import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, validate } from './schema';
import type { ProjectJson } from './schema';
import { projectFingerprint, sampleFilePath, serialize } from './serialize';
import { sampleFile } from '../state/sampleFiles';
import { buildFixture } from './testFixture';
import { Project } from '../state/project.svelte';
import { addAudioClip, addAudioTrack, setAudioClip } from '../state/audio-actions';

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
    const json = { ...serialize(new Project()), schemaVersion: 3 };
    const r = validate(json);
    expect('error' in r && r.error).toMatch(/newer/);
    expect('error' in r && r.error).toMatch(/schema 3; this one reads up to 2/);
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
      kind: 'audio', slot: a.slot, name: 'Vox', color: a.color,
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
    expect(vj.clips[2].len).toBe(1);
    const w = r.warnings.join('\n');
    for (const re of [/gain/, /offset/, /loop/, /fade/i, /sample 77/, /slot/, /malformed/]) expect(w).toMatch(re);
  });
});
