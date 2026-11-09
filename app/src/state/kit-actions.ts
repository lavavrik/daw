// Using a built-in kit (plan 25 Task 1, spec §1 "Using kits"): load one onto
// a drum track, or add a drum track made of one. Kits are state/kits.ts.
//
// One user action, one undo entry, although the samples load asynchronously
// (fetch, decode, upload: state/sampleImport.ts). The mechanism is "prepare,
// then commit":
//   1. prepare (async, no state change a user can see or undo): fetch every
//      sound of the kit at once, import them one at a time in role order
//      (ids follow the rows). Each import uploads the sample into the
//      engine under a fresh id and keeps its bytes (p.sampleFiles), but
//      nothing references it yet. A sound that fails reports its error
//      (deps.onError) and is left out. A sound the engine defers (dropped
//      while playing: Err.DEFERRED) is waited for until it settles at Stop
//      (sampleLoads.ts deferSampleAssign; its notice says so).
//   2. commit (synchronous, ONE edit(): one undo entry): put every imported
//      sample on its row, adding rows for roles the track lacks.
// So undo restores exactly what the rows held before (the previous sample
// ids: diffApply sends SET_ROW_SAMPLE back, removes the added rows), and
// redo puts the kit back (its samples stay uploaded under their ids; sample
// bytes are immutable and keyed by id). Unlike the default kit's
// attachKitSample (state/defaultKit.ts), nothing here is a starting point:
// it is an ordinary edit, so it marks the project unsaved.
//
// The commit is dropped when the session was replaced meanwhile (New / Open
// / restore: Project.generation; a reset also drops a deferred load, whose
// wait then never ends — that load's session is gone) or the target track
// was removed. Edits made while the kit loads stay their own undo entries,
// before this one.
import { MAX_ROWS, MAX_TRACKS } from './project.svelte';
import type { DrumTrack, Project } from './project.svelte';
import { addDrumTrack, addRow, setRowSample, uniqueTrackName } from './actions';
import type { CommandSink } from './actions';
import { banners } from './banners.svelte';
import { edit } from './edits';
import { whenIdle } from './idle';
import { STARTER_KIT_ID, kitById, rowHasRole } from './kits';
import type { Kit, KitRole, KitSound } from './kits';
import { importSample } from './sampleImport';
import type { ImportEngine } from './sampleImport';
import { deferSampleAssign } from './sampleLoads';
import { kitSample } from '../library/kitFiles';

export interface KitFileDeps {
  /** The kit sound as a File (the app: fetched from the bundle, library/kitFiles.ts). */
  fetchFile(kit: Kit, sound: KitSound): Promise<File>;
  /** A sound could not be loaded, or had no room (the app: the error banner). */
  onError(message: string): void;
}

export const appKitFileDeps: KitFileDeps = {
  fetchFile: (kit, s) => kitSample(kit.id, s.file),
  onError: (m) => (banners.error = m),
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Step 1 ("prepare", see the header): every sound of `kit` imported, as
 * role -> sample id (a failed sound is missing; its error is reported).
 * Null when `stillThere` turns false (the target or the session went).
 */
async function importKit(
  p: Project, engine: ImportEngine, kit: Kit, stillThere: () => boolean, deps: KitFileDeps,
): Promise<Map<KitRole, number> | null> {
  const files = kit.rows.map((s) => deps.fetchFile(kit, s).then((file) => ({ file }), (error: unknown) => ({ error })));
  const ids = new Map<KitRole, number>();
  const deferred: Promise<void>[] = [];
  for (const [i, s] of kit.rows.entries()) {
    const got = await files[i];
    if (!stillThere()) return null;
    if ('error' in got) {
      deps.onError(`Couldn't load "${s.file}" from the ${kit.name} kit — ${message(got.error)}`);
      continue;
    }
    let r = await importSample(p, engine, got.file, stillThere);
    if (!r.ok && r.busy) {
      // An audio restart or an autosave restore's read (as loadDefaultKit):
      // try once more when it is over. A replaced session never signals.
      await whenIdle(p);
      if (!stillThere()) return null;
      r = await importSample(p, engine, got.file, stillThere);
    }
    if (!stillThere()) return null;
    if (!r.ok) {
      if (r.error) deps.onError(r.error);
      continue;
    }
    if (!r.deferred) ids.set(s.role, r.id);
    else {
      const id = r.id;
      // Registered before the next await, so a Stop meanwhile still finds it.
      deferred.push(
        new Promise<void>((resolve) =>
          deferSampleAssign(id, s.name, () => {
            ids.set(s.role, id);
            resolve();
          }, () => resolve()),
        ),
      );
    }
  }
  await Promise.all(deferred);
  return stillThere() ? ids : null;
}

const drumTrack = (p: Project, trackId: string) => {
  const t = p.tracks.find((x) => x.id === trackId);
  return t?.kind === 'drum' ? t : null;
};

/**
 * Which row each kit sound goes to: the first row named after its role
 * (rowHasRole), else a new row (`row: null`) while the track has room
 * (MAX_ROWS); sounds with neither are `skipped`. Pure (rows by name only).
 */
export function kitRowPlan(rowNames: readonly string[], kit: Kit, maxRows = MAX_ROWS) {
  const rows: { role: KitRole; row: number | null }[] = [];
  const skipped: KitRole[] = [];
  let count = rowNames.length;
  for (const s of kit.rows) {
    const at = rowNames.findIndex((n) => rowHasRole(n, s.role));
    if (at >= 0) rows.push({ role: s.role, row: at });
    else if (count < maxRows) {
      rows.push({ role: s.role, row: null });
      count++;
    } else skipped.push(s.role);
  }
  return { rows, skipped };
}

/**
 * Load kit `kitId` onto drum track `trackId` (the Browser's "Load onto
 * track"): each row named after a role gets the kit's sound for it, roles
 * the track lacks get new rows (up to MAX_ROWS), other rows and every step
 * stay as they are. One undo entry ("Load kit <name>"), made when the
 * samples are in (see the header). Resolves true when it committed.
 */
export async function loadKitOntoTrack(
  p: Project, sink: CommandSink & ImportEngine, trackId: string, kitId: string, deps: KitFileDeps = appKitFileDeps,
): Promise<boolean> {
  const kit = kitById(kitId);
  if (!kit || !drumTrack(p, trackId) || p.loading) return false;
  const gen = p.generation;
  const there = () => p.generation === gen && !p.loading && drumTrack(p, trackId) !== null;
  const ids = await importKit(p, sink, kit, there, deps);
  if (!ids || !there()) return false;
  const loaded = kit.rows.filter((s) => ids.has(s.role));
  if (!loaded.length) return false;
  return edit(p, `Load kit ${kit.name}`, () => {
    const t = drumTrack(p, trackId)!;
    const plan = kitRowPlan(t.rows.map((r) => r.name), { ...kit, rows: loaded });
    for (const { role, row } of plan.rows) {
      const r = row === null ? addRow(p, sink, t.id) : t.rows[row];
      if (r) setRowSample(p, sink, t.id, r.id, ids.get(role)!, role);
    }
    if (plan.skipped.length) {
      deps.onError(`No room for ${plan.skipped.join(', ')} from the ${kit.name} kit: ${MAX_ROWS} rows is the maximum`);
    }
    return true;
  });
}

/**
 * A new drum track made of kit `kitId` (Add track ▸ Drum track ▸ <kit>): its
 * rows are the kit's roles, each with its sound (a sound that failed leaves
 * its row empty). Named after the kit ("Drums" for the starter kit). One
 * undo entry ("Add drum track"), made when the samples are in, so the track
 * appears then (see the header). Null when no track slot is free or the
 * session was replaced meanwhile.
 */
export async function addKitDrumTrack(
  p: Project, engine: CommandSink & ImportEngine, kitId: string, deps: KitFileDeps = appKitFileDeps,
): Promise<DrumTrack | null> {
  const kit = kitById(kitId);
  if (!kit || p.tracks.length >= MAX_TRACKS || p.loading) return null;
  const gen = p.generation;
  const there = () => p.generation === gen && !p.loading;
  const ids = await importKit(p, engine, kit, there, deps);
  if (!ids || !there()) return null;
  return edit(p, 'Add drum track', () => {
    const name = uniqueTrackName(p, kit.id === STARTER_KIT_ID ? 'Drums' : kit.name);
    const t = addDrumTrack(p, engine, name, kit.rows.map((s) => s.role));
    if (!t) return null;
    t.rows.forEach((r, i) => {
      const id = ids.get(kit.rows[i].role);
      if (id !== undefined) setRowSample(p, engine, t.id, r.id, id, r.name);
    });
    return t;
  });
}
