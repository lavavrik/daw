// Listing a library folder for the Browser pane (spec §4 "Library browser").
//
//   <library>/…/*.wav|aif|aiff|mp3|flac|ogg|m4a   samples, in any sub-folder
//   <library>/patches/*.json                       saved rack patches
//
// Lazily, one folder level at a time (plan 6 Task 5 review item 2): the root
// when the library opens, a sub-folder when the user expands it. A sample
// library can hold hundreds of thousands of files (and an Ableton .asd beside
// each sample); a whole-tree walk would be slow on every rescan and, capped,
// would cut the listing at an arbitrary point. Per level:
//   - hidden entries (".DS_Store", ".git/") and non-audio files are skipped
//     and never count toward the cap;
//   - folders and samples are each sorted by name (case-insensitive,
//     numeric) and each capped at `maxEntries` (2000), in that order; `more`
//     says how many were not shown;
//   - the root's patches/ is not a sample folder: listPatches() lists its
//     *.json files (not nested ones) for "Patches", eagerly.
// A folder is shown whether or not it holds audio (that would need a walk).
//
// Results hold names and '/'-joined paths relative to the library root,
// never handles: reads go back through the library (library.svelte.ts),
// which resolves a path from the root handle each time. Access errors
// (permission revoked, folder deleted) propagate to the caller, which turns
// them into "Reconnect folder".
import { AUDIO_EXT } from '../audio/samples';

export const PATCHES_DIR = 'patches';

export interface LibSample {
  /** File name, with extension ("kick.wav"). */
  name: string;
  /** Path from the library root ("drums/kick.wav"). */
  path: string;
}

export interface LibFolderRef {
  name: string;
  path: string;
}

/** One folder level. */
export interface LibListing {
  folders: LibFolderRef[];
  samples: LibSample[];
  /** Entries (folders + samples) beyond the cap, not shown. */
  more: number;
}

export interface LibPatch {
  /** File name without ".json": the name shown and loaded. */
  name: string;
  path: string;
}

/** The directory-handle surface a listing needs (OPFS, a picked folder, tests' FakeDir). */
type DirLike = {
  name: string;
  entries(): AsyncIterable<[string, { kind: string }]>;
  getDirectoryHandle(name: string): Promise<DirLike>;
};

export const MAX_LISTED = 2000;

export const isAudioName = (name: string): boolean => AUDIO_EXT.test(name);

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const byName = (a: string, b: string) => collator.compare(a, b);

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** The folder at `path` ('' = the root). Throws NotFoundError if it is gone. */
export async function folderAt(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
  let dir = root as unknown as DirLike;
  for (const p of path ? path.split('/') : []) dir = await dir.getDirectoryHandle(p);
  return dir as unknown as FileSystemDirectoryHandle;
}

export async function listFolder(
  root: FileSystemDirectoryHandle, path: string, opts: { maxEntries?: number } = {},
): Promise<LibListing> {
  const max = opts.maxEntries ?? MAX_LISTED;
  const dir = (await folderAt(root, path)) as unknown as DirLike;
  const folders: string[] = [];
  const samples: string[] = [];
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') {
      if (!(path === '' && name === PATCHES_DIR)) folders.push(name);
    } else if (isAudioName(name)) samples.push(name);
  }
  folders.sort(byName);
  samples.sort(byName);
  return {
    folders: folders.slice(0, max).map((name) => ({ name, path: join(path, name) })),
    samples: samples.slice(0, max).map((name) => ({ name, path: join(path, name) })),
    more: Math.max(0, folders.length - max) + Math.max(0, samples.length - max),
  };
}

/** patches/*.json at the library root, by name ([] when there is no patches/). */
export async function listPatches(root: FileSystemDirectoryHandle): Promise<LibPatch[]> {
  let dir: DirLike;
  try {
    dir = await (root as unknown as DirLike).getDirectoryHandle(PATCHES_DIR);
  } catch (e) {
    if ((e as { name?: string })?.name === 'NotFoundError' || (e as { name?: string })?.name === 'TypeMismatchError') return [];
    throw e;
  }
  const out: LibPatch[] = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'file' && !name.startsWith('.') && /\.json$/i.test(name)) {
      out.push({ name: name.replace(/\.json$/i, ''), path: `${PATCHES_DIR}/${name}` });
    }
  }
  return out.sort((a, b) => byName(a.name, b.name));
}

const MIME: Record<string, string> = {
  wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4',
};
/** The audio MIME type for a file name's extension ('' if unknown). */
export const audioMime = (name: string): string => MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? '';

/** A root listing for a fixed list of root-level files (the built-in starter kit). */
export function listingFromPaths(paths: string[]): LibListing {
  const samples = paths.filter(isAudioName).sort(byName).map((p) => ({ name: p, path: p }));
  return { folders: [], samples, more: 0 };
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
