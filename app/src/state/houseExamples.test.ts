import { describe, expect, it } from 'vitest';
import { BAR_TICKS } from '../audio/protocol';
import { HOUSE_GROUPS, HOUSE_PHRASES } from './housePatches';
import { HOUSE_EXAMPLES, exampleFor } from './houseExamples';

describe('house examples', () => {
  it('every house patch has exactly one example (the transition patches none)', () => {
    const all = HOUSE_GROUPS.flatMap((g) => g.patches.map((x) => x.name));
    expect(all.sort()).toEqual(Object.keys(HOUSE_PHRASES).sort()); // the 21 house patches
    const house = all.filter((n) => HOUSE_PHRASES[n] !== 'fx');
    expect(house).toHaveLength(19);
    expect(HOUSE_EXAMPLES.map((e) => e.patch).sort()).toEqual(house.sort());
    expect(exampleFor('Noise Sweep')).toBeNull();
    expect(exampleFor('Impact')).toBeNull();
    for (const name of house) {
      expect(HOUSE_EXAMPLES.filter((e) => e.patch === name)).toHaveLength(1);
      expect(exampleFor(name)?.name).toBe(`${name} example`);
    }
    expect(exampleFor('Deep Bass')).toBeNull(); // a starter patch has none
    expect(exampleFor('')).toBeNull();
  });

  it('example notes are valid', () => {
    for (const ex of HOUSE_EXAMPLES) {
      expect(ex.notes.length, ex.name).toBeGreaterThan(0);
      expect(Number.isInteger(ex.bars) && ex.bars >= 1 && ex.bars <= 16, ex.name).toBe(true);
      const end = ex.bars * BAR_TICKS;
      for (const n of ex.notes) {
        for (const v of [n.pitch, n.vel, n.start, n.len]) expect(Number.isInteger(v), `${ex.name} ${JSON.stringify(n)}`).toBe(true);
        expect(n.pitch).toBeGreaterThanOrEqual(0);
        expect(n.pitch).toBeLessThanOrEqual(127);
        expect(n.vel).toBeGreaterThanOrEqual(1);
        expect(n.vel).toBeLessThanOrEqual(127);
        expect(n.len).toBeGreaterThanOrEqual(1);
        expect(n.start).toBeGreaterThanOrEqual(0);
        expect(n.start + n.len, `${ex.name} ${JSON.stringify(n)}`).toBeLessThanOrEqual(end);
      }
    }
  });

  it('plan 28 examples are in A minor and inside their bars', () => {
    const NEW = ['Supersaw Lead', 'Hoover', 'Soft Pluck', 'Bright Pluck', '90s Organ', 'FM Bell', 'Formant Pad'];
    const A_MINOR = new Set([9, 11, 0, 2, 4, 5, 7]); // A B C D E F G
    for (const name of NEW) {
      const ex = exampleFor(name)!;
      expect(ex, name).toBeTruthy();
      expect(ex.name).toBe(`${name} example`);
      expect(ex.notes.length, name).toBeGreaterThan(0);
      for (const n of ex.notes) {
        expect(A_MINOR.has(n.pitch % 12), `${name}: ${n.pitch} is not in A minor`).toBe(true);
        expect(n.start + n.len, `${name} ${JSON.stringify(n)}`).toBeLessThanOrEqual(ex.bars * BAR_TICKS);
      }
    }
  });

  it('acid example matches the render', () => {
    const acid = exampleFor('Acid Line')!;
    expect(acid.bars).toBe(1);
    expect(acid.notes).toHaveLength(16);
    expect(acid.notes[2]).toEqual({ pitch: 48, vel: 80, start: 480, len: 264 }); // a slide step: 1.1/16
    expect(acid.notes[0]).toEqual({ pitch: 36, vel: 127, start: 0, len: 120 }); // no slide: 0.5/16
  });

  it('the other examples match the render (spot checks)', () => {
    // Stabs: the top four notes of each chord on the off-beat hits.
    const brass = exampleFor('Brass Stab')!;
    expect(brass.bars).toBe(4);
    expect(brass.notes).toHaveLength(4 * 4 * 4);
    expect(brass.notes.slice(0, 4)).toEqual([63, 67, 70, 74].map((pitch) => ({ pitch, vel: 110, start: 480, len: 192 })));
    expect(exampleFor('Tine Keys')!.notes[4]).toEqual({ pitch: 63, vel: 115, start: 3360, len: 432 });
    // Pads: the whole chord an octave down plus the root two octaves down.
    const strings = exampleFor('Strings')!;
    expect(strings.bars).toBe(8);
    expect(strings.notes.slice(0, 6).map((n) => n.pitch)).toEqual([48, 51, 55, 58, 62, 36]);
    expect(strings.notes[0].len).toBe(7642);
    // Arp: 1/16 steps; step 8 is the root an octave up, accented.
    const arp = exampleFor('Arp Pluck')!;
    expect(arp.notes).toHaveLength(64);
    expect(arp.notes[8]).toEqual({ pitch: 72, vel: 120, start: 1920, len: 192 });
    expect(arp.notes[17]).toEqual({ pitch: 65, vel: 90, start: 4080, len: 192 }); // bar 2: C[1][2]
    expect(exampleFor('Sub Bass')!.notes.at(-1)).toEqual({ pitch: 43, vel: 110, start: 6240, len: 1152 });
    expect(exampleFor('Reese Bass')!.notes.map((n) => [n.pitch, n.start, n.len])).toEqual([
      [36, 0, 3821], [36, 3840, 3821], [39, 7680, 3821], [34, 11520, 3821],
    ]);
    const sax = exampleFor('Sax')!;
    expect(sax.bars).toBe(2);
    expect(sax.notes[0]).toEqual({ pitch: 63, vel: 110, start: 0, len: 528 });
    expect(sax.notes.at(-1)).toEqual({ pitch: 63, vel: 115, start: 4560, len: 2400 });
  });
});
