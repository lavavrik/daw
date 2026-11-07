// The built-in default kit (plan 8 Task 4): a fresh session's drum track is
// the starter kit's eight rows, filled asynchronously without marking the
// project dirty, bumping its version (autosave) or creating an undo entry.
import { describe, expect, it } from 'vitest';
import { Err } from '../audio/protocol';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { markSaved } from '../project/session';
import { projectFingerprint, serialize } from '../project/serialize';
import { fakeAudio, fakeDecoder } from '../project/testFixture';
import { toggleStep } from './actions';
import { commandEdits } from './edits';
import { DEFAULT_KIT, addDefaultDrumTrack, defaultKitRows, loadDefaultKit } from './defaultKit';
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
});
