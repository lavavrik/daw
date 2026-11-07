// Song-timeline maths: pure, DOM-free, unit-tested (tlMath.test.ts).
//
// Coordinates (CSS px) are those of the *lanes area* (Timeline.svelte), to the
// right of the track headers:
// - x = 0 is the area's left edge, where tick `scrollTick` sits (time is
//   scrolled virtually, by the view);
// - y = 0 is the top of lane 0 (below the ruler); lane i covers
//   [i * laneH, (i + 1) * laneH). Vertical scrolling is native (the pane's
//   scroll container), so y here is content y, not viewport y.
import { MAX_SONG_TICKS } from '../../audio/protocol';

/** Ticks per beat / bar (4/4 at 960 PPQ). */
export const BEAT = 960;
export const BAR = 3840;
/** Lane height (px): the Song pane is only ~0.5fr of the right column. */
export const LANE_H = 28;
/** Width of the track-header column (px). */
export const HEADER_W = 160;
export const RULER_H = 20;
/** Resize handles: the outer EDGE_ZONE px at each end of a clip. */
export const EDGE_ZONE = 6;
/** Zoom limits (ticks per px): a beat at most 480 px wide; 999 bars fit ~10 000 px. */
export const ZOOM = { minTpp: 2, maxTpp: 400 };

export interface TlView {
  /** Horizontal zoom: ticks per CSS pixel. */
  ticksPerPx: number;
  /** Tick at x = 0. */
  scrollTick: number;
  /** Lane height (px). */
  laneH: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mod = (x: number, m: number) => ((x % m) + m) % m;

// ---- geometry ---------------------------------------------------------------

export const tickToX = (t: number, v: TlView) => (t - v.scrollTick) / v.ticksPerPx;
export const xToTick = (x: number, v: TlView) => x * v.ticksPerPx + v.scrollTick;
/** Top edge of lane `lane`. */
export const laneToY = (lane: number, v: TlView) => lane * v.laneH;
/** Lane under content y (may be < 0 or past the last lane: the caller checks). */
export const yToLane = (y: number, v: TlView) => Math.floor(y / v.laneH);

// ---- snapping ---------------------------------------------------------------

/** Nearest grid line. */
export const snap = (t: number, grid: number) => Math.round(t / grid) * grid;
/** Grid line at or before `t`. */
export const snapFloor = (t: number, grid: number) => Math.floor(t / grid) * grid;
/** Grid line at or after `t`. */
export const snapCeil = (t: number, grid: number) => Math.ceil(t / grid) * grid;

/** Ruler click: nearest beat (`free` = Alt: the exact tick), inside the song. */
export function seekTick(t: number, free: boolean): number {
  return clamp(free ? Math.round(t) : snap(t, BEAT), 0, MAX_SONG_TICKS);
}

/**
 * Ruler drag -> loop range: whole bars covering both ends (bar-inclusive: a
 * drag from inside bar 2 to inside bar 3 loops bars 2-3), at least one bar,
 * inside the song.
 */
export function loopFromDrag(t0: number, t1: number): { start: number; end: number } {
  const lo = clamp(Math.min(t0, t1), 0, MAX_SONG_TICKS - 1);
  const hi = clamp(Math.max(t0, t1), 0, MAX_SONG_TICKS);
  const start = snapFloor(lo, BAR);
  const end = Math.min(MAX_SONG_TICKS, Math.max(start + BAR, snapCeil(hi, BAR)));
  return { start, end };
}

// ---- hit-testing -------------------------------------------------------------

export interface ClipBox {
  id: string;
  /** Lane index (position in the track list). */
  lane: number;
  start: number;
  len: number;
}

/** Clips are drawn at least this wide (px), and hit that wide too. */
export const MIN_CLIP_W = 3;

/**
 * The clip under (x, y), last in array order first (it is drawn on top).
 * 'left' / 'right' = the resize zones: EDGE_ZONE px, but at most a third of
 * the clip each, so a short clip can still be grabbed to move.
 */
export function hitTest(clips: readonly ClipBox[], x: number, y: number, v: TlView): { id: string; part: 'body' | 'left' | 'right' } | null {
  const lane = yToLane(y, v);
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    if (c.lane !== lane) continue;
    const x0 = tickToX(c.start, v);
    const x1 = Math.max(tickToX(c.start + c.len, v), x0 + MIN_CLIP_W);
    if (x < x0 || x >= x1) continue;
    const zone = Math.min(EDGE_ZONE, (x1 - x0) / 3);
    return { id: c.id, part: x < x0 + zone ? 'left' : x >= x1 - zone ? 'right' : 'body' };
  }
  return null;
}

/** Ids of the clips whose lane and time span overlap the rectangle (any corner order). */
export function boxSelect(clips: readonly ClipBox[], x0: number, y0: number, x1: number, y1: number, v: TlView): string[] {
  const tA = xToTick(Math.min(x0, x1), v);
  const tB = xToTick(Math.max(x0, x1), v);
  const lA = yToLane(Math.min(y0, y1), v);
  const lB = yToLane(Math.max(y0, y1), v);
  return clips.filter((c) => c.lane >= lA && c.lane <= lB && c.start < tB && c.start + c.len > tA).map((c) => c.id);
}

// ---- clip edits ----------------------------------------------------------------

/** Most repeat markers drawn per clip (a 1/16 pattern over 999 bars would be ~16 000). */
const MAX_MARKS = 4096;

/**
 * Song ticks where the clip's pattern restarts, strictly inside the clip
 * (the clip plays pattern position (offset + t - start) mod patLen).
 */
export function repeatTicks(start: number, len: number, offset: number, patLen: number): number[] {
  const out: number[] = [];
  if (!(patLen > 0)) return out;
  const phase = mod(offset, patLen);
  let t = start + (phase === 0 ? patLen : patLen - phase);
  for (; t < start + len && out.length < MAX_MARKS; t += patLen) out.push(t);
  return out;
}

/**
 * Left-edge resize to `newStart` (clamped to 0 .. end - minLen): the end stays
 * and so does the music under it, because the offset follows the start
 * (wrapped mod the pattern length; growing left reveals earlier repeats).
 */
export function resizeLeft(
  c: { start: number; len: number; offset: number }, newStart: number, patLen: number, minLen: number,
): { start: number; len: number; offset: number } {
  const end = c.start + c.len;
  const start = Math.round(clamp(newStart, 0, Math.max(0, end - minLen)));
  return { start, len: end - start, offset: mod(c.offset + (start - c.start), patLen) };
}

/** Right-edge resize: the new length (at least minLen, ending inside the song). */
export function resizeRight(c: { start: number; len: number }, newEnd: number, minLen: number): number {
  return Math.round(clamp(newEnd - c.start, minLen, MAX_SONG_TICKS - c.start));
}

/** A group move's time delta, clamped so every clip stays in 0..MAX_SONG_TICKS (same as moveClips). */
export function clampGroupDt(clips: readonly { start: number; len: number }[], dt: number): number {
  if (!clips.length) return 0;
  const minStart = Math.min(...clips.map((c) => c.start));
  const maxEnd = Math.max(...clips.map((c) => c.start + c.len));
  return clamp(dt, -minStart, MAX_SONG_TICKS - maxEnd) + 0; // + 0: no -0
}

/**
 * Length of a clip placed at `start` by a click: the pattern length, cut at
 * the next clip on the lane (placing never hides an existing clip under a
 * new one) and at the song end.
 */
export function placeLen(lane: readonly { start: number }[], start: number, patLen: number): number {
  let len = Math.min(patLen, MAX_SONG_TICKS - start);
  for (const c of lane) if (c.start > start) len = Math.min(len, c.start - start);
  return len;
}

// ---- labels / view -------------------------------------------------------------

/** "bar 2" / "bars 1–4" (1-based; any partial bar counts). */
export function barRange(start: number, len: number): string {
  const a = Math.floor(start / BAR) + 1;
  const b = Math.floor((start + len - 1) / BAR) + 1;
  return a === b ? `bar ${a}` : `bars ${a}–${b}`;
}

/** Bars per ruler label (1, 2, 4, …) so labels sit at least 28 px apart. */
export function barLabelStep(ticksPerPx: number): number {
  const pxPerBar = BAR / ticksPerPx;
  let step = 1;
  while (step * pxPerBar < 28 && step < 1024) step *= 2;
  return step;
}

/** Zoom by `factor` (< 1 = in) around pointer x; scroll never goes below 0. */
export function zoomAt(v: TlView, factor: number, x: number, lim: { minTpp: number; maxTpp: number }): TlView {
  const ticksPerPx = clamp(v.ticksPerPx * factor, lim.minTpp, lim.maxTpp);
  const at = xToTick(x, v);
  return { ...v, ticksPerPx, scrollTick: Math.max(0, at - x * ticksPerPx) };
}

// ---- audio lanes (plan 9) ------------------------------------------------------

/** Where a dropped audio file goes. */
export type DropTarget = { audioLane: number } | { newTrack: true } | { refused: true };

/**
 * Drop target for content y over the lanes (`rows`: the tracks in lane
 * order): an Audio lane takes the clip, anything below the last lane makes a
 * new Audio track (so does an empty timeline), a drum or synth lane only
 * shows a hint, and so does the ruler (y < 0).
 */
export function dropTarget(rows: readonly { kind: string }[], y: number, laneH = LANE_H): DropTarget {
  if (y < 0) return { refused: true };
  const lane = Math.floor(y / laneH);
  if (lane >= rows.length) return { newTrack: true };
  return rows[lane].kind === 'audio' ? { audioLane: lane } : { refused: true };
}

/** Song ticks of `seconds` at `tempo` BPM (clips play at native speed: this moves with the tempo). */
export const fileTicks = (seconds: number, tempo: number) => (seconds * tempo * BEAT) / 60;

/** The parts of an audio clip the lane needs (offset: seconds into the file). */
export interface AudioClipBox {
  start: number;
  len: number;
  offset: number;
  loop: boolean;
}

/**
 * How far an audio clip's edges can go: a one-shot clip's left edge stops
 * where its file starts (and at tick 0), its right edge where the file ends
 * at the current tempo (the same rounding as audio-actions' cap). A loop
 * clip, or one whose file length is unknown (`seconds` null), only has the
 * song's bounds.
 */
export function audioEdges(c: AudioClipBox, seconds: number | null, tempo: number): { minStart: number; maxEnd: number } {
  if (c.loop || seconds === null) return { minStart: 0, maxEnd: MAX_SONG_TICKS };
  const back = fileTicks(c.offset, tempo);
  const rest = Math.max(1, Math.ceil(fileTicks(seconds - c.offset, tempo) - 1e-9));
  return { minStart: Math.max(0, Math.ceil(c.start - back - 1e-9)), maxEnd: Math.min(MAX_SONG_TICKS, c.start + rest) };
}

/**
 * The lane's marks inside an audio clip: for a loop clip, a notch every file
 * length where the file starts again (`repeats`); for a one-shot clip, the
 * tick where its file runs out when that is before the clip end (after a
 * tempo change: `fileEnd`). Nothing when the file length is unknown.
 */
export function audioMarks(c: AudioClipBox, seconds: number | null, tempo: number): { repeats: number[]; fileEnd: number | null } {
  if (seconds === null || !(seconds > 0)) return { repeats: [], fileEnd: null };
  const fl = fileTicks(seconds, tempo);
  if (c.loop) return { repeats: repeatTicks(c.start, c.len, fileTicks(c.offset, tempo), fl), fileEnd: null };
  const end = c.start + fl - fileTicks(c.offset, tempo);
  return { repeats: [], fileEnd: end < c.start + c.len - 0.5 ? end : null };
}
