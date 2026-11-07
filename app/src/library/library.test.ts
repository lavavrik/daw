import { describe, expect, it } from 'vitest';
import { FakeDir, asDir } from '../project/fakeDir';
import { LibraryLostError, createLibrary } from './library.svelte';
import type { StoredLibrary } from './handles';

type Perm = 'granted' | 'prompt' | 'denied';

/** A library folder whose permission the test controls. */
function folder(perm: { query: Perm; request: Perm }) {
  const d = new FakeDir('Sounds') as FakeDir & {
    queryPermission?: () => Promise<Perm>;
    requestPermission?: () => Promise<Perm>;
    requests: number;
  };
  d.requests = 0;
  d.queryPermission = async () => perm.query;
  d.requestPermission = async () => (d.requests++, perm.request);
  d.put('kick.wav', [1, 2, 3]);
  return d;
}

function deps(stored: StoredLibrary | null = null, picked: FakeDir | null = null) {
  const saved: (StoredLibrary | null)[] = [];
  return {
    saved,
    deps: {
      store: { load: async () => stored, save: async (v: StoredLibrary | null) => void saved.push(v) },
      pick: async () => (picked ? asDir(picked) : null),
      starter: { name: 'Starter kit', files: [{ path: 'kick-deep.wav', url: '/s/kick-deep.wav' }] },
      fetchBytes: async (url: string) => (url === '/s/kick-deep.wav' ? new Uint8Array([9, 9]).buffer : Promise.reject(new Error('404'))),
    },
  };
}

describe('library (folder handle, permission, reconnect)', () => {
  it('nothing chosen yet: status none', async () => {
    const lib = createLibrary(deps().deps);
    await lib.init();
    expect(lib.state.status).toBe('none');
  });

  it('a stored folder with permission granted is scanned on start', async () => {
    const dir = folder({ query: 'granted', request: 'granted' });
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    expect(lib.state).toMatchObject({ status: 'ready', source: 'folder', name: 'Sounds', writable: true });
    expect(lib.state.listings['']!.samples.map((s) => s.name)).toEqual(['kick.wav']);
  });

  it('permission lost shows reconnect; Reconnect asks again and rescans', async () => {
    const perm = { query: 'prompt' as Perm, request: 'granted' as Perm };
    const dir = folder(perm);
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    expect(lib.state.status).toBe('lost');
    expect(lib.state.name).toBe('Sounds');
    expect(lib.state.listings).toEqual({});
    expect(dir.requests).toBe(0); // never prompts without a click
    await lib.reconnect();
    expect(dir.requests).toBe(1);
    expect(lib.state.status).toBe('ready');
  });

  it('Reconnect refused: stays lost, no throw', async () => {
    const dir = folder({ query: 'prompt', request: 'denied' });
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    await lib.reconnect();
    expect(lib.state.status).toBe('lost');
  });

  it('a deleted folder (NotFoundError on scan) is lost, not an error', async () => {
    const dir = folder({ query: 'granted', request: 'granted' });
    dir.entries = async function* () {
      throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
    } as FakeDir['entries'];
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    expect(lib.state.status).toBe('lost');
    expect(lib.state.message).toMatch(/moved or deleted/);
  });

  it('a read that hits a lost folder flips to lost and throws LibraryLostError (callers stay quiet)', async () => {
    const perm = { query: 'granted' as Perm, request: 'granted' as Perm };
    const dir = folder(perm);
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    const f = await lib.readSample('kick.wav');
    expect(f.name).toBe('kick.wav');
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    dir.files.delete('kick.wav');
    perm.query = 'denied'; // revoked in the browser's site settings
    await expect(lib.readSample('kick.wav')).rejects.toBeInstanceOf(LibraryLostError);
    expect(lib.state.status).toBe('lost');
    // Further reads fail the same quiet way without touching the disk.
    await expect(lib.readSample('kick.wav')).rejects.toBeInstanceOf(LibraryLostError);
  });

  it('one file gone (folder fine): a plain error and a rescan, not lost', async () => {
    const dir = folder({ query: 'granted', request: 'granted' });
    dir.put('snare.wav', [4]);
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    dir.files.delete('kick.wav');
    const err = await lib.readSample('kick.wav').catch((e) => e);
    expect(err).not.toBeInstanceOf(LibraryLostError);
    expect(String(err)).toMatch(/no longer in the library/);
    expect(lib.state.status).toBe('ready');
    await new Promise((r) => setTimeout(r, 0));
    expect(lib.state.listings['']!.samples.map((s) => s.name)).toEqual(['snare.wav']);
  });

  it('choose stores the handle; cancel changes nothing', async () => {
    const dir = folder({ query: 'granted', request: 'granted' });
    const none = deps();
    const lib0 = createLibrary(none.deps);
    await lib0.choose();
    expect(lib0.state.status).toBe('none');
    expect(none.saved).toEqual([]);
    const d = deps(null, dir);
    const lib = createLibrary(d.deps);
    await lib.choose();
    expect(lib.state.status).toBe('ready');
    expect(d.saved).toEqual([{ kind: 'folder', handle: asDir(dir) }]);
  });

  it('the starter kit is read-only and reads through fetch', async () => {
    const d = deps();
    const lib = createLibrary(d.deps);
    await lib.useStarter();
    expect(lib.state).toMatchObject({ status: 'ready', source: 'starter', name: 'Starter kit', writable: false });
    expect(d.saved).toEqual([{ kind: 'starter' }]);
    const f = await lib.readSample('kick-deep.wav');
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
    await expect(lib.savePatch('X', { name: 'X', modules: [], cables: [] })).rejects.toThrow(/library folder/);
  });

  it('savePatch writes patches/<name>.json, refuses to overwrite unless asked, and lists it', async () => {
    const dir = folder({ query: 'granted', request: 'granted' });
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    const patch = { name: 'Acid', modules: [{ idx: 0, id: 'out' }], cables: [] };
    expect(await lib.savePatch('Acid', patch)).toBe('saved');
    expect(lib.state.patches).toEqual([{ name: 'Acid', path: 'patches/Acid.json' }]);
    expect(await lib.readPatch('patches/Acid.json')).toEqual(patch);
    expect(await lib.savePatch('Acid', { ...patch, modules: [] })).toBe('exists');
    expect(await lib.readPatch('patches/Acid.json')).toEqual(patch);
    expect(await lib.savePatch('Acid', { ...patch, modules: [] }, { replace: true })).toBe('saved');
    expect(await lib.readPatch('patches/Acid.json')).toEqual({ ...patch, modules: [] });
  });

  it('readPatch of invalid JSON throws a plain error (not lost)', async () => {
    const dir = folder({ query: 'granted', request: 'granted' });
    const p = new FakeDir('patches', dir);
    dir.files.set('patches', p);
    p.put('Bad.json', '{ nope');
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    await expect(lib.readPatch('patches/Bad.json')).rejects.toThrow(/not valid JSON/);
    expect(lib.state.status).toBe('ready');
  });

  it('folders are listed when expanded; collapse forgets them and what was open inside', async () => {
    const dir = folder({ query: 'granted', request: 'granted' });
    const drums = new FakeDir('drums', dir);
    dir.files.set('drums', drums);
    drums.put('snare.wav', [1]);
    const deep = new FakeDir('909', drums);
    drums.files.set('909', deep);
    deep.put('clap.wav', [1]);
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    expect(Object.keys(lib.state.listings)).toEqual(['']);
    expect(lib.state.listings['']!.folders).toEqual([{ name: 'drums', path: 'drums' }]);
    await lib.expand('drums');
    await lib.expand('drums/909');
    expect(lib.state.listings['drums/909']!.samples.map((s) => s.path)).toEqual(['drums/909/clap.wav']);
    lib.collapse('drums');
    expect(Object.keys(lib.state.listings)).toEqual(['']);
  });

  it('refresh re-lists only the root, the open folders and patches/', async () => {
    const dir = folder({ query: 'granted', request: 'granted' });
    const listed: string[] = [];
    const spy = (d: FakeDir) => {
      const orig = d.entries.bind(d);
      d.entries = (() => (listed.push(d.name), orig())) as FakeDir['entries'];
    };
    for (const n of ['a', 'b']) {
      const d = new FakeDir(n, dir);
      dir.files.set(n, d);
      d.put('x.wav', [1]);
      spy(d);
    }
    spy(dir);
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    await lib.expand('a');
    listed.length = 0;
    const stamp = lib.state.stamp;
    await lib.refresh();
    expect(listed.sort()).toEqual(['Sounds', 'a']); // never the closed folder b
    expect(lib.state.stamp).toBeGreaterThan(stamp);
  });

  it('an open folder deleted meanwhile is dropped on refresh (the library stays)', async () => {
    const dir = folder({ query: 'granted', request: 'granted' });
    const d = new FakeDir('old', dir);
    dir.files.set('old', d);
    d.put('x.wav', [1]);
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    await lib.expand('old');
    dir.files.delete('old');
    await lib.refresh();
    expect(lib.state.status).toBe('ready');
    expect(Object.keys(lib.state.listings)).toEqual(['']);
    expect(lib.state.listings['']!.folders).toEqual([]);
  });

  it('sampleBlob hands the disk file to the preview without reading it', async () => {
    const dir = folder({ query: 'granted', request: 'granted' });
    const lib = createLibrary(deps({ kind: 'folder', handle: asDir(dir) }).deps);
    await lib.init();
    const f = await lib.sampleBlob('kick.wav');
    expect(f.size).toBe(3);
  });
});
