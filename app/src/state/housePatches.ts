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
  | 'lead' // C4 (mono)
  | 'arp'; // C4 E4 G4 B4 as 1/16 notes at 124 BPM, one bar: arp patches

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

/**
 * Brass Stab: a bright brass hit for disco-house stabs. Detuned saws through
 * a low-q brass formant body; the filter envelope opens slower than the amp
 * (the "blat": the note speaks dark and blooms bright in ~40 ms) and also
 * lifts the formants. Velocity → brighter and louder.
 */
const BRASS_STAB: Patch = {
  name: 'Brass Stab',
  modules: [
    // Poly, 8 voices.
    { idx: 0, id: 'midi_in' },
    // Section: three detuned saws.
    { idx: 1, id: 'osc', params: { wave: 0, unison: 3, detune: 18 } },
    // One more saw 7 cents sharp, so the section beats slowly.
    { idx: 2, id: 'osc', params: { wave: 0, fine: 7 } },
    // Saws mix.
    { idx: 3, id: 'mixer', params: { lvl1: 0.7, lvl2: 0.5 } },
    // Brass body: broad (low q) resonances near 650 / 1300 / 2500 Hz; the filter env lifts them (bloom).
    { idx: 4, id: 'formant', params: { f1: 650, f2: 1300, f3: 2500, q: 2, g2: 0.8, g3: 0.5, track: 0.2, cv_amt: 0.6, mix: 0.7 } },
    // Brightness: LP12 swept up 3.5 oct by the filter envelope.
    { idx: 5, id: 'filter', params: { mode: 1, cutoff: 600, reso: 0.15, cv_amt: 3.5 } },
    // Amp.
    { idx: 6, id: 'vca' },
    // Stab envelope: instant speak, falls to 0.6, short tail; velocity → level.
    { idx: 7, id: 'adsr', params: { attack: 0.004, decay: 0.3, sustain: 0.6, release: 0.15, vel_amt: 0.4 } },
    // Filter envelope: a slower 50 ms attack than the amp (the blat), velocity → brighter.
    { idx: 8, id: 'adsr', params: { attack: 0.05, decay: 0.3, sustain: 0.35, release: 0.15, vel_amt: 0.6 } },
    // Out: sets the house level.
    { idx: 9, id: 'out', params: { level: 0.6 } },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'pitch'], to: [2, 'pitch'] },
    { from: [0, 'pitch'], to: [4, 'pitch'] },
    { from: [0, 'gate'], to: [7, 'gate'] },
    { from: [0, 'gate'], to: [8, 'gate'] },
    { from: [0, 'vel'], to: [7, 'vel'] },
    { from: [0, 'vel'], to: [8, 'vel'] },
    { from: [1, 'out'], to: [3, 'in1'] },
    { from: [2, 'out'], to: [3, 'in2'] },
    { from: [3, 'out'], to: [4, 'in'] },
    { from: [8, 'env'], to: [4, 'cv'] },
    { from: [4, 'out'], to: [5, 'in'] },
    { from: [8, 'env'], to: [5, 'cv'] },
    { from: [5, 'out'], to: [6, 'in'] },
    { from: [7, 'env'], to: [6, 'cv'] },
    { from: [6, 'out'], to: [9, 'l'] },
    { from: [6, 'out'], to: [9, 'r'] },
  ],
};

/**
 * Arp Pluck: a short, bright pluck for 1/16 arps. Saw plus a square an
 * octave up through a resonant LP24 that snaps shut, then a per-voice drive;
 * no sustain, so fast notes never smear. Velocity → brighter and louder.
 * Levelled on the 1/16 arp it is played as (phrase `arp`), so a held
 * 4-note chord of it peaks above 0.9 pre-limiter (the master limiter takes
 * it).
 */
const ARP_PLUCK: Patch = {
  name: 'Arp Pluck',
  modules: [
    // Poly, 8 voices.
    { idx: 0, id: 'midi_in' },
    // Body: a slightly detuned saw pair (a touch of width).
    { idx: 1, id: 'osc', params: { wave: 0, unison: 2, detune: 10 } },
    // Sparkle: a square an octave up.
    { idx: 2, id: 'osc', params: { wave: 1, octave: 1 } },
    // Mix: saw forward.
    { idx: 3, id: 'mixer', params: { lvl1: 0.7, lvl2: 0.35 } },
    // LP24 with some resonance: the "pluck" is its envelope (up to 4 oct) snapping it shut.
    { idx: 4, id: 'filter', params: { mode: 0, cutoff: 400, reso: 0.3, cv_amt: 4 } },
    // Filter envelope: a 4 ms snap, ~0.15 s decay to closed (the pluck); velocity → brighter.
    { idx: 5, id: 'adsr', params: { attack: 0.004, decay: 0.15, sustain: 0, release: 0.08, vel_amt: 0.4 } },
    // Amp.
    { idx: 6, id: 'vca' },
    // Amp envelope: no sustain (−20 dB at ~0.2 s held; a released 1/16 is cut by the 80 ms release), velocity → level.
    { idx: 7, id: 'adsr', params: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.08, vel_amt: 0.4 } },
    // Per-voice drive: rounds each note's onset peak (the arp then reaches the house level under the 0.9 peak) and fattens it.
    { idx: 8, id: 'saturator', params: { drive: 0.45, mix: 1 } },
    // Out: sets the house level (levelled on the 1/16 arp it is played as).
    { idx: 9, id: 'out', params: { level: 0.42 } },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'pitch'], to: [2, 'pitch'] },
    { from: [0, 'gate'], to: [5, 'gate'] },
    { from: [0, 'gate'], to: [7, 'gate'] },
    { from: [0, 'vel'], to: [5, 'vel'] },
    { from: [0, 'vel'], to: [7, 'vel'] },
    { from: [1, 'out'], to: [3, 'in1'] },
    { from: [2, 'out'], to: [3, 'in2'] },
    { from: [3, 'out'], to: [4, 'in'] },
    { from: [5, 'env'], to: [4, 'cv'] },
    { from: [4, 'out'], to: [6, 'in'] },
    { from: [7, 'env'], to: [6, 'cv'] },
    { from: [6, 'out'], to: [8, 'in'] },
    { from: [8, 'out'], to: [9, 'l'] },
    { from: [8, 'out'], to: [9, 'r'] },
  ],
};

/**
 * Tine Keys: an FM electric piano for deep-house chords. A 1:1 sine pair
 * gives the warm, slightly barking body (its index decays and follows
 * velocity); a sine at exactly 14× the note is the tine "ping", scaled by
 * velocity² (a soft touch is mellow, a hard hit rings the bell) and faded out
 * over the top octave (D#6 up: 14× would pass 0.4 × 44.1 kHz and pin at the
 * Osc's frequency cap as an inharmonic whistle). Both scalings go into the
 * tine envelope's `vel`, so they are latched per note and glide on a steal.
 * Long decay, chorus for the classic shimmer. (The Osc's linear FM floors at
 * 0 Hz, so a 1:1 pair can't go past index 1 without detuning; the bell is
 * therefore its own partial.)
 */
const TINE_KEYS: Patch = {
  name: 'Tine Keys',
  modules: [
    // Poly, 8 voices.
    { idx: 0, id: 'midi_in' },
    // Carrier: a sine; fm 0.2 → the modulator VCA's 0..1 is an FM index of 0..1.
    { idx: 1, id: 'osc', params: { wave: 3, fm: 0.2 } },
    // Modulator: a sine at the note (1:1, harmonic sidebands).
    { idx: 2, id: 'osc', params: { wave: 3 } },
    // Modulation depth (the FM index), driven by the mod envelope.
    { idx: 3, id: 'vca' },
    // Mod envelope: the bark at the onset settles to a soft glow; velocity → index.
    { idx: 4, id: 'adsr', params: { attack: 0.001, decay: 1.2, sustain: 0.15, release: 0.3, vel_amt: 0.9 } },
    // Amp.
    { idx: 5, id: 'vca' },
    // Amp envelope: struck, a long piano-like decay; velocity → level.
    { idx: 6, id: 'adsr', params: { attack: 0.002, decay: 5, sustain: 0, release: 0.4, vel_amt: 0.35 } },
    // Tine: a sine at 14× the note (3 oct + 9.688 st = ×1.75 × 8).
    { idx: 7, id: 'osc', params: { wave: 3, octave: 3, tune: 9.6883 } },
    // Tine amp, by its envelope.
    { idx: 8, id: 'vca' },
    // Tine envelope: a quick ping, scaled by its `vel` (velocity² × key scale, latched per note).
    { idx: 9, id: 'adsr', params: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.1, vel_amt: 1 } },
    // Velocity² (vel × vel): the bell is mostly a hard-hit thing.
    { idx: 10, id: 'vca' },
    // Body + tine.
    { idx: 11, id: 'mixer', params: { lvl1: 0.8, lvl2: 0.3 } },
    // The e-piano chorus shimmer.
    { idx: 12, id: 'chorus', params: { rate: 0.7, depth: 0.5, mix: 0.35 } },
    // Out: sets the house level.
    { idx: 13, id: 'out', params: { level: 0.27 } },
    // Key scale, linear part: 0.9 − 0.4 × pitch (V/oct, 0 = C4): 0 at D#6, above 1 below ~F5.
    { idx: 14, id: 'attenuator', params: { amount: -0.4, offset: 0.9 } },
    // Key scale, clamp: a hard tanh (×9) holds it at 1 below ~F5 and fades it to 0 at D#6 (negative above; the ADSR clamps that to 0).
    { idx: 15, id: 'saturator', params: { drive: 0.8, mix: 1 } },
    // Velocity² × key scale → the tine envelope's vel.
    { idx: 16, id: 'vca' },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'pitch'], to: [2, 'pitch'] },
    { from: [0, 'pitch'], to: [7, 'pitch'] },
    { from: [0, 'gate'], to: [4, 'gate'] },
    { from: [0, 'gate'], to: [6, 'gate'] },
    { from: [0, 'gate'], to: [9, 'gate'] },
    { from: [0, 'vel'], to: [4, 'vel'] },
    { from: [0, 'vel'], to: [6, 'vel'] },
    { from: [0, 'vel'], to: [10, 'in'] },
    { from: [0, 'vel'], to: [10, 'cv'] },
    { from: [0, 'pitch'], to: [14, 'in'] },
    { from: [14, 'out'], to: [15, 'in'] },
    { from: [10, 'out'], to: [16, 'in'] },
    { from: [15, 'out'], to: [16, 'cv'] },
    { from: [16, 'out'], to: [9, 'vel'] },
    { from: [2, 'out'], to: [3, 'in'] },
    { from: [4, 'env'], to: [3, 'cv'] },
    { from: [3, 'out'], to: [1, 'fm'] },
    { from: [1, 'out'], to: [5, 'in'] },
    { from: [6, 'env'], to: [5, 'cv'] },
    { from: [5, 'out'], to: [11, 'in1'] },
    { from: [7, 'out'], to: [8, 'in'] },
    { from: [9, 'env'], to: [8, 'cv'] },
    { from: [8, 'out'], to: [11, 'in2'] },
    { from: [11, 'out'], to: [12, 'l'] },
    { from: [12, 'l'], to: [13, 'l'] },
    { from: [12, 'r'], to: [13, 'r'] },
  ],
};

/**
 * Piano Stab: the classic house piano chord stab. Saw plus a slightly
 * detuned square an octave up, through an LP12 whose fast-decaying,
 * velocity-scaled envelope gives the bright hammer that mellows; the amp
 * decays with no sustain (held chords fade like a piano); a light saturator
 * for weight.
 *
 * Body (plan 13 Task 4; the user: "good, but missing some depth"): a
 * triangle at the note and a sine an octave below fill the low mids the saw
 * and square left thin (on chord4 only C4's 262 Hz lay below 300 Hz). Both
 * are plain, nearly harmonic-free tones, so they add warmth under the hammer
 * without brightening it, and they ride the same amp envelope, so the stab
 * stays percussive (−20 dB at 0.76–0.82 s, was 0.70–0.74). Measured on chord4
 * (vel 100, 48 kHz; 44.1/96 kHz within 0.2 dB): power below 300 Hz −5.0 dB of
 * the total (was −10.4), loudness −16.0 dBFS (was −16.4), vel-127 peak
 * 0.80–0.82 (was 0.76). The filter and hammer are
 * unchanged: the layers alone gave +5 dB. The two layers are idx 3–4, right
 * after the oscillators, so the wrapped rack reads in signal-flow order.
 */
const PIANO_STAB: Patch = {
  name: 'Piano Stab',
  modules: [
    // Poly, 8 voices.
    { idx: 0, id: 'midi_in' },
    // Body: a saw.
    { idx: 1, id: 'osc', params: { wave: 0 } },
    // Brightness: a square an octave up, 6 cents sharp (the slightly out-of-tune string pair).
    { idx: 2, id: 'osc', params: { wave: 1, octave: 1, fine: 6 } },
    // Body: a triangle at the note (warmth at the fundamental).
    { idx: 3, id: 'osc', params: { wave: 2 } },
    // Depth: a sine an octave below (C3–B3 on chord4: low mids, not sub-bass).
    { idx: 4, id: 'osc', params: { wave: 3, octave: -1 } },
    // Mix: saw, square, then the body layers (triangle, sub sine). The sub is a
    // touch louder: it carries most of the depth; much more and low chords boom.
    { idx: 5, id: 'mixer', params: { lvl1: 0.7, lvl2: 0.45, lvl3: 0.35, lvl4: 0.4 } },
    // LP12 opened by the hammer envelope.
    { idx: 6, id: 'filter', params: { mode: 1, cutoff: 600, reso: 0.1, cv_amt: 4 } },
    // Hammer envelope: instant, decays over ~0.5 s; velocity → brighter.
    { idx: 7, id: 'adsr', params: { attack: 0.001, decay: 0.5, sustain: 0.05, release: 0.2, vel_amt: 0.6 } },
    // Amp.
    { idx: 8, id: 'vca' },
    // Amp envelope: struck, decays with no sustain (−20 dB at ~0.85 s); velocity → level.
    { idx: 9, id: 'adsr', params: { attack: 0.001, decay: 1.7, sustain: 0, release: 0.25, vel_amt: 0.4 } },
    // Weight: a light, slightly bright saturation, half wet.
    { idx: 10, id: 'saturator', params: { drive: 0.15, mix: 0.5, tone: 0.6 } },
    // Out: sets the house level (0.27 → 0.25 with the body layers: loudness −16.0 dBFS, vel-127 peak ≤ 0.82).
    { idx: 11, id: 'out', params: { level: 0.25 } },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'pitch'], to: [2, 'pitch'] },
    { from: [0, 'pitch'], to: [3, 'pitch'] },
    { from: [0, 'pitch'], to: [4, 'pitch'] },
    { from: [0, 'gate'], to: [7, 'gate'] },
    { from: [0, 'gate'], to: [9, 'gate'] },
    { from: [0, 'vel'], to: [7, 'vel'] },
    { from: [0, 'vel'], to: [9, 'vel'] },
    { from: [1, 'out'], to: [5, 'in1'] },
    { from: [2, 'out'], to: [5, 'in2'] },
    { from: [3, 'out'], to: [5, 'in3'] },
    { from: [4, 'out'], to: [5, 'in4'] },
    { from: [5, 'out'], to: [6, 'in'] },
    { from: [7, 'env'], to: [6, 'cv'] },
    { from: [6, 'out'], to: [8, 'in'] },
    { from: [9, 'env'], to: [8, 'cv'] },
    { from: [8, 'out'], to: [10, 'in'] },
    { from: [10, 'out'], to: [11, 'l'] },
    { from: [10, 'out'], to: [11, 'r'] },
  ],
};

/**
 * Garage Organ: the percussive UK-garage organ chord. A square with sines an
 * octave up and down (drawbar-ish), through a formant body whose own fast
 * envelope sweeps it down an octave at each hit (the "wah" bounce), into a
 * fast decay to a low sustain.
 *
 * Release 0.12 → 0.45 s (plan 13 Task 4; the user: "probably needs a bit
 * longer release"): short stabs now ring out instead of cutting off. A 0.2 s
 * chord4 is −20 dB 250 ms after its note-off (was −81 dB) and silent
 * (< −60 dBFS) well before 1.5 s. The hit, the 0.3 s decay and the 0.25
 * sustain are unchanged, so loudness (−16.7 dBFS) and peak are too.
 */
const GARAGE_ORGAN: Patch = {
  name: 'Garage Organ',
  modules: [
    // Poly, 8 voices.
    { idx: 0, id: 'midi_in' },
    // 8': a square (the hollow organ tone).
    { idx: 1, id: 'osc', params: { wave: 1 } },
    // 4': a sine an octave up.
    { idx: 2, id: 'osc', params: { wave: 3, octave: 1 } },
    // 16': a sine an octave down.
    { idx: 3, id: 'osc', params: { wave: 3, octave: -1 } },
    // Drawbars.
    { idx: 4, id: 'mixer', params: { lvl1: 0.5, lvl2: 0.5, lvl3: 0.6 } },
    // Vowel body: its envelope starts it an octave up and drops it in ~0.15 s ("wah"); 60 % wet.
    { idx: 5, id: 'formant', params: { f1: 450, f2: 1100, f3: 2600, q: 3, g2: 0.7, g3: 0.4, track: 0.3, cv_amt: 1, mix: 0.6 } },
    // Wah envelope.
    { idx: 6, id: 'adsr', params: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.1 } },
    // Amp.
    { idx: 7, id: 'vca' },
    // Amp envelope: percussive, a fast decay to a low (0.25) sustain, a 0.45 s release tail; velocity → level.
    { idx: 8, id: 'adsr', params: { attack: 0.001, decay: 0.3, sustain: 0.25, release: 0.45, vel_amt: 0.4 } },
    // Per-voice drive (an organ through a hot amp): rounds each hit's onset peak.
    { idx: 9, id: 'saturator', params: { drive: 0.3, mix: 1 } },
    // Out: sets the house level.
    { idx: 10, id: 'out', params: { level: 0.28 } },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'pitch'], to: [2, 'pitch'] },
    { from: [0, 'pitch'], to: [3, 'pitch'] },
    { from: [0, 'pitch'], to: [5, 'pitch'] },
    { from: [0, 'gate'], to: [6, 'gate'] },
    { from: [0, 'gate'], to: [8, 'gate'] },
    { from: [0, 'vel'], to: [8, 'vel'] },
    { from: [1, 'out'], to: [4, 'in1'] },
    { from: [2, 'out'], to: [4, 'in2'] },
    { from: [3, 'out'], to: [4, 'in3'] },
    { from: [4, 'out'], to: [5, 'in'] },
    { from: [6, 'env'], to: [5, 'cv'] },
    { from: [5, 'out'], to: [7, 'in'] },
    { from: [8, 'env'], to: [7, 'cv'] },
    { from: [7, 'out'], to: [9, 'in'] },
    { from: [9, 'out'], to: [10, 'l'] },
    { from: [9, 'out'], to: [10, 'r'] },
  ],
};

/**
 * Organ Bass: the hollow 90s house organ bass. A sine with an octave sine
 * just under it (the strong 2nd harmonic is the sound) and a touch of
 * square for edge, through an LP12 a click envelope flicks open at each note;
 * a short decay to a mid sustain.
 *
 * Depth (plan 16 Task 1; the owner: "good, missing some depth, but it
 * probably shouldn't be too deep"): a quiet sine an octave below (16') under
 * the drawbars adds low end without turning it into a sub bass; the octave
 * sine is still the sound, nudged 0.55 → 0.5 so the sub (0.3, ~8.5 dB
 * under the fundamental) reads. Measured on the bass phrase (C2 then C3,
 * vel 100; 44.1/48/96 kHz within 0.02 dB): power below 120 Hz −3.7 dB of
 * the total (was −4.5; Sub Bass −1.8), loudness −15.7 dBFS (unchanged),
 * h2 still 2 dB from h1. At the brief's 0.2 alone it moved only +0.3 dB.
 * The sub is idx 4, right after the other oscillators, so the wrapped rack
 * reads in signal-flow order.
 */
const ORGAN_BASS: Patch = {
  name: 'Organ Bass',
  modules: [
    // Mono, last-note priority, no glide (organ notes jump).
    { idx: 0, id: 'midi_in', params: { mode: 1 } },
    // Fundamental: a sine.
    { idx: 1, id: 'osc', params: { wave: 3 } },
    // The octave: a sine an octave up.
    { idx: 2, id: 'osc', params: { wave: 3, octave: 1 } },
    // Edge: a quiet square an octave up.
    { idx: 3, id: 'osc', params: { wave: 1, octave: 1 } },
    // Depth: a sine an octave down (16').
    { idx: 4, id: 'osc', params: { wave: 3, octave: -1 } },
    // Drawbars: fundamental, octave a little under it, a touch of square, a
    // little sub (much more and it is a Sub Bass).
    { idx: 5, id: 'mixer', params: { lvl1: 0.8, lvl2: 0.5, lvl3: 0.12, lvl4: 0.3 } },
    // LP12: tames the square; the click envelope opens it 3 oct for a moment.
    { idx: 6, id: 'filter', params: { mode: 1, cutoff: 500, reso: 0.1, cv_amt: 3 } },
    // Key click: 40 ms.
    { idx: 7, id: 'adsr', params: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.05 } },
    // Amp.
    { idx: 8, id: 'vca' },
    // Amp envelope: a short decay to a mid sustain, quick release; velocity → level.
    { idx: 9, id: 'adsr', params: { attack: 0.002, decay: 0.35, sustain: 0.6, release: 0.08, vel_amt: 0.3 } },
    // Out: sets the house level.
    { idx: 10, id: 'out', params: { level: 0.45 } },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'pitch'], to: [2, 'pitch'] },
    { from: [0, 'pitch'], to: [3, 'pitch'] },
    { from: [0, 'pitch'], to: [4, 'pitch'] },
    { from: [0, 'gate'], to: [7, 'gate'] },
    { from: [0, 'gate'], to: [9, 'gate'] },
    { from: [0, 'vel'], to: [9, 'vel'] },
    { from: [1, 'out'], to: [5, 'in1'] },
    { from: [2, 'out'], to: [5, 'in2'] },
    { from: [3, 'out'], to: [5, 'in3'] },
    { from: [4, 'out'], to: [5, 'in4'] },
    { from: [5, 'out'], to: [6, 'in'] },
    { from: [7, 'env'], to: [6, 'cv'] },
    { from: [6, 'out'], to: [8, 'in'] },
    { from: [9, 'env'], to: [8, 'cv'] },
    { from: [8, 'out'], to: [10, 'l'] },
    { from: [8, 'out'], to: [10, 'r'] },
  ],
};

/**
 * Reese Bass: a detuned, phasing Reese. Four saws (two detuned pairs)
 * beating against each other through a dark LP24 and a saturator; the mod
 * wheel opens the filter 4 oct toward a snarling hoover. Glide on every note.
 */
const REESE_BASS: Patch = {
  name: 'Reese Bass',
  modules: [
    // Mono, glide on every note (80 ms).
    { idx: 0, id: 'midi_in', params: { mode: 1, glide: 0.08, glide_mode: 0 } },
    // Saw pair, wide detune.
    { idx: 1, id: 'osc', params: { wave: 0, unison: 2, detune: 35 } },
    // Second saw pair, 11 cents sharp: the slow phasing.
    { idx: 2, id: 'osc', params: { wave: 0, unison: 2, detune: 35, fine: 11 } },
    // Equal mix.
    { idx: 3, id: 'mixer', params: { lvl1: 0.6, lvl2: 0.6 } },
    // Dark LP24; the mod wheel opens it up to 4 oct (220 Hz → 3.5 kHz).
    { idx: 4, id: 'filter', params: { mode: 0, cutoff: 220, reso: 0.25, cv_amt: 4, drive: 0.2 } },
    // Snarl.
    { idx: 5, id: 'saturator', params: { drive: 0.45, mix: 0.8 } },
    // Amp.
    { idx: 6, id: 'vca' },
    // Amp envelope: organ-like (full sustain), short release; a little velocity.
    { idx: 7, id: 'adsr', params: { attack: 0.005, decay: 0.3, sustain: 1, release: 0.15, vel_amt: 0.2 } },
    // Out: sets the house level.
    { idx: 8, id: 'out', params: { level: 0.3 } },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'pitch'], to: [2, 'pitch'] },
    { from: [0, 'gate'], to: [7, 'gate'] },
    { from: [0, 'vel'], to: [7, 'vel'] },
    { from: [0, 'mod'], to: [4, 'cv'] },
    { from: [1, 'out'], to: [3, 'in1'] },
    { from: [2, 'out'], to: [3, 'in2'] },
    { from: [3, 'out'], to: [4, 'in'] },
    { from: [4, 'out'], to: [5, 'in'] },
    { from: [5, 'out'], to: [6, 'in'] },
    { from: [7, 'env'], to: [6, 'cv'] },
    { from: [6, 'out'], to: [8, 'l'] },
    { from: [6, 'out'], to: [8, 'r'] },
  ],
};

/**
 * Acid Line: an original squelchy acid bass (not a copy of any instrument).
 * One saw into a driven, resonant Diode ladder with a snappy filter envelope.
 * The accent is velocity: an Accent module (vel >= 100) adds a sweep to the
 * filter cv (a run of accents opens it further) and a little to the amp cv,
 * on top of the envelopes' own velocity response. The slide is legato glide
 * (only overlapping notes slide). The mod wheel adds to the cutoff.
 */
const ACID_LINE: Patch = {
  name: 'Acid Line',
  modules: [
    // Mono; overlapping notes slide in 60 ms, separated ones jump.
    { idx: 0, id: 'midi_in', params: { mode: 1, glide: 0.06, glide_mode: 1 } },
    // A saw.
    { idx: 1, id: 'osc', params: { wave: 0 } },
    // The squelch: resonant Diode ladder (mode 5), swept up to 5 oct. Moderate
    // reso: it squelches, it doesn't scream.
    { idx: 2, id: 'filter', params: { mode: 5, cutoff: 200, reso: 0.7, cv_amt: 5, drive: 0.35 } },
    // Filter envelope: snappy decay to nearly closed; velocity = accent (deeper sweep).
    { idx: 3, id: 'adsr', params: { attack: 0.002, decay: 0.22, sustain: 0.08, release: 0.1, vel_amt: 0.5 } },
    // Filter cv: the envelope (in1), the mod wheel (in2, cutoff ride) and the
    // accent sweep (in3, 0.35 = up to ~1.75 oct extra, on top of the envelope).
    { idx: 4, id: 'mixer', params: { lvl1: 1, lvl2: 0.6, lvl3: 0.35 } },
    // Grit.
    { idx: 5, id: 'saturator', params: { drive: 0.5, mix: 0.8, tone: 0.55 } },
    // Amp.
    { idx: 6, id: 'vca' },
    // Amp envelope: quick, high sustain, short release; accent a little louder.
    { idx: 7, id: 'adsr', params: { attack: 0.002, decay: 0.4, sustain: 0.85, release: 0.06, vel_amt: 0.2 } },
    // Out: sets the house level.
    { idx: 8, id: 'out', params: { level: 0.3 } },
    // Accent: vel >= 100 (the Acid editor's accent, 120) charges a store that
    // decays in 0.3 s, so a run of accents climbs and opens the filter further.
    { idx: 9, id: 'accent', params: { threshold: 100 / 127, amount: 1, decay: 0.3 } },
    // Amp cv: the amp envelope (in1) plus a little accent (in2, 0.25): an
    // accented note is a bit louder, without a second VCA.
    { idx: 10, id: 'mixer', params: { lvl1: 1, lvl2: 0.25 } },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'gate'], to: [3, 'gate'] },
    { from: [0, 'gate'], to: [7, 'gate'] },
    { from: [0, 'gate'], to: [9, 'gate'] },
    { from: [0, 'vel'], to: [3, 'vel'] },
    { from: [0, 'vel'], to: [7, 'vel'] },
    { from: [0, 'vel'], to: [9, 'vel'] },
    { from: [0, 'mod'], to: [4, 'in2'] },
    { from: [3, 'env'], to: [4, 'in1'] },
    { from: [9, 'cv'], to: [4, 'in3'] },
    { from: [4, 'out'], to: [2, 'cv'] },
    { from: [1, 'out'], to: [2, 'in'] },
    { from: [2, 'out'], to: [5, 'in'] },
    { from: [5, 'out'], to: [6, 'in'] },
    { from: [7, 'env'], to: [10, 'in1'] },
    { from: [9, 'cv'], to: [10, 'in2'] },
    { from: [10, 'out'], to: [6, 'cv'] },
    { from: [6, 'out'], to: [8, 'l'] },
    { from: [6, 'out'], to: [8, 'r'] },
  ],
};

/**
 * Sub Bass: a clean sub for deep house. A sine with a quiet triangle under
 * an LP12 at 180 Hz, then a gentle, mostly-dry saturator that adds just
 * enough harmonics to be heard on small speakers. Short legato glide.
 */
const SUB_BASS: Patch = {
  name: 'Sub Bass',
  modules: [
    // Mono; overlapping notes glide in 30 ms.
    { idx: 0, id: 'midi_in', params: { mode: 1, glide: 0.03, glide_mode: 1 } },
    // The sub: a sine.
    { idx: 1, id: 'osc', params: { wave: 3 } },
    // A quiet triangle (a little odd-harmonic body).
    { idx: 2, id: 'osc', params: { wave: 2 } },
    // Mix.
    { idx: 3, id: 'mixer', params: { lvl1: 0.8, lvl2: 0.2 } },
    // LP12 at 180 Hz: keeps it sub.
    { idx: 4, id: 'filter', params: { mode: 1, cutoff: 180, reso: 0 } },
    // Small-speaker harmonics: gentle drive, 20 % wet.
    { idx: 5, id: 'saturator', params: { drive: 0.3, mix: 0.2 } },
    // Amp.
    { idx: 6, id: 'vca' },
    // Amp envelope: clickless onset, full sustain, short release; a little velocity.
    { idx: 7, id: 'adsr', params: { attack: 0.003, decay: 0.2, sustain: 1, release: 0.08, vel_amt: 0.2 } },
    // Out: sets the house level.
    { idx: 8, id: 'out', params: { level: 0.42 } },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'pitch'], to: [2, 'pitch'] },
    { from: [0, 'gate'], to: [7, 'gate'] },
    { from: [0, 'vel'], to: [7, 'vel'] },
    { from: [1, 'out'], to: [3, 'in1'] },
    { from: [2, 'out'], to: [3, 'in2'] },
    { from: [3, 'out'], to: [4, 'in'] },
    { from: [4, 'out'], to: [5, 'in'] },
    { from: [5, 'out'], to: [6, 'in'] },
    { from: [7, 'env'], to: [6, 'cv'] },
    { from: [6, 'out'], to: [8, 'l'] },
    { from: [6, 'out'], to: [8, 'r'] },
  ],
};

/**
 * Strings: a string-machine section. Four detuned saws plus a detuned pair an
 * octave up through a gentle LP12, a slow ~0.35 s swell and a long release,
 * then the ensemble chorus that makes it a string machine.
 */
const STRINGS: Patch = {
  name: 'Strings',
  modules: [
    // Poly, 8 voices.
    { idx: 0, id: 'midi_in' },
    // 8': four detuned saws.
    { idx: 1, id: 'osc', params: { wave: 0, unison: 4, detune: 22 } },
    // 4': two detuned saws an octave up.
    { idx: 2, id: 'osc', params: { wave: 0, octave: 1, unison: 2, detune: 14 } },
    // Registers.
    { idx: 3, id: 'mixer', params: { lvl1: 0.7, lvl2: 0.35 } },
    // Gentle LP12: silky, not buzzy.
    { idx: 4, id: 'filter', params: { mode: 1, cutoff: 2800, reso: 0.05 } },
    // Amp.
    { idx: 5, id: 'vca' },
    // Amp envelope: a 0.45 s bowed swell, full sustain, a long 1 s release; a little velocity.
    { idx: 6, id: 'adsr', params: { attack: 0.45, decay: 0.5, sustain: 1, release: 1, vel_amt: 0.3 } },
    // The ensemble: slow, deep chorus.
    { idx: 7, id: 'chorus', params: { rate: 0.45, depth: 0.5, mix: 0.35 } },
    // Out: sets the house level.
    { idx: 8, id: 'out', params: { level: 0.3 } },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'pitch'], to: [2, 'pitch'] },
    { from: [0, 'gate'], to: [6, 'gate'] },
    { from: [0, 'vel'], to: [6, 'vel'] },
    { from: [1, 'out'], to: [3, 'in1'] },
    { from: [2, 'out'], to: [3, 'in2'] },
    { from: [3, 'out'], to: [4, 'in'] },
    { from: [4, 'out'], to: [5, 'in'] },
    { from: [6, 'env'], to: [5, 'cv'] },
    { from: [5, 'out'], to: [7, 'l'] },
    { from: [7, 'l'], to: [8, 'l'] },
    { from: [7, 'r'], to: [8, 'r'] },
  ],
};

/**
 * Warm Pad: a moving pad (unlike the starter Pad). Three detuned saws plus a
 * triangle an octave up, through an LP12 that a tempo-synced LFO sweeps over
 * two bars, a slow swell and release, and a wide chorus.
 */
const WARM_PAD: Patch = {
  name: 'Warm Pad',
  modules: [
    // Poly, 8 voices.
    { idx: 0, id: 'midi_in' },
    // Body: three detuned saws.
    { idx: 1, id: 'osc', params: { wave: 0, unison: 3, detune: 20 } },
    // Air: a triangle an octave up.
    { idx: 2, id: 'osc', params: { wave: 2, octave: 1 } },
    // Mix.
    { idx: 3, id: 'mixer', params: { lvl1: 0.7, lvl2: 0.4 } },
    // Warm LP12, swept ±1.2 oct around 900 Hz by the LFO.
    { idx: 4, id: 'filter', params: { mode: 1, cutoff: 900, reso: 0.2, cv_amt: 1.2 } },
    // The movement: a sine locked to the song, one cycle per 2 bars.
    { idx: 5, id: 'lfo', params: { wave: 0, sync: 1, division: 6 } },
    // Amp.
    { idx: 6, id: 'vca' },
    // Amp envelope: slow swell, full sustain, long release; a little velocity.
    { idx: 7, id: 'adsr', params: { attack: 0.9, decay: 1, sustain: 1, release: 1.8, vel_amt: 0.25 } },
    // Width: a slow, deep chorus.
    { idx: 8, id: 'chorus', params: { rate: 0.3, depth: 0.7, mix: 0.4 } },
    // Out: sets the house level.
    { idx: 9, id: 'out', params: { level: 0.35 } },
  ],
  cables: [
    { from: [0, 'pitch'], to: [1, 'pitch'] },
    { from: [0, 'pitch'], to: [2, 'pitch'] },
    { from: [0, 'gate'], to: [7, 'gate'] },
    { from: [0, 'vel'], to: [7, 'vel'] },
    { from: [1, 'out'], to: [3, 'in1'] },
    { from: [2, 'out'], to: [3, 'in2'] },
    { from: [3, 'out'], to: [4, 'in'] },
    { from: [5, 'out'], to: [4, 'cv'] },
    { from: [4, 'out'], to: [6, 'in'] },
    { from: [7, 'env'], to: [6, 'cv'] },
    { from: [6, 'out'], to: [8, 'l'] },
    { from: [8, 'l'], to: [9, 'l'] },
    { from: [8, 'r'], to: [9, 'r'] },
  ],
};

/** The House groups, in menu order (labels are shown as optgroups). */
export const HOUSE_GROUPS: { label: string; patches: Patch[] }[] = [
  { label: 'House · Leads & Stabs', patches: [SAX, BRASS_STAB, ARP_PLUCK] },
  { label: 'House · Keys', patches: [TINE_KEYS, PIANO_STAB, GARAGE_ORGAN] },
  { label: 'House · Bass', patches: [ORGAN_BASS, REESE_BASS, ACID_LINE, SUB_BASS] },
  { label: 'House · Pads', patches: [STRINGS, WARM_PAD] },
];

/** Each house patch's typical phrase, by name (not part of Patch, so saved files are unchanged). */
export const HOUSE_PHRASES: Record<string, HousePhrase> = {
  Sax: 'lead',
  'Brass Stab': 'chord4',
  'Arp Pluck': 'arp',
  'Tine Keys': 'chord4',
  'Piano Stab': 'chord4',
  'Garage Organ': 'chord4',
  'Organ Bass': 'bass',
  'Reese Bass': 'bass',
  'Acid Line': 'bass',
  'Sub Bass': 'bass',
  Strings: 'chord5',
  'Warm Pad': 'chord5',
};
