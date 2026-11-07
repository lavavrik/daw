// project.json schema migrations (spec addendum §3.5). Each schema change
// bumps `schemaVersion`; `migrate` turns an older file into the current
// version, one step at a time, and runs before `validate` (schema.ts calls
// it first, so every reader -- open, autosave restore, the folder's sample
// list -- gets it). Pure: the input is never changed.
//
//   v1 -> v2 (plan 9): Audio tracks. A v1 project has none, so the step only
//                      bumps the version: lossless.
//
// Anything that is not a v1..current project object (no or a bad
// schemaVersion, a NEWER version than this build knows) is returned as is
// for `validate` to refuse with its error.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Json = Record<string, unknown>;

/** The steps, by the version they migrate FROM. */
const STEPS = new Map<unknown, (json: Json) => Json>([
  [1, (json) => ({ ...json, schemaVersion: 2 })],
]);

/** `json` brought up to the current schema version (see above). */
export function migrate(json: unknown): unknown {
  if (!isObj(json)) return json;
  let out = json;
  for (let step = STEPS.get(out.schemaVersion); step; step = STEPS.get(out.schemaVersion)) out = step(out);
  return out;
}
