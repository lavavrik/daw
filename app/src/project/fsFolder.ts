// A project folder on disk (File System Access API) or in OPFS: any
// FileSystemDirectoryHandle works (the e2e tests and autosave use OPFS).
//
//   <folder>/project.json         schema.ts
//   <folder>/samples/<id>-<name>  the original sample bytes, never re-encoded
//
// writeProject order, so a crash or a failed write at any point leaves the
// previous project readable: samples first (new names only add files), then
// project.json.tmp, then the tmp is moved over project.json (or, where the
// handle cannot move, project.json is written from it: Chrome's writable
// streams replace the file atomically on close). Sample names carry a
// content hash (serialize.ts), so an existing file is never overwritten with
// other bytes. Only after project.json is replaced are the samples removed
// that the PREVIOUS project.json listed and the new one does not: nothing
// else in the folder is ever deleted (it may be the user's own files).

import { validate } from './schema';

export const PROJECT_FILE = 'project.json';
const TMP_FILE = 'project.json.tmp';
const SAMPLES_DIR = 'samples';

type Writable = { write(data: ArrayBuffer | string): Promise<void>; close(): Promise<void>; abort?(): Promise<void> };
type MovableFile = FileSystemFileHandle & { move?: (dir: FileSystemDirectoryHandle, name: string) => Promise<void> };
type Entries = { entries(): AsyncIterable<[string, FileSystemHandle]> };

/**
 * Ask the user for a project folder (read/write). Null if they cancel.
 * Needs a user gesture (click or key press).
 */
export async function pickProjectFolder(): Promise<FileSystemDirectoryHandle | null> {
  const pick = (window as unknown as { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  if (typeof pick !== 'function') throw new Error('this browser cannot open folders (use Chrome)');
  try {
    return await pick({ id: 'daw-project', mode: 'readwrite' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: ArrayBuffer | string) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = (await fh.createWritable()) as unknown as Writable;
  try {
    await w.write(data);
    await w.close();
  } catch (e) {
    await w.abort?.().catch(() => {});
    throw e;
  }
}

async function readBytes(fh: FileSystemFileHandle): Promise<ArrayBuffer> {
  return (await fh.getFile()).arrayBuffer();
}

/** Same bytes already on disk (skips rewriting unchanged samples on every save). */
async function sameFile(dir: FileSystemDirectoryHandle, name: string, bytes: ArrayBuffer): Promise<boolean> {
  try {
    const f = await (await dir.getFileHandle(name)).getFile();
    if (f.size !== bytes.byteLength) return false;
    const a = new Uint8Array(await f.arrayBuffer());
    const b = new Uint8Array(bytes);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  } catch {
    return false;
  }
}

/** Sample file names ("x.wav" in samples/) that `dir`'s current project.json lists. */
async function listedSamples(dir: FileSystemDirectoryHandle): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const json = JSON.parse(await (await (await dir.getFileHandle(PROJECT_FILE)).getFile()).text()) as { samples?: unknown };
    for (const s of Array.isArray(json.samples) ? json.samples : []) {
      const file = (s as { file?: unknown })?.file;
      if (typeof file === 'string' && /^samples\/[^/\\]+$/.test(file)) out.add(file.slice(SAMPLES_DIR.length + 1));
    }
  } catch { /* no (readable) project here: nothing is ours to remove */ }
  return out;
}

/**
 * True if `dir` already holds a project (project.json) or anything in
 * samples/: saving there would replace it, so Save As asks first.
 */
export async function folderInUse(dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    await dir.getFileHandle(PROJECT_FILE);
    return true;
  } catch { /* none */ }
  try {
    const samples = await dir.getDirectoryHandle(SAMPLES_DIR);
    for await (const _ of (samples as unknown as Entries).entries()) return true;
  } catch { /* none */ }
  return false;
}

/**
 * Write `json` and its sample files (`files`: "samples/<name>" -> bytes)
 * into `dir`, in the crash-safe order described at the top.
 */
export async function writeProject(dir: FileSystemDirectoryHandle, json: unknown, files: Map<string, ArrayBuffer>) {
  const previous = await listedSamples(dir);
  const samples = await dir.getDirectoryHandle(SAMPLES_DIR, { create: true });
  const keep = new Set<string>();
  for (const [path, bytes] of files) {
    const name = path.slice(SAMPLES_DIR.length + 1);
    if (!path.startsWith(`${SAMPLES_DIR}/`) || name === '' || name.includes('/')) throw new Error(`bad sample path ${path}`);
    keep.add(name);
    if (!(await sameFile(samples, name, bytes))) await writeFile(samples, name, bytes);
  }

  await writeFile(dir, TMP_FILE, JSON.stringify(json, null, 1));
  const tmp = (await dir.getFileHandle(TMP_FILE)) as MovableFile;
  let moved = false;
  if (typeof tmp.move === 'function') {
    try {
      await tmp.move(dir, PROJECT_FILE);
      moved = true;
    } catch { /* not supported here (or the target exists): copy instead */ }
  }
  if (!moved) {
    await writeFile(dir, PROJECT_FILE, await (await tmp.getFile()).text());
    await dir.removeEntry(TMP_FILE);
  }

  for (const name of previous) {
    if (!keep.has(name)) await samples.removeEntry(name).catch(() => {}); // already gone: fine
  }
}

/**
 * Read project.json (parsed, not yet validated: loadProject does that) and
 * the sample files it lists ("samples/<name>" -> bytes; a missing one is
 * simply absent, the load warns). Nothing else in the folder is read. Throws
 * an Error with a plain-words message if the folder has no readable project.
 */
export async function readProject(dir: FileSystemDirectoryHandle): Promise<{ json: unknown; files: Map<string, ArrayBuffer> }> {
  let text: string;
  try {
    text = await (await (await dir.getFileHandle(PROJECT_FILE)).getFile()).text();
  } catch {
    throw new Error(`"${dir.name}" has no project.json — is it a project folder?`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`project.json in "${dir.name}" is not valid JSON`);
  }
  const files = new Map<string, ArrayBuffer>();
  const v = validate(json); // only for the list of sample paths (safe names)
  if ('error' in v || v.project.samples.length === 0) return { json, files };
  let samples: FileSystemDirectoryHandle;
  try {
    samples = await dir.getDirectoryHandle(SAMPLES_DIR);
  } catch {
    return { json, files };
  }
  for (const s of v.project.samples) {
    try {
      files.set(s.file, await readBytes(await samples.getFileHandle(s.file.slice(SAMPLES_DIR.length + 1))));
    } catch { /* missing: loadProject warns */ }
  }
  return { json, files };
}
