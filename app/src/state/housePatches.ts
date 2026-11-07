// The House patch set (plan 11): built-in patches for house music, grouped
// by category in the patch menu after the starter patches (patches.ts
// BUILTIN_GROUPS). Same Patch shape and rules as the starter patches (params
// by catalog name, omitted = catalog default; choice params are indices),
// plus the house rules that patches.test.ts checks for every built-in:
//   - one MIDI In and one Out; MIDI In `pitch` feeds every Osc and `gate`
//     every ADSR;
//   - at most 24 modules (room to edit under the 32 cap);
//   - no Delay or Reverb (use the mixer sends, so loading house patches never
//     drains the 8-slot FX banks); Chorus only where it defines the sound;
//   - names unique case-insensitively, no trademarks.
//
// Levels: each patch's Out `level` is set so its typical phrase (HOUSE_PHRASES)
// at velocity 100 reads −15 dBFS ± 3 dB momentary loudness, and never peaks
// at 0.9 pre-limiter at velocity 127 (see the level policy in patches.ts).
// engine/tests/house_patches.rs measures this, plus the Sax's acceptance
// numbers, from engine/tests/fixtures/house_patches.txt; after editing a
// patch, regenerate that fixture:
//   UPDATE_FIXTURES=1 npx vitest run app/src/state/patches.fixture.test.ts
// and run `cargo test -p daw-engine --test house_patches`. Module idx values
// the Rust tests refer to (e.g. the Sax's vibrato VCA) are checked there.

import type { Patch } from './patches';

/** What the level, peak and CPU tests play on a house patch. */
export type HousePhrase =
  | 'chord4' // C4 E4 G4 B4: keys and stabs
  | 'chord5' // C3 G3 C4 E4 B4: pads
  | 'bass' // C2, then C3 (mono)
  | 'lead'; // C4 (mono)

/**
 * Sax: a breathy, alto-like mono hook lead (plan 11 *Sax recipe*). Not a
 * sample: two oscillators through a three-peak formant body, a reedy
 * saturator, a breath-noise "chiff" that leads the tone, a delayed vibrato,
 * velocity → brightness and level, and legato glide (overlapping notes
 * slide, separated ones jump). The mod wheel stands in for a breath
 * controller: it raises the formants up to +0.5 oct (brighter, "pushed").
 */
const SAX: Patch = {
  name: 'Sax',
  modules: [
    // Mono, last-note priority; a note pressed over a held one glides there in ~40 ms.
    { idx: 0, id: 'midi_in', params: { mode: 1, glide: 0.04, glide_mode: 1 } },
    // Main tone: a saw (all harmonics, like the conical bore).
    { idx: 1, id: 'osc', params: { wave: 0, fm: 0.002 } },
    // Hollow layer: a narrow-ish square, 5 cents sharp, for a slow beating "reed" shimmer.
    { idx: 2, id: 'osc', params: { wave: 1, pw: 0.4, fine: 5, fm: 0.002 } },
    // Tone mix: saw forward, square underneath.
    { idx: 3, id: 'mixer', params: { lvl1: 0.75, lvl2: 0.3 } },
    // The body: alto-sax resonances, fully wet (≥ 9 dB above the 0.7–1.15 / 1.9–2.2 kHz troughs); they barely
    // follow the note (track 0.15), the mod wheel lifts them.
    { idx: 4, id: 'formant', params: { f1: 520, f2: 1480, f3: 2650, q: 4, g2: 0.9, g3: 0.7, track: 0.15, cv_amt: 0.5 } },
    // Brightness: LP12 opened by the filter envelope (onset overshoot, velocity → brighter).
    { idx: 5, id: 'filter', params: { mode: 1, cutoff: 800, reso: 0.1, cv_amt: 3 } },
    // Reedy grit.
    { idx: 6, id: 'saturator', params: { drive: 0.35 } },
    // Amp: the note's loudness.
    { idx: 7, id: 'vca' },
    // Amp envelope: a blown (not plucked) ~45 ms onset, velocity → level.
    { idx: 8, id: 'adsr', params: { attack: 0.045, decay: 0.3, sustain: 0.85, release: 0.12, vel_amt: 0.4 } },
    // Filter envelope: fast rise, settles to 0.6 (the brightness "push" at the onset); velocity → brighter.
    { idx: 9, id: 'adsr', params: { attack: 0.01, decay: 0.25, sustain: 0.6, release: 0.12, vel_amt: 0.8 } },
    // Breath source.
    { idx: 10, id: 'noise' },
    // Breath colour: a band of air around 3.2 kHz.
    { idx: 11, id: 'filter', params: { mode: 3, cutoff: 3200, reso: 0.3 } },
    // Breath amp.
    { idx: 12, id: 'vca' },
    // Breath envelope: an 8 ms chiff that leads the tone, then a quiet steady hiss.
    { idx: 13, id: 'adsr', params: { attack: 0.008, decay: 0.15, sustain: 0.3, release: 0.1, vel_amt: 0.5 } },
    // Vibrato: a 5.2 Hz sine.
    { idx: 14, id: 'lfo', params: { wave: 0, rate: 5.2 } },
    // Vibrato depth: the oscillators' fm (0.002 → about ±17 cents at full depth).
    { idx: 15, id: 'vca' },
    // Vibrato envelope: waits 0.25 s, then fades in over 0.4 s (a player's delayed vibrato).
    { idx: 16, id: 'adsr', params: { delay: 0.25, attack: 0.4, sustain: 1, release: 0.2 } },
    // Output mix: tone (in1) plus a quiet breath (in2).
    { idx: 17, id: 'mixer', params: { lvl1: 0.8, lvl2: 0.1 } },
    // Out: sets the house level.
    { idx: 18, id: 'out', params: { level: 0.65 } },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'pitch'], to: [2, 'pitch'] },
    { from: [0, 'pitch'], to: [4, 'pitch'] },
    { from: [0, 'mod'], to: [4, 'cv'] },
    { from: [0, 'gate'], to: [8, 'gate'] },
    { from: [0, 'gate'], to: [9, 'gate'] },
    { from: [0, 'gate'], to: [13, 'gate'] },
    { from: [0, 'gate'], to: [16, 'gate'] },
    { from: [0, 'vel'], to: [8, 'vel'] },
    { from: [0, 'vel'], to: [9, 'vel'] },
    { from: [0, 'vel'], to: [13, 'vel'] },
    { from: [1, 'out'], to: [3, 'in1'] },
    { from: [2, 'out'], to: [3, 'in2'] },
    { from: [3, 'out'], to: [4, 'in'] },
    { from: [4, 'out'], to: [5, 'in'] },
    { from: [9, 'env'], to: [5, 'cv'] },
    { from: [5, 'out'], to: [6, 'in'] },
    { from: [6, 'out'], to: [7, 'in'] },
    { from: [8, 'env'], to: [7, 'cv'] },
    { from: [7, 'out'], to: [17, 'in1'] },
    { from: [10, 'out'], to: [11, 'in'] },
    { from: [11, 'out'], to: [12, 'in'] },
    { from: [13, 'env'], to: [12, 'cv'] },
    { from: [12, 'out'], to: [17, 'in2'] },
    { from: [14, 'out'], to: [15, 'in'] },
    { from: [16, 'env'], to: [15, 'cv'] },
    { from: [15, 'out'], to: [1, 'fm'] },
    { from: [15, 'out'], to: [2, 'fm'] },
    { from: [17, 'out'], to: [18, 'l'] },
    { from: [17, 'out'], to: [18, 'r'] },
  ],
};

/** The House groups, in menu order (labels are shown as optgroups). */
export const HOUSE_GROUPS: { label: string; patches: Patch[] }[] = [
  { label: 'House · Leads & Stabs', patches: [SAX] },
  { label: 'House · Keys', patches: [] },
  { label: 'House · Bass', patches: [] },
  { label: 'House · Pads', patches: [] },
];

/** Each house patch's typical phrase, by name (not part of Patch, so saved files are unchanged). */
export const HOUSE_PHRASES: Record<string, HousePhrase> = {
  Sax: 'lead',
};
