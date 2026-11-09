// Using a built-in kit (plan 25 Task 1, spec §1 "Using kits"): load one onto
// a drum track, or add a drum track made of one. Kits are state/kits.ts.
//
// One user action, one undo entry, although the samples load asynchronously
// (fetch, decode, upload: state/sampleImport.ts). The mechanism is "prepare,
// then commit":
//   1. prepare (async, no state change a user can see or undo): every sound
//      already loaded in this session (state/kitSamples.ts, by kit and
//      file) is reused under its id, so auditioning kits costs no new
//      sample ids or memory. The rest are fetched at once and imported one
//      at a time in role order (ids follow the rows): each upload goes into
//      the engine under a fresh id with its bytes kept (p.sampleFiles), but
//      nothing references it yet. Sounds that fail are left out and
//      reported together, in one message naming the kit. A sound the engine
//      defers (dropped while playing: Err.DEFERRED) is waited for until it
//      settles at Stop (sampleLoads.ts deferSampleAssign; its notice says
//      so). A load onto a track whose default kit is still landing
//      (loadDefaultKit) waits for that first, so the starter samples are in
//      the "before" this load's undo restores.
//   2. commit (synchronous, ONE edit(): one undo entry): put every sample on
//      its row, adding rows for roles the track lacks.
// So undo restores exactly what the rows held before (the previous sample
// ids: diffApply sends SET_ROW_SAMPLE back, removes the added rows), and
// redo puts the kit back (its samples stay uploaded under their ids; sample
// bytes are immutable and keyed by id). Unlike the default kit's
// attachKitSample (state/defaultKit.ts), nothing here is a starting point:
// it is an ordinary edit, so it marks the project unsaved.
//
// Every wait ends: the commit is dropped (the promise resolves false / null)
// when the session was replaced meanwhile (New / Open / restore:
// Project.generation; each wait races idle.ts whenSessionEnds, since a
// replaced session's whenIdle never resolves), when a deferred load is
// dropped unanswered (a reset or an audio restart that lost it: onDrop), or
// when the target track was removed. So a caller's "loading" state always
// clears. Edits made while the kit loads stay their own undo entries,
// before this one.
import { MAX_ROWS, MAX_TRACKS } from './project.svelte';
import type { DrumTrack, Project } from './project.svelte';
import { addDrumTrack, addRow, setRowSample, uniqueTrackName } from './actions';
import type { CommandSink } from './actions';
import { banners } from './banners.svelte';
import { edit } from './edits';
import { whenIdle, whenSessionEnds } from './idle';
import { defaultKitLoad, knownKitSample, rememberKitSample } from './kitSamples';
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
/** importSample's text without its own `Couldn't load "<file>" — ` lead (the kit message names the sound). */
const reason = (e: string) => e.replace(/^Couldn't load "[^"]*" — /, '');

/** `x`, or null once session `gen` is gone (whichever comes first). */
const orEnded = <T>(p: Project, gen: number, x: Promise<T>): Promise<T | null> =>
  Promise.race([x, whenSessionEnds(p, gen).then(() => null)]);

/** Every sound that didn't load, in one message naming the kit (null: none). */
export function kitFailureText(kit: Kit, failed: { role: KitRole; why: string }[]): string | null {
  if (!failed.length) return null;
  const n = failed.length;
  return `${kit.name} kit: ${n} sound${n === 1 ? '' : 's'} didn't load — ${failed.map((f) => `${f.role}: ${f.why}`).join('; ')}`;
}

/**
 * Step 1 ("prepare", see the header): role -> sample id for every sound of
 * `kit` (reused or imported), plus the sounds that failed. Null when
 * `stillThere` turns false or the session ends (the target or the session
 * went).
 */
async function importKit(
  p: Project, engine: ImportEngine, kit: Kit, stillThere: () => boolean, deps: KitFileDeps,
): Promise<{ ids: Map<KitRole, number>; failed: { role: KitRole; why: string }[] } | null> {
  const gen = p.generation;
  const ids = new Map<KitRole, number>();
  const failed: { role: KitRole; why: string }[] = [];
  const todo = kit.rows.filter((s) => {
    const id = knownKitSample(p, kit.id, s.file);
    if (id !== null) ids.set(s.role, id);
    return id === null;
  });
  const files = todo.map((s) => deps.fetchFile(kit, s).then((file) => ({ file }), (error: unknown) => ({ error })));
  const deferred: Promise<void>[] = [];
  const loaded = (s: KitSound, id: number) => {
    ids.set(s.role, id);
    // Only for the session that imported it: a deferred load settling after
    // a replace must not land in the new session's table (its id may be
    // another sample there).
    if (p.generation === gen) rememberKitSample(p, kit.id, s.file, id);
  };
  for (const [i, s] of todo.entries()) {
    const got = await orEnded(p, gen, files[i]);
    if (!got || !stillThere()) return null;
    if ('error' in got) {
      failed.push({ role: s.role, why: message(got.error) });
      continue;
    }
    let r = await orEnded(p, gen, importSample(p, engine, got.file, stillThere));
    if (r && !r.ok && r.busy) {
      // An audio restart or an autosave restore's read (as loadDefaultKit):
      // try once more when it is over (a replaced session never signals: the
      // race ends the wait).
      if ((await orEnded(p, gen, whenIdle(p).then(() => true))) === null || !stillThere()) return null;
      r = await orEnded(p, gen, importSample(p, engine, got.file, stillThere));
    }
    if (!r || !stillThere()) return null;
    if (!r.ok) {
      if (r.error) failed.push({ role: s.role, why: reason(r.error) });
      continue;
    }
    if (!r.deferred) loaded(s, r.id);
    else {
      const id = r.id;
      // Registered before the next await, so a Stop meanwhile still finds it.
      // Settles on OK (attach), a failure (onFail: the generic banner says
      // why) or a drop (onDrop: a reset, whose session is gone, so the load
      // ends below; or an audio restart that lost it: reported as failed).
      deferred.push(
        new Promise<void>((resolve) =>
          deferSampleAssign(id, s.name, () => {
            loaded(s, id);
            resolve();
          }, () => resolve(), () => {
            failed.push({ role: s.role, why: 'dropped before it loaded (audio restarted)' });
            resolve();
          }),
        ),
      );
    }
  }
  if ((await orEnded(p, gen, Promise.all(deferred))) === null) return null;
  return stillThere() ? { ids, failed } : null;
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
  const got = await importKit(p, sink, kit, there, deps);
  // The track's default kit still landing: let it finish first (see the header).
  const landing = defaultKitLoad(p, trackId);
  if (got && landing) await orEnded(p, gen, landing);
  if (!got || !there()) return false;
  const { ids, failed } = got;
  const loaded = kit.rows.filter((s) => ids.has(s.role));
  let skipped: KitRole[] = [];
  const done = loaded.length > 0 && edit(p, `Load kit ${kit.name}`, () => {
    const t = drumTrack(p, trackId)!;
    const plan = kitRowPlan(t.rows.map((r) => r.name), { ...kit, rows: loaded });
    for (const { role, row } of plan.rows) {
      const r = row === null ? addRow(p, sink, t.id) : t.rows[row];
      if (r) setRowSample(p, sink, t.id, r.id, ids.get(role)!, role);
    }
    skipped = plan.skipped;
    return true;
  });
  const problems = [
    kitFailureText(kit, failed),
    skipped.length ? `No room for ${skipped.join(', ')} from the ${kit.name} kit: ${MAX_ROWS} rows is the maximum` : null,
  ].filter((m): m is string => m !== null);
  if (problems.length) deps.onError(problems.join('. '));
  return done;
}

/**
 * A new drum track made of kit `kitId` (Add track ▸ Drum track: the starter
 * kit; its kit choice / the menu bar's Drum track ▸ <kit>: any kit): its
 * rows are the kit's roles, each with its sound (a sound that failed leaves
 * its row empty). Named after the kit ("Drums" for the starter kit). One
 * undo entry ("Add drum track"), made when the samples are in, so the track
 * appears then (see the header; a second add of a kit reuses its samples, so
 * it is immediate). Null when no track slot is free or the session was
 * replaced meanwhile.
 */
export async function addKitDrumTrack(
  p: Project, engine: CommandSink & ImportEngine, kitId: string, deps: KitFileDeps = appKitFileDeps,
): Promise<DrumTrack | null> {
  const kit = kitById(kitId);
  if (!kit || p.tracks.length >= MAX_TRACKS || p.loading) return null;
  const gen = p.generation;
  const there = () => p.generation === gen && !p.loading;
  const got = await importKit(p, engine, kit, there, deps);
  if (!got || !there()) return null;
  const { ids, failed } = got;
  const failure = kitFailureText(kit, failed);
  if (failure) deps.onError(failure);
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
