import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Project } from '../state/project.svelte';
import { sampleFile } from '../state/sampleFiles';
import {
  AUTOSAVE_DIR, AUTOSAVE_TMP, MARKER, createAutosave, discardAutosave, offersRestore, peekAutosave, readAutosave,
  writeAutosave,
} from './autosave';
import { FakeDir, asDir } from './fakeDir';
import { buildFixture } from './testFixture';
import { serialize } from './serialize';

const root = () => new FakeDir('opfs');
const markerWrites = (d: FakeDir) => d.log.filter((l) => l.endsWith(`-> ${MARKER}`) || l === `write ${AUTOSAVE_DIR}/${MARKER}`);

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces to one write', async () => {
    const r = root();
    const { p } = buildFixture();
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r), debounceMs: 5000 });
    for (let i = 0; i < 5; i++) {
      a.markDirty();
      await vi.advanceTimersByTimeAsync(1000); // edits 1 s apart: never 5 s quiet
    }
    expect(markerWrites(r)).toEqual([]);
    expect(a.lastSaved).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(markerWrites(r)).toHaveLength(1);
    expect(a.lastSaved).not.toBeNull();
    await vi.advanceTimersByTimeAsync(20_000); // nothing new: no more writes
    expect(markerWrites(r)).toHaveLength(1);
    expect((await readAutosave(asDir(r)))!.json).toEqual(serialize(p));
  });

  it('heavy editing still writes after maxWaitMs', async () => {
    const r = root();
    const { p } = buildFixture();
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r), debounceMs: 5000, maxWaitMs: 30_000 });
    for (let i = 0; i < 40; i++) {
      a.markDirty();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(markerWrites(r)).toHaveLength(1);
  });

  it('flush writes now; nothing pending writes nothing', async () => {
    const r = root();
    const { p } = buildFixture();
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r) });
    await a.flush();
    expect(r.log).toEqual([]);
    a.markDirty();
    await a.flush();
    expect(markerWrites(r)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000); // the debounce timer was cleared
    expect(markerWrites(r)).toHaveLength(1);
  });

  it('autosave is atomic', async () => {
    const r = root();
    const { p } = buildFixture();
    const first = serialize(p);
    await writeAutosave(asDir(r), first, new Map([...p.sampleFiles].map(([id, f]) => [`samples/${id}-${f.hash}-${f.name}`, f.bytes])), 1000);
    const files1 = (await readAutosave(asDir(r)))!.files;

    // A new sample (the second write's first step) fails: the previous autosave is untouched.
    p.sampleFiles.set(5, sampleFile('new.wav', 'audio/wav', new Uint8Array([9, 9, 9, 9]).buffer));
    const newFile = `5-${p.sampleFiles.get(5)!.hash}-new.wav`;
    const second = { ...serialize(p), name: 'Second', samples: [{ id: 5, name: 'new.wav', type: 'audio/wav', file: `samples/${newFile}` }] };
    const files2 = new Map([[`samples/${newFile}`, p.sampleFiles.get(5)!.bytes]]);
    r.failOn = newFile;
    await expect(writeAutosave(asDir(r), second, files2, 2000)).rejects.toThrow(/disk full/);
    let back = (await readAutosave(asDir(r)))!;
    expect(back.json).toEqual(first);
    expect(back.savedAt).toBe(1000);
    expect([...back.files.keys()]).toEqual([...files1.keys()]);

    // Interrupted while writing the new marker in autosave.tmp/: still the previous one.
    r.failOn = MARKER;
    await expect(writeAutosave(asDir(r), second, files2, 2000)).rejects.toThrow(/disk full/);
    back = (await readAutosave(asDir(r)))!;
    expect(back.json).toEqual(first);
    expect(back.files.size).toBe(files1.size);

    // A stale autosave.tmp/ (left by a crash) is never read, and the next write succeeds.
    r.failOn = null;
    (await r.getDirectoryHandle(AUTOSAVE_TMP)).put(MARKER, '{"half":');
    expect((await readAutosave(asDir(r)))!.json).toEqual(first);
    r.log = [];
    await writeAutosave(asDir(r), second, files2, 2000);
    // The sample the interrupted attempt completed is reused; the marker is
    // written in autosave.tmp/ and moved into autosave/ last (then the sweep).
    const steps = r.log.filter((l) => !l.startsWith('remove'));
    expect(steps).toEqual([`write ${AUTOSAVE_TMP}/${MARKER}`, `move ${MARKER} -> ${MARKER}`]);
    back = (await readAutosave(asDir(r)))!;
    expect(back.json).toEqual(second);
    expect(back.savedAt).toBe(2000);
    // Samples the new autosave does not list are swept only after the swap.
    expect([...back.files.keys()]).toEqual([`samples/${newFile}`]);
    const pool = await (await r.getDirectoryHandle(AUTOSAVE_DIR)).getDirectoryHandle('samples');
    expect([...pool.files.keys()]).toEqual([newFile]);
  });

  it('without move, the marker is replaced by a whole-file write (atomic on close)', async () => {
    const r = root();
    r.noMove = true;
    const { p } = buildFixture();
    await writeAutosave(asDir(r), serialize(p), new Map(), 1);
    expect(r.log).toEqual([`write ${AUTOSAVE_TMP}/${MARKER}`, `write ${AUTOSAVE_DIR}/${MARKER}`, `remove ${AUTOSAVE_TMP}/${MARKER}`]);
    expect((await readAutosave(asDir(r)))!.savedAt).toBe(1);
  });

  it('samples already written are reused by content hash', async () => {
    const r = root();
    const { p } = buildFixture();
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r) });
    a.markDirty();
    await a.flush();
    const sampleWrites = () => r.log.filter((l) => l.startsWith(`write ${AUTOSAVE_DIR}/samples/`));
    expect(sampleWrites()).toHaveLength(3);
    // Order: every sample, then the marker in autosave.tmp/, moved into autosave/ last.
    expect(r.log.slice(3)).toEqual([`write ${AUTOSAVE_TMP}/${MARKER}`, `move ${MARKER} -> ${MARKER}`]);
    r.log = [];
    p.tempo = 99;
    a.markDirty();
    await a.flush();
    expect(sampleWrites()).toEqual([]);
    expect(markerWrites(r)).toHaveLength(1);
  });

  it('large samples are written in chunks (never one long blocking write)', async () => {
    const r = root();
    const p = new Project();
    const big = new Uint8Array(3 * 1024 * 1024 + 5).buffer;
    p.sampleFiles.set(0, sampleFile('big.wav', 'audio/wav', big));
    const json = serialize(p);
    const file = `samples/0-${p.sampleFiles.get(0)!.hash}-big.wav`;
    r.chunks = 0;
    await writeAutosave(asDir(r), json, new Map([[file, big]]), 1, { chunkBytes: 1024 * 1024 });
    expect(r.chunks).toBeGreaterThanOrEqual(4); // 4 sample chunks (+ the marker)
    const pool = await (await r.getDirectoryHandle(AUTOSAVE_DIR)).getDirectoryHandle('samples');
    expect((await (await pool.getFileHandle(file.slice(8))).getFile()).size).toBe(big.byteLength);
  });

  it('a held autosave writes nothing until released; cancel drops a pending write', async () => {
    const r = root();
    const { p } = buildFixture();
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r), debounceMs: 100 });
    a.hold(true);
    a.markDirty();
    await vi.advanceTimersByTimeAsync(1000);
    await a.flush();
    expect(r.log).toEqual([]);
    a.hold(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(markerWrites(r)).toHaveLength(1);
    a.markDirty();
    a.cancel(); // an explicit save just made this moot
    await vi.advanceTimersByTimeAsync(1000);
    expect(markerWrites(r)).toHaveLength(1);
  });

  it('never writes while a project loads (it retries after)', async () => {
    const r = root();
    const { p } = buildFixture();
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r), debounceMs: 100 });
    p.loading = true;
    a.markDirty();
    await vi.advanceTimersByTimeAsync(500);
    expect(r.log).toEqual([]);
    p.loading = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(markerWrites(r)).toHaveLength(1);
  });

  it('a failed write is reported once and retried on the next change', async () => {
    const r = root();
    const { p } = buildFixture();
    const errors: (string | null)[] = [];
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r), debounceMs: 100, onError: (m) => errors.push(m) });
    r.failOn = MARKER;
    a.markDirty();
    await vi.advanceTimersByTimeAsync(200);
    a.markDirty();
    await vi.advanceTimersByTimeAsync(200);
    expect(errors).toEqual([expect.stringMatching(/disk full/)]);
    r.failOn = null;
    a.markDirty();
    await vi.advanceTimersByTimeAsync(200);
    expect(errors).toEqual([expect.stringMatching(/disk full/), null]);
    expect(markerWrites(r)).toHaveLength(1);
  });

  it('peek / discard / offersRestore', async () => {
    const r = root();
    expect(await peekAutosave(asDir(r))).toBeNull();
    const { p } = buildFixture();
    await writeAutosave(asDir(r), serialize(p), new Map(), 5000);
    expect(await peekAutosave(asDir(r))).toEqual({ savedAt: 5000, name: 'Fixture' });
    expect(offersRestore({ savedAt: 5000, name: 'x' }, null)).toBe(true);
    expect(offersRestore({ savedAt: 5000, name: 'x' }, 4000)).toBe(true);
    expect(offersRestore({ savedAt: 5000, name: 'x' }, 6000)).toBe(false);
    expect(offersRestore(null, null)).toBe(false);
    await discardAutosave(asDir(r));
    expect(await peekAutosave(asDir(r))).toBeNull();
    expect(r.files.has(AUTOSAVE_DIR)).toBe(false);
    await discardAutosave(asDir(r)); // nothing there: fine
  });

  it('a corrupt or foreign marker reads as no autosave', async () => {
    const r = root();
    (await r.getDirectoryHandle(AUTOSAVE_DIR, { create: true })).put(MARKER, '');
    expect(await peekAutosave(asDir(r))).toBeNull();
    expect(await readAutosave(asDir(r))).toBeNull();
    (await r.getDirectoryHandle(AUTOSAVE_DIR)).put(MARKER, '{"format":99,"savedAt":1,"project":{}}');
    expect(await readAutosave(asDir(r))).toBeNull();
  });
});
