// The library folder's directory handle, remembered across sessions.
//
// File System Access handles can be stored in IndexedDB (structured clone)
// but not in localStorage, so the choice lives in IndexedDB "daw-library",
// store "library", key "current": { kind: 'folder', handle }. (Older
// versions could store { kind: 'starter' }; the starter kit is always in the
// Browser now, so that reads as nothing chosen.)
//
// Permission: a stored handle usually comes back as 'prompt' after a browser
// restart. queryPermission() never shows UI, so start-up uses it and, if
// it is not 'granted', the Browser offers "Reconnect folder", whose click
// (a user gesture, which Chrome requires) calls requestPermission().
// Handles without these methods (OPFS in some engines, test fakes) count as
// granted.

export type StoredLibrary = { kind: 'folder'; handle: FileSystemDirectoryHandle };

type PermissionMode = { mode: 'read' | 'readwrite' };
type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: PermissionMode) => Promise<PermissionState>;
  requestPermission?: (d: PermissionMode) => Promise<PermissionState>;
};

const RW: PermissionMode = { mode: 'readwrite' };

export async function queryAccess(h: FileSystemDirectoryHandle): Promise<PermissionState> {
  const q = (h as PermissionHandle).queryPermission;
  if (typeof q !== 'function') return 'granted';
  try {
    return await q.call(h, RW);
  } catch {
    return 'prompt';
  }
}

/** Needs a user gesture (a click). Resolves 'denied' instead of throwing. */
export async function requestAccess(h: FileSystemDirectoryHandle): Promise<PermissionState> {
  const r = (h as PermissionHandle).requestPermission;
  if (typeof r !== 'function') return 'granted';
  try {
    return await r.call(h, RW);
  } catch {
    return 'denied';
  }
}

/**
 * The error means the folder is out of reach (permission revoked, folder or
 * file moved or deleted, handle no longer valid) rather than a bad file:
 * the Browser shows "Reconnect folder" instead of an error.
 */
export function isAccessLost(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'NotAllowedError' || name === 'NotFoundError' || name === 'SecurityError' || name === 'InvalidStateError';
}

/** Ask the user for a library folder (read/write). Null if they cancel. Needs a user gesture. */
export async function pickLibraryFolder(): Promise<FileSystemDirectoryHandle | null> {
  const pick = (window as unknown as { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  if (typeof pick !== 'function') throw new Error('this browser cannot open folders (use Chrome)');
  try {
    return await pick({ id: 'daw-library', mode: 'readwrite' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}

const DB = 'daw-library';
const STORE = 'library';
const KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

/** The IndexedDB-backed store used by the app (library.svelte.ts takes any). */
export const idbLibraryStore = {
  async load(): Promise<StoredLibrary | null> {
    const v = (await tx('readonly', (s) => s.get(KEY))) as StoredLibrary | undefined;
    return v && v.kind === 'folder' && v.handle ? v : null;
  },
  async save(v: StoredLibrary | null): Promise<void> {
    await (v ? tx('readwrite', (s) => s.put(v, KEY)) : tx('readwrite', (s) => s.delete(KEY)));
  },
};
