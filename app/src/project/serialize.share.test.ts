import { describe, expect, it } from 'vitest';
import { addDrumTrack, removeTrack, setTempo, toggleStep } from '../state/actions';
import { addSynthTrack } from '../state/rack-actions';
import { Project } from '../state/project.svelte';
import { fingerprintOf, jsonEqual, sameProject, serialize, shareSnapshot } from './serialize';

const sink = { send: () => true };

describe('snapshot sharing', () => {
  it('jsonEqual agrees with JSON.stringify (NaN, -0, nesting)', () => {
    const cases: [unknown, unknown][] = [
      [{ a: [1, { b: NaN }] }, { a: [1, { b: NaN }] }],
      [{ a: 0 }, { a: -0 }],
      [{ a: [1, 2] }, { a: [1, 2, 3] }],
      [{ a: 1 }, { b: 1 }],
      [[{ x: null }], [{ x: 0 }]],
      [{ a: [] }, { a: {} }],
      ['1', 1],
    ];
    for (const [a, b] of cases) expect(jsonEqual(a, b), JSON.stringify([a, b])).toBe(JSON.stringify(a) === JSON.stringify(b));
  });

  it('shares unchanged subtrees, matching tracks by slot; equal content, frozen when asked', () => {
    const p = new Project();
    addDrumTrack(p, sink);
    const s1 = addSynthTrack(p, sink)!;
    const d2 = addDrumTrack(p, sink)!;
    const a = shareSnapshot(null, serialize(p), true);
    expect(shareSnapshot(a, serialize(p), true)).toBe(a); // nothing changed: the same object
    removeTrack(p, sink, s1.id); // slot 1 goes; slot 2 moves to index 1
    toggleStep(p, sink, d2.id, d2.rows[0].id, 5);
    const fresh = serialize(p);
    const b = shareSnapshot(a, serialize(p), true);
    expect(b).toEqual(fresh);
    expect(b.tracks[0]).toBe(a.tracks[0]);
    expect(b.tracks[1]).not.toBe(a.tracks[2]); // drum 2 changed ...
    expect(b.tracks[1].kind === 'drum' && b.tracks[1].rows).toBe(a.tracks[2].kind === 'drum' && a.tracks[2].rows); // ... but not its rows
    expect(Object.isFrozen(b) && Object.isFrozen(b.tracks[1]) && Object.isFrozen(b.mixer.master)).toBe(true);
    expect(Object.isFrozen(shareSnapshot(null, serialize(p), false))).toBe(false);
  });

  it('sameProject is fingerprint equality', () => {
    const p = new Project();
    addDrumTrack(p, sink);
    const a = serialize(p);
    const sel = { ...serialize(p), selection: { track: null, synth: null } };
    expect(sameProject(a, sel)).toBe(fingerprintOf(a) === fingerprintOf(sel));
    expect(sameProject(a, sel)).toBe(true);
    // The mode (which transport ran last) is no change either (plan 20 ruling).
    const song = { ...serialize(p), mode: 'song' as const };
    expect(sameProject(a, song)).toBe(fingerprintOf(a) === fingerprintOf(song));
    expect(sameProject(a, song)).toBe(true);
    setTempo(p, sink, 77);
    const b = serialize(p);
    expect(sameProject(a, b)).toBe(fingerprintOf(a) === fingerprintOf(b));
    expect(sameProject(a, b)).toBe(false);
  });
});
