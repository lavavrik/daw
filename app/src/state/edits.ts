// "Something was edited": one signal for the unsaved mark (and Task 4's
// autosave, which subscribes to Project.version).
//
// Every edit action sends at least one engine command, so App hooks
// AudioEngine.onCommand to commandEdits(): any op except the ones below marks
// the project dirty and bumps `version`. That costs O(1) per command, unlike
// re-serializing the project on every reactive change. The few edits that
// send nothing (addRow, renamePattern) call markEdited themselves. Whether
// the project really differs from the last save (e.g. an edit undone by
// hand) is settled later, off the hot path (project/dirtyCheck.ts).
import { Op } from '../audio/protocol';
import type { Project } from './project.svelte';


/**
 * Commands that are not edits of the saved project: transport (including the
 * pattern focus, SET_PATTERN_FOCUS: which track the pattern transport plays),
 * live playing, selection, an automation override (AUTO_OVERRIDE only
 * suspends a lane; the manual move's own MIX_SET / RACK_SET_PARAM that
 * follows is the edit), and the strip tap (VIS_TAP only picks what the
 * analyser shows).
 */
export const NON_EDIT_OPS: ReadonlySet<number> = new Set([
  Op.NOTE_ON, Op.NOTE_OFF, Op.PLAY, Op.STOP, Op.SEEK, Op.SET_INPUT_TRACK,
  Op.PITCH_BEND, Op.MOD_WHEEL, Op.SUSTAIN, Op.RESET_ALL, Op.AUTO_OVERRIDE, Op.VIS_TAP, Op.SET_PATTERN_FOCUS,
]);

/**
 * The project was edited (ignored while a load replaces it, and for a
 * starting-point change: Project.baselining).
 */
export function markEdited(p: Project) {
  if (p.loading || p.baselining) return;
  p.dirty = true;
  p.version++;
}

/** AudioEngine.onCommand: mark edits (see NON_EDIT_OPS). */
export function commandEdits(p: Project, op: number) {
  if (!NON_EDIT_OPS.has(op)) markEdited(p);
}

/**
 * Run a user-level edit as one undo entry (history/history.ts transact):
 * every exported action in state/*-actions.ts wraps its body in this. Nested
 * calls (an action calling another), a load replacing the session,
 * undo/redo applying a snapshot and a starting-point change
 * (Project.baselining: the history is rebased instead) just run `fn`.
 */
export function edit<T>(p: Project, label: string, fn: () => T, opts?: { coalesce?: string }): T {
  if (!p.history || p.loading || p.baselining) return fn();
  return p.history.transact(label, fn, opts);
}
