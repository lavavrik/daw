// Listing a library folder for the Browser pane (spec §4 "Library browser").
//
//   <library>/…/*.wav|aif|aiff|mp3|flac|ogg|m4a   samples, in any sub-folder
//   <library>/patches/*.json                       saved rack patches
//
// The tree holds names and '/'-joined paths relative to the library root,
// never handles: the Browser renders it, and reads go back through the
// library (library.svelte.ts), which resolves a path from the root handle
// each time (so a folder that vanished is noticed on the next read).
//
// Hidden entries (".DS_Store", ".git/") are skipped; folders with no audio
// anywhere below are pruned, so the tree only shows what can be used. The
// patches/ folder is not a sample folder: its *.json files (not nested ones)
// are listed under "Patches". The scan stops after `maxEntries` entries
// (`truncated` says so): pointing the library at a home folder by mistake
// must not hang the UI.
//
// Access errors (permission revoked, folder deleted) propagate to the
// caller, which turns them into "Reconnect folder" (library.svelte.ts).
import { AUDIO_EXT } from '../audio/samples';

export const PATCHES_DIR = 'patches';

export interface LibSample {
  /** File name, with extension ("kick.wav"). */
  name: string;
  /** Path from the library root ("drums/kick.wav"). */
  path: string;
}

export interface LibFolder {
  name: string;
  /** '' for the root. */
  path: string;
  folders: LibFolder[];
  samples: LibSample[];
}

export interface LibPatch {
  /** File name without ".json": the name shown and loaded. */
  name: string;
  path: string;
}

export interface LibraryTree {
  root: LibFolder;
  patches: LibPatch[];
  /** The scan stopped at the entry cap: some files are not listed. */
  truncated: boolean;
}

/** The directory-handle surface a scan needs (OPFS, a picked folder, tests' FakeDir). */
type DirLike = { name: string; entries(): AsyncIterable<[string, { kind: string }]> };

export const isAudioName = (name: string): boolean => AUDIO_EXT.test(name);

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export async function scanLibrary(
  root: FileSystemDirectoryHandle,
  opts: { maxEntries?: number; maxDepth?: number } = {},
): Promise<LibraryTree> {
  const maxEntries = opts.maxEntries ?? 5000;
  const maxDepth = opts.maxDepth ?? 8;
  let seen = 0;
  let truncated = false;
  const patches: LibPatch[] = [];

  async function walk(dir: DirLike, path: string, depth: number): Promise<LibFolder> {
    const folder: LibFolder = { name: dir.name, path, folders: [], samples: [] };
    for await (const [name, h] of dir.entries()) {
      if (++seen > maxEntries) {
        truncated = true;
        break;
      }
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') {
        if (depth === 0 && name === PATCHES_DIR) {
          await listPatches(h as unknown as DirLike);
          continue;
        }
        if (depth + 1 > maxDepth) {
          truncated = true;
          continue;
        }
        const sub = await walk(h as unknown as DirLike, join(path, name), depth + 1);
        if (sub.samples.length || sub.folders.length) folder.folders.push(sub);
      } else if (isAudioName(name)) {
        folder.samples.push({ name, path: join(path, name) });
      }
    }
    folder.folders.sort(byName);
    folder.samples.sort(byName);
    return folder;
  }

  async function listPatches(dir: DirLike) {
    for await (const [name, h] of dir.entries()) {
      if (++seen > maxEntries) {
        truncated = true;
        break;
      }
      if (h.kind === 'file' && !name.startsWith('.') && /\.json$/i.test(name)) {
        patches.push({ name: name.replace(/\.json$/i, ''), path: `${PATCHES_DIR}/${name}` });
      }
    }
  }

  const tree = await walk(root as unknown as DirLike, '', 0);
  patches.sort(byName);
  return { root: tree, patches, truncated };
}

/** A tree for a fixed list of root-level files (the bundled starter kit). */
export function treeFromPaths(name: string, paths: string[]): LibraryTree {
  const samples = paths.filter(isAudioName).map((p) => ({ name: p, path: p })).sort(byName);
  return { root: { name, path: '', folders: [], samples }, patches: [], truncated: false };
}

/**
 * "<name>.json" for a patch name typed by the user, safe on every OS: path
 * separators and reserved characters become spaces, runs of spaces collapse,
 * at most 64 characters. Null if nothing usable is left (empty, only dots).
 */
export function patchFileName(name: string): string | null {
  const clean = name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '') // a leading dot would make it hidden (the scan skips those)
    .slice(0, 64)
    .trim();
  if (!clean) return null;
  return `${clean}.json`;
}
