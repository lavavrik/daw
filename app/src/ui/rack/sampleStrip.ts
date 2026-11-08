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
//   loopStart  start .. end − 1 px
// (the knobs can still set any value; the engine copes, see Task 1's
// degenerate_regions test, and the strip draws it as above).

/** The piano roll's note names: 60 → "C4", 61 → "C#4", 0 → "C-1". */
export { noteName } from '../pianoroll/prMath';

/** The strip's size in CSS px. */
export const STRIP_W = 220;
export const STRIP_H = 48;
/** Arrow-key step on a handle (Shift: a tenth). */
export const STRIP_KEY_STEP = 0.01;

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

/** `v` for marker `m`, kept inside the bounds the other two give (see the top). */
export function clampMarker(m: Marker, v: number, r: Region, w: number): number {
  const px = 1 / (w || 1);
  const s = clamp01(r.start);
  const e = clamp01(r.end);
  switch (m) {
    case 'start':
      return clamp(clamp01(v), 0, Math.max(0, e - px));
    case 'end':
      return clamp(clamp01(v), Math.min(1, s + px), 1);
    case 'loopStart':
      return clamp(clamp01(v), Math.min(s, Math.max(0, e - px)), Math.max(0, e - px));
  }
}

/** A drag: the value it was grabbed at (`from`) moved by `dx` CSS px, clamped. */
export const dragMarker = (m: Marker, from: number, dx: number, r: Region, w: number) =>
  clampMarker(m, from + dx / (w || 1), r, w);

/** An arrow key on a handle: ±0.01, Shift ±0.001, clamped. */
export function stepMarker(m: Marker, r: Region, dir: 1 | -1, fine: boolean, w: number): number {
  const step = fine ? STRIP_KEY_STEP / 10 : STRIP_KEY_STEP;
  // Round to the step's precision so repeated steps don't drift (0.01 + 0.01 …).
  const v = Math.round((r[m] + dir * step) * 1e6) / 1e6;
  return clampMarker(m, v, r, w);
}
