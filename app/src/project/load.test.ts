import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { moduleDef, paramIndex } from '../audio/catalog';
import { liveInputTrack } from '../state/actions';
import { Project } from '../state/project.svelte';
import type { SynthTrack } from '../state/project.svelte';
import { loadProject, ProjectLoadError } from './load';
import { sampleFile } from '../state/sampleFiles';
import { serialize } from './serialize';
import { buildFixture, checkLog, fakeAudio, fakeDecoder, fakeEngine } from './testFixture';
import type { ProjectJson } from './schema';

const roundJson = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** The fixture's sample files keyed by their project path (what readProject returns). */
function filesOf(json: ProjectJson, p: Project): Map<string, ArrayBuffer> {
  return new Map(json.samples.map((s) => [s.file, p.sampleFiles.get(s.id)!.bytes]));
}

describe('loadProject', () => {
  it('load replays commands in a valid order', async () => {
    const { p: src } = buildFixture();
    const json = roundJson(serialize(src));
    const p = new Project();
    p.playing = true; // loading while playing: STOP goes first
    const e = fakeEngine();
    const warnings = await loadProject(p, e, json, filesOf(json, src), fakeDecoder);
    expect(warnings).toEqual([]);
    const { errors } = checkLog([{ op: Op.PLAY, args: [0, 0, 0, 0] }, ...e.log]);
    expect(errors).toEqual([]);
    const ops = e.log.map((x) => ('op' in x ? x.op : -1));
    expect(ops.slice(0, 2)).toEqual([Op.STOP, Op.RESET_ALL]);
    // Load order: tracks (+ patterns, rack, samples) -> MIX_SET -> MIX_SET_KEY.
    const last = (op: number) => ops.lastIndexOf(op);
    const first = (op: number) => ops.indexOf(op);
    expect(last(Op.ADD_SYNTH_TRACK)).toBeLessThan(first(Op.MIX_SET));
    expect(last(Op.RACK_CONNECT)).toBeLessThan(first(Op.MIX_SET));
    expect(last(Op.MIX_SET)).toBeLessThan(first(Op.MIX_SET_KEY));
    expect(e.log.filter((x) => 'op' in x && x.op === Op.MIX_SET_KEY)).toHaveLength(2);
    // The state matches the source project: serializing it again gives the same JSON.
    expect(p.playing).toBe(false);
    expect(serialize(p)).toEqual(json);
    expect(p.name).toBe('Fixture');
    expect(p.nextSampleId).toBe(3);
    expect([...p.sampleFiles.keys()]).toEqual([0, 1, 2]);
  });

  it('after a load the engine matches the UI tempo/metronome/mode/loop/input track', async () => {
    const { p: src } = buildFixture();
    const json = roundJson(serialize(src));
    const p = new Project();
    const e = fakeEngine();
    await loadProject(p, e, json, filesOf(json, src), fakeDecoder);
    const { state } = checkLog(e.log);
    expect(state.tempo).toBe(p.tempo);
    expect(state.metronome).toBe(p.metronome);
    expect(state.song).toBe(p.mode === 'song');
    expect(state.loop).toEqual(p.loop.on ? [p.loop.start, p.loop.end] : [0, 0]);
    expect(state.input).toBe(liveInputTrack(p)?.slot ?? -1);
    expect(liveInputTrack(p)?.name).toBe('Bass');
    expect(p.tracks.find((t) => t.id === p.selectedTrackId)?.name).toBe('Drums');
    // Defaults are sent too (RESET_ALL already set them, but say so explicitly).
    const blank = roundJson(serialize(new Project()));
    const e2 = fakeEngine();
    await loadProject(new Project(), e2, blank, new Map(), fakeDecoder);
    const ops = e2.log.map((x) => ('op' in x ? x.op : -1));
    for (const op of [Op.SET_TEMPO, Op.SET_METRONOME, Op.SET_MODE, Op.SET_LOOP, Op.SET_INPUT_TRACK]) expect(ops).toContain(op);
  });

  it('uploads samples only after the reset ack', async () => {
    const { p: src } = buildFixture();
    const json = roundJson(serialize(src));
    const e = fakeEngine({ holdReset: true });
    const done = loadProject(new Project(), e, json, filesOf(json, src), fakeDecoder);
    for (let i = 0; i < 10; i++) await Promise.resolve(); // let decoding finish
    await new Promise((r) => setTimeout(r, 0));
    expect(e.log.some((x) => 'sample' in x)).toBe(false);
    expect(e.log.some((x) => 'op' in x && x.op === Op.RESET_ALL)).toBe(true);
    e.ack(0);
    await done;
    const iReset = e.log.findIndex((x) => 'op' in x && x.op === Op.RESET_ALL);
    const iSample = e.log.findIndex((x) => 'sample' in x);
    expect(iSample).toBeGreaterThan(iReset);
  });

  it('a refused or missing reset ack fails the load with an error', async () => {
    const { p: src } = buildFixture();
    const json = roundJson(serialize(src));
    const e = fakeEngine({ holdReset: true });
    const done = loadProject(new Project(), e, json, filesOf(json, src), fakeDecoder);
    await new Promise((r) => setTimeout(r, 0));
    e.ack(-3);
    await expect(done).rejects.toBeInstanceOf(ProjectLoadError);
    expect(e.log.some((x) => 'sample' in x)).toBe(false);
  });

  it('an invalid project changes nothing', async () => {
    const { p } = buildFixture();
    const before = serialize(p);
    const e = fakeEngine();
    await expect(loadProject(p, e, { schemaVersion: 99 }, new Map(), fakeDecoder)).rejects.toThrow(/newer/);
    expect(e.log).toEqual([]);
    expect(serialize(p)).toEqual(before);
  });

  it('load tolerates missing samples', async () => {
    const { p: src } = buildFixture();
    const json = roundJson(serialize(src));
    const files = filesOf(json, src);
    files.delete(json.samples[0].file); // gone from the folder
    files.set(json.samples[1].file, new ArrayBuffer(0)); // undecodable
    const p = new Project();
    const e = fakeEngine();
    const warnings = await loadProject(p, e, json, files, fakeDecoder);
    expect(warnings.join('\n')).toMatch(/kick\.wav/);
    expect(warnings.join('\n')).toMatch(/snare\.wav/);
    expect(checkLog(e.log).errors).toEqual([]);
    const d = p.tracks[0];
    if (d.kind !== 'drum') throw new Error('kind');
    expect(d.rows[0].sampleId).toBeNull();
    expect(d.rows[1].sampleId).toBeNull();
    // The one that loaded got compact id 0, and the SamplePlayer follows it.
    expect(e.log.filter((x) => 'sample' in x)).toEqual([{ sample: 0 }]);
    const s = p.tracks[1] as SynthTrack;
    const sp = s.modules.find((m) => m.kind === moduleDef('sample_player').kind)!;
    expect(sp.params[paramIndex(moduleDef('sample_player'), 'sample')]).toBe(0);
    expect([...p.sampleFiles.keys()]).toEqual([0]);
    expect(p.nextSampleId).toBe(1);
  });

  it('reassigns sample ids compactly and remaps SamplePlayer params', async () => {
    const { p: src, drums, synth } = buildFixture();
    // Burned ids: 7 on the kick row, 12 on the SamplePlayer, 40 not in the folder.
    src.sampleFiles.set(7, sampleFile('kick.wav', 'audio/wav', fakeAudio(9)));
    src.sampleFiles.set(12, sampleFile('vox.wav', 'audio/wav', fakeAudio(9)));
    drums.rows[0].sampleId = 7;
    const spIdx = synth.modules.find((m) => m.kind === moduleDef('sample_player').kind)!.idx;
    synth.modules.find((m) => m.idx === spIdx)!.params[paramIndex(moduleDef('sample_player'), 'sample')] = 12;
    const json = roundJson(serialize(src));
    expect(json.samples.map((s) => s.id)).toEqual([1, 7, 12]);
    const dj = json.tracks[0];
    if (dj.kind !== 'drum') throw new Error('kind');
    dj.rows[2].sample = 40; // not in the project's sample list
    const p = new Project();
    const e = fakeEngine();
    const warnings = await loadProject(p, e, json, filesOf(json, src), fakeDecoder);
    expect(warnings.join('\n')).toMatch(/sample 40/);
    const d = p.tracks[0];
    if (d.kind !== 'drum') throw new Error('kind');
    expect(d.rows.map((r) => r.sampleId)).toEqual([1, 0, null, null, null]);
    const sp = (p.tracks[1] as SynthTrack).modules.find((m) => m.idx === spIdx)!;
    expect(sp.params[paramIndex(moduleDef('sample_player'), 'sample')]).toBe(2);
    expect(checkLog(e.log).errors).toEqual([]);
  });

  it('pooled effects beyond the FX pool are dropped with a warning', async () => {
    const { p: src } = buildFixture();
    const json = roundJson(serialize(src));
    const synth = json.tracks[2];
    if (synth.kind !== 'synth') throw new Error('kind');
    // 9 more reverbs on the second synth (the first synth already has one): 2 too many.
    for (let i = 0; i < 9; i++) synth.patch.modules.push({ idx: 20 + i, id: 'reverb', params: {} });
    const p = new Project();
    const e = fakeEngine();
    const warnings = await loadProject(p, e, json, filesOf(json, src), fakeDecoder);
    expect(warnings.filter((w) => /reverb/i.test(w))).toHaveLength(2);
    const reverbs = p.tracks.flatMap((t) => (t.kind === 'synth' ? t.modules : [])).filter((m) => m.kind === moduleDef('reverb').kind);
    expect(reverbs).toHaveLength(8);
    expect(checkLog(e.log).errors).toEqual([]);
  });

  it('a sidechain key the engine cannot take is dropped with a warning', async () => {
    const { p: src } = buildFixture();
    const json = roundJson(serialize(src));
    // A drum row that does not exist (the drums have 5 rows): dropped.
    json.mixer.tracks[2].key = { track: json.tracks[0].slot, row: 9 };
    const p = new Project();
    const warnings = await loadProject(p, fakeEngine(), json, filesOf(json, src), fakeDecoder);
    expect(warnings.join('\n')).toMatch(/key/i);
    expect(p.mixer.channels[p.tracks[2].id].key).toBeNull();
  });

  it('a failed load leaves no folder to save over (fix 1)', async () => {
    const { p: src } = buildFixture();
    const json = roundJson(serialize(src));
    const p = new Project();
    p.folder = { name: 'Old Song' } as FileSystemDirectoryHandle;
    const e = fakeEngine({ holdReset: true });
    const done = loadProject(p, e, json, filesOf(json, src), fakeDecoder);
    await new Promise((r) => setTimeout(r, 0));
    e.ack(-3);
    await expect(done).rejects.toBeInstanceOf(ProjectLoadError);
    expect(p.folder).toBeNull();
    expect(p.loading).toBe(false);
    // A failure before anything changed (invalid file) keeps the folder.
    const q = new Project();
    q.folder = { name: 'Old Song' } as FileSystemDirectoryHandle;
    await expect(loadProject(q, fakeEngine(), { schemaVersion: 7 }, new Map(), fakeDecoder)).rejects.toThrow();
    expect(q.folder).not.toBeNull();
  });

  it('p.loading is set while the session is being replaced (fix 3)', async () => {
    const { p: src } = buildFixture();
    const json = roundJson(serialize(src));
    const p = new Project();
    const e = fakeEngine({ holdReset: true });
    const done = loadProject(p, e, json, filesOf(json, src), fakeDecoder);
    await new Promise((r) => setTimeout(r, 0));
    expect(p.loading).toBe(true);
    e.ack(0);
    await done;
    expect(p.loading).toBe(false);
  });

  it('beforeLoad runs after validation and decoding, right before STOP (fix 4)', async () => {
    const { p: src } = buildFixture();
    const json = roundJson(serialize(src));
    const order: string[] = [];
    const decoder = {
      decodeAudioData: async (b: ArrayBuffer) => (order.push('decode'), fakeDecoder.decodeAudioData(b)),
    } as typeof fakeDecoder;
    const e = fakeEngine();
    const send = e.send.bind(e);
    e.send = (op: number, ...a: number[]) => (order.push(`op${op}`), send(op, ...a));
    await loadProject(new Project(), e, json, filesOf(json, src), decoder, { beforeLoad: () => order.push('before') });
    expect(order.slice(0, 5)).toEqual(['decode', 'decode', 'decode', 'before', `op${Op.STOP}`]);
    // Never for a file that does not validate.
    let called = false;
    await expect(loadProject(new Project(), fakeEngine(), {}, new Map(), fakeDecoder, { beforeLoad: () => (called = true) })).rejects.toThrow();
    expect(called).toBe(false);
  });
});
