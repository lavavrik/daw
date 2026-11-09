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
import { MAX_ROWS, MAX_STEPS, currentPattern, isPatternTrack, synthTrack } from './project.svelte';
import type { DrumPattern, Note, NotePatternState, PatternTrack, Project, SynthTrack } from './project.svelte';
import type { CommandSink } from './actions';
import { edit, markEdited } from './edits';
import { nearestInKey } from '../music/scales';
import { humanizeAmount, humanizeSeed, humanizedStart, humanizedVel, nextHumanizeCounter, peekHumanizeCounter } from './groove';

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

type NewNote = { pitch: number; start: number; len: number; vel?: number };

/**
 * Pushes `o` (clamped) into `pat` at engine idx `idx` and sends it; returns
 * the reactive proxy. The shared body of addNote / addNotes.
 */
function pushNote(sink: CommandSink, t: SynthTrack, pat: NotePatternState, idx: number, o: NewNote): Note {
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

/** The `count` lowest free engine idxs of `pat`, or null when fewer are free. */
function freeIdxs(pat: NotePatternState, count: number): number[] | null {
  const used = new Set(pat.notes.map((n) => n.idx));
  const out: number[] = [];
  for (let idx = 0; idx < MAX_NOTES && out.length < count; idx++) if (!used.has(idx)) out.push(idx);
  return out.length === count ? out : null;
}

/**
 * Adds to the current pattern (`patternId`: only if that one is current).
 * Lowest free engine idx (per pattern), or null when all MAX_NOTES are used.
 */
export function addNote(
  p: Project, sink: CommandSink, trackId: string,
  o: NewNote,
  patternId?: string,
): Note | null {
  return edit(p, 'Add note', () => {
    const tp = target(p, trackId, patternId);
    if (!tp) return null;
    const idx = freeIdxs(tp.pat, 1);
    return idx ? pushNote(sink, tp.t, tp.pat, idx[0], o) : null;
  });
}

/**
 * Adds several notes to the current pattern as ONE undo entry (plan 26 Task
 * 2: the piano roll's chord stamp). All or nothing: when the pattern has
 * fewer than `notes.length` free slots (MAX_NOTES) nothing is added and the
 * result is null, as for an unknown / drum track; the caller says why. An
 * empty list adds nothing (no entry) and returns []. Each note is clamped
 * as addNote does; they take the lowest free engine idxs, in order.
 */
export function addNotes(
  p: Project, sink: CommandSink, trackId: string, notes: NewNote[], label = 'Add notes',
): Note[] | null {
  return edit(p, label, () => {
    const tp = target(p, trackId);
    if (!tp) return null;
    const idxs = freeIdxs(tp.pat, notes.length);
    if (!idxs) return null;
    return notes.map((o, i) => pushNote(sink, tp.t, tp.pat, idxs[i], o));
  });
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
/** Undo label of an updateNotes call: what its changes touch. */
function notesLabel(changes: { pitch?: number; start?: number; len?: number; vel?: number }[]): string {
  if (changes.some((c) => c.pitch !== undefined || c.start !== undefined)) return 'Move notes';
  if (changes.some((c) => c.len !== undefined)) return 'Resize notes';
  return 'Note velocity';
}

export function updateNotes(
  p: Project, sink: CommandSink, trackId: string,
  changes: { id: string; pitch?: number; start?: number; len?: number; vel?: number }[],
) {
  return edit(p, notesLabel(changes), () => {
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
  });
}

/** From the current pattern (`patternId`: only if that one is current; else false). */
export function deleteNotes(p: Project, sink: CommandSink, trackId: string, ids: string[], patternId?: string): boolean {
  return edit(p, 'Delete notes', () => {
    const tp = target(p, trackId, patternId);
    if (!tp) return false;
    const { t, pat } = tp;
    const gone = new Set(ids);
    for (const n of pat.notes) {
      if (gone.has(n.id)) sink.send(Op.NOTE_REMOVE, t.slot * MAX_NOTES + n.idx);
    }
    pat.notes = pat.notes.filter((n) => !gone.has(n.id));
    return true;
  });
}

/** Never moves notes: those past the new end stay (they just do not play). */
export function setPatternBars(p: Project, sink: CommandSink, trackId: string, bars: number) {
  return edit(p, 'Pattern length', () => {
    const tp = target(p, trackId);
    if (!tp) return;
    tp.pat.bars = clampInt(bars, 1, MAX_PATTERN_BARS);
    sink.send(Op.SET_PATTERN_BARS, tp.t.slot, tp.pat.bars);
  });
}

/**
 * Empties the current pattern (`patternId`: only if that one is still
 * current). Every clip using it goes silent at once.
 */
export function clearPattern(p: Project, sink: CommandSink, trackId: string, patternId?: string) {
  return edit(p, 'Clear pattern', () => {
    const tp = target(p, trackId, patternId);
    if (!tp) return;
    tp.pat.notes = [];
    sink.send(Op.NOTE_CLEAR, tp.t.slot);
  });
}

/**
 * Moves starts toward the nearest grid line by `strength` (0..1); empty ids =
 * all notes. A snap to >= pattern end wraps to 0. Notes already past the end
 * (kept, silent) are skipped: quantizing never brings them into the loop.
 */
export function quantizeNotes(
  p: Project, sink: CommandSink, trackId: string, ids: string[], gridTicks: number, strength = 1,
) {
  return edit(p, 'Quantize', () => {
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
  });
}

/**
 * Humanize (plan 25; docs/architecture/sequencer.md "Humanize"): jitter the
 * velocity (±HUMANIZE_VEL) and start (±HUMANIZE_TICKS) of each note by up to
 * that much x `amount` (0..1); `ids` empty = every note, like Quantize.
 * Starts stay inside the pattern (state/groove.ts humanizedStart: >= 0, the
 * end never past the pattern end); notes already past the end (kept,
 * silent) are skipped, so Humanize never brings one into the loop.
 * Deterministic: seeded by the pattern id and its humanize counter, each
 * note keyed by its id. One undo entry ("Humanize"). Amount 0 (or NaN), or
 * notes that would not move, is a no-op: no write, no entry, the counter is
 * not used. Returns how many notes changed (as humanizeDrum).
 */
export function humanizeNotes(p: Project, sink: CommandSink, trackId: string, amount: number, ids: string[] = []): number {
  const a = humanizeAmount(amount);
  const tp = target(p, trackId);
  if (a === 0 || !tp) return 0;
  const { t, pat } = tp;
  const want = ids.length ? new Set(ids) : null;
  const total = patternTicks(t);
  const seed = humanizeSeed(pat.id, peekHumanizeCounter(pat.id));
  const changes: { id: string; start: number; vel: number }[] = [];
  for (const n of pat.notes) {
    if ((want && !want.has(n.id)) || n.start >= total) continue;
    const start = humanizedStart(n.start, n.len, total, seed, n.id, a);
    const vel = humanizedVel(n.vel, seed, n.id, a);
    if (start !== n.start || vel !== n.vel) changes.push({ id: n.id, start, vel });
  }
  if (!changes.length) return 0; // nothing to change: no entry, no counter used
  nextHumanizeCounter(pat.id);
  edit(p, 'Humanize', () => updateNotes(p, sink, trackId, changes));
  return changes.length;
}

// ---- key helpers (plan 26; docs/architecture/theory.md) ----------------------

/** Transpose… range: ±1 octave. */
export const MAX_TRANSPOSE = 12;

/**
 * Transpose… (plan 26 Task 1): move the pitch of `ids` (empty = every note
 * of the current pattern, past-the-end ones too) by `semitones`, rounded and
 * clamped to ±MAX_TRANSPOSE, then clamped for the whole group so no note
 * leaves 0..127 (the shape is kept, as prMath.clampMove does for a drag).
 * A plain semitone shift: Snap to key does not apply (Fit to key is the
 * in-key fix). One "Transpose" undo entry. Returns the semitones applied; 0 changes nothing
 * and adds no entry.
 */
export function transposeNotes(p: Project, sink: CommandSink, trackId: string, ids: string[], semitones: number): number {
  const tp = target(p, trackId);
  if (!tp) return 0;
  const want = ids.length ? new Set(ids) : null;
  const notes = tp.pat.notes.filter((n) => !want || want.has(n.id));
  if (!notes.length) return 0;
  const lo = -Math.min(...notes.map((n) => n.pitch));
  const hi = 127 - Math.max(...notes.map((n) => n.pitch));
  const dp = Math.min(hi, Math.max(lo, clampInt(semitones, -MAX_TRANSPOSE, MAX_TRANSPOSE))) + 0;
  if (dp === 0) return 0;
  edit(p, 'Transpose', () => updateNotes(p, sink, trackId, notes.map((n) => ({ id: n.id, pitch: n.pitch + dp }))));
  return dp;
}

/**
 * Fit to key (plan 26 Task 1): every note of the current pattern (past-the-end
 * ones too) to nearestInKey(pitch, p.key) -- the nearest in-key pitch, ties
 * up; starts, lengths and velocities stay. One "Fit to key" undo entry.
 * Returns how many notes moved; 0 (everything already in key, or a chromatic
 * key) changes nothing and adds no entry.
 */
export function fitNotesToKey(p: Project, sink: CommandSink, trackId: string): number {
  const tp = target(p, trackId);
  if (!tp) return 0;
  const changes = tp.pat.notes
    .map((n) => ({ id: n.id, from: n.pitch, pitch: nearestInKey(n.pitch, p.key) }))
    .filter((c) => c.pitch !== c.from)
    .map(({ id, pitch }) => ({ id, pitch }));
  if (!changes.length) return 0;
  edit(p, 'Fit to key', () => updateNotes(p, sink, trackId, changes));
  return changes.length;
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

/** The drum or synth track `trackId` (an Audio track has no patterns: null). */
const findTrack = (p: Project, trackId: string): PatternTrack | null => {
  const t = p.tracks.find((x) => x.id === trackId);
  return t && isPatternTrack(t) ? t : null;
};

/** The pattern `patternId` of `t` (patterns is a union of arrays: widen once here). */
export function patternOf(t: PatternTrack, patternId: string): AnyPattern | null {
  const ps: AnyPattern[] = t.patterns;
  return ps.find((x) => x.id === patternId) ?? null;
}

/** Why "new pattern" buttons are disabled at MAX_PATTERNS (the pattern picker, the examples menu). */
export const PATTERNS_FULL_TEXT = `At most ${MAX_PATTERNS} patterns per track`;

/** Lowest free engine pattern slot, or null when all MAX_PATTERNS are used. */
function freeEngineIdx(t: PatternTrack): number | null {
  const used = new Set(t.patterns.map((x) => x.engineIdx));
  for (let i = 0; i < MAX_PATTERNS; i++) if (!used.has(i)) return i;
  return null;
}

/**
 * First unused name. `numbered`: "base 1", "base 2", … (new patterns);
 * otherwise "base", "base 2", … (copies).
 */
export function freeName(t: PatternTrack, base: string, numbered: boolean): string {
  const names = new Set(t.patterns.map((x) => x.name));
  let n = 1;
  const name = () => (n === 1 && !numbered ? base : `${base} ${n}`);
  while (names.has(name())) n++;
  return name();
}

/** "<name> copy", then "<name> copy 2", …: never another pattern's base name. */
const copyName = (t: PatternTrack, name: string) => freeName(t, `${name} copy`, false);

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
  // Saved but not an edit: a pending recording pass's "after" is taken first
  // (after the recorder wrote its held notes into the old pattern).
  p.history?.settle();
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
  return edit(p, 'New pattern', () => {
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
  });
}

/**
 * Copies `patternId` (data and lengths) into a new engine slot with
 * COPY_PATTERN; does NOT change the current pattern. Used by duplicatePattern
 * and makeUnique. Null at MAX_PATTERNS or for an unknown pattern.
 */
export function copyPattern(p: Project, sink: CommandSink, trackId: string, patternId: string): AnyPattern | null {
  return edit(p, 'Copy pattern', () => {
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
  });
}

/** A copy of `patternId` (default: the current one) that becomes current. */
export function duplicatePattern(p: Project, sink: CommandSink, trackId: string, patternId?: string): AnyPattern | null {
  return edit(p, 'Duplicate pattern', () => {
    const t = findTrack(p, trackId);
    if (!t) return null;
    const pat = copyPattern(p, sink, trackId, patternId ?? t.currentPatternId);
    if (pat) selectPattern(p, sink, trackId, pat.id);
    return pat;
  });
}

/** UI-only (the engine has no names). Trimmed; empty names are refused. */
export function renamePattern(p: Project, _sink: CommandSink, trackId: string, patternId: string, name: string): boolean {
  return edit(p, 'Rename pattern', () => {
    const t = findTrack(p, trackId);
    const pat = t && patternOf(t, patternId);
    const n = name.trim();
    if (!pat || !n) return false;
    pat.name = n;
    markEdited(p); // no engine command, so mark it here
    return true;
  });
}

/**
 * Refused (false) while a clip of the track uses the pattern, or when it is
 * the track's only pattern. Deleting the current pattern first selects the
 * remaining one with the lowest engine index. Sends CLEAR_PATTERN_DATA so the
 * freed slot is empty when newPattern reuses it; no renumbering.
 */
export function deletePattern(p: Project, sink: CommandSink, trackId: string, patternId: string): boolean {
  return edit(p, 'Delete pattern', () => {
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
  });
}
