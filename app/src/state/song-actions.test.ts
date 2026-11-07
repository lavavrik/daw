import { describe, expect, it } from 'vitest';
import { MAX_CLIPS, MAX_SONG_TICKS, Op } from '../audio/protocol';
import { Project, currentPattern } from './project.svelte';
import type { DrumTrack, SynthTrack } from './project.svelte';
import { addDrumTrack, stop } from './actions';
import { addSynthTrack } from './rack-actions';
import { newPattern, selectPattern } from './pattern-actions';
import {
  addClip, deleteClips, duplicateClips, makeUnique, moveClips, patternPosAt, resizeClip, seek, setLoop, setMode,
} from './song-actions';

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
    expect(copies.map((c) => [c.idx, c.start, c.len, c.offset, c.patternId])).toEqual([
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
