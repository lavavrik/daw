import { describe, expect, it } from 'vitest';
import { MAX_CLIPS, MAX_SONG_TICKS, Op, PATTERN_FOCUS_NONE } from '../audio/protocol';
import { Project, currentPattern } from './project.svelte';
import type { DrumTrack, SynthTrack } from './project.svelte';
import { addDrumTrack, removeTrack, selectTrack, stop } from './actions';
import { addSynthTrack } from './rack-actions';
import { newPattern, selectPattern } from './pattern-actions';
import {
  addClip, deleteClips, duplicateClips, makeUnique, moveClips, patternPosAt, playPattern, playSong, resizeClip, seek, setLoop,
  setMode, splitClips, stopTransport, toggleTransport,
} from './song-actions';
import { addAudioClip, addAudioTrack } from './audio-actions';
import { addLane, addPoint } from './automation-actions';

function setup() {
  const sent: number[][] = [];
  const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
  const p = new Project();
  const d0 = addDrumTrack(p, sink)!; // slot 0
  const s1 = addSynthTrack(p, sink)!; // slot 1
  const d2 = addDrumTrack(p, sink)!; // slot 2
  sent.length = 0;
  return { p, sink, sent, d0, s1, d2 };
}

describe('clips', () => {
  it('addClip packs b = offset*16 + pattern', () => {
    const { p, sink, sent, d0, s1 } = setup();
    newPattern(p, sink, d0.id); // engineIdx 1, current
    sent.length = 0;
    const c = addClip(p, sink, d0.id, { start: 3840, offset: 240 })!;
    expect(c.idx).toBe(0);
    expect(c.patternId).toBe(d0.currentPatternId);
    expect(c.len).toBe(16 * 240); // the current pattern's length
    expect(sent).toEqual([[Op.CLIP_SET, 0 * MAX_CLIPS + 0, 240 * 16 + 1, 3840, 16 * 240]]);
    // Explicit pattern and length; synth default length is bars.
    const c2 = addClip(p, sink, s1.id, { start: 0 })!;
    expect(c2.len).toBe(4 * 3840);
    expect(sent[1]).toEqual([Op.CLIP_SET, 1 * MAX_CLIPS + 0, 0 * 16 + 0, 0, 4 * 3840]);
    const c3 = addClip(p, sink, d0.id, { start: 100.4, len: 7.6, patternId: d0.patterns[0].id })!;
    expect([c3.idx, c3.start, c3.len]).toEqual([1, 100, 8]);
    expect(sent[2]).toEqual([Op.CLIP_SET, 1, 0, 100, 8]);
  });

  it('addClip validates range, length, offset and pattern', () => {
    const { p, sink, sent, d0, s1 } = setup();
    expect(addClip(p, sink, d0.id, { start: -1 })).toBeNull();
    expect(addClip(p, sink, d0.id, { start: 0, len: 0 })).toBeNull();
    expect(addClip(p, sink, d0.id, { start: MAX_SONG_TICKS - 10, len: 11 })).toBeNull();
    expect(addClip(p, sink, d0.id, { start: 0, offset: 61440 })).toBeNull();
    expect(addClip(p, sink, d0.id, { start: NaN })).toBeNull();
    expect(addClip(p, sink, d0.id, { start: 0, patternId: s1.patterns[0].id })).toBeNull(); // other track's pattern
    expect(addClip(p, sink, 'nope', { start: 0 })).toBeNull();
    expect(addClip(p, sink, d0.id, { start: MAX_SONG_TICKS - 10, len: 10 })).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('addClip takes the lowest free idx and stops at MAX_CLIPS', () => {
    const { p, sink, d0 } = setup();
    for (let i = 0; i < MAX_CLIPS; i++) expect(addClip(p, sink, d0.id, { start: i, len: 1 })).not.toBeNull();
    expect(addClip(p, sink, d0.id, { start: 0, len: 1 })).toBeNull();
    deleteClips(p, sink, [d0.clips[5].id]);
    expect(addClip(p, sink, d0.id, { start: 0, len: 1 })!.idx).toBe(5);
  });

  it('makeUnique repoints the clip', () => {
    const { p, sink, sent, d0 } = setup();
    const pat0 = d0.patterns[0];
    const a = addClip(p, sink, d0.id, { start: 0 })!;
    addClip(p, sink, d0.id, { start: 3840 });
    sent.length = 0;
    const copy = makeUnique(p, sink, d0.id, a.id)!;
    expect(copy.engineIdx).toBe(1);
    expect(copy.name).toBe('Pattern 1 copy');
    expect(a.patternId).toBe(copy.id);
    expect(d0.clips[1].patternId).toBe(pat0.id); // the other clip keeps the original
    expect(d0.currentPatternId).toBe(pat0.id); // does not change what is being edited
    expect(sent).toEqual([
      [Op.COPY_PATTERN, 0, 0, 1, 0],
      [Op.CLIP_SET, 0, 0 * 16 + 1, 0, 16 * 240],
    ]);
    expect(makeUnique(p, sink, d0.id, 'nope')).toBeNull();
  });

  it('moveClips refuses cross-kind lanes (and, for now, every lane move: ruling R4)', () => {
    const { p, sink, sent, d0, d2 } = setup();
    const c = addClip(p, sink, d0.id, { start: 0 })!;
    sent.length = 0;
    expect(moveClips(p, sink, [c.id], 3840, 1)).toBe(false); // d0 -> s1 (synth)
    expect(moveClips(p, sink, [c.id], 0, -1)).toBe(false); // no lane above
    expect(moveClips(p, sink, [c.id], 0, 2)).toBe(false); // d0 -> d2, same kind: refused too
    expect(sent).toEqual([]);
    expect(d2.clips).toEqual([]);
    expect(d0.clips).toHaveLength(1);
    expect(c.start).toBe(0);
  });

  it('moveClips moves in time, the group clamped to the song; repeated ids count once', () => {
    const { p, sink, sent, d0 } = setup();
    const a = addClip(p, sink, d0.id, { start: 3840 })!;
    const b = addClip(p, sink, d0.id, { start: 7680 })!;
    sent.length = 0;
    expect(moveClips(p, sink, [a.id, b.id, a.id], -10000)).toBe(true); // clamped: a lands on 0
    expect([a.start, b.start]).toEqual([0, 3840]);
    expect(sent).toEqual([
      [Op.CLIP_SET, 0, 0, 0, 3840],
      [Op.CLIP_SET, 1, 0, 3840, 3840],
    ]);
    sent.length = 0;
    expect(moveClips(p, sink, [b.id], MAX_SONG_TICKS)).toBe(true); // clamped to the song end
    expect(b.start + b.len).toBe(MAX_SONG_TICKS);
    expect(moveClips(p, sink, [b.id], 0)).toBe(true); // no change: nothing sent
    expect(sent).toHaveLength(1);
  });

  it('automation follows clips: a time move carries the points in [start, end) and replaces the destination\'s', () => {
    const { p, sink, d0, d2 } = setup();
    const a = addClip(p, sink, d0.id, { start: 0, len: 3840 })!;
    const lane = addLane(p, sink, d0.id, { kind: 'mix', param: 'pan' })!;
    const other = addLane(p, sink, d2.id, { kind: 'mix', param: 'pan' })!;
    for (const [tick, value] of [[0, -1], [1920, 0], [3840, 0.5], [9000, 0.2], [10000, 0.9]] as const) addPoint(p, sink, lane.id, { tick, value });
    addPoint(p, sink, other.id, { tick: 100, value: 1 });
    const at = () => lane.points.map((x) => [x.tick, x.value]);
    // Into 7680..11520: 0 and 1920 go along; 3840 (the clip's end) stays; 9000 and 10000 are replaced.
    expect(moveClips(p, sink, [a.id], 7680)).toBe(true);
    expect(at()).toEqual([[3840, 0.5], [7680, -1], [9600, 0]]);
    expect(other.points.map((x) => x.tick)).toEqual([100]); // another track's lanes never move
    // carry: false (a drag's steps): the clip only.
    expect(moveClips(p, sink, [a.id], -7680, 0, { carry: false })).toBe(true);
    expect(a.start).toBe(0);
    expect(at()).toEqual([[3840, 0.5], [7680, -1], [9600, 0]]);
    // A duplicate copies (the source keeps its points), replacing what was under the copy.
    moveClips(p, sink, [a.id], 7680, 0, { carry: false }); // back over its points
    duplicateClips(p, sink, [a.id]);
    expect(at()).toEqual([[3840, 0.5], [7680, -1], [9600, 0], [11520, -1], [13440, 0]]);
  });

  it('resizeClip edits start/len/offset; invalid values are refused', () => {
    const { p, sink, sent, d0 } = setup();
    const c = addClip(p, sink, d0.id, { start: 3840 })!;
    sent.length = 0;
    expect(resizeClip(p, sink, c.id, { len: 3840 * 3 })).toBe(true);
    expect(resizeClip(p, sink, c.id, { start: 3600, len: 3840 * 3 + 240, offset: 3600 })).toBe(true);
    expect(resizeClip(p, sink, c.id, { len: 0 })).toBe(false);
    expect(resizeClip(p, sink, c.id, { offset: -1 })).toBe(false);
    expect(resizeClip(p, sink, c.id, { start: MAX_SONG_TICKS })).toBe(false);
    expect([c.start, c.len, c.offset]).toEqual([3600, 3840 * 3 + 240, 3600]);
    expect(sent).toEqual([
      [Op.CLIP_SET, 0, 0, 3840, 3840 * 3],
      [Op.CLIP_SET, 0, 3600 * 16, 3600, 3840 * 3 + 240],
    ]);
  });

  it('deleteClips sends CLIP_REMOVE across tracks; duplicateClips places copies right after', () => {
    const { p, sink, sent, d0, s1 } = setup();
    const a = addClip(p, sink, d0.id, { start: 0, len: 1000, offset: 20 })!;
    const b = addClip(p, sink, s1.id, { start: 3840 })!;
    sent.length = 0;
    const copies = duplicateClips(p, sink, [a.id, b.id]);
    expect(copies.map((c) => [c.idx, c.start, c.len, c.offset, 'patternId' in c && c.patternId])).toEqual([
      [1, 1000, 1000, 20, a.patternId],
      [1, 3840 + 4 * 3840, 4 * 3840, 0, b.patternId],
    ]);
    expect(sent).toEqual([
      [Op.CLIP_SET, 1, 20 * 16, 1000, 1000],
      [Op.CLIP_SET, MAX_CLIPS + 1, 0, 19200, 15360],
    ]);
    sent.length = 0;
    deleteClips(p, sink, [a.id, b.id, 'nope', a.id]); // a repeated id must not remove another clip

    expect(sent).toEqual([[Op.CLIP_REMOVE, 0, 0, 0, 0], [Op.CLIP_REMOVE, MAX_CLIPS, 0, 0, 0]]);
    expect(d0.clips.map((c) => c.idx)).toEqual([1]);
    expect(s1.clips.map((c) => c.idx)).toEqual([1]);
  });

  it('a clip of a later pattern packs that pattern\'s engine index', () => {
    const { p, sink, sent, s1 } = setup();
    const pat = newPattern(p, sink, s1.id)!;
    selectPattern(p, sink, s1.id, s1.patterns[0].id);
    sent.length = 0;
    addClip(p, sink, s1.id, { start: 0, patternId: pat.id, offset: 3 });
    expect(sent).toEqual([[Op.CLIP_SET, MAX_CLIPS, 3 * 16 + 1, 0, 4 * 3840]]);
  });
});

describe('audio clips on the timeline (plan 9)', () => {
  /** setup() plus Audio tracks at slots 3 and 4 (lanes 3, 4) and a 2 s sample 7 at 120 BPM. */
  function audioSetup() {
    const s = setup();
    s.p.tempo = 120; // 1920 ticks per second
    s.p.sampleMeta.set(7, { seconds: 2, channels: 1, peaks: null });
    const a3 = addAudioTrack(s.p, s.sink)!;
    const a4 = addAudioTrack(s.p, s.sink)!;
    s.sent.length = 0;
    return { ...s, a3, a4 };
  }
  const ops = (sent: number[][]) => sent.map((x) => x[0]);

  it('splitClips splits note and audio clips', () => {
    const { p, sink, sent, d0, a3 } = audioSetup();
    const n = addClip(p, sink, d0.id, { start: 0, len: 7680, offset: 240 })!; // pattern: 3840 ticks
    const a = addAudioClip(p, sink, a3.id, { sampleId: 7, start: 3840, len: 3840 })!;
    a.fadeIn = 300;
    a.fadeOut = 600;
    const outside = addClip(p, sink, d0.id, { start: 20000, len: 100 })!;
    sent.length = 0;
    const right = splitClips(p, sink, [n.id, a.id, outside.id], 4800);
    expect(right).toHaveLength(2);
    // Note clip: the right half continues in the pattern where the left stopped.
    expect([n.start, n.len, n.offset]).toEqual([0, 4800, 240]);
    const [rn, ra] = right;
    expect(rn).toMatchObject({ start: 4800, len: 2880, offset: (240 + 4800) % 3840 });
    expect('patternId' in rn && rn.patternId).toBe(n.patternId);
    // Audio clip: left keeps its fade-in, the right half its fade-out, and
    // the offset moves on by the left half's length in seconds.
    expect([a.start, a.len, a.offset, a.fadeIn, a.fadeOut]).toEqual([3840, 960, 0, 300, 0]);
    expect(ra).toMatchObject({ start: 4800, len: 2880, sampleId: 7, fadeIn: 0, fadeOut: 600 });
    expect('offset' in ra && ra.offset).toBeCloseTo(0.5, 12);
    expect(outside.len).toBe(100); // the split tick is outside: untouched
    expect(ops(sent)).toEqual([
      Op.CLIP_SET, Op.CLIP_SET,
      Op.AUDIO_CLIP_SOURCE, Op.AUDIO_CLIP_GAIN, Op.AUDIO_CLIP_SET,
      Op.AUDIO_CLIP_SOURCE, Op.AUDIO_CLIP_GAIN, Op.AUDIO_CLIP_SET,
    ]);
    // On a clip edge: nothing to split.
    sent.length = 0;
    expect(splitClips(p, sink, [n.id], 0)).toEqual([]);
    expect(splitClips(p, sink, [n.id], 4800)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('audio clips move between audio lanes only', () => {
    const { p, sink, sent, d0, a3, a4 } = audioSetup();
    const a = addAudioClip(p, sink, a3.id, { sampleId: 7, start: 0 })!;
    const b = addAudioClip(p, sink, a3.id, { sampleId: 7, start: 3840 })!;
    addAudioClip(p, sink, a4.id, { sampleId: 7, start: 0 }); // a4 idx 0 is taken
    const n = addClip(p, sink, d0.id, { start: 0 })!;
    sent.length = 0;
    // Onto a drum lane, past the last lane, or with a note clip: refused, nothing moves.
    expect(moveClips(p, sink, [a.id], 0, -1)).toBe(false); // lane 2: a drum track
    expect(moveClips(p, sink, [a.id], 0, 2)).toBe(false); // no lane 5
    expect(moveClips(p, sink, [a.id, n.id], 0, 1)).toBe(false); // a note clip keeps ruling R4
    expect(sent).toEqual([]);
    // Audio lane 3 -> 4: re-homed with a free idx there, the UI id kept.
    const id = a.id;
    expect(moveClips(p, sink, [a.id], 960, 1)).toBe(true);
    expect(a3.clips.map((c) => c.id)).toEqual([b.id]);
    const moved = a4.clips.find((c) => c.id === id)!;
    expect(moved).toMatchObject({ idx: 1, start: 960, sampleId: 7 });
    expect(sent).toEqual([
      [Op.CLIP_REMOVE, 3 * MAX_CLIPS + 0, 0, 0, 0],
      [Op.AUDIO_CLIP_SOURCE, 4 * MAX_CLIPS + 1, 7, 0, 0],
      [Op.AUDIO_CLIP_GAIN, 4 * MAX_CLIPS + 1, 1, 0, 0],
      [Op.AUDIO_CLIP_SET, 4 * MAX_CLIPS + 1, 960, 3840, 0],
    ]);
    // In time only, on its lane: SOURCE, GAIN, SET.
    sent.length = 0;
    expect(moveClips(p, sink, [b.id], 100)).toBe(true);
    expect(ops(sent)).toEqual([Op.AUDIO_CLIP_SOURCE, Op.AUDIO_CLIP_GAIN, Op.AUDIO_CLIP_SET]);
  });

  it('resize, delete and duplicate handle audio clips', () => {
    const { p, sink, sent, a3 } = audioSetup();
    const a = addAudioClip(p, sink, a3.id, { sampleId: 7, start: 0, len: 960 })!;
    a.gain = -3;
    sent.length = 0;
    expect(resizeClip(p, sink, a.id, { len: 1920, offset: 0.25 })).toBe(true);
    expect([a.len, a.offset]).toEqual([1920, 0.25]);
    expect(resizeClip(p, sink, a.id, { len: 0 })).toBe(false);
    const [copy] = duplicateClips(p, sink, [a.id]);
    expect(copy).toMatchObject({ idx: 1, start: 1920, len: 1920, offset: 0.25, gain: -3, sampleId: 7 });
    sent.length = 0;
    deleteClips(p, sink, [a.id, copy.id]);
    expect(sent).toEqual([[Op.CLIP_REMOVE, 3 * MAX_CLIPS, 0, 0, 0], [Op.CLIP_REMOVE, 3 * MAX_CLIPS + 1, 0, 0, 0]]);
    expect(a3.clips).toEqual([]);
  });
});

describe('transports', () => {
  it('playPattern while the song plays: stops, then Pattern mode, then plays', () => {
    const { p, sink, sent } = setup();
    expect(playSong(p, sink)).toBe(true);
    expect([p.mode, p.playing]).toEqual(['song', true]);
    sent.length = 0;
    const calls: string[] = [];
    const hooks = { beforeStop: () => calls.push(`stop:${p.playing}`), countIn: () => (calls.push(`countIn:${p.mode}`), 3840) };
    expect(playPattern(p, sink, hooks)).toBe(true);
    expect(sent.map((x) => x[0])).toEqual([Op.STOP, Op.SET_MODE, Op.SET_PATTERN_FOCUS, Op.PLAY]);
    expect(sent[1][1]).toBe(0); // Pattern mode
    expect(sent[2][1]).toBe(2); // only the selected track (d2) plays
    expect(sent[3][1]).toBe(3840); // the count-in, asked once the mode is Pattern
    expect(calls).toEqual(['stop:true', 'countIn:pattern']);
    expect([p.mode, p.playing]).toEqual(['pattern', true]);
  });

  it('playSong while the pattern plays: stops, then Song mode (+ SEEK), then plays', () => {
    const { p, sink, sent } = setup();
    playPattern(p, sink);
    seek(p, sink, 3840);
    sent.length = 0;
    expect(playSong(p, sink)).toBe(true);
    expect(sent).toEqual([
      [Op.STOP, 0, 0, 0, 0], [Op.SET_MODE, 1, 0, 0, 0], [Op.SEEK, 3840, 0, 0, 0],
      [Op.SET_PATTERN_FOCUS, PATTERN_FOCUS_NONE, 0, 0, 0], [Op.PLAY, 0, 0, 0, 0],
    ]);
    expect([p.mode, p.playing]).toEqual(['song', true]);
  });

  it('starting the transport that already runs sends nothing; from stopped there is no STOP', () => {
    const { p, sink, sent } = setup();
    playPattern(p, sink); // mode already Pattern: the focus, PLAY
    expect(sent).toEqual([[Op.SET_PATTERN_FOCUS, 2, 0, 0, 0], [Op.PLAY, 0, 0, 0, 0]]);
    sent.length = 0;
    let stops = 0;
    expect(playPattern(p, sink, { beforeStop: () => stops++ })).toBe(true);
    expect(sent).toEqual([]);
    expect(stops).toBe(0);
  });

  it('a refused PLAY leaves the transport stopped (and the other one stopped too)', () => {
    const { p, sink } = setup();
    playSong(p, sink);
    const refusing = { send: (op: number, ...a: number[]) => (op === Op.PLAY ? false : sink.send(op, ...a)) };
    expect(playPattern(p, refusing)).toBe(false);
    expect([p.mode, p.playing]).toEqual(['pattern', false]);
  });

  it('toggleTransport stops the transport that runs, else starts it; stopTransport is a no-op when stopped', () => {
    const { p, sink, sent } = setup();
    toggleTransport(p, sink, 'song');
    expect([p.mode, p.playing]).toEqual(['song', true]);
    toggleTransport(p, sink, 'pattern'); // the other one: switches
    expect([p.mode, p.playing]).toEqual(['pattern', true]);
    toggleTransport(p, sink, 'pattern');
    expect(p.playing).toBe(false);
    sent.length = 0;
    let stops = 0;
    stopTransport(p, sink, { beforeStop: () => stops++ });
    expect([sent, stops]).toEqual([[], 0]);
  });
});

describe('pattern focus (plan 20 task 12): the pattern transport plays only the shown track', () => {
  const focuses = (sent: number[][]) => sent.filter((x) => x[0] === Op.SET_PATTERN_FOCUS).map((x) => x[1]);

  it('selecting another pattern track while the pattern plays moves the focus', () => {
    const { p, sink, sent, d0, s1 } = setup();
    playPattern(p, sink);
    expect(focuses(sent)).toEqual([2]);
    sent.length = 0;
    selectTrack(p, sink, s1.id);
    selectTrack(p, sink, d0.id);
    expect(focuses(sent)).toEqual([1, 0]);
  });

  it('an Audio track (no pattern) keeps the last focus', () => {
    const { p, sink, sent, d0 } = setup();
    const a = addAudioTrack(p, sink)!; // selects it (stopped: no focus)
    selectTrack(p, sink, d0.id);
    expect(focuses(sent)).toEqual([]);
    playPattern(p, sink);
    sent.length = 0;
    selectTrack(p, sink, a.id);
    expect(focuses(sent)).toEqual([]);
  });

  it('no pattern track selected at Play: every track plays (255)', () => {
    const { p, sink, sent } = setup();
    addAudioTrack(p, sink); // selected
    sent.length = 0;
    playPattern(p, sink);
    expect(focuses(sent)).toEqual([PATTERN_FOCUS_NONE]);
  });

  it('stopped, or the song playing: selecting sends no focus', () => {
    const { p, sink, sent, d0, s1 } = setup();
    selectTrack(p, sink, s1.id);
    playSong(p, sink);
    sent.length = 0;
    selectTrack(p, sink, d0.id);
    expect(focuses(sent)).toEqual([]);
  });

  it('removing the focused track while the pattern plays moves the focus with the selection', () => {
    const { p, sink, sent, s1 } = setup();
    selectTrack(p, sink, s1.id);
    playPattern(p, sink);
    sent.length = 0;
    removeTrack(p, sink, s1.id); // the selection moves to d2 (slot 2)
    expect(p.selectedTrackId).toBe(p.tracks[1].id);
    expect(focuses(sent)).toEqual([2]);
  });

  it('removing the focused track while the pattern plays with an Audio track (or nothing) left selected stops it', () => {
    const { p, sink, sent, d0, s1, d2 } = setup();
    const a = addAudioTrack(p, sink)!;
    selectTrack(p, sink, s1.id);
    playPattern(p, sink);
    selectTrack(p, sink, a.id); // the focus stays on s1
    sent.length = 0;
    removeTrack(p, sink, s1.id);
    expect(p.selectedTrackId).toBe(a.id);
    expect(p.playing).toBe(false);
    expect(sent.map((x) => x[0])).toContain(Op.STOP);
    expect(focuses(sent)).toEqual([]);
    // Another (unfocused) track's removal leaves it playing.
    selectTrack(p, sink, d0.id);
    playPattern(p, sink);
    selectTrack(p, sink, a.id);
    removeTrack(p, sink, d2.id);
    expect(p.playing).toBe(true);
    // Removing the selected focused track when the selection falls on nothing: stopped.
    selectTrack(p, sink, d0.id);
    removeTrack(p, sink, a.id);
    expect(p.tracks.map((t) => t.id)).toEqual([d0.id]);
    removeTrack(p, sink, d0.id);
    expect(p.selectedTrackId).toBeNull();
    expect(p.playing).toBe(false);
  });
});

describe('mode, loop, seek', () => {
  it('setMode sends SET_MODE and SEEK', () => {
    const { p, sink, sent } = setup();
    seek(p, sink, 7680);
    sent.length = 0;
    setMode(p, sink, 'song');
    expect(p.mode).toBe('song');
    expect(sent).toEqual([[Op.SET_MODE, 1, 0, 0, 0], [Op.SEEK, 7680, 0, 0, 0]]);
    sent.length = 0;
    setMode(p, sink, 'pattern');
    expect(sent).toEqual([[Op.SET_MODE, 0, 0, 0, 0]]);
    setMode(p, sink, 'pattern'); // unchanged: nothing
    expect(sent).toHaveLength(1);
  });

  it('setLoop sends the range while on and 0,0 when off; invalid ranges are refused', () => {
    const { p, sink, sent } = setup();
    expect(p.loop).toEqual({ on: false, start: 0, end: 4 * 3840 });
    expect(setLoop(p, sink, { on: true })).toBe(true);
    expect(setLoop(p, sink, { start: 3840, end: 11520 })).toBe(true);
    expect(setLoop(p, sink, { on: false })).toBe(true);
    expect(setLoop(p, sink, { start: 7680 })).toBe(true); // off: stored, sends 0,0
    expect(setLoop(p, sink, { start: 5000, end: 5000 })).toBe(false);
    expect(setLoop(p, sink, { end: MAX_SONG_TICKS + 1 })).toBe(false);
    expect(setLoop(p, sink, { start: NaN })).toBe(false);
    expect(p.loop).toEqual({ on: false, start: 7680, end: 11520 });
    expect(sent).toEqual([
      [Op.SET_LOOP, 0, 15360, 0, 0],
      [Op.SET_LOOP, 3840, 11520, 0, 0],
      [Op.SET_LOOP, 0, 0, 0, 0],
      [Op.SET_LOOP, 0, 0, 0, 0],
    ]);
  });

  it('seek clamps and remembers the song position', () => {
    const { p, sink, sent } = setup();
    seek(p, sink, -5);
    seek(p, sink, MAX_SONG_TICKS + 99);
    seek(p, sink, 1234.6);
    seek(p, sink, NaN);
    expect(p.songPosition).toBe(1235);
    expect(sent).toEqual([[Op.SEEK, 0, 0, 0, 0], [Op.SEEK, MAX_SONG_TICKS, 0, 0, 0], [Op.SEEK, 1235, 0, 0, 0]]);
  });

  it('Stop in Song mode with the loop on parks the song position at the loop start', () => {
    const { p, sink } = setup();
    setMode(p, sink, 'song');
    seek(p, sink, 9000);
    stop(p, sink);
    expect(p.songPosition).toBe(9000);
    setLoop(p, sink, { on: true, start: 3840, end: 7680 });
    stop(p, sink);
    expect(p.songPosition).toBe(3840);
  });

  it('track types carry patterns and clips', () => {
    const { d0, s1 } = setup();
    const d: DrumTrack = d0;
    const s: SynthTrack = s1;
    expect(currentPattern(d).steps).toHaveLength(16);
    expect(currentPattern(s).bars).toBe(4);
    expect(d.clips).toEqual([]);
  });
});

describe('patternPosAt', () => {
  it('maps song ticks inside a clip, null outside or for another pattern', () => {
    const { p, sink, d0 } = setup();
    const pid = d0.patterns[0].id; // 16 steps = 3840 ticks
    addClip(p, sink, d0.id, { start: 1000, len: 2000 });
    expect(patternPosAt(d0, pid, 1000)).toBe(0);
    expect(patternPosAt(d0, pid, 1500)).toBe(500);
    expect(patternPosAt(d0, pid, 2999)).toBe(1999);
    expect(patternPosAt(d0, pid, 3000)).toBeNull(); // end is exclusive
    expect(patternPosAt(d0, pid, 999)).toBeNull();
    newPattern(p, sink, d0.id);
    expect(patternPosAt(d0, d0.currentPatternId, 1500)).toBeNull(); // clip plays another pattern
  });

  it('applies offset and repeats via mod pattern length', () => {
    const { p, sink, d0 } = setup();
    const pid = d0.patterns[0].id;
    addClip(p, sink, d0.id, { start: 0, len: 10000, offset: 240 });
    expect(patternPosAt(d0, pid, 0)).toBe(240);
    expect(patternPosAt(d0, pid, 3600)).toBe(0); // 240+3600 = 3840 wraps
    expect(patternPosAt(d0, pid, 9000)).toBe((240 + 9000) % 3840);
  });

  it('overlap: the clip that started latest wins', () => {
    const { p, sink, d0 } = setup();
    const pid = d0.patterns[0].id;
    addClip(p, sink, d0.id, { start: 0, len: 8000 });
    addClip(p, sink, d0.id, { start: 1000, len: 1000, offset: 100 });
    expect(patternPosAt(d0, pid, 500)).toBe(500);
    expect(patternPosAt(d0, pid, 1500)).toBe(600); // later clip: 100 + 500
    expect(patternPosAt(d0, pid, 2500)).toBe(2500); // back to the first
  });

  it('non-finite tick is null', () => {
    const { p, sink, d0 } = setup();
    addClip(p, sink, d0.id, { start: 0 });
    expect(patternPosAt(d0, d0.patterns[0].id, NaN)).toBeNull();
  });
});
