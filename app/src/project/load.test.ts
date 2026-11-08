import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { moduleDef, paramIndex } from '../audio/catalog';
import { liveInputTrack } from '../state/actions';
import { Project } from '../state/project.svelte';
import type { SynthTrack } from '../state/project.svelte';
import { bindingCommands, loadProject, ProjectLoadError, units } from './load';
import { addLane, addPoint } from '../state/automation-actions';
import { projectCommands } from './commands';
import { createHistory } from '../history/history';
import { setTempo } from '../state/actions';
import { sampleFile } from '../state/sampleFiles';
import { serialize } from './serialize';
import { libraryJson, libraryState, savePatternToLibrary } from '../state/pattern-library';
import { addAudioFixture, addAutomationFixture, buildFixture, checkLog, fakeAudio, fakeDecoder, fakeEngine, nullSink } from './testFixture';
import { readFileSync } from 'node:fs';
import type { ProjectJson } from './schema';
import { withAppendedParams } from './testdata/appendedParams';
import { learnMidi } from '../state/midiMap';
import { laneValueAt } from '../state/automation';
import { mixParam } from '../audio/mixerCatalog';

const roundJson = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** The fixture's sample files keyed by their project path (what readProject returns). */
function filesOf(json: ProjectJson, p: Project): Map<string, ArrayBuffer> {
  return new Map(json.samples.map((s) => [s.file, p.sampleFiles.get(s.id)!.bytes]));
}

describe('loadProject', () => {
  it('load replays commands in a valid order', async () => {
    const { p: src } = await buildFixture();
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

  it('projectCommands is the replay a load sends, without a Project (plan-7 one builder)', async () => {
    const { p: src } = await buildFixture();
    const json = roundJson(serialize(src));
    const e = fakeEngine();
    await loadProject(new Project(), e, json, filesOf(json, src), fakeDecoder);
    const lastSample = e.log.map((x) => 'sample' in x).lastIndexOf(true);
    const afterSamples = e.log.slice(lastSample + 1);
    const pc = projectCommands(json, new Map(json.samples.map((s) => [s.id, s.id])));
    expect(pc.commands.map(([op, a = 0, b = 0, c = 0, d = 0]) => ({ op, args: [a, b, c, d] }))).toEqual(afterSamples);
    expect(pc.samples.map((s) => s.id)).toEqual([0, 1, 2]);
    expect(pc.project).toEqual(json);
    expect(pc.warnings).toEqual([]);
  });

  it('projectCommands includes audio tracks', async () => {
    const { p: src } = await buildFixture();
    const { ids } = await addAudioFixture(src);
    const json = roundJson(serialize(src));
    expect(json.samples.map((s) => s.id)).toEqual([0, 1, 2, ...ids]); // audio-clip samples are listed
    const p = new Project();
    const e = fakeEngine();
    expect(await loadProject(p, e, json, filesOf(json, src), fakeDecoder)).toEqual([]);
    // Nothing addressed to a missing sample or slot, every clip staged before its commit.
    expect(checkLog(e.log).errors).toEqual([]);
    expect(serialize(p)).toEqual(json);
    const ops = e.log.flatMap((x) => ('op' in x ? [x] : []));
    const audio = json.tracks.filter((t) => t.kind === 'audio');
    expect(audio.map((t) => t.name)).toEqual(['Loop', 'Vox']);
    for (const t of audio) {
      const add = ops.findIndex((x) => x.op === Op.ADD_AUDIO_TRACK && x.args[0] === t.slot);
      expect(add).toBeGreaterThanOrEqual(0);
      for (const c of t.kind === 'audio' ? t.clips : []) {
        const at = ops.findIndex((x) => x.op === Op.AUDIO_CLIP_SOURCE && x.args[0] === t.slot * 256 + c.idx);
        expect(at).toBeGreaterThan(add);
        expect(ops.slice(at, at + 3).map((x) => x.op)).toEqual([Op.AUDIO_CLIP_SOURCE, Op.AUDIO_CLIP_GAIN, Op.AUDIO_CLIP_SET]);
        expect(ops[at].args[1]).toBe(c.sample ?? -1);
        expect(ops[at + 2].args.slice(1, 3)).toEqual([c.start, c.len]);
      }
    }
    // The sidechain from an Audio track (whole track) goes last, with the other keys.
    expect(ops.filter((x) => x.op === Op.MIX_SET_KEY)).toHaveLength(3);
    expect(p.sampleMeta.get(ids[1])).toMatchObject({ channels: 1, peaks: { framesPerPeak: 256 } }); // what the (fake) decode gave; peaks before the upload
    expect(p.sampleMeta.get(ids[1])!.peaks!.levels[0]).toHaveLength(1);

    // A clip whose sample is missing from the folder is kept as "missing sample" (-1), with a warning.
    const files = filesOf(json, src);
    files.delete(json.samples.find((s) => s.id === ids[1])!.file);
    const q = new Project();
    const e2 = fakeEngine();
    const w = await loadProject(q, e2, json, files, fakeDecoder);
    expect(w).toEqual([expect.stringMatching(/vox\.wav.*missing/)]);
    expect(checkLog(e2.log).errors).toEqual([]);
    const vox = q.tracks.find((t) => t.name === 'Vox');
    expect(vox?.kind === 'audio' && vox.clips.map((c) => c.sampleId)).toEqual([null]);
    expect(e2.log.some((x) => 'op' in x && x.op === Op.AUDIO_CLIP_SOURCE && x.args[1] === -1 && x.args[0] === vox!.slot * 256)).toBe(true);
  });

  it('a load clears the undo history (undo never crosses sessions)', async () => {
    const { p: src } = await buildFixture();
    const json = roundJson(serialize(src));
    const p = new Project();
    p.history = createHistory({ snapshot: () => serialize(p), apply: () => {} });
    setTempo(p, nullSink, 99);
    expect(p.history.canUndo).toBe(true);
    await loadProject(p, fakeEngine(), json, filesOf(json, src), fakeDecoder);
    expect([p.history.canUndo, p.history.canRedo]).toEqual([false, false]);
  });

  it('after a load the engine matches the UI tempo/metronome/mode/loop/input track', async () => {
    const { p: src } = await buildFixture();
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
    // The selected drum track is the input (plan 15); the last synth stays Bass.
    expect(liveInputTrack(p)?.name).toBe('Drums');
    expect(p.tracks.find((t) => t.id === p.selectedTrackId)?.name).toBe('Drums');
    expect(p.tracks.find((t) => t.id === p.lastSynthTrackId)?.name).toBe('Bass');
    // Defaults are sent too (RESET_ALL already set them, but say so explicitly).
    const blank = roundJson(serialize(new Project()));
    const e2 = fakeEngine();
    await loadProject(new Project(), e2, blank, new Map(), fakeDecoder);
    const ops = e2.log.map((x) => ('op' in x ? x.op : -1));
    for (const op of [Op.SET_TEMPO, Op.SET_METRONOME, Op.SET_MODE, Op.SET_LOOP, Op.SET_INPUT_TRACK]) expect(ops).toContain(op);
  });

  it('uploads samples only after the reset ack', async () => {
    const { p: src } = await buildFixture();
    const json = roundJson(serialize(src));
    const e = fakeEngine({ holdReset: true });
    const done = loadProject(new Project(), e, json, filesOf(json, src), fakeDecoder);
    await e.untilReset(); // decoding, hashing and ensureRunning are done
    expect(e.log.some((x) => 'sample' in x)).toBe(false);
    expect(e.log.some((x) => 'op' in x && x.op === Op.RESET_ALL)).toBe(true);
    e.ack(0);
    await done;
    const iReset = e.log.findIndex((x) => 'op' in x && x.op === Op.RESET_ALL);
    const iSample = e.log.findIndex((x) => 'sample' in x);
    expect(iSample).toBeGreaterThan(iReset);
  });

  it('a refused or missing reset ack fails the load with an error', async () => {
    const { p: src } = await buildFixture();
    const json = roundJson(serialize(src));
    const e = fakeEngine({ holdReset: true });
    const done = loadProject(new Project(), e, json, filesOf(json, src), fakeDecoder);
    await e.untilReset();
    e.ack(-3);
    await expect(done).rejects.toBeInstanceOf(ProjectLoadError);
    expect(e.log.some((x) => 'sample' in x)).toBe(false);
  });

  it('a paused AudioContext fails the load before anything is blanked (M6)', async () => {
    const { p: src } = await buildFixture();
    const json = roundJson(serialize(src));
    const { p } = await buildFixture();
    p.folder = {} as FileSystemDirectoryHandle;
    const before = serialize(p);
    const e = fakeEngine({ audioRunning: false });
    let before_ = 0;
    await expect(loadProject(p, e, json, filesOf(json, src), fakeDecoder, { beforeLoad: () => before_++ })).rejects.toThrow(
      'Audio is paused — click to start audio, then open again',
    );
    expect(before_).toBe(0);
    expect(e.log).toEqual([]); // no STOP, no RESET_ALL
    expect(serialize(p)).toEqual(before);
    expect(p.folder).not.toBeNull(); // the session is intact: Save still goes to its folder
    expect(p.loading).toBe(false);
  });

  it('an invalid project changes nothing', async () => {
    const { p } = await buildFixture();
    const before = serialize(p);
    const e = fakeEngine();
    await expect(loadProject(p, e, { schemaVersion: 99 }, new Map(), fakeDecoder)).rejects.toThrow(/newer/);
    expect(e.log).toEqual([]);
    expect(serialize(p)).toEqual(before);
  });

  it('load tolerates missing samples', async () => {
    const { p: src } = await buildFixture();
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
    const { p: src, drums, synth } = await buildFixture();
    // Burned ids: 7 on the kick row, 12 on the SamplePlayer, 40 not in the folder.
    src.sampleFiles.set(7, await sampleFile('kick.wav', 'audio/wav', fakeAudio(9)));
    src.sampleFiles.set(12, await sampleFile('vox.wav', 'audio/wav', fakeAudio(9)));
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
    const { p: src } = await buildFixture();
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

  it('projectCommands emits lanes after keys', async () => {
    const { p: src } = await buildFixture();
    await addAudioFixture(src);
    const lanes = addAutomationFixture(src);
    const json = roundJson(serialize(src));
    const p = new Project();
    const e = fakeEngine();
    expect(await loadProject(p, e, json, filesOf(json, src), fakeDecoder)).toEqual([]);
    // checkLog: every lane target exists and is automatable, ticks are unique, values in range, lanes after everything else.
    expect(checkLog(e.log).errors).toEqual([]);
    expect(serialize(p)).toEqual(json);
    const ops = e.log.flatMap((x) => ('op' in x ? [x] : []));
    const at = (op: number) => ops.map((x) => x.op).indexOf(op);
    const lastOf = (op: number) => ops.map((x) => x.op).lastIndexOf(op);
    expect(lastOf(Op.MIX_SET_KEY)).toBeLessThan(at(Op.AUTO_LANE_SET));
    expect(lastOf(Op.AUTO_LANE_ENABLE)).toBeLessThan(at(Op.SET_TEMPO));
    // Per lane: AUTO_LANE_SET, its points (idx = position in the JSON), then AUTO_LANE_ENABLE.
    const auto = ops.slice(at(Op.AUTO_LANE_SET), lastOf(Op.AUTO_LANE_ENABLE) + 1);
    expect(auto.map((x) => x.op)).toEqual([
      Op.AUTO_LANE_SET, Op.AUTO_POINT_SET, Op.AUTO_POINT_SET, Op.AUTO_LANE_ENABLE, // Drums send A
      Op.AUTO_LANE_SET, Op.AUTO_POINT_SET, Op.AUTO_POINT_SET, Op.AUTO_POINT_SET, Op.AUTO_LANE_ENABLE, // Bass fader
      Op.AUTO_LANE_SET, Op.AUTO_POINT_SET, Op.AUTO_POINT_SET, Op.AUTO_LANE_ENABLE, // Bass cutoff
      Op.AUTO_LANE_SET, Op.AUTO_POINT_SET, Op.AUTO_POINT_SET, Op.AUTO_LANE_ENABLE, // Master ceiling (disabled)
    ]);
    const bassSlot = json.tracks.find((t) => t.name === 'Bass')!.slot;
    expect(auto[4].args).toEqual([lanes.fader.lane, 1, bassSlot, 0]);
    expect(auto[5].args).toEqual([lanes.fader.lane * 512, 0, -24, 0]);
    expect(auto[6].args).toEqual([lanes.fader.lane * 512 + 1, 3840, 0, 1]);
    expect(auto[9].args).toEqual([lanes.cutoff.lane, 2, bassSlot, 4 * 16 + paramIndex(moduleDef('filter'), 'cutoff')]);
    expect(auto.at(-1)!.args).toEqual([lanes.ceiling.lane, 0, 0, 0]);
    // The state: lanes with their points sorted by tick, the Master row's lane in the mixer.
    const bass = p.tracks.find((t) => t.name === 'Bass')!;
    expect(bass.automation.map((l) => l.target)).toEqual([{ kind: 'mix', param: 'fader' }, { kind: 'rack', module: 4, param: 'cutoff' }]);
    expect(p.mixer.automation.map((x) => [x.channel, x.lane.enabled])).toEqual([['master', false]]);
    // Restarting the audio replays the same lanes: projectCommands of the live project.
    const again = projectCommands(serialize(p), new Map(json.samples.map((s) => [s.id, s.id])));
    expect(again.commands.filter((c) => c[0] >= Op.AUTO_LANE_SET && c[0] <= Op.AUTO_LANE_ENABLE).map(([op, a = 0, b = 0, c = 0, d = 0]) => [op, a, b, c, d]))
      .toEqual(auto.map((x) => [x.op, ...x.args]));
  });

  it('a curved lane loads through the checked engine: SET, then CURVE (plan 16)', async () => {
    const { p: src } = await buildFixture();
    const lanes = addAutomationFixture(src);
    lanes.cutoff.points[0].curve = -0.25;
    const json = roundJson(serialize(src));
    const p = new Project();
    const e = fakeEngine();
    expect(await loadProject(p, e, json, filesOf(json, src), fakeDecoder)).toEqual([]);
    expect(checkLog(e.log).errors).toEqual([]);
    expect(serialize(p)).toEqual(json);
    const ops = e.log.flatMap((x) => ('op' in x ? [x] : []));
    const k = ops.findIndex((x) => x.op === Op.AUTO_POINT_CURVE);
    expect(ops[k - 1]).toEqual({ op: Op.AUTO_POINT_SET, args: [lanes.cutoff.lane * 512, 0, 200, 0] });
    expect(ops[k].args).toEqual([lanes.cutoff.lane * 512, -0.25, 0, 0]);
    // The checker refuses what the engine refuses: a curve on an inactive point, or past -1..1.
    const bad = (args: number[]) => checkLog([...e.log, { op: Op.AUTO_POINT_CURVE, args }]).errors;
    expect(bad([lanes.cutoff.lane * 512 + 40, 0.5, 0, 0])).toHaveLength(1);
    expect(bad([lanes.cutoff.lane * 512, 1.5, 0, 0])).toHaveLength(1);
    expect(bad([lanes.cutoff.lane * 512 + 1, -1, 0, 0])).toEqual([]);
  });

  it('an old project\'s volume and send lanes load unchanged; only the in-between follows the fader taper (plan 19)', async () => {
    // The frozen v3 file (before plan 19): a Drums send A fade-in and a Bass fader ride, in dB.
    const v3 = JSON.parse(readFileSync(new URL('./testdata/v3-fixture.json', import.meta.url), 'utf8'));
    const p = new Project();
    const e = fakeEngine();
    await loadProject(p, e, v3, new Map(), fakeDecoder); // its samples are not here: warnings only
    const json = roundJson(serialize(p));
    for (const name of ['Drums', 'Bass']) {
      const was = v3.tracks.find((t: { name: string }) => t.name === name).automation;
      expect(json.tracks.find((t) => t.name === name)!.automation, name).toEqual(was); // same points, same dB
    }
    // The engine gets the same dB values (no schema change, no conversion).
    const bass = p.tracks.find((t) => t.name === 'Bass')!;
    const fader = bass.automation.find((l) => l.target.kind === 'mix')!;
    const sets = e.log.flatMap((x) => ('op' in x && x.op === Op.AUTO_POINT_SET && Math.floor(x.args[0] / 512) === fader.lane ? [x.args[2]] : []));
    expect(sets).toEqual([-24, 0, -60]);
    // In between: half way from -24 dB to 0 dB is half way in fader travel
    // (0.328 -> 0.75: 0.539, -10.65 dB), not the -12 dB of a linear-dB line.
    const mid = laneValueAt(fader.points, 1920, mixParam('fader'))!;
    expect(mid).toBeCloseTo(-10 - (10 * (0.55 - (0.328 + 0.75) / 2)) / 0.17, 9);
    const drums = p.tracks.find((t) => t.name === 'Drums')!;
    expect(laneValueAt(drums.automation[0].points, 3840, mixParam('send_a'))).toBeCloseTo(-30 + (10 * 0.125) / 0.13, 9);
  });

  it('units() keeps each lane whole: AUTO_LANE_SET, its points, AUTO_LANE_ENABLE', async () => {
    const { p: src } = await buildFixture();
    await addAudioFixture(src);
    const fx = addAutomationFixture(src);
    fx.fader.points[0].curve = 0.5; // plan 16: a curved point replays SET, then CURVE, inside its lane's unit
    const json = roundJson(serialize(src));
    const cmds = projectCommands(json, new Map(json.samples.map((s) => [s.id, s.id]))).commands;
    const us = units(cmds);
    expect(us.flat()).toEqual(cmds); // nothing lost, nothing reordered
    const lanes = us.filter((u) => u[0][0] === Op.AUTO_LANE_SET);
    expect(lanes.map((u) => u.map((c) => c[0]))).toEqual([
      [Op.AUTO_LANE_SET, Op.AUTO_POINT_SET, Op.AUTO_POINT_SET, Op.AUTO_LANE_ENABLE],
      [Op.AUTO_LANE_SET, Op.AUTO_POINT_SET, Op.AUTO_POINT_CURVE, Op.AUTO_POINT_SET, Op.AUTO_POINT_SET, Op.AUTO_LANE_ENABLE],
      [Op.AUTO_LANE_SET, Op.AUTO_POINT_SET, Op.AUTO_POINT_SET, Op.AUTO_LANE_ENABLE],
      [Op.AUTO_LANE_SET, Op.AUTO_POINT_SET, Op.AUTO_POINT_SET, Op.AUTO_LANE_ENABLE],
    ]);
    const perPoint = (op: number) => op === Op.AUTO_POINT_SET || op === Op.AUTO_POINT_CURVE;
    for (const u of lanes) for (const c of u.slice(1)) expect(Math.floor((perPoint(c[0]) ? c[1]! / 512 : c[1]!))).toBe(u[0][1]);
    // No lane command is left outside its lane's unit; an audio clip's triple stays one unit too.
    const laneOp = (op: number) => (op >= Op.AUTO_POINT_SET && op <= Op.AUTO_LANE_ENABLE) || op === Op.AUTO_POINT_CURVE;
    expect(us.filter((u) => u.length === 1 && laneOp(u[0][0]))).toEqual([]);
    expect(us.filter((u) => u[0][0] === Op.AUDIO_CLIP_SOURCE).every((u) => u.map((c) => c[0]).join() === [Op.AUDIO_CLIP_SOURCE, Op.AUDIO_CLIP_GAIN, Op.AUDIO_CLIP_SET].join())).toBe(true);
    // A lane without points is one unit of SET + ENABLE; two lanes in a row never merge.
    expect(units([[Op.AUTO_LANE_SET, 0, 1, 0, 0], [Op.AUTO_LANE_ENABLE, 0, 1], [Op.AUTO_LANE_SET, 1, 1, 1, 0], [Op.AUTO_POINT_SET, 512, 0, 0, 0], [Op.AUTO_LANE_ENABLE, 1, 0]]))
      .toEqual([[[Op.AUTO_LANE_SET, 0, 1, 0, 0], [Op.AUTO_LANE_ENABLE, 0, 1]], [[Op.AUTO_LANE_SET, 1, 1, 1, 0], [Op.AUTO_POINT_SET, 512, 0, 0, 0], [Op.AUTO_LANE_ENABLE, 1, 0]]]);
    // Another lane's CURVE ends the unit (never seen in a replay, but a lane never takes a foreign point).
    expect(units([[Op.AUTO_LANE_SET, 0, 1, 0, 0], [Op.AUTO_POINT_SET, 0, 0, 0, 0], [Op.AUTO_POINT_CURVE, 512, 0.5, 0, 0]]).map((u) => u.length)).toEqual([2, 1]);
  });

  it('bindingCommands re-sends a SamplePlayer\'s sample, never the lanes on its track', async () => {
    const { p, synth } = await buildFixture();
    const sp = synth.modules.find((m) => m.kind === moduleDef('sample_player').kind)!;
    // Lanes on the SamplePlayer's own gain and on the track's fader.
    const gain = addLane(p, nullSink, synth.id, { kind: 'rack', module: sp.idx, param: 'gain' })!;
    addPoint(p, nullSink, gain.id, { tick: 0, value: 0.2 });
    addPoint(p, nullSink, gain.id, { tick: 3840, value: 0.9 });
    const fader = addLane(p, nullSink, synth.id, { kind: 'mix', param: 'fader' })!;
    addPoint(p, nullSink, fader.id, { tick: 960, value: -6 });
    const out = bindingCommands(p, 2); // sample 2: only the SamplePlayer uses it
    expect(out).toEqual([[Op.RACK_SET_PARAM, synth.slot, sp.idx, paramIndex(moduleDef('sample_player'), 'sample'), 2]]);
    expect(out.some((c) => c[0] >= Op.AUTO_LANE_SET && c[0] <= Op.AUTO_OVERRIDE)).toBe(false);
  });

  it('a lane on a module the FX pool drops goes with it', async () => {
    const { p: src } = await buildFixture();
    const json = roundJson(serialize(src));
    const synth = json.tracks[2];
    if (synth.kind !== 'synth') throw new Error('kind');
    for (let i = 0; i < 9; i++) synth.patch.modules.push({ idx: 20 + i, id: 'reverb', params: {} });
    synth.automation.push({ lane: 5, enabled: true, target: { rack: [28, 'size'] }, points: [[0, 0.5, 0]] }); // a dropped reverb
    synth.automation.push({ lane: 6, enabled: true, target: { rack: [20, 'size'] }, points: [[0, 0.5, 0]] }); // a kept one
    const p = new Project();
    const e = fakeEngine();
    const warnings = await loadProject(p, e, json, filesOf(json, src), fakeDecoder);
    expect(warnings.filter((w) => /automation/i.test(w))).toHaveLength(1);
    expect(checkLog(e.log).errors).toEqual([]);
    expect(p.tracks[2].automation.map((l) => l.lane)).toEqual([6]);
  });

  it('a v2 project loads and saves as v5', async () => {
    const v2 = JSON.parse(readFileSync(new URL('./testdata/v2-fixture.json', import.meta.url), 'utf8'));
    const { p: src } = await buildFixture();
    const { ids } = await addAudioFixture(src);
    // The fixture's sample files (same ids and content hashes as when it was frozen).
    const files = new Map<string, ArrayBuffer>((v2.samples as { id: number; file: string }[]).map((s) => [s.file, src.sampleFiles.get(s.id)!.bytes]));
    expect(ids).toEqual([3, 4]);
    const p = new Project();
    const e = fakeEngine();
    expect(await loadProject(p, e, v2, files, fakeDecoder)).toEqual([]);
    expect(checkLog(e.log).errors).toEqual([]);
    const out = serialize(p);
    expect(out.schemaVersion).toBe(5);
    // Params appended to the catalog since are written with their defaults.
    expect(out).toEqual({
      ...v2,
      schemaVersion: 5,
      tracks: v2.tracks.map((t: object) => ({ ...withAppendedParams(t), automation: [] })),
      mixer: { ...v2.mixer, automation: [] },
      midiMap: [],
      patternLibrary: [],
    });
  });

  it('the pattern library survives a save and reopen; a load replaces the old session\'s', async () => {
    const { p: src, drums, synth } = await buildFixture();
    savePatternToLibrary(src, drums.id, drums.currentPatternId, 'Groove');
    savePatternToLibrary(src, synth.id, synth.currentPatternId, 'Bass');
    const json = roundJson(serialize(src));
    const p = new Project();
    p.patternLibrary = libraryState([{ kind: 'synth', name: 'Old', bars: 1, notes: [] }]);
    expect(await loadProject(p, fakeEngine(), json, filesOf(json, src), fakeDecoder)).toEqual([]);
    expect(p.patternLibrary.map(libraryJson)).toEqual(src.patternLibrary.map(libraryJson));
    expect(roundJson(serialize(p)).patternLibrary).toEqual(json.patternLibrary);
  });

  it('MIDI mappings survive a save and reopen (by slot, onto the new track ids)', async () => {
    const { p: src, synth, drums } = await buildFixture();
    learnMidi(src, 74, synth.id, { kind: 'rack', module: 4, param: 'cutoff' });
    learnMidi(src, 7, drums.id, { kind: 'mix', param: 'fader' });
    learnMidi(src, 10, 'delay', { kind: 'mix', param: 'delay_feedback' });
    const json = roundJson(serialize(src));
    const p = new Project();
    p.midiMap = [{ cc: 1, owner: 'master', target: { kind: 'mix', param: 'fader' } }]; // the old session's: gone
    expect(await loadProject(p, fakeEngine(), json, filesOf(json, src), fakeDecoder)).toEqual([]);
    const bySlot = (slot: number) => p.tracks.find((t) => t.slot === slot)!.id;
    expect(p.midiMap).toEqual([
      { cc: 74, owner: bySlot(synth.slot), target: { kind: 'rack', module: 4, param: 'cutoff' } },
      { cc: 7, owner: bySlot(drums.slot), target: { kind: 'mix', param: 'fader' } },
      { cc: 10, owner: 'delay', target: { kind: 'mix', param: 'delay_feedback' } },
    ]);
    expect(serialize(p).midiMap).toEqual(json.midiMap);
  });

  it('a MIDI mapping on a module the FX pool drops goes with it', async () => {
    const { p: src } = await buildFixture();
    const json = roundJson(serialize(src));
    const synth = json.tracks[2];
    if (synth.kind !== 'synth') throw new Error('kind');
    for (let i = 0; i < 9; i++) synth.patch.modules.push({ idx: 20 + i, id: 'reverb', params: {} });
    json.midiMap = [
      { cc: 20, track: synth.slot, target: { rack: [28, 'size'] } }, // a dropped reverb
      { cc: 21, track: synth.slot, target: { rack: [20, 'size'] } }, // a kept one
    ];
    const p = new Project();
    const warnings = await loadProject(p, fakeEngine(), json, filesOf(json, src), fakeDecoder);
    expect(warnings.filter((w) => /MIDI/.test(w))).toHaveLength(1);
    expect(p.midiMap.map((m) => m.cc)).toEqual([21]);
  });

  it('a sidechain key the engine cannot take is dropped with a warning', async () => {
    const { p: src } = await buildFixture();
    const json = roundJson(serialize(src));
    // A drum row that does not exist (the drums have 5 rows): dropped.
    json.mixer.tracks[2].key = { track: json.tracks[0].slot, row: 9 };
    const p = new Project();
    const warnings = await loadProject(p, fakeEngine(), json, filesOf(json, src), fakeDecoder);
    expect(warnings.join('\n')).toMatch(/key/i);
    expect(p.mixer.channels[p.tracks[2].id].key).toBeNull();
  });

  it('a failed load leaves no folder to save over (fix 1)', async () => {
    const { p: src } = await buildFixture();
    const json = roundJson(serialize(src));
    const p = new Project();
    p.folder = { name: 'Old Song' } as FileSystemDirectoryHandle;
    const e = fakeEngine({ holdReset: true });
    const done = loadProject(p, e, json, filesOf(json, src), fakeDecoder);
    await e.untilReset();
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
    const { p: src } = await buildFixture();
    const json = roundJson(serialize(src));
    const p = new Project();
    const e = fakeEngine({ holdReset: true });
    const done = loadProject(p, e, json, filesOf(json, src), fakeDecoder);
    await e.untilReset();
    expect(p.loading).toBe(true);
    e.ack(0);
    await done;
    expect(p.loading).toBe(false);
  });

  it('beforeLoad runs after validation and decoding, right before STOP (fix 4)', async () => {
    const { p: src } = await buildFixture();
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
