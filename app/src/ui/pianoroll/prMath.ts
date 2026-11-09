// Piano-roll maths: pure, DOM-free, unit-tested (prMath.test.ts).
//
// Coordinates (CSS px) are those of the *note area*:
// - x = 0 is the canvas' left edge; the keyboard covers 0..keysW, so tick
//   `scrollTick` sits at x = keysW;
// - y = 0 is the top of the note area (below the bar ruler); row 0 is
//   `topPitch`, each row is `rowH` px, higher pitches are higher up.
// The component subtracts the ruler height from pointer y before calling these.
import { GRID_TICKS } from '../../state/pattern-actions';
import { NOTE_NAMES, noteName } from '../noteName';
import { inKey, isKeyRoot, nearestInKey } from '../../music/scales';
import type { MusicKey } from '../../music/scales';

export interface View {
  /** Horizontal zoom: ticks per CSS pixel (960 PPQ). */
  ticksPerPx: number;
  /** Tick at the left edge of the grid (x = keysW). */
  scrollTick: number;
  /** Row height (px) of one semitone. */
  rowH: number;
  /** Pitch of the top row (y = 0). */
  topPitch: number;
  /** Width of the keyboard on the left (px). */
  keysW: number;
}

export type GridKey = keyof typeof GRID_TICKS;

/** Ticks per beat / bar / sixteenth (4/4 at 960 PPQ). */
export const BEAT = 960;
export const BAR = 3840;
export const SIXTEENTH = 240;
/** The resize handle: the last END_ZONE px of a note. */
export const END_ZONE = 6;

// ---- geometry ---------------------------------------------------------------

export const tickToX = (t: number, v: View) => v.keysW + (t - v.scrollTick) / v.ticksPerPx;
export const xToTick = (x: number, v: View) => (x - v.keysW) * v.ticksPerPx + v.scrollTick;
/** Top edge of pitch `p`'s row. */
export const pitchToY = (p: number, v: View) => (v.topPitch - p) * v.rowH;
export const yToPitch = (y: number, v: View) => v.topPitch - Math.floor(y / v.rowH);

// ---- snapping ---------------------------------------------------------------

/** Nearest grid line. */
export const snap = (t: number, grid: number) => Math.round(t / grid) * grid;
/** Grid line at or before `t` (the cell the pointer is in). */
export const snapFloor = (t: number, grid: number) => Math.floor(t / grid) * grid;

// ---- hit-testing -------------------------------------------------------------

export interface NoteBox {
  id: string;
  pitch: number;
  start: number;
  len: number;
}

/**
 * The note under (x, y), last in array order first (it is drawn on top).
 * 'end' = the resize zone: the last END_ZONE px, but at most the right half
 * of the note so a short note can still be grabbed to move.
 */
export function hitTest(notes: readonly NoteBox[], x: number, y: number, v: View): { id: string; part: 'body' | 'end' } | null {
  if (x < v.keysW) return null; // over the keyboard
  const pitch = yToPitch(y, v);
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n.pitch !== pitch) continue;
    const x0 = tickToX(n.start, v);
    // Drawn at least 2 px wide (PianoRoll), so hit at least that wide too.
    const x1 = Math.max(tickToX(n.start + n.len, v), x0 + 2);
    if (x < x0 || x >= x1) continue;
    const endW = Math.min(END_ZONE, (x1 - x0) / 2);
    return { id: n.id, part: x >= x1 - endW ? 'end' : 'body' };
  }
  return null;
}

// ---- labels ------------------------------------------------------------------

// noteName lives in ui/noteName.ts (shared with the knobs); re-exported here
// for the piano roll's existing callers.
export { noteName };

export const isBlack = (p: number) => NOTE_NAMES[((p % 12) + 12) % 12].length > 1;

/** "bar.beat.sixteenth", 1-based; off-grid ticks appended: "1.1.1 +96t". */
export function formatPos(t: number): string {
  const bar = Math.floor(t / BAR) + 1;
  const beat = Math.floor((t % BAR) / BEAT) + 1;
  const six = Math.floor((t % BEAT) / SIXTEENTH) + 1;
  const rest = t % SIXTEENTH;
  return `${bar}.${beat}.${six}${rest ? ` +${rest}t` : ''}`;
}

/** Note values that get a name ("1/8T"), longest first. */
const NAMED: [string, number][] = [['1/2', 1920], ...Object.entries(GRID_TICKS)];

/** "1/16", "1/8T", "3×1/16" (grid multiples), "2 bars", else "100 ticks". */
export function formatLen(len: number, grid: GridKey): string {
  if (len % BAR === 0) return len === BAR ? '1 bar' : `${len / BAR} bars`;
  const named = NAMED.find(([, t]) => t === len);
  if (named) return named[0];
  const g = GRID_TICKS[grid];
  if (len % g === 0) return `${len / g}×${grid}`;
  return `${len} ticks`;
}

/** Toolbar readout of one note: "C3 · 1.1.1 · 1/16". */
export const readout = (n: { pitch: number; start: number; len: number }, grid: GridKey) =>
  `${noteName(n.pitch)} · ${formatPos(n.start)} · ${formatLen(n.len, grid)}`;

// ---- moving ------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Clamp a group move so no note leaves the pattern (start 0..total-1) or
 * 0..127, keeping the group's shape (a chord never gets squashed against an
 * edge). `+ 0` turns -0 into 0.
 */
export function clampMove(
  sel: readonly { pitch: number; start: number }[], dt: number, dp: number, total: number,
): { dt: number; dp: number } {
  if (!sel.length) return { dt: 0, dp: 0 };
  const starts = sel.map((n) => n.start);
  const pitches = sel.map((n) => n.pitch);
  const lo = -Math.min(...starts);
  // In-pattern notes may not be moved past the end. A selection that already
  // holds a note past the end cannot move right at all, and is never pushed
  // left by this clamp (updateNotes lets such notes stay past the end).
  const hi = Math.max(0, total - 1 - Math.max(...starts));
  return {
    dt: clamp(dt, lo, hi) + 0,
    dp: clamp(dp, -Math.min(...pitches), 127 - Math.max(...pitches)) + 0,
  };
}

// ---- the key (plan 26; docs/architecture/theory.md) ----------------------------

/**
 * How the note grid shades pitch `p`'s row for `key`: 'root' rows are
 * tinted, 'out' (of key) rows dimmed, 'in' rows plain. null for a chromatic
 * key: no highlight at all, the classic black/white-key shading instead.
 */
export function keyRow(p: number, key: MusicKey): 'root' | 'in' | 'out' | null {
  if (key.scale === 'chromatic') return null;
  if (isKeyRoot(p, key)) return 'root';
  return inKey(p, key) ? 'in' : 'out';
}

/**
 * The pitch a note moved by `dp` semitones from `from` lands on. `key` null
 * (Snap to key off): from + dp. With a key, the nearest in-key pitch in the
 * direction of the move (nearestInKey 'up' / 'down'), so a one-row move
 * never snaps back to where it started; dp 0: the nearest, ties up (a time-
 * only move, or a note just drawn on an off-key row).
 */
export function movedPitch(from: number, dp: number, key: MusicKey | null): number {
  if (!key) return from + dp;
  return nearestInKey(from + dp, key, dp > 0 ? 'up' : dp < 0 ? 'down' : undefined);
}

// ---- view --------------------------------------------------------------------

/** Zoom by `factor` (< 1 = in) around pointer x; scroll never goes below 0. */
export function zoomAt(v: View, factor: number, x: number, lim: { minTpp: number; maxTpp: number }): View {
  const ticksPerPx = clamp(v.ticksPerPx * factor, lim.minTpp, lim.maxTpp);
  const at = xToTick(x, v);
  const scrollTick = Math.max(0, at - (x - v.keysW) * ticksPerPx);
  return { ...v, ticksPerPx, scrollTick };
}

export const KEYS_W = 48;
/** Rows C2..C5 inclusive: what an empty roll opens on (bass + chords). */
const DEFAULT_LOW = 36;
const DEFAULT_HIGH = 72;
/** Smallest row that still fits a note name (9 px font) inside a note. */
export const MIN_ROW_H = 9;

/**
 * Opening view for a `width` x `height` note area (width includes the
 * keyboard): the whole pattern fits horizontally; vertically it centres the
 * existing notes, or C2..C5 when empty, with rows sized so C2..C5 fits
 * (MIN_ROW_H..16 px; below that it is centred, not squeezed).
 */
export function initialView(width: number, height: number, total: number, notes: readonly { pitch: number }[]): View {
  const rowH = clamp(Math.floor(height / (DEFAULT_HIGH - DEFAULT_LOW + 1)), MIN_ROW_H, 16);
  const rows = Math.max(1, Math.floor(height / rowH));
  let centre = (DEFAULT_LOW + DEFAULT_HIGH) / 2;
  if (notes.length) {
    const ps = notes.map((n) => n.pitch);
    centre = (Math.min(...ps) + Math.max(...ps)) / 2;
  }
  const topPitch = clamp(Math.round(centre + (rows - 1) / 2), Math.min(127, rows - 1), 127);
  return { ticksPerPx: total / Math.max(1, width - KEYS_W), scrollTick: 0, rowH, topPitch, keysW: KEYS_W };
}
