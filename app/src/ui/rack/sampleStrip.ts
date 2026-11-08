// Sample Player strip maths (plan 15 Task 5; SampleStrip.svelte draws it).
// Pure: no DOM, no Svelte; unit-tested in sampleStrip.test.ts.
//
// The strip is the whole sample across STRIP_W px: a param value v in 0..1
// (start, end, loopStart are fractions of the file) sits at x = v · width.
// Its markers follow the engine's effective region
// (docs/architecture/modular.md, Sample Player):
//   s = start, e = max(end, s + 1 frame), loop [max(loopStart, s), e)
// in pixels: the End marker is never drawn left of Start + 1 px, the Loop
// start marker is drawn inside [Start, End].
//
// Dragging or stepping a handle keeps the region sane in value space too:
//   start      0 .. end − 1 px
//   end        start + 1 px .. 1
//   loopStart  start .. end − max(1 px, loopMin)
// loopMin (loopMin()) is the shortest loop the engine loops: two 10 ms seam
// crossfades (2 · round(0.01 · rate) frames) plus one frame of margin for
// the engine's floor(), as a fraction of the file; shorter, it plays the
// region once (loop off). Dragging End left past loopStart + loopMin (Loop
// On) pushes Loop start back with it (one change: the same undo entry),
// never before Start; when even that is too short (End within loopMin of
// Start), the loop tint is drawn hatched, "plays once" (loopTooShort).
// (The knobs can still set any value; the engine copes, see Task 1's
// degenerate_regions test, and the strip draws it as above.)
//
// A drag starts from where the marker is *drawn* (drawnValue), so grabbing
// a marker of a degenerate region (End set left of Start from the knobs)
// moves it from where it is seen, without a jump.

/** The shared note names (ui/noteName.ts): 60 → "C4", 61 → "C#4", 0 → "C-1". */
export { noteName } from '../noteName';

/** The strip's size in CSS px. */
export const STRIP_W = 220;
export const STRIP_H = 48;
/** Arrow-key step on a handle (Shift: a tenth). */
export const STRIP_KEY_STEP = 0.01;
/** PageUp / PageDown step on a handle. */
export const STRIP_PAGE_STEP = 0.1;
/** The engine's loop seam crossfade (sample_player.rs XFADE_SECONDS). */
const XFADE_SECONDS = 0.01;

export type Marker = 'start' | 'end' | 'loopStart';
/** The three Sample Player params the strip edits, as fractions of the file. */
export interface Region {
  start: number;
  end: number;
  loopStart: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(Number.isFinite(v) ? v : 0, 0, 1);

/** x (CSS px) of value `v` on a strip `w` px wide. */
export const valueToX = (v: number, w: number) => clamp01(v) * w;
/** The value at x (CSS px), clamped to 0..1. */
export const xToValue = (x: number, w: number) => clamp01(x / (w || 1));

/** Where the three markers are drawn (CSS px; see the top of this file). */
export function markerXs(r: Region, w: number): Region {
  const start = Math.min(valueToX(r.start, w), Math.max(0, w - 1));
  const end = clamp(Math.max(valueToX(r.end, w), start + 1), 0, w);
  const loopStart = clamp(valueToX(r.loopStart, w), start, end);
  return { start, end, loopStart };
}

/**
 * The shortest loop the engine loops, as a fraction of a `frames`-frame file
 * at `rate` Hz (see the top): 1 when the file is shorter than that, 0 when
 * its length is unknown (no limit).
 */
export function loopMin(frames: number, rate: number): number {
  if (!(frames > 0) || !(rate > 0)) return 0;
  const xf = Math.max(1, Math.round(XFADE_SECONDS * rate));
  return Math.min(1, (2 * xf + 1) / frames);
}

/** Loop start's upper bound: `minLoop` (and at least 1 px) before `end`. */
const loopHi = (end: number, w: number, minLoop: number) => Math.max(0, clamp01(end) - Math.max(1 / (w || 1), minLoop));

/** `v` for marker `m`, kept inside the bounds the other two give (see the top). */
export function clampMarker(m: Marker, v: number, r: Region, w: number, minLoop = 0): number {
  const px = 1 / (w || 1);
  const s = clamp01(r.start);
  const e = clamp01(r.end);
  switch (m) {
    case 'start':
      return clamp(clamp01(v), 0, Math.max(0, e - px));
    case 'end':
      return clamp(clamp01(v), Math.min(1, s + px), 1);
    case 'loopStart': {
      // Never before Start (unless Start is past End − 1 px: knob values);
      // when the region is shorter than minLoop, pinned to Start.
      const lo = Math.min(s, Math.max(0, e - px));
      return clamp(clamp01(v), lo, Math.max(lo, loopHi(e, w, minLoop)));
    }
  }
}

/**
 * Marker `m` set to `v` (clamped): the params that change. With Loop On, End
 * moved left past loopStart + minLoop also pushes Loop start back with it
 * (never before Start, never forward). Empty when nothing changes.
 */
export function markerChanges(m: Marker, v: number, r: Region, w: number, minLoop = 0, loop = false): Partial<Region> {
  const out: Partial<Region> = {};
  const nv = clampMarker(m, v, r, w, minLoop);
  if (nv !== r[m]) out[m] = nv;
  if (m === 'end' && loop) {
    const ls = Math.max(clamp01(r.start), loopHi(nv, w, minLoop));
    if (ls < r.loopStart) out.loopStart = ls;
  }
  return out;
}

/**
 * The loop region the engine plays, [max(loopStart, start), max(end, start)),
 * is shorter than `minLoop`: it plays once (loop off). False when the
 * length is unknown (minLoop 0).
 */
export function loopTooShort(r: Region, minLoop: number): boolean {
  const s = clamp01(r.start);
  const e = Math.max(clamp01(r.end), s);
  const ls = Math.max(clamp01(r.loopStart), s);
  return minLoop > 0 && e - ls < minLoop - 1e-9;
}

/** The value marker `m` is drawn at (its own value unless the drawing clamped it): a drag starts here. */
export function drawnValue(m: Marker, r: Region, w: number): number {
  const x = markerXs(r, w)[m];
  return x === valueToX(r[m], w) ? clamp01(r[m]) : xToValue(x, w);
}

/** A drag: the value it was grabbed at (`from`) moved by `dx` CSS px, clamped. */
export const dragMarker = (m: Marker, from: number, dx: number, r: Region, w: number, minLoop = 0) =>
  clampMarker(m, from + dx / (w || 1), r, w, minLoop);

/** An arrow key on a handle: ±0.01, Shift ±0.001, clamped. */
export function stepMarker(m: Marker, r: Region, dir: 1 | -1, fine: boolean, w: number, minLoop = 0): number {
  return stepBy(m, r, dir * (fine ? STRIP_KEY_STEP / 10 : STRIP_KEY_STEP), w, minLoop);
}

function stepBy(m: Marker, r: Region, d: number, w: number, minLoop: number): number {
  // Round to the step's precision so repeated steps don't drift (0.01 + 0.01 …).
  const v = Math.round((r[m] + d) * 1e6) / 1e6;
  return clampMarker(m, v, r, w, minLoop);
}

/**
 * A key on a focused handle: ←/↓ −0.01, →/↑ +0.01 (Shift a tenth),
 * PageDown / PageUp ∓0.1, Home / End to the lowest / highest value it may
 * take; clamped. Null for any other key.
 */
export function keyMarker(m: Marker, r: Region, key: string, shift: boolean, w: number, minLoop = 0): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return stepMarker(m, r, 1, shift, w, minLoop);
    case 'ArrowLeft':
    case 'ArrowDown':
      return stepMarker(m, r, -1, shift, w, minLoop);
    case 'PageUp':
      return stepBy(m, r, STRIP_PAGE_STEP, w, minLoop);
    case 'PageDown':
      return stepBy(m, r, -STRIP_PAGE_STEP, w, minLoop);
    case 'Home':
      return clampMarker(m, 0, r, w, minLoop);
    case 'End':
      return clampMarker(m, 1, r, w, minLoop);
    default:
      return null;
  }
}

/**
 * The strip's empty-state text, or null when there is a waveform to draw:
 * nothing assigned (`sampleId` < 0) vs an id the session does not know (a
 * sample missing from the project, not decoded / imported here).
 */
export function stripEmptyText(sampleId: number, meta: object | null): string | null {
  if (meta) return null;
  return sampleId >= 0 ? 'Sample not loaded' : 'Drop a sample here';
}
