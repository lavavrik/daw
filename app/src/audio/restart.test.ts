import { describe, expect, it } from 'vitest';
import { Err, Op } from './protocol';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { blankModel, run, view } from '../history/engineModel';
import { projectCommands } from '../project/commands';
import { serialize } from '../project/serialize';
import type { ProjectJson } from '../project/schema';
import { buildFixture, checkLog, fakeAudio, fakeDecoder, fakeEngine } from '../project/testFixture';
import { setRowSample, setTempo } from '../state/actions';
import { sampleFile } from '../state/sampleFiles';
import {
  LATENCY_HINT_KEY, hintLabel, loadLatencyHint, parseLatencyHint, restartAudio, saveLatencyHint,
} from './restart';
import type { LatencyHint, RestartDeps } from './restart';

const ids = (json: ProjectJson) => new Map(json.samples.map((s) => [s.id, s.id]));
/** The engine state a fresh load of `json` builds (history/engineModel). */
const loaded = (json: ProjectJson) => view(run(blankModel(), projectCommands(json, ids(json)).commands), json);

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

type Fake = ReturnType<typeof fakeEngine> & { context: typeof fakeDecoder; close(): Promise<void>; closed: boolean; hint?: LatencyHint };
function engineFor(steps: string[], name: string, o: Parameters<typeof fakeEngine>[0] = {}): Fake {
  const e = fakeEngine(o) as Fake;
  e.context = fakeDecoder;
  e.closed = false;
  e.close = async () => {
    steps.push(`close ${name}`);
    e.closed = true;
  };
  return e;
}

/** A live project as a session builds it: fixture + history, on an "old" engine. */
async function live() {
  const f = await buildFixture();
  const p = f.p;
  // Sample ids need not be compact in a live session: an unused id 3 and a used id 7.
  p.sampleFiles.set(3, await sampleFile('unused.wav', 'audio/wav', fakeAudio(13)));
  p.sampleFiles.set(7, await sampleFile('clap.wav', 'audio/wav', fakeAudio(17)));
  p.nextSampleId = 8;
  const steps: string[] = [];
  const old = engineFor(steps, 'old');
  let sink: { send: Fake['send'] } = old;
  const h = createHistory({ snapshot: () => serialize(p), apply: (a, b) => diffApply(p, sink, a, b), canApply: () => !p.loading });
  p.history = h;
  setRowSample(p, old, f.drums.id, f.drums.rows[2].id, 7, 'clap');
  setTempo(p, old, 140);
  // Mid-edit flags a session carries: unsaved, a folder, an edit count.
  p.dirty = true;
  p.version = 12;
  p.folder = { name: 'proj' } as FileSystemDirectoryHandle;
  return { ...f, steps, old, h, setSink: (s: { send: Fake['send'] }) => (sink = s) };
}

function deps(l: Awaited<ReturnType<typeof live>>, o: Partial<RestartDeps<Fake>> & { failHints?: LatencyHint[] } = {}) {
  const started: Fake[] = [];
  const d: RestartDeps<Fake> = {
    old: l.old,
    oldHint: 'interactive',
    async start(hint) {
      l.steps.push(`start ${String(hint)}`);
      if (o.failHints?.includes(hint)) throw new Error('device refused');
      const e = engineFor(l.steps, `new ${String(hint)}`);
      e.hint = hint;
      started.push(e);
      return e;
    },
    stop: () => l.steps.push('stop'),
    unwire: () => l.steps.push('unwire'),
    wire: (e) => {
      l.steps.push(`wire ${String(e.hint)}`);
      l.setSink(e);
    },
    ...o,
  };
  return { d, started };
}

describe('latency hint setting', () => {
  it('latency hint round-trips through localStorage', () => {
    for (const h of ['interactive', 'balanced', 'playback', 0.02] as LatencyHint[]) {
      const s = memStore();
      saveLatencyHint(h, s);
      expect(loadLatencyHint(s)).toEqual(h);
    }
    expect(loadLatencyHint(memStore())).toBe('interactive'); // nothing stored
    expect(loadLatencyHint(null)).toBe('interactive'); // storage blocked
    expect(loadLatencyHint(memStore({ [LATENCY_HINT_KEY]: 'garbage' }))).toBe('interactive');
    expect(loadLatencyHint(memStore({ [LATENCY_HINT_KEY]: '-1' }))).toBe('interactive');
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadLatencyHint(throwing)).toBe('interactive');
    expect(() => saveLatencyHint('playback', throwing)).not.toThrow();
  });

  it('custom hints are seconds within 1 ms..1 s; labels name them in ms', () => {
    expect(parseLatencyHint(0.0005)).toBe(0.001);
    expect(parseLatencyHint(5)).toBe(1);
    expect(parseLatencyHint(Number.NaN)).toBe('interactive');
    expect(parseLatencyHint('balanced')).toBe('balanced');
    expect(hintLabel('playback')).toBe('Playback');
    expect(hintLabel(0.025)).toBe('Custom 25 ms');
  });
});

describe('restartAudio', () => {
  it('restart order: stop, unwire, close the old engine, start with the hint, replay, wire', async () => {
    const l = await live();
    const { d, started } = deps(l);
    const r = await restartAudio(l.p, 'playback', d);
    expect(r).toEqual({ hint: 'playback', warnings: [], error: null });
    expect(l.steps).toEqual(['stop', 'unwire', 'close old', 'start playback', 'wire playback']);
    expect(l.old.closed).toBe(true);
    // Replayed on the fresh engine: samples first (each at its own id, used
    // or not -- undo may bring an unused one back), then the commands. No
    // RESET_ALL: a new engine is blank.
    const e = started[0];
    const firstOp = e.log.findIndex((x) => 'op' in x);
    expect(e.log.slice(0, firstOp)).toEqual([{ sample: 0 }, { sample: 1 }, { sample: 2 }, { sample: 3 }, { sample: 7 }]);
    expect(e.log.some((x) => 'op' in x && x.op === Op.RESET_ALL)).toBe(false);
    expect(checkLog(e.log).errors).toEqual([]);
    expect(l.p.loading).toBe(false);
  });

  it('restart keeps the project: same serialize, name, folder, dirty mark, version and undo history', async () => {
    const l = await live();
    const before = serialize(l.p);
    const folder = l.p.folder;
    const ids0 = l.p.tracks.map((t) => t.id);
    const { d, started } = deps(l);
    await restartAudio(l.p, 'balanced', d);
    expect(serialize(l.p)).toEqual(before);
    expect(l.p.tracks.map((t) => t.id)).toEqual(ids0); // the UI state is untouched (editor selections stay valid)
    expect(l.p.name).toBe('Fixture');
    expect(l.p.folder).toBe(folder);
    expect(l.p.dirty).toBe(true);
    expect(l.p.version).toBe(12);
    expect(l.h.labels.undo).not.toBeNull();
    // The new engine holds exactly what a load of the project builds.
    const e = started[0];
    const cmds = e.log.filter((x) => 'op' in x).map((x) => ('op' in x ? [x.op, ...x.args] : []));
    expect(view(run(blankModel(), cmds), before)).toEqual(loaded(before));

    // Undo still works after the restart (snapshots are engine-independent),
    // through the new engine: tempo back to 132.5, then the clap row back to none.
    l.h.undo();
    expect(l.p.tempo).toBe(132.5);
    l.h.undo();
    expect(l.p.tracks[0].kind === 'drum' && l.p.tracks[0].rows[2].sampleId).toBeNull();
    const after = e.log.filter((x) => 'op' in x).map((x) => ('op' in x ? [x.op, ...x.args] : []));
    const now = serialize(l.p);
    expect(view(run(blankModel(), after), now)).toEqual(loaded(now));
    // ...and redo brings back sample 7 (kept at its id on the new engine).
    l.h.redo();
    expect(l.p.tracks[0].kind === 'drum' && l.p.tracks[0].rows[2].sampleId).toBe(7);
    expect(checkLog(e.log).errors).toEqual([]);
  });

  it('a hint the device refuses falls back to the previous one (and says so)', async () => {
    const l = await live();
    const { d, started } = deps(l, { failHints: [0.005] });
    const r = await restartAudio(l.p, 0.005, d);
    expect(r?.hint).toBe('interactive');
    expect(r?.error).toMatch(/Custom 5 ms.*device refused/);
    expect(l.steps).toEqual(['stop', 'unwire', 'close old', 'start 0.005', 'start interactive', 'wire interactive']);
    expect(started).toHaveLength(1);
    expect(serialize(l.p).tempo).toBe(140);
  });

  it('refused while a project load or another restart runs (nothing touched)', async () => {
    const l = await live();
    const { d } = deps(l);
    l.p.loading = true;
    expect(await restartAudio(l.p, 'playback', d)).toBeNull();
    expect(l.steps).toEqual([]);
    expect(l.old.closed).toBe(false);
  });

  it('a sample the new engine refuses is a warning; wire gets every upload result', async () => {
    const l = await live();
    let codes: Map<number, number> | null = null;
    const { d } = deps(l, {
      start: async () => engineFor(l.steps, 'new', { sampleCode: (id) => (id === 7 ? Err.OUT_OF_MEMORY : Err.OK) }),
      wire: (_e, c) => (codes = c),
    });
    const r = await restartAudio(l.p, 'interactive', d);
    expect(r?.warnings).toHaveLength(1);
    expect(r?.warnings[0]).toMatch(/clap\.wav/);
    expect(codes!.get(7)).toBe(Err.OUT_OF_MEMORY);
    expect(codes!.get(0)).toBe(Err.OK);
    // The UI keeps the row's sample (a Save still writes it); only the engine lacks it.
    expect(l.p.tracks[0].kind === 'drum' && l.p.tracks[0].rows[2].sampleId).toBe(7);
  });

  it('when no engine can start, the error propagates with nothing wired and loading cleared', async () => {
    const l = await live();
    const { d } = deps(l, { failHints: ['playback', 'interactive'] });
    await expect(restartAudio(l.p, 'playback', d)).rejects.toThrow(/device refused/);
    expect(l.steps).not.toContain('wire interactive');
    expect(l.p.loading).toBe(false);
  });
});
