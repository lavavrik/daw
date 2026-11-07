// Shape previews for the ADSR and LFO panels, and the voice LEDs' level
// (plan 12 Task 5; docs/architecture/visuals.md "Shape previews"). Pure and
// DOM-free: ShapePreview.svelte / VoiceLeds.svelte draw what this computes.
//
// The curves MIRROR the engine's documented ones (engine/src/rack/modules/
// adsr.rs, lfo.rs) and are pinned against the real modules by
// engine/tests/fixtures/shapes.json (shapes.test.ts: every engine point is
// within 0.01 of the drawn polyline). If the engine's curves change,
// regenerate the fixture (UPDATE_FIXTURES=1 cargo test -p daw-engine --test
// shapes) and this file follows.
//
// ADSR (a note held, then released, at full velocity):
//   Delay   flat at 0 for `delay` s (none when 0);
//   Attack  linear 0 → 1 in `attack` s;
//   Decay   exponential to `sustain`, tau = decay / ln(100) (within 1 % after
//           `decay` s);
//   plateau the gate keeps being held for one more `decay` (the decay has
//           settled to within 1e-4: the engine's sustain capture), drawn at a
//           FIXED width (PLATEAU = 20 % of the preview);
//   Release exponential to 0 from the level at the gate's fall, tau =
//           release / ln(100); drawn for `release` s (to 1 %).
// Time axis (my call): every timed segment's width ∝ √t, normalised so they
// share the 80 % beside the plateau, linear in time inside a segment. √
// keeps a 1 ms attack visible next to a 4 s release; labels give real times.
// Times are clamped like the engine's (attack / decay / release ≥ 1 ms,
// delay 0..4 s, sustain 0..1).
//
// LFO: one cycle from the engine's phase 0 (synced: phase 0 is on the
// division's grid line, i.e. a bar / beat), value = wave(phase) × depth,
// bipolar. The engine's 1 ms output slew is not drawn (invisible at 120 px).
import { DIVISION_TICKS } from './scopeMath';

/** The plateau's share of the ADSR preview's width. */
export const PLATEAU = 0.2;
/** ln(100): an exponential with tau = t / LN_100 is at 1 % after t (adsr.rs LN_100). */
const LN_100 = Math.log(100);

export interface AdsrParams {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** Seconds before the attack (plan 11); 0 = none. */
  delay: number;
}

export type AdsrSegKind = 'delay' | 'attack' | 'decay' | 'sustain' | 'release';

/** One segment of the preview: x0..x1 (0..1 of the width) shows real time t0..t1 (s). */
export interface AdsrSeg {
  kind: AdsrSegKind;
  x0: number;
  x1: number;
  t0: number;
  t1: number;
}

const fin = (x: number, d: number) => (Number.isFinite(x) ? x : d);

/** The params as the engine reads them (adsr.rs: max(0.001), delay 0..4, sustain 0..1). */
function clampAdsr(p: AdsrParams): AdsrParams {
  return {
    attack: Math.max(0.001, fin(p.attack, 0.001)),
    decay: Math.max(0.001, fin(p.decay, 0.001)),
    sustain: Math.min(1, Math.max(0, fin(p.sustain, 0))),
    release: Math.max(0.001, fin(p.release, 0.001)),
    delay: Math.min(4, Math.max(0, fin(p.delay, 0))),
  };
}

/** The five segments in order (delay has zero width when `delay` is 0). */
export function adsrLayout(p: AdsrParams): AdsrSeg[] {
  const c = clampAdsr(p);
  const timed = [c.delay, c.attack, c.decay, c.release].map(Math.sqrt);
  const sum = timed[0] + timed[1] + timed[2] + timed[3];
  const w = timed.map((r) => ((1 - PLATEAU) * r) / sum);
  const tA = c.delay;
  const tD = tA + c.attack;
  const tS = tD + c.decay;
  const tOff = tS + c.decay; // the plateau stands for one more decay time
  const segs: AdsrSeg[] = [];
  let x = 0;
  const push = (kind: AdsrSegKind, width: number, t0: number, t1: number) => {
    segs.push({ kind, x0: x, x1: x + width, t0, t1 });
    x += width;
  };
  push('delay', w[0], 0, tA);
  push('attack', w[1], tA, tD);
  push('decay', w[2], tD, tS);
  push('sustain', PLATEAU, tS, tOff);
  // The last edge is exactly 1 (no rounding drift past the right edge).
  segs.push({ kind: 'release', x0: x, x1: 1, t0: tOff, t1: tOff + c.release });
  return segs;
}

/** Real time `t` (s from the gate's rise) → x (0..1) on the preview. */
export function adsrTimeToX(p: AdsrParams, t: number): number {
  const segs = adsrLayout(p);
  if (!(t > 0)) return 0;
  for (const s of segs) {
    if (t <= s.t1 && s.t1 > s.t0) return s.x0 + ((t - s.t0) / (s.t1 - s.t0)) * (s.x1 - s.x0);
  }
  return 1;
}

/** The envelope's level at real time `t` (s from the gate's rise; the gate falls at the plateau's end). */
export function adsrValueAt(p: AdsrParams, t: number): number {
  const c = clampAdsr(p);
  const tA = c.delay;
  const tD = tA + c.attack;
  const tOff = tD + 2 * c.decay;
  const held = (u: number) => {
    if (u <= tA) return 0;
    if (u <= tD) return (u - tA) / c.attack;
    return c.sustain + (1 - c.sustain) * Math.exp((-(u - tD) * LN_100) / c.decay);
  };
  if (t <= tOff) return held(t);
  return held(tOff) * Math.exp((-(t - tOff) * LN_100) / c.release);
}

/** Points per curved (exponential) segment: chord error < 0.003 of full scale. */
const CURVE_PTS = 32;

/** The ADSR preview's polyline: [x 0..1, level 0..1], x increasing. */
export function adsrPoints(p: AdsrParams): [number, number][] {
  const pts: [number, number][] = [];
  for (const s of adsrLayout(p)) {
    if (s.x1 <= s.x0) continue;
    // Linear segments need their ends only; the plateau barely moves (≤ 1 %).
    const n = s.kind === 'decay' || s.kind === 'release' ? CURVE_PTS : s.kind === 'sustain' ? 8 : 1;
    for (let i = pts.length ? 1 : 0; i <= n; i++) {
      const f = i / n;
      pts.push([s.x0 + f * (s.x1 - s.x0), adsrValueAt(p, s.t0 + f * (s.t1 - s.t0))]);
    }
  }
  return pts;
}

export interface LfoParams {
  wave: number;
  rate: number;
  sync: number;
  division: number;
  depth: number;
}

/** One cycle of `wave` (lfo.rs: 0 Sine, 1 Tri, 2 Saw, 3+ Square) at `phase` 0..1. */
export function lfoWave(wave: number, phase: number): number {
  const p = phase - Math.floor(phase);
  switch (Math.max(0, Math.trunc(fin(wave, 0)))) { // the engine's `as u32`
    case 0: return Math.sin(2 * Math.PI * p);
    case 1: return 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5);
    case 2: return 2 * p - 1;
    default: return p < 0.5 ? 1 : -1;
  }
}

/** The LFO preview's polyline: [phase 0..1, value −depth..depth]; jumps are vertical (two points at one x). */
export function lfoPoints(wave: number, depth: number): [number, number][] {
  const d = Math.min(1, Math.max(0, fin(depth, 0)));
  const w = Math.max(0, Math.trunc(fin(wave, 0))); // the engine's `as u32`
  if (w === 2) return [[0, -d], [1, d]];
  if (w >= 3) return [[0, d], [0.5, d], [0.5, -d], [1, -d]];
  if (w === 1) return [[0, 0], [0.25, d], [0.75, -d], [1, 0]];
  const n = 64; // a sine: chord error 1 - cos(π / 64) < 0.0013
  return Array.from({ length: n + 1 }, (_, i) => [i / n, d * Math.sin((2 * Math.PI * i) / n)] as [number, number]);
}

/** A polyline's y at `x` (linear between points; at a vertical jump, the later point). */
export function polyAt(pts: [number, number][], x: number): number {
  if (!pts.length) return 0;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (x < x1 || (x === x1 && i === pts.length - 1)) {
      const [x0, y0] = pts[i - 1];
      return x1 > x0 ? y0 + ((x - x0) / (x1 - x0)) * (y1 - y0) : y1;
    }
  }
  return pts[pts.length - 1][1];
}

/** "5 ms", "250 ms", "1.20 s". */
export function fmtTime(s: number): string {
  return s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`;
}

/** The ADSR label: "5 ms · 200 ms · 70% · 300 ms" (A · D · S · R), "+250 ms · …" with a delay. */
export function adsrLabel(p: AdsrParams): string {
  const c = clampAdsr(p);
  const parts = [fmtTime(c.attack), fmtTime(c.decay), `${Math.round(c.sustain * 100)}%`, fmtTime(c.release)];
  return (c.delay > 0 ? `+${fmtTime(c.delay)} · ` : '') + parts.join(' · ');
}

/** Seconds per LFO cycle: 1 / rate, or the division at `bpm` when synced (lfo.rs: bpm ≥ 1). */
export function lfoPeriod(p: LfoParams, bpm: number): number {
  if (p.sync >= 0.5) {
    const ticks = DIVISION_TICKS[Math.max(0, Math.min(DIVISION_TICKS.length - 1, Math.trunc(fin(p.division, 3))))];
    return (ticks * 60) / (Math.max(1, fin(bpm, 120)) * 960);
  }
  const hz = Math.min(1000, Math.max(0, fin(p.rate, 0)));
  return hz > 0 ? 1 / hz : Infinity;
}

/** "2.00 Hz · 500 ms", or "1/4 · 500 ms" when synced (at the current tempo). */
export function lfoLabel(p: LfoParams, bpm: number, divisions: readonly string[] = LFO_DIVISIONS): string {
  const period = lfoPeriod(p, bpm);
  const t = Number.isFinite(period) ? fmtTime(period) : '∞';
  if (p.sync >= 0.5) return `${divisions[Math.max(0, Math.min(divisions.length - 1, Math.trunc(fin(p.division, 3))))]} · ${t}`;
  return `${fin(p.rate, 0).toFixed(2)} Hz · ${t}`;
}

/** The catalog's LFO division names (catalog.rs LFO_DIVISIONS; ShapePreview passes the catalog's own). */
export const LFO_DIVISIONS = ['1/16', '1/8', '1/8.', '1/4', '1/2', '1 bar', '2 bars', '4 bars'] as const;

/** Voice LEDs: the LED's bottom of range (dB); the engine's floor is −60 dB (dark there anyway). */
export const LED_FLOOR_DB = -48;

/** A voice level (linear peak, visSab voices) → LED brightness 0..1: −48..0 dB → 0..1, clamped. */
export function voiceLedLevel(level: number): number {
  if (!(level > 0)) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, (db - LED_FLOOR_DB) / -LED_FLOOR_DB));
}
