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
// - At most 60 frames a second: a display frame less than a 60 Hz period
//   (minus 1 ms of vsync jitter) after the last drawn one is skipped, so a
//   120/240 Hz display draws every 2nd/4th frame (60 fps) and a 144 Hz one
//   every 3rd (48 fps), never 72. `hz: 30` consumers run every other drawn
//   frame (analysis ≤ 30 Hz).
// - Every callback is timed; stats() = { busyMs, wallMs, frames } over the
//   last 5 s, where wallMs counts only the time the loop was running (a
//   paused loop neither costs nor dilutes the ratio), so busyMs / wallMs is
//   the honest main-thread share (window.__daw.vis.stats(), the serial e2e
//   budget).
// - The strip tap (OP_VIS_TAP) is chosen here too: setTap(ch) sends it to
//   the attached engine and remembers it, and attach() re-sends it to a new
//   engine (an audio restart starts with the tap off), like the want mask.
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
  /** Sends OP_VIS_TAP (AudioEngine.setVisTap); optional for test fakes. */
  setVisTap?(ch: number): boolean;
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
  /**
   * The strip tap: a mixer channel 0..MIX_DELAY or -1 (off). Sent to the
   * attached engine now and to every engine attached later.
   */
  setTap(ch: number): void;
  stats(): FrameStats;
}

/** Rolling stats window (ms). */
const WINDOW_MS = 5000;
/** Frames kept for the stats (5 s at 60 fps, with room). */
const HISTORY = 512;
/** Running spans kept for the stats (older ones fall out of the window). */
const SPANS = 64;
/**
 * A frame sooner than this after the last drawn one is skipped (≤ 60 fps):
 * a 60 Hz period less 1 ms, so 60 Hz vsync jitter never drops a frame.
 */
const MIN_FRAME_MS = 1000 / 60 - 1;

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
  // Running time for the stats: closed [start, end) spans (a ring) and the
  // start of the current one (NaN while stopped).
  const spanStart = new Float64Array(SPANS);
  const spanEnd = new Float64Array(SPANS);
  let spans = 0;
  let runStart = NaN;
  /** The engine served now, and the strip tap to give every engine (null: never chosen). */
  let source: VisSource | null = null;
  let tap: number | null = null;

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
      if (Number.isNaN(runStart)) runStart = env.now();
      raf = env.raf(frame);
    } else if (on.length === 0) {
      if (raf !== 0) env.caf(raf);
      raf = 0;
      if (!Number.isNaN(runStart)) {
        const at = spans++ % SPANS;
        spanStart[at] = runStart;
        spanEnd[at] = env.now();
        runStart = NaN;
      }
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
      source = engine;
      views = engine ? engine.vis() : null;
      want = -1;
      // A new engine starts with the tap off: give it the chosen one.
      if (engine && tap !== null && tap >= 0) engine.setVisTap?.(tap);
      update();
    },
    setTap(ch) {
      tap = ch;
      source?.setVisTap?.(ch);
    },
    stats() {
      const now = env.now();
      const lo = now - WINDOW_MS;
      let b = 0;
      let n = 0;
      for (let i = 0; i < Math.min(count, HISTORY); i++) {
        if (times[i] > lo) {
          b += busy[i];
          n++;
        }
      }
      // Running time inside the window only.
      let wallMs = Number.isNaN(runStart) ? 0 : now - Math.max(runStart, lo);
      for (let i = 0; i < Math.min(spans, SPANS); i++) {
        wallMs += Math.max(0, spanEnd[i] - Math.max(spanStart[i], lo));
      }
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
