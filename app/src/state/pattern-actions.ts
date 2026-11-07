// Pattern CRUD (both track kinds) and synth note-pattern edits. Like
// actions.ts: every function mutates Project AND sends the matching engine
// command, so UI and engine never diverge.
//
// Engine pattern slots: every pattern has a stable `engineIdx` (lowest free
// 0..MAX_PATTERNS-1 when created, freed by deletePattern with
// CLEAR_PATTERN_DATA; never renumbered, so clips never need re-sending).
//
// Current pattern: the note/step/length opcodes act on the engine's current
// pattern. selectPattern is the ONLY sender of SET_CURRENT_PATTERN and the
// only writer of `currentPatternId`, so the two always agree and edits simply
// target currentPattern(track). No action switches the pattern implicitly.
import { BAR_TICKS, MAX_NOTES, MAX_PATTERN_BARS, MAX_PATTERNS, Op } from '../audio/protocol';
import { MAX_ROWS, MAX_STEPS, currentPattern, synthTrack } from './project.svelte';
import type { DrumPattern, Note, NotePatternState, Project, SynthTrack, Track } from './project.svelte';
import type { CommandSink } from './actions';

export const MAX_NOTE_LEN = 61440;
/** Last start tick the engine accepts (MAX_PATTERN_BARS bars). */
const MAX_START = MAX_PATTERN_BARS * BAR_TICKS - 1;

/** Grid sizes in ticks (960 PPQ). */
export const GRID_TICKS = {
  '1/4': 960, '1/8': 480, '1/16': 240, '1/32': 120, '1/8T': 320, '1/16T': 160,
} as const;

/** Current pattern length in ticks. */
export const patternTicks = (t: SynthTrack) => currentPattern(t).bars * BAR_TICKS;

/** Rounds and clamps; NaN/±Infinity fall to `lo` so they never reach the engine. */
const clampInt = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo;

/** NOTE_SET for note `n` of track `t`'s current engine pattern (also used by project load). */
export function sendNote(sink: CommandSink, t: SynthTrack, n: Note) {
  sink.send(Op.NOTE_SET, t.slot * MAX_NOTES + n.idx, n.pitch * 128 + n.vel, n.start, n.len);
}

/**
 * The synth track and its current pattern; null for an unknown/drum track, or
 * when `patternId` is given and is not the current pattern (the engine would
 * write the edit into the wrong pattern: refused, never switched implicitly).
 */
function target(p: Project, trackId: string, patternId?: string) {
  const t = synthTrack(p, trackId);
  if (!t) return null;
  const pat = currentPattern(t);
  if (patternId !== undefined && pat.id !== patternId) return null;
  return { t, pat };
}

/**
 * Adds to the current pattern (`patternId`: only if that one is current).
 * Lowest free engine idx (per pattern), or null when all MAX_NOTES are used.
 */
export function addNote(
  p: Project, sink: CommandSink, trackId: string,
  o: { pitch: number; start: number; len: number; vel?: number },
  patternId?: string,
): Note | null {
  const tp = target(p, trackId, patternId);
  if (!tp) return null;
  const { t, pat } = tp;
  const used = new Set(pat.notes.map((n) => n.idx));
  let idx = 0;
  while (idx < MAX_NOTES && used.has(idx)) idx++;
  if (idx >= MAX_NOTES) return null;
  pat.notes.push({
    id: crypto.randomUUID(),
    idx,
    pitch: clampInt(o.pitch, 0, 127),
    vel: clampInt(o.vel ?? 100, 1, 127),
    start: clampInt(o.start, 0, patternTicks(t) - 1),
    len: clampInt(o.len, 1, MAX_NOTE_LEN),
  });
  const n = pat.notes[pat.notes.length - 1]; // reactive proxy
  sendNote(sink, t, n);
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
  const tp = target(p, trackId);
  if (!tp) return;
  const { t, pat } = tp;
  const byId = new Map(pat.notes.map((n) => [n.id, n]));
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
    sendNote(sink, t, n);
  }
}

/** From the current pattern (`patternId`: only if that one is current; else false). */
export function deleteNotes(p: Project, sink: CommandSink, trackId: string, ids: string[], patternId?: string): boolean {
  const tp = target(p, trackId, patternId);
  if (!tp) return false;
  const { t, pat } = tp;
  const gone = new Set(ids);
  for (const n of pat.notes) {
    if (gone.has(n.id)) sink.send(Op.NOTE_REMOVE, t.slot * MAX_NOTES + n.idx);
  }
  pat.notes = pat.notes.filter((n) => !gone.has(n.id));
  return true;
}

/** Never moves notes: those past the new end stay (they just do not play). */
export function setPatternBars(p: Project, sink: CommandSink, trackId: string, bars: number) {
  const tp = target(p, trackId);
  if (!tp) return;
  tp.pat.bars = clampInt(bars, 1, MAX_PATTERN_BARS);
  sink.send(Op.SET_PATTERN_BARS, tp.t.slot, tp.pat.bars);
}

/** Empties the current pattern (every clip using it goes silent at once). */
export function clearPattern(p: Project, sink: CommandSink, trackId: string) {
  const tp = target(p, trackId);
  if (!tp) return;
  tp.pat.notes = [];
  sink.send(Op.NOTE_CLEAR, tp.t.slot);
}

/**
 * Moves starts toward the nearest grid line by `strength` (0..1); empty ids =
 * all notes. A snap to >= pattern end wraps to 0. Notes already past the end
 * (kept, silent) are skipped: quantizing never brings them into the loop.
 */
export function quantizeNotes(
  p: Project, sink: CommandSink, trackId: string, ids: string[], gridTicks: number, strength = 1,
) {
  const tp = target(p, trackId);
  if (!tp || !(gridTicks > 0)) return;
  const { t, pat } = tp;
  const want = ids.length ? new Set(ids) : null;
  const total = patternTicks(t);
  const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1;
  const changes: { id: string; start: number }[] = [];
  for (const n of pat.notes) {
    if (want && !want.has(n.id)) continue;
    if (n.start >= total) continue;
    let snapped = Math.round(n.start / gridTicks) * gridTicks;
    if (snapped >= total) snapped = 0;
    changes.push({ id: n.id, start: n.start + (snapped - n.start) * s });
  }
  updateNotes(p, sink, trackId, changes);
}

// ---- pattern CRUD ------------------------------------------------------------

type AnyPattern = DrumPattern | NotePatternState;

/** An empty drum pattern with MAX_ROWS x MAX_STEPS steps. */
export function makeDrumPattern(engineIdx: number, name: string, stepCount: 16 | 32 | 64, swing: number): DrumPattern {
  return {
    id: crypto.randomUUID(),
    engineIdx,
    name,
    stepCount,
    swing,
    steps: Array.from({ length: MAX_ROWS }, () => new Array<number>(MAX_STEPS).fill(0)),
  };
}

export function makeNotePattern(engineIdx: number, name: string, bars: number): NotePatternState {
  return { id: crypto.randomUUID(), engineIdx, name, bars, notes: [] };
}

const findTrack = (p: Project, trackId: string): Track | null => p.tracks.find((t) => t.id === trackId) ?? null;

/** The pattern `patternId` of `t` (patterns is a union of arrays: widen once here). */
export function patternOf(t: Track, patternId: string): AnyPattern | null {
  const ps: AnyPattern[] = t.patterns;
  return ps.find((x) => x.id === patternId) ?? null;
}

/** Lowest free engine pattern slot, or null when all MAX_PATTERNS are used. */
function freeEngineIdx(t: Track): number | null {
  const used = new Set(t.patterns.map((x) => x.engineIdx));
  for (let i = 0; i < MAX_PATTERNS; i++) if (!used.has(i)) return i;
  return null;
}

/**
 * First unused name. `numbered`: "base 1", "base 2", … (new patterns);
 * otherwise "base", "base 2", … (copies).
 */
function freeName(t: Track, base: string, numbered: boolean): string {
  const names = new Set(t.patterns.map((x) => x.name));
  let n = 1;
  const name = () => (n === 1 && !numbered ? base : `${base} ${n}`);
  while (names.has(name())) n++;
  return name();
}

/** "<name> copy", then "<name> copy 2", …: never another pattern's base name. */
const copyName = (t: Track, name: string) => freeName(t, `${name} copy`, false);

/**
 * Makes `patternId` the track's current pattern: the one Pattern mode loops
 * and the editors/recorder use. The ONLY sender of SET_CURRENT_PATTERN. Calls
 * p.beforePatternSwitch first (the recorder writes held notes into the old
 * pattern while the engine still edits it). False for an unknown track/pattern.
 */
export function selectPattern(p: Project, sink: CommandSink, trackId: string, patternId: string): boolean {
  const t = findTrack(p, trackId);
  const pat = t && patternOf(t, patternId);
  if (!t || !pat) return false;
  if (t.currentPatternId === pat.id) return true;
  p.beforePatternSwitch?.(t.id);
  t.currentPatternId = pat.id;
  sink.send(Op.SET_CURRENT_PATTERN, t.slot, pat.engineIdx);
  return true;
}

/**
 * Adds an empty "Pattern N" with the current pattern's length settings (drum:
 * step count + swing; synth: bars) and makes it current. The engine slot is
 * already empty (fresh track, or cleared by deletePattern) but may hold old
 * lengths, so they are sent after selecting it. Null at MAX_PATTERNS.
 */
export function newPattern(p: Project, sink: CommandSink, trackId: string): AnyPattern | null {
  const t = findTrack(p, trackId);
  if (!t) return null;
  const idx = freeEngineIdx(t);
  if (idx === null) return null;
  const name = freeName(t, 'Pattern', true);
  if (t.kind === 'drum') {
    const cur = currentPattern(t);
    t.patterns.push(makeDrumPattern(idx, name, cur.stepCount, cur.swing));
    const pat = t.patterns[t.patterns.length - 1]; // reactive proxy
    selectPattern(p, sink, t.id, pat.id);
    sink.send(Op.SET_STEP_COUNT, t.slot, pat.stepCount);
    sink.send(Op.SET_SWING, t.slot, pat.swing);
    return pat;
  }
  t.patterns.push(makeNotePattern(idx, name, currentPattern(t).bars));
  const pat = t.patterns[t.patterns.length - 1];
  selectPattern(p, sink, t.id, pat.id);
  sink.send(Op.SET_PATTERN_BARS, t.slot, pat.bars);
  return pat;
}

/**
 * Copies `patternId` (data and lengths) into a new engine slot with
 * COPY_PATTERN; does NOT change the current pattern. Used by duplicatePattern
 * and makeUnique. Null at MAX_PATTERNS or for an unknown pattern.
 */
export function copyPattern(p: Project, sink: CommandSink, trackId: string, patternId: string): AnyPattern | null {
  const t = findTrack(p, trackId);
  const src = t && patternOf(t, patternId);
  if (!t || !src) return null;
  const idx = freeEngineIdx(t);
  if (idx === null) return null;
  const name = copyName(t, src.name);
  let pat: AnyPattern;
  if (t.kind === 'drum') {
    const s = src as DrumPattern;
    t.patterns.push({ ...makeDrumPattern(idx, name, s.stepCount, s.swing), steps: s.steps.map((r) => [...r]) });
    pat = t.patterns[t.patterns.length - 1];
  } else {
    const s = src as NotePatternState;
    // Same note idx: each engine pattern has its own note slots.
    t.patterns.push({ ...makeNotePattern(idx, name, s.bars), notes: s.notes.map((n) => ({ ...n, id: crypto.randomUUID() })) });
    pat = t.patterns[t.patterns.length - 1];
  }
  sink.send(Op.COPY_PATTERN, t.slot, src.engineIdx, idx);
  return pat;
}

/** A copy of `patternId` (default: the current one) that becomes current. */
export function duplicatePattern(p: Project, sink: CommandSink, trackId: string, patternId?: string): AnyPattern | null {
  const t = findTrack(p, trackId);
  if (!t) return null;
  const pat = copyPattern(p, sink, trackId, patternId ?? t.currentPatternId);
  if (pat) selectPattern(p, sink, trackId, pat.id);
  return pat;
}

/** UI-only (the engine has no names). Trimmed; empty names are refused. */
export function renamePattern(p: Project, _sink: CommandSink, trackId: string, patternId: string, name: string): boolean {
  const t = findTrack(p, trackId);
  const pat = t && patternOf(t, patternId);
  const n = name.trim();
  if (!pat || !n) return false;
  pat.name = n;
  return true;
}

/**
 * Refused (false) while a clip of the track uses the pattern, or when it is
 * the track's only pattern. Deleting the current pattern first selects the
 * remaining one with the lowest engine index. Sends CLEAR_PATTERN_DATA so the
 * freed slot is empty when newPattern reuses it; no renumbering.
 */
export function deletePattern(p: Project, sink: CommandSink, trackId: string, patternId: string): boolean {
  const t = findTrack(p, trackId);
  const pat = t && patternOf(t, patternId);
  if (!t || !pat || t.patterns.length <= 1) return false;
  if (t.clips.some((c) => c.patternId === pat.id)) return false;
  if (t.currentPatternId === pat.id) {
    const rest: AnyPattern[] = t.patterns;
    const next = rest.filter((x) => x.id !== pat.id).sort((a, b) => a.engineIdx - b.engineIdx)[0];
    selectPattern(p, sink, t.id, next.id);
  }
  sink.send(Op.CLEAR_PATTERN_DATA, t.slot, pat.engineIdx);
  if (t.kind === 'drum') t.patterns = t.patterns.filter((x) => x.id !== pat.id);
  else t.patterns = t.patterns.filter((x) => x.id !== pat.id);
  return true;
}
