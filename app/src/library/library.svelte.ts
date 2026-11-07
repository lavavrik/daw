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
//   loading  scanning;
//   ready    `tree` is the current listing;
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
// deleted or renamed) rescans and throws an ordinary error instead.
import { writeFile } from '../project/fsFolder';
import type { Patch } from '../state/patches';
import { idbLibraryStore, isAccessLost, pickLibraryFolder, queryAccess, requestAccess } from './handles';
import type { StoredLibrary } from './handles';
import { PATCHES_DIR, patchFileName, scanLibrary, treeFromPaths } from './scan';
import type { LibraryTree } from './scan';
import { STARTER_KIT, fetchBytes } from './starter';
import type { StarterKit } from './starter';

export type LibraryStatus = 'none' | 'loading' | 'ready' | 'lost';

export interface LibraryState {
  status: LibraryStatus;
  source: 'folder' | 'starter' | null;
  /** Folder name (or "Starter kit"), also while lost. */
  name: string;
  tree: LibraryTree | null;
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
  /** Rescan (Browser ↻, and when the tab becomes visible again: a revoked permission shows then). */
  refresh(): Promise<void>;
  readSample(path: string): Promise<File>;
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
  const state = $state<LibraryState>({ status: 'none', source: null, name: '', tree: null, message: null, writable: false });
  let handle: FileSystemDirectoryHandle | null = null;
  /** Bumped by every change of library: a scan for an older one is dropped. */
  let gen = 0;

  function set(s: Partial<LibraryState>) {
    Object.assign(state, s);
    state.writable = state.source === 'folder' && state.status === 'ready';
  }

  function lose(why: keyof typeof lostText) {
    set({ status: 'lost', tree: null, message: lostText[why](state.name) });
  }

  async function scan(g: number) {
    if (!handle) return;
    const h = handle;
    try {
      const tree = await scanLibrary(h);
      if (g === gen) set({ status: 'ready', tree, message: null });
    } catch (e) {
      if (g !== gen) return;
      if (!isAccessLost(e)) console.warn('Library scan failed', e);
      lose('missing');
    }
  }

  async function attach(h: FileSystemDirectoryHandle, persist = false) {
    const g = ++gen;
    handle = h;
    set({ source: 'folder', name: h.name, status: 'loading', tree: null, message: null });
    if (persist) await deps.store.save({ kind: 'folder', handle: h }).catch((e) => console.warn('Could not remember the library folder', e));
    if ((await queryAccess(h)) !== 'granted') {
      if (g === gen) lose('permission');
      return;
    }
    await scan(g);
  }

  async function useStarter() {
    ++gen;
    handle = null;
    set({
      source: 'starter', name: deps.starter.name, status: 'ready', message: null,
      tree: treeFromPaths(deps.starter.name, deps.starter.files.map((f) => f.path)),
    });
    await deps.store.save({ kind: 'starter' }).catch((e) => console.warn('Could not remember the library choice', e));
  }

  /**
   * Run a folder operation; an access failure turns into `lost` +
   * LibraryLostError (or, if only that file is gone, a rescan + `missing`).
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
        void scan(g);
        throw missing();
      }
      if (g === gen) lose('missing');
      throw new LibraryLostError(state.message ?? 'The library folder is out of reach');
    }
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
      await scan(g);
    },
    async refresh() {
      if (state.source !== 'folder' || !handle) return;
      const g = gen;
      if ((await queryAccess(handle)) !== 'granted') {
        if (g === gen) lose('permission');
        return;
      }
      await scan(g);
    },
    async readSample(path) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (state.source === 'starter') {
        const f = deps.starter.files.find((x) => x.path === path);
        if (!f) throw new Error(`"${name}" is not in the starter kit`);
        return new File([await deps.fetchBytes(f.url)], name, { type: mimeOf(name) });
      }
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
      if (r === 'saved') await scan(g);
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
