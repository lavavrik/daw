// project.json schema migrations (spec addendum §3.5). Each schema change
// bumps `schemaVersion`; `migrate` turns an older file into the current
// version, one step at a time, and runs before `validate` (schema.ts calls
// it first, so every reader -- open, autosave restore, the folder's sample
// list -- gets it). Pure: the input is never changed.
//
//   v1 -> v2 (plan 9): Audio tracks. A v1 project has none, so the step only
//                      bumps the version: lossless.
//   v2 -> v3 (plan 10): automation lanes. A v2 project has none: every track
//                      (an object in `tracks`) and the mixer (if it is an
//                      object) get an empty `automation`; nothing else
//                      changes, so it is lossless too.
//   v3 -> v4 (plan 14): MIDI CC mappings. A v3 project has none: the step
//                      adds a top-level `midiMap: []` (replacing anything a
//                      v3 file had under that name, which v3 never wrote).
//   v4 -> v5 (plan 21): the pattern library. A v4 project has none: the step
//                      adds a top-level `patternLibrary: []` (replacing
//                      anything under that name, which v4 never wrote).
//   v5 -> v6 (plan 26): the key. A v5 project has none: the step adds a
//                      top-level `key: { root: 9, scale: 'minor' }` (A minor,
//                      the house default; replacing anything under that
//                      name, which v5 never wrote). Nothing else changes.
//   v6 -> v7 (plan 29): multiple returns. `mixer.reverb` and `mixer.delay`
//                      become `mixer.returns`: the Reverb on slot 0 (id
//                      'reverb', name "Reverb") and the Delay on slot 1 (id
//                      'delay', name "Delay"), each with its params as they
//                      were. The ids are the old channel names, so the
//                      Master row lanes and MIDI mappings that name them
//                      stay valid unchanged, and track sends need nothing
//                      (send_a / send_b are slots 0 / 1). A mixer that is
//                      not an object read as all defaults, so it becomes
//                      one with just the two default returns. Lossless.
//
// Anything that is not a v1..current project object (no or a bad
// schemaVersion, a NEWER version than this build knows) is returned as is
// for `validate` to refuse with its error.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Json = Record<string, unknown>;

/** The steps, by the version they migrate FROM. */
const STEPS = new Map<unknown, (json: Json) => Json>([
  [1, (json) => ({ ...json, schemaVersion: 2 })],
  [2, (json) => ({
    ...json,
    schemaVersion: 3,
    ...(Array.isArray(json.tracks) ? { tracks: json.tracks.map((t) => (isObj(t) ? { ...t, automation: [] } : t)) } : {}),
    ...(isObj(json.mixer) ? { mixer: { ...json.mixer, automation: [] } } : {}),
  })],
  [3, (json) => ({ ...json, schemaVersion: 4, midiMap: [] })],
  [4, (json) => ({ ...json, schemaVersion: 5, patternLibrary: [] })],
  [5, (json) => ({ ...json, schemaVersion: 6, key: { root: 9, scale: 'minor' } })],
  [6, (json) => {
    const { reverb, delay, ...rest } = isObj(json.mixer) ? json.mixer : {};
    const returns = [
      { id: 'reverb', kind: 'reverb', name: 'Reverb', slot: 0, params: reverb ?? {} },
      { id: 'delay', kind: 'delay', name: 'Delay', slot: 1, params: delay ?? {} },
    ];
    return { ...json, schemaVersion: 7, mixer: { ...rest, returns } };
  }],
]);

/** `json` brought up to the current schema version (see above). */
export function migrate(json: unknown): unknown {
  if (!isObj(json)) return json;
  let out = json;
  for (let step = STEPS.get(out.schemaVersion); step; step = STEPS.get(out.schemaVersion)) out = step(out);
  return out;
}
