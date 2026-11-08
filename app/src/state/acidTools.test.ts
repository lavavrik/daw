import { describe, expect, it } from 'vitest';
import { normalizeSteps, REST, type AcidStep } from './acidSteps';
import { mutate, randomize, SCALES, shift, type ScaleName } from './acidTools';

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('acid tools', () => {
  it('randomize_seeded_deterministic', () => {
    const a = randomize(16, 9, 'minor', mulberry32(5));
    expect(randomize(16, 9, 'minor', mulberry32(5))).toEqual(a);
    expect(randomize(16, 9, 'minor', mulberry32(6))).not.toEqual(a);
    expect(a).toHaveLength(16);
    expect(a).toEqual(normalizeSteps(a, 1)); // canonical
  });

  it('randomize_keys_in_scale', () => {
    const rnd = mulberry32(1);
    for (const scale of Object.keys(SCALES) as ScaleName[]) {
      for (const root of [0, 4, 11]) {
        const allowed = new Set(SCALES[scale].map((d) => (root + d) % 12));
        for (const s of randomize(64, root, scale, rnd)) if (s.kind === 'note') expect(allowed.has(s.key)).toBe(true);
      }
    }
  });

  it('randomize_first_step_note', () => {
    const rnd = mulberry32(2);
    for (let i = 0; i < 100; i++) expect(randomize(16, 0, 'major', rnd)[0].kind).toBe('note');
  });

  it('randomize_kind_odds', () => {
    const steps = randomize(4000, 0, 'minor', mulberry32(3));
    const frac = (k: string) => steps.filter((s) => s.kind === k).length / steps.length;
    // tie-after-rest is normalized to rest, so ties come out a little under 10 %.
    expect(frac('note')).toBeGreaterThan(0.66);
    expect(frac('note')).toBeLessThan(0.74);
    expect(frac('tie')).toBeLessThan(0.11);
  });

  it('mutate_changes_at_most_count', () => {
    const rnd = mulberry32(4);
    const base = randomize(32, 0, 'dorian', rnd);
    for (let i = 0; i < 100; i++) {
      const out = mutate(base, 0, 'dorian', rnd, 3);
      expect(out).toHaveLength(32);
      // Normalizing can also drop a tie/slide that lost its note, so bound the
      // fallout: each re-roll invalidates at most the next tie run and one slide.
      let changed = 0;
      out.forEach((s, j) => { if (JSON.stringify(s) !== JSON.stringify(base[j])) changed++; });
      expect(changed).toBeLessThanOrEqual(3 * 4 + 3);
    }
    // Without fallout (all notes, no slides) the bound is exact.
    const notes: AcidStep[] = Array.from({ length: 16 }, () => ({ kind: 'note', key: 0, oct: 0, accent: false, slide: false }));
    for (let i = 0; i < 50; i++) {
      const out = mutate(notes, 0, 'major', rnd, 3);
      expect(out.filter((s, j) => JSON.stringify(s) !== JSON.stringify(notes[j])).length).toBeLessThanOrEqual(3);
    }
  });

  it('shift_rotates', () => {
    const n = (key: number): AcidStep => ({ kind: 'note', key, oct: 0, accent: false, slide: false });
    const steps = [n(1), n(2), REST, n(3)];
    expect(shift(steps, 1).map((s) => s.kind === 'note' ? s.key : -1)).toEqual([3, 1, 2, -1]);
    expect(shift(steps, -1).map((s) => s.kind === 'note' ? s.key : -1)).toEqual([2, -1, 3, 1]);
    expect(shift(shift(steps, 1), -1)).toEqual(steps);
  });
});
