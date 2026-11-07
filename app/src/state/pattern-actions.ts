// Synth note-pattern edits. Like actions.ts: every function mutates Project AND
// sends the matching engine command (NOTE_SET / NOTE_REMOVE / NOTE_CLEAR /
// SET_PATTERN_BARS), so UI and engine never diverge.
import { BAR_TICKS, MAX_NOTES, MAX_PATTERN_BARS, Op } from '../audio/protocol';
import { synthTrack } from './project.svelte';
import type { Note, Project, SynthTrack } from './project.svelte';
import type { CommandSink } from './actions';

export const MAX_NOTE_LEN = 61440;
/** Last start tick the engine accepts (MAX_PATTERN_BARS bars). */
const MAX_START = MAX_PATTERN_BARS * BAR_TICKS - 1;

/** Grid sizes in ticks (960 PPQ). */
export const GRID_TICKS = {
  '1/4': 960, '1/8': 480, '1/16': 240, '1/32': 120, '1/8T': 320, '1/16T': 160,
} as const;

/** Pattern length in ticks. */
export const patternTicks = (t: SynthTrack) => t.pattern.bars * BAR_TICKS;

/** Rounds and clamps; NaN/±Infinity fall to `lo` so they never reach the engine. */
const clampInt = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo;

function send(sink: CommandSink, t: SynthTrack, n: Note) {
  sink.send(Op.NOTE_SET, t.slot * MAX_NOTES + n.idx, n.pitch * 128 + n.vel, n.start, n.len);
}

/** Lowest free engine idx, or null when all MAX_NOTES are used. */
export function addNote(
  p: Project, sink: CommandSink, trackId: string,
  o: { pitch: number; start: number; len: number; vel?: number },
): Note | null {
  const t = synthTrack(p, trackId);
  if (!t) return null;
  const used = new Set(t.pattern.notes.map((n) => n.idx));
  let idx = 0;
  while (idx < MAX_NOTES && used.has(idx)) idx++;
  if (idx >= MAX_NOTES) return null;
  t.pattern.notes.push({
    id: crypto.randomUUID(),
    idx,
    pitch: clampInt(o.pitch, 0, 127),
    vel: clampInt(o.vel ?? 100, 1, 127),
    start: clampInt(o.start, 0, patternTicks(t) - 1),
    len: clampInt(o.len, 1, MAX_NOTE_LEN),
  });
  const n = t.pattern.notes[t.pattern.notes.length - 1]; // reactive proxy
  send(sink, t, n);
  return n;
}

/**
 * Clamps + rounds each field; unknown ids are skipped. Only the fields given
 * change. A new start is clamped to the engine's range (0..16 bars - 1), NOT
 * to this pattern's length: notes past the end are kept (silent), and editing
 * one (pitch, velocity, a small move, or reverting a drag) must never yank it
 * into the audible loop. Keeping in-pattern notes inside the pattern is the
 * editor's job (prMath.clampMove). A note whose values end up unchanged sends
 * nothing (drags re-send often).
 */
export function updateNotes(
  p: Project, sink: CommandSink, trackId: string,
  changes: { id: string; pitch?: number; start?: number; len?: number; vel?: number }[],
) {
  const t = synthTrack(p, trackId);
  if (!t) return;
  const byId = new Map(t.pattern.notes.map((n) => [n.id, n]));
  for (const c of changes) {
    const n = byId.get(c.id);
    if (!n) continue;
    const pitch = c.pitch !== undefined ? clampInt(c.pitch, 0, 127) : n.pitch;
    const vel = c.vel !== undefined ? clampInt(c.vel, 1, 127) : n.vel;
    const start = c.start !== undefined ? clampInt(c.start, 0, MAX_START) : n.start;
    const len = c.len !== undefined ? clampInt(c.len, 1, MAX_NOTE_LEN) : n.len;
    if (pitch === n.pitch && vel === n.vel && start === n.start && len === n.len) continue;
    n.pitch = pitch;
    n.vel = vel;
    n.start = start;
    n.len = len;
    send(sink, t, n);
  }
}

export function deleteNotes(p: Project, sink: CommandSink, trackId: string, ids: string[]) {
  const t = synthTrack(p, trackId);
  if (!t) return;
  const gone = new Set(ids);
  for (const n of t.pattern.notes) {
    if (gone.has(n.id)) sink.send(Op.NOTE_REMOVE, t.slot * MAX_NOTES + n.idx);
  }
  t.pattern.notes = t.pattern.notes.filter((n) => !gone.has(n.id));
}

/** Never moves notes: those past the new end stay (they just do not play). */
export function setPatternBars(p: Project, sink: CommandSink, trackId: string, bars: number) {
  const t = synthTrack(p, trackId);
  if (!t) return;
  t.pattern.bars = clampInt(bars, 1, MAX_PATTERN_BARS);
  sink.send(Op.SET_PATTERN_BARS, t.slot, t.pattern.bars);
}

export function clearPattern(p: Project, sink: CommandSink, trackId: string) {
  const t = synthTrack(p, trackId);
  if (!t) return;
  t.pattern.notes = [];
  sink.send(Op.NOTE_CLEAR, t.slot);
}

/**
 * Moves starts toward the nearest grid line by `strength` (0..1); empty ids =
 * all notes. A snap to >= pattern end wraps to 0. Notes already past the end
 * (kept, silent) are skipped: quantizing never brings them into the loop.
 */
export function quantizeNotes(
  p: Project, sink: CommandSink, trackId: string, ids: string[], gridTicks: number, strength = 1,
) {
  const t = synthTrack(p, trackId);
  if (!t || !(gridTicks > 0)) return;
  const want = ids.length ? new Set(ids) : null;
  const total = patternTicks(t);
  const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1;
  const changes: { id: string; start: number }[] = [];
  for (const n of t.pattern.notes) {
    if (want && !want.has(n.id)) continue;
    if (n.start >= total) continue;
    let snapped = Math.round(n.start / gridTicks) * gridTicks;
    if (snapped >= total) snapped = 0;
    changes.push({ id: n.id, start: n.start + (snapped - n.start) * s });
  }
  updateNotes(p, sink, trackId, changes);
}
