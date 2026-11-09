import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, validate } from './schema';
import type { ProjectJson } from './schema';
import { projectFingerprint, sampleFilePath, serialize } from './serialize';
import { sampleFile } from '../state/sampleFiles';
import { addAutomationFixture, buildFixture } from './testFixture';
import { Project } from '../state/project.svelte';
import { CLIP_GAIN_MIN_DB, addAudioClip, addAudioTrack, setAudioClip } from '../state/audio-actions';
import { learnMidi } from '../state/midiMap';

const roundJson = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function ok(r: ReturnType<typeof validate>) {
  if ('error' in r) throw new Error(r.error);
  return r;
}

describe('project schema', () => {
  it('round-trip serialize → validate → equals', async () => {
    const { p, drums, synth } = await buildFixture();
    const json = serialize(p);
    expect(json.schemaVersion).toBe(SCHEMA_VERSION);
    expect(json.name).toBe('Fixture');
    expect(json.tempo).toBe(132.5);
    expect(json.metronome).toBe(true);
    expect(json.mode).toBe('song');
    expect(json.loop).toEqual({ on: true, start: 3840, end: 19200 });
    expect(json.tracks.map((t) => t.kind)).toEqual(['drum', 'synth', 'synth']);
    // Engine slots are stored so a restore puts everything back in place.
    const dj = json.tracks[0];
    if (dj.kind !== 'drum') throw new Error('kind');
    expect(dj.slot).toBe(drums.slot);
    expect(dj.patterns.map((x) => x.engineIdx)).toEqual([0, 1]);
    expect(dj.patterns[0].hits).toContainEqual([1, 4, 60]);
    expect(dj.patterns[1]).toMatchObject({ stepCount: 32, hits: [[4, 31, 127]] });
    expect(dj.rows[1]).toEqual({ name: 'snare', sample: 1, gain: 0.5, pan: -0.25, mute: false });
    expect(dj.clips[1]).toEqual({ idx: 1, pattern: 1, start: 3840, len: 7680, offset: 240 });
    const sj = json.tracks[1];
    if (sj.kind !== 'synth') throw new Error('kind');
    expect(sj.currentPattern).toBe(1);
    expect(sj.patterns[1].notes).toEqual([{ idx: 0, pitch: 48, vel: 100, start: 3840, len: 3840 }]);
    expect(sj.patch.modules.find((m) => m.id === 'filter')!.params!.cutoff).toBe(1234);
    expect(sj.patch.modules.find((m) => m.id === 'sample_player')!.params!.sample).toBe(2);
    // Samples: the drum rows' and the one only a SamplePlayer uses.
    expect(json.samples.map(({ id, name, type }) => ({ id, name, type }))).toEqual([
      { id: 0, name: 'kick.wav', type: 'audio/wav' },
      { id: 1, name: 'snare.wav', type: 'audio/wav' },
      { id: 2, name: 'vox.wav', type: 'audio/wav' },
    ]);
    // "<id>-<content hash>-<name>": a file with other bytes never reuses a name.
    expect(json.samples[0].file).toMatch(/^samples\/0-[0-9a-f]{8}-kick\.wav$/);
    // Mixer params by catalog name; keys by slot.
    const strip = json.mixer.tracks.find((t) => t.slot === synth.slot)!;
    expect(strip.params.comp_on).toBe(1);
    expect(strip.key).toEqual({ track: drums.slot, row: 0 });
    expect(json.mixer.reverb.rev_size).toBe(0.8);
    expect(json.mixer.reverb.delay_time).toBeUndefined();
    expect(json.mixer.master.limiter_ceiling).toBe(-1);
    expect(json.selection).toEqual({ track: drums.slot, synth: synth.slot });

    const r = ok(validate(roundJson(json)));
    expect(r.warnings).toEqual([]);
    expect(r.project).toEqual(json);
  });

  it('module pos survives serialize -> JSON -> validate; an old project without pos loads', async () => {
    const { p, synth } = await buildFixture();
    const t = p.tracks.find((x) => x.id === synth.id)!;
    if (t.kind !== 'synth') throw new Error('kind');
    const first = serialize(p);
    const old = first.tracks.find((x) => x.kind === 'synth');
    if (old?.kind !== 'synth') throw new Error('kind');
    expect(old.patch.modules.every((m) => !('pos' in m))).toBe(true);
    const loadedOld = ok(validate(roundJson(first)));
    expect(loadedOld.warnings).toEqual([]);
    t.modules[0].pos = { row: 1, x: 3 };
    const json = serialize(p);
    const r = ok(validate(roundJson(json)));
    const st = r.project.tracks.find((x) => x.kind === 'synth' && x.slot === t.slot);
    if (st?.kind !== 'synth') throw new Error('kind');
    expect(st.patch.modules.find((m) => m.idx === t.modules[0].idx)!.pos).toEqual({ row: 1, x: 3 });
    expect(r.warnings).toEqual([]);
  });

  it('sample file names carry a content hash (fix 7)', async () => {
    const { p } = await buildFixture();
    const before = serialize(p).samples[0].file;
    p.sampleFiles.set(0, await sampleFile('kick.wav', 'audio/wav', new Uint8Array([99, 1, 2]).buffer));
    const after = serialize(p).samples[0].file;
    expect(after).not.toBe(before);
    expect(after.startsWith('samples/0-')).toBe(true);
    expect(sampleFilePath(3, 'a/b:c.wav', 'deadbeef')).toBe('samples/3-deadbeef-a_b_c.wav');
  });

  it('serialize is pure (same project, same output; the project is untouched)', async () => {
    const { p } = await buildFixture();
    const before = projectFingerprint(p);
    expect(serialize(p)).toEqual(serialize(p));
    expect(projectFingerprint(p)).toBe(before);
  });

  it('an empty project round-trips', async () => {
    const json = serialize(new Project());
    expect(ok(validate(roundJson(json)))).toEqual({ project: json, warnings: [] });
  });

  it('rejects newer schema', async () => {
    const json = { ...serialize(new Project()), schemaVersion: 6 };
    const r = validate(json);
    expect('error' in r && r.error).toMatch(/newer/);
    expect('error' in r && r.error).toMatch(/schema 6; this one reads up to 5/);
    expect('error' in validate(null)).toBe(true);
    expect('error' in validate({ tracks: [] })).toBe(true); // no schemaVersion
    expect('error' in validate('{}')).toBe(true);
  });

  it('ignores unknown fields', async () => {
    const json = serialize((await buildFixture()).p) as ProjectJson & Record<string, unknown>;
    const r = ok(validate({ ...roundJson(json), futureThing: { a: 1 }, tracks: json.tracks.map((t) => ({ ...t, extra: 1 })) }));
    expect(r.warnings).toEqual([]);
    expect(r.project).toEqual(roundJson(json));
  });

  it('clamps out-of-range values with warnings', async () => {
    const json = roundJson(serialize((await buildFixture()).p)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    json.tempo = 999;
    json.tracks[0].rows[1].gain = 7;
    json.tracks[0].patterns[0].hits.push([0, 99, 100]); // step out of range: dropped
    json.tracks[0].patterns[1].stepCount = 48;
    json.tracks[1].patterns[0].notes[0].pitch = 300;
    json.tracks[1].patterns[0].notes.push({ idx: 0, pitch: 1, vel: 1, start: 0, len: 1 }); // duplicate idx
    json.tracks[1].clips[0].pattern = 9; // no such pattern
    json.tracks.push({ kind: 'theremin', slot: 9 });
    json.tracks.push({ ...json.tracks[2], name: 'Dup' }); // slot taken
    json.mixer.tracks[0].params.fader = 40;
    json.mixer.tracks[0].params.wobble = 1;
    json.mixer.tracks[0].params.rev_size = 0.5; // reverb param on a track strip
    json.mixer.delay.rev_size = 0.5; // reverb param on the delay return
    json.mixer.tracks[1].key = { track: 31, row: null }; // no such track
    json.samples.push({ id: 5, name: 'x', type: 'audio/wav', file: '../../etc/passwd' });
    json.loop = { on: true, start: 500, end: 100 };
    const r = ok(validate(json));
    const p = r.project;
    expect(p.tempo).toBe(300);
    const d = p.tracks[0];
    if (d.kind !== 'drum') throw new Error('kind');
    expect(d.rows[1].gain).toBe(2);
    expect(d.patterns[0].hits.some((h) => h[1] === 99)).toBe(false);
    expect(d.patterns[1].stepCount).toBe(16);
    const s = p.tracks[1];
    if (s.kind !== 'synth') throw new Error('kind');
    expect(s.patterns[0].notes[0].pitch).toBe(127);
    expect(s.patterns[0].notes).toHaveLength(2);
    expect(s.clips).toHaveLength(0);
    expect(p.tracks).toHaveLength(3);
    expect(p.mixer.tracks[0].params.fader).toBe(6);
    expect(p.mixer.tracks[0].params.wobble).toBeUndefined();
    expect(p.mixer.tracks[0].params.rev_size).toBeUndefined();
    expect(p.mixer.delay.rev_size).toBeUndefined();
    expect(p.mixer.tracks[1].key).toBeNull();
    expect(p.samples).toHaveLength(3);
    expect(p.loop).toEqual({ on: false, start: 0, end: 4 * 3840 });
    const w = r.warnings.join('\n');
    for (const re of [/tempo/i, /gain/i, /step/i, /step count/i, /pitch/i, /note/i, /clip/i, /theremin/, /Dup/,
      /fader/, /wobble/, /rev_size/, /key/i, /passwd/, /loop/i]) {
      expect(w).toMatch(re);
    }
    expect(r.warnings.length).toBeGreaterThanOrEqual(15);
  });

  it('missing optional values fall back to defaults', async () => {
    const r = ok(validate({ schemaVersion: 1, tracks: [{ kind: 'drum', slot: 3 }] }));
    expect(r.project.tempo).toBe(124);
    expect(r.project.name).toBe('Untitled');
    const d = r.project.tracks[0];
    if (d.kind !== 'drum') throw new Error('kind');
    expect(d.patterns).toHaveLength(1);
    expect(d.currentPattern).toBe(d.patterns[0].engineIdx);
    expect(d.rows).toHaveLength(4);
  });

  it('validates audio tracks', async () => {
    const { p } = await buildFixture();
    const sink = { send: () => true };
    const a = addAudioTrack(p, sink, { name: 'Vox' })!;
    p.sampleMeta.set(1, { seconds: 4, channels: 2, peaks: null });
    const c = addAudioClip(p, sink, a.id, { sampleId: 1, start: 3840 })!;
    setAudioClip(p, sink, c.id, { offset: 0.25, loop: true, gain: -6, fadeIn: 240, fadeOut: 480 });
    addAudioClip(p, sink, a.id, { sampleId: 2, start: 0, len: 960 }); // sample 2: only the SamplePlayer used it so far
    const json = serialize(p);
    const aj = json.tracks.find((t) => t.kind === 'audio')!;
    expect(aj).toEqual({
      kind: 'audio', slot: a.slot, name: 'Vox', color: a.color, automation: [],
      clips: [
        { idx: 0, sample: 1, start: 3840, len: c.len, offset: 0.25, loop: true, gain: -6, fadeIn: 240, fadeOut: 480 },
        { idx: 1, sample: 2, start: 0, len: 960, offset: 0, loop: false, gain: 0, fadeIn: 0, fadeOut: 0 },
      ],
    });
    // Audio-clip samples are listed under `samples` like rows'.
    expect(json.samples.map((s) => s.id)).toEqual([0, 1, 2]);
    // Round-trip.
    expect(ok(validate(roundJson(json)))).toEqual({ project: roundJson(json), warnings: [] });

    // Bad values: clamped or dropped, with warnings; a missing sample keeps the clip.
    const bad = roundJson(json) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const at = bad.tracks.findIndex((t: { kind: string }) => t.kind === 'audio');
    const clips = bad.tracks[at].clips;
    clips[0].gain = 99;
    clips[0].offset = -2;
    clips[0].loop = 'yes';
    clips[0].fadeIn = clips[0].len; // with fadeOut 480: too long, cut
    clips[1].gain = null; // JSON.stringify(-Infinity): -inf, silently
    clips[1].sample = 77; // not in the project
    clips.push({ idx: 0, sample: 1, start: 0, len: 10, offset: 0, loop: false, gain: 0, fadeIn: 0, fadeOut: 0 }); // idx taken
    clips.push('junk');
    clips.push({ idx: 5, sample: 1, start: 0, len: 0 }); // length clamped to 1
    bad.tracks[at].patterns = [{ engineIdx: 0, name: 'x' }]; // unknown on an Audio track: ignored
    const r = ok(validate(bad));
    const vj = r.project.tracks[at];
    if (vj.kind !== 'audio') throw new Error('kind');
    expect(vj.clips.map((x) => x.idx)).toEqual([0, 1, 5]);
    expect(vj.clips[0]).toMatchObject({ gain: 12, offset: 0, loop: false, fadeOut: 480 });
    expect(vj.clips[0].fadeIn + vj.clips[0].fadeOut).toBeLessThanOrEqual(vj.clips[0].len);
    expect(vj.clips[1].sample).toBeNull();
    expect(vj.clips[1].gain).toBe(CLIP_GAIN_MIN_DB);
    expect(r.warnings.some((x) => /clip gain: not a number/.test(x))).toBe(false);
    expect(vj.clips[2].len).toBe(1);
    const w = r.warnings.join('\n');
    for (const re of [/gain/, /offset/, /loop/, /fade/i, /sample 77/, /slot/, /malformed/]) expect(w).toMatch(re);
  });

  it('saves a point\'s curve as its optional 4th element (plan 16, no schema bump)', async () => {
    const { p, synth } = await buildFixture();
    const lanes = addAutomationFixture(p);
    lanes.fader.points[0].curve = -0.75;
    const json = serialize(p);
    const sj = json.tracks.find((t) => t.slot === synth.slot)!;
    expect(sj.automation[0].points).toEqual([[0, -24, 0, -0.75], [3840, 0, 1], [5760, -60, 0]]);
    expect(json.schemaVersion).toBe(SCHEMA_VERSION); // no bump of its own
    // Round trip: unchanged, no warnings.
    expect(ok(validate(roundJson(json)))).toEqual({ project: roundJson(json), warnings: [] });
    // Bad curves: clamped to -1..1 (0 written as no curve); a non-number makes the point malformed.
    const bad = roundJson(json) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const at = bad.tracks.findIndex((t: { slot: number }) => t.slot === synth.slot);
    const pts = bad.tracks[at].automation[0].points;
    pts[0][3] = 7;
    pts[1][3] = 0;
    pts.push([6000, -6, 0, 'x'], [6100, -6, 0, 0.5, 1]);
    const r = ok(validate(bad));
    expect(r.project.tracks[at].automation[0].points).toEqual([[0, -24, 0, 1], [3840, 0, 1], [5760, -60, 0]]);
    expect(r.warnings.join('\n')).toMatch(/curve 7 clamped to 1/);
    expect(r.warnings.filter((w) => /malformed/.test(w))).toHaveLength(2);
  });

  it('validates lanes', async () => {
    const { p, synth } = await buildFixture();
    const lanes = addAutomationFixture(p);
    const json = serialize(p);
    const sj = json.tracks.find((t) => t.slot === synth.slot)!;
    // Targets by catalog name: {mix: name} or {rack: [module idx, name]}; points [tick, value, 0|1] in engine idx order.
    expect(sj.automation.map((l) => l.target)).toEqual([{ mix: 'fader' }, { rack: [4, 'cutoff'] }]);
    expect(sj.automation[0]).toEqual({ lane: lanes.fader.lane, enabled: true, target: { mix: 'fader' }, points: [[0, -24, 0], [3840, 0, 1], [5760, -60, 0]] });
    expect(json.mixer.automation).toEqual([{ channel: 'master', lane: lanes.ceiling.lane, enabled: false, target: { mix: 'limiter_ceiling' }, points: [[0, 0, 0], [7680, -3, 0]] }]);
    expect(ok(validate(roundJson(json)))).toEqual({ project: roundJson(json), warnings: [] });

    const bad = roundJson(json) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const at = bad.tracks.findIndex((t: { slot: number }) => t.slot === synth.slot);
    const auto = bad.tracks[at].automation;
    auto[0].points.push([3840, -3, 0]); // duplicate tick: dropped
    auto[0].points.push([7000, 99, 1]); // clamped to +6
    auto[0].points.push([-5, 0, 0], 'junk'); // tick clamped to 0... which is taken: dropped; malformed: dropped
    auto[1].enabled = 'no'; // not a boolean: true
    auto.push({ lane: 40, enabled: true, target: { mix: 'mute' }, points: [] }); // integer target
    auto.push({ lane: 41, enabled: true, target: { mix: 'wobble' }, points: [] }); // unknown
    auto.push({ lane: 42, enabled: true, target: { rack: [4, 'mode'] }, points: [] }); // integer rack param
    auto.push({ lane: 43, enabled: true, target: { rack: [30, 'cutoff'] }, points: [] }); // no such module
    auto.push({ lane: 44, enabled: true, points: [] }); // no target
    auto.push({ lane: 45, enabled: true, target: { mix: 'fader' }, points: [] }); // a second lane on one target
    auto.push({ lane: lanes.fader.lane, enabled: true, target: { mix: 'pan' }, points: [] }); // engine lane taken
    auto.push({ lane: 64, enabled: true, target: { mix: 'pan' }, points: [] }); // engine lane out of range
    bad.tracks[0].automation.push({ lane: 46, enabled: true, target: { rack: [0, 'level'] }, points: [] }); // rack on drums
    bad.tracks.push({
      kind: 'audio', slot: 9, name: 'Vox', color: '#ff6b6b', clips: [],
      automation: [
        { lane: 50, enabled: true, target: { rack: [0, 'gain'] }, points: [] }, // an Audio slot has no rack
        { lane: 51, enabled: true, target: { mix: 'fader' }, points: [[0, -6, 0]] }, // its strip: fine
      ],
    });
    bad.mixer.automation.push({ channel: 'reverb', lane: 47, enabled: true, target: { mix: 'delay_feedback' }, points: [] }); // not on the Reverb
    bad.mixer.automation.push({ channel: 'bus', lane: 48, enabled: true, target: { mix: 'fader' }, points: [] }); // no such channel
    bad.mixer.automation.push({ channel: 'delay', lane: 49, enabled: true, target: { mix: 'delay_feedback' }, points: [[0, 0.5, 0]] }); // fine
    const r = ok(validate(bad));
    const vj = r.project.tracks[at];
    expect(vj.automation.map((l) => l.lane)).toEqual([lanes.fader.lane, lanes.cutoff.lane]);
    expect(vj.automation[0].points).toEqual([[0, -24, 0], [3840, 0, 1], [5760, -60, 0], [7000, 6, 1]]);
    expect(vj.automation[1].enabled).toBe(true);
    expect(r.project.tracks[0].automation.map((l) => l.lane)).toEqual([lanes.send.lane]); // the rack lane on drums: dropped
    expect(r.project.mixer.automation.map((l) => [l.channel, l.lane])).toEqual([['master', lanes.ceiling.lane], ['delay', 49]]);
    const vox = r.project.tracks.find((t) => t.kind === 'audio')!;
    expect(vox.automation.map((l) => [l.lane, l.target])).toEqual([[51, { mix: 'fader' }]]);
    expect(r.warnings).toContainEqual(expect.stringMatching(/Track "Vox".*gain: only synth tracks have a rack/));
    const w = r.warnings.join('\n');
    for (const re of [/tick 3840/, /clamped/, /malformed/, /mute/, /wobble/, /mode/, /module 30/, /no target/, /already has a lane/,
      /lane \d+.*taken/, /64/, /level/, /delay_feedback/, /bus/, /enabled/i]) {
      expect(w).toMatch(re);
    }

    // Caps: 512 points per lane, the rest dropped. (64 lanes per project
    // follows from the unique engine lanes 0..63; validate counts them anyway.)
    const many = roundJson(json) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    many.tracks[at].automation[0].points = Array.from({ length: 600 }, (_, i) => [i * 10, -6, 0]);
    const rc = ok(validate(many));
    expect(rc.project.tracks[at].automation[0].points).toHaveLength(512);
    expect(rc.warnings.join('\n')).toMatch(/512/);
  });

  it('MIDI mappings round-trip (by slot / channel name)', async () => {
    const { p, synth } = await buildFixture();
    learnMidi(p, 74, synth.id, { kind: 'rack', module: 4, param: 'cutoff' });
    learnMidi(p, 7, 'master', { kind: 'mix', param: 'fader' });
    const json = serialize(p);
    expect(json.midiMap).toEqual([
      { cc: 74, track: synth.slot, target: { rack: [4, 'cutoff'] } },
      { cc: 7, channel: 'master', target: { mix: 'fader' } },
    ]);
    const r = ok(validate(roundJson(json)));
    expect(r.warnings).toEqual([]);
    expect(r.project).toEqual(json);
    expect(serialize(new Project()).midiMap).toEqual([]);
  });

  it('validates MIDI mappings', async () => {
    const { p, drums, synth } = await buildFixture();
    const json = roundJson(serialize(p)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const keep = [
      { cc: 74, track: synth.slot, target: { rack: [4, 'cutoff'] } },
      { cc: 7, track: drums.slot, target: { mix: 'fader' } },
      { cc: 10, channel: 'reverb', target: { mix: 'rev_size' } },
      { cc: 0, track: synth.slot, target: { rack: [1, 'octave'] } }, // integer knobs are learnable
    ];
    json.midiMap = [
      ...keep,
      'junk',
      { cc: 120, track: drums.slot, target: { mix: 'pan' } }, // panic range
      { cc: 3.5, track: drums.slot, target: { mix: 'pan' } }, // not an integer
      { cc: 11, track: 29, target: { mix: 'pan' } }, // no such slot
      { cc: 12, channel: 'bus', target: { mix: 'fader' } }, // no such channel
      { cc: 13, track: synth.slot, target: { rack: [30, 'cutoff'] } }, // no module 30
      { cc: 14, track: drums.slot, target: { rack: [4, 'cutoff'] } }, // drums have no rack
      { cc: 15, track: synth.slot, target: { rack: [4, 'wobble'] } }, // unknown rack param
      { cc: 16, channel: 'master', target: { mix: 'pan' } }, // master takes no pan
      { cc: 17, track: drums.slot, target: { mix: 'nope' } }, // unknown mixer param
      { cc: 18, track: drums.slot, target: 'fader' }, // malformed target
      { cc: 74, track: drums.slot, target: { mix: 'pan' } }, // duplicate cc
      { cc: 19, track: synth.slot, target: { rack: [4, 'cutoff'] } }, // duplicate control
      { cc: 21, track: drums.slot, target: { mix: 'mute' } }, // an on/off flag
      { cc: 22, track: synth.slot, target: { rack: [4, 'mode'] } }, // a choice
      { cc: 23, channel: 'delay', target: { mix: 'delay_ping_pong' } }, // a flag on a return
    ];
    const r = ok(validate(json));
    expect(r.project.midiMap).toEqual(keep);
    const w = r.warnings.filter((x) => /MIDI/.test(x));
    expect(w).toHaveLength(16);
    expect(w.filter((x) => /not learnable/.test(x))).toHaveLength(3);
    for (const re of [/malformed/, /CC 120/, /CC 3.5/, /slot 29/, /bus/, /module 30/, /only synth tracks/, /wobble/, /pan/, /nope/, /already mapped/, /already has CC 74/]) {
      expect(w.join('\n')).toMatch(re);
    }
    // Not an array: none, with a warning.
    const r2 = ok(validate({ ...roundJson(serialize(p)), midiMap: { cc: 1 } }));
    expect(r2.project.midiMap).toEqual([]);
    expect(r2.warnings.join('\n')).toMatch(/MIDI/);
  });

  it('validates the pattern library (plan 21): malformed entries dropped, values clamped, with warnings', () => {
    const steps = (on: number[], v = 100) => Array.from({ length: 64 }, (_, i) => (on.includes(i) ? v : 0));
    const good = [
      { kind: 'drum', name: 'Groove', stepCount: 32, swing: 0.5, rows: [{ name: 'Kick', sampleName: 'kick.wav', steps: steps([0, 8]) }, { name: 'Row 2', steps: steps([]) }] },
      { kind: 'synth', name: 'Bass', bars: 2, notes: [{ pitch: 36, vel: 100, start: 0, len: 480 }] },
    ];
    const base = roundJson(serialize(new Project()));
    // Well-formed: kept as is, no warnings.
    const r0 = ok(validate({ ...base, patternLibrary: good }));
    expect(r0.warnings).toEqual([]);
    expect(r0.project.patternLibrary).toEqual(good);

    const r = ok(validate({
      ...base,
      patternLibrary: [
        ...good,
        'junk',
        { kind: 'drum', name: 'No rows' },
        { kind: 'audio', name: 'Wrong kind', rows: [] },
        { kind: 'synth', notes: [] }, // no name
        {
          kind: 'drum', name: 'Odd', stepCount: 12, swing: 3,
          rows: ['junk', { name: 'Hat', sampleName: 5, steps: [127, 300, -1, 'x', 2.6] }, { name: 'Long', steps: [...steps([]), 100] }],
        },
        { kind: 'synth', name: 'Wild', bars: 99, notes: [{ pitch: 200, vel: 0, start: -5, len: 0 }, 'junk'] },
      ],
    }));
    const lib = r.project.patternLibrary;
    expect(lib.map((e) => e.name)).toEqual(['Groove', 'Bass', 'Odd', 'Wild']);
    const odd = lib[2];
    if (odd.kind !== 'drum') throw new Error('kind');
    expect(odd.stepCount).toBe(16);
    expect(odd.swing).toBe(1);
    expect(odd.rows[0]).toEqual({ name: 'Row 1', steps: steps([]) });
    expect(odd.rows[1].sampleName).toBeUndefined();
    expect(odd.rows[1].steps.slice(0, 5)).toEqual([127, 127, 0, 0, 3]);
    expect(odd.rows[1].steps).toHaveLength(64);
    expect(odd.rows[2].steps).toEqual(steps([]));
    const wild = lib[3];
    if (wild.kind !== 'synth') throw new Error('kind');
    expect(wild.bars).toBe(16);
    expect(wild.notes).toEqual([{ pitch: 127, vel: 1, start: 0, len: 1 }]);
    const w = r.warnings.join('\n');
    for (const re of [/malformed library pattern\b/, /malformed library pattern "No rows"/, /"Wrong kind"/, /step count 12/, /swing/, /row 1: malformed/, /sample name/, /first 64 steps/, /velocity/, /bars/, /dropped a malformed note/]) {
      expect(w).toMatch(re);
    }
    // Not a list: empty, with a warning.
    const r2 = ok(validate({ ...base, patternLibrary: { kind: 'drum' } }));
    expect(r2.project.patternLibrary).toEqual([]);
    expect(r2.warnings.join('\n')).toMatch(/Pattern library/);

    // Names as the app makes them: trimmed, at most 60 characters, never empty, unique.
    const syn = (name: string) => ({ kind: 'synth', name, bars: 1, notes: [] });
    const r3 = ok(validate({ ...base, patternLibrary: [syn('A'), syn(' A '), syn('   '), syn('x'.repeat(70)), syn('A')] }));
    expect(r3.project.patternLibrary.map((e) => e.name)).toEqual(['A', 'A 2', 'Pattern', 'x'.repeat(60), 'A 3']);
    expect(r3.warnings.filter((x) => /renamed/.test(x))).toHaveLength(4);
    // At most 256 entries.
    const r4 = ok(validate({ ...base, patternLibrary: Array.from({ length: 300 }, (_, i) => syn(`P${i}`)) }));
    expect(r4.project.patternLibrary).toHaveLength(256);
    expect(r4.warnings.join('\n')).toMatch(/only the first 256/);
  });
});
