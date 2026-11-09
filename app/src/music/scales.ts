// The ONE source of scale maths (plan 26; spec 2026-11-19-builtin-content.md
// §2; docs/architecture/theory.md). Pure, DOM-free, no Svelte: the piano
// roll (scale highlight, Snap to key, Fit to key, the chord stamp), the
// pattern actions and the engine's mirror all follow these definitions.
//
// The engine mirrors what its Arp / Chord modules need in Rust (plan 26
// Task 3). Parity is pinned by a JSON fixture both test suites read:
// engine/tests/fixtures/scales.json, generated from THIS file by
// scales.fixture.test.ts (UPDATE_FIXTURES=1 npx vitest run
// app/src/music/scales.fixture.test.ts). Change a table here -> regenerate
// -> the Rust test tells the mirror to follow.
//
// API (everything later tasks rely on):
//   ScaleId, SCALE_IDS            the scales, in WIRE ORDER: an index into
//                                 SCALE_IDS is what the engine gets (SET_KEY
//                                 b = scale index). Append only.
//   SCALES[id]                    { name, short, intervals, harmony }:
//                                 `intervals` are semitones above the root,
//                                 ascending, starting at 0; `harmony` is the
//                                 7-note scale chords are built from (itself,
//                                 or the parent of a pentatonic / chromatic).
//   MusicKey, DEFAULT_KEY         { root: 0..11 (C = 0), scale }; A minor.
//   pitchClass(p)                 0..11 for any integer (negative too).
//   inKey(pitch, key)             is the pitch class in the scale?
//   isKeyRoot(pitch, key)         is it the key's root?
//   nearestInKey(pitch, key, dir?)  the closest in-key pitch in 0..127;
//                                 dir omitted: nearest, a TIE GOES UP;
//                                 'up' / 'down': the first in-key pitch at or
//                                 above / below (falls back to the other way
//                                 at the 0..127 edge).
//   scaleDegree(pitch, key)       0-based degree in key.scale ITSELF, or
//                                 null (0..4 for a pentatonic, 0..11 for
//                                 chromatic): for display / membership only.
//   harmonyDegree(pitch, key)     0-based degree in the key's HARMONY scale
//                                 (0..6), or null: THE degree diatonicChord
//                                 and degreePitchClass take.
//   diatonicChord(key, degree, seventh)
//                                 the chord stacked in thirds on harmony
//                                 degree `degree` (0-based, any integer:
//                                 wraps mod 7), as semitones above that
//                                 degree's note: A minor degree 0, seventh
//                                 -> [0, 3, 7, 10] (Am7).
//   degreePitchClass(key, degree) that harmony degree's pitch class.
//   DEGREE SPACES: chord maths only ever takes harmony degrees (0..6). Never
//   pass a scaleDegree to diatonicChord: for a pentatonic they differ (A
//   minor pentatonic: E is scaleDegree 3 but harmonyDegree 4).
//   ChordType, CHORD_TYPES        the stamp / Chord module types, in WIRE
//                                 ORDER (the engine's Chord "type" param is an
//                                 index into CHORD_TYPES; append only), each
//                                 { id, label, intervals } with `intervals`
//                                 null for 'inKey' (it depends on the key).
//   chordIntervals(type, rootPitch, key)
//                                 the intervals a type plays on a root
//                                 ('inKey': diatonicChord of the root's
//                                 degree, sevenths).
//   MAX_INVERSION                 3.
//   voiceChord(rootPitch, type, inversion, key?)
//                                 the MIDI pitches, ascending, inside 0..127.
//
// Conventions:
//   - Pitches are MIDI numbers (C4 = 60); pitch classes 0..11 from C.
//   - Chromatic: every pitch is in key, nothing is "out", and the UI shows no
//     highlight; its harmony scale is major (In key on a chromatic key plays
//     the major-scale chord of the clicked degree: *my call*, as there is no
//     diatonic harmony to follow).
//   - Pentatonic harmony: minor pentatonic -> natural minor, major
//     pentatonic -> major (their parent scales), so In key always stacks
//     real thirds.
//   - 'inKey' roots: voiceChord snaps the root to the KEY's own scale first
//     (nearestInKey, ties up), so a pentatonic key only builds chords on its
//     five notes; then it stacks the seventh on that note's HARMONY degree
//     (the parent scale gives the quality: A minor pentatonic's E -> Em7).
//     Chromatic is the exception: every note is "in" it, so its roots snap
//     to its harmony (major) scale instead. (plan 26 "My call: In key gives
//     sevenths"; Task 1 review #4.) Every other type plays its
//     fixed intervals on the root as given (the caller snaps it with
//     nearestInKey when Snap to key is on).
//   - Inversion i (0..MAX_INVERSION) moves the lowest min(i, n-1) notes up an
//     octave: a triad's inversion 3 is its second inversion (never a plain
//     octave shift). Pitches that land outside 0..127 are dropped.

export type ScaleId =
  | 'major' | 'minor' | 'dorian' | 'mixolydian' | 'harmonicMinor' | 'minorPentatonic' | 'majorPentatonic' | 'chromatic';

/** Wire order (engine index). Append only. */
export const SCALE_IDS: readonly ScaleId[] = [
  'major', 'minor', 'dorian', 'mixolydian', 'harmonicMinor', 'minorPentatonic', 'majorPentatonic', 'chromatic',
];

export interface ScaleDef {
  /** Full name ("Harmonic minor"): the key picker's list. */
  name: string;
  /** Short name ("harm min"): the compact "Key: A min" button. */
  short: string;
  /** Semitones above the root, ascending, from 0. */
  intervals: readonly number[];
  /** The 7-note scale its chords are stacked in (see the header). */
  harmony: ScaleId;
}

export const SCALES: Readonly<Record<ScaleId, ScaleDef>> = {
  major: { name: 'Major', short: 'maj', intervals: [0, 2, 4, 5, 7, 9, 11], harmony: 'major' },
  minor: { name: 'Minor', short: 'min', intervals: [0, 2, 3, 5, 7, 8, 10], harmony: 'minor' },
  dorian: { name: 'Dorian', short: 'dor', intervals: [0, 2, 3, 5, 7, 9, 10], harmony: 'dorian' },
  mixolydian: { name: 'Mixolydian', short: 'mix', intervals: [0, 2, 4, 5, 7, 9, 10], harmony: 'mixolydian' },
  harmonicMinor: { name: 'Harmonic minor', short: 'harm min', intervals: [0, 2, 3, 5, 7, 8, 11], harmony: 'harmonicMinor' },
  minorPentatonic: { name: 'Minor pentatonic', short: 'min pent', intervals: [0, 3, 5, 7, 10], harmony: 'minor' },
  majorPentatonic: { name: 'Major pentatonic', short: 'maj pent', intervals: [0, 2, 4, 7, 9], harmony: 'major' },
  chromatic: { name: 'Chromatic', short: 'chrom', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], harmony: 'major' },
};

export const isScaleId = (v: unknown): v is ScaleId => typeof v === 'string' && (SCALE_IDS as readonly string[]).includes(v);

/** The project's key (Project.key, project.json `key`). */
export interface MusicKey {
  /** Pitch class of the root, 0..11 (C = 0). */
  root: number;
  scale: ScaleId;
}

/** A minor: new projects and projects older than schema 6 (the house default). */
export const DEFAULT_KEY: Readonly<MusicKey> = { root: 9, scale: 'minor' };

export const sameKey = (a: MusicKey, b: MusicKey) => a.root === b.root && a.scale === b.scale;

/** 0..11 for any integer pitch (negative ones too). */
export const pitchClass = (p: number) => ((p % 12) + 12) % 12;

/** Semitones of `pitch` above the key root, 0..11. */
const fromRoot = (pitch: number, key: MusicKey) => pitchClass(pitch - key.root);

export function inKey(pitch: number, key: MusicKey): boolean {
  return SCALES[key.scale].intervals.includes(fromRoot(pitch, key));
}

export function isKeyRoot(pitch: number, key: MusicKey): boolean {
  return fromRoot(pitch, key) === 0;
}

/**
 * 0-based degree of `pitch` in key.scale itself, or null when it is not in
 * key. NOT the degree chord maths takes (see harmonyDegree).
 */
export function scaleDegree(pitch: number, key: MusicKey): number | null {
  const i = SCALES[key.scale].intervals.indexOf(fromRoot(pitch, key));
  return i < 0 ? null : i;
}

const inRange = (p: number) => p >= 0 && p <= 127;

/**
 * The in-key pitch closest to `pitch`, inside 0..127. `dir` omitted: the
 * nearest, a tie going UP (C#4 in A minor -> D4). 'up' / 'down': the first
 * in-key pitch at or above / at or below `pitch`; when there is none inside
 * 0..127 that way, the first one the other way. An in-key pitch is returned
 * as is. `pitch` is rounded and clamped to 0..127 first.
 */
export function nearestInKey(pitch: number, key: MusicKey, dir?: 'up' | 'down'): number {
  const p = Math.min(127, Math.max(0, Math.round(pitch)));
  if (inKey(p, key)) return p;
  const search = (step: 1 | -1) => {
    for (let q = p + step; inRange(q); q += step) if (inKey(q, key)) return q;
    return null;
  };
  if (dir === 'up') return search(1) ?? search(-1) ?? p;
  if (dir === 'down') return search(-1) ?? search(1) ?? p;
  // Every scale has a note within 6 semitones either way, so d <= 6 here,
  // except at the 0..127 edges (then only one side exists).
  for (let d = 1; d <= 127; d++) {
    if (inRange(p + d) && inKey(p + d, key)) return p + d; // up first: ties go up
    if (inRange(p - d) && inKey(p - d, key)) return p - d;
  }
  return p;
}

/** The harmony scale's intervals (always 7 notes). */
const harmonyOf = (key: MusicKey) => SCALES[SCALES[key.scale].harmony].intervals;
const mod = (n: number, m: number) => ((n % m) + m) % m;

/**
 * 0-based degree of `pitch` in the key's HARMONY scale (0..6), or null when
 * it is not in it: the degree diatonicChord / degreePitchClass take.
 */
export function harmonyDegree(pitch: number, key: MusicKey): number | null {
  const i = harmonyOf(key).indexOf(fromRoot(pitch, key));
  return i < 0 ? null : i;
}

/** Pitch class of harmony `degree` (0-based, wraps) of the key. */
export function degreePitchClass(key: MusicKey, degree: number): number {
  const iv = harmonyOf(key);
  return pitchClass(key.root + iv[mod(degree, iv.length)]);
}

/**
 * The diatonic triad (or seventh) on `degree` of the key's harmony scale:
 * scale notes degree, +2, +4 (, +6), as semitones above the degree's own
 * note, ascending from 0. A minor: degree 0 -> [0, 3, 7] / [0, 3, 7, 10]
 * (Am / Am7); C major degree 4 -> [0, 4, 7, 10] (G7). `degree` wraps mod 7.
 */
export function diatonicChord(key: MusicKey, degree: number, seventh: boolean): number[] {
  const iv = harmonyOf(key);
  const n = iv.length;
  const d = mod(degree, n);
  const at = (i: number) => iv[i % n] + 12 * Math.floor(i / n);
  const steps = seventh ? [0, 2, 4, 6] : [0, 2, 4];
  return steps.map((s) => at(d + s) - iv[d]);
}

export type ChordType = 'maj' | 'min' | '7' | 'maj7' | 'm7' | 'm9' | 'sus2' | 'sus4' | 'dim' | 'inKey';

export interface ChordDef {
  id: ChordType;
  /** What the chord-type select shows. */
  label: string;
  /** Semitones above the root, ascending from 0; null for 'inKey' (it follows the key). */
  intervals: readonly number[] | null;
}

/** Wire order (the engine Chord module's "type" index). Append only. */
export const CHORD_TYPES: readonly ChordDef[] = [
  { id: 'maj', label: 'maj', intervals: [0, 4, 7] },
  { id: 'min', label: 'min', intervals: [0, 3, 7] },
  { id: '7', label: '7', intervals: [0, 4, 7, 10] },
  { id: 'maj7', label: 'maj7', intervals: [0, 4, 7, 11] },
  { id: 'm7', label: 'm7', intervals: [0, 3, 7, 10] },
  { id: 'm9', label: 'm9', intervals: [0, 3, 7, 10, 14] },
  { id: 'sus2', label: 'sus2', intervals: [0, 2, 7] },
  { id: 'sus4', label: 'sus4', intervals: [0, 5, 7] },
  { id: 'dim', label: 'dim', intervals: [0, 3, 6] },
  { id: 'inKey', label: 'In key', intervals: null },
];

export const MAX_INVERSION = 3;

/** C chromatic (harmony: C major): what 'inKey' follows when voiceChord gets no key. */
const NO_KEY: MusicKey = { root: 0, scale: 'chromatic' };

/**
 * What In key roots snap to: the key's own scale (every scale but chromatic
 * is a subset of its harmony scale, so the snapped root always has a
 * harmony degree), or for chromatic its harmony (major) scale.
 */
const rootKey = (key: MusicKey): MusicKey =>
  key.scale === 'chromatic' ? { root: key.root, scale: SCALES[key.scale].harmony } : key;

/**
 * The root an 'inKey' chord is built on (`rootPitch` snapped to the key's
 * scale, ties up; chromatic: to major), or `rootPitch` itself for a fixed type.
 */
export function chordRoot(rootPitch: number, type: ChordType, key: MusicKey = NO_KEY): number {
  return type === 'inKey' ? nearestInKey(rootPitch, rootKey(key)) : Math.round(rootPitch);
}

/** The intervals `type` plays on `rootPitch` ('inKey': the seventh on chordRoot's degree). */
export function chordIntervals(type: ChordType, rootPitch: number, key: MusicKey = NO_KEY): number[] {
  const def = CHORD_TYPES.find((c) => c.id === type);
  if (!def) throw new Error(`unknown chord type "${type}"`);
  if (def.intervals) return [...def.intervals];
  const degree = harmonyDegree(chordRoot(rootPitch, type, key), key)!; // chordRoot is in the harmony scale
  return diatonicChord(key, degree, true);
}

/**
 * The chord's MIDI pitches, ascending, inside 0..127 (outside ones are
 * dropped). `inversion` is clamped to 0..MAX_INVERSION and moves the lowest
 * min(inversion, n-1) notes up an octave. `key` only matters for 'inKey'
 * (omitted: C chromatic, i.e. C major harmony).
 */
export function voiceChord(rootPitch: number, type: ChordType, inversion: number, key: MusicKey = NO_KEY): number[] {
  const root = chordRoot(rootPitch, type, key);
  const notes = chordIntervals(type, rootPitch, key).map((i) => root + i);
  const inv = Math.min(notes.length - 1, MAX_INVERSION, Math.max(0, Math.round(inversion) || 0));
  for (let i = 0; i < inv; i++) notes[i] += 12;
  return notes.sort((a, b) => a - b).filter(inRange);
}
