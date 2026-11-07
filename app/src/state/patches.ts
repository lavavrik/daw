// Starter patches. Params are given by catalog name; anything omitted uses the
// catalog default. Choice params are choice indices (osc wave: 0 saw, 1 square,
// 2 tri, 3 sine; filter mode: 0 LP24, 1 LP12; midi_in mode: 0 poly, 1 mono;
// lfo wave: 0 sine, 1 tri). patches.test.ts checks every value is in range.
// In every patch MIDI In `pitch` feeds each Osc and `gate` feeds each ADSR.
//
// Levels: Out sums poly voices unnormalised, so the poly patches (Chord Stab,
// Pad, Pluck) set a low Out `level` to keep a 4-note chord (5 for Pad) under
// ~0.9 before the master clamp. engine/tests/starter_patches.rs measures this
// from engine/tests/fixtures/starter_patches.txt; after editing a patch,
// regenerate that fixture (see patches.fixture.test.ts) and rerun cargo test.

export interface Patch {
  name: string;
  modules: { idx: number; id: string; params?: Record<string, number> }[];
  cables: { from: [number, string]; to: [number, string] }[];
}

export const STARTER_PATCHES: Patch[] = [
  {
    name: 'Deep Bass',
    modules: [
      { idx: 0, id: 'midi_in', params: { mode: 1, glide: 0.04 } },
      { idx: 1, id: 'osc', params: { wave: 0, octave: -1 } },
      { idx: 2, id: 'osc', params: { wave: 1, octave: -2 } },
      { idx: 3, id: 'mixer' },
      { idx: 4, id: 'filter', params: { mode: 0, cutoff: 300, reso: 0.35, cv_amt: 3 } },
      { idx: 5, id: 'adsr', params: { attack: 0.002, decay: 0.25, sustain: 0.25, release: 0.12 } },
      { idx: 6, id: 'vca' },
      { idx: 7, id: 'out' },
    ],
    cables: [
      { from: [0, 'pitch'], to: [1, 'pitch'] },
      { from: [0, 'pitch'], to: [2, 'pitch'] },
      { from: [0, 'gate'], to: [5, 'gate'] },
      { from: [1, 'out'], to: [3, 'in1'] },
      { from: [2, 'out'], to: [3, 'in2'] },
      { from: [3, 'out'], to: [4, 'in'] },
      { from: [5, 'env'], to: [4, 'cv'] },
      { from: [4, 'out'], to: [6, 'in'] },
      { from: [5, 'env'], to: [6, 'cv'] },
      { from: [6, 'out'], to: [7, 'l'] },
      { from: [6, 'out'], to: [7, 'r'] },
    ],
  },
  {
    name: 'Chord Stab',
    modules: [
      { idx: 0, id: 'midi_in', params: { mode: 0, voices: 8 } },
      { idx: 1, id: 'osc', params: { wave: 0, unison: 2, detune: 12 } },
      { idx: 2, id: 'filter', params: { mode: 0, cutoff: 500, reso: 0.3, cv_amt: 4 } },
      { idx: 3, id: 'adsr', params: { attack: 0.002, decay: 0.18, sustain: 0, release: 0.15 } },
      { idx: 4, id: 'vca' },
      { idx: 5, id: 'out', params: { level: 0.4 } },
    ],
    cables: [
      { from: [0, 'pitch'], to: [1, 'pitch'] },
      { from: [0, 'gate'], to: [3, 'gate'] },
      { from: [1, 'out'], to: [2, 'in'] },
      { from: [3, 'env'], to: [2, 'cv'] },
      { from: [2, 'out'], to: [4, 'in'] },
      { from: [3, 'env'], to: [4, 'cv'] },
      { from: [4, 'out'], to: [5, 'l'] },
      { from: [4, 'out'], to: [5, 'r'] },
    ],
  },
  {
    name: 'Pad',
    modules: [
      { idx: 0, id: 'midi_in', params: { mode: 0 } },
      { idx: 1, id: 'osc', params: { wave: 0, unison: 4, detune: 22 } },
      { idx: 2, id: 'filter', params: { mode: 1, cutoff: 1500, cv_amt: 0.6 } },
      { idx: 3, id: 'lfo', params: { wave: 0, rate: 0.25 } },
      { idx: 4, id: 'adsr', params: { attack: 0.6, decay: 1, sustain: 0.8, release: 1.5 } },
      { idx: 5, id: 'vca' },
      { idx: 6, id: 'out', params: { level: 0.25 } },
    ],
    cables: [
      { from: [0, 'pitch'], to: [1, 'pitch'] },
      { from: [0, 'gate'], to: [4, 'gate'] },
      { from: [1, 'out'], to: [2, 'in'] },
      { from: [3, 'out'], to: [2, 'cv'] },
      { from: [2, 'out'], to: [5, 'in'] },
      { from: [4, 'env'], to: [5, 'cv'] },
      { from: [5, 'out'], to: [6, 'l'] },
      { from: [5, 'out'], to: [6, 'r'] },
    ],
  },
  {
    name: 'Lead',
    modules: [
      { idx: 0, id: 'midi_in', params: { mode: 1 } },
      { idx: 1, id: 'osc', params: { wave: 1 } },
      { idx: 2, id: 'lfo', params: { wave: 1, rate: 5, depth: 0.3 } },
      { idx: 3, id: 'filter', params: { mode: 0, cutoff: 2500, reso: 0.5 } },
      { idx: 4, id: 'adsr', params: { attack: 0.005, decay: 0.3, sustain: 0.6, release: 0.2 } },
      { idx: 5, id: 'vca' },
      { idx: 6, id: 'out' },
    ],
    cables: [
      { from: [0, 'pitch'], to: [1, 'pitch'] },
      { from: [0, 'gate'], to: [4, 'gate'] },
      { from: [2, 'out'], to: [1, 'pw'] },
      { from: [1, 'out'], to: [3, 'in'] },
      { from: [3, 'out'], to: [5, 'in'] },
      { from: [4, 'env'], to: [5, 'cv'] },
      { from: [5, 'out'], to: [6, 'l'] },
      { from: [5, 'out'], to: [6, 'r'] },
    ],
  },
  {
    name: 'Pluck',
    modules: [
      { idx: 0, id: 'midi_in', params: { mode: 0 } },
      { idx: 1, id: 'osc', params: { wave: 0 } },
      { idx: 2, id: 'osc', params: { wave: 2 } },
      { idx: 3, id: 'mixer' },
      { idx: 4, id: 'filter', params: { mode: 0, cutoff: 200, cv_amt: 5 } },
      { idx: 5, id: 'adsr', params: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.12 } },
      { idx: 6, id: 'vca' },
      { idx: 7, id: 'out', params: { level: 0.3 } },
    ],
    cables: [
      { from: [0, 'pitch'], to: [1, 'pitch'] },
      { from: [0, 'pitch'], to: [2, 'pitch'] },
      { from: [0, 'gate'], to: [5, 'gate'] },
      { from: [1, 'out'], to: [3, 'in1'] },
      { from: [2, 'out'], to: [3, 'in2'] },
      { from: [3, 'out'], to: [4, 'in'] },
      { from: [5, 'env'], to: [4, 'cv'] },
      { from: [4, 'out'], to: [6, 'in'] },
      { from: [5, 'env'], to: [6, 'cv'] },
      { from: [6, 'out'], to: [7, 'l'] },
      { from: [6, 'out'], to: [7, 'r'] },
    ],
  },
];
