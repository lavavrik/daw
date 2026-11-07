// The ONE animation-frame loop for every visual (plan 12; docs/architecture/
// visuals.md). Consumers (the mixer meters, scopes, spectrum, waveforms...)
// register here instead of running their own requestAnimationFrame:
//
// - add({ want, el?, hz?, frame }) returns the remove function. `el` is
//   watched with one IntersectionObserver: a consumer whose element is off
//   screen does not run and does not want anything. No `el` = always on
//   screen (until the document hides).
// - The rAF runs only while the document is visible, an engine is attached
//   and at least one consumer is on screen; otherwise it is cancelled and the
//   want mask in visSab is 0, so the worklet copies nothing (visCopy.ts).
// - The want mask is the OR of the on-screen consumers' `want` bits
//   (VIS_WANT), written whenever that set changes.
// - At most 60 frames a second: a frame closer than 3/4 of a 60 Hz frame
//   to the last one drawn is skipped (high refresh-rate displays). `hz: 30`
//   consumers run every other drawn frame (analysis ≤ 30 Hz).
// - Every callback is timed; stats() = { busyMs, wallMs, frames } over a
//   rolling 5 s (window.__daw.vis.stats(), the serial e2e budget).
// - A consumer that throws is removed and logged once: a visual must never
//   break the app.
//
// Consumers draw their canvas / DOM directly in `frame` (never through
// Svelte state: the MeterBus rule).
import { VIS_HDR, type VisViews } from '../../audio/visLayout';

export interface FrameConsumer {
  /** VIS_WANT bits this consumer reads from visSab (0: none, e.g. meters). */
  want: number;
  /** Watched for visibility; omitted = always on screen. */
  el?: Element | null;
  /** 60 (default) or 30: every other frame. */
  hz?: 60 | 30;
  frame(now: number, vis: VisViews): void;
}

export interface FrameStats {
  /** Time spent inside consumer callbacks. */
  busyMs: number;
  /** Wall time the stats cover (≤ 5 s). */
  wallMs: number;
  /** Frames drawn. */
  frames: number;
}

/** Anything with live vis views (AudioEngine). */
export interface VisSource {
  vis(): VisViews;
}

type IoEntry = { target: Element; isIntersecting: boolean };

/** What the loop needs from the browser (fakes in frameLoop.test.ts). */
export interface FrameEnv {
  raf(fn: (now: number) => void): number;
  caf(id: number): void;
  now(): number;
  document: { hidden: boolean; addEventListener(type: 'visibilitychange', fn: () => void): void };
  IntersectionObserver: new (cb: (entries: IoEntry[]) => void) => {
    observe(el: Element): void;
    unobserve(el: Element): void;
  };
  error(...args: unknown[]): void;
}

export interface FrameLoop {
  add(c: FrameConsumer): () => void;
  /** The engine whose visSab the loop serves (null: stop). */
  attach(engine: VisSource | null): void;
  stats(): FrameStats;
}

/** Rolling stats window (ms). */
const WINDOW_MS = 5000;
/** Frames kept for the stats (5 s at 60 fps, with room). */
const HISTORY = 512;
/** A frame sooner than this after the last drawn one is skipped (≤ 60 fps). */
const MIN_FRAME_MS = (1000 / 60) * 0.75;

interface Entry {
  c: FrameConsumer;
  onScreen: boolean;
  /** Drawn-frame counter for 30 Hz consumers. */
  tick: number;
}

export function createFrameLoop(env: FrameEnv): FrameLoop {
  const entries = new Set<Entry>();
  const byEl = new Map<Element, Set<Entry>>();
  let views: VisViews | null = null;
  let raf = 0;
  let want = -1;
  let last = -Infinity;
  // Stats: a ring of (time, busy) per drawn frame.
  const times = new Float64Array(HISTORY);
  const busy = new Float64Array(HISTORY);
  let count = 0;
  /** When the loop first started (stats' wall time counts from here). */
  let first = NaN;

  const io = new env.IntersectionObserver((list) => {
    for (const e of list) for (const en of byEl.get(e.target) ?? []) en.onScreen = e.isIntersecting;
    update();
  });
  env.document.addEventListener('visibilitychange', () => update());

  const running = () => [...entries].filter((e) => e.onScreen);

  function setWant(w: number) {
    if (views && w !== want) Atomics.store(views.hdr, VIS_HDR.want, w);
    want = w;
  }

  /** Start or stop the rAF and rewrite the want mask after any change. */
  function update() {
    const on = views !== null && !env.document.hidden ? running() : [];
    setWant(on.reduce((m, e) => m | e.c.want, 0));
    if (on.length > 0 && raf === 0) {
      if (Number.isNaN(first)) first = env.now();
      raf = env.raf(frame);
    } else if (on.length === 0 && raf !== 0) {
      env.caf(raf);
      raf = 0;
    }
  }

  function remove(en: Entry) {
    if (!entries.delete(en)) return;
    const el = en.c.el;
    if (el) {
      const set = byEl.get(el);
      set?.delete(en);
      if (set && set.size === 0) {
        byEl.delete(el);
        io.unobserve(el);
      }
    }
    update();
  }

  function frame(now: number) {
    raf = 0;
    const v = views;
    if (v === null || env.document.hidden) return update();
    raf = env.raf(frame);
    if (now - last < MIN_FRAME_MS) return;
    last = now;
    let spent = 0;
    for (const en of entries) {
      if (!en.onScreen) continue;
      if (en.c.hz === 30 && en.tick++ % 2 !== 0) continue;
      const t0 = env.now();
      try {
        en.c.frame(now, v);
      } catch (e) {
        env.error('frameLoop: a visual threw and was removed', e);
        remove(en);
      }
      spent += env.now() - t0;
    }
    const at = count++ % HISTORY;
    times[at] = now;
    busy[at] = spent;
  }

  return {
    add(c) {
      const en: Entry = { c, onScreen: !c.el, tick: 0 };
      entries.add(en);
      if (c.el) {
        let set = byEl.get(c.el);
        if (!set) {
          byEl.set(c.el, (set = new Set()));
          io.observe(c.el);
        } else {
          // Another consumer already knows this element's visibility.
          en.onScreen = [...set][0]?.onScreen ?? false;
        }
        set.add(en);
      }
      update();
      return () => remove(en);
    },
    attach(engine) {
      setWant(0);
      views = engine ? engine.vis() : null;
      want = -1;
      update();
    },
    stats() {
      const now = env.now();
      let b = 0;
      let n = 0;
      for (let i = 0; i < Math.min(count, HISTORY); i++) {
        if (times[i] > now - WINDOW_MS) {
          b += busy[i];
          n++;
        }
      }
      const wallMs = Number.isNaN(first) ? 0 : Math.min(WINDOW_MS, now - first);
      return { busyMs: b, wallMs, frames: n };
    },
  };
}

let shared: FrameLoop | null = null;

/** The app's one frame loop (created on first use, with the browser's globals). */
export function frameLoop(): FrameLoop {
  shared ??= createFrameLoop({
    raf: (fn) => requestAnimationFrame(fn),
    caf: (id) => cancelAnimationFrame(id),
    now: () => performance.now(),
    document,
    IntersectionObserver: IntersectionObserver as unknown as FrameEnv['IntersectionObserver'],
    error: (...a) => console.error(...a),
  });
  return shared;
}
