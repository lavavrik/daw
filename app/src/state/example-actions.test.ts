import { describe, expect, it } from 'vitest';
import { MAX_NOTES, MAX_PATTERNS, Op } from '../audio/protocol';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';
import { addDrumTrack } from './actions';
import { addExamplePattern, addExampleTrack } from './example-actions';
import { exampleFor } from './houseExamples';
import { HOUSE_GROUPS } from './housePatches';
import { newPattern } from './pattern-actions';
import { MAX_TRACKS, Project, currentPattern } from './project.svelte';
import type { SynthTrack } from './project.svelte';
import { addSynthTrack } from './rack-actions';

/** A project with one synth track, its history installed as App does it. */
function setup() {
  const sent: number[][] = [];
  const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
  const p = new Project();
  const t = addSynthTrack(p, sink)!;
  const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
  p.history = h;
  sent.length = 0;
  return { p, sink, sent, h, t };
}

const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('example actions', () => {
  it('addExamplePattern adds, fills and selects the example', () => {
    const s = setup();
    const ex = exampleFor('Acid Line')!;
    const pat = addExamplePattern(s.p, s.sink, s.t.id, ex)!;
    expect(pat).not.toBeNull();
    expect(s.t.patterns).toHaveLength(2);
    expect(s.t.currentPatternId).toBe(pat.id);
    expect(pat.name).toBe('Acid Line example');
    expect(pat.bars).toBe(1);
    expect(pat.notes.map(({ pitch, vel, start, len }) => ({ pitch, vel, start, len }))).toEqual(ex.notes);
    // The engine got the switch, the length and every note (on the new pattern's slot).
    expect(s.sent).toContainEqual([Op.SET_CURRENT_PATTERN, s.t.slot, pat.engineIdx, 0, 0]);
    expect(s.sent.filter((c) => c[0] === Op.SET_PATTERN_BARS).at(-1)).toEqual([Op.SET_PATTERN_BARS, s.t.slot, 1, 0, 0]);
    expect(s.sent.filter((c) => c[0] === Op.NOTE_SET)).toHaveLength(16);
    // A second copy gets a free name.
    expect(addExamplePattern(s.p, s.sink, s.t.id, ex)!.name).toBe('Acid Line example 2');
  });

  it('addExamplePattern is one undo step', () => {
    const s = setup();
    const before = plain(serialize(s.p));
    const first = s.t.currentPatternId;
    addExamplePattern(s.p, s.sink, s.t.id, exampleFor('Sax')!);
    expect(s.h.labels.undo).toBe('Add example pattern');
    expect(s.h.undo()).toBe(true);
    expect(s.h.canUndo).toBe(false); // the whole thing was one entry
    expect(s.t.currentPatternId).toBe(first);
    expect(plain(serialize(s.p))).toEqual(before);
    expect(s.h.redo()).toBe(true);
    expect(currentPattern(s.t).name).toBe('Sax example');
    expect(currentPattern(s.t).notes).toHaveLength(9);
  });

  it('addExampleTrack loads the patch and selects the example', () => {
    const s = setup();
    const before = plain(serialize(s.p));
    const sax = HOUSE_GROUPS.flatMap((g) => g.patches).find((x) => x.name === 'Sax')!;
    const t = addExampleTrack(s.p, s.sink, exampleFor('Sax')!)!;
    expect(t).not.toBeNull();
    expect(t.name).toBe('Sax');
    expect(t.patchName).toBe('Sax');
    expect(t.modules).toHaveLength(sax.modules.length);
    expect(s.p.selectedTrackId).toBe(t.id);
    // The example IS the track's pattern (no empty "Pattern 1" beside it).
    expect(t.patterns).toHaveLength(1);
    expect(currentPattern(t).name).toBe('Sax example');
    expect(currentPattern(t).bars).toBe(2);
    expect(currentPattern(t).notes).toHaveLength(9);
    expect(s.sent.filter((c) => c[0] === Op.NOTE_SET && Math.floor(c[1] / MAX_NOTES) === t.slot)).toHaveLength(9);
    // One undo removes track, patch and pattern.
    expect(s.h.labels.undo).toBe('Add example track');
    s.h.undo();
    expect(s.h.canUndo).toBe(false);
    expect(plain(serialize(s.p))).toEqual(before);
    // A second Sax track gets a free name.
    expect(addExampleTrack(s.p, s.sink, exampleFor('Sax')!)!.name).toBe('Sax');
    expect(addExampleTrack(s.p, s.sink, exampleFor('Sax')!)!.name).toBe('Sax 2');
  });

  it('full patterns → null, nothing changed', () => {
    const s = setup();
    for (let i = 1; i < MAX_PATTERNS; i++) newPattern(s.p, s.sink, s.t.id);
    expect(s.t.patterns).toHaveLength(MAX_PATTERNS);
    const before = plain(serialize(s.p));
    const undo = s.h.labels.undo;
    s.sent.length = 0;
    expect(addExamplePattern(s.p, s.sink, s.t.id, exampleFor('Acid Line')!)).toBeNull();
    expect(s.sent).toEqual([]);
    expect(plain(serialize(s.p))).toEqual(before);
    expect(s.h.labels.undo).toBe(undo); // no new entry
    // An unknown or drum track: refused too.
    expect(addExamplePattern(s.p, s.sink, 'nope', exampleFor('Acid Line')!)).toBeNull();
    const d = addDrumTrack(s.p, s.sink)!;
    s.sent.length = 0;
    expect(addExamplePattern(s.p, s.sink, d.id, exampleFor('Acid Line')!)).toBeNull();
    expect(s.sent).toEqual([]);
  });

  it('full tracks → null, nothing changed', () => {
    const s = setup();
    while (s.p.tracks.length < MAX_TRACKS) addDrumTrack(s.p, s.sink);
    const before = plain(serialize(s.p));
    const undo = s.h.labels.undo;
    s.sent.length = 0;
    expect(addExampleTrack(s.p, s.sink, exampleFor('Sax')!)).toBeNull();
    expect(s.sent).toEqual([]);
    expect(plain(serialize(s.p))).toEqual(before);
    expect(s.h.labels.undo).toBe(undo);
  });

  it('an example whose patch is not built in → null, nothing changed', () => {
    const s = setup();
    const before = plain(serialize(s.p));
    s.sent.length = 0;
    const bogus = { ...exampleFor('Sax')!, patch: 'No Such Patch' };
    expect(addExampleTrack(s.p, s.sink, bogus)).toBeNull();
    expect(s.sent).toEqual([]);
    expect(plain(serialize(s.p))).toEqual(before);
    expect((s.p.tracks[0] as SynthTrack).patterns).toHaveLength(1);
  });
});
