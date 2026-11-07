import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Project } from '../state/project.svelte';
import { sampleFile } from '../state/sampleFiles';
import { MAX_ROWS, MAX_STEPS, MAX_TRACKS } from '../state/project.svelte';
import { addDrumTrack, addRow, setStepCount } from '../state/actions';
import { newPattern } from '../state/pattern-actions';
import { MAX_PATTERNS } from '../audio/protocol';
import {
  AUTOSAVE_DIR, AUTOSAVE_LOCK, AUTOSAVE_TMP, MARKER, OWNER_LOCK, claimAutosaveOwner, createAutosave, discardAutosave,
  lastExplicitSave, offersRestore, peekAutosave, readAutosave, withAutosaveLock, writeAutosave,
} from './autosave';
import type { LockManagerLike } from './autosave';
import { FakeDir, FakeLocks, asDir } from './fakeDir';
import { nullSink } from './testFixture';
import { buildFixture } from './testFixture';
import { serialize } from './serialize';

const root = () => new FakeDir('opfs');
const markerWrites = (d: FakeDir) => d.log.filter((l) => l.endsWith(`-> ${MARKER}`) || l === `write ${AUTOSAVE_DIR}/${MARKER}`);

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces to one write', async () => {
    const r = root();
    const { p } = await buildFixture();
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
    const { p } = await buildFixture();
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r), debounceMs: 5000, maxWaitMs: 30_000 });
    for (let i = 0; i < 40; i++) {
      a.markDirty();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(markerWrites(r)).toHaveLength(1);
  });

  it('flush writes now; nothing pending writes nothing', async () => {
    const r = root();
    const { p } = await buildFixture();
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
    const { p } = await buildFixture();
    const first = serialize(p);
    await writeAutosave(asDir(r), first, new Map([...p.sampleFiles].map(([id, f]) => [`samples/${id}-${f.hash}-${f.name}`, f.bytes])), 1000);
    const files1 = (await readAutosave(asDir(r)))!.files;

    // A new sample (the second write's first step) fails: the previous autosave is untouched.
    p.sampleFiles.set(5, await sampleFile('new.wav', 'audio/wav', new Uint8Array([9, 9, 9, 9]).buffer));
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
    const { p } = await buildFixture();
    await writeAutosave(asDir(r), serialize(p), new Map(), 1);
    expect(r.log).toEqual([`write ${AUTOSAVE_TMP}/${MARKER}`, `write ${AUTOSAVE_DIR}/${MARKER}`, `remove ${AUTOSAVE_TMP}/${MARKER}`]);
    expect((await readAutosave(asDir(r)))!.savedAt).toBe(1);
  });

  it('samples already written are reused by content hash', async () => {
    const r = root();
    const { p } = await buildFixture();
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
    p.sampleFiles.set(0, await sampleFile('big.wav', 'audio/wav', big));
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
    const { p } = await buildFixture();
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
    const { p } = await buildFixture();
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r), debounceMs: 100 });
    p.loading = true;
    a.markDirty();
    await vi.advanceTimersByTimeAsync(500);
    expect(r.log).toEqual([]);
    p.loading = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(markerWrites(r)).toHaveLength(1);
  });

  it('a failed write is reported once and retried', async () => {
    const r = root();
    const { p } = await buildFixture();
    const errors: (string | null)[] = [];
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r), debounceMs: 100, onError: (m) => errors.push(m) });
    r.failOn = MARKER;
    a.markDirty();
    await vi.advanceTimersByTimeAsync(200);
    a.markDirty();
    await vi.advanceTimersByTimeAsync(200);
    expect(errors).toEqual([expect.stringMatching(/^Autosave failed: disk full/)]);
    r.failOn = null;
    a.markDirty();
    await vi.advanceTimersByTimeAsync(60_000); // the retry, after the backoff
    expect(errors).toEqual([expect.stringMatching(/^Autosave failed: disk full/), null]);
    expect(markerWrites(r)).toHaveLength(1);
  });

  it('an edit during the successful retry write is still written afterwards (P7)', async () => {
    const r = root();
    const { p } = await buildFixture();
    let gate: Promise<void> | null = null;
    let release!: () => void;
    const a = createAutosave({
      getProject: () => p, debounceMs: 100,
      root: async () => {
        if (gate) await gate; // the retry write is in flight
        return asDir(r);
      },
    });
    r.failOn = MARKER;
    a.markDirty();
    await vi.advanceTimersByTimeAsync(150); // first write fails: retry in 100 ms (backoff)
    expect(markerWrites(r)).toHaveLength(0);
    r.failOn = null;
    gate = new Promise((res) => (release = res));
    await vi.advanceTimersByTimeAsync(150); // the retry starts and waits on the gate
    a.markDirty(); // an edit while backing off: no timer of its own
    release();
    gate = null;
    await vi.advanceTimersByTimeAsync(10);
    expect(markerWrites(r)).toHaveLength(1); // the retry (without that edit)
    await vi.advanceTimersByTimeAsync(500);
    expect(markerWrites(r)).toHaveLength(2); // ...and the edit, after the usual debounce
  });

  it('peek / discard / offersRestore', async () => {
    const r = root();
    expect(await peekAutosave(asDir(r))).toBeNull();
    const { p } = await buildFixture();
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

  it('failed writes back off (doubling up to 60 s) instead of rewriting on every edit (fix 2)', async () => {
    const r = root();
    const { p } = await buildFixture();
    let attempts = 0;
    const errors: (string | null)[] = [];
    const a = createAutosave({
      getProject: () => p, root: async () => (attempts++, asDir(r)), debounceMs: 5000, maxWaitMs: 30_000,
      onError: (m) => errors.push(m),
    });
    r.failOn = MARKER; // e.g. QuotaExceededError
    const times: number[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 300; i++) { // an edit every second for 5 minutes
      const before = attempts;
      a.markDirty();
      await vi.advanceTimersByTimeAsync(1000);
      if (attempts > before) times.push(Math.round((Date.now() - t0) / 1000));
    }
    // First the maxWait write (30 s), then retries 5, 10, 20, 40, 60, 60… s apart.
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(gaps.slice(0, 5)).toEqual([5, 10, 20, 40, 60]);
    expect(gaps.every((g) => g <= 60 && g >= 5)).toBe(true);
    expect(attempts).toBeLessThan(12);
    expect(errors).toHaveLength(1); // one banner, not repeated
    // Success resets the backoff: the next change writes after the usual debounce.
    r.failOn = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toEqual([expect.any(String), null]);
    const n = markerWrites(r).length;
    a.markDirty();
    await vi.advanceTimersByTimeAsync(5000);
    expect(markerWrites(r).length).toBe(n + 1);
  });

  it('an explicit save that missed later edits keeps them pending (fix 3)', async () => {
    const r = root();
    const { p } = await buildFixture();
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r), debounceMs: 100 });
    a.markDirty();
    a.savedExplicitly(1234, false); // an edit landed while the save was writing
    expect(lastExplicitSave()).toBe(null); // no localStorage in node: nothing recorded, no throw
    await vi.advanceTimersByTimeAsync(200);
    expect(markerWrites(r)).toHaveLength(1);
    a.markDirty();
    a.savedExplicitly(5678, true); // the save holds everything: nothing to autosave
    await vi.advanceTimersByTimeAsync(200);
    expect(markerWrites(r)).toHaveLength(1);
  });

  it('commit failure (the target marker write) and a failing sweep (fix 5)', async () => {
    const r = root();
    const { p } = await buildFixture();
    const first = serialize(p);
    const files = new Map([...p.sampleFiles].map(([id, f]) => [`samples/${id}-${f.hash}-${f.name}`, f.bytes]));
    await writeAutosave(asDir(r), first, files, 1);
    r.noMove = true;
    r.failOnPath = `${AUTOSAVE_DIR}/${MARKER}`;
    await expect(writeAutosave(asDir(r), { ...first, name: 'B' }, new Map(), 2)).rejects.toThrow(/disk full/);
    let back = (await readAutosave(asDir(r)))!;
    expect(back.json).toEqual(first);
    expect(back.files.size).toBe(3); // no sweep before a commit
    // The sweep cannot remove a file: the commit stands, the write succeeds.
    r.failOnPath = null;
    const [stale] = [...files.keys()];
    r.failRemove = stale.slice('samples/'.length);
    await writeAutosave(asDir(r), { ...first, name: 'C', samples: [] }, new Map(), 3);
    back = (await readAutosave(asDir(r)))!;
    expect(back.savedAt).toBe(3);
    expect((back.json as { name: string }).name).toBe('C');
  });

  it('two tabs: writes, reads and discards are serialized by the daw-autosave lock (fix 1)', async () => {
    const r = root();
    const locks = new FakeLocks();
    const { p: pa } = await buildFixture();
    const { p: pb } = await buildFixture();
    pb.sampleFiles.set(0, await sampleFile('other.wav', 'audio/wav', new Uint8Array([7, 7, 7, 7]).buffer));
    const a = createAutosave({ getProject: () => pa, root: async () => asDir(r), locks });
    const b = createAutosave({ getProject: () => pb, root: async () => asDir(r), locks });
    a.markDirty();
    b.markDirty();
    await Promise.all([a.flush(), b.flush()]);
    // No interleaving: one tab's whole write (ending with its commit) before the other's.
    const commits = r.log.map((l, i) => (l.startsWith('move') ? i : -1)).filter((i) => i >= 0);
    expect(commits).toHaveLength(2);
    expect(r.log.slice(0, commits[0] + 1).some((l) => l.includes('other.wav'))).toBe(false);
    expect(locks.requests.filter((n) => n === AUTOSAVE_LOCK)).toHaveLength(2);
    // The committed marker always has every sample it lists.
    const back = (await withAutosaveLock(locks, () => readAutosave(asDir(r))))!;
    expect(back.files.size).toBe((back.json as { samples: unknown[] }).samples.length);
    expect(locks.requests.filter((n) => n === AUTOSAVE_LOCK)).toHaveLength(3);
  });

  it('only the tab holding the owner lock autosaves (fix 1)', async () => {
    const locks = new FakeLocks();
    expect(await claimAutosaveOwner(locks)).toBe(true); // first tab: holds it for its lifetime
    expect(await claimAutosaveOwner(locks)).toBe(false); // second tab
    expect(locks.requests).toEqual([OWNER_LOCK, OWNER_LOCK]);
    expect(await claimAutosaveOwner(undefined)).toBe(true); // no Web Locks: assume alone
    const broken = { request: async () => { throw new Error('no'); } } as unknown as LockManagerLike;
    expect(await claimAutosaveOwner(broken)).toBe(true);
    // A disabled autosave (not the owner) never writes, even on flush.
    const r = root();
    const { p } = await buildFixture();
    const a = createAutosave({ getProject: () => p, root: async () => asDir(r), debounceMs: 10 });
    a.disable();
    a.hold(false);
    a.markDirty();
    await vi.advanceTimersByTimeAsync(100);
    await a.flush();
    expect(r.log).toEqual([]);
  });

  it('serialize + stringify of a maximal project stays well inside a frame budget (fix 7)', async () => {
    vi.useRealTimers();
    const p = new Project();
    for (let t = 0; t < MAX_TRACKS; t++) {
      const d = addDrumTrack(p, nullSink)!;
      while (d.rows.length < MAX_ROWS) addRow(p, nullSink, d.id);
      while (d.patterns.length < MAX_PATTERNS) newPattern(p, nullSink, d.id);
      setStepCount(p, nullSink, d.id, 64);
      for (const pat of d.patterns) {
        pat.stepCount = MAX_STEPS;
        for (const row of pat.steps) row.fill(100);
      }
    }
    serialize(p); // warm up
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      JSON.stringify({ format: 1, savedAt: 0, project: serialize(p) });
      runs.push(performance.now() - t);
    }
    const ms = Math.min(...runs);
    console.log(`autosave snapshot of a maximal project (${MAX_TRACKS}x${MAX_PATTERNS} patterns, ${MAX_ROWS}x${MAX_STEPS} filled): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(250);
  });
});

