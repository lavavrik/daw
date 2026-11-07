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
// streams replace the file atomically on close). Sample files the new
// project.json no longer lists are removed only after that.

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

/**
 * Write `json` and its sample files (`files`: "samples/<name>" -> bytes)
 * into `dir`, in the crash-safe order described at the top.
 */
export async function writeProject(dir: FileSystemDirectoryHandle, json: unknown, files: Map<string, ArrayBuffer>) {
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

  const stale: string[] = [];
  for await (const [name, h] of (samples as unknown as Entries).entries()) {
    if (h.kind === 'file' && !keep.has(name)) stale.push(name);
  }
  for (const name of stale) await samples.removeEntry(name);
}

/**
 * Read project.json (parsed, NOT validated: see schema.ts `validate`) and
 * every file in samples/ ("samples/<name>" -> bytes). Throws an Error with a
 * plain-words message if the folder has no readable project.
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
  let samples: FileSystemDirectoryHandle | null = null;
  try {
    samples = await dir.getDirectoryHandle(SAMPLES_DIR);
  } catch { /* no samples */ }
  if (samples) {
    for await (const [name, h] of (samples as unknown as Entries).entries()) {
      if (h.kind === 'file') files.set(`${SAMPLES_DIR}/${name}`, await readBytes(h as FileSystemFileHandle));
    }
  }
  return { json, files };
}
