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
// Swing is the app's 0..1 (odd steps late by swing × 120 ticks); the MPC
// figure in each comment is 50 % + 25 % × swing.
//
// SYNTHS: written in A minor (natural: A B C D E F G only; plan 26's theory
// helpers transpose them), bass around A1–A2 (MIDI 33–45), chords around
// A3–E5 (57–76), 1, 2 or 4 bars, velocities 80–115. Times are 1/16 steps
// (240 ticks at 960 PPQ), rounded to whole ticks. Chord voicings are mostly
// rootless or open so they sit above the bass and lead smoothly into each
// other; the bass track supplies the roots.
import { BAR_TICKS } from '../audio/protocol';
import type { LibraryPatternJson } from '../project/schema';
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

const DRUMS: FactoryPattern[] = [
  // The bare house pulse: kick on every beat, clap on 2 and 4, open hat on every offbeat. Straight.
  drums('Four on the floor', 0, {
    Kick:            'X... x... x... x...',
    Clap:            '.... x... .... x...',
    'Open hat':      '..x. ..x. ..x. ..x.',
  }),
  // Chicago / NY staple: ghosted 16th closed hats around the offbeat open hat, an accented clap backbeat. 54 %.
  drums('Classic house', 0.16, {
    Kick:              'X... x... x... x...',
    Clap:              '.... X... .... X...',
    'Closed hat':      'og.g og.g og.g og.g',
    'Open hat':        '..x. ..x. ..x. ..x.',
  }),
  // Laid-back deep house: soft kick and clap, a swung shaker carpet, a ghosted rim answering the clap. 58 %.
  drums('Deep shuffle', 0.32, {
    Kick:              'x... x... x... x...',
    Clap:              '.... o... .... o...',
    'Closed hat':      '..o. ..o. ..o. ..og',
    Rim:               '.... ..g. ...g ..g.',
    Shaker:            'ggog ggog ggog ggog',
  }),
  // UK garage: skipping kick (1 and the & of 3, a push in bar 2), hard snare backbeat with ghost snares,
  // shuffled hats and shaker. 62.5 %.
  drums('Garage 2-step', 0.5, {
    Kick:              'X... .... ..x. .... X... .... ..x. .x..',
    'Closed hat':      'g.x. g.x. g.x. g.xg g.x. g.x. g.x. g.xo',
    Snare:             '.... X..g .... X.g. .... X... ..g. X..g',
    Rim:               '.... .... ...o .... .... ...o .... ..o.',
    Shaker:            '.g.g .g.g .g.g .g.g .g.g .g.g .g.g .g.g',
  }),
  // Late-90s speed garage: four-on-the-floor kick under garage swing, loud offbeat open hats,
  // a snare backbeat with a skipping ghost. 60 %.
  drums('Speed garage', 0.4, {
    Kick:              'X... x... x... x...',
    'Closed hat':      '.g.g .g.g .g.g .g.g',
    'Open hat':        '..X. ..x. ..X. ..x.',
    Snare:             '.... X... ..g. X..g',
    Rim:               '...o .... .o.. ....',
  }),
  // Tight tech house: punchy kick, clap on 2 and 4, driving 16th hats, offbeat open hat,
  // a syncopated rim and a tom pickup. 54 %.
  drums('Tech house', 0.16, {
    Kick:              'X... x... X... x...',
    Clap:              '.... X... .... X...',
    'Closed hat':      'go.g go.g go.g go.g',
    'Open hat':        '..x. ..x. ..x. ..x.',
    Rim:               '.... ..o. .o.. ...o',
    Perc:              '.... .... .... ..o.',
  }),
  // Tribal house: kick on the beat under a 3-3-2 tom figure that rolls into bar 3, rim and shaker
  // cross-rhythms, a sparse clap. 56 %.
  drums('Tribal perc', 0.24, {
    Kick:          'x... x... x... x... x... x... x... x...',
    Clap:          '.... .... .... o... .... .... .... o...',
    Rim:           '..o. ..o. .o.. ..o. ..o. ..o. .o.. o.o.',
    Shaker:        'ggog ggog ggog ggog ggog ggog ggog ggog',
    Perc:          'x..x ..x. x..x ..x. x..x ..x. x..o .ooX',
  }),
  // Disco-house: straight 16th closed hats, an accented open hat on every offbeat, snare and clap
  // together on 2 and 4.
  drums('Disco hats', 0, {
    Kick:              'x... x... x... x...',
    Clap:              '.... o... .... o...',
    'Closed hat':      'xg.g og.g xg.g og.g',
    'Open hat':        '..X. ..X. ..X. ..X.',
    Snare:             '.... x... .... x...',
  }),
  // West-London broken beat: displaced kicks, a late snare on the "a" of 4, ghost notes between,
  // swung 8th hats. 58 %.
  drums('Broken beat', 0.32, {
    Kick:              'X... ...x ..x. .... X... .... .x.. ..x.',
    'Closed hat':      'o.x. o.x. o.x. o.xg o.x. o.x. o.x. o.xg',
    Snare:             '.... X... .g.. .X.. .... X..g .... X...',
    Rim:               '.... .... .... ...g .... .... ...g ....',
  }),
  // Minimal: kick, a ticking offbeat hat, a soft clap and a lone rim; one perc hit in bar 2. Room for the bass. 54 %.
  drums('Minimal', 0.16, {
    Kick:              'x... x... x... x... x... x... x... x...',
    Clap:              '.... o... .... o... .... o... .... o...',
    'Closed hat':      '..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o.',
    Rim:               '.... ...o .... .... .... ...o .... ..o.',
    Perc:              '.... .... .... .... .... .... ..o. ....',
  }),
  // One-bar snare-roll fill: the kick holds three beats, the snare builds from ghost 8ths to 16ths into an accent.
  drums('Fill A', 0, {
    Kick:              'x... x... x... ....',
    Clap:              '.... x... .... ....',
    'Closed hat':      '..x. ..x. .... ....',
    Snare:             '.... .... g.o. oxxX',
  }),
  // One-bar tom-and-rim fill: the kick drops out on beat 4, rim and perc alternate 16ths into the next bar.
  drums('Fill B', 0, {
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

/** Chord hits from [step, voicing, lenSteps, vel] rows: every pitch of the voicing at the same time. */
const hits = (rows: [step: number, chord: readonly number[], lenSteps: number, vel: number][]): Notes =>
  rows.flatMap(([s, chord, len, vel]) => chord.map((pitch) => note(pitch, vel, s, len)));

/** `rhythm` ([step in bar, lenSteps, vel]) on `chords`, one bar each. */
const perBar = (chords: readonly (readonly number[])[], rhythm: [step: number, lenSteps: number, vel: number][]): Notes =>
  chords.flatMap((c, bar) => hits(rhythm.map(([s, len, vel]) => [16 * bar + s, c, len, vel])));

function synth(group: 'bass' | 'chords', name: string, bars: 1 | 2 | 4, notes: Notes): FactoryPattern {
  return { id: `factory-${slug(name)}`, group, kind: 'synth', name, bars, notes };
}

// Bass pitches (MIDI).
const F1 = 29, G1 = 31, A1 = 33, C2 = 36, D2 = 38, E2 = 40, F2 = 41, G2 = 43, A2 = 45, B2 = 47, C3 = 48, D3 = 50;

/** Per beat: root on the beat, its octave on the offbeat 8th, a soft root pickup on the last 16th. */
const bounce = (roots: number[]): Notes =>
  roots.flatMap((r, b) => line([[4 * b, r, 1.5, 102], [4 * b + 2, r + 12, 1.5, 112], [4 * b + 3, r, 0.75, 84]]));

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
  // The classic house bass: short A1 on every offbeat, between the kicks; bar 2 climbs C2 → G1 back into A.
  synth('bass', 'Offbeat', 2, line([
    [2, A1, 1.5, 108], [6, A1, 1.5, 96], [10, A1, 1.5, 104], [14, A1, 1.5, 94],
    [18, A1, 1.5, 108], [22, A1, 1.5, 96], [26, C2, 1.5, 104], [30, G1, 1.5, 100],
  ])),
  // Root on the beat, octave on the offbeat, a ghost pickup: bounces A, then D and E (i – iv – v).
  synth('bass', 'Octave bounce', 2, bounce([A1, A1, A1, A1, D2, D2, E2, E2])),
  // Tech-house roll: three 16ths per beat around the kick (root, octave pop, root), C and G on beat 4.
  synth('bass', 'Rolling 16ths', 1, line([
    [1, A1, 0.8, 90], [2, A2, 0.8, 110], [3, A1, 0.8, 86],
    [5, A1, 0.8, 90], [6, A2, 0.8, 108], [7, A1, 0.8, 86],
    [9, A1, 0.8, 92], [10, A2, 0.8, 110], [11, A1, 0.8, 86],
    [13, C2, 0.8, 90], [14, C3, 0.8, 108], [15, G1, 0.8, 92],
  ])),
  // 2-step sub: long notes that skip with a garage kick (1, the a of 2, the & of 3); Am then F, G, E back home.
  synth('bass', 'Garage sub', 2, line([
    [0, A1, 5, 112], [6, A1, 2, 90], [10, C2, 4, 104],
    [16, F2, 5, 110], [22, F2, 2, 88], [26, G2, 3, 100], [30, E2, 2, 86],
  ])),
  // Deep-house walk under Am – Dm – F – Em: root, fifth, octave, and a passing note into each next root.
  synth('bass', 'Deep walk', 4, [
    ...walk(0, [A1, A1, E2, A2, C2]),
    ...walk(1, [D2, D2, A2, D3, G2]),
    ...walk(2, [F2, F2, C3, A2, D2]),
    ...walk(3, [E2, E2, B2, D3, G1]),
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

// Chord voicings (MIDI), low to high.
const AM9 = [57, 60, 64, 67, 71]; //   A3 C4 E4 G4 B4
const AM7 = [57, 60, 64, 67]; //       A3 C4 E4 G4
const AM11 = [57, 62, 64, 67, 72]; //  A3 D4 E4 G4 C5: the M1 "minor 11" organ shape
const AM_OPEN = [57, 64, 67, 72]; //   A3 E4 G4 C5: open Am7, dub-techno style
const AM = [57, 60, 64, 69]; //        A3 C4 E4 A4
const AM_HIGH = [57, 64, 69, 72]; //   A3 E4 A4 C5: string-section spread
const DM9 = [60, 64, 65, 69]; //       C4 E4 F4 A4: rootless Dm9 (from Am9: G→F, B→A)
const DM7 = [57, 60, 62, 65]; //       A3 C4 D4 F4
const FMAJ7 = [57, 60, 64, 65]; //     A3 C4 E4 F4
const F = [57, 60, 65, 69]; //         A3 C4 F4 A4
const C = [60, 64, 67, 72]; //         C4 E4 G4 C5
const G = [59, 62, 67, 71]; //         B3 D4 G4 B4
const EM7 = [59, 62, 64, 67]; //       B3 D4 E4 G4
const EM = [59, 64, 67, 71]; //        B3 E4 G4 B4

const CHORDS: FactoryPattern[] = [
  // Detroit chord-memory stab: a short Am9 on the "a" of 1, the & of 2 and the & of 3; bar 2 answers with Em7.
  synth('chords', 'Detroit minor stabs', 2, hits([
    [3, AM9, 0.75, 110], [6, AM9, 0.75, 92], [10, AM9, 1, 104],
    [19, AM9, 0.75, 110], [22, AM9, 0.75, 92], [26, EM7, 1, 104], [29, EM7, 0.75, 86],
  ])),
  // Deep house i – iv – VI – v (Am9 – Dm9 – Fmaj7 – Em7), voice-led by steps: held to the & of 2, re-struck on 3.
  synth('chords', 'Deep m9 progression', 4, perBar([AM9, DM9, FMAJ7, EM7], [[0, 6, 98], [10, 5, 90]])),
  // Garage organ: Am7 then Dm7 on the skipping 2-step offbeats (the & of 1, the e of 2, the & of 3, the e of 4).
  synth('chords', 'Garage organ', 2, perBar([AM7, DM7], [[2, 1.5, 108], [5, 1, 88], [10, 1.5, 104], [13, 1, 92]])),
  // Piano house vamp: i – VI – III – VII (Am – F – C – G) in the syncopated 8th "Italo piano" rhythm, offbeats accented.
  synth('chords', 'Piano house vamp', 4, perBar([AM, F, C, G], [[0, 2, 96], [3, 1, 84], [6, 2, 108], [10, 2, 102], [12, 1, 86], [14, 2, 112]])),
  // The classic M1 organ stab: Am11 in the 3-3-4-3-3 rhythm, accent on the one.
  synth('chords', 'Classic M1 stab', 1, hits([
    [0, AM11, 1, 112], [3, AM11, 1, 92], [6, AM11, 1, 106], [10, AM11, 1, 100], [13, AM11, 1, 90],
  ])),
  // Dub chord: one open Am7 on the & of 1 with quieter "echo" repeats (made for a send delay and a filter ride).
  synth('chords', 'Dub chord', 2, hits([
    [2, AM_OPEN, 1.5, 110], [9, AM_OPEN, 1, 90],
    [18, AM_OPEN, 1.5, 106], [25, AM_OPEN, 1, 88], [29, AM_OPEN, 1, 82],
  ])),
  // Long pad, a bar per chord, legato (released a 1/64 early): Am9 – Fmaj7 – Dm9 – Em7, swelling into the turnaround.
  synth('chords', 'Pad long', 4, hits([[0, AM9, 15.75, 86], [16, FMAJ7, 15.75, 82], [32, DM9, 15.75, 88], [48, EM7, 15.75, 94]])),
  // Disco strings: Am – G – F – Em held for half a bar, then three rising-intensity stabs pushing into the next chord.
  synth('chords', 'Disco strings', 4, perBar([AM_HIGH, G, F, EM], [[0, 7, 94], [10, 1.5, 100], [12, 1.5, 104], [14, 2, 110]])),
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
