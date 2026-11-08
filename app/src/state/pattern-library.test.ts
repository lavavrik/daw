import { describe, expect, it } from 'vitest';
import { MAX_NOTES, MAX_PATTERNS, Op } from '../audio/protocol';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';
import { validate } from '../project/schema';
import { addDrumTrack, setStep, setSwing, setStepCount } from './actions';
import {
  deleteLibraryPattern, droppedRowsText, freeLibraryName, libraryJson, libraryState, loadBlocked, loadPatternFromLibrary,
  mapLibraryRows, renameLibraryPattern, savePatternToLibrary,
} from './pattern-library';
import { addNote, newPattern, setPatternBars } from './pattern-actions';
import { MAX_STEPS, Project, currentPattern } from './project.svelte';
import { addSynthTrack } from './rack-actions';

const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/**
 * Two drum tracks and a synth track; history installed as App does it.
 * Drums A: Kick, Snare, Hat (kick.wav, snare.wav, hat.wav). Drums B: the
 * same samples in another order with other row names, plus a Clap and no
 * hat: Snr (snare.wav), Clap (clap.wav), Bd (kick.wav).
 */
function setup() {
  const sent: number[][] = [];
  const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
  const p = new Project();
  const file = (name: string) => ({ name, type: 'audio/wav', bytes: new ArrayBuffer(4), hash: '00000000' });
  ['kick.wav', 'snare.wav', 'hat.wav', 'clap.wav'].forEach((n, id) => p.sampleFiles.set(id, file(n)));
  const a = addDrumTrack(p, sink, 'Drums A', ['Kick', 'Snare', 'Hat'])!;
  [0, 1, 2].forEach((id, i) => (a.rows[i].sampleId = id));
  const b = addDrumTrack(p, sink, 'Drums B', ['Snr', 'Clap', 'Bd'])!;
  [1, 3, 0].forEach((id, i) => (b.rows[i].sampleId = id));
  const s = addSynthTrack(p, sink)!;
  const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
  p.history = h;
  sent.length = 0;
  return { p, sink, sent, h, a, b, s };
}

/** Kick on 0 4 8 12, Snare on 4 12 (vel 90), Hat on every odd step; 32 steps, swing 0.25. */
function beat(x: ReturnType<typeof setup>) {
  const { p, sink, a } = x;
  setStepCount(p, sink, a.id, 32);
  setSwing(p, sink, a.id, 0.25);
  for (const s of [0, 4, 8, 12]) setStep(p, sink, a.id, a.rows[0].id, s, 100);
  for (const s of [4, 12]) setStep(p, sink, a.id, a.rows[1].id, s, 90);
  for (let s = 1; s < 32; s += 2) setStep(p, sink, a.id, a.rows[2].id, s, 60);
}

const onSteps = (steps: number[]) => steps.flatMap((v, i) => (v > 0 ? [i] : []));

describe('mapLibraryRows', () => {
  const row = (sampleName: string | undefined, hits: boolean) => ({ sampleName, steps: hits ? [100] : [0] });
  it('maps by sample name first, then by index; counts rows with steps that find no place', () => {
    // Same samples, reordered.
    expect(mapLibraryRows([row('a', true), row('b', true)], ['b', 'a'])).toEqual({ to: [1, 0], dropped: 0 });
    // A renamed (other) sample: by index.
    expect(mapLibraryRows([row('a', true), row('x', true)], ['a', 'y'])).toEqual({ to: [0, 1], dropped: 0 });
    // Fewer rows: the third has nowhere to go.
    expect(mapLibraryRows([row('a', true), row('b', true), row('c', true)], ['a', 'b'])).toEqual({ to: [0, 1, null], dropped: 1 });
    // A name match claims its row before any index fallback: c's index (0) is taken by a, so c
    // is dropped (never moved to another free row such as z).
    expect(mapLibraryRows([row('c', true), row('a', true)], ['a', 'z'])).toEqual({ to: [null, 0], dropped: 1 });
    // An empty row only maps by name and is never counted.
    expect(mapLibraryRows([row('q', false), row(undefined, true)], ['z', 'y'])).toEqual({ to: [null, 1], dropped: 0 });
    // No samples on either side: by index.
    expect(mapLibraryRows([row(undefined, true)], [null])).toEqual({ to: [0], dropped: 0 });
    // Two rows with one sample: the first free one each.
    expect(mapLibraryRows([row('a', true), row('a', true)], ['a', 'a'])).toEqual({ to: [0, 1], dropped: 0 });
  });

  it('names the drop', () => {
    expect(droppedRowsText(1)).toBe('1 row not in this kit');
    expect(droppedRowsText(3)).toBe('3 rows not in this kit');
  });
});

describe('pattern library', () => {
  it('saves a drum pattern by value: rows, sample names, steps, length, swing', () => {
    const x = setup();
    beat(x);
    const pat = currentPattern(x.a);
    const e = savePatternToLibrary(x.p, x.a.id, pat.id, '  Groove  ')!;
    expect(e).not.toBeNull();
    expect(x.h.labels.undo).toBe('Save pattern to library');
    expect(libraryJson(e)).toEqual({
      kind: 'drum', name: 'Groove', stepCount: 32, swing: 0.25,
      rows: [
        { name: 'Kick', sampleName: 'kick.wav', steps: pat.steps[0] },
        { name: 'Snare', sampleName: 'snare.wav', steps: pat.steps[1] },
        { name: 'Hat', sampleName: 'hat.wav', steps: pat.steps[2] },
      ],
    });
    expect(e.kind === 'drum' && e.rows[0].steps).toHaveLength(MAX_STEPS);
    // A copy: editing the pattern afterwards leaves the entry alone.
    setStep(x.p, x.sink, x.a.id, x.a.rows[0].id, 1, 100);
    expect(e.kind === 'drum' && e.rows[0].steps[1]).toBe(0);
    // No engine command (the library is project data only).
    expect(x.sent.filter((c) => c[0] === Op.SET_STEP && c[2] === 0 && c[3] === 1)).toHaveLength(1);
    // A duplicate name is numbered; an empty one refused.
    expect(savePatternToLibrary(x.p, x.a.id, pat.id, 'Groove')!.name).toBe('Groove 2');
    expect(savePatternToLibrary(x.p, x.a.id, pat.id, '   ')).toBeNull();
    expect(x.p.patternLibrary.map((y) => y.name)).toEqual(['Groove', 'Groove 2']);
  });

  it('save is one undo entry, and undo / redo restore the library', () => {
    const x = setup();
    beat(x);
    const before = plain(serialize(x.p));
    x.p.dirty = false;
    savePatternToLibrary(x.p, x.a.id, x.a.currentPatternId, 'Groove');
    expect(x.p.dirty).toBe(true); // marked edited without an engine command
    expect(x.h.undo()).toBe(true);
    expect(x.p.patternLibrary).toEqual([]);
    expect(plain(serialize(x.p))).toEqual(before);
    expect(x.h.labels.undo).toBe('Set step'); // the save was exactly one entry
    expect(x.h.redo()).toBe(true);
    expect(x.p.patternLibrary.map((e) => e.name)).toEqual(['Groove']);
  });

  it('loads into a drum track with another row order: steps land on the same samples; one undo entry', () => {
    const x = setup();
    beat(x);
    const src = currentPattern(x.a);
    const e = savePatternToLibrary(x.p, x.a.id, src.id, 'Groove')!;
    const before = plain(serialize(x.p));
    const firstB = x.b.currentPatternId;
    x.sent.length = 0;

    const r = loadPatternFromLibrary(x.p, x.sink, x.b.id, e.id)!;
    expect(r).not.toBeNull();
    expect(x.h.labels.undo).toBe('Load library pattern');
    // A NEW pattern, named after the entry, selected; the old one untouched.
    expect(x.b.patterns).toHaveLength(2);
    expect(x.b.currentPatternId).toBe(r.pattern.id);
    expect(r.pattern.name).toBe('Groove');
    const pat = currentPattern(x.b);
    expect(pat.stepCount).toBe(32);
    expect(pat.swing).toBe(0.25);
    // B's rows: Snr (snare) 0, Clap 1, Bd (kick) 2. Kick → row 2, snare → row 0; the hat has no
    // sample match and its index (2) is the kick's: dropped.
    expect(onSteps(pat.steps[2])).toEqual([0, 4, 8, 12]);
    expect(onSteps(pat.steps[0])).toEqual([4, 12]);
    expect(pat.steps[0][4]).toBe(90);
    expect(onSteps(pat.steps[1])).toEqual([]);
    expect(r.dropped).toBe(1);
    // The engine got the switch to the new slot, its length, swing and steps.
    expect(x.sent).toContainEqual([Op.SET_CURRENT_PATTERN, x.b.slot, pat.engineIdx, 0, 0]);
    expect(x.sent).toContainEqual([Op.SET_STEP_COUNT, x.b.slot, 32, 0, 0]);
    expect(x.sent).toContainEqual([Op.SET_SWING, x.b.slot, 0.25, 0, 0]);
    expect(x.sent.filter((c) => c[0] === Op.SET_STEP)).toEqual([
      ...[0, 4, 8, 12].map((s) => [Op.SET_STEP, x.b.slot, 2, s, 100]),
      ...[4, 12].map((s) => [Op.SET_STEP, x.b.slot, 0, s, 90]),
    ]);
    // A second load gets a free name.
    expect(loadPatternFromLibrary(x.p, x.sink, x.b.id, e.id)!.pattern.name).toBe('Groove 2');

    // Undo twice: back to before the first load, in one step each.
    x.h.undo();
    expect(x.h.undo()).toBe(true);
    expect(x.h.labels.undo).toBe('Save pattern to library');
    expect(x.b.patterns).toHaveLength(1);
    expect(x.b.currentPatternId).toBe(firstB);
    expect(plain(serialize(x.p))).toEqual(before);
    // Redo: the loaded pattern comes back, selected.
    x.h.redo();
    expect(currentPattern(x.b).name).toBe('Groove');
    expect(onSteps(currentPattern(x.b).steps[2])).toEqual([0, 4, 8, 12]);
  });

  it('loads into the same track after a row moved: by sample name; into a sample-less track: by index', () => {
    const x = setup();
    beat(x);
    const e = savePatternToLibrary(x.p, x.a.id, x.a.currentPatternId, 'Groove')!;
    // A track with no samples at all: every row by index; the third row has none to go to.
    const c = addDrumTrack(x.p, x.sink, 'Empty', ['Row 1', 'Row 2'])!;
    const r = loadPatternFromLibrary(x.p, x.sink, c.id, e.id)!;
    const pat = currentPattern(c);
    expect(onSteps(pat.steps[0])).toEqual([0, 4, 8, 12]);
    expect(onSteps(pat.steps[1])).toEqual([4, 12]);
    expect(r.dropped).toBe(1);
  });

  it('loads into a synth track: the bars and the notes as they are; one undo entry', () => {
    const x = setup();
    setPatternBars(x.p, x.sink, x.s.id, 2);
    addNote(x.p, x.sink, x.s.id, { pitch: 36, start: 0, len: 480, vel: 110 });
    addNote(x.p, x.sink, x.s.id, { pitch: 43, start: 1920, len: 240 });
    setPatternBars(x.p, x.sink, x.s.id, 1); // the second note is now past the end: kept, silent
    const e = savePatternToLibrary(x.p, x.s.id, x.s.currentPatternId, 'Bassline')!;
    expect(libraryJson(e)).toEqual({
      kind: 'synth', name: 'Bassline', bars: 1,
      notes: [{ pitch: 36, vel: 110, start: 0, len: 480 }, { pitch: 43, vel: 100, start: 1920, len: 240 }],
    });
    const s2 = addSynthTrack(x.p, x.sink)!;
    const before = plain(serialize(x.p));
    x.sent.length = 0;
    const r = loadPatternFromLibrary(x.p, x.sink, s2.id, e.id)!;
    const pat = currentPattern(s2);
    expect(s2.currentPatternId).toBe(r.pattern.id);
    expect(pat.name).toBe('Bassline');
    expect(pat.bars).toBe(1);
    expect(pat.notes.map(({ idx, pitch, vel, start, len }) => ({ idx, pitch, vel, start, len }))).toEqual([
      { idx: 0, pitch: 36, vel: 110, start: 0, len: 480 },
      { idx: 1, pitch: 43, vel: 100, start: 1920, len: 240 },
    ]);
    expect(x.sent.filter((c) => c[0] === Op.NOTE_SET)).toEqual([
      [Op.NOTE_SET, s2.slot * MAX_NOTES, 36 * 128 + 110, 0, 480],
      [Op.NOTE_SET, s2.slot * MAX_NOTES + 1, 43 * 128 + 100, 1920, 240],
    ]);
    expect(x.h.labels.undo).toBe('Load library pattern');
    x.h.undo();
    expect(plain(serialize(x.p))).toEqual(before);
  });

  it('refuses another kind, a full track, unknown ids (nothing changes)', () => {
    const x = setup();
    const d = savePatternToLibrary(x.p, x.a.id, x.a.currentPatternId, 'D')!;
    const before = plain(serialize(x.p));
    expect(loadBlocked(x.s, d)).toMatch(/drum pattern/);
    expect(loadPatternFromLibrary(x.p, x.sink, x.s.id, d.id)).toBeNull();
    expect(loadPatternFromLibrary(x.p, x.sink, x.a.id, 'nope')).toBeNull();
    expect(loadPatternFromLibrary(x.p, x.sink, 'nope', d.id)).toBeNull();
    for (let i = 1; i < MAX_PATTERNS; i++) newPattern(x.p, x.sink, x.b.id);
    const full = plain(serialize(x.p));
    expect(loadBlocked(x.b, d)).toMatch(/At most/);
    expect(loadPatternFromLibrary(x.p, x.sink, x.b.id, d.id)).toBeNull();
    expect(plain(serialize(x.p))).toEqual(full);
    expect(before.patternLibrary).toEqual(full.patternLibrary);
  });

  it('rename and delete: one undo entry each; names stay unique', () => {
    const x = setup();
    const g = savePatternToLibrary(x.p, x.a.id, x.a.currentPatternId, 'Groove')!;
    const f = savePatternToLibrary(x.p, x.a.id, x.a.currentPatternId, 'Fill')!;
    expect(renameLibraryPattern(x.p, f.id, ' Groove ')).toBe(true);
    expect(f.name).toBe('Groove 2'); // taken by the other entry
    expect(x.h.labels.undo).toBe('Rename library pattern');
    expect(renameLibraryPattern(x.p, f.id, '')).toBe(false);
    expect(renameLibraryPattern(x.p, g.id, 'Groove')).toBe(true); // its own name: no change, no entry
    expect(x.h.labels.undo).toBe('Rename library pattern');
    x.h.undo();
    expect(x.p.patternLibrary.map((e) => e.name)).toEqual(['Groove', 'Fill']);
    // The unchanged entry keeps its UI id through undo.
    expect(x.p.patternLibrary[0].id).toBe(g.id);

    expect(deleteLibraryPattern(x.p, g.id)).toBe(true);
    expect(x.h.labels.undo).toBe('Delete library pattern');
    expect(x.p.patternLibrary.map((e) => e.name)).toEqual(['Fill']);
    expect(deleteLibraryPattern(x.p, 'nope')).toBe(false);
    x.h.undo();
    expect(x.p.patternLibrary.map((e) => e.name)).toEqual(['Groove', 'Fill']);
    expect(x.h.labels.undo).toBe('Save pattern to library');
  });

  it('the library survives a save and validate (by value), and loads with fresh ids', () => {
    const x = setup();
    beat(x);
    savePatternToLibrary(x.p, x.a.id, x.a.currentPatternId, 'Groove');
    addNote(x.p, x.sink, x.s.id, { pitch: 60, start: 0, len: 240 });
    savePatternToLibrary(x.p, x.s.id, x.s.currentPatternId, 'Lead');
    const json = plain(serialize(x.p));
    expect(json.patternLibrary.map((e) => [e.kind, e.name])).toEqual([['drum', 'Groove'], ['synth', 'Lead']]);
    const v = validate(json);
    if ('error' in v) throw new Error(v.error);
    expect(v.warnings).toEqual([]);
    expect(v.project.patternLibrary).toEqual(json.patternLibrary);
    const lib = libraryState(v.project.patternLibrary);
    expect(lib.map(libraryJson)).toEqual(json.patternLibrary);
    expect(lib[0].id).not.toBe(x.p.patternLibrary[0].id);
  });

  it('freeLibraryName numbers taken names', () => {
    const lib = libraryState([
      { kind: 'synth', name: 'A', bars: 1, notes: [] },
      { kind: 'synth', name: 'A 2', bars: 1, notes: [] },
    ]);
    expect(freeLibraryName(lib, 'A')).toBe('A 3');
    expect(freeLibraryName(lib, 'A', lib[0].id)).toBe('A');
    expect(freeLibraryName(lib, 'B')).toBe('B');
  });
});
