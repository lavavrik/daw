// The built-in default kit (plan 8 Task 4): every fresh session — the first
// start, Project ▸ New, and "Start fresh" (which keeps the first start's
// session) — begins with a playable drum track: eight named rows filled
// from the starter kit (library/starter.ts). Restoring an autosave or
// opening a project never adds it.
//
// Two steps:
//   1. addDefaultDrumTrack (synchronous, part of building the fresh
//      session, before markSaved / history.clear): the drum track with the
//      kit's row names, rows empty, no steps.
//   2. loadDefaultKit (async, not awaited: the UI is usable at once): fetch
//      every file, then import them in row order through the normal import
//      path (state/sampleImport.ts: decode, keep the original bytes in
//      p.sampleFiles so Save / export / audio restart work, upload). Each
//      row fills as its sample lands. A failure raises the normal error
//      banner and leaves that row empty.
//
// A landing sample is part of the session's starting point, not an edit
// (attachKitSample):
//   - set with Project.baselining on: no dirty mark, no version bump (so
//     the autosave writes nothing and the next start offers no restore of
//     an untouched session), no undo entry;
//   - the undo history is rebased (history.ts rebase) and so is the saved
//     fingerprint (what "● unsaved" compares with): if the user already
//     edited while the kit loaded, their edit stays one undo step, undoing
//     it keeps the kit, and undoing back to the start clears "unsaved";
//   - except when the session was saved to a folder meanwhile: the folder
//     lacks the sample, so it is an ordinary unsaved change. A save still
//     writing when it lands sees Project.baselineEpoch change and leaves the
//     project unsaved too (project/session.ts saveTo);
//   - if the user already edited this session (its version moved since the
//     load began), the autosave has (or will have) a copy without the
//     sample: KitDeps.landedAfterEdit asks it to write again (App:
//     autosave.markDirty, no version bump). An untouched session never
//     autosaves.
// A row the user filled first keeps the user's sample. A New / Open /
// restore that replaced the session (Project.generation) ends the load.
// An import that only failed because the project was busy (an audio
// restart, or an autosave restore still reading: sampleImport `busy`) is
// retried once that is over, so a restart never leaves kit rows asking to
// "drop it again".
import { starterSample } from '../library/starter';
import type { ProjectJson, SampleJson } from '../project/schema';
import { fingerprintOf, serialize } from '../project/serialize';
import { addDrumTrack, setRowSample } from './actions';
import type { CommandSink } from './actions';
import { banners } from './banners.svelte';
import { markEdited } from './edits';
import { MAX_ROWS } from './project.svelte';
import type { DrumTrack, Project } from './project.svelte';
import { importSample } from './sampleImport';
import type { ImportEngine } from './sampleImport';
import { deferSampleAssign } from './sampleLoads';

export interface KitRow {
  /** The row's name in the step grid. */
  name: string;
  /** Its file in samples/starter/. */
  file: string;
}

/** The default drum track's rows, top to bottom. */
export const DEFAULT_KIT: readonly KitRow[] = [
  { name: 'Kick', file: 'kick-punch.wav' },
  { name: 'Clap', file: 'clap.wav' },
  { name: 'Closed hat', file: 'hat-closed.wav' },
  { name: 'Open hat', file: 'hat-open.wav' },
  { name: 'Snare', file: 'snare.wav' },
  { name: 'Rim', file: 'rim.wav' },
  { name: 'Shaker', file: 'shaker.wav' },
  { name: 'Perc', file: 'perc-tom.wav' },
];

/** The kit rows a track can hold: the first `max` (the row cap). */
export function defaultKitRows(max = MAX_ROWS): KitRow[] {
  return DEFAULT_KIT.slice(0, Math.max(0, max));
}

/**
 * Step 1: the fresh session's drum track, with the kit's (empty) rows. Null
 * if no track slot is free. Built with Project.baselining on: it is the
 * starting point, not an edit, so no dirty mark and no version bump even when
 * the engine's commands mark edits (Project ▸ New runs with onCommand wired;
 * a bump there would autosave the untouched New session and offer it back as
 * "Restore last session" on the next start).
 */
export function addDefaultDrumTrack(p: Project, sink: CommandSink): DrumTrack | null {
  p.baselining = true;
  try {
    return addDrumTrack(p, sink, undefined, defaultKitRows().map((k) => k.name));
  } finally {
    p.baselining = false;
  }
}

export interface KitDeps {
  /** The kit file as a File (the app: fetched from the bundle). */
  fetchFile(file: string): Promise<File>;
  /** A sample could not be loaded (the app: the error banner). */
  onError(message: string): void;
  /**
   * A kit sample landed in a session the user already edited (the App:
   * autosave.markDirty, so the autosave includes it). Never called for an
   * untouched session.
   */
  landedAfterEdit?(): void;
}

/** The app's: the bundled starter kit, problems in the error banner. */
export const appKitDeps: KitDeps = {
  fetchFile: (file) => starterSample(file),
  onError: (m) => (banners.error = m),
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How often a kit import waiting for a busy project checks again. */
export const KIT_RETRY_POLL_MS = 50;

/** Resolves once no load / restore read / audio restart is running. */
async function untilIdle(p: Project) {
  while (p.loading || p.restarting) await new Promise((r) => setTimeout(r, KIT_RETRY_POLL_MS));
}

function emptyRow(p: Project, trackId: string, rowId: string): boolean {
  const t = p.tracks.find((x) => x.id === trackId);
  return t?.kind === 'drum' && t.rows.some((r) => r.id === rowId && r.sampleId === null);
}

/**
 * Step 2: fill the default track's rows (track `trackId`, built by
 * addDefaultDrumTrack) from the kit. Resolves when every row is done
 * (loaded, failed, deferred until Stop, or skipped).
 */
export async function loadDefaultKit(p: Project, engine: ImportEngine & CommandSink, trackId: string, deps: KitDeps = appKitDeps) {
  const gen = p.generation;
  const v0 = p.version; // the session as it started: any change of it is a user edit
  const t = p.tracks.find((x) => x.id === trackId);
  if (t?.kind !== 'drum') return;
  const jobs = t.rows.slice(0, DEFAULT_KIT.length).map((r, i) => ({ rowId: r.id, kit: DEFAULT_KIT[i] }));
  // All fetches at once; imports one at a time in row order (ids follow the rows).
  const files = jobs.map((j) => deps.fetchFile(j.kit.file).then((file) => ({ file }), (error: unknown) => ({ error })));
  for (const [i, j] of jobs.entries()) {
    const got = await files[i];
    if (p.generation !== gen) return; // the session was replaced
    if ('error' in got) {
      deps.onError(`Couldn't load "${j.kit.file}" — ${message(got.error)}`);
      continue;
    }
    const empty = () => emptyRow(p, trackId, j.rowId);
    if (!empty()) continue;
    let r = await importSample(p, engine, got.file, empty);
    if (!r.ok && r.busy) {
      // An audio restart or an autosave restore's read: the session may well
      // outlive it. Try once more after it (the live engine by then).
      await untilIdle(p);
      if (p.generation !== gen) return;
      if (!empty()) continue;
      r = await importSample(p, engine, got.file, empty);
      if (p.generation !== gen) return;
      if (!r.ok && r.busy) r = { ok: false, error: `Couldn't load the starter kit's "${j.kit.file}" — drag it in from the Browser's Starter kit` };
    }
    if (!r.ok) {
      if (r.error) deps.onError(r.error);
      continue;
    }
    const attach = (id: number) => {
      if (attachKitSample(p, engine, trackId, j.rowId, id) && p.version !== v0) deps.landedAfterEdit?.();
    };
    if (r.deferred) deferSampleAssign(r.id, j.kit.name, attach);
    else attach(r.id);
  }
}

/**
 * Put loaded sample `sampleId` on the kit row as part of the starting
 * point (see the header). False (nothing done) if the row is gone or
 * already holds a sample.
 */
export function attachKitSample(p: Project, sink: CommandSink, trackId: string, rowId: string, sampleId: number): boolean {
  const t = p.tracks.find((x) => x.id === trackId);
  if (t?.kind !== 'drum') return false;
  const i = t.rows.findIndex((r) => r.id === rowId);
  if (i < 0 || t.rows[i].sampleId !== null) return false;
  const name = t.rows[i].name;
  p.baselining = true;
  try {
    setRowSample(p, sink, trackId, rowId, sampleId, name);
  } finally {
    p.baselining = false;
  }
  const sample = serialize(p).samples.find((s) => s.id === sampleId);
  if (!sample) return true; // not saved (no original bytes): no stored state changes
  p.baselineEpoch++;
  const patch = (s: ProjectJson) => withRowSample(s, t.slot, name, sample);
  p.history?.rebase(patch);
  if (p.folder) markEdited(p);
  else if (p.savedFingerprint) p.savedFingerprint = fingerprintOf(patch(JSON.parse(p.savedFingerprint) as ProjectJson));
  return true;
}

/**
 * `s` with `sample` on the first empty row named `name` of the drum track in
 * `slot` (by name, not by the live row's index: a snapshot may hold the rows
 * elsewhere), if there is one and `sample` is not in `s` yet; else `s`
 * itself. New nodes only for what changed (fresh copies every call:
 * history.ts rebase shares and freezes them per snapshot).
 */
export function withRowSample(s: ProjectJson, slot: number, name: string, sample: SampleJson): ProjectJson {
  const ti = s.tracks.findIndex((x) => x.slot === slot);
  const t = s.tracks[ti];
  if (t?.kind !== 'drum') return s;
  const row = t.rows.findIndex((r) => r.sample === null && r.name === name);
  if (row < 0 || s.samples.some((x) => x.id === sample.id)) return s;
  const rows = t.rows.map((x, k) => (k === row ? { ...x, sample: sample.id } : x));
  return {
    ...s,
    tracks: s.tracks.map((x, k) => (k === ti ? { ...t, rows } : x)),
    // Copies: an id sorted in before others shifts them to other indexes.
    samples: [...s.samples, sample].sort((a, b) => a.id - b.id).map((x) => ({ ...x })),
  };
}
