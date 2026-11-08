// Example piano rolls for the House patches (plan 13): one short phrase per
// house patch, to hear it in context and as a starting point. Data only:
// they are added as ordinary patterns (state/example-actions.ts), so a saved
// project has no new fields.
//
// Where the notes come from: the demo renders made while the house patches
// were tuned (plan 11/12; a throwaway Rust test that played each patch
// through the engine into a WAV). That script wrote times in seconds at
// 124 BPM (BEAT = 60/124 s); here they are in beats, then ticks (960 PPQ,
// rounded to whole ticks). The phrases are reproduced note for note,
// including the render's quirks: the pads release 0.02 s (≈ 0.04 beat)
// before the next chord and the Reese 0.01 s (≈ 0.02 beat) before the next
// bar. The Sax riff was rendered separately, with the same timing rules.
//
// Mod wheel: the Reese, Acid and Sax renders also swept the mod wheel (the
// Reese's detune opening up, the acid filter, the Sax's "breath"). That is
// not part of the rolls: a pattern holds notes only. Ride the wheel live,
// or draw it as automation, to get the same movement.
//
// Repeats: the bass renders played their line twice and the Acid line four
// times; a pattern loops, so it holds the line once.
import { HOUSE_GROUPS } from './housePatches';

/** One example: a pattern for `patch` (a built-in house patch's name). */
export interface ExampleRoll {
  /** The built-in patch it was written for. */
  patch: string;
  /** "<Patch> example": the name the new pattern gets. */
  name: string;
  bars: number;
  /** Ticks (960 PPQ) and MIDI values, all integers; every note ends inside `bars`. */
  notes: { pitch: number; vel: number; start: number; len: number }[];
}

type Notes = ExampleRoll['notes'];

const PPQ = 960;
/** A 1/16 in beats. */
const S = 1 / 4;

/** A note from beats (start, len), rounded to whole ticks; len >= 1 tick. */
const note = (pitch: number, vel: number, startBeats: number, lenBeats: number) => ({
  pitch,
  vel,
  start: Math.round(startBeats * PPQ),
  len: Math.max(1, Math.round(lenBeats * PPQ)),
});

/**
 * The render's chord loop: Cm9 → Fm9 → Abmaj7 → Gm7-ish voicings. Keys and
 * stabs play the top four notes; pads the whole chord an octave down plus
 * the root two octaves down.
 */
const C: number[][] = [
  [60, 63, 67, 70, 74],
  [60, 63, 65, 68, 72],
  [60, 63, 67, 68, 72],
  [58, 62, 65, 67, 70],
];

/** One bar per chord: each hit (beat in bar, len, vel) plays C[i][1..]. */
function chordHits(hits: [beat: number, len: number, vel: number][]): Notes {
  const out: Notes = [];
  C.forEach((c, i) => {
    for (const [b, len, v] of hits) for (const n of c.slice(1)) out.push(note(n, v, 4 * i + b, len));
  });
  return out;
}

/** Off-beat stabs with a pushed fourth hit. */
const STABS = chordHits([[0.5, 0.2, 110], [1.5, 0.2, 90], [2.5, 0.2, 110], [3.25, 0.5, 120]]);
/** A held chord with a pickup on the "and" of 4. */
const TINE = chordHits([[0, 3.4, 85], [3.5, 0.45, 115]]);

/** Two bars per chord, legato (released 0.04 beat early, as rendered). */
const PADS: Notes = C.flatMap((c, i) =>
  [...c.map((n) => n - 12), c[0] - 24].map((n) => note(n, 100, 8 * i, 8 - 0.04)),
);

/** 1/16 arpeggio over the chord, an octave up in the second half of each bar, accent on the beat. */
const ARP: Notes = Array.from({ length: 64 }, (_, k) => {
  const i = Math.floor(k / 16);
  const j = k % 16;
  const pitch = C[i][[0, 2, 4, 1, 3, 4, 2, 0][j % 8]] + (j >= 8 ? 12 : 0);
  return note(pitch, j % 4 === 0 ? 120 : 90, k * S, 0.8 * S);
});

/** Two-bar house bassline (beat, len, pitch, vel). */
const BASSLINE: Notes = ([
  [0.5, 0.4, 36, 110], [1.5, 0.4, 36, 100], [2.5, 0.25, 48, 110], [2.75, 0.25, 46, 90], [3.5, 0.4, 39, 100],
  [4.5, 0.4, 41, 110], [5.5, 0.4, 41, 100], [6.5, 1.2, 43, 110],
] as const).map(([b, len, n, v]) => note(n, v, b, len));

/** One held root per bar (released 0.02 beat early, as rendered). */
const REESE: Notes = [36, 36, 39, 34].map((n, i) => note(n, 100, 4 * i, 4 - 0.02));

/** 303-style 16 steps (pitch, vel, slide): a slide step is held into the next one (1.1/16), others 0.5/16. */
const ACID: Notes = ([
  [36, 127, false], [36, 80, false], [48, 80, true], [46, 100, false],
  [36, 80, false], [39, 127, true], [41, 80, false], [36, 80, false],
  [36, 127, false], [48, 80, false], [36, 80, true], [39, 100, false],
  [43, 127, false], [36, 80, true], [46, 90, false], [48, 110, false],
] as const).map(([n, v, slide], k) => note(n, v, k * S, (slide ? 1.1 : 0.5) * S));

/**
 * Sax hook in eighths (start, len, pitch, vel). Notes overlap ON PURPOSE:
 * the Sax patch glides between overlapping (legato) notes and re-attacks
 * separated ones, so a 1.1-eighth note running into the next is a slur,
 * not a mistake. Do not "fix" the overlaps.
 */
const SAX: Notes = ([
  [0, 1.1, 63, 110], [1, 1, 65, 90], [2, 1, 67, 100], [3, 0.9, 70, 120], [4, 1.1, 67, 95],
  [5, 1, 65, 90], [6, 2, 63, 100], [8.5, 0.9, 60, 80], [9.5, 5, 63, 115],
] as const).map(([s, len, n, v]) => note(n, v, s / 2, len / 2));

/** Bars and notes per patch name. */
const DATA: Record<string, { bars: number; notes: Notes }> = {
  'Brass Stab': { bars: 4, notes: STABS },
  'Piano Stab': { bars: 4, notes: STABS },
  'Garage Organ': { bars: 4, notes: STABS },
  'Tine Keys': { bars: 4, notes: TINE },
  Strings: { bars: 8, notes: PADS },
  'Warm Pad': { bars: 8, notes: PADS },
  'Arp Pluck': { bars: 4, notes: ARP },
  'Organ Bass': { bars: 2, notes: BASSLINE },
  'Sub Bass': { bars: 2, notes: BASSLINE },
  'Reese Bass': { bars: 4, notes: REESE },
  'Acid Line': { bars: 1, notes: ACID },
  Sax: { bars: 2, notes: SAX },
};

/** Every example, in patch-menu order (HOUSE_GROUPS). Each gets its own copy of the notes. */
export const HOUSE_EXAMPLES: ExampleRoll[] = HOUSE_GROUPS.flatMap((g) => g.patches)
  .filter((x) => DATA[x.name])
  .map((x) => ({
    patch: x.name,
    name: `${x.name} example`,
    bars: DATA[x.name].bars,
    notes: DATA[x.name].notes.map((n) => ({ ...n })),
  }));

/** The example for the patch named `patchName`, or null (starter / library patches have none). */
export function exampleFor(patchName: string): ExampleRoll | null {
  return HOUSE_EXAMPLES.find((e) => e.patch === patchName) ?? null;
}
