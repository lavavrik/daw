import { afterEach, describe, expect, it, vi } from 'vitest';
import { Err, Op } from './protocol';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { blankModel, run, view } from '../history/engineModel';
import { projectCommands } from '../project/commands';
import { serialize } from '../project/serialize';
import type { ProjectJson } from '../project/schema';
import { addAutomationFixture, buildFixture, checkLog, fakeAudio, fakeDecoder, fakeEngine } from '../project/testFixture';
import { setRowSample, setTempo } from '../state/actions';
import { addAudioClip, addAudioTrack } from '../state/audio-actions';
import { deleteClips } from '../state/song-actions';
import { MAX_ARENA_FLOATS } from './protocol';
import { sampleFile } from '../state/sampleFiles';
import { installSampleLoads, pendingSampleLoads } from '../state/sampleLoads';
import {
  LATENCY_HINT_KEY, RESTART_TIMEOUT_MS, customHint, hintLabel, loadLatencyHint, parseLatencyHint, replayTimeoutMs, restartAudio,
  saveLatencyHint,
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
    timeoutMs: 200,
    flush: async () => void l.steps.push('flush'),
    async start(hint) {
      l.steps.push(`start ${String(hint)}`);
      if (o.failHints?.includes(hint)) throw new Error('device refused');
      const e = engineFor(l.steps, `new ${String(hint)}`);
      e.hint = hint;
      started.push(e);
      return e;
    },
    stop: () => l.steps.push('stop'),
    // Before any replayed command reaches the new engine (stall reports).
    prepare: (e) => l.steps.push(`prepare ${String(e.hint)} (${e.log.length} sent)`),
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

  it('customHint: an empty or non-positive ms field applies nothing (no silent Interactive)', () => {
    expect(customHint(20)).toBe(0.02);
    expect(customHint(5000)).toBe(1); // clamped; the panel shows what applies
    expect(customHint(0)).toBeNull();
    expect(customHint(-3)).toBeNull();
    expect(customHint(Number.NaN)).toBeNull(); // an emptied <input type=number>
    expect(customHint(null)).toBeNull();
  });
});

describe('restartAudio', () => {
  it('restart order: flush, stop, start the new engine (old still running), replay, then swap and close the old one', async () => {
    const l = await live();
    const { d, started } = deps(l);
    let during: [boolean, number] | null = null;
    d.stop = () => {
      l.steps.push('stop');
      during = [l.p.restarting, l.p.audioRestarts];
    };
    const r = await restartAudio(l.p, 'playback', d);
    expect(r).toMatchObject({ hint: 'playback', warnings: [], error: null });
    expect(l.steps).toEqual(['flush', 'stop', 'start playback', 'prepare playback (0 sent)', 'unwire', 'wire playback', 'close old']);
    expect(await r!.later).toEqual([]);
    expect(l.old.closed).toBe(true);
    expect(during).toEqual([true, 0]);
    expect(l.p.restarting).toBe(false);
    expect(l.p.audioRestarts).toBe(1); // in-flight imports on the old engine see it
    // Replayed on the fresh engine: the samples the project uses first, each
    // at its own id, then the commands. No RESET_ALL: a new engine is blank.
    // The unused one (undo may bring it back) is uploaded after the swap.
    const e = started[0];
    const firstOp = e.log.findIndex((x) => 'op' in x);
    expect(e.log.slice(0, firstOp)).toEqual([{ sample: 0 }, { sample: 1 }, { sample: 2 }, { sample: 7 }]);
    expect(e.log.at(-1)).toEqual({ sample: 3 });
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

  it('restart replays the automation lanes (projectCommands: no path of its own)', async () => {
    const l = await live();
    addAutomationFixture(l.p);
    const before = serialize(l.p);
    const { d, started } = deps(l);
    await restartAudio(l.p, 'balanced', d);
    expect(serialize(l.p)).toEqual(before);
    const e = started[0];
    const cmds = e.log.filter((x) => 'op' in x).map((x) => ('op' in x ? [x.op, ...x.args] : []));
    const m = run(blankModel(), cmds);
    expect(m.errors).toEqual([]);
    expect(m.autos.filter(Boolean)).toHaveLength(4);
    expect(view(m, before)).toEqual(loaded(before));
    expect(checkLog(e.log).errors).toEqual([]);
  });

  it('a hint the device refuses keeps the running engine (and says so)', async () => {
    const l = await live();
    const { d, started } = deps(l, { failHints: [0.005] });
    const r = await restartAudio(l.p, 0.005, d);
    expect(r?.hint).toBe('interactive');
    expect(r?.error).toBe("Couldn't apply Custom 5 ms: device refused; kept previous settings");
    expect(l.steps).toEqual(['flush', 'stop', 'start 0.005']);
    expect(started).toHaveLength(0);
    expect(l.old.closed).toBe(false); // still wired, still playing what it had
    expect(l.p.loading).toBe(false);
    expect(l.p.audioRestarts).toBe(0);
    expect(serialize(l.p).tempo).toBe(140);
  });

  it('a start that hangs times out; the old engine stays wired and running, the late one is closed', async () => {
    const l = await live();
    let late!: (e: Fake) => void;
    const { d } = deps(l, { timeoutMs: 30, start: () => new Promise<Fake>((r) => (late = r)) });
    const r = await restartAudio(l.p, 'playback', d);
    expect(r?.error).toMatch(/^Couldn't apply Playback: audio did not start within 0\.03 s; kept previous settings$/);
    expect(r?.hint).toBe('interactive');
    expect(l.steps).toEqual(['flush', 'stop']);
    expect(l.old.closed).toBe(false);
    expect(l.p.loading).toBe(false);
    expect(l.p.restarting).toBe(false);
    // The device answers after all: that engine is closed, never wired.
    const straggler = engineFor(l.steps, 'late');
    late(straggler);
    await Promise.resolve();
    await Promise.resolve();
    expect(straggler.closed).toBe(true);
    expect(l.steps).not.toContain('unwire');
  });

  it('a replay that throws (or hangs) closes the new engine and keeps the old one', async () => {
    const l = await live();
    let made: Fake | null = null;
    const { d } = deps(l, {
      start: async (h) => {
        made = engineFor(l.steps, 'new');
        made.hint = h;
        made.loadSample = () => Promise.reject(new Error('port gone'));
        return made;
      },
    });
    const r = await restartAudio(l.p, 'balanced', d);
    expect(r?.error).toBe("Couldn't apply Balanced: port gone; kept previous settings");
    expect(made!.closed).toBe(true);
    expect(l.old.closed).toBe(false);
    expect(l.steps).toEqual(['flush', 'stop', 'prepare balanced (0 sent)', 'close new']);

    const l2 = await live();
    const { d: d2, started } = deps(l2, { timeoutMs: 30 });
    d2.start = async (h) => {
      const e = engineFor(l2.steps, 'new');
      e.hint = h;
      e.loadSample = () => new Promise(() => {}); // never answers
      started.push(e);
      return e;
    };
    const r2 = await restartAudio(l2.p, 'balanced', d2);
    expect(r2?.error).toMatch(/did not finish within 0\.03 s; kept previous settings$/);
    expect(started[0].closed).toBe(true);
    expect(l2.old.closed).toBe(false);
    expect(l2.p.loading).toBe(false);
  });

  it('a failing autosave flush does not stop the restart', async () => {
    const l = await live();
    const { d } = deps(l, { flush: () => Promise.reject(new Error('disk full')) });
    const r = await restartAudio(l.p, 'playback', d);
    expect(r?.error).toBeNull();
    expect(l.old.closed).toBe(true);
  });

  it('refused while a project load or another restart runs (nothing touched)', async () => {
    const l = await live();
    const { d } = deps(l);
    l.p.loading = true;
    expect(await restartAudio(l.p, 'playback', d)).toBeNull();
    expect(l.steps).toEqual([]); // not even the flush
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
  describe('unused samples and the replay timeout', () => {
    afterEach(() => vi.useRealTimers());

    it('unused samples upload after the switch', async () => {
      const l = await live(); // sample 3 is unused (fakeAudio(13)); 0, 1, 2, 7 are used
      vi.useFakeTimers();
      const { d, started } = deps(l, { timeoutMs: undefined }); // the real 8 s
      const slow = {
        // The unused sample takes 20 s to decode: far beyond the 8 s budget.
        decodeAudioData: async (buf: ArrayBuffer) => {
          if (new Uint8Array(buf)[0] === 13) await new Promise((r) => setTimeout(r, 20_000));
          return fakeDecoder.decodeAudioData(buf);
        },
      };
      const start = d.start;
      d.start = async (h) => {
        const e = await start(h);
        e.context = slow as typeof fakeDecoder;
        const load = e.loadSample.bind(e);
        e.loadSample = (id, ch) => {
          l.steps.push(`upload ${id}`);
          return load(id, ch);
        };
        return e;
      };
      let res: Awaited<ReturnType<typeof restartAudio>> | undefined;
      void restartAudio(l.p, 'playback', d).then((r) => (res = r));
      await vi.advanceTimersByTimeAsync(RESTART_TIMEOUT_MS - 1);
      expect(res?.error).toBeNull(); // done within the 8 s
      expect(l.p.loading).toBe(false);
      expect(l.steps).toEqual([
        'flush', 'stop', 'start playback', 'prepare playback (0 sent)',
        'upload 0', 'upload 1', 'upload 2', 'upload 7', 'unwire', 'wire playback', 'close old',
      ]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(l.steps.at(-1)).toBe('upload 3'); // after wireEngine
      expect(await res!.later).toEqual([]);
      expect(started[0].log.at(-1)).toEqual({ sample: 3 });
      expect(checkLog(started[0].log).errors).toEqual([]);
    });

    it('an undo that brings back a not-yet-uploaded sample: its binding is re-sent once when the upload lands', async () => {
      const l = await live();
      const row = l.drums.rows[3].id;
      // Row 3 held the unused sample 3 once: an undo can bring it back.
      setRowSample(l.p, l.old, l.drums.id, row, 3, 'unused');
      setRowSample(l.p, l.old, l.drums.id, row, null, 'Row');
      vi.useFakeTimers();
      const { d, started } = deps(l, { timeoutMs: undefined });
      const slow = {
        decodeAudioData: async (buf: ArrayBuffer) => {
          if (new Uint8Array(buf)[0] === 13) await new Promise((r) => setTimeout(r, 20_000));
          return fakeDecoder.decodeAudioData(buf);
        },
      };
      const start = d.start;
      d.start = async (h) => {
        const e = await start(h);
        e.context = slow as typeof fakeDecoder;
        return e;
      };
      let res: Awaited<ReturnType<typeof restartAudio>> | undefined;
      void restartAudio(l.p, 'playback', d).then((r) => (res = r));
      await vi.advanceTimersByTimeAsync(100);
      expect(res?.error).toBeNull();
      const e = started[0];
      const slot = l.drums.slot;
      const binds = () => e.log.filter((x) => 'op' in x && x.op === Op.SET_ROW_SAMPLE && x.args[0] === slot && x.args[1] === 3 && x.args[2] === 3);
      l.h.undo(); // row 3 -> sample 3, which the new engine does not have yet
      expect(l.p.tracks[0].kind === 'drum' && l.p.tracks[0].rows[3].sampleId).toBe(3);
      expect(binds()).toHaveLength(1);
      const [version, dirty] = [l.p.version, l.p.dirty];
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await res!.later).toEqual([]);
      expect(binds()).toHaveLength(2); // re-sent exactly once, after the upload
      const upload = e.log.findIndex((x) => 'sample' in x && x.sample === 3);
      expect(e.log.lastIndexOf(binds()[1])).toBeGreaterThan(upload);
      expect([l.p.version, l.p.dirty]).toEqual([version, dirty]); // catching the engine up is no edit
    });

    it('undo restores an audio clip whose sample is still uploading: the clip is re-sent once it lands, and plays', async () => {
      const l = await live();
      // An Audio track whose clip played the unused sample 3 once.
      const t = addAudioTrack(l.p, l.old)!;
      const c = addAudioClip(l.p, l.old, t.id, { sampleId: 3, start: 3840, len: 960 })!;
      deleteClips(l.p, l.old, [c.id]); // sample 3 is unused again: it uploads after the switch
      vi.useFakeTimers();
      const { d, started } = deps(l, { timeoutMs: undefined });
      const slow = {
        decodeAudioData: async (buf: ArrayBuffer) => {
          if (new Uint8Array(buf)[0] === 13) await new Promise((r) => setTimeout(r, 20_000));
          return fakeDecoder.decodeAudioData(buf);
        },
      };
      const start = d.start;
      d.start = async (h) => {
        const e = await start(h);
        e.context = slow as typeof fakeDecoder;
        return e;
      };
      let res: Awaited<ReturnType<typeof restartAudio>> | undefined;
      void restartAudio(l.p, 'playback', d).then((r) => (res = r));
      await vi.advanceTimersByTimeAsync(100);
      expect(res?.error).toBeNull();
      const e = started[0];
      const at = t.slot * 256 + c.idx;
      const sent = (op: number) => e.log.flatMap((x) => ('op' in x && x.op === op && x.args[0] === at ? [x] : []));
      l.h.undo(); // the clip is back, its sample not in the new engine yet
      expect(t.clips.map((x) => x.sampleId)).toEqual([3]);
      expect(sent(Op.AUDIO_CLIP_SET)).toHaveLength(1);
      const [version, dirty] = [l.p.version, l.p.dirty];
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await res!.later).toEqual([]);
      // Re-sent after the upload, staging AND commit (a SOURCE alone would only stage).
      const upload = e.log.findIndex((x) => 'sample' in x && x.sample === 3);
      expect(upload).toBeGreaterThan(-1);
      const tail = e.log.slice(upload + 1).flatMap((x) => ('op' in x && x.args[0] === at ? [x.op] : []));
      expect(tail).toEqual([Op.AUDIO_CLIP_SOURCE, Op.AUDIO_CLIP_GAIN, Op.AUDIO_CLIP_SET]);
      expect(sent(Op.AUDIO_CLIP_SOURCE).at(-1)!.args[1]).toBe(3);
      // The engine (modelled) has the clip committed on sample 3, which is uploaded: it plays.
      const m = run(blankModel(), e.log.flatMap((x) => ('op' in x ? [x] : [])));
      expect(m.errors).toEqual([]);
      expect(m.slots[t.slot]?.audio[c.idx]?.[0]).toBe(3);
      expect([l.p.version, l.p.dirty]).toEqual([version, dirty]); // catching the engine up is no edit
    });

    it('the restart counts the floats it uploads (the budget starts over with the new engine)', async () => {
      const l = await live();
      l.p.arenaFloats = MAX_ARENA_FLOATS; // the old engine was full of leaked samples
      const { d } = deps(l);
      const r = await restartAudio(l.p, 'interactive', d);
      await r!.later;
      // fakeAudio(n) decodes to n frames: used 10, 11, 12, 17 and the late unused 13.
      expect(l.p.arenaFloats).toBe(10 + 11 + 12 + 17 + 13);
      expect(l.p.sampleMeta.get(7)).toEqual({ seconds: 17 / 48000, channels: 1, peaks: null });
    });

    it('a late upload the engine parks (DEFERRED): counted, but bound only when it lands OK; a failure gives the floats back', async () => {
      for (const outcome of [Err.OK, Err.OUT_OF_MEMORY]) {
        const l = await live();
        const t = addAudioTrack(l.p, l.old)!;
        const c = addAudioClip(l.p, l.old, t.id, { sampleId: 3, start: 3840, len: 960 })!;
        deleteClips(l.p, l.old, [c.id]);
        let made!: Fake;
        const { d } = deps(l, {
          start: async () => {
            made = engineFor(l.steps, 'new', { sampleCode: (id) => (id === 3 ? Err.DEFERRED : Err.OK) });
            installSampleLoads(l.p, made as unknown as Parameters<typeof installSampleLoads>[1]);
            return made;
          },
        });
        const r = await restartAudio(l.p, 'interactive', d);
        l.h.undo(); // the clip is back on sample 3, which the engine has only parked
        expect(await r!.later).toEqual([]);
        const sets = () => made.log.filter((x) => 'op' in x && x.op === Op.AUDIO_CLIP_SET).length;
        const before = sets();
        const afterRestart = l.p.arenaFloats;
        expect(pendingSampleLoads()).toBe(1);
        (made as unknown as { onSampleLoaded(id: number, code: number): void }).onSampleLoaded(3, outcome); // Stop settles it
        if (outcome === Err.OK) {
          expect(l.p.arenaFloats).toBe(afterRestart);
          expect(sets()).toBe(before + 1); // bound now (never before)
        } else {
          expect(l.p.arenaFloats).toBe(afterRestart - 13); // reservation returned
          expect(sets()).toBe(before);
        }
        expect(pendingSampleLoads()).toBe(0);
      }
    });

    it('an unused sample nothing points at when it lands: nothing is re-sent', async () => {
      const l = await live();
      const { d, started } = deps(l);
      const r = await restartAudio(l.p, 'interactive', d);
      const before = started[0].log.filter((x) => 'op' in x).length;
      await r!.later;
      expect(started[0].log.filter((x) => 'op' in x).length).toBe(before);
    });

    it('an unused sample the new engine refuses for memory is dropped silently; another refusal is a warning', async () => {
      const l = await live();
      const { d } = deps(l, {
        start: async () => engineFor(l.steps, 'new', { sampleCode: (id) => (id === 3 ? Err.OUT_OF_MEMORY : Err.OK) }),
      });
      const r = await restartAudio(l.p, 'interactive', d);
      expect(r?.warnings).toEqual([]);
      expect(await r!.later).toEqual([]);

      const l2 = await live();
      const { d: d2 } = deps(l2, {
        start: async () => engineFor(l2.steps, 'new', { sampleCode: (id) => (id === 3 ? Err.BAD_VALUE : Err.OK) }),
      });
      const r2 = await restartAudio(l2.p, 'interactive', d2);
      expect(r2?.warnings).toEqual([]);
      const later = await r2!.later;
      expect(later).toHaveLength(1);
      expect(later[0]).toMatch(/unused\.wav/);
    });

    it('a session replaced before the unused samples land: they are not uploaded into it', async () => {
      const l = await live();
      let made!: Fake;
      const { d } = deps(l, {
        start: async () => (made = engineFor(l.steps, 'new')),
      });
      const r = await restartAudio(l.p, 'interactive', d);
      l.p.generation++; // an Open blanked the session before rest() decoded
      expect(await r!.later).toEqual([]);
      expect(made.log.some((x) => 'sample' in x && x.sample === 3)).toBe(false);
    });

    it('replay timeout scales with used sample bytes', async () => {
      const MB = 1024 * 1024;
      expect(replayTimeoutMs(0)).toBe(RESTART_TIMEOUT_MS);
      expect(replayTimeoutMs(25 * MB)).toBe(RESTART_TIMEOUT_MS + 1000);
      expect(replayTimeoutMs(100 * MB)).toBe(RESTART_TIMEOUT_MS + 4000);
      expect(replayTimeoutMs(250 * MB)).toBe(RESTART_TIMEOUT_MS + 10_000);

      // A used sample of 50 MB: the replay may take 10 s; the start still only 8.
      const run = async (uploadMs: number) => {
        vi.useRealTimers();
        const l = await live();
        const big = new Uint8Array(50 * MB);
        big[0] = 17;
        l.p.sampleFiles.set(7, await sampleFile('clap.wav', 'audio/wav', big.buffer));
        vi.useFakeTimers();
        const { d } = deps(l, { timeoutMs: undefined });
        const start = d.start;
        d.start = async (h) => {
          const e = await start(h);
          const load = e.loadSample.bind(e);
          e.loadSample = async (id, ch) => {
            if (id === 7) await new Promise((r) => setTimeout(r, uploadMs));
            return load(id, ch);
          };
          return e;
        };
        let res: Awaited<ReturnType<typeof restartAudio>> | undefined;
        void restartAudio(l.p, 'playback', d).then((r) => (res = r));
        await vi.advanceTimersByTimeAsync(12_000);
        return res;
      };
      expect((await run(9_500))?.error).toBeNull();
      expect((await run(10_500))?.error).toBe("Couldn't apply Playback: restoring the project did not finish within 10 s; kept previous settings");
    });
  });
});
