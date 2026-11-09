// Factory patterns (plan 25 Task 2; spec 2026-11-19-builtin-content §1):
// read-only grooves, basslines and chords that ship with the app, listed in
// the Load popover's / Load from library ▸'s "Factory" section
// (ui/LibraryList.svelte) and loaded like a library entry
// (state/pattern-library.ts loadFactoryPattern: a NEW pattern, one undo).
//
// They are LibraryPatternJson values (project/schema.ts), so a load runs the
// exact library path; they are never in Project.patternLibrary, never saved
// and can't be renamed or deleted. Plus `id` (stable: "factory-<slug>", the
// UI key) and `group` (Drums / Bass / Chords in the list).
//
// DRUMS: every entry has all 8 rows, named by ROLE (DRUM_ROLES, in
// DEFAULT_KIT order), and no sample names: drum rows map by role name first
// (pattern-library.ts DRUM ROW MAPPING), so an entry lands on the same sounds
// in any kit whose rows keep their role names; a track with renamed rows gets
// them by position, which is the kit's role order too. Grids below are one
// character per 1/16 step (spaces between beats are ignored):
//   X 120 accent · x 100 · o 80 · g 45 ghost · . off
// Swing is written in MPC % (swing(), below): a figure the swing popover
// has a preset for (Straight, 54, 58, 62, 66; plan 25 Task 3) takes that
// preset's exact value from state/groove.ts SWING_PRESETS, so a loaded
// groove lights its preset chip and the two can't drift; others (56, 60) go
// through the same mpcToSwing on the slider's 1 % grid.
//
// SYNTHS: written in A minor (natural: A B C D E F G only; plan 26's theory
// helpers transpose them), bass around A1–A2 (MIDI 33–45), chords around
// A3–E5 (57–76; Disco strings an octave up, A4–C6, where strings sit), 1, 2
// or 4 bars, velocities 80–115. Times are 1/16 steps (240 ticks at 960
// PPQ), rounded to whole ticks. Basslines are MONO lines (no note overlaps
// the next: the house bass patches are mono with legato glide, so an overlap
// slides), except Acid 303 line, whose overlaps are its slides. Chords come
// from VOICINGS: each voicing holds its root (so a Dm9 sounds as a Dm9 on
// its own, without the bass), and they are voiced to move by small steps.
import { BAR_TICKS } from '../audio/protocol';
import type { LibraryPatternJson } from '../project/schema';
import { SWING_PRESETS, mpcToSwing } from './groove';
import { MAX_STEPS } from './project.svelte';

export type FactoryGroup = 'drums' | 'bass' | 'chords';

/** A factory entry: a library pattern plus its stable id and list group. */
export type FactoryPattern = LibraryPatternJson & { id: string; group: FactoryGroup };

/** The list's groups, in order, with the track kind each loads into. */
export const FACTORY_GROUPS: readonly { group: FactoryGroup; label: string; kind: 'drum' | 'synth' }[] = [
  { group: 'drums', label: 'Drums', kind: 'drum' },
  { group: 'bass', label: 'Bass', kind: 'synth' },
  { group: 'chords', label: 'Chords', kind: 'synth' },
];

/**
 * The drum row roles, as DEFAULT_KIT (state/defaultKit.ts) names its rows,
 * top to bottom. Not imported from there (that module pulls in the sample
 * import path); factoryPatterns.test.ts pins the two equal.
 */
export const DRUM_ROLES = ['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc'] as const;
export type DrumRole = (typeof DRUM_ROLES)[number];

// ---- drums --------------------------------------------------------------------

const VEL: Record<string, number> = { X: 120, x: 100, o: 80, g: 45 };

/** A grid string (see the header) as MAX_STEPS velocities. */
function gridSteps(grid: string): number[] {
  const cells = grid.replace(/\s/g, '');
  const out = new Array<number>(MAX_STEPS).fill(0);
  [...cells].forEach((c, i) => {
    if (c === '.') return;
    if (!(c in VEL)) throw new Error(`factoryPatterns: unknown grid cell "${c}"`);
    out[i] = VEL[c];
  });
  return out;
}

/** A drum entry: its step count is its grids' length (all rows alike); unlisted roles are empty rows. */
function drums(name: string, swing: number, grids: Partial<Record<DrumRole, string>>): FactoryPattern {
  const lens = new Set(Object.values(grids).map((g) => g.replace(/\s/g, '').length));
  const [len] = lens;
  if (lens.size !== 1 || (len !== 16 && len !== 32)) throw new Error(`factoryPatterns: "${name}" grids must all be 16 or 32 steps`);
  return {
    id: `factory-${slug(name)}`, group: 'drums', kind: 'drum', name, stepCount: len, swing,
    rows: DRUM_ROLES.map((role) => ({ name: role, steps: gridSteps(grids[role] ?? '') })),
  };
}

/** The swing for MPC `pct` %: the swing preset's own value when there is one, else mpcToSwing on the 1 % grid. */
function swing(pct: number): number {
  return SWING_PRESETS.find((p) => p.mpc === pct)?.swing ?? Math.round(mpcToSwing(pct) * 100) / 100;
}

const DRUMS: FactoryPattern[] = [
  // The bare house pulse: kick on every beat, clap on 2 and 4, open hat on every offbeat. Straight.
  drums('Four on the floor', swing(50), {
    Kick:            'X... x... x... x...',
    Clap:            '.... x... .... x...',
    'Open hat':      '..x. ..x. ..x. ..x.',
  }),
  // Chicago / NY staple: ghosted 16th closed hats around the offbeat open hat, an accented clap backbeat. 54 %.
  drums('Classic house', swing(54), {
    Kick:              'X... x... x... x...',
    Clap:              '.... X... .... X...',
    'Closed hat':      'og.g og.g og.g og.g',
    'Open hat':        '..x. ..x. ..x. ..x.',
  }),
  // Laid-back deep house: soft kick and clap, a swung shaker carpet, a ghosted rim answering the clap. 58 %.
  drums('Deep shuffle', swing(58), {
    Kick:              'x... x... x... x...',
    Clap:              '.... o... .... o...',
    'Closed hat':      '..o. ..o. ..o. ..og',
    Rim:               '.... ..g. ...g ..g.',
    Shaker:            'ggog ggog ggog ggog',
  }),
  // UK garage: skipping kick (1 and the & of 3, a push on the e of 4 in bar 2), hard snare backbeat with
  // ghost snares, shuffled hats and shaker. 62 % (the preset).
  drums('Garage 2-step', swing(62), {
    Kick:              'X... .... ..x. .... X... .... ..x. .x..',
    'Closed hat':      'g.x. g.x. g.x. g.xg g.x. g.x. g.x. g.xo',
    Snare:             '.... X..g .... X.g. .... X... ..g. X..g',
    Rim:               '.... .... ...o .... .... ...o .... ..o.',
    Shaker:            '.g.g .g.g .g.g .g.g .g.g .g.g .g.g .g.g',
  }),
  // Late-90s speed garage: four-on-the-floor kick under garage swing, loud offbeat open hats,
  // a snare backbeat with a skipping ghost. 60 %.
  drums('Speed garage', swing(60), {
    Kick:              'X... x... x... x...',
    'Closed hat':      '.g.g .g.g .g.g .g.g',
    'Open hat':        '..X. ..x. ..X. ..x.',
    Snare:             '.... X... ..g. X..g',
    Rim:               '...o .... .o.. ....',
  }),
  // Tight tech house: punchy kick, clap on 2 and 4, even ghost 16th closed hats driving under an accented
  // offbeat open hat, a syncopated rim and a tom pickup. 54 %.
  drums('Tech house', swing(54), {
    Kick:              'X... x... X... x...',
    Clap:              '.... X... .... X...',
    'Closed hat':      'gg.g gg.g gg.g gg.g',
    'Open hat':        '..X. ..X. ..X. ..X.',
    Rim:               '.... ..o. .o.. ...o',
    Perc:              '.... .... .... ..o.',
  }),
  // Tribal house: kick on the beat under a 3-3-2 tom figure that ends bar 2 with a roll back into the loop,
  // rim and shaker cross-rhythms, a sparse clap. 56 %.
  drums('Tribal perc', swing(56), {
    Kick:          'x... x... x... x... x... x... x... x...',
    Clap:          '.... .... .... o... .... .... .... o...',
    Rim:           '..o. ..o. .o.. ..o. ..o. ..o. .o.. o.o.',
    Shaker:        'ggog ggog ggog ggog ggog ggog ggog ggog',
    Perc:          'x..x ..x. x..x ..x. x..x ..x. x..o .ooX',
  }),
  // Disco-house: straight 16th closed hats, an accented open hat on every offbeat, snare and clap
  // together on 2 and 4.
  drums('Disco hats', swing(50), {
    Kick:              'x... x... x... x...',
    Clap:              '.... o... .... o...',
    'Closed hat':      'xg.g og.g xg.g og.g',
    'Open hat':        '..X. ..X. ..X. ..X.',
    Snare:             '.... x... .... x...',
  }),
  // West-London broken beat: displaced kicks, a late snare on the e of 4 in bar 1, ghost notes between,
  // swung 8th hats. 58 %.
  drums('Broken beat', swing(58), {
    Kick:              'X... ...x ..x. .... X... .... .x.. ..x.',
    'Closed hat':      'o.x. o.x. o.x. o.xg o.x. o.x. o.x. o.xg',
    Snare:             '.... X... .g.. .X.. .... X..g .... X...',
    Rim:               '.... .... .... ...g .... .... ...g ....',
  }),
  // Minimal: kick, a ticking offbeat hat, a soft clap and a lone rim; one perc hit in bar 2. Room for the bass. 54 %.
  drums('Minimal', swing(54), {
    Kick:              'x... x... x... x... x... x... x... x...',
    Clap:              '.... o... .... o... .... o... .... o...',
    'Closed hat':      '..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o.',
    Rim:               '.... ...o .... .... .... ...o .... ..o.',
    Perc:              '.... .... .... .... .... .... ..o. ....',
  }),
  // One-bar snare-roll fill: the kick holds three beats, the snare builds from ghost 8ths to 16ths into an accent.
  // Classic house's 54 %: swing is per pattern, so a straight fill would flip the feel for its bar.
  drums('Fill A', swing(54), {
    Kick:              'x... x... x... ....',
    Clap:              '.... x... .... ....',
    'Closed hat':      '..x. ..x. .... ....',
    Snare:             '.... .... g.o. oxxX',
  }),
  // One-bar tom-and-rim fill: the kick drops out on beat 4, rim and perc alternate 16ths into the next bar. 54 %, as Fill A.
  drums('Fill B', swing(54), {
    Kick:            'x... x... x... ....',
    Clap:            '.... x... .... ....',
    'Open hat':      '..x. ..x. .... ....',
    Rim:             '.... .... ..o. o.o.',
    Perc:            '.... .... ...o .x.X',
  }),
];

// ---- synths -------------------------------------------------------------------

type Notes = Extract<LibraryPatternJson, { kind: 'synth' }>['notes'];

/** A 1/16 step in ticks (960 PPQ). */
const STEP = BAR_TICKS / 16;

/** A note from steps (start, len), rounded to whole ticks; len >= 1 tick. */
const note = (pitch: number, vel: number, step: number, lenSteps: number) => ({
  pitch, vel, start: Math.round(step * STEP), len: Math.max(1, Math.round(lenSteps * STEP)),
});

/** Notes from [step, pitch, lenSteps, vel] rows. */
const line = (rows: [step: number, pitch: number, lenSteps: number, vel: number][]): Notes =>
  rows.map(([s, pitch, len, vel]) => note(pitch, vel, s, len));

function synth(group: 'bass' | 'chords', name: string, bars: 1 | 2 | 4, notes: Notes): FactoryPattern {
  return { id: `factory-${slug(name)}`, group, kind: 'synth', name, bars, notes };
}

// Bass pitches (MIDI).
const E1 = 28, F1 = 29, G1 = 31, A1 = 33, B1 = 35, C2 = 36, D2 = 38, E2 = 40, F2 = 41, G2 = 43, A2 = 45, B2 = 47, C3 = 48, D3 = 50;

/**
 * Per beat: root on the beat, its octave on the offbeat 8th, a soft root
 * pickup on the last 16th. The octave is 0.9 steps so it ends before the
 * pickup: on a mono legato patch (Sub Bass) an overlap would glide.
 */
const bounce = (roots: number[]): Notes =>
  roots.flatMap((r, b) => line([[4 * b, r, 1.5, 102], [4 * b + 2, r + 12, 0.9, 112], [4 * b + 3, r, 0.75, 84]]));

/** Walking bar: root (held, then a short repeat), fifth, octave or third, then an approach note into the next root. */
const walk = (bar: number, [root, repeat, fifth, up, approach]: number[]): Notes => {
  const o = 16 * bar;
  return line([[o, root, 3, 106], [o + 3, repeat, 1, 82], [o + 6, fifth, 2, 96], [o + 10, up, 2, 92], [o + 14, approach, 2, 88]]);
};

/** 303 steps (pitch, vel, slide): a slide step is held into the next one (1.1 steps), others 0.5. */
const acid = (steps: [pitch: number, vel: number, slide: boolean][]): Notes =>
  steps.map(([pitch, vel, slide], k) => note(pitch, vel, k, slide ? 1.1 : 0.5));

/** Disco octaves: 8ths alternating low / high on `roots` (one per half bar). */
const octaves = (roots: number[]): Notes =>
  roots.flatMap((r, half) =>
    Array.from({ length: 4 }, (_, i) => {
      const s = 8 * half + 2 * i;
      const low = i % 2 === 0;
      return note(low ? r : r + 12, s % 16 === 0 ? 112 : low ? 104 : 92, s, 1.6);
    }),
  );

const BASS: FactoryPattern[] = [
  // The classic house bass: short A1 on every offbeat, between the kicks; bar 2 turns through C2 and G1 back into A.
  synth('bass', 'Offbeat', 2, line([
    [2, A1, 1.5, 108], [6, A1, 1.5, 96], [10, A1, 1.5, 104], [14, A1, 1.5, 94],
    [18, A1, 1.5, 108], [22, A1, 1.5, 96], [26, C2, 1.5, 104], [30, G1, 1.5, 100],
  ])),
  // Root on the beat, octave on the offbeat, a ghost pickup: bounces A, then D and E (i – iv – v).
  synth('bass', 'Octave bounce', 2, bounce([A1, A1, A1, A1, D2, D2, E2, E2])),
  // Tech-house roll: three 16ths per beat around the kick (root, octave pop, root), C, C and G on beat 4.
  synth('bass', 'Rolling 16ths', 1, line([
    [1, A1, 0.8, 90], [2, A2, 0.8, 110], [3, A1, 0.8, 86],
    [5, A1, 0.8, 90], [6, A2, 0.8, 108], [7, A1, 0.8, 86],
    [9, A1, 0.8, 92], [10, A2, 0.8, 110], [11, A1, 0.8, 86],
    [13, C2, 0.8, 90], [14, C3, 0.8, 108], [15, G2, 0.8, 92],
  ])),
  // 2-step sub: long notes on 1, the & of 2 and the & of 3, skipping like the garage kick; Am, then F, G and E
  // back home, all in the sub octave (nothing above C2).
  synth('bass', 'Garage sub', 2, line([
    [0, A1, 5, 112], [6, A1, 2, 90], [10, C2, 4, 104],
    [16, F1, 5, 110], [22, F1, 2, 88], [26, G1, 3, 100], [30, E1, 2, 86],
  ])),
  // Deep-house walk under Am – Dm – F – Em: root, fifth, octave (or third), and a passing note a step or two
  // from each next root (no leap over an octave).
  synth('bass', 'Deep walk', 4, [
    ...walk(0, [A1, A1, E2, A2, C2]),
    ...walk(1, [D2, D2, A2, D3, G2]),
    ...walk(2, [F2, F2, C3, A2, D2]),
    ...walk(3, [E2, E2, B2, G2, B1]),
  ]),
  // 303-style 16ths on A1 with octave jumps, minor-third and fifth turns, slides on the held steps.
  synth('bass', 'Acid 303 line', 1, acid([
    [A1, 112, false], [A1, 82, false], [A2, 90, true], [G2, 100, false],
    [A1, 82, false], [C2, 112, true], [D2, 85, false], [A1, 82, false],
    [A1, 112, false], [A2, 85, false], [A1, 85, true], [C2, 100, false],
    [E2, 112, false], [A1, 85, true], [G2, 95, false], [A2, 108, false],
  ])),
  // Reese: one held, low note per chord (Am for two bars, F, G), released a 1/32 before the next for a clean restart.
  synth('bass', 'Reese hold', 4, line([[0, A1, 31.5, 104], [32, F1, 15.5, 98], [48, G1, 15.5, 108]])),
  // Disco octaves: 8ths jumping low/high, Am for a bar, then G and F (the descending disco walk-down).
  synth('bass', 'Disco octaves', 2, octaves([A1, A1, G1, F1])),
];

/** A chord voicing: its symbol, its root's pitch class (0 = C) and its MIDI notes, low to high. */
export interface Voicing {
  symbol: string;
  root: number;
  notes: readonly number[];
}
const v = (symbol: string, root: number, notes: number[]): Voicing => ({ symbol, root, notes });
/** Root pitch classes. */
const PC = { A: 9, C: 0, D: 2, E: 4, F: 5, G: 7 } as const;

/**
 * Every chord the chord entries use. Voicings sharing a symbol are the same
 * chord voiced differently; different symbols have different pitch classes
 * (factoryPatterns.test.ts checks both, and that each holds its root).
 */
export const VOICINGS = {
  AM9: v('Am9', PC.A, [57, 60, 64, 67, 71]), //        A3 C4 E4 G4 B4
  AM7: v('Am7', PC.A, [57, 60, 64, 67]), //            A3 C4 E4 G4
  AM7_OPEN: v('Am7', PC.A, [57, 64, 67, 72]), //       A3 E4 G4 C5: open, dub-techno style
  AM11: v('Am11', PC.A, [57, 62, 64, 67, 72]), //      A3 D4 E4 G4 C5: the M1 organ shape
  AM: v('Am', PC.A, [57, 60, 64, 69]), //              A3 C4 E4 A4
  AM_SPREAD: v('Am', PC.A, [57, 64, 69, 72]), //       A3 E4 A4 C5: string-section spread
  DM9: v('Dm9', PC.D, [57, 62, 64, 65, 72]), //        A3 D4 E4 F4 C5: from Am9 A stays, C→D, E stays, G→F, B→C
  DM7: v('Dm7', PC.D, [57, 60, 62, 65]), //            A3 C4 D4 F4
  FMAJ7: v('Fmaj7', PC.F, [57, 60, 64, 65]), //        A3 C4 E4 F4
  F: v('F', PC.F, [57, 60, 65, 69]), //                A3 C4 F4 A4
  C: v('C', PC.C, [60, 64, 67, 72]), //                C4 E4 G4 C5
  G: v('G', PC.G, [59, 62, 67, 71]), //                B3 D4 G4 B4
  EM7: v('Em7', PC.E, [59, 62, 64, 67]), //            B3 D4 E4 G4
  EM: v('Em', PC.E, [59, 64, 67, 71]), //              B3 E4 G4 B4
} as const;
const { AM9, AM7, AM7_OPEN, AM11, AM, AM_SPREAD, DM9, DM7, FMAJ7, EM7, EM } = VOICINGS;

/** `x` an octave up (Disco strings). */
const up = (x: Voicing): Voicing => ({ ...x, notes: x.notes.map((n) => n + 12) });

/** Chord hits from [step, voicing, lenSteps, vel] rows: every note of the voicing at the same time. */
const hits = (rows: [step: number, chord: Voicing, lenSteps: number, vel: number][]): Notes =>
  rows.flatMap(([s, chord, len, vel]) => chord.notes.map((pitch) => note(pitch, vel, s, len)));

/** `rhythm` ([step in bar, lenSteps, vel]) on `chords`, one bar each. */
const perBar = (chords: Voicing[], rhythm: [step: number, lenSteps: number, vel: number][]): Notes =>
  chords.flatMap((c, bar) => hits(rhythm.map(([s, len, vel]) => [16 * bar + s, c, len, vel])));

const CHORDS: FactoryPattern[] = [
  // Detroit chord-memory stab: a short Am9 on the a of 1, the & of 2 and the & of 3; bar 2 answers with Em7.
  synth('chords', 'Detroit minor stabs', 2, hits([
    [3, AM9, 0.75, 110], [6, AM9, 0.75, 92], [10, AM9, 1, 104],
    [19, AM9, 0.75, 110], [22, AM9, 0.75, 92], [26, EM7, 1, 104], [29, EM7, 0.75, 86],
  ])),
  // Deep house i – iv – VI – v (Am9 – Dm9 – Fmaj7 – Em7), voice-led by steps: held to the & of 2, re-struck on the & of 3.
  synth('chords', 'Deep m9 progression', 4, perBar([AM9, DM9, FMAJ7, EM7], [[0, 6, 98], [10, 5, 90]])),
  // Garage organ: Am7 then Dm7 on the skipping 2-step offbeats (the & of 1, the e of 2, the & of 3, the e of 4).
  synth('chords', 'Garage organ', 2, perBar([AM7, DM7], [[2, 1.5, 108], [5, 1, 88], [10, 1.5, 104], [13, 1, 92]])),
  // Piano house vamp: i – VI – III – VII (Am – F – C – G) in the syncopated 8th "Italo piano" rhythm, offbeats accented.
  synth('chords', 'Piano house vamp', 4, perBar([AM, VOICINGS.F, VOICINGS.C, VOICINGS.G], [[0, 2, 96], [3, 1, 84], [6, 2, 108], [10, 2, 102], [12, 1, 86], [14, 2, 112]])),
  // The classic M1 organ stab: Am11 in the 3-3-4-3-3 rhythm, accent on the one.
  synth('chords', 'Classic M1 stab', 1, hits([
    [0, AM11, 1, 112], [3, AM11, 1, 92], [6, AM11, 1, 106], [10, AM11, 1, 100], [13, AM11, 1, 90],
  ])),
  // Dub chord: an open Am7 on the & of 1 with two decaying echoes a dotted 8th (3 steps) apart, as a dub delay
  // would repeat it; set the send delay to a dotted 8th and they thicken instead of fighting it.
  synth('chords', 'Dub chord', 2, hits([
    [2, AM7_OPEN, 1.5, 110], [5, AM7_OPEN, 1, 96], [8, AM7_OPEN, 1, 84],
    [18, AM7_OPEN, 1.5, 108], [21, AM7_OPEN, 1, 94], [24, AM7_OPEN, 1, 82],
  ])),
  // Long pad, a bar per chord, legato (released a 1/64 early): Am9 – Fmaj7 – Dm9 – Em7, swelling into the turnaround.
  synth('chords', 'Pad long', 4, hits([[0, AM9, 15.75, 86], [16, FMAJ7, 15.75, 82], [32, DM9, 15.75, 88], [48, EM7, 15.75, 94]])),
  // Disco strings, up where a string section plays (A4–C6): Am – G – F – Em held for half a bar, then three
  // rising-intensity stabs pushing into the next chord.
  synth('chords', 'Disco strings', 4, perBar([up(AM_SPREAD), up(VOICINGS.G), up(VOICINGS.F), up(EM)], [[0, 7, 94], [10, 1.5, 100], [12, 1.5, 104], [14, 2, 110]])),
];

// ---- the list -------------------------------------------------------------------

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Every factory pattern: Drums, then Bass, then Chords (FACTORY_GROUPS order). */
export const FACTORY_PATTERNS: readonly FactoryPattern[] = [...DRUMS, ...BASS, ...CHORDS];

/** The factory entry with id `id`, or null. */
export const factoryPattern = (id: string): FactoryPattern | null => FACTORY_PATTERNS.find((e) => e.id === id) ?? null;

/** The entries of `group`, in list order. */
export const factoryGroup = (group: FactoryGroup): FactoryPattern[] => FACTORY_PATTERNS.filter((e) => e.group === group);
