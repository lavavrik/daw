// The song's key (plan 26 Task 1; docs/architecture/theory.md). Like the
// other *-actions.ts files: setKey changes Project AND sends what the engine
// needs, as one undo entry.
//
// Engine side: the engine learns the key through keyCommands(), the ONE
// place that builds its command(s). It is used by
//   - setKey (an edit) and applyKey (undo/redo: history/diffApply.ts), and
//   - project/commands.ts projectCommands (load, audio restart, export), so
//     every way a project reaches an engine sends the key.
// PLAN 26 TASK 3 HOOK: keyCommands returns nothing until the engine has a
// SET_KEY op; Task 3 adds the op and returns [[Op.SET_KEY, root, scale
// index]] here (scale index = SCALE_IDS.indexOf(key.scale), the wire order
// pinned by engine/tests/fixtures/scales.json). No other call site changes.
import { isScaleId, sameKey } from '../music/scales';
import type { MusicKey } from '../music/scales';
import type { CommandSink } from './actions';
import type { EngineCommand } from './rack-actions';
import type { Project } from './project.svelte';
import { edit, markEdited } from './edits';

/** The engine command(s) that set `key` (none yet: see PLAN 26 TASK 3 HOOK above). */
export function keyCommands(_key: MusicKey): EngineCommand[] {
  return [];
}

/** A valid copy of `key`, or null (root not an integer 0..11, or an unknown scale). */
function checked(key: MusicKey): MusicKey | null {
  if (!Number.isInteger(key.root) || key.root < 0 || key.root > 11 || !isScaleId(key.scale)) return null;
  return { root: key.root, scale: key.scale };
}

/**
 * Make `key` the project's key and tell the engine. Not an undo entry by
 * itself (diffApply restores through it); false when it is invalid or
 * already the key (nothing sent).
 */
export function applyKey(p: Project, sink: CommandSink, key: MusicKey): boolean {
  const k = checked(key);
  if (!k || sameKey(k, p.key)) return false;
  p.key = k;
  for (const c of keyCommands(k)) sink.send(c[0], c[1], c[2], c[3], c[4]);
  markEdited(p); // no engine command yet (and the key is project data either way)
  return true;
}

/** The key picker: one "Key" undo entry; false (no entry) when nothing changes. */
export function setKey(p: Project, sink: CommandSink, key: MusicKey): boolean {
  const k = checked(key);
  if (!k || sameKey(k, p.key)) return false;
  return edit(p, 'Key', () => applyKey(p, sink, k));
}
