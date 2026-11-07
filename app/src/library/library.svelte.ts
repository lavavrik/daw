// The sample + patch library shown in the Browser pane (spec §4 "Library
// browser"; plan 6 Task 5).
//
// Sources:
//   - a folder the user picks once (Choose library folder…), remembered in
//     IndexedDB (handles.ts) and read/written through the File System
//     Access API: samples anywhere in it, patches in patches/*.json;
//   - the bundled starter kit (Use starter kit), read-only via fetch().
//
// Status:
//   none     nothing chosen yet;
//   loading  listing the root;
//   ready    `listings` holds the root ('') and every expanded folder, one
//            level each (scan.ts: lazy, per-folder cap); `patches` the
//            patches/*.json files. A refresh re-lists only those;
//   lost     the folder is out of reach: permission not granted (the usual
//            state after a browser restart: queryPermission says 'prompt'),
//            revoked, or the folder was moved/deleted. The Browser shows
//            "Reconnect folder" (requestPermission needs that click).
//
// Plan 6 review focus 4 (no error spam): every access failure, from a scan,
// a preview, a drag or a patch save, lands here as ONE state change to
// `lost` with one message in the Browser pane. Reads that fail that way
// throw LibraryLostError, which callers do not report again.
//
// Reads go back to the root handle by path each time (no stale per-file
// handles). A read that fails while the root is still fine (one file was
// deleted or renamed) re-lists and throws an ordinary error instead; an
// expanded folder that is gone is simply dropped from `listings`.
import { writeFile } from '../project/fsFolder';
import type { Patch } from '../state/patches';
import { idbLibraryStore, isAccessLost, pickLibraryFolder, queryAccess, requestAccess } from './handles';
import type { StoredLibrary } from './handles';
import { PATCHES_DIR, listFolder, listPatches, listingFromPaths, patchFileName } from './scan';
import type { LibListing, LibPatch } from './scan';
import { STARTER_KIT, fetchBytes } from './starter';
import type { StarterKit } from './starter';

export type LibraryStatus = 'none' | 'loading' | 'ready' | 'lost';

export interface LibraryState {
  status: LibraryStatus;
  source: 'folder' | 'starter' | null;
  /** Folder name (or "Starter kit"), also while lost. */
  name: string;
  /** Listed folders by path: '' (the root) and every expanded folder. Empty unless ready. */
  listings: Record<string, LibListing>;
  /** patches/*.json (folder libraries only). */
  patches: LibPatch[];
  /** Bumped by every (re)listing: files at the same paths may have changed. */
  stamp: number;
  /** Why the library is lost (shown in the Browser), else null. */
  message: string | null;
  /** Patches can be saved (a reachable folder; never the starter kit). */
  writable: boolean;
}

/** The library folder is out of reach; the Browser already says so (no banner). */
export class LibraryLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryLostError';
  }
}

export interface LibraryDeps {
  store: { load(): Promise<StoredLibrary | null>; save(v: StoredLibrary | null): Promise<void> };
  pick: () => Promise<FileSystemDirectoryHandle | null>;
  starter: StarterKit;
  fetchBytes: (url: string) => Promise<ArrayBuffer>;
}

export interface Library {
  readonly state: LibraryState;
  /** On start: restore the stored choice (never prompts). */
  init(): Promise<void>;
  /** Choose library folder… (user gesture). Cancel keeps the current library. */
  choose(): Promise<void>;
  useStarter(): Promise<void>;
  /** Use `handle` as the library, as start-up would (e2e: OPFS); `persist` also remembers it. */
  attach(handle: FileSystemDirectoryHandle, persist?: boolean): Promise<void>;
  /** "Reconnect folder" (user gesture): ask for permission again, then rescan. */
  reconnect(): Promise<void>;
  /**
   * Re-list the root, the expanded folders and patches/ (Browser ↻, and when
   * the tab becomes visible again: a revoked permission shows then).
   */
  refresh(): Promise<void>;
  /** List one more folder level (the Browser expanded it). */
  expand(path: string): Promise<void>;
  /** Forget `path`'s listing and those of the folders open inside it. */
  collapse(path: string): void;
  /** The file's bytes, copied into memory (to import into the project). */
  readSample(path: string): Promise<File>;
  /** The file itself, not read (a preview decides by size whether to read or stream it). */
  sampleBlob(path: string): Promise<Blob>;
  /** Parsed JSON of a patch file (validate it before use). */
  readPatch(path: string): Promise<unknown>;
  /**
   * Write patches/<name>.json. 'exists' (nothing written) when that file is
   * there and `replace` is not set. Throws if the library is not writable.
   */
  savePatch(name: string, patch: Patch, opts?: { replace?: boolean }): Promise<'saved' | 'exists'>;
}

const lostText = {
  permission: (n: string) => `Allow access to "${n}" again to browse it.`,
  missing: (n: string) => `"${n}" can't be reached — it may have been moved or deleted, or access was revoked.`,
};

const MIME: Record<string, string> = {
  wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4',
};
const mimeOf = (name: string) => MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? '';

async function resolveFile(root: FileSystemDirectoryHandle, path: string, create = false): Promise<FileSystemFileHandle> {
  const parts = path.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

/** The root is still listable (a missing file vs. a missing folder). */
async function reachable(root: FileSystemDirectoryHandle): Promise<boolean> {
  if ((await queryAccess(root)) !== 'granted') return false;
  try {
    const it = (root as unknown as { entries(): AsyncIterator<unknown> }).entries();
    await it.next();
    return true;
  } catch {
    return false;
  }
}

export function createLibrary(deps: LibraryDeps): Library {
  const state = $state<LibraryState>({
    status: 'none', source: null, name: '', listings: {}, patches: [], stamp: 0, message: null, writable: false,
  });
  let handle: FileSystemDirectoryHandle | null = null;
  /** Bumped by every change of library: a listing for an older one is dropped. */
  let gen = 0;
  /** Expanded folder paths (what a refresh re-lists besides the root). */
  const open = new Set<string>();
  const inside = (path: string, p: string) => p === path || p.startsWith(`${path}/`);

  function set(s: Partial<LibraryState>) {
    Object.assign(state, s);
    state.writable = state.source === 'folder' && state.status === 'ready';
  }

  function lose(why: keyof typeof lostText) {
    open.clear();
    set({ status: 'lost', listings: {}, patches: [], message: lostText[why](state.name) });
  }

  /**
   * List the root, patches/ and every expanded folder. The root failing
   * means the library is lost; an expanded folder failing (moved, deleted)
   * just closes it.
   */
  async function relist(g: number) {
    if (!handle) return;
    const h = handle;
    try {
      const [root, patches] = await Promise.all([listFolder(h, ''), listPatches(h)]);
      const listings: Record<string, LibListing> = { '': root };
      for (const path of [...open]) {
        try {
          listings[path] = await listFolder(h, path);
        } catch (e) {
          if (!isAccessLost(e)) console.warn(`Library: could not list "${path}"`, e);
          for (const p of [...open]) if (inside(path, p)) open.delete(p);
        }
      }
      for (const p of Object.keys(listings)) if (p && !open.has(p)) delete listings[p];
      if (g === gen) set({ status: 'ready', listings, patches, stamp: state.stamp + 1, message: null });
    } catch (e) {
      if (g !== gen) return;
      if (!isAccessLost(e)) console.warn('Library listing failed', e);
      lose('missing');
    }
  }

  async function attach(h: FileSystemDirectoryHandle, persist = false) {
    const g = ++gen;
    handle = h;
    open.clear();
    set({ source: 'folder', name: h.name, status: 'loading', listings: {}, patches: [], message: null });
    if (persist) await deps.store.save({ kind: 'folder', handle: h }).catch((e) => console.warn('Could not remember the library folder', e));
    if ((await queryAccess(h)) !== 'granted') {
      if (g === gen) lose('permission');
      return;
    }
    await relist(g);
  }

  async function useStarter() {
    ++gen;
    handle = null;
    open.clear();
    set({
      source: 'starter', name: deps.starter.name, status: 'ready', message: null, patches: [], stamp: state.stamp + 1,
      listings: { '': listingFromPaths(deps.starter.files.map((f) => f.path)) },
    });
    await deps.store.save({ kind: 'starter' }).catch((e) => console.warn('Could not remember the library choice', e));
  }

  /**
   * Run a folder operation; an access failure turns into `lost` +
   * LibraryLostError (or, if only that file is gone, a re-list + `missing`).
   */
  async function guarded<T>(fn: (root: FileSystemDirectoryHandle) => Promise<T>, missing?: () => Error): Promise<T> {
    const h = handle;
    if (state.source !== 'folder' || !h || state.status === 'lost') {
      throw new LibraryLostError(state.message ?? 'No library folder');
    }
    const g = gen;
    try {
      return await fn(h);
    } catch (e) {
      if (!isAccessLost(e)) throw e;
      if (missing && (await reachable(h))) {
        void relist(g);
        throw missing();
      }
      if (g === gen) lose('missing');
      throw new LibraryLostError(state.message ?? 'The library folder is out of reach');
    }
  }

  /** A starter-kit sample, fetched (small files, read-only). */
  async function starterFile(path: string): Promise<File> {
    const f = deps.starter.files.find((x) => x.path === path);
    if (!f) throw new Error(`"${path}" is not in the starter kit`);
    return new File([await deps.fetchBytes(f.url)], path, { type: mimeOf(path) });
  }

  return {
    state,
    async init() {
      let stored: StoredLibrary | null = null;
      try {
        stored = await deps.store.load();
      } catch (e) {
        console.warn('Could not read the stored library choice', e);
      }
      if (!stored || gen !== 0) return; // nothing stored, or the user already chose
      if (stored.kind === 'starter') await useStarter();
      else await attach(stored.handle);
    },
    async choose() {
      const h = await deps.pick();
      if (h) await attach(h, true);
    },
    useStarter,
    attach,
    async reconnect() {
      const h = handle;
      if (!h) return;
      const g = ++gen;
      if ((await requestAccess(h)) !== 'granted') {
        if (g === gen) lose('permission');
        return;
      }
      set({ status: 'loading', message: null });
      await relist(g);
    },
    async refresh() {
      if (state.source !== 'folder' || !handle) return;
      const g = gen;
      if ((await queryAccess(handle)) !== 'granted') {
        if (g === gen) lose('permission');
        return;
      }
      await relist(g);
    },
    async expand(path) {
      if (state.source !== 'folder' || state.status !== 'ready' || open.has(path)) return;
      open.add(path);
      const g = gen;
      const name = path.slice(path.lastIndexOf('/') + 1);
      let l: LibListing;
      try {
        l = await guarded((root) => listFolder(root, path), () => new Error(`"${name}" is no longer in the library folder`));
      } catch (e) {
        open.delete(path);
        throw e;
      }
      if (g === gen && open.has(path)) state.listings = { ...state.listings, [path]: l };
    },
    collapse(path) {
      for (const p of [...open]) if (inside(path, p)) open.delete(p);
      state.listings = Object.fromEntries(Object.entries(state.listings).filter(([p]) => !p || !inside(path, p)));
    },
    async sampleBlob(path) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (state.source === 'starter') return starterFile(path);
      return guarded(
        async (root) => (await resolveFile(root, path)).getFile(),
        () => new Error(`"${name}" is no longer in the library folder`),
      );
    },
    async readSample(path) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (state.source === 'starter') return starterFile(path);
      return guarded(
        async (root) => {
          const file = await (await resolveFile(root, path)).getFile();
          // Own copy of the bytes: the File may be invalidated if the disk file changes.
          return new File([await file.arrayBuffer()], name, { type: file.type || mimeOf(name) });
        },
        () => new Error(`"${name}" is no longer in the library folder`),
      );
    },
    async readPatch(path) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const text = await guarded(
        async (root) => (await (await resolveFile(root, path)).getFile()).text(),
        () => new Error(`"${name}" is no longer in the library folder`),
      );
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`"${name}" is not valid JSON`);
      }
    },
    async savePatch(name, patch, opts = {}) {
      if (!state.writable) throw new Error('Choose a library folder to save patches');
      const file = patchFileName(name);
      if (!file) throw new Error('Give the patch a name');
      const g = gen;
      const r = await guarded(async (root) => {
        const dir = await root.getDirectoryHandle(PATCHES_DIR, { create: true });
        if (!opts.replace) {
          const exists = await dir.getFileHandle(file).then(() => true, () => false);
          if (exists) return 'exists' as const;
        }
        await writeFile(dir, file, `${JSON.stringify(patch, null, 2)}\n`);
        return 'saved' as const;
      });
      if (r === 'saved' && handle) {
        try {
          const patches = await listPatches(handle);
          if (g === gen) state.patches = patches;
        } catch { /* the next refresh shows it (or the loss) */ }
      }
      return r;
    },
  };
}

/** The app's library: IndexedDB-remembered folder, the real picker, the bundled kit. */
export const library: Library = createLibrary({
  store: idbLibraryStore,
  pick: pickLibraryFolder,
  starter: STARTER_KIT,
  fetchBytes,
});
