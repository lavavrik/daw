// Session bookkeeping for the built-in kits' samples (plan 25 Task 1, review
// round 1). Shared by state/defaultKit.ts and state/kit-actions.ts (kept apart
// from both so neither imports the other).
//
// 1. Which sample id already holds a kit file in this session, keyed
//    "<kit id>/<file>". A kit load reuses it instead of importing the file
//    again: auditioning kits (Garage, Deep, back to Garage…) would otherwise
//    take 8 of the session's MAX_SAMPLES ids and more sample memory on every
//    click. An id is remembered only once its load succeeded (an immediate
//    upload, or a deferred one that settled OK), and reused only while the
//    project still keeps its bytes and its deferred load never failed. The
//    table belongs to one session: ids start over when the session is
//    replaced (Project.generation), so a new generation starts an empty one.
//    An audio restart keeps ids (it re-uploads every kept sample at its own
//    id), so the table stays.
//
// 2. The default kit's load in progress, per track (loadDefaultKit). A kit
//    loaded onto that track waits for it before committing: otherwise the
//    load's undo would restore the rows as they were before the starter
//    samples landed (empty), and the late starter samples would then skip
//    the rows the kit filled.
import type { Project } from './project.svelte';
import { sampleFailed } from './sampleLoads';

interface Table {
  gen: number;
  ids: Map<string, number>;
}
const tables = new WeakMap<Project, Table>();

function table(p: Project): Map<string, number> {
  let t = tables.get(p);
  if (!t || t.gen !== p.generation) tables.set(p, (t = { gen: p.generation, ids: new Map() }));
  return t.ids;
}

const key = (kitId: string, file: string) => `${kitId}/${file}`;

/** Kit file `kitId`/`file` is loaded (OK) under sample `id` in this session. */
export function rememberKitSample(p: Project, kitId: string, file: string, id: number) {
  table(p).set(key(kitId, file), id);
}

/** The sample id already holding kit file `kitId`/`file` in this session, or null. */
export function knownKitSample(p: Project, kitId: string, file: string): number | null {
  const id = table(p).get(key(kitId, file));
  if (id === undefined || !p.sampleFiles.has(id) || sampleFailed(id)) return null;
  return id;
}

/** Per project: track id -> the default kit's load into it, while it runs. */
const defaultLoads = new WeakMap<Project, Map<string, Promise<void>>>();

/** loadDefaultKit runs `done` into `trackId` (forgotten once it settles). */
export function trackDefaultKitLoad(p: Project, trackId: string, done: Promise<void>) {
  const m = defaultLoads.get(p) ?? new Map<string, Promise<void>>();
  defaultLoads.set(p, m);
  m.set(trackId, done);
  const forget = () => {
    if (m.get(trackId) === done) m.delete(trackId);
  };
  done.then(forget, forget);
}

/** The default kit's load into `trackId` still running, or null. */
export function defaultKitLoad(p: Project, trackId: string): Promise<void> | null {
  return defaultLoads.get(p)?.get(trackId) ?? null;
}
