// Using a built-in kit (state/kit-actions.ts): load one onto a drum track or
// add a drum track made of one. Each is ONE undo entry although the samples
// load asynchronously ("prepare, then commit").
import { describe, expect, it } from 'vitest';
import { Err } from '../audio/protocol';
import type { KitDeps } from './defaultKit';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';
import { fakeAudio, fakeDecoder } from '../project/testFixture';
import { addDrumTrack, removeTrack, toggleStep } from './actions';
import { commandEdits } from './edits';
import { addDefaultDrumTrack, attachKitSample } from './defaultKit';
import { KITS, KIT_ROLES, kitById } from './kits';
import type { Kit, KitSound } from './kits';
import { addKitDrumTrack, kitRowPlan, loadKitOntoTrack } from './kit-actions';
import type { KitFileDeps } from './kit-actions';
import { MAX_ROWS, MAX_TRACKS, Project, currentPattern } from './project.svelte';
import type { DrumTrack } from './project.svelte';
import { installSampleLoads } from './sampleLoads';
import { markBusy, markIdle } from './idle';
import { HostErr } from '../audio/protocol';
import { loadDefaultKit } from './defaultKit';
import { knownKitSample } from './kitSamples';
import { sampleFile } from './sampleFiles';

const ROLES = [...KIT_ROLES];

/** A fresh session as App builds it, the default kit's rows holding starter samples 100..107. */
async function fresh(o: { sampleCode?: (id: number) => number } = {}) {
  const p = new Project();
  const engine = {
    sampleRate: 48000,
    context: fakeDecoder,
    send(op: number) {
      commandEdits(p, op);
      return true;
    },
    loadSample: async (id: number) => (o.sampleCode ? o.sampleCode(id) : Err.OK),
    onSampleLoaded: undefined as ((id: number, code: number) => void) | undefined,
  };
  const t = addDefaultDrumTrack(p, engine)!;
  const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, engine, from, to) });
  p.history = h;
  h.clear();
  for (const [i, r] of t.rows.entries()) {
    p.sampleFiles.set(100 + i, await sampleFile(`starter-${i}.wav`, 'audio/wav', fakeAudio(50 + i)));
    attachKitSample(p, engine, t.id, r.id, 100 + i);
  }
  p.nextSampleId = 0;
  return { p, engine, t, h };
}

/** Kit files as fake audio; `fail` names files that reject; `hold` waits for release(). */
function deps(o: { fail?: string[]; hold?: boolean } = {}) {
  const errors: string[] = [];
  const waiting: (() => void)[] = [];
  const fetched: string[] = [];
  const d: KitFileDeps = {
    fetchFile: (kit: Kit, s: KitSound) => {
      fetched.push(`${kit.id}/${s.file}`);
      const go = () => {
        if (o.fail?.includes(s.file)) throw new Error('HTTP 404');
        return new File([fakeAudio(10 + ROLES.indexOf(s.role))], `${kit.id}-${s.file}`, { type: 'audio/wav' });
      };
      if (!o.hold) return Promise.resolve().then(go);
      return new Promise<File>((res, rej) => waiting.push(() => { try { res(go()); } catch (e) { rej(e); } }));
    },
    onError: (m) => errors.push(m),
  };
  return { d, errors, fetched, release: () => waiting.splice(0).forEach((f) => f()) };
}

const rows = (p: Project, i = 0) => (p.tracks[i] as DrumTrack).rows;
const fileOf = (p: Project, id: number | null) => (id === null ? null : (p.sampleFiles.get(id)?.name ?? null));

describe('kitRowPlan', () => {
  const garage = kitById('garage')!;
  it('a role goes to the first row named after it; missing roles get new rows', () => {
    const plan = kitRowPlan(['Row 1', 'kick', 'Snare', 'Kick'], garage);
    expect(plan.rows).toEqual([
      { role: 'Kick', row: 1 }, { role: 'Clap', row: null }, { role: 'Closed hat', row: null }, { role: 'Open hat', row: null },
      { role: 'Snare', row: 2 }, { role: 'Rim', row: null }, { role: 'Shaker', row: null }, { role: 'Perc', row: null },
    ]);
    expect(plan.skipped).toEqual([]);
  });
  it('past the row cap the rest are skipped', () => {
    expect(kitRowPlan(['Kick', 'a', 'b'], garage, 5)).toEqual({
      rows: [{ role: 'Kick', row: 0 }, { role: 'Clap', row: null }, { role: 'Closed hat', row: null }],
      skipped: ['Open hat', 'Snare', 'Rim', 'Shaker', 'Perc'],
    });
  });
});

describe('loadKitOntoTrack', () => {
  it('replaces every role row\'s sample, keeps the steps, is one undo entry; undo restores the starter samples', async () => {
    const { p, engine, t, h } = await fresh();
    toggleStep(p, engine, t.id, t.rows[0].id, 0);
    toggleStep(p, engine, t.id, t.rows[4].id, 4);
    const before = rows(p).map((r) => r.sampleId);
    const { d, errors } = deps();
    expect(await loadKitOntoTrack(p, engine, t.id, 'garage', d)).toBe(true);
    expect(errors).toEqual([]);
    expect(rows(p).map((r) => r.name)).toEqual(ROLES);
    expect(rows(p).map((r) => fileOf(p, r.sampleId))).toEqual(kitById('garage')!.rows.map((s) => `garage-${s.file}`));
    const steps = currentPattern(p.tracks[0] as DrumTrack).steps;
    expect([steps[0][0], steps[4][4]]).toEqual([100, 100]);
    expect(p.dirty).toBe(true); // an ordinary edit
    expect(h.labels.undo).toBe('Load kit Garage');
    h.undo();
    expect(rows(p).map((r) => r.sampleId)).toEqual(before);
    expect(h.labels.undo).toBe('Toggle step'); // one entry for the whole kit
    expect(currentPattern(p.tracks[0] as DrumTrack).steps[4][4]).toBe(100);
    h.redo();
    expect(rows(p).map((r) => fileOf(p, r.sampleId))[0]).toBe('garage-kick.wav');
  });

  it('adds rows for roles the track lacks; other rows are left alone; undo removes the added rows', async () => {
    const { p, engine, h } = await fresh();
    const t = addDrumTrack(p, engine, 'B', ['Kick', 'Row 2'])!;
    const { d } = deps();
    await loadKitOntoTrack(p, engine, t.id, 'deep', d);
    const r = rows(p, 1);
    expect(r.map((x) => x.name)).toEqual(['Kick', 'Row 2', ...ROLES.slice(1)]);
    expect(r[1].sampleId).toBeNull();
    expect(fileOf(p, r[0].sampleId)).toBe('deep-kick.wav');
    expect(fileOf(p, r[8].sampleId)).toBe('deep-perc.wav');
    h.undo();
    expect(rows(p, 1).map((x) => x.name)).toEqual(['Kick', 'Row 2']);
    expect(rows(p, 1).map((x) => x.sampleId)).toEqual([null, null]);
  });

  it('at the row cap the roles with no room are reported, the rest load', async () => {
    const { p, engine } = await fresh();
    const t = addDrumTrack(p, engine, 'Full', ['Kick', ...Array.from({ length: MAX_ROWS - 2 }, (_, i) => `R${i}`)])!;
    const { d, errors } = deps();
    await loadKitOntoTrack(p, engine, t.id, 'dusty', d);
    expect(rows(p, 1)).toHaveLength(MAX_ROWS);
    expect(rows(p, 1).at(-1)!.name).toBe('Clap');
    expect(errors).toEqual([`No room for Closed hat, Open hat, Snare, Rim, Shaker, Perc from the Dusty kit: ${MAX_ROWS} rows is the maximum`]);
  });

  it('a sound that fails is reported and keeps its row\'s sample; the rest load', async () => {
    const { p, engine, t } = await fresh();
    const { d, errors } = deps({ fail: ['clap.wav', 'rim.wav'] });
    await loadKitOntoTrack(p, engine, t.id, 'drum-machine', d);
    // One message naming the kit and every sound that failed.
    expect(errors).toEqual(['Drum Machine kit: 2 sounds didn\'t load — Clap: HTTP 404; Rim: HTTP 404']);
    expect(rows(p)[1].sampleId).toBe(101);
    expect(fileOf(p, rows(p)[0].sampleId)).toBe('drum-machine-kick.wav');
  });

  it('edits made while it loads stay their own entries, before it', async () => {
    const { p, engine, t, h } = await fresh();
    const { d, release } = deps({ hold: true });
    const loading = loadKitOntoTrack(p, engine, t.id, 'garage', d);
    toggleStep(p, engine, t.id, t.rows[0].id, 8);
    release();
    await loading;
    expect(h.labels.undo).toBe('Load kit Garage');
    h.undo();
    expect(h.labels.undo).toBe('Toggle step');
    expect(currentPattern(p.tracks[0] as DrumTrack).steps[0][8]).toBe(100);
  });

  it('no commit when the track was removed or the session replaced meanwhile', async () => {
    const a = await fresh();
    const held = deps({ hold: true });
    const gone = loadKitOntoTrack(a.p, a.engine, a.t.id, 'garage', held.d);
    removeTrack(a.p, a.engine, a.t.id);
    held.release();
    expect(await gone).toBe(false);

    const b = await fresh();
    const held2 = deps({ hold: true });
    const replaced = loadKitOntoTrack(b.p, b.engine, b.t.id, 'garage', held2.d);
    b.p.generation++;
    held2.release();
    expect(await replaced).toBe(false);
    expect(rows(b.p).map((r) => r.sampleId)).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
  });

  it('while playing, deferred sounds are waited for: the whole kit lands at Stop, still one entry', async () => {
    const { p, engine, t, h } = await fresh({ sampleCode: (id) => (id === 2 ? Err.DEFERRED : Err.OK) });
    const uninstall = installSampleLoads(p, engine);
    try {
      const { d } = deps();
      let done = false;
      const loading = loadKitOntoTrack(p, engine, t.id, 'garage', d).then((v) => (done = v));
      await new Promise((r) => setTimeout(r, 20));
      expect(done).toBe(false);
      expect(rows(p)[0].sampleId).toBe(100); // nothing yet
      engine.onSampleLoaded!(2, Err.OK); // Stop: the deferred load settles
      await loading;
      expect(rows(p).map((r) => fileOf(p, r.sampleId))[2]).toBe('garage-closed-hat.wav');
      h.undo();
      expect(rows(p).map((r) => r.sampleId)).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
    } finally {
      uninstall();
    }
  });

  it('refuses an unknown kit or a missing track', async () => {
    const { p, engine, t } = await fresh();
    const { d } = deps();
    expect(await loadKitOntoTrack(p, engine, t.id, 'nope', d)).toBe(false);
    expect(await loadKitOntoTrack(p, engine, 'no-track', 'garage', d)).toBe(false);
  });
});

describe('addKitDrumTrack', () => {
  it('a track named after the kit, its rows the roles with the kit\'s sounds, one undo entry', async () => {
    const { p, engine, h } = await fresh();
    const { d } = deps();
    const t = (await addKitDrumTrack(p, engine, 'deep', d))!;
    expect(t.name).toBe('Deep');
    expect(t.rows.map((r) => r.name)).toEqual(ROLES);
    expect(t.rows.map((r) => fileOf(p, r.sampleId))).toEqual(kitById('deep')!.rows.map((s) => `deep-${s.file}`));
    expect(p.selectedTrackId).toBe(t.id);
    expect(h.labels.undo).toBe('Add drum track');
    h.undo();
    expect(p.tracks).toHaveLength(1);
    expect(h.canUndo).toBe(false);
  });

  it('the starter kit\'s track is "Drums 2" with its files; a full project adds nothing', async () => {
    const { p, engine } = await fresh();
    const { d } = deps();
    const t = (await addKitDrumTrack(p, engine, KITS[0].id, d))!;
    expect(t.name).toBe('Drums 2');
    expect(fileOf(p, t.rows[0].sampleId)).toBe('starter-kick-punch.wav'); // (the fake deps name files "<kit>-<file>")
    while (p.tracks.length < MAX_TRACKS) addDrumTrack(p, engine);
    expect(await addKitDrumTrack(p, engine, 'garage', d)).toBeNull();
  });
});

describe('kit samples are reused within a session (review round 1 #2)', () => {
  it('loading the same kit again imports nothing new: same ids, no fetch, still one undo entry each', async () => {
    const { p, engine, t, h } = await fresh();
    const { d, fetched } = deps();
    await loadKitOntoTrack(p, engine, t.id, 'garage', d);
    const first = rows(p).map((r) => r.sampleId);
    const next = p.nextSampleId;
    await loadKitOntoTrack(p, engine, t.id, 'deep', d);
    await loadKitOntoTrack(p, engine, t.id, 'garage', d);
    expect(rows(p).map((r) => r.sampleId)).toEqual(first);
    expect(p.nextSampleId).toBe(next + 8); // only Deep's 8 were new
    expect(fetched.filter((f) => f.startsWith('garage/'))).toHaveLength(8);
    expect(h.labels.undo).toBe('Load kit Garage');
    h.undo();
    expect(rows(p).map((r) => fileOf(p, r.sampleId))[0]).toBe('deep-kick.wav');
    // A kit track of a kit already loaded reuses its samples too.
    const added = (await addKitDrumTrack(p, engine, 'garage', d))!;
    expect(added.rows.map((r) => r.sampleId)).toEqual(first);
    expect(p.nextSampleId).toBe(next + 8);
  });

  it('a new session (generation) starts over: ids are imported again', async () => {
    const { p, engine, t } = await fresh();
    const { d, fetched } = deps();
    await loadKitOntoTrack(p, engine, t.id, 'garage', d);
    p.generation++; // as a load does (ids start over)
    await loadKitOntoTrack(p, engine, t.id, 'garage', d);
    expect(fetched).toHaveLength(16);
  });

  it('the default kit\'s samples are reused by a Starter kit load', async () => {
    const { p, engine, t } = await fresh();
    const kick = (await addKitDrumTrack(p, engine, 'starter', deps().d))!; // imports the starter's 8
    const n = p.nextSampleId;
    const { d, fetched } = deps();
    await loadKitOntoTrack(p, engine, t.id, 'starter', d);
    expect(fetched).toEqual([]);
    expect(p.nextSampleId).toBe(n);
    expect(rows(p).map((r) => r.sampleId)).toEqual(kick.rows.map((r) => r.sampleId));
  });
});

describe('a deferred sound settling after the session changed is not remembered (final review #2)', () => {
  it('kit load: its id never enters the new session\'s table', async () => {
    const { p, engine, t } = await fresh({ sampleCode: (id) => (id === 2 ? Err.DEFERRED : Err.OK) });
    const uninstall = installSampleLoads(p, engine);
    try {
      const { d, fetched } = deps();
      const loading = loadKitOntoTrack(p, engine, t.id, 'garage', d);
      await new Promise((r) => setTimeout(r, 20));
      p.generation++; // a load replaced the session (still loading: no markIdle yet)
      engine.onSampleLoaded!(2, Err.OK); // the parked load settles OK anyway
      expect(await loading).toBe(false);
      expect(knownKitSample(p, 'garage', 'closed-hat.wav')).toBeNull();
      expect(knownKitSample(p, 'garage', 'kick.wav')).toBeNull();
      fetched.length = 0;
      await loadKitOntoTrack(p, engine, t.id, 'garage', d);
      expect(fetched).toHaveLength(8); // nothing reused from the old session
    } finally {
      uninstall();
    }
  });

  it('default kit: same', async () => {
    const p = new Project();
    const engine = {
      sampleRate: 48000, context: fakeDecoder, send(op: number) { commandEdits(p, op); return true; },
      loadSample: async (id: number) => (id === 0 ? Err.DEFERRED : Err.OK),
      onSampleLoaded: undefined as ((id: number, code: number) => void) | undefined,
    };
    const t = addDefaultDrumTrack(p, engine)!;
    const uninstall = installSampleLoads(p, engine);
    try {
      const kitDeps: KitDeps = { fetchFile: async (file) => new File([fakeAudio(60)], file, { type: 'audio/wav' }), onError: () => {} };
      await loadDefaultKit(p, engine, t.id, kitDeps); // the kick (id 0) waits for Stop
      expect(knownKitSample(p, 'starter', 'clap.wav')).toBe(1);
      p.generation++;
      engine.onSampleLoaded!(0, Err.OK);
      expect(knownKitSample(p, 'starter', 'kick-punch.wav')).toBeNull();
    } finally {
      uninstall();
    }
  });
});

describe('a kit load always ends (review round 1 #3)', () => {
  it('a deferred sound whose load is reset: the load resolves false, nothing committed', async () => {
    const { p, engine, t, h } = await fresh({ sampleCode: (id) => (id === 3 ? Err.DEFERRED : Err.OK) });
    const uninstall = installSampleLoads(p, engine);
    try {
      const loading = loadKitOntoTrack(p, engine, t.id, 'garage', deps().d);
      await new Promise((r) => setTimeout(r, 20));
      // A load replaces the session: the engine reset drops the deferred load.
      markBusy(p);
      p.generation++;
      engine.onSampleLoaded!(3, HostErr.RESET);
      markIdle(p);
      expect(await loading).toBe(false);
      expect(rows(p)[3].sampleId).toBe(103);
      expect(h.canUndo).toBe(false);
    } finally {
      uninstall();
    }
  });

  it('a deferred sound that an audio restart lost: the load ends, the rest land, the lost one is reported', async () => {
    const { p, engine, t } = await fresh({ sampleCode: (id) => (id === 0 ? Err.DEFERRED : Err.OK) });
    const uninstall = installSampleLoads(p, engine);
    try {
      const { d, errors } = deps();
      const loading = loadKitOntoTrack(p, engine, t.id, 'deep', d);
      await new Promise((r) => setTimeout(r, 20));
      installSampleLoads(p, engine)(); // pending loads dropped unanswered
      expect(await loading).toBe(true);
      expect(rows(p)[0].sampleId).toBe(100); // the lost kick: the row keeps its sample
      expect(fileOf(p, rows(p)[1].sampleId)).toBe('deep-clap.wav');
      expect(errors).toEqual(['Deep kit: 1 sound didn\'t load — Kick: dropped before it loaded (audio restarted)']);
    } finally {
      uninstall();
    }
  });

  it('a busy import whose session is replaced before idle: resolves false (whenIdle alone would never)', async () => {
    const { p, engine, t } = await fresh();
    const held = deps({ hold: true });
    const loading = addKitDrumTrack(p, engine, 'dusty', held.d);
    markBusy(p); // an autosave restore's read: imports come back busy
    held.release();
    await new Promise((r) => setTimeout(r, 20));
    p.generation++; // the restore replaced the session
    markIdle(p);
    expect(await loading).toBeNull();
    void t;
  });
});

describe('a kit load during the default kit\'s load (review round 1 #11)', () => {
  it('waits for the starter samples to land, so one undo restores them', async () => {
    const p = new Project();
    const engine = {
      sampleRate: 48000, context: fakeDecoder, send(op: number) { commandEdits(p, op); return true; },
      loadSample: async () => Err.OK,
    };
    const t = addDefaultDrumTrack(p, engine)!;
    const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, engine, from, to) });
    p.history = h;
    h.clear();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const kitDeps: KitDeps = {
      fetchFile: async (file) => {
        await gate;
        return new File([fakeAudio(60)], file, { type: 'audio/wav' });
      },
      onError: () => {},
    };
    const starting = loadDefaultKit(p, engine, t.id, kitDeps);
    const loading = loadKitOntoTrack(p, engine, t.id, 'garage', deps().d);
    await new Promise((r) => setTimeout(r, 20));
    expect(rows(p)[0].sampleId).toBeNull(); // the kit waits for the default kit
    release();
    await starting;
    expect(await loading).toBe(true);
    expect(fileOf(p, rows(p)[0].sampleId)).toBe('garage-kick.wav');
    h.undo();
    expect(rows(p).map((r) => fileOf(p, r.sampleId))).toEqual(KITS[0].rows.map((s) => s.file));
  });
});
