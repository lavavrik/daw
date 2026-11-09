// The built-in default kit (plan 8 Task 4): a fresh session's drum track is
// the starter kit's eight rows, filled asynchronously without marking the
// project dirty, bumping its version (autosave) or creating an undo entry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Err } from '../audio/protocol';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { FakeDir, asDir } from '../project/fakeDir';
import type { ProjectJson, SampleJson } from '../project/schema';
import { createProjectSession, markSaved } from '../project/session';
import type { SessionEngine } from '../project/session';
import { projectFingerprint, serialize } from '../project/serialize';
import { fakeAudio, fakeDecoder, fakeEngine } from '../project/testFixture';
import { toggleStep } from './actions';
import { commandEdits } from './edits';
import { markBusy, markIdle } from './idle';
import { DEFAULT_KIT, addDefaultDrumTrack, defaultKitRows, loadDefaultKit, withRowSample } from './defaultKit';
import type { KitDeps } from './defaultKit';
import { Project, currentPattern } from './project.svelte';
import type { DrumTrack } from './project.svelte';
import { installSampleLoads } from './sampleLoads';

const NAMES = ['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc'];
const FILES = ['kick-punch.wav', 'clap.wav', 'hat-closed.wav', 'hat-open.wav', 'snare.wav', 'rim.wav', 'shaker.wav', 'perc-tom.wav'];

/** A fresh session as App builds it: engine commands mark edits (onCommand), history installed. */
function fresh(o: { sampleCode?: (id: number) => number } = {}) {
  const p = new Project();
  const sent: number[][] = [];
  const engine = {
    sampleRate: 48000,
    context: fakeDecoder,
    send(op: number, a = 0, b = 0, c = 0, d = 0) {
      sent.push([op, a, b, c, d]);
      commandEdits(p, op); // App: e.onCommand
      return true;
    },
    loadSample: async (id: number) => (o.sampleCode ? o.sampleCode(id) : Err.OK),
    onSampleLoaded: undefined as ((id: number, code: number) => void) | undefined,
  };
  const t = addDefaultDrumTrack(p, engine)!;
  const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, engine, from, to) });
  p.history = h;
  h.clear();
  markSaved(p);
  const v0 = p.version;
  return { p, engine, t, h, v0, sent };
}

/** Fetches resolve when released (or at once); bytes encode the frame count. */
function deps(o: { fail?: string[]; hold?: boolean } = {}) {
  const errors: string[] = [];
  const waiting: (() => void)[] = [];
  const d: KitDeps = {
    fetchFile: (file) => {
      const go = () => {
        if (o.fail?.includes(file)) throw new Error('HTTP 404');
        return new File([fakeAudio(10 + FILES.indexOf(file))], file, { type: 'audio/wav' });
      };
      if (!o.hold) return Promise.resolve().then(go);
      return new Promise<File>((res, rej) => waiting.push(() => { try { res(go()); } catch (e) { rej(e); } }));
    },
    onError: (m) => errors.push(m),
  };
  return { d, errors, release: () => waiting.splice(0).forEach((f) => f()) };
}

const rowsOf = (p: Project) => (p.tracks[0] as DrumTrack).rows;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('default kit rows', () => {
  it('eight named rows in order, each with its starter-kit file', () => {
    expect(DEFAULT_KIT.map((k) => k.name)).toEqual(NAMES);
    expect(DEFAULT_KIT.map((k) => k.file)).toEqual(FILES);
    expect(defaultKitRows()).toEqual(DEFAULT_KIT);
  });

  it('a lower row cap keeps the first N', () => {
    expect(defaultKitRows(3).map((k) => k.name)).toEqual(['Kick', 'Clap', 'Closed hat']);
    expect(defaultKitRows(0)).toEqual([]);
  });

  it('the default drum track has those rows, empty, and no steps', () => {
    const { t } = fresh();
    expect(t.rows.map((r) => r.name)).toEqual(NAMES);
    expect(t.rows.every((r) => r.sampleId === null)).toBe(true);
    expect(currentPattern(t).steps.flat().every((v) => v === 0)).toBe(true);
  });
});

describe('loadDefaultKit', () => {
  it('fills every row through the import path: original bytes kept, not dirty, no version bump, no undo entry', async () => {
    const { p, t, h, v0, engine } = fresh();
    const { d, errors } = deps();
    await loadDefaultKit(p, engine, t.id, d);
    expect(errors).toEqual([]);
    expect(rowsOf(p).map((r) => r.name)).toEqual(NAMES);
    expect(rowsOf(p).map((r) => r.sampleId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // row order
    for (const [i, r] of rowsOf(p).entries()) {
      const f = p.sampleFiles.get(r.sampleId!)!;
      expect(f.name).toBe(FILES[i]);
      expect(new Uint8Array(f.bytes)[0]).toBe(10 + i);
    }
    expect(serialize(p).samples.map((s) => s.name)).toEqual(FILES); // a Save writes them
    expect(p.dirty).toBe(false);
    expect(p.version).toBe(v0); // nothing for the autosave to write
    expect(p.savedFingerprint).toBe(projectFingerprint(p)); // the baseline includes the kit
    expect([h.canUndo, h.canRedo]).toEqual([false, false]);
  });

  it('the UI is usable at once: an edit made while the kit loads stays one undo step, and undo keeps the kit', async () => {
    const { p, t, h, engine } = fresh();
    const { d, release } = deps({ hold: true });
    const loading = loadDefaultKit(p, engine, t.id, d);
    toggleStep(p, engine, t.id, t.rows[0].id, 0); // tapped before the samples landed
    expect(p.dirty).toBe(true);
    release();
    await loading;
    expect(rowsOf(p).every((r) => r.sampleId !== null)).toBe(true);
    expect(p.dirty).toBe(true); // the user's edit is still unsaved
    expect(h.labels.undo).toBe('Toggle step');
    expect(h.undo()).toBe(true);
    expect(h.canUndo).toBe(false);
    expect(currentPattern(p.tracks[0] as DrumTrack).steps[0][0]).toBe(0);
    expect(rowsOf(p).map((r) => r.sampleId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // the kit survives the undo
    expect(projectFingerprint(p)).toBe(p.savedFingerprint); // back to the starting point: the dirty check clears it
    h.redo();
    expect(currentPattern(p.tracks[0] as DrumTrack).steps[0][0]).toBe(100);
    expect(rowsOf(p).map((r) => r.sampleId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('a failed sample shows the error and leaves its row empty; the rest load', async () => {
    const { p, t, engine } = fresh();
    const { d, errors } = deps({ fail: ['clap.wav'] });
    await loadDefaultKit(p, engine, t.id, d);
    expect(errors).toEqual(['Couldn\'t load "clap.wav" — HTTP 404']);
    expect(rowsOf(p)[1]).toMatchObject({ name: 'Clap', sampleId: null });
    expect(rowsOf(p).filter((r) => r.sampleId !== null)).toHaveLength(7);
    expect(p.dirty).toBe(false);
  });

  it('a row the user already filled keeps the user\'s sample', async () => {
    const { p, t, engine } = fresh();
    const { d, release } = deps({ hold: true });
    const loading = loadDefaultKit(p, engine, t.id, d);
    t.rows[0].sampleId = 99; // stands in for a drop that landed first
    release();
    await loading;
    expect(rowsOf(p)[0].sampleId).toBe(99);
    expect(rowsOf(p)[1].sampleId).not.toBeNull();
  });

  it('New / Open / restore during the load: nothing lands in the new session', async () => {
    const { p, t, engine } = fresh();
    const { d, release } = deps({ hold: true });
    const loading = loadDefaultKit(p, engine, t.id, d);
    p.generation++; // project/load.ts blankState
    release();
    await loading;
    expect(p.sampleFiles.size).toBe(0);
    expect(rowsOf(p).every((r) => r.sampleId === null)).toBe(true);
  });

  it('saved to a folder before the kit landed: the kit is an unsaved change', async () => {
    const { p, t, engine } = fresh();
    const { d, release } = deps({ hold: true });
    const loading = loadDefaultKit(p, engine, t.id, d);
    p.folder = {} as FileSystemDirectoryHandle;
    markSaved(p);
    release();
    await loading;
    expect(rowsOf(p).every((r) => r.sampleId !== null)).toBe(true);
    expect(p.dirty).toBe(true); // the folder does not have the samples yet
  });

  it('dropped while playing (DEFERRED): attaches when the engine settles it, still quietly', async () => {
    const { p, t, engine, v0, h } = fresh({ sampleCode: () => Err.DEFERRED });
    const off = installSampleLoads(p, engine);
    try {
      const { d } = deps();
      await loadDefaultKit(p, engine, t.id, d);
      expect(rowsOf(p).every((r) => r.sampleId === null)).toBe(true);
      for (let id = 0; id < 8; id++) engine.onSampleLoaded!(id, Err.OK);
      expect(rowsOf(p).map((r) => r.sampleId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect([p.dirty, p.version, h.canUndo]).toEqual([false, v0, false]);
    } finally {
      off();
    }
  });

  it('Save As while the kit loads: the folder lacks the late samples, so the project stays unsaved (final M1)', async () => {
    const { p, t, engine } = fresh();
    const { d, release } = deps({ hold: true });
    const loading = loadDefaultKit(p, engine, t.id, d);
    const dir = new FakeDir('Song');
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const getDir = dir.getDirectoryHandle.bind(dir);
    dir.getDirectoryHandle = async (n: string, o?: { create?: boolean }) => (await gate, getDir(n, o));
    const saved: { version: number; baselineEpoch: number }[] = [];
    const s = createProjectSession(p, engine as unknown as SessionEngine, { onSaved: (i) => void saved.push(i) });
    const saving = s.saveTo(asDir(dir)); // serialized now (no kit samples), written once the gate opens
    release();
    await loading; // the kit lands while the files are written
    open();
    await saving;
    expect(rowsOf(p).every((r) => r.sampleId !== null)).toBe(true);
    expect(p.folder).toBe(asDir(dir));
    expect(p.dirty).toBe(true); // the folder does not have the samples
    expect(p.savedFingerprint).not.toBe(projectFingerprint(p));
    // The autosave's pending write must not be dropped either (App onSaved).
    expect(saved).toHaveLength(1);
    expect(saved[0].baselineEpoch).not.toBe(p.baselineEpoch);
  });

  it('a kit row landing after the user edited asks the autosave to write it; an untouched session never does (final M2)', async () => {
    for (const edited of [false, true]) {
      const { p, t, engine, v0 } = fresh();
      const { d, release } = deps({ hold: true });
      let asked = 0;
      d.landedAfterEdit = () => asked++;
      const loading = loadDefaultKit(p, engine, t.id, d);
      if (edited) toggleStep(p, engine, t.id, t.rows[0].id, 0);
      const v = p.version;
      release();
      await loading;
      expect(rowsOf(p).every((r) => r.sampleId !== null)).toBe(true);
      expect(p.version).toBe(v); // still no version bump (no extra undo / dirty signal)
      expect(asked).toBe(edited ? 8 : 0);
      if (!edited) expect(p.version).toBe(v0);
    }
  });

  it('withRowSample finds the row by name within the track, wherever it is in that snapshot (final M3)', () => {
    const { p } = fresh();
    const s = serialize(p);
    const t = s.tracks[0] as Extract<ProjectJson['tracks'][number], { kind: 'drum' }>;
    // An older snapshot whose rows sit at other indexes than the live ones.
    const moved: ProjectJson = { ...s, tracks: [{ ...t, rows: [t.rows[1], t.rows[0], ...t.rows.slice(2)] }] };
    const sample = { id: 0, name: 'clap.wav', file: 'samples/0-x-clap.wav' } as unknown as SampleJson;
    const got = withRowSample(moved, t.slot, 'Clap', sample);
    const rows = (got.tracks[0] as typeof t).rows;
    expect(rows.map((r) => [r.name, r.sample])).toEqual([['Clap', 0], ['Kick', null], ...t.rows.slice(2).map((r) => [r.name, null])]);
    expect(got.samples.map((x) => x.id)).toEqual([0]);
    // No empty row of that name (or the sample is already there): unchanged.
    expect(withRowSample(got, t.slot, 'Clap', { ...sample, id: 1 } as SampleJson)).toBe(got);
    expect(withRowSample(moved, t.slot, 'Cowbell', sample)).toBe(moved);
  });

  it('an autosave restore still reading (p.loading) when a row imports: retried once it is over (final M4)', async () => {
    const { p, t, engine, v0 } = fresh();
    const { d, errors } = deps();
    markBusy(p); // session.restore reading the autosave (generation unchanged until it loads)
    const loading = loadDefaultKit(p, engine, t.id, d);
    await tick(30);
    markIdle(p); // the read failed: the fresh session stays
    await loading;
    expect(errors).toEqual([]);
    expect(rowsOf(p).every((r) => r.sampleId !== null)).toBe(true);
    expect([p.dirty, p.version]).toEqual([false, v0]);
  });

  it('a restore that replaced the session during that wait: nothing lands (final M4)', async () => {
    const { p, t, engine } = fresh();
    const { d, errors } = deps();
    markBusy(p);
    void loadDefaultKit(p, engine, t.id, d); // ends without resolving: whenIdle never fires for an old session
    await tick(30);
    p.generation++; // the restore loaded
    markIdle(p);
    await tick(30);
    expect(errors).toEqual([]);
    expect(rowsOf(p).every((r) => r.sampleId === null)).toBe(true);
  });

  it('an audio restart during the kit load: the rows load after it, no "drop it again" (final P4)', async () => {
    const { p, t, engine } = fresh();
    const { d, errors } = deps();
    markBusy(p, { restarting: true }); // audio/restart.ts
    const loading = loadDefaultKit(p, engine, t.id, d);
    await tick(30);
    p.audioRestarts++;
    markIdle(p);
    await loading;
    expect(errors).toEqual([]);
    expect(rowsOf(p).every((r) => r.sampleId !== null)).toBe(true);
    expect(p.dirty).toBe(false);
  });
  describe('waiting for idle', () => {
    afterEach(() => vi.useRealTimers());

    it('busy kit import retries on the idle signal, no polling', async () => {
      // Only timers are faked: setImmediate (below) waits for the real async
      // work (hashing) without scheduling a timer of its own.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const { p, t, engine } = fresh();
      const decodes: number[] = []; // frames = 10 + row index (deps below)
      engine.context = {
        decodeAudioData: (buf: ArrayBuffer) => {
          decodes.push(new Uint8Array(buf)[0]);
          return fakeDecoder.decodeAudioData(buf);
        },
      };
      const { d, errors } = deps();
      const spin = async (n = 200) => {
        for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
      };
      markBusy(p); // a restore still reading
      const loading = loadDefaultKit(p, engine, t.id, d);
      await spin();
      expect(decodes).toEqual([10]); // row 0 imported once, refused as busy
      expect(vi.getTimerCount()).toBe(0); // waiting on the signal, not a timer
      await spin();
      expect(decodes).toEqual([10]);
      markIdle(p);
      await loading;
      expect(decodes.filter((x) => x === 10)).toHaveLength(2); // exactly one retry
      expect(errors).toEqual([]);
      expect(rowsOf(p).every((r) => r.sampleId !== null)).toBe(true);
    });
  });
});

describe('a template\'s kit (File ▸ New from template, plan 27 Task 2)', () => {
  it('New from template, then its kit lands: every row filled from that kit, not dirty, no version bump, no undo history', async () => {
    const p = new Project();
    const base = fakeEngine();
    const engine: SessionEngine & typeof base = Object.assign(base, {
      context: fakeDecoder,
      send(op: number, a = 0, b = 0, c = 0, d = 0) {
        base.log.push({ op, args: [a, b, c, d] });
        commandEdits(p, op); // App: e.onCommand
        return true;
      },
    });
    const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, engine, from, to) });
    p.history = h;
    const fetched: string[] = [];
    const d: KitDeps = {
      fetchFile: async (file, kitId) => (fetched.push(`${kitId}/${file}`), new File([fakeAudio(20)], `${kitId}-${file}`, { type: 'audio/wav' })),
      onError: (m) => { throw new Error(m); },
    };
    let landing: Promise<void> | null = null;
    const s = createProjectSession(p, engine, {
      onFresh: (trackId, kitId) => (landing = loadDefaultKit(p, engine, trackId, d, kitId)),
    });
    await s.newFromTemplate('deep-house-122');
    expect(landing).not.toBeNull();
    const v0 = p.version;
    expect([p.dirty, h.canUndo]).toEqual([false, false]);
    await landing;
    const rows = rowsOf(p);
    expect(rows.map((r) => r.name)).toEqual(NAMES); // the Deep kit's roles
    expect(rows.map((r) => p.sampleFiles.get(r.sampleId!)?.name)).toEqual(
      ['kick.wav', 'clap.wav', 'closed-hat.wav', 'open-hat.wav', 'snare.wav', 'rim.wav', 'shaker.wav', 'perc.wav'].map((f) => `deep-${f}`),
    );
    expect(fetched.every((f) => f.startsWith('deep/'))).toBe(true);
    expect(p.dirty).toBe(false);
    expect(p.version).toBe(v0);
    expect(p.savedFingerprint).toBe(projectFingerprint(p)); // the baseline includes the kit
    expect([h.canUndo, h.canRedo]).toEqual([false, false]);
    // The rest of the template is intact: tempo, its four tracks, the Bass ducked from the Kick row.
    expect(p.tempo).toBe(122);
    expect(p.tracks.map((t) => t.name)).toEqual(['Drums', 'Bass', 'Keys', 'Pad']);
    expect(p.mixer.channels[p.tracks[1].id].key).toEqual({ trackId: p.tracks[0].id, row: 0 });
  });

  it('an unknown kit id loads nothing', async () => {
    const { p, t, engine } = fresh();
    const { d } = deps();
    await loadDefaultKit(p, engine, t.id, d, 'nope');
    expect(rowsOf(p).every((r) => r.sampleId === null)).toBe(true);
  });
});
