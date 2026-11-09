// Edit actions of the Acid tab (plan 17 Task 3). The steps are not stored: an
// edit is turned into a note diff by acidSteps.planEdit and applied through the
// ordinary note actions, all inside ONE edit() so it is one undo entry.
import type { CommandSink } from './actions';
import { createSweepKeys } from '../history/sweep';
import { ACID_MAX_BARS, convertSteps, DEFAULT_BASE, planEdit, readSteps, type AcidStep, type NoteDiff } from './acidSteps';
import { edit } from './edits';
import { addNote, deleteNotes, setPatternBars, updateNotes } from './pattern-actions';
import { currentPattern, synthTrack } from './project.svelte';
import type { Project } from './project.svelte';

/** Coalesce keys with a 1000 ms idle rollover (history itself has no time limit). */
let sweepKey = createSweepKeys();
/** Test hook: replace the key source (e.g. with an injected clock). */
export function setAcidSweepKeys(f: (base: string) => string) { sweepKey = f; }

/** What a single-step edit changed; part of the undo coalesce key. */
export type AcidEditKind = 'pitch' | 'oct' | 'accent' | 'slide' | 'kind' | 'entry';

/**
 * Applies `diff` to the current pattern: delete first (frees engine idx), then
 * update, then add. Must run inside an edit(). addNote returns null when all
 * MAX_NOTES are used (so do the remaining adds: a full pattern gets a
 * partial result, still one undo entry, no error) and for an exact duplicate
 * of a note already there (skipped; the rest still go in).
 */
function applyDiff(p: Project, sink: CommandSink, trackId: string, diff: NoteDiff) {
  if (diff.remove.length) deleteNotes(p, sink, trackId, diff.remove);
  if (diff.update.length) updateNotes(p, sink, trackId, diff.update);
  for (const a of diff.add) addNote(p, sink, trackId, a);
}

/**
 * Writes `next` (steps of the pattern read at `base`) into the current pattern
 * as one undo entry labelled `label`. With `coalesceKind`, consecutive single
 * step edits of that kind on this track merge (key `acid:<trackId>:<kind>`;
 * a new entry starts after 1000 ms idle, see sweepKey).
 *
 * Refused (false, nothing written) when the pattern can't be read at exactly
 * `base`: the UI only edits a view it got from readSteps at its own base. An
 * empty diff sends nothing and returns false.
 */
export function applyAcidSteps(
  p: Project, sink: CommandSink, trackId: string, base: number, next: AcidStep[], label: string,
  coalesceKind?: AcidEditKind,
): boolean {
  const t = synthTrack(p, trackId);
  if (!t) return false;
  const pat = currentPattern(t);
  const view = readSteps(pat.notes, pat.bars, base);
  if (!view.ok || view.base !== base) return false;
  const diff = planEdit(pat.notes, pat.bars, base, next);
  if (!diff.add.length && !diff.update.length && !diff.remove.length) return false;
  edit(p, label, () => applyDiff(p, sink, trackId, diff), coalesceKind ? { coalesce: sweepKey(`acid:${trackId}:${coalesceKind}`) } : undefined);
  return true;
}

/**
 * Moves every note of the current pattern (also those past its end) by
 * `semis`. False, with no entry and nothing sent, when there is nothing to move
 * or a pitch would leave 0..127.
 */
export function transposeAcid(p: Project, sink: CommandSink, trackId: string, semis: number): boolean {
  const t = synthTrack(p, trackId);
  if (!t || semis === 0) return false;
  const notes = currentPattern(t).notes;
  if (notes.length === 0 || notes.some((n) => n.pitch + semis < 0 || n.pitch + semis > 127)) return false;
  edit(p, 'Transpose', () => updateNotes(p, sink, trackId, notes.map((n) => ({ id: n.id, pitch: n.pitch + semis }))));
  return true;
}

/**
 * Makes an unreadable pattern readable (spec §2.7) as one undo entry: a pattern
 * longer than 4 bars is first cut to 4 (its later notes stay, silent), then the
 * snapped steps replace the shown notes (planEdit's unreadable fallback; a
 * pattern that already reads is left as it is). Returns the base to show.
 */
export function convertToSteps(p: Project, sink: CommandSink, trackId: string): number {
  const t = synthTrack(p, trackId);
  if (!t) return DEFAULT_BASE;
  return edit(p, 'Convert to steps', () => {
    if (currentPattern(t).bars > ACID_MAX_BARS) setPatternBars(p, sink, trackId, ACID_MAX_BARS);
    const pat = currentPattern(t);
    const { base, steps } = convertSteps(pat.notes, pat.bars);
    applyDiff(p, sink, trackId, planEdit(pat.notes, pat.bars, base, steps));
    return base;
  });
}
