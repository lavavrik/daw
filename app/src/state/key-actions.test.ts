import { describe, expect, it } from 'vitest';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { projectCommands } from '../project/commands';
import { serialize } from '../project/serialize';
import { Op } from '../audio/protocol';
import { applyKey, keyCommands, setKey } from './key-actions';
import { addNote, fitNotesToKey, transposeNotes } from './pattern-actions';
import { Project, currentPattern } from './project.svelte';
import { addSynthTrack } from './rack-actions';

/** A synth track; history installed as App does it. */
function setup() {
  const sent: number[][] = [];
  const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
  const p = new Project();
  const s = addSynthTrack(p, sink)!;
  const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
  p.history = h;
  sent.length = 0;
  const note = (pitch: number, start = 0) => addNote(p, sink, s.id, { pitch, start, len: 240 })!;
  const pitches = () => currentPattern(s).notes.map((n) => n.pitch);
  return { p, sink, sent, h, s, note, pitches };
}

describe('setKey', () => {
  it('a new project is in A minor; setKey is one "Key" entry, marks the project edited, and undoes', () => {
    const x = setup();
    expect(x.p.key).toEqual({ root: 9, scale: 'minor' });
    x.p.dirty = false;
    const v = x.p.version;
    expect(setKey(x.p, x.sink, { root: 0, scale: 'major' })).toBe(true);
    expect(x.p.key).toEqual({ root: 0, scale: 'major' });
    expect(x.p.dirty).toBe(true);
    expect(x.p.version).toBeGreaterThan(v);
    expect(x.h.labels.undo).toBe('Key');
    expect(serialize(x.p).key).toEqual({ root: 0, scale: 'major' });
    x.h.undo();
    expect(x.p.key).toEqual({ root: 9, scale: 'minor' });
    x.h.redo();
    expect(x.p.key).toEqual({ root: 0, scale: 'major' });
  });

  it('the same key or an invalid one changes nothing and adds no entry', () => {
    const x = setup();
    expect(setKey(x.p, x.sink, { root: 9, scale: 'minor' })).toBe(false);
    expect(setKey(x.p, x.sink, { root: 12, scale: 'minor' })).toBe(false);
    expect(setKey(x.p, x.sink, { root: 1.5, scale: 'minor' })).toBe(false);
    expect(setKey(x.p, x.sink, { root: 0, scale: 'lydian' as never })).toBe(false);
    expect(x.h.labels.undo).toBeNull();
    expect(applyKey(x.p, x.sink, { root: 9, scale: 'minor' })).toBe(false);
  });

  it('the key is replaced whole (a held reference to the old one never changes)', () => {
    const x = setup();
    const old = x.p.key;
    setKey(x.p, x.sink, { root: 4, scale: 'dorian' });
    expect(old).toEqual({ root: 9, scale: 'minor' });
  });

  it('the engine hears SET_KEY root, scale index from setKey, undo/redo and projectCommands (plan 26 Task 3)', () => {
    const x = setup();
    expect(keyCommands({ root: 0, scale: 'major' })).toEqual([[Op.SET_KEY, 0, 0]]);
    expect(keyCommands({ root: 11, scale: 'chromatic' })).toEqual([[Op.SET_KEY, 11, 7]]);
    setKey(x.p, x.sink, { root: 0, scale: 'major' });
    expect(x.sent).toEqual([[Op.SET_KEY, 0, 0, 0, 0]]);
    x.sent.length = 0;
    x.h.undo();
    expect(x.sent).toEqual([[Op.SET_KEY, 9, 1, 0, 0]]);
    x.sent.length = 0;
    x.h.redo();
    expect(x.sent).toEqual([[Op.SET_KEY, 0, 0, 0, 0]]);
    const cmds = projectCommands(serialize(x.p), new Map()).commands;
    const tail = keyCommands(x.p.key);
    expect(cmds.slice(cmds.length - tail.length)).toEqual(tail);
  });
});

describe('transposeNotes', () => {
  it('+3 on the selection only, one "Transpose" entry; undo restores', () => {
    const x = setup();
    const a = x.note(60);
    x.note(64, 240);
    const c = x.note(67, 480);
    expect(transposeNotes(x.p, x.sink, x.s.id, [a.id, c.id], 3).semitones).toBe(3);
    expect(x.pitches()).toEqual([63, 64, 70]);
    expect(x.h.labels.undo).toBe('Transpose');
    x.h.undo();
    expect(x.pitches()).toEqual([60, 64, 67]);
  });

  it('no ids = every note; clamped to ±12 and, as a group, to 0..127; 0 is a no-op', () => {
    const x = setup();
    x.note(60);
    x.note(120, 240);
    expect(transposeNotes(x.p, x.sink, x.s.id, [], 30).semitones).toBe(7); // 120 + 7 = 127: the group stops there
    expect(x.pitches()).toEqual([67, 127]);
    expect(transposeNotes(x.p, x.sink, x.s.id, [], -30).semitones).toBe(-12);
    expect(x.pitches()).toEqual([55, 115]);
    const undo = x.h.labels.undo;
    x.h.undo();
    expect(transposeNotes(x.p, x.sink, x.s.id, [], 0).semitones).toBe(0);
    expect(transposeNotes(x.p, x.sink, x.s.id, [], 1).semitones).toBe(0); // 127 already at the top
    expect(x.h.labels.redo).toBe(undo); // nothing new was recorded
    expect(transposeNotes(x.p, x.sink, 'nope', [], 1).semitones).toBe(0);
  });
});

describe('fitNotesToKey', () => {
  it('moves out-of-key notes to the nearest in-key pitch (ties up), one "Fit to key" entry', () => {
    const x = setup(); // A minor
    x.note(61); // C# -> D (tie)
    x.note(56, 240); // G# -> A (tie G/A: up)
    x.note(64, 480); // E stays
    expect(fitNotesToKey(x.p, x.sink, x.s.id).moved).toBe(2);
    expect(x.pitches()).toEqual([62, 57, 64]);
    expect(x.h.labels.undo).toBe('Fit to key');
    x.h.undo();
    expect(x.pitches()).toEqual([61, 56, 64]);
  });

  it('follows the project key; in key (or chromatic) it is a no-op with no entry', () => {
    const x = setup();
    x.note(61);
    setKey(x.p, x.sink, { root: 2, scale: 'major' }); // C# is in D major
    expect(fitNotesToKey(x.p, x.sink, x.s.id).moved).toBe(0);
    expect(x.h.labels.undo).toBe('Key');
    setKey(x.p, x.sink, { root: 0, scale: 'chromatic' });
    expect(fitNotesToKey(x.p, x.sink, x.s.id).moved).toBe(0);
    setKey(x.p, x.sink, { root: 0, scale: 'minorPentatonic' }); // C Eb F G Bb
    expect(fitNotesToKey(x.p, x.sink, x.s.id).moved).toBe(1);
    expect(x.pitches()).toEqual([60]); // C# -> C (1) not Eb (2)
  });

  it('acts on the selection when given one (review #7)', () => {
    const x = setup(); // A minor
    const a = x.note(61);
    x.note(66, 240);
    expect(fitNotesToKey(x.p, x.sink, x.s.id, [a.id])).toEqual({ moved: 1, merged: 0 });
    expect(x.pitches()).toEqual([62, 66]); // F# (not selected) stays
  });
});

describe('stacked notes merge (review #1)', () => {
  /** A note with a given length / velocity. */
  const full = (x: ReturnType<typeof setup>, pitch: number, start: number, len: number, vel: number) =>
    addNote(x.p, x.sink, x.s.id, { pitch, start, len, vel })!;
  const dump = (x: ReturnType<typeof setup>) =>
    currentPattern(x.s).notes.map((n) => [n.pitch, n.start, n.len, n.vel]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  it('Fit to key: G#+A at one start become one A, the longer note with the higher velocity, in the same entry', () => {
    const x = setup(); // A minor
    full(x, 68, 0, 240, 120); // G#: short, loud
    full(x, 69, 0, 480, 80); // A: long, soft
    full(x, 61, 960, 240, 100); // C# elsewhere: moves, merges with nothing
    expect(fitNotesToKey(x.p, x.sink, x.s.id)).toEqual({ moved: 2, merged: 1 });
    expect(dump(x)).toEqual([[62, 960, 240, 100], [69, 0, 480, 120]]);
    expect(x.h.labels.undo).toBe('Fit to key');
    x.h.undo();
    expect(dump(x)).toEqual([[61, 960, 240, 100], [68, 0, 240, 120], [69, 0, 480, 80]]);
  });

  it('Transpose onto a note that did not move merges too; notes at other starts never do', () => {
    const x = setup();
    const a = full(x, 60, 0, 960, 90);
    full(x, 63, 0, 240, 110);
    full(x, 63, 480, 240, 100);
    expect(transposeNotes(x.p, x.sink, x.s.id, [a.id], 3)).toEqual({ semitones: 3, merged: 1 });
    expect(dump(x)).toEqual([[63, 0, 960, 110], [63, 480, 240, 100]]);
    x.h.undo();
    expect(dump(x)).toEqual([[60, 0, 960, 90], [63, 0, 240, 110], [63, 480, 240, 100]]);
  });

  it('a whole-chord transpose keeps every note (nothing lands on anything)', () => {
    const x = setup();
    for (const p of [57, 60, 64, 67]) full(x, p, 0, 240, 100);
    expect(transposeNotes(x.p, x.sink, x.s.id, [], 5)).toEqual({ semitones: 5, merged: 0 });
    expect(dump(x).map((n) => n[0])).toEqual([62, 65, 69, 72]);
  });
});
