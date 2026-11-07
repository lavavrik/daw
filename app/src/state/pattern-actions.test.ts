import { describe, expect, it } from 'vitest';
import { MAX_NOTES, Op } from '../audio/protocol';
import { Project } from './project.svelte';
import { addDrumTrack } from './actions';
import { addSynthTrack } from './rack-actions';
import {
  GRID_TICKS, addNote, clearPattern, deleteNotes, patternTicks, quantizeNotes, setPatternBars, updateNotes,
} from './pattern-actions';

function setup() {
  const sent: number[][] = [];
  const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
  const p = new Project();
  const t = addSynthTrack(p, sink)!;
  sent.length = 0;
  return { p, t, sink, sent };
}

describe('pattern actions', () => {
  it('addNote sends NOTE_SET with packed args', () => {
    const p = new Project();
    const sent: number[][] = [];
    const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
    addDrumTrack(p, sink); addDrumTrack(p, sink); addDrumTrack(p, sink);
    const t = addSynthTrack(p, sink)!; // slot 3
    expect(t.slot).toBe(3);
    sent.length = 0;
    const n = addNote(p, sink, t.id, { pitch: 60, start: 480, len: 240 })!;
    expect(n.idx).toBe(0);
    expect(n.vel).toBe(100);
    expect(sent).toEqual([[Op.NOTE_SET, 3 * MAX_NOTES + 0, 60 * 128 + 100, 480, 240]]);
    expect(t.pattern.notes).toHaveLength(1);
  });

  it('idx reused after delete', () => {
    const { p, t, sink, sent } = setup();
    const a = addNote(p, sink, t.id, { pitch: 60, start: 0, len: 100 })!;
    const b = addNote(p, sink, t.id, { pitch: 62, start: 0, len: 100 })!;
    expect([a.idx, b.idx]).toEqual([0, 1]);
    deleteNotes(p, sink, t.id, [a.id]);
    expect(sent[sent.length - 1]).toEqual([Op.NOTE_REMOVE, t.slot * MAX_NOTES + 0, 0, 0, 0]);
    const c = addNote(p, sink, t.id, { pitch: 64, start: 0, len: 100 })!;
    expect(c.idx).toBe(0);
  });

  it('returns null at MAX_NOTES', () => {
    const { p, t, sink } = setup();
    for (let i = 0; i < MAX_NOTES; i++) expect(addNote(p, sink, t.id, { pitch: 60, start: 0, len: 1 })).not.toBeNull();
    expect(addNote(p, sink, t.id, { pitch: 60, start: 0, len: 1 })).toBeNull();
  });

  it('updateNotes clamps pitch, vel and len', () => {
    const { p, t, sink, sent } = setup();
    const n = addNote(p, sink, t.id, { pitch: 60, start: 0, len: 100 })!;
    sent.length = 0;
    updateNotes(p, sink, t.id, [{ id: n.id, pitch: 200.4, vel: 0, len: 99999, start: 1e9 }]);
    const m = t.pattern.notes[0];
    expect([m.pitch, m.vel, m.len, m.start]).toEqual([127, 1, 61440, patternTicks(t) - 1]);
    expect(sent).toEqual([[Op.NOTE_SET, t.slot * MAX_NOTES, 127 * 128 + 1, patternTicks(t) - 1, 61440]]);
    updateNotes(p, sink, t.id, [{ id: n.id, pitch: -5, vel: 500, len: 0, start: -3 }]);
    expect([m.pitch, m.vel, m.len, m.start]).toEqual([0, 127, 1, 0]);
    updateNotes(p, sink, t.id, [{ id: 'nope', pitch: 1 }]); // unknown id: ignored
  });

  it('quantize 1/16 snaps 250 to 240 and 370 to 480; strength 0.5 moves halfway', () => {
    const { p, t, sink } = setup();
    const a = addNote(p, sink, t.id, { pitch: 60, start: 250, len: 100 })!;
    const b = addNote(p, sink, t.id, { pitch: 60, start: 370, len: 100 })!;
    quantizeNotes(p, sink, t.id, [], GRID_TICKS['1/16']);
    // 370 / 240 = 1.54 -> nearest line 480
    expect(t.pattern.notes.map((n) => n.start)).toEqual([240, 480]);
    updateNotes(p, sink, t.id, [{ id: a.id, start: 250 }, { id: b.id, start: 370 }]);
    quantizeNotes(p, sink, t.id, [a.id, b.id], 240, 0.5);
    expect(t.pattern.notes.map((n) => n.start)).toEqual([245, 425]);
  });

  it('NaN never reaches the engine: fields fall to their lower bound, strength to 1', () => {
    const { p, t, sink, sent } = setup();
    const n = addNote(p, sink, t.id, { pitch: NaN, start: NaN, len: NaN, vel: NaN })!;
    expect([n.pitch, n.start, n.len, n.vel]).toEqual([0, 0, 1, 1]);
    updateNotes(p, sink, t.id, [{ id: n.id, start: 250, len: Infinity }]);
    expect(n.len).toBe(1); // non-finite -> lower bound
    quantizeNotes(p, sink, t.id, [], 240, NaN);
    expect(n.start).toBe(240); // NaN strength = full snap
    expect(sent.flat().every(Number.isFinite)).toBe(true);
  });

  it('quantize wraps a note snapped past the end to 0', () => {
    const { p, t, sink } = setup();
    addNote(p, sink, t.id, { pitch: 60, start: patternTicks(t) - 10, len: 100 });
    quantizeNotes(p, sink, t.id, [], 960);
    expect(t.pattern.notes[0].start).toBe(0);
  });

  it('setPatternBars sends and keeps notes beyond end', () => {
    const { p, t, sink, sent } = setup();
    addNote(p, sink, t.id, { pitch: 60, start: 3 * 3840, len: 100 });
    sent.length = 0;
    setPatternBars(p, sink, t.id, 1);
    expect(sent).toEqual([[Op.SET_PATTERN_BARS, t.slot, 1, 0, 0]]);
    expect(t.pattern.bars).toBe(1);
    expect(t.pattern.notes).toHaveLength(1);
    expect(t.pattern.notes[0].start).toBe(3 * 3840);
    setPatternBars(p, sink, t.id, 99);
    expect(t.pattern.bars).toBe(16);
  });

  it('clearPattern sends NOTE_CLEAR', () => {
    const { p, t, sink, sent } = setup();
    addNote(p, sink, t.id, { pitch: 60, start: 0, len: 100 });
    sent.length = 0;
    clearPattern(p, sink, t.id);
    expect(sent).toEqual([[Op.NOTE_CLEAR, t.slot, 0, 0, 0]]);
    expect(t.pattern.notes).toEqual([]);
  });

  it('unknown / drum track is a no-op', () => {
    const { p, sink, sent } = setup();
    const d = addDrumTrack(p, sink)!;
    sent.length = 0;
    expect(addNote(p, sink, d.id, { pitch: 60, start: 0, len: 1 })).toBeNull();
    expect(addNote(p, sink, 'zzz', { pitch: 60, start: 0, len: 1 })).toBeNull();
    setPatternBars(p, sink, d.id, 2); clearPattern(p, sink, 'zzz');
    expect(sent).toEqual([]);
  });
});
