import { describe, expect, it } from 'vitest';
import {
  CHORD_TYPES, DEFAULT_KEY, MAX_INVERSION, SCALES, SCALE_IDS, chordIntervals, degreePitchClass, diatonicChord, inKey, isKeyRoot,
  nearestInKey, pitchClass, scaleDegree, voiceChord,
} from './scales';
import type { MusicKey, ScaleId } from './scales';

const key = (root: number, scale: ScaleId): MusicKey => ({ root, scale });
const AMIN = key(9, 'minor');
const CMAJ = key(0, 'major');
/** The in-key pitch classes of a key, sorted. */
const classes = (k: MusicKey) => Array.from({ length: 12 }, (_, i) => i).filter((pc) => inKey(pc, k));

describe('scale tables', () => {
  it('every scale starts at 0, ascends inside the octave, and has its expected size', () => {
    const size: Record<ScaleId, number> = {
      major: 7, minor: 7, dorian: 7, mixolydian: 7, harmonicMinor: 7, minorPentatonic: 5, majorPentatonic: 5, chromatic: 12,
    };
    expect(SCALE_IDS).toEqual(Object.keys(SCALES)); // wire order = the table's order
    for (const id of SCALE_IDS) {
      const iv = SCALES[id].intervals;
      expect(iv.length, id).toBe(size[id]);
      expect(iv[0], id).toBe(0);
      for (let i = 1; i < iv.length; i++) expect(iv[i], id).toBeGreaterThan(iv[i - 1]);
      expect(iv[iv.length - 1], id).toBeLessThan(12);
      expect(SCALES[SCALES[id].harmony].intervals.length, `${id} harmony`).toBe(7);
    }
  });

  it('the scales are the textbook ones (A minor = the white keys, as C major)', () => {
    expect(classes(AMIN)).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(classes(CMAJ)).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(classes(key(2, 'dorian'))).toEqual([0, 2, 4, 5, 7, 9, 11]); // D dorian: white keys too
    expect(classes(key(7, 'mixolydian'))).toEqual([0, 2, 4, 5, 7, 9, 11]); // G mixolydian
    expect(classes(key(9, 'harmonicMinor'))).toEqual([0, 2, 4, 5, 8, 9, 11]); // G# instead of G
    expect(classes(key(9, 'harmonicMinor')).includes(7)).toBe(false);
    expect(classes(key(9, 'minorPentatonic'))).toEqual([0, 2, 4, 7, 9]); // A C D E G
    expect(classes(key(0, 'majorPentatonic'))).toEqual([0, 2, 4, 7, 9]); // C D E G A
    expect(classes(key(5, 'chromatic'))).toHaveLength(12);
    expect(classes(key(2, 'major'))).toEqual([1, 2, 4, 6, 7, 9, 11]); // D major: F#, C#
  });

  it('the default key is A minor', () => {
    expect(DEFAULT_KEY).toEqual({ root: 9, scale: 'minor' });
  });
});

describe('inKey / isKeyRoot / scaleDegree, every scale and root', () => {
  it('match the intervals for every pitch 0..127', () => {
    for (const scale of SCALE_IDS) {
      for (let root = 0; root < 12; root++) {
        const k = key(root, scale);
        const iv = SCALES[scale].intervals;
        for (let p = 0; p <= 127; p++) {
          const above = (p - root + 120) % 12;
          expect(inKey(p, k), `${scale} ${root} ${p}`).toBe(iv.includes(above));
          expect(isKeyRoot(p, k)).toBe(above === 0);
          const d = scaleDegree(p, k);
          expect(d).toBe(iv.includes(above) ? iv.indexOf(above) : null);
        }
      }
    }
  });

  it('pitchClass wraps negatives', () => {
    expect([pitchClass(-1), pitchClass(-12), pitchClass(61), pitchClass(0)]).toEqual([11, 0, 1, 0]);
  });
});

describe('nearestInKey', () => {
  it('A minor: C#4 goes up to D4 on the tie; down to C4 when asked; in-key pitches stay', () => {
    expect(nearestInKey(61, AMIN)).toBe(62);
    expect(nearestInKey(61, AMIN, 'up')).toBe(62);
    expect(nearestInKey(61, AMIN, 'down')).toBe(60);
    expect(nearestInKey(57, AMIN)).toBe(57);
    expect(nearestInKey(57, AMIN, 'down')).toBe(57);
    // A# (between A and B, both in key): tie up.
    expect(nearestInKey(58, AMIN)).toBe(59);
  });

  it('pentatonic gaps pick the nearer side, not always up', () => {
    const am = key(9, 'minorPentatonic'); // A C D E G
    expect(nearestInKey(58, am)).toBe(57); // A# -> A (1) not C (2)
    expect(nearestInKey(59, am)).toBe(60); // B -> C (1) not A (2)
    expect(nearestInKey(68, am)).toBe(69); // G# -> A (1) not G (1)? tie: up
    expect(nearestInKey(65, am)).toBe(64); // F -> E (1) not G (2)
    expect(nearestInKey(58, am, 'up')).toBe(60);
  });

  it('is the nearest (ties up) for every scale, root and pitch; dir finds the first one that way', () => {
    for (const scale of SCALE_IDS) {
      for (let root = 0; root < 12; root++) {
        const k = key(root, scale);
        const ins = Array.from({ length: 128 }, (_, i) => i).filter((p) => inKey(p, k));
        for (let p = 0; p <= 127; p++) {
          const best = Math.min(...ins.map((q) => Math.abs(q - p)));
          const want = ins.includes(p + best) ? p + best : p - best;
          expect(nearestInKey(p, k), `${scale} ${root} ${p}`).toBe(want);
          const up = ins.find((q) => q >= p);
          const down = [...ins].reverse().find((q) => q <= p);
          expect(nearestInKey(p, k, 'up')).toBe(up ?? down);
          expect(nearestInKey(p, k, 'down')).toBe(down ?? up);
          if (scale === 'chromatic') expect(nearestInKey(p, k)).toBe(p);
        }
      }
    }
  });

  it('stays inside 0..127 at the edges', () => {
    const cs = key(1, 'major'); // C# major: no G (127)
    expect(inKey(127, cs)).toBe(false);
    expect(nearestInKey(127, cs)).toBe(126);
    expect(nearestInKey(127, cs, 'up')).toBe(126); // nothing above: falls back down
    const d = key(2, 'major'); // D major: no C (0)
    expect(inKey(0, d)).toBe(false);
    expect(nearestInKey(0, d, 'down')).toBe(1); // nothing below: falls back up
    expect(nearestInKey(200, AMIN)).toBe(127); // clamped first (G9 is in A minor)
    expect(nearestInKey(-5, AMIN)).toBe(0);
  });
});

describe('diatonic chords', () => {
  it('A minor sevenths: Am7 Bm7b5 Cmaj7 Dm7 Em7 Fmaj7 G7', () => {
    const want = [[0, 3, 7, 10], [0, 3, 6, 10], [0, 4, 7, 11], [0, 3, 7, 10], [0, 3, 7, 10], [0, 4, 7, 11], [0, 4, 7, 10]];
    for (let d = 0; d < 7; d++) expect(diatonicChord(AMIN, d, true), `degree ${d}`).toEqual(want[d]);
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => degreePitchClass(AMIN, d))).toEqual([9, 11, 0, 2, 4, 5, 7]);
  });

  it('C major triads: C Dm Em F G Am Bdim; degrees wrap', () => {
    const want = [[0, 4, 7], [0, 3, 7], [0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 3, 7], [0, 3, 6]];
    for (let d = 0; d < 7; d++) expect(diatonicChord(CMAJ, d, false)).toEqual(want[d]);
    expect(diatonicChord(CMAJ, 7, false)).toEqual(want[0]);
    expect(diatonicChord(CMAJ, -1, false)).toEqual(want[6]);
  });

  it('harmonic minor V is a dominant 7th; pentatonics and chromatic use their parent', () => {
    expect(diatonicChord(key(9, 'harmonicMinor'), 4, true)).toEqual([0, 4, 7, 10]); // E7
    expect(diatonicChord(key(9, 'harmonicMinor'), 0, true)).toEqual([0, 3, 7, 11]); // Am(maj7)
    for (let d = 0; d < 7; d++) {
      expect(diatonicChord(key(9, 'minorPentatonic'), d, true)).toEqual(diatonicChord(AMIN, d, true));
      expect(diatonicChord(key(0, 'majorPentatonic'), d, true)).toEqual(diatonicChord(CMAJ, d, true));
      expect(diatonicChord(key(0, 'chromatic'), d, true)).toEqual(diatonicChord(CMAJ, d, true));
    }
  });

  it('every scale and degree stacks thirds of 3 or 4 semitones (sevenths 4 notes, inside two octaves)', () => {
    for (const scale of SCALE_IDS) {
      for (let d = 0; d < 7; d++) {
        const c = diatonicChord(key(0, scale), d, true);
        expect(c).toHaveLength(4);
        expect(c[0]).toBe(0);
        for (let i = 1; i < 4; i++) expect([3, 4]).toContain(c[i] - c[i - 1]);
      }
    }
  });
});

describe('chord types and voicing', () => {
  it('the types are the spec\'s, In key last, in wire order', () => {
    expect(CHORD_TYPES.map((c) => c.id)).toEqual(['maj', 'min', '7', 'maj7', 'm7', 'm9', 'sus2', 'sus4', 'dim', 'inKey']);
    expect(CHORD_TYPES.find((c) => c.id === 'm9')!.intervals).toEqual([0, 3, 7, 10, 14]);
    expect(CHORD_TYPES.find((c) => c.id === 'inKey')!.intervals).toBeNull();
    expect(MAX_INVERSION).toBe(3);
  });

  it('In key at A3 in A minor is Am7 (A C E G); off-key roots snap first (C# -> Dm7)', () => {
    expect(voiceChord(57, 'inKey', 0, AMIN)).toEqual([57, 60, 64, 67]);
    expect(voiceChord(61, 'inKey', 0, AMIN)).toEqual([62, 65, 69, 72]);
    expect(chordIntervals('inKey', 64, AMIN)).toEqual([0, 3, 7, 10]); // Em7
    expect(voiceChord(60, 'inKey', 0)).toEqual([60, 64, 67, 71]); // no key: C major harmony
  });

  it('fixed types play on the root as given; inversions move the lowest notes up', () => {
    expect(voiceChord(57, 'm9', 0)).toEqual([57, 60, 64, 67, 71]);
    expect(voiceChord(57, 'm9', 1)).toEqual([60, 64, 67, 69, 71]);
    expect(voiceChord(61, 'maj', 0, AMIN)).toEqual([61, 65, 68]); // not snapped: the caller snaps
    expect(voiceChord(60, 'maj', 1)).toEqual([64, 67, 72]);
    expect(voiceChord(60, 'maj', 2)).toEqual([67, 72, 76]);
    expect(voiceChord(60, 'maj', 3)).toEqual([67, 72, 76]); // a triad has 2 inversions
    expect(voiceChord(60, 'maj7', 3)).toEqual([71, 72, 76, 79]);
    expect(voiceChord(60, 'maj7', 9)).toEqual(voiceChord(60, 'maj7', 3)); // clamped
    expect(voiceChord(60, 'maj7', -1)).toEqual(voiceChord(60, 'maj7', 0));
  });

  it('drops pitches outside 0..127', () => {
    expect(voiceChord(125, 'maj', 0)).toEqual([125]);
    expect(voiceChord(120, 'm9', 1)).toEqual([123, 127]);
  });
});
