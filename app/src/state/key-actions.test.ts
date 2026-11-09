import { describe, expect, it } from 'vitest';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { projectCommands } from '../project/commands';
import { serialize } from '../project/serialize';
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

  it('engine hook: keyCommands is what setKey and projectCommands send (none until plan 26 Task 3)', () => {
    const x = setup();
    expect(keyCommands({ root: 0, scale: 'major' })).toEqual([]);
    setKey(x.p, x.sink, { root: 0, scale: 'major' });
    expect(x.sent).toEqual(keyCommands({ root: 0, scale: 'major' }));
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
    expect(transposeNotes(x.p, x.sink, x.s.id, [a.id, c.id], 3)).toBe(3);
    expect(x.pitches()).toEqual([63, 64, 70]);
    expect(x.h.labels.undo).toBe('Transpose');
    x.h.undo();
    expect(x.pitches()).toEqual([60, 64, 67]);
  });

  it('no ids = every note; clamped to ±12 and, as a group, to 0..127; 0 is a no-op', () => {
    const x = setup();
    x.note(60);
    x.note(120, 240);
    expect(transposeNotes(x.p, x.sink, x.s.id, [], 30)).toBe(7); // 120 + 7 = 127: the group stops there
    expect(x.pitches()).toEqual([67, 127]);
    expect(transposeNotes(x.p, x.sink, x.s.id, [], -30)).toBe(-12);
    expect(x.pitches()).toEqual([55, 115]);
    const undo = x.h.labels.undo;
    x.h.undo();
    expect(transposeNotes(x.p, x.sink, x.s.id, [], 0)).toBe(0);
    expect(transposeNotes(x.p, x.sink, x.s.id, [], 1)).toBe(0); // 127 already at the top
    expect(x.h.labels.redo).toBe(undo); // nothing new was recorded
    expect(transposeNotes(x.p, x.sink, 'nope', [], 1)).toBe(0);
  });
});

describe('fitNotesToKey', () => {
  it('moves out-of-key notes to the nearest in-key pitch (ties up), one "Fit to key" entry', () => {
    const x = setup(); // A minor
    x.note(61); // C# -> D (tie)
    x.note(56, 240); // G# -> A (tie G/A: up)
    x.note(64, 480); // E stays
    expect(fitNotesToKey(x.p, x.sink, x.s.id)).toBe(2);
    expect(x.pitches()).toEqual([62, 57, 64]);
    expect(x.h.labels.undo).toBe('Fit to key');
    x.h.undo();
    expect(x.pitches()).toEqual([61, 56, 64]);
  });

  it('follows the project key; in key (or chromatic) it is a no-op with no entry', () => {
    const x = setup();
    x.note(61);
    setKey(x.p, x.sink, { root: 2, scale: 'major' }); // C# is in D major
    expect(fitNotesToKey(x.p, x.sink, x.s.id)).toBe(0);
    expect(x.h.labels.undo).toBe('Key');
    setKey(x.p, x.sink, { root: 0, scale: 'chromatic' });
    expect(fitNotesToKey(x.p, x.sink, x.s.id)).toBe(0);
    setKey(x.p, x.sink, { root: 0, scale: 'minorPentatonic' }); // C Eb F G Bb
    expect(fitNotesToKey(x.p, x.sink, x.s.id)).toBe(1);
    expect(x.pitches()).toEqual([60]); // C# -> C (1) not Eb (2)
  });
});
