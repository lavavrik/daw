// Autosave to OPFS (the origin-private file system): a crash or a reload
// never loses more than the last few seconds of work. See
// docs/architecture/projects.md "Autosave".
//
// OPFS layout (root = navigator.storage.getDirectory()):
//
//   autosave/autosave.json        THE MARKER: { format, savedAt, project }.
//                                 Only this file is ever read; it is replaced
//                                 by a rename, last, so it is always complete.
//   autosave/samples/<id>-<hash>-<name>
//                                 sample pool shared by successive autosaves;
//                                 names carry a content hash, so a file that
//                                 exists with the right size is reused as is.
//   autosave.tmp/autosave.json    the next marker while it is being written.
//
// writeAutosave order (each step leaves the previous autosave readable):
//   1. every listed sample missing from the pool is written into it (new
//      names only add files; large files in 1 MiB chunks, so the UI thread
//      never stalls on one big copy);
//   2. the marker is written to autosave.tmp/;
//   3. it is moved over autosave/autosave.json (the commit; where the handle
//      cannot move, the marker is written whole — atomic on close);
//   4. pool files the new marker does not list are removed (after the
//      commit, so the committed autosave never misses a sample).
// A crash at any step leaves either the previous or the new marker, and every
// sample the marker lists. A leftover autosave.tmp/ is never read.
//
// createAutosave: debounced writer. App calls markDirty on every Project.version
// change (state/edits.ts) and flush on visibilitychange -> hidden.
import type { Project } from '../state/project.svelte';
import { WRITE_CHUNK, readListedSamples, replaceWith, writeFile } from './fsFolder';
import type { ProjectJson } from './schema';
import { projectFiles, serialize } from './serialize';

export const AUTOSAVE_DIR = 'autosave';
export const AUTOSAVE_TMP = 'autosave.tmp';
export const MARKER = 'autosave.json';
const SAMPLES_DIR = 'samples';
const FORMAT = 1;

/** What the start-up check needs (the marker only; no samples read). */
export interface AutosaveInfo {
  /** Date.now() when the autosaved state was taken. */
  savedAt: number;
  name: string;
}

type Entries = { entries(): AsyncIterable<[string, FileSystemHandle]> };
type Marker = { format: number; savedAt: number; project: ProjectJson };

const notFound = (e: unknown) => (e as Error)?.name === 'NotFoundError';

/** The OPFS root (async: the first call may set it up). */
export const opfsRoot = () => navigator.storage.getDirectory();

/** Size of `dir`/`name`, or -1 if there is no such file. */
async function fileSize(dir: FileSystemDirectoryHandle, name: string): Promise<number> {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size;
  } catch {
    return -1;
  }
}

/**
 * Write one autosave (the order at the top). `files`: "samples/<name>" ->
 * bytes, as projectFiles returns them. Throws if a step fails; the previous
 * autosave is then still the one read.
 */
export async function writeAutosave(
  root: FileSystemDirectoryHandle, json: ProjectJson, files: Map<string, ArrayBuffer>, savedAt: number,
  opts: { chunkBytes?: number } = {},
) {
  const chunk = opts.chunkBytes ?? WRITE_CHUNK;
  const dir = await root.getDirectoryHandle(AUTOSAVE_DIR, { create: true });
  const pool = await dir.getDirectoryHandle(SAMPLES_DIR, { create: true });
  const keep = new Set<string>();
  for (const [path, bytes] of files) {
    const name = path.slice(SAMPLES_DIR.length + 1);
    if (!path.startsWith(`${SAMPLES_DIR}/`) || name === '' || name.includes('/')) throw new Error(`bad sample path ${path}`);
    keep.add(name);
    // Same name = same id, name and content hash: a complete file is reused.
    // (A crash mid-write leaves an empty or old-sized file, rewritten here.)
    if ((await fileSize(pool, name)) !== bytes.byteLength) await writeFile(pool, name, bytes, chunk);
  }

  const tmp = await root.getDirectoryHandle(AUTOSAVE_TMP, { create: true });
  const marker: Marker = { format: FORMAT, savedAt, project: json };
  await writeFile(tmp, MARKER, JSON.stringify(marker), chunk);
  await replaceWith(tmp, MARKER, dir, MARKER); // the commit

  const stale: string[] = [];
  for await (const [name] of (pool as unknown as Entries).entries()) if (!keep.has(name)) stale.push(name);
  for (const name of stale) await pool.removeEntry(name).catch(() => {});
}

async function readMarker(root: FileSystemDirectoryHandle): Promise<{ dir: FileSystemDirectoryHandle; marker: Marker } | null> {
  let dir: FileSystemDirectoryHandle;
  let text: string;
  try {
    dir = await root.getDirectoryHandle(AUTOSAVE_DIR);
    text = await (await (await dir.getFileHandle(MARKER)).getFile()).text();
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
  try {
    const m = JSON.parse(text) as Partial<Marker>;
    if (m?.format !== FORMAT || typeof m.savedAt !== 'number' || !Number.isFinite(m.savedAt)) return null;
    if (typeof m.project !== 'object' || m.project === null) return null;
    return { dir, marker: m as Marker };
  } catch {
    return null; // empty (first write interrupted) or not ours: no autosave
  }
}

/** The completed autosave's time and project name, or null if there is none. */
export async function peekAutosave(root: FileSystemDirectoryHandle): Promise<AutosaveInfo | null> {
  const r = await readMarker(root);
  if (!r) return null;
  const name = (r.marker.project as { name?: unknown }).name;
  return { savedAt: r.marker.savedAt, name: typeof name === 'string' ? name : 'Untitled' };
}

/**
 * The completed autosave: its project.json (not yet validated: loadProject
 * does that) and the samples it lists, or null if there is none.
 */
export async function readAutosave(
  root: FileSystemDirectoryHandle,
): Promise<{ savedAt: number; json: unknown; files: Map<string, ArrayBuffer> } | null> {
  const r = await readMarker(root);
  if (!r) return null;
  return { savedAt: r.marker.savedAt, json: r.marker.project, files: await readListedSamples(r.dir, r.marker.project) };
}

/** "Start fresh": the marker goes first, so nothing half-removed is ever read. */
export async function discardAutosave(root: FileSystemDirectoryHandle) {
  try {
    await (await root.getDirectoryHandle(AUTOSAVE_DIR)).removeEntry(MARKER);
  } catch { /* none */ }
  await root.removeEntry(AUTOSAVE_DIR, { recursive: true }).catch(() => {});
  await root.removeEntry(AUTOSAVE_TMP, { recursive: true }).catch(() => {});
}

// "Last explicit save" (Project ▸ Save / Save As): a per-browser time in
// localStorage, compared with the autosave's savedAt on start.
const LAST_SAVE_KEY = 'daw.lastExplicitSave';

export function lastExplicitSave(): number | null {
  try {
    const v = Number(globalThis.localStorage?.getItem(LAST_SAVE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function recordExplicitSave(t = Date.now()) {
  try {
    globalThis.localStorage?.setItem(LAST_SAVE_KEY, String(t));
  } catch { /* storage blocked: every autosave is then offered */ }
}

/** Offer "Restore last session" only for an autosave newer than the last explicit save. */
export function offersRestore(info: AutosaveInfo | null, lastSave: number | null): boolean {
  return info !== null && (lastSave === null || info.savedAt > lastSave);
}

export interface AutosaveOptions {
  getProject: () => Project;
  /** The OPFS root (tests: a fake directory). */
  root: () => Promise<FileSystemDirectoryHandle>;
  /** Quiet time after the last change before a write. */
  debounceMs?: number;
  /** Continuous editing still writes at least this often. */
  maxWaitMs?: number;
  /** A write failed (message; reported once until one succeeds) or succeeded again (null). */
  onError?: (message: string | null) => void;
  now?: () => number;
}

export interface Autosave {
  /** The project changed (App: every Project.version change). */
  markDirty(): void;
  /** Write now if anything changed (visibilitychange -> hidden); resolves when written. */
  flush(): Promise<void>;
  /** savedAt of the last autosave this session wrote, or null. */
  readonly lastSaved: number | null;
  /**
   * Hold writes (changes are remembered): while the start-up check runs and
   * the "Restore last session" offer is open, the previous autosave must not
   * be overwritten.
   */
  hold(on: boolean): void;
  /** Forget pending changes (an explicit save or a restore just made them moot). */
  cancel(): void;
  dispose(): void;
}

export function createAutosave(o: AutosaveOptions): Autosave {
  const debounce = o.debounceMs ?? 5000;
  const maxWait = o.maxWaitMs ?? 30_000;
  const now = o.now ?? Date.now;
  let pending = false;
  let held = false;
  let firstChange = 0; // when the pending changes began (maxWait)
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let lastSaved: number | null = null;
  let reported: string | null = null;

  const schedule = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), ms);
  };

  async function writeOnce() {
    const p = o.getProject();
    if (p.loading) {
      schedule(debounce); // mid-load state is never written; try again after
      return;
    }
    pending = false;
    const savedAt = now();
    // Synchronous: the snapshot is consistent (no edit can interleave).
    const json = serialize(p);
    const files = projectFiles(p, json);
    try {
      await writeAutosave(await o.root(), json, files, savedAt);
      lastSaved = savedAt;
      if (reported !== null) o.onError?.((reported = null));
    } catch (e) {
      pending = true; // retried on the next change
      const msg = `Autosave failed — ${e instanceof Error ? e.message : String(e)}`;
      console.warn(msg, e);
      if (msg !== reported) o.onError?.((reported = msg));
    }
  }

  /** One write at a time; a change during a write is written after it. */
  async function run() {
    clearTimeout(timer);
    while (running) await running;
    if (!pending || held) return;
    running = writeOnce().finally(() => (running = null));
    await running;
  }

  return {
    markDirty() {
      if (!pending) firstChange = now();
      pending = true;
      if (held) return;
      schedule(Math.max(0, Math.min(debounce, firstChange + maxWait - now())));
    },
    flush: run,
    get lastSaved() {
      return lastSaved;
    },
    hold(on) {
      held = on;
      if (on) clearTimeout(timer);
      else if (pending) schedule(debounce);
    },
    cancel() {
      pending = false;
      clearTimeout(timer);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
