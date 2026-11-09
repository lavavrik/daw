// The analyser bus (plan 12 Task 3; docs/architecture/visuals.md
// *Analyser*): ONE 30 Hz frame-loop consumer that analyses the master ring
// and the strip tap for every spectrum view, so views never run an FFT of
// their own; they subscribe and draw from its arrays.
//
// Views subscribe with what they need:
//   'mini'   the top bar's master spectrum (20 bands, `mini`);
//   'panel'  the mixer analyser's spectrum (60 bands, `panel`) of the
//            selected source: the Master, or one strip (`selected`);
//   'stereo' the master's correlation and goniometer points.
// A view with an `el` counts only while that element is on screen (its own
// IntersectionObserver; no `el` = always). From the views on screen the bus
// derives its want bits: master (1) while any master view is on screen
// (mini, stereo, or the panel showing the Master), the strip tap (2) only
// while the panel shows a strip. It is registered on the frame loop with
// exactly those bits, re-registered when they change, and not at all while
// nothing is on screen, so the loop and the worklet's copies can stop.
//
// Idle (Task 5 review; `env.wake`, the app's visWake): when the transport is
// stopped, nothing analysed has been heard and every shown band (mini, and
// the panel when on screen: levels and peaks) has been at the floor for
// IDLE_AFTER_MS, the bus leaves the loop too (the top bar's spectrum is
// always on screen: without this the loop would never pause). A wake (Play,
// a note-on, an edit, a new engine), a new view or a new selection brings it
// back; its first look sees the ring stood still and reads silence until
// fresh frames arrive. Without `env.wake` it never idles.
//
// The tap choice lives here too: select(ch | 'master') / toggle(ch) (the
// strips' ∿ buttons). The engine taps the selected strip only while a panel
// is mounted (else −1), sent through frameLoop().setTap, which remembers it
// and re-sends it whenever an engine is attached (an audio restart starts
// with the tap off). sync(live strips) falls back to the Master when the
// selected strip's track is removed (or its slot now holds another track).
// The choice is view state: not saved, not an edit.
//
// Ring reads follow the visLayout rule (head first, newest frames, never
// the oldest VIS_GUARD). Frames written before a source was being analysed
// (its ring stood still — bit off, loop paused: it moved less than half the
// frames the elapsed time should have brought — or the tap was on another
// strip) read as silence, and a change of the tapped channel (the SAB's [3]) resets
// the panel's history. Analysis runs at most 30 times a second (the loop's
// `hz: 30`, plus a guard for re-registration); everything is allocated up
// front, per sample rate, so a frame allocates nothing.
import { VIS_GUARD, VIS_HDR, VIS_WANT, type VisViews } from '../../audio/visLayout';
import { VIS_TAP_RING } from '../../audio/protocol';
import { frameLoop, type FrameLoop } from './frameLoop';
import { IDLE_AFTER_MS } from './idleDriver';
import { visWake, type VisWake } from './visWake';
import { Ballistics, Bands, DB_FLOOR, SPEC_N, SpectrumAnalyser } from './spectrum';
import { CorrelationMeter, MAX_STEREO_FRAMES, corrFrames, goniometer, gonioFrames } from './stereo';

export type AnalyserSource = number | 'master';
export type AnalyserNeed = 'mini' | 'panel' | 'stereo';

export interface AnalyserView {
  need: AnalyserNeed;
  /** Watched for visibility; omitted = always on screen. */
  el?: Element | null;
  /** Called after each analysis (≤ 30 Hz) while on screen: draw straight onto the canvas. */
  draw(bus: AnalyserBus, now: number): void;
}

/** A window is "heard" when its peak |x| reaches this (-60 dBFS); quieter tails do not keep the bus awake. */
const HEARD_PEAK = 1e-3;
/** Bars at or under this (dB) count as dark for the idle check. */
const QUIET_DB = -60;

/** A mixer strip that can be shown: its channel and who it belongs to (a track or return id). */
export interface LiveStrip {
  ch: number;
  key: string;
}

export interface AnalyserBus {
  subscribe(v: AnalyserView): () => void;
  /** Show the Master or one strip (mixer channel 0..MIX_MASTER-1: a track or return; `key` identifies its owner). */
  select(src: AnalyserSource, key?: string): void;
  /** A strip's ∿ button: show it, or back to the Master if it is shown. */
  toggle(ch: number, key: string): void;
  readonly selected: AnalyserSource;
  /** Called now and on every selection change; returns the unsubscribe. */
  onSelect(fn: (s: AnalyserSource) => void): () => void;
  /** The strips that exist now: a vanished selection falls back to the Master. */
  sync(live: readonly LiveStrip[]): void;
  /** The engine whose sample rate the bands follow (null: none). */
  attach(engine: { sampleRate: number } | null): void;
  /** Master, 20 bands (the top bar). */
  readonly mini: Ballistics;
  readonly miniBands: Bands;
  /** The selected source, 60 bands (the mixer analyser). */
  readonly panel: Ballistics;
  readonly panelBands: Bands;
  /** The source the panel arrays hold (follows `selected` once analysed). */
  readonly panelSource: AnalyserSource;
  /** Master correlation, as the bar shows it (stereo.ts CorrelationMeter, −1..+1). */
  readonly correlation: number;
  /** Master goniometer points (see stereo.ts), `gonN` of them. */
  readonly gonX: Float32Array;
  readonly gonY: Float32Array;
  readonly gonN: number;
}

type IoEntry = { target: Element; isIntersecting: boolean };

export interface AnalyserEnv {
  loop: Pick<FrameLoop, 'add' | 'setTap'>;
  /** Watches the views' elements (omitted: every view is on screen). */
  IntersectionObserver?: new (cb: (entries: IoEntry[]) => void) => {
    observe(el: Element): void;
    unobserve(el: Element): void;
  };
  /** Idle when stopped and silent; woken by it (omitted: never idles). */
  wake?: Pick<VisWake, 'onWake' | 'playing'>;
}

export const PANEL_BANDS = 60;
export const MINI_BANDS = 20;
/** At most 30 analyses a second: two 60 Hz frames, less jitter. */
const MIN_ANALYSIS_MS = 1000 / 30 - 4;
/**
 * A ring that moved less than this share of the frames the time since the
 * last look should have brought stood still meanwhile (its bit was off, the
 * loop paused): what it holds from before is old, so the read starts again.
 * A slow frame rate (a throttled background tab) is not a pause.
 */
const STILL_SHARE = 0.5;
/**
 * Ballistics and smoothing never step more than this. A pause is handled by
 * the staleness rule above, so this only bounds a pathological gap; a
 * throttled tab (1–2 frames a second) still falls at the stated rates.
 */
const MAX_DT_S = 1;
const DEFAULT_RATE = 48000;

interface ViewEntry {
  v: AnalyserView;
  onScreen: boolean;
}

/** Reading state per ring. */
interface Reader {
  /** Frames before this head are stale (read as silence). */
  since: number;
  /** When it was last analysed (ms; -Infinity = never) and its head then. */
  last: number;
  lastHead: number;
}

export function createAnalyserBus(env: AnalyserEnv): AnalyserBus {
  const views = new Set<ViewEntry>();
  const byEl = new Map<Element, Set<ViewEntry>>();
  const listeners = new Set<(s: AnalyserSource) => void>();
  let selected: AnalyserSource = 'master';
  let selectedKey: string | null = null;
  /** The tap last sent (-1 off; the engine starts off). */
  let sentTap = -1;
  /** The frame-loop registration and its want bits (-1: none). */
  let unregister: (() => void) | null = null;
  let registered = -1;
  let lastRun = -Infinity;
  let lastVis: VisViews | null = null;
  /** Out of the loop while stopped and silent (see the top); `quietSince`: NaN = not quiet yet. */
  let asleep = false;
  let quietSince = NaN;
  /** Something non-silent was analysed this frame. */
  let heard = false;

  let rate = DEFAULT_RATE;
  let analyser = new SpectrumAnalyser(rate);
  let miniBands = new Bands(MINI_BANDS, rate);
  let panelBands = new Bands(PANEL_BANDS, rate);
  const mini = new Ballistics(MINI_BANDS);
  const panel = new Ballistics(PANEL_BANDS);
  let panelSource: AnalyserSource = 'master';
  const corr = new CorrelationMeter();
  /** Window lengths at the attached rate (frames). */
  let corrN = corrFrames(DEFAULT_RATE);
  let gonioN = gonioFrames(DEFAULT_RATE);
  let masterN = Math.max(corrN, SPEC_N, gonioN);
  let gonN = 0;
  // Sized for any rate up to 192 kHz (the windows are capped by the ring).
  const gonX = new Float32Array(MAX_STEREO_FRAMES);
  const gonY = new Float32Array(MAX_STEREO_FRAMES);
  // Scratch: the newest frames of a ring, oldest first.
  const bufL = new Float32Array(MAX_STEREO_FRAMES);
  const bufR = new Float32Array(MAX_STEREO_FRAMES);
  const mono = new Float64Array(SPEC_N);
  const silentMini = new Float32Array(MINI_BANDS).fill(DB_FLOOR);
  const silentPanel = new Float32Array(PANEL_BANDS).fill(DB_FLOOR);
  const master: Reader = { since: 0, last: -Infinity, lastHead: 0 };
  const tap: Reader = { since: 0, last: -Infinity, lastHead: 0 };

  /** Note a look at a ring at `head`: restart it if it stood still since the last one. */
  function look(rd: Reader, head: number, now: number) {
    const expected = ((now - rd.last) / 1000) * rate;
    if (!(((head - rd.lastHead) | 0) >= STILL_SHARE * expected)) rd.since = head;
    rd.last = now;
    rd.lastHead = head;
  }
  /** The tapped channel the panel's history belongs to. */
  let tapCh = -1;

  const io = env.IntersectionObserver
    ? new env.IntersectionObserver((list) => {
        for (const e of list) for (const en of byEl.get(e.target) ?? []) en.onScreen = e.isIntersecting;
        refresh();
      })
    : null;

  const panelMounted = () => [...views].some((e) => e.v.need === 'panel');

  /** The tap the engine should have: the selected strip while a panel is mounted. */
  function syncTap() {
    const want = typeof selected === 'number' && panelMounted() ? selected : -1;
    if (want === sentTap) return;
    sentTap = want;
    env.loop.setTap(want);
  }

  /** The want bits of the views on screen. */
  function wantBits(): number {
    let w = 0;
    for (const e of views) {
      if (!e.onScreen) continue;
      if (e.v.need === 'panel') w |= typeof selected === 'number' ? VIS_WANT.tap : VIS_WANT.master;
      else w |= VIS_WANT.master;
    }
    return w;
  }

  /** (Re-)register on the frame loop with the current want bits. */
  function refresh() {
    syncTap();
    const on = !asleep && [...views].some((e) => e.onScreen);
    const w = on ? wantBits() : -1;
    if (w === registered) return;
    unregister?.();
    unregister = null;
    registered = w;
    if (on) unregister = env.loop.add({ want: w, hz: 30, frame });
  }

  /** Copy the newest `n` frames of a ring into bufL/bufR[0..n), stale frames as 0. */
  function read(L: Float32Array, R: Float32Array, head: number, rd: Reader, n: number) {
    let fresh = (head - rd.since) | 0;
    if (fresh < 0) {
      // A new ring (restart) behind the old mark: start again.
      rd.since = head;
      fresh = 0;
    }
    fresh = Math.min(fresh, n, VIS_TAP_RING - VIS_GUARD);
    const pad = n - fresh;
    bufL.fill(0, 0, pad);
    bufR.fill(0, 0, pad);
    const mask = VIS_TAP_RING - 1;
    for (let i = pad, h = (head - fresh) | 0; i < n; i++, h = (h + 1) | 0) {
      bufL[i] = L[h & mask];
      bufR[i] = R[h & mask];
    }
  }

  /** The mono sum of the newest SPEC_N frames in bufL/bufR[0..n). */
  function monoOf(n: number) {
    for (let i = 0, j = n - SPEC_N; i < SPEC_N; i++, j++) mono[i] = (bufL[j] + bufR[j]) / 2;
  }

  /**
   * dB per bin of `mono`, or null for (near-)silence — a window whose peak
   * stays under HEARD_PEAK (-60 dBFS; a stopped transport, a dying tail) —
   * which skips the FFT — the top bar keeps the analysis
   * running whenever the app is visible.
   */
  function bins(): Float32Array | null {
    for (let i = 0; i < SPEC_N; i++) {
      if (Math.abs(mono[i]) >= HEARD_PEAK) {
        heard = true;
        return analyser.analyse(mono);
      }
    }
    return null;
  }

  const atFloor = (b: Ballistics) => {
    for (let i = 0; i < b.level.length; i++) if (b.level[i] > QUIET_DB || b.peak[i] > QUIET_DB) return false;
    return true;
  };

  /** After a frame: leave the loop once stopped, unheard and dark for IDLE_AFTER_MS. */
  function idleCheck(now: number, needMini: boolean, needPanel: boolean) {
    if (!env.wake) return;
    const quiet = !heard && !env.wake.playing() && (!needMini || atFloor(mini)) && (!needPanel || atFloor(panel));
    if (!quiet) quietSince = NaN;
    else if (Number.isNaN(quietSince)) quietSince = now;
    else if (now - quietSince > IDLE_AFTER_MS) {
      // The bars sit between -60 and -90 dB now: drop them to the floor and
      // draw that once, so the frozen picture is the empty one.
      mini.reset();
      panel.reset();
      for (const e of views) if (e.onScreen) e.v.draw(bus, now);
      asleep = true;
      refresh();
    }
  }

  /** Back into the loop (a wake, a new view or selection). */
  function wakeUp() {
    quietSince = NaN;
    if (!asleep) return;
    asleep = false;
    refresh();
  }
  env.wake?.onWake(wakeUp);

  function frame(now: number, vis: VisViews) {
    if (now - lastRun < MIN_ANALYSIS_MS) return;
    const dt = Math.min(MAX_DT_S, Number.isFinite(lastRun) ? (now - lastRun) / 1000 : 1 / 30);
    lastRun = now;
    heard = false;
    if (vis !== lastVis) {
      // Another engine's visSab: nothing in it belongs to the old history.
      lastVis = vis;
      master.last = tap.last = -Infinity;
      mini.reset();
      panel.reset();
      corr.reset();
    }
    let needMini = false;
    let needPanel = false;
    let needStereo = false;
    for (const e of views) {
      if (!e.onScreen) continue;
      if (e.v.need === 'mini') needMini = true;
      else if (e.v.need === 'panel') needPanel = true;
      else needStereo = true;
    }
    const panelMaster = needPanel && selected === 'master';
    if (panelSource !== selected) {
      panelSource = selected;
      panel.reset();
    }

    // The master ring.
    if (needMini || needStereo || panelMaster) {
      const head = Atomics.load(vis.hdr, VIS_HDR.masterHead);
      look(master, head, now);
      read(vis.masterL, vis.masterR, head, master, masterN);
      if (needMini || panelMaster) {
        monoOf(masterN);
        const b = bins();
        if (needMini) mini.step(b ? miniBands.measure(b) : silentMini, dt);
        if (panelMaster) panel.step(b ? panelBands.measure(b) : silentPanel, dt);
      }
      if (needStereo) {
        if (!heard) for (let i = masterN - corrN; i < masterN; i++) if (Math.abs(bufL[i]) >= HEARD_PEAK || Math.abs(bufR[i]) >= HEARD_PEAK) { heard = true; break; }
        corr.step(bufL, bufR, masterN - corrN, masterN, dt);
        gonN = goniometer(bufL, bufR, gonX, gonY, gonioN, masterN);
      }
    }

    // The strip tap.
    if (needPanel && typeof selected === 'number') {
      const head = Atomics.load(vis.hdr, VIS_HDR.tapHead);
      const ch = Atomics.load(vis.hdr, VIS_HDR.tapCh);
      if (ch !== tapCh) {
        // Another strip's frames: start the history again.
        tapCh = ch;
        tap.since = head;
        panel.reset();
      }
      look(tap, head, now);
      // Until the engine taps the selected strip, the panel shows silence.
      if (ch !== selected) tap.since = head;
      read(vis.tapL, vis.tapR, head, tap, SPEC_N);
      monoOf(SPEC_N);
      const b = bins();
      panel.step(b ? panelBands.measure(b) : silentPanel, dt);
    }

    for (const e of views) if (e.onScreen) e.v.draw(bus, now);
    idleCheck(now, needMini, needPanel);
  }

  function setSelected(s: AnalyserSource, key: string | null) {
    const changed = s !== selected;
    selected = s;
    selectedKey = s === 'master' ? null : key;
    asleep = false;
    quietSince = NaN;
    refresh();
    if (changed) for (const fn of listeners) fn(s);
  }

  const bus: AnalyserBus = {
    subscribe(v) {
      const en: ViewEntry = { v, onScreen: !v.el || !io };
      views.add(en);
      if (v.el && io) {
        let set = byEl.get(v.el);
        if (!set) {
          byEl.set(v.el, (set = new Set()));
          io.observe(v.el);
        } else {
          en.onScreen = [...set][0]?.onScreen ?? false;
        }
        set.add(en);
      }
      // A new view draws at least until it has shown the current state.
      asleep = false;
      quietSince = NaN;
      refresh();
      return () => {
        if (!views.delete(en)) return;
        const el = v.el;
        const set = el ? byEl.get(el) : undefined;
        if (el && set) {
          set.delete(en);
          if (set.size === 0) {
            byEl.delete(el);
            io?.unobserve(el);
          }
        }
        refresh();
      };
    },
    select(src, key) {
      setSelected(src, key ?? null);
    },
    toggle(ch, key) {
      setSelected(selected === ch ? 'master' : ch, key);
    },
    get selected() {
      return selected;
    },
    onSelect(fn) {
      listeners.add(fn);
      fn(selected);
      return () => void listeners.delete(fn);
    },
    sync(live) {
      if (selected === 'master') return;
      if (!live.some((s) => s.ch === selected && (selectedKey === null || s.key === selectedKey))) setSelected('master', null);
    },
    attach(engine) {
      const r = engine?.sampleRate ?? DEFAULT_RATE;
      if (r !== rate) {
        // Allocation, but only here (a new engine), never per frame.
        rate = r;
        analyser = new SpectrumAnalyser(r);
        miniBands = new Bands(MINI_BANDS, r);
        panelBands = new Bands(PANEL_BANDS, r);
        corrN = corrFrames(r);
        gonioN = gonioFrames(r);
        masterN = Math.max(corrN, SPEC_N, gonioN);
      }
      // A new engine starts with the tap off; the frame loop re-sends ours.
      lastVis = null;
      tapCh = -1;
    },
    get mini() {
      return mini;
    },
    get miniBands() {
      return miniBands;
    },
    get panel() {
      return panel;
    },
    get panelBands() {
      return panelBands;
    },
    get panelSource() {
      return panelSource;
    },
    get correlation() {
      return corr.value;
    },
    gonX,
    gonY,
    get gonN() {
      return gonN;
    },
  };
  return bus;
}

let shared: AnalyserBus | null = null;

/** The app's one analyser bus, on the app's frame loop (App attaches it with each engine). */
export function analyserBus(): AnalyserBus {
  shared ??= createAnalyserBus({
    loop: frameLoop(),
    IntersectionObserver: IntersectionObserver as unknown as AnalyserEnv['IntersectionObserver'],
    wake: visWake(),
  });
  return shared;
}
