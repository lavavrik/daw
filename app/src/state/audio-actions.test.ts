import { describe, expect, it } from 'vitest';
import { MAX_CLIPS, MAX_SAMPLE_FLOATS, MAX_SONG_TICKS, Op } from '../audio/protocol';
import { Project } from './project.svelte';
import { addDrumTrack } from './actions';
import {
  CLIP_GAIN_MIN_DB, MAX_AUDIO_OFFSET, addAudioClip, addAudioTrack, clipGainLinear, sendAudioClip, setAudioClip, trimAudioClipStart,
} from './audio-actions';

function setup() {
  const sent: number[][] = [];
  const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
  const p = new Project();
  p.tempo = 120; // 1920 ticks per second
  addDrumTrack(p, sink); // slot 0
  const a = addAudioTrack(p, sink)!; // slot 1
  // Sample 4: 2 s (3840 ticks at 120 BPM); sample 5: length unknown (no meta).
  p.sampleMeta.set(4, { seconds: 2, channels: 2, peaks: null });
  sent.length = 0;
  return { p, sink, sent, a };
}

describe('audio tracks', () => {
  it('addAudioTrack takes the lowest free slot, a strip and ADD_AUDIO_TRACK', () => {
    const sent: number[][] = [];
    const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
    const p = new Project();
    const t = addAudioTrack(p, sink)!;
    expect(t).toMatchObject({ kind: 'audio', slot: 0, name: 'Audio', clips: [] });
    expect(p.mixer.channels[t.id]).toBeDefined();
    expect(p.selectedTrackId).toBe(t.id);
    expect(sent[0]).toEqual([Op.ADD_AUDIO_TRACK, 0, 0, 0, 0]);
    expect(addAudioTrack(p, sink)!.name).toBe('Audio 2');
  });
});

describe('audio clips', () => {
  it('addAudioClip places at tick with file length', () => {
    const { p, sink, sent, a } = setup();
    const c = addAudioClip(p, sink, a.id, { sampleId: 4, start: 3840.4 })!;
    expect(c).toMatchObject({ idx: 0, sampleId: 4, start: 3840, len: 3840, offset: 0, loop: false, gain: 0, fadeIn: 0, fadeOut: 0 });
    const at = 1 * MAX_CLIPS + 0;
    expect(sent).toEqual([
      [Op.AUDIO_CLIP_SOURCE, at, 4, 0, 0],
      [Op.AUDIO_CLIP_GAIN, at, 1, 0, 0],
      [Op.AUDIO_CLIP_SET, at, 3840, 3840, 0],
    ]);
    // A different tempo: the same file covers more ticks.
    p.tempo = 60;
    expect(addAudioClip(p, sink, a.id, { sampleId: 4, start: 0 })!.len).toBe(1920);
    // Unknown length: one bar; an explicit length wins.
    expect(addAudioClip(p, sink, a.id, { sampleId: 5, start: 0 })!.len).toBe(3840);
    expect(addAudioClip(p, sink, a.id, { sampleId: 4, start: 0, len: 100 })!.len).toBe(100);
    // Only on Audio tracks, inside the song, and refused when full.
    expect(addAudioClip(p, sink, p.tracks[0].id, { sampleId: 4, start: 0 })).toBeNull();
    expect(addAudioClip(p, sink, a.id, { sampleId: 4, start: -1 })).toBeNull();
    expect(addAudioClip(p, sink, a.id, { sampleId: 4, start: MAX_SONG_TICKS })).toBeNull();
    // Near the song end the length is cut to fit.
    expect(addAudioClip(p, sink, a.id, { sampleId: 4, start: MAX_SONG_TICKS - 10 })!.len).toBe(10);
  });

  it('addAudioClip refuses past MAX_CLIPS', () => {
    const { p, sink, a } = setup();
    for (let i = 0; i < MAX_CLIPS; i++) expect(addAudioClip(p, sink, a.id, { sampleId: 4, start: i, len: 1 })).not.toBeNull();
    expect(addAudioClip(p, sink, a.id, { sampleId: 4, start: 0, len: 1 })).toBeNull();
  });

  it('audio clip edits send SOURCE, GAIN then SET', () => {
    const { p, sink, sent, a } = setup();
    const c = addAudioClip(p, sink, a.id, { sampleId: 4, start: 0 })!;
    sent.length = 0;
    expect(setAudioClip(p, sink, c.id, { gain: -6, fadeIn: 480, fadeOut: 960, loop: true })).toBe(true);
    const at = 1 * MAX_CLIPS + c.idx;
    expect(sent.map((s) => s[0])).toEqual([Op.AUDIO_CLIP_SOURCE, Op.AUDIO_CLIP_GAIN, Op.AUDIO_CLIP_SET]);
    expect(sent[0]).toEqual([Op.AUDIO_CLIP_SOURCE, at, 4, 0, 1]);
    expect(sent[1][2]).toBeCloseTo(10 ** (-6 / 20), 12);
    expect(sent[1].slice(3)).toEqual([480, 960]);
    expect(sent[2]).toEqual([Op.AUDIO_CLIP_SET, at, 0, 3840, 0]);
    // sendAudioClip is the one encoder (load, undo and edits).
    sent.length = 0;
    sendAudioClip(sink, a, c);
    expect(sent.map((s) => s[0])).toEqual([Op.AUDIO_CLIP_SOURCE, Op.AUDIO_CLIP_GAIN, Op.AUDIO_CLIP_SET]);
    // No change: nothing sent. Invalid: refused, nothing changes.
    sent.length = 0;
    expect(setAudioClip(p, sink, c.id, { gain: -6 })).toBe(true);
    expect(setAudioClip(p, sink, c.id, { gain: NaN })).toBe(false);
    expect(setAudioClip(p, sink, c.id, { offset: -1 })).toBe(false);
    expect(setAudioClip(p, sink, c.id, { start: MAX_SONG_TICKS })).toBe(false);
    expect(setAudioClip(p, sink, 'nope', { gain: 0 })).toBe(false);
    expect(sent).toEqual([]);
    // Gain clamps to -inf..+12 dB (-inf is the minimum: linear 0).
    setAudioClip(p, sink, c.id, { gain: 40 });
    expect(c.gain).toBe(12);
    setAudioClip(p, sink, c.id, { gain: -Infinity });
    expect(c.gain).toBe(CLIP_GAIN_MIN_DB);
    expect(sent.at(-2)![2]).toBe(0);
    expect(clipGainLinear(12)).toBeLessThanOrEqual(4);
    // Fades never exceed the clip: a shorter clip shortens them.
    setAudioClip(p, sink, c.id, { len: 1000 });
    expect(c.fadeIn + c.fadeOut).toBeLessThanOrEqual(1000);
    expect(sent.at(-1)).toEqual([Op.AUDIO_CLIP_SET, at, 0, 1000, 0]);
  });

  it('non-loop right edge capped at file end', () => {
    const { p, sink, a } = setup();
    const c = addAudioClip(p, sink, a.id, { sampleId: 4, start: 0, len: 960 })!;
    expect(setAudioClip(p, sink, c.id, { len: 10_000 })).toBe(true);
    expect(c.len).toBe(3840); // the 2 s file at 120 BPM
    setAudioClip(p, sink, c.id, { offset: 0.5 });
    setAudioClip(p, sink, c.id, { len: 10_000 });
    expect(c.len).toBe(2880); // 1.5 s left in the file
    // A loop clip repeats the file: any length.
    setAudioClip(p, sink, c.id, { loop: true, len: 10_000 });
    expect(c.len).toBe(10_000);
    // Unknown file length: no cap.
    const u = addAudioClip(p, sink, a.id, { sampleId: 5, start: 0 })!;
    setAudioClip(p, sink, u.id, { len: 20_000 });
    expect(u.len).toBe(20_000);
  });

  it('left trim keeps audio in place', () => {
    const { p, sink, sent, a } = setup();
    const c = addAudioClip(p, sink, a.id, { sampleId: 4, start: 3840 })!; // 3840..7680
    sent.length = 0;
    expect(trimAudioClipStart(p, sink, c.id, 3840 + 960)).toBe(true);
    expect([c.start, c.len]).toEqual([4800, 2880]); // the end stays
    expect(c.offset).toBeCloseTo(0.5, 12); // 960 ticks at 120 BPM
    expect(sent.map((s) => s[0])).toEqual([Op.AUDIO_CLIP_SOURCE, Op.AUDIO_CLIP_GAIN, Op.AUDIO_CLIP_SET]);
    // Back out to the left: never before the file start (one-shot).
    trimAudioClipStart(p, sink, c.id, 0);
    expect([c.start, c.len, c.offset]).toEqual([3840, 3840, 0]);
    // Never past the end.
    trimAudioClipStart(p, sink, c.id, 99_999);
    expect(c.start + c.len).toBe(7680);
    expect(c.len).toBe(1);
    // A loop clip wraps around the file instead.
    const l = addAudioClip(p, sink, a.id, { sampleId: 4, start: 3840 * 4 })!;
    setAudioClip(p, sink, l.id, { loop: true });
    trimAudioClipStart(p, sink, l.id, 3840 * 4 - 960);
    expect([l.start, l.len]).toEqual([3840 * 4 - 960, 3840 + 960]);
    expect(l.offset).toBeCloseTo(1.5, 12); // -0.5 s, modulo the 2 s file
  });

  it('the offset stays where the engine can play it at any rate', () => {
    const { p, sink, sent, a } = setup();
    // A one-shot's offset stops at its file's end (2 s): past it is silence anyway.
    const c = addAudioClip(p, sink, a.id, { sampleId: 4, start: 0, len: 100 })!;
    expect(setAudioClip(p, sink, c.id, { offset: 50 })).toBe(true);
    expect(c.offset).toBe(2);
    // Unknown file length: bounded so offset x 192 kHz stays within MAX_SAMPLE_FLOATS frames.
    expect(MAX_AUDIO_OFFSET * 192000).toBeLessThanOrEqual(MAX_SAMPLE_FLOATS);
    const u = addAudioClip(p, sink, a.id, { sampleId: 5, start: 0 })!;
    sent.length = 0;
    expect(setAudioClip(p, sink, u.id, { offset: 1000 })).toBe(true);
    expect(u.offset).toBe(MAX_AUDIO_OFFSET);
    expect(sent[0][3]).toBe(MAX_AUDIO_OFFSET);
    // A long file (20 min): an offset deep inside it is kept, beyond the unknown-length bound.
    p.sampleMeta.set(6, { seconds: 1200, channels: 1, peaks: null });
    const long = addAudioClip(p, sink, a.id, { sampleId: 6, start: 0, len: 100 })!;
    setAudioClip(p, sink, long.id, { offset: 900 });
    expect(long.offset).toBe(900);
    // A left trim of a one-shot clip that outlives its file (a tempo change) never passes the file's end either.
    const l = addAudioClip(p, sink, a.id, { sampleId: 4, start: 3840 * 2, len: 3840 })!;
    p.tempo = 240; // the 2 s file now covers 7680 ticks; the clip is 3840
    setAudioClip(p, sink, l.id, { len: 7680 });
    p.tempo = 60; // ... and now only 1920
    trimAudioClipStart(p, sink, l.id, 3840 * 2 + 7000);
    expect(l.offset).toBeLessThanOrEqual(2);
  });
});
