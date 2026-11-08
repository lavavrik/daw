// Song-timeline maths: pure, DOM-free, unit-tested (tlMath.test.ts).
//
// Coordinates (CSS px) are those of the *lanes area* (Timeline.svelte), to the
// right of the track headers:
// - x = 0 is the area's left edge, where tick `scrollTick` sits (time is
//   scrolled virtually, by the view);
// - y = 0 is the top of the first row (below the ruler). Rows are NOT
//   uniform (plan 10): every y -> row question goes through the layout map
//   (rowLayout / rowAt): drops, clip hit tests, box selection, cross-lane
//   moves, drawing and the header column. Vertical scrolling is native (the
//   pane's scroll container), so y here is content y, not viewport y.
import { MAX_SONG_TICKS } from '../../audio/protocol';
import { toPos } from '../rack/knobMath';
import type { CurveDef } from '../rack/knobMath';
import { bend } from '../../state/automation';
import { THEME } from '../theme';

/** Ticks per beat / bar (4/4 at 960 PPQ). */
export const BEAT = 960;
export const BAR = 3840;
/** Clip row height (px): the Song pane is only ~0.5fr of the right column. */
export const LANE_H = 28;
/** Automation lane row height (px): the default; a lane can be resized (plan 19, laneView.heights). */
export const AUTO_H = 48;
/** Resized lane row heights stay within these (px). */
export const LANE_MIN_H = 32;
export const LANE_MAX_H = 240;
/** Width of the track-header column (px): colour bar, name over the volume slider, M/S/A, ×. */
export const HEADER_W = 176;
/**
 * The ruler (plan 21 §6): two labelled rows, BAR on top (bar numbers, beat
 * ticks, the loop bar and the playhead head) and TIME under it (m:ss labels,
 * timeLabels). The header column's top-left cell labels them "Bar" / "Time".
 */
export const RULER_BAR_H = 18;
export const RULER_TIME_H = 14;
export const RULER_H = RULER_BAR_H + RULER_TIME_H;
/** The loop range's bar says "Loop" once it is at least this wide on screen (px). */
export const LOOP_LABEL_MIN_PX = 40;
/** Resize handles: the outer EDGE_ZONE px at each end of a clip. */
export const EDGE_ZONE = 6;
/** Zoom limits (ticks per px): a beat at most 480 px wide; 999 bars fit ~10 000 px. */
export const ZOOM = { minTpp: 2, maxTpp: 400 };

export interface TlView {
  /** Horizontal zoom: ticks per CSS pixel. */
  ticksPerPx: number;
  /** Tick at x = 0. */
  scrollTick: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mod = (x: number, m: number) => ((x % m) + m) % m;

// ---- geometry ---------------------------------------------------------------

export const tickToX = (t: number, v: TlView) => (t - v.scrollTick) / v.ticksPerPx;
export const xToTick = (x: number, v: TlView) => x * v.ticksPerPx + v.scrollTick;

// ---- layout map (plan 10) ---------------------------------------------------

/** The Master row's trackId (its rows and lanes), and its key in rowLayout's `open`. */
export const MASTER_ROW = 'master';
/** The Master row's colour: its header and its lanes' curves (a theme grey, not a track colour). */
export const MASTER_GREY = THEME.textDim;

/**
 * One row of the timeline, top to bottom:
 * - `clips`: a track's clip lane (LANE_H);
 * - `lane`: an automation lane (its own height: rowLayout's `laneH`, AUTO_H
 *   by default) of track `trackId`, or of the Master row (trackId
 *   MASTER_ROW). Without `laneId` it is an open owner's empty lane row
 *   (always AUTO_H): no lane yet, its header offers "Automate…";
 * - `master`: the Master row's own header row (LANE_H): no clips.
 * `track` is the owner's index in the track list (moveClips' lanes, ClipBox
 * lane), -1 for the Master row.
 */
export interface Row {
  kind: 'clips' | 'lane' | 'master';
  trackId: string;
  laneId?: string;
  y: number;
  h: number;
  track: number;
}

/**
 * The layout map: each track's clip row, then, while the track is open
 * (`open` has its id: the header's A toggle), one row per automation lane
 * (or one empty lane row when it has none). `masterRow` (null: no Master row)
 * is the Master row's lanes: its header row is pinned under the last track,
 * and its lanes follow while `open` has MASTER_ROW. `laneH` is each lane
 * row's height by lane id (the timeline passes laneView.laneHeight); every
 * lane-local hit test and drawing must then use that row's `h`.
 */
export function rowLayout(
  tracks: readonly { id: string; automation: readonly { id: string }[] }[],
  open: ReadonlySet<string>,
  masterRow: readonly { id: string }[] | null,
  laneH: (laneId: string) => number = () => AUTO_H,
): Row[] {
  const rows: Row[] = [];
  let y = 0;
  const push = (r: Omit<Row, 'y'>) => {
    rows.push(r.laneId === undefined ? { kind: r.kind, trackId: r.trackId, y, h: r.h, track: r.track } : { ...r, y });
    y += r.h;
  };
  const lanes = (trackId: string, list: readonly { id: string }[], track: number) => {
    if (!open.has(trackId)) return;
    if (!list.length) push({ kind: 'lane', trackId, h: AUTO_H, track });
    for (const l of list) push({ kind: 'lane', trackId, laneId: l.id, h: laneH(l.id), track });
  };
  tracks.forEach((t, i) => {
    push({ kind: 'clips', trackId: t.id, h: LANE_H, track: i });
    lanes(t.id, t.automation, i);
  });
  if (masterRow) {
    push({ kind: 'master', trackId: MASTER_ROW, h: LANE_H, track: -1 });
    lanes(MASTER_ROW, masterRow, -1);
  }
  return rows;
}

/** Total height of the rows (px). */
export const rowsHeight = (rows: readonly Row[]) => (rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : 0);

/** The row under content y, or null (above the first row or below the last). */
export function rowAt<R extends Row>(rows: readonly R[], y: number): R | null {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid];
    if (y < r.y) hi = mid - 1;
    else if (y >= r.y + r.h) lo = mid + 1;
    else return r;
  }
  return null;
}

/** Track index under content y when it is over a clip row, else -1 (a lane row, the Master row, outside). */
export function clipLaneAt(rows: readonly Row[], y: number): number {
  const r = rowAt(rows, y);
  return r && r.kind === 'clips' ? r.track : -1;
}

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
export function hitTest(
  clips: readonly ClipBox[], x: number, y: number, v: TlView, rows: readonly Row[],
): { id: string; part: 'body' | 'left' | 'right' } | null {
  const lane = clipLaneAt(rows, y);
  if (lane < 0) return null;
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

/** Ids of the clips whose clip row and time span overlap the rectangle (any corner order). */
export function boxSelect(
  clips: readonly ClipBox[], x0: number, y0: number, x1: number, y1: number, v: TlView, rows: readonly Row[],
): string[] {
  const tA = xToTick(Math.min(x0, x1), v);
  const tB = xToTick(Math.max(x0, x1), v);
  const yA = Math.min(y0, y1);
  const yB = Math.max(y0, y1);
  const lanes = new Set(rows.filter((r) => r.kind === 'clips' && r.y <= yB && r.y + r.h > yA).map((r) => r.track));
  return clips.filter((c) => lanes.has(c.lane) && c.start < tB && c.start + c.len > tA).map((c) => c.id);
}

// ---- clip previews (plan 20) -----------------------------------------------------
// A pattern clip shows a mini preview of its pattern under its name: step
// marks for a drum pattern, note dashes for a synth pattern. The marks are
// computed once per pattern content (Timeline's `previews`), normalised to one
// pattern period, so a scroll or zoom only re-places them (periodStarts).

/**
 * One mark of a preview, normalised: `t0`..`t1` as fractions of the pattern
 * length, `y` and `h` as fractions of the preview band's height (0 = top).
 */
export interface PreviewMark {
  t0: number;
  t1: number;
  y: number;
  h: number;
}

/**
 * Drum pattern preview: a mark per hit (velocity > 0) in the first
 * `stepCount` steps of the track's first `rows` rows. Each row with a hit
 * gets an equal band, top to bottom in row order; rows without hits take no
 * space, so a two-sound beat stays readable in a 6 px band.
 */
export function drumPreview(steps: readonly (readonly number[])[], rows: number, stepCount: number): PreviewMark[] {
  const used: number[] = [];
  for (let r = 0; r < Math.min(rows, steps.length); r++) {
    for (let s = 0; s < stepCount; s++) if (steps[r][s] > 0) { used.push(r); break; }
  }
  const out: PreviewMark[] = [];
  const h = 1 / (used.length || 1);
  used.forEach((r, k) => {
    for (let s = 0; s < stepCount; s++) if (steps[r][s] > 0) out.push({ t0: s / stepCount, t1: (s + 1) / stepCount, y: k * h, h });
  });
  return out;
}

/**
 * Note pattern preview: a dash per note that starts inside the loop (`bars`;
 * notes after it don't play), from its start to its end, cut at the loop
 * end; the pattern's pitch range spans the band (highest on top), at least
 * 4 pitch rows tall so a one-note line is a dash, not a block.
 */
export function notePreview(notes: readonly { pitch: number; start: number; len: number }[], bars: number): PreviewMark[] {
  const loop = bars * BAR;
  const inLoop = notes.filter((n) => n.start < loop);
  if (!inLoop.length || !(loop > 0)) return [];
  const lo = Math.min(...inLoop.map((n) => n.pitch));
  const hi = Math.max(...inLoop.map((n) => n.pitch));
  const rows = Math.max(4, hi - lo + 1);
  const top = hi + Math.floor((rows - (hi - lo + 1)) / 2);
  return inLoop.map((n) => ({ t0: n.start / loop, t1: Math.min(1, (n.start + n.len) / loop), y: (top - n.pitch) / rows, h: 1 / rows }));
}

/**
 * The song ticks where the clip's pattern periods start (the clip plays
 * pattern position (offset + t - start) mod patLen), for the periods that
 * overlap both the clip and song ticks [t0, t1): the ones a preview draws.
 */
export function periodStarts(start: number, len: number, offset: number, patLen: number, t0: number, t1: number): number[] {
  const out: number[] = [];
  if (!(patLen > 0)) return out;
  const lo = Math.max(start, t0);
  const hi = Math.min(start + len, t1);
  const first = start - mod(offset, patLen);
  let t = first + Math.max(0, Math.floor((lo - first) / patLen)) * patLen;
  for (; t < hi && out.length < MAX_MARKS; t += patLen) if (t + patLen > lo) out.push(t);
  return out;
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

/**
 * Play follow (the Song-mode rAF loop): when the heard playhead leaves the
 * view (off either side, or within 12 px of the right edge) on a frame after
 * it was visible, the view pages to the bar before it (`scrollTick`; null:
 * no flip). Never while `busy` (a clip drag or an AutoLane gesture is down:
 * the view must not move under the pointer); it stays armed, so the flip
 * comes on the first frame after the release. `visible` is the next frame's
 * `wasVisible`.
 */
export function followPage(v: TlView, playTick: number, width: number, wasVisible: boolean, busy: boolean): { scrollTick: number | null; visible: boolean } {
  const x = tickToX(playTick, v);
  const visible = x >= 0 && x <= width - 12;
  const flip = !visible && wasVisible && !busy;
  return { scrollTick: flip ? snapFloor(playTick, BAR) - BAR : null, visible: visible || busy };
}

/** Bars per ruler label (1, 2, 4, …) so labels sit at least 28 px apart. */
export function barLabelStep(ticksPerPx: number): number {
  const pxPerBar = BAR / ticksPerPx;
  let step = 1;
  while (step * pxPerBar < 28 && step < 1024) step *= 2;
  return step;
}

// ---- song time (the ruler's TIME row and the hover readout) ---------------------
// The tempo is one value per project (no tempo map), so seconds are linear in
// ticks: seconds = ticks * 60 / (tempo * BEAT). fileTicks (below) is the inverse.

/** Seconds from the song start to tick `t` at `tempo` BPM. */
export const tickSeconds = (t: number, tempo: number) => (t * 60) / (tempo * BEAT);

/** TIME labels sit at least this far apart (px): "12:34" in the 9 px mono font plus air. */
export const TIME_LABEL_MIN_PX = 48;
/** Seconds per TIME label, smallest first: round clock values only. */
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** Seconds per TIME label: the smallest TIME_STEPS entry whose labels sit >= TIME_LABEL_MIN_PX apart (the last one when none does). */
export function timeLabelStep(ticksPerPx: number, tempo: number): number {
  const pxPerSec = (tempo * BEAT) / 60 / ticksPerPx;
  return TIME_STEPS.find((s) => s * pxPerSec >= TIME_LABEL_MIN_PX) ?? TIME_STEPS[TIME_STEPS.length - 1];
}

/** "m:ss", rounded to the nearest second (minutes run past 59: "75:00"). */
export function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The TIME labels for ticks t0..t1: every timeLabelStep seconds from 0:00, each at the tick where that second falls. */
export function timeLabels(t0: number, t1: number, ticksPerPx: number, tempo: number): { t: number; text: string }[] {
  const step = timeLabelStep(ticksPerPx, tempo);
  const out: { t: number; text: string }[] = [];
  for (let s = Math.max(0, Math.ceil(tickSeconds(t0, tempo) / step - 1e-9)) * step; ; s += step) {
    const t = fileTicks(s, tempo);
    if (t > t1) break;
    out.push({ t, text: clockLabel(s) });
  }
  return out;
}

/** The hover readout: "Bar 5.3 · 0:09.4" (1-based bar.beat, then m:ss.t with the tenths floored). */
export function posReadout(tick: number, tempo: number): string {
  const t = Math.max(0, tick);
  const bar = Math.floor(t / BAR) + 1;
  const beat = Math.floor((t % BAR) / BEAT) + 1;
  const tenths = Math.floor(tickSeconds(t, tempo) * 10 + 1e-6);
  const m = Math.floor(tenths / 600);
  const sec = (tenths % 600) / 10;
  return `Bar ${bar}.${beat} · ${m}:${sec.toFixed(1).padStart(4, '0')}`;
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
 * Drop target for content y over the lanes (`tracks` in lane order, `rows`
 * their layout map): an Audio track's clip row takes the clip, anything below
 * the last row makes a new Audio track (so does an empty timeline), a drum or
 * synth clip row, an automation lane or the Master row only shows a hint,
 * and so does the ruler (y < 0).
 */
export function dropTarget(tracks: readonly { kind: string }[], rows: readonly Row[], y: number): DropTarget {
  if (y < 0) return { refused: true };
  if (y >= rowsHeight(rows)) return { newTrack: true };
  const lane = clipLaneAt(rows, y);
  return lane >= 0 && tracks[lane]?.kind === 'audio' ? { audioLane: lane } : { refused: true };
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

// ---- automation lane points (plan 10) ------------------------------------------

/** Space kept above and below the curve in an automation lane (px), so the extreme points stay grabbable. */
export const AUTO_PAD = 6;
/** A point is grabbed within this many px (its dot is drawn smaller). */
export const POINT_R = 6;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
// Every helper below takes the lane row's height `h` (Row.h: a lane can be
// resized, plan 19), with no default: a forgotten `h` must not silently mean
// AUTO_H in a taller or shorter lane.
/** Lane-local y of knob position `pos` (0 = bottom of the travel, 1 = top) in a row `h` tall. */
export const posToY = (pos: number, h: number) => AUTO_PAD + (1 - pos) * (h - 2 * AUTO_PAD);
/** Knob position at lane-local y in a row `h` tall (clamped to 0..1). */
export const yToPos = (y: number, h: number) => clamp01(1 - (y - AUTO_PAD) / (h - 2 * AUTO_PAD));

/** What the point hit tests need of a lane: its points and its param's curve. */
export interface LanePoints {
  points: readonly { id: string; tick: number; value: number }[];
  def: CurveDef;
}

/**
 * The point under lane-local (x, y) within POINT_R px (the nearest if several
 * are), or null. Values sit at their knob position, as the lane draws them.
 */
export function pointHit(lane: LanePoints, x: number, y: number, v: TlView, h: number): string | null {
  let best: string | null = null;
  let bestD = POINT_R * POINT_R;
  for (const pt of lane.points) {
    const dx = tickToX(pt.tick, v) - x;
    const dy = posToY(toPos(lane.def, pt.value), h) - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = pt.id;
    }
  }
  return best;
}

/** Ids of the points inside the lane-local rectangle (any corner order). */
export function pointBox(lane: LanePoints, x0: number, y0: number, x1: number, y1: number, v: TlView, h: number): string[] {
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  return lane.points.filter((pt) => {
    const x = tickToX(pt.tick, v);
    const y = posToY(toPos(lane.def, pt.value), h);
    return x >= xa && x <= xb && y >= ya && y <= yb;
  }).map((pt) => pt.id);
}

/**
 * The fractions (0..1, exclusive, ascending) at which a curved segment from
 * x0 to x1 rising `dy` px is sampled for drawing (plan 16): every 2 px of x
 * AND every px of y, so each chord spans at most 2 px across and 1 px up
 * (curve 1 rises most of the way in its first pixels; -1 in its last). Only
 * the part in -1..W+1 is sampled, so a segment far wider than the view (deep
 * zoom) costs no more than the view.
 */
function curveSamples(x0: number, x1: number, dy: number, curve: number, W: number): number[] {
  const span = x1 - x0;
  if (!(span > 0)) return [];
  const lo = Math.max(0, (-1 - x0) / span);
  const hi = Math.min(1, (W + 1 - x0) / span);
  if (!(hi > lo)) return [];
  const out: number[] = [];
  if (lo > 0) out.push(lo);
  if (hi < 1) out.push(hi);
  const nx = Math.ceil(((hi - lo) * span) / 2);
  for (let k = 1; k < nx; k++) out.push(lo + ((hi - lo) * k) / nx);
  // Even steps of y: the inverse of bend, x = y^(2^(3 curve)). |dy| is at most the row's height.
  const ny = Math.ceil(Math.abs(dy));
  const inv = 2 ** (3 * curve);
  for (let k = 1; k < ny; k++) {
    const u = (k / ny) ** inv;
    if (u > lo && u < hi) out.push(u);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The vertices of a lane's drawn curve (lane-local px), from x = -1 to
 * W + 1: flat at the first point's value before it and at the last's after
 * it; a linear segment is a straight line between its points' KNOB
 * positions, which is exactly what laneValueAt (and the engine) interpolate,
 * exp params included (only inside an exp param's zero zone, where the value
 * is exactly 0, the line is up to ZERO_ZONE of the travel off: < 1 px); a
 * curved one (plan 16) bends the same knob-space line by `bend`, sampled
 * by curveSamples (within half a pixel); a hold point runs flat to the next
 * point's x, then steps.
 */
export function lanePolyline(
  points: readonly { tick: number; value: number; hold: boolean; curve?: number }[], def: CurveDef, v: TlView, W: number, h: number,
): [number, number][] {
  if (!points.length) return [];
  const pts = points.map((x) => ({ x: tickToX(x.tick, v), y: posToY(toPos(def, x.value), h), hold: x.hold, curve: x.curve ?? 0 }));
  const out: [number, number][] = [[-1, pts[0].y]];
  pts.forEach((a, i) => {
    out.push([a.x, a.y]);
    const b = pts[i + 1];
    if (b && a.hold) out.push([b.x, a.y]);
    else if (b && a.curve !== 0 && b.y !== a.y) {
      for (const u of curveSamples(a.x, b.x, b.y - a.y, a.curve, W)) out.push([a.x + u * (b.x - a.x), a.y + (b.y - a.y) * bend(u, a.curve)]);
    }
  });
  out.push([W + 1, pts[pts.length - 1].y]);
  return out;
}

/** A segment is grabbed (Alt-drag: its curve) within this many px of the drawn line. */
export const SEGMENT_R = 5;
/** Alt-drag on a segment: this many px of vertical travel is the curve's full range, -1..1 (plan 16). */
export const CURVE_PX = 100;

/**
 * The point whose segment (to the next point) is under lane-local (x, y):
 * x strictly between the two points and y within SEGMENT_R px of the drawn
 * line there (curve included), or null. A hold point's flat run and the
 * flat ends before the first and after the last point are no segment.
 * Points sorted by tick, as the model keeps them. Check pointHit first: a
 * point wins over its segments.
 */
export function segmentHit(
  lane: { points: readonly { id: string; tick: number; value: number; hold: boolean; curve?: number }[]; def: CurveDef },
  x: number, y: number, v: TlView, h: number,
): string | null {
  const pts = lane.points;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const xa = tickToX(a.tick, v);
    const xb = tickToX(b.tick, v);
    if (!(x > xa && x < xb)) continue;
    if (a.hold) return null;
    const ya = posToY(toPos(lane.def, a.value), h);
    const yb = posToY(toPos(lane.def, b.value), h);
    const yc = ya + (yb - ya) * bend((x - xa) / (xb - xa), a.curve ?? 0);
    return Math.abs(y - yc) <= SEGMENT_R ? a.id : null;
  }
  return null;
}

/**
 * The curve an Alt-drag sets (plan 16): from `c0` at the press, `dy` px
 * down since (negative: up), on a segment that `rises` (its end is higher
 * on screen; a flat one counts as rising). Dragging up bends the line up:
 * a rising segment gets a positive curve (fast, then slow), a falling one a
 * negative curve (holds high, then drops). CURVE_PX px is the full range;
 * clamped to -1..1 and rounded to 0.01.
 */
export function curveDrag(c0: number, dy: number, rises: boolean): number {
  const c = c0 + ((rises ? -dy : dy) * 2) / CURVE_PX;
  return Math.round(Math.min(1, Math.max(-1, c)) * 100) / 100 || 0;
}
