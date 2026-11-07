// Mixer maths (pure; unit-tested in mixMath.test.ts): the fader law, fader
// gestures, the dB readout, the meter scale, peak hold and the clip test.
import { mixParam } from '../../audio/mixerCatalog';

const FADER = mixParam('fader');

/**
 * Fader law: (dB, position) breakpoints, linear in dB between them. Position
 * 0..1 is the fader travel, bottom to top. Modelled on console fader scales:
 * 0 dB at 3/4 of the travel, the top quarter for +6 dB of boost, and the
 * range near unity (where mixing happens) spread out — −10 dB is still above
 * half way — while the bottom 14% covers −40 dB down to −∞ (the catalog min,
 * −60 dB, which the engine treats as off).
 *
 * A piecewise-linear law instead of one curve: it hits the familiar marks
 * exactly (the scale ticks are printed at the breakpoints), it is trivially
 * invertible, and its slope only changes at the ticks. The meter beside the
 * fader uses the same law (meterPos), so a −10 dBFS peak lines up with the
 * −10 tick.
 */
export const FADER_LAW: readonly (readonly [number, number])[] = [
  [FADER.min, 0], // −60 = −∞
  [-40, 0.14],
  [-30, 0.25],
  [-20, 0.38],
  [-10, 0.55],
  [0, 0.75],
  [FADER.max, 1], // +6
];
/** Tick labels beside the fader / meter (the breakpoints). */
export const SCALE_TICKS: readonly number[] = FADER_LAW.map(([db]) => db);
export const FADER_MIN_DB = FADER.min;
export const FADER_MAX_DB = FADER.max;
/** Drag factor while Shift is held. */
export const FADER_FINE = 0.1;
/** Keyboard step in dB (Shift: 0.1 dB). */
export const FADER_KEY_DB = 1;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

/** dB -> fader position 0..1 (−∞ and anything at/below the min -> 0). */
export function faderPos(db: number): number {
  if (!(db > FADER.min)) return 0; // also NaN, −∞
  if (db >= FADER.max) return 1;
  for (let i = 1; i < FADER_LAW.length; i++) {
    const [d1, p1] = FADER_LAW[i];
    if (db <= d1) {
      const [d0, p0] = FADER_LAW[i - 1];
      return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
    }
  }
  return 1;
}

/** Fader position -> dB, clamped to the catalog range and snapped to 0.1 dB. */
export function faderDb(pos: number): number {
  const p = clamp(pos, 0, 1);
  for (let i = 1; i < FADER_LAW.length; i++) {
    const [d1, p1] = FADER_LAW[i];
    if (p <= p1) {
      const [d0, p0] = FADER_LAW[i - 1];
      return clamp(round1(d0 + ((p - p0) / (p1 - p0)) * (d1 - d0)), FADER.min, FADER.max);
    }
  }
  return FADER.max;
}

/** New position after a vertical drag of `dy` px on a fader `heightPx` tall (up = louder). */
export function faderDrag(pos: number, dy: number, heightPx: number, fine: boolean): number {
  return clamp(pos - (dy / Math.max(1, heightPx)) * (fine ? FADER_FINE : 1), 0, 1);
}

/** One arrow-key step: ±1 dB (fine: ±0.1 dB), clamped, snapped to 0.1 dB. */
export function faderKeyStep(db: number, dir: 1 | -1, fine: boolean): number {
  const from = db > FADER.min ? db : FADER.min;
  return clamp(round1(from + dir * (fine ? FADER_KEY_DB / 10 : FADER_KEY_DB)), FADER.min, FADER.max);
}

/** Fader readout: "−∞" at the floor, else one decimal with a real minus ("−6.0 dB", "+3.0 dB", "0.0 dB"). */
export function formatDb(db: number): string {
  if (!(db > FADER.min)) return '−∞';
  const t = Math.abs(db).toFixed(1);
  if (t === '0.0') return '0.0 dB';
  return `${db < 0 ? '−' : '+'}${t} dB`;
}

// ---- meters ------------------------------------------------------------------

/** Linear amplitude -> dBFS (−∞ for 0, negatives and NaN). */
export function linToDb(x: number): number {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}

/** Meter bar height 0..1 for a linear peak: the fader law, clamped to its range. */
export function meterPos(lin: number): number {
  return faderPos(linToDb(lin));
}

/** How long the peak-hold line stays at the highest recent peak. */
export const PEAK_HOLD_MS = 1000;

export interface Hold {
  /** Held peak, dBFS. */
  db: number;
  /** When it was set (ms, the rAF clock). */
  t: number;
}

/** Peak hold: a higher peak (or the old one expiring after PEAK_HOLD_MS) replaces the hold. */
export function holdStep(h: Hold, db: number, now: number): Hold {
  if (db >= h.db || now - h.t > PEAK_HOLD_MS) return { db, t: now };
  return h;
}

/**
 * Clip test: the peak reached the ceiling (0 dBFS for strips, the limiter
 * ceiling for the master). A 0.001 dB tolerance absorbs float rounding.
 */
export function isClip(lin: number, ceilingDb: number): boolean {
  return linToDb(lin) >= ceilingDb - 0.001;
}

/** Master clip light: limiter GR above this (dB) counts as "hitting the ceiling". */
export const MASTER_CLIP_GR_DB = 1;
/** ...as does an output peak within this many dB of the ceiling. */
export const MASTER_CLIP_MARGIN_DB = 0.5;

/**
 * Master clip test. The limiter's output sits a little *under* its ceiling
 * (lookahead peak detection, ~0.2 dB), so plain isClip never fires there.
 * Instead the master light means "the limiter is working hard": gain reduction
 * above MASTER_CLIP_GR_DB, or an output peak within MASTER_CLIP_MARGIN_DB of
 * the ceiling.
 */
export function isMasterClip(lin: number, ceilingDb: number, grDb: number): boolean {
  return grDb > MASTER_CLIP_GR_DB || linToDb(lin) >= ceilingDb - MASTER_CLIP_MARGIN_DB;
}
