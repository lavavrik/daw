#!/usr/bin/env node
// Generates the built-in drum kits in samples/kits/<kit-id>/<role>.wav
// (plan 25 Task 1, spec 2026-11-19-builtin-content.md §1): four kits beside
// the starter kit (scripts/make-starter-kit.mjs), each with the eight row
// roles of DEFAULT_KIT (Kick, Clap, Closed hat, Open hat, Snare, Rim,
// Shaker, Perc). Original sounds synthesised from scratch, CC0 (LICENSE.txt
// is written next to them). Re-run any time:
//
//   node scripts/make-kits.mjs            write the files
//   node scripts/make-kits.mjs --hashes   print { "<kit>/<file>": sha256 } as JSON, write nothing
//
// 48 kHz, 16-bit mono WAV (scripts/lib/synth.mjs). Every noise source is
// seeded, so every run writes byte-identical files: app/src/state/kits.test.ts
// pins the hashes and checks the files on disk match. The kit data the app
// reads (ids, names, file per role) is app/src/state/kits.ts; keep the two
// in step.
//
// Levels: every sound is normalised to a -1 dBFS peak, like the starter
// kit, so loading a kit over a track (rows by role) keeps the track's
// balance: the row gains the user set still mean the same thing.
// Lengths stay short (budget: all kits under 3 MB): kicks under 0.8 s, hats
// and claps under 0.5 s. A long sound fades out over its last quarter
// (fadeTail, applied to every sound) so no tail is cut off abruptly.
//
// Measured after generation (a throwaway Node analysis of the written WAVs).
// Each recipe below ends with `peak / length / centroid (power centroid)`:
// peak in dBFS, length in s, spectral centroid = the mean frequency of the
// whole sound's summed 2048-point Hann spectra weighted by magnitude, and in
// brackets weighted by power (what dominates the energy). The magnitude
// centroid shows the grit: Dusty's kick reads 848 Hz from its crush noise
// and drive harmonics while its energy still sits at 58 Hz. The kits differ
// where it counts: kicks settle at 50-58 Hz; Garage the shortest and
// brightest (hats 13 kHz, snare 9.3 kHz), Deep the darkest (clap 2.2 kHz,
// hats 9 kHz, snare 4.4 kHz, a clean round 50 Hz boom), Drum Machine its own
// 909-ish set (a long two-stage kick sweep, ringing 6 kHz square-bank hats,
// a peaky 2.4 kHz clap, a body-led snare).
//
// Distinctness (review round 1): per role, the mean |dB| difference of the
// level-normalised third-octave spectra against the starter kit's sound for
// the same role is over 3 dB for every Drum Machine role (kick 3.7, clap
// 7.8, closed hat 4.7, open hat 4.8, snare 11.5, rim 11.9, shaker 7.1, perc
// 7.8), and Deep's kick is 3.8 dB from the starter's kick-deep. Dusty's
// hats keep their own sound against Deep's noise-led ones (final review:
// closed 4.8, open 4.0 dB) while everything under 300 Hz is 74 dB down.
// Claps and snares fade in over 1.5 ms like the kicks (first sample 0).

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Biquad, SR, TAU, env, finish, makeNoise, render, wav16 } from './lib/synth.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'kits');

/** File name per role (the same in every kit). */
export const ROLE_FILES = {
  Kick: 'kick.wav',
  Clap: 'clap.wav',
  'Closed hat': 'closed-hat.wav',
  'Open hat': 'open-hat.wav',
  Snare: 'snare.wav',
  Rim: 'rim.wav',
  Shaker: 'shaker.wav',
  Perc: 'perc.wav',
};


// ---------- voice builders (parameterised per kit) ----------

/**
 * Kick: a sine whose pitch falls exponentially to f1. One stage (f0 → f1 in
 * `tau`), or two (`fm`, `tau2`: f0 → fm fast in `tau`, then fm → f1 slowly
 * in `tau2`, the long 909-style sweep). An exponential body decay, a
 * high-passed noise click on top, all through tanh saturation (`drive`:
 * more = squarer, louder body). The whole kick fades in over `attack`
 * (1.5 ms): the first sample is 0 and the click never starts as a DC step.
 * `knock` adds an upper partial that follows the pitch.
 */
function kick({ seconds, f0, f1, tau, fm = f1, tau2 = 1, decay, drive, click, clickHp = 3000, clickDecay = 0.002, attack = 0.0015, knock = null, seed }) {
  let ph = 0;
  const n = makeNoise(seed);
  const hp = new Biquad('hp', clickHp);
  return render(seconds, (t) => {
    ph += (TAU * (f1 + (fm - f1) * Math.exp(-t / tau2) + (f0 - fm) * Math.exp(-t / tau))) / SR;
    let body = Math.sin(ph) * env(t, decay, 0.001);
    // `knock` [ratio, level, decay]: a partial at ratio × the pitch (a warm knock on top of the sub).
    if (knock) body += Math.sin(ph * knock[0]) * knock[1] * env(t, knock[2], 0.001);
    const c = hp.process(n()) * Math.exp(-t / clickDecay) * click;
    return Math.min(1, t / attack) * Math.tanh(drive * (body + c));
  });
}

/**
 * Clap: `bursts` band-passed noise bursts `spacing` s apart (the hands not
 * quite together), each decaying in `burstDecay`, then a room tail of
 * `tailLevel` decaying in `tail`. `lp` darkens it (0 = off).
 */
function clap({ seconds, bursts, spacing, burstDecay, tail, tailLevel, bp, q, hp, lp = 0, seed }) {
  const n = makeNoise(seed);
  const band = new Biquad('bp', bp, q);
  const high = new Biquad('hp', hp);
  const low = lp ? new Biquad('lp', lp) : null;
  const last = (bursts - 1) * spacing;
  return render(seconds, (t) => {
    let e = 0;
    for (let k = 0; k < bursts; k++) {
      const at = k * spacing;
      if (t >= at) e = Math.max(e, Math.exp(-(t - at) / burstDecay));
    }
    if (t >= last) e = Math.max(e, tailLevel * Math.exp(-(t - last) / tail));
    const x = high.process(band.process(n())) * e;
    return low ? low.process(x) : x;
  });
}

/**
 * Snare: drum-head tones (each [Hz, level]) with a short pitch drop
 * (`bend`: start at f*bend, settle in 10 ms) plus band-limited noise for the
 * wires; `crack` adds a very short bright transient (band-pass 5 kHz).
 */
function snare({ seconds, tones, toneDecay, bend = 1, noiseHp, noiseLp, noiseDecay, toneLevel, noiseLevel, crack = 0, attack = 0.0005, seed }) {
  const n = makeNoise(seed);
  const hp = new Biquad('hp', noiseHp);
  const lp = new Biquad('lp', noiseLp);
  const cr = new Biquad('bp', 5000, 1.2);
  const ph = tones.map(() => 0);
  return render(seconds, (t) => {
    const b = 1 + (bend - 1) * Math.exp(-t / 0.01);
    let tone = 0;
    tones.forEach(([f, a], k) => {
      ph[k] += (TAU * f * b) / SR;
      tone += Math.sin(ph[k]) * a;
    });
    const w = n();
    const noise = lp.process(hp.process(w)) * env(t, noiseDecay, attack);
    const c = cr.process(w) * Math.exp(-t / 0.004) * crack;
    return toneLevel * tone * env(t, toneDecay, attack) + noiseLevel * noise + c;
  });
}

/** The classic metallic cluster: six detuned square waves (base ratios × `scale`). */
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
/** Drum Machine's own bank: six squares spread higher and wider (a brighter, more clangy ring). */
const METAL_DM = [263, 400, 421, 474, 587, 845];

/**
 * Hat: the square cluster mixed with noise (`noise` 0..1 = how much is
 * noise), band-passed and high-passed into the top octaves, optional
 * low-pass `lp` (darker, "dusty"), exponential `decay`. `grain` modulates
 * the noise with a second noise (a rougher, dirtier texture).
 */
function hat({ seconds, decay, scale, noise, bp, bpQ, hp, lp = 0, grain = 0, attack = 0.0005, bank = METAL, seed }) {
  const n = makeNoise(seed);
  const g = makeNoise(seed + 1000);
  const band = new Biquad('bp', bp, bpQ);
  const high = new Biquad('hp', hp);
  const low = lp ? new Biquad('lp', lp) : null;
  const freqs = bank.map((f) => f * scale);
  return render(seconds, (t) => {
    let s = 0;
    for (const f of freqs) s += Math.sin(TAU * f * t) >= 0 ? 1 : -1;
    const w = n() * (1 - grain + grain * Math.abs(g()));
    const x = high.process(band.process((1 - noise) * (s / 6) + noise * w)) * env(t, decay, attack);
    return low ? low.process(x) : x;
  });
}

/** Rim / clave / woodblock: two short sine partials plus a noise tick through a band-pass. */
function ping({ seconds, partials, decay, tick, tickBp, tickQ = 3, seed }) {
  const n = makeNoise(seed);
  const bp = new Biquad('bp', tickBp, tickQ);
  return render(seconds, (t) => {
    let s = 0;
    for (const [f, a] of partials) s += Math.sin(TAU * f * t) * a;
    return s * env(t, decay) + bp.process(n()) * env(t, 0.003) * tick;
  });
}

/**
 * Shaker: high-passed (and band-passed) noise, one envelope per stroke
 * ([start s, level]), each with a soft `attack` and a `decay`.
 */
function shaker({ seconds, strokes, attack, decay, hp, bp, bpQ = 0.8, seed }) {
  const n = makeNoise(seed);
  const high = new Biquad('hp', hp);
  const band = new Biquad('bp', bp, bpQ);
  return render(seconds, (t) => {
    let e = 0;
    for (const [at, a] of strokes) {
      if (t < at) continue;
      const u = t - at;
      e = Math.max(e, a * (u < attack ? u / attack : Math.exp(-(u - attack) / decay)));
    }
    return band.process(high.process(n())) * e;
  });
}

/**
 * Tom / conga / bongo: a sine falling from f*bend to f (in `tau`), with an
 * optional second partial (`over`: [ratio, level, decay]) for the slap, and a
 * little noise on the attack.
 */
function drum({ seconds, f, bend, tau, decay, over = null, tick = 0, seed }) {
  const n = makeNoise(seed);
  const hp = new Biquad('hp', 2000);
  let ph = 0;
  let ph2 = 0;
  return render(seconds, (t) => {
    const fr = f * (1 + (bend - 1) * Math.exp(-t / tau));
    ph += (TAU * fr) / SR;
    let s = Math.sin(ph) * env(t, decay, 0.001);
    if (over) {
      ph2 += (TAU * fr * over[0]) / SR;
      s += Math.sin(ph2) * over[1] * env(t, over[2], 0.001);
    }
    return s + hp.process(n()) * env(t, 0.004) * tick;
  });
}

// ---------- post-processing ----------

/**
 * Lo-fi: low-pass at `lp`, then sample-and-hold every `hold` samples (48 kHz
 * / hold: 4 = 12 kHz, with its aliasing), quantise to `bits`, then add tape
 * hiss that rides on the sound (an envelope follower, 80 ms release: the hiss
 * sits `hissDb` under the sound's level, so a short hit stays short) over a
 * fixed floor 54 dB under the peak, and vinyl crackle.
 *
 * Hiss and crackle go through a 400 Hz high-pass (two stages, 24 dB/oct):
 * they add grit on top, never rumble under a hat or a kick. Crackle only on
 * sounds of 300 ms or more (on a short hit a click at a fixed offset would
 * repeat on every 16th, a rhythm rather than vinyl): sparse (`crackle`
 * clicks per second on average, Poisson-like: each sample has the same small
 * chance, so the gaps are irregular), each a 3-sample decaying click of
 * random level (-30 to -16 dB under the peak) and polarity. `outHp`
 * high-passes the whole result (two stages): for hats and shakers, whose
 * coarse quantisation would otherwise spread its error down into the lows.
 * 700 Hz (final review): everything under 300 Hz stays 74 dB or more down,
 * while the crush grit between 700 Hz and 2 kHz is kept; it is what tells
 * Dusty's hats from Deep's noise-led ones (2 kHz made them near twins).
 */
function dust(x, { lp, hold, bits, hissDb, crackle, outHp = 0, seed }) {
  const n = makeNoise(seed);
  const c = makeNoise(seed + 7);
  const low = new Biquad('lp', lp);
  const hissLp = new Biquad('lp', 7000);
  const hp1 = new Biquad('hp', 400);
  const hp2 = new Biquad('hp', 400);
  const out1 = outHp ? new Biquad('hp', outHp) : null;
  const out2 = outHp ? new Biquad('hp', outHp) : null;
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const q = 2 ** (bits - 1);
  const rel = 10 ** (-hissDb / 20);
  const floor = peak * 10 ** (-54 / 20);
  const fall = Math.exp(-1 / (0.08 * SR));
  const crackles = x.length >= 0.3 * SR ? crackle : 0;
  let held = 0;
  let follow = 0;
  let click = 0;
  for (let i = 0; i < x.length; i++) {
    const f = low.process(x[i]);
    follow = Math.max(Math.abs(f), follow * fall);
    if (i % hold === 0) held = (Math.round((f / peak) * q) / q) * peak;
    if ((c() + 1) / 2 < crackles / SR) {
      const level = 10 ** ((-30 + 14 * ((c() + 1) / 2)) / 20);
      click = peak * level * (c() > 0 ? 1 : -1);
    }
    const grit = hissLp.process(n()) * (rel * follow + floor) + click;
    click *= 0.35; // a 3-sample click
    const y = held + hp2.process(hp1.process(grit));
    x[i] = out1 ? out2.process(out1.process(y)) : y;
  }
  return x;
}

/**
 * Fade the first `seconds` in linearly (1.5 ms): the sound starts from 0,
 * never with a step. Kicks do it inside kick(); claps and snares get it
 * here, after any lo-fi pass (renderKits), so even Dusty's start at 0.
 */
function fadeIn(x, seconds = 0.0015) {
  const n = Math.round(seconds * SR);
  for (let i = 0; i < Math.min(n, x.length); i++) x[i] *= i / n;
  return x;
}

/** Fade the last `fraction` of the sound out on a half-cosine (no cut-off tail). */
function fadeTail(x, fraction = 0.25) {
  const len = Math.round(x.length * fraction);
  const from = x.length - len;
  for (let i = from; i < x.length; i++) x[i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i - from)) / len);
  return x;
}

// ---------- the kits ----------
// Seeds: 100 × kit + 10 × role + k, so no two sounds share a noise stream.

export const KIT_SOUNDS = {
  // Drum Machine — 909-ish, its own sounds (not the starter's): a kick with
  // a long two-stage pitch sweep and soft saturation, hats from a brighter
  // square bank through a ringing band-pass, a clap with a peaky band and a
  // longer room, a snare whose body tones lead and whose noise is a high
  // snap, a three-partial rim, a mid-band shaker, a pitched tom.
  'drum-machine': {
    // 320 → 120 Hz in 4 ms, then → 51 Hz in 60 ms, 0.3 s body, drive 1.2, soft click. -1.0 dB / 0.70 s / 151 Hz (59 Hz)
    Kick: () => kick({ seconds: 0.7, f0: 320, fm: 120, tau: 0.004, f1: 51, tau2: 0.06, decay: 0.3, drive: 1.2, click: 0.25, clickHp: 1500, clickDecay: 0.004, seed: 100 }),
    // 4 bursts 8 ms apart, BP 2.4 kHz (Q 2.8), HP 1 kHz, 0.16 s room. -1.0 dB / 0.45 s / 5.4 kHz (3.1 kHz)
    Clap: () => clap({ seconds: 0.45, bursts: 4, spacing: 0.008, burstDecay: 0.0035, tail: 0.16, tailLevel: 0.55, bp: 2400, q: 2.8, hp: 1000, seed: 110 }),
    // Squares (METAL_DM ×2.4) + 15 % noise, ringing BP 6 kHz (Q 3), HP 4.5 kHz, 28 ms. -1.0 dB / 0.11 s / 8.0 kHz (6.3 kHz)
    'Closed hat': () => hat({ seconds: 0.11, decay: 0.028, bank: METAL_DM, scale: 2.4, noise: 0.15, bp: 6000, bpQ: 3, hp: 4500, seed: 120 }),
    // Same bank, 0.32 s decay. -1.0 dB / 0.48 s / 7.9 kHz (6.3 kHz)
    'Open hat': () => hat({ seconds: 0.48, decay: 0.32, bank: METAL_DM, scale: 2.4, noise: 0.15, bp: 6000, bpQ: 3, hp: 4500, seed: 130 }),
    // Body 238 + 476 Hz bending from ×1.4 (80 ms) leads; snap: noise HP 3.5 kHz (90 ms) + 5 kHz crack. -1.0 dB / 0.32 s / 7.6 kHz (2.1 kHz)
    Snare: () => snare({ seconds: 0.32, tones: [[238, 0.55], [476, 0.45]], toneDecay: 0.08, bend: 1.4, noiseHp: 3500, noiseLp: 12000, noiseDecay: 0.09, toneLevel: 1, noiseLevel: 0.75, crack: 0.6, seed: 140 }),
    // 1.25 kHz + 3.1 kHz + 620 Hz, 9 ms, tick at 5 kHz. -1.0 dB / 0.09 s / 2.5 kHz (1.6 kHz)
    Rim: () => ping({ seconds: 0.09, partials: [[1250, 0.5], [3100, 0.3], [620, 0.2]], decay: 0.009, tick: 0.6, tickBp: 5000, seed: 150 }),
    // Mid-band: HP 2 kHz, BP 3 kHz (Q 2), 6 ms attack, 30 ms decay. -1.0 dB / 0.14 s / 6.4 kHz (4.1 kHz)
    Shaker: () => shaker({ seconds: 0.14, strokes: [[0, 1]], attack: 0.006, decay: 0.03, hp: 2000, bp: 3000, bpQ: 2, seed: 160 }),
    // Mid tom: 105 Hz bending from ×1.5 in 40 ms, 0.18 s. -1.0 dB / 0.40 s / 368 Hz (113 Hz)
    Perc: () => drum({ seconds: 0.4, f: 105, bend: 1.5, tau: 0.04, decay: 0.18, tick: 0.3, seed: 170 }),
  },

  // Deep — round and soft: a long low kick with a dull click, a darker clap
  // with more room, dusty noise-led hats, a soft snare, a conga.
  deep: {
    // Round boom: a short glide 75 → 50 Hz (50 ms), 0.45 s body, clean (drive 1), no click. -1.0 dB / 0.75 s / 62 Hz (52 Hz)
    Kick: () => kick({ seconds: 0.75, f0: 75, f1: 50, tau: 0.05, decay: 0.45, drive: 1, click: 0, seed: 200 }),
    // 3 bursts 13 ms apart, BP 900 Hz, LP 3.5 kHz, 0.17 s tail. -1.0 dB / 0.48 s / 2.2 kHz (1.3 kHz)
    Clap: () => clap({ seconds: 0.48, bursts: 3, spacing: 0.013, burstDecay: 0.006, tail: 0.17, tailLevel: 0.6, bp: 900, q: 1.1, hp: 400, lp: 3500, seed: 210 }),
    // 80 % grainy noise, BP 8 kHz, LP 11 kHz, 1.5 ms attack, 45 ms. -1.0 dB / 0.14 s / 9.0 kHz (8.6 kHz)
    'Closed hat': () => hat({ seconds: 0.14, decay: 0.045, scale: 1.6, noise: 0.8, grain: 0.6, bp: 8000, bpQ: 0.6, hp: 5500, lp: 11000, attack: 0.0015, seed: 220 }),
    // Same, 0.2 s decay. -1.0 dB / 0.45 s / 9.1 kHz (8.5 kHz)
    'Open hat': () => hat({ seconds: 0.45, decay: 0.2, scale: 1.6, noise: 0.8, grain: 0.6, bp: 8000, bpQ: 0.6, hp: 5500, lp: 11000, attack: 0.0015, seed: 230 }),
    // 165 + 290 Hz heads, wires HP 900 Hz / LP 5 kHz, 3 ms attack, 0.16 s. -1.0 dB / 0.36 s / 4.4 kHz (1.3 kHz)
    Snare: () => snare({ seconds: 0.36, tones: [[165, 0.6], [290, 0.4]], toneDecay: 0.07, noiseHp: 900, noiseLp: 5000, noiseDecay: 0.16, toneLevel: 0.8, noiseLevel: 0.6, attack: 0.003, seed: 240 }),
    // Woody side-stick: 900 + 380 Hz, 18 ms, tick at 1.2 kHz. -1.0 dB / 0.12 s / 748 Hz (640 Hz)
    Rim: () => ping({ seconds: 0.12, partials: [[900, 0.5], [380, 0.5]], decay: 0.018, tick: 0.5, tickBp: 1200, tickQ: 2, seed: 250 }),
    // BP 5 kHz, 25 ms attack, 60 ms decay. -1.0 dB / 0.20 s / 9.1 kHz (7.5 kHz)
    Shaker: () => shaker({ seconds: 0.2, strokes: [[0, 1]], attack: 0.025, decay: 0.06, hp: 3500, bp: 5000, bpQ: 0.8, seed: 260 }),
    // Conga: 220 Hz from ×1.25, slap partial ×2.4 (25 ms), 0.1 s. -1.0 dB / 0.30 s / 455 Hz (225 Hz)
    Perc: () => drum({ seconds: 0.3, f: 220, bend: 1.25, tau: 0.015, decay: 0.1, over: [2.4, 0.35, 0.025], tick: 0.15, seed: 270 }),
  },

  // Garage — snappy and short: a tight punchy kick, a fast clap, very
  // short hats, a cracking snare and rim, a two-stroke shaker, a clave.
  garage: {
    // 320 → 58 Hz in 12 ms, 0.13 s body, strong click (HP 3.5 kHz). -1.0 dB / 0.38 s / 171 Hz (63 Hz)
    Kick: () => kick({ seconds: 0.38, f0: 320, f1: 58, tau: 0.012, decay: 0.13, drive: 2.8, click: 0.7, clickHp: 3500, seed: 300 }),
    // 3 bursts 6 ms apart, BP 1.7 kHz (Q 2.2), 60 ms tail. -1.0 dB / 0.28 s / 5.0 kHz (2.5 kHz)
    Clap: () => clap({ seconds: 0.28, bursts: 3, spacing: 0.006, burstDecay: 0.003, tail: 0.06, tailLevel: 0.8, bp: 1700, q: 2.2, hp: 900, seed: 310 }),
    // Squares ×2.2, HP 9 kHz, 16 ms. -1.0 dB / 0.07 s / 13.3 kHz (13.0 kHz)
    'Closed hat': () => hat({ seconds: 0.07, decay: 0.016, scale: 2.2, noise: 0.4, bp: 12000, bpQ: 1, hp: 9000, seed: 320 }),
    // Same, 0.11 s decay: a short "tss". -1.0 dB / 0.30 s / 13.3 kHz (13.0 kHz)
    'Open hat': () => hat({ seconds: 0.3, decay: 0.11, scale: 2.2, noise: 0.4, bp: 12000, bpQ: 1, hp: 9000, seed: 330 }),
    // 230 + 420 Hz heads (30 ms), wires HP 3 kHz (70 ms), 5 kHz crack. -1.0 dB / 0.24 s / 9.3 kHz (8.1 kHz)
    Snare: () => snare({ seconds: 0.24, tones: [[230, 0.6], [420, 0.4]], toneDecay: 0.03, bend: 1.2, noiseHp: 3000, noiseLp: 14000, noiseDecay: 0.07, toneLevel: 0.6, noiseLevel: 1, crack: 0.8, seed: 340 }),
    // 2.2 kHz + 720 Hz, 6 ms, bright tick. -1.0 dB / 0.07 s / 2.9 kHz (1.8 kHz)
    Rim: () => ping({ seconds: 0.07, partials: [[2200, 0.6], [720, 0.4]], decay: 0.006, tick: 1, tickBp: 3500, seed: 350 }),
    // Two strokes ("ch-ka", 55 ms apart), HP 6.5 kHz, BP 9 kHz. -1.0 dB / 0.16 s / 11.8 kHz (11.0 kHz)
    Shaker: () => shaker({ seconds: 0.16, strokes: [[0, 0.7], [0.055, 1]], attack: 0.008, decay: 0.025, hp: 6500, bp: 9000, seed: 360 }),
    // Clave: 2.5 kHz + 1.25 kHz, 20 ms. -1.0 dB / 0.12 s / 2.2 kHz (2.3 kHz)
    Perc: () => ping({ seconds: 0.12, partials: [[2500, 0.7], [1250, 0.3]], decay: 0.02, tick: 0.3, tickBp: 3000, seed: 370 }),
  },

  // Dusty — lo-fi: every sound through dust() (sample-and-hold, few bits,
  // hiss, crackle), the kick over-driven, the hats darkened before the crush.
  dusty: {
    // 150 → 52 Hz in 30 ms, 0.24 s, drive 3; LP 5 kHz, 12 kHz / 8 bit. -1.0 dB / 0.55 s / 848 Hz (58 Hz)
    Kick: () => dust(kick({ seconds: 0.55, f0: 150, f1: 52, tau: 0.03, decay: 0.24, drive: 3, click: 0.3, seed: 400 }), { lp: 5000, hold: 4, bits: 8, hissDb: 38, crackle: 6, seed: 401 }),
    // 4 bursts 11 ms apart, BP 1.25 kHz, 0.13 s tail; 16 kHz / 6 bit. -1.0 dB / 0.42 s / 6.3 kHz (2.5 kHz)
    Clap: () => dust(clap({ seconds: 0.42, bursts: 4, spacing: 0.011, burstDecay: 0.005, tail: 0.13, tailLevel: 0.7, bp: 1250, q: 1.3, hp: 500, seed: 410 }), { lp: 7000, hold: 3, bits: 6, hissDb: 34, crackle: 8, seed: 411 }),
    // Squares ×1.8, LP 9 kHz, 35 ms; 24 kHz / 6 bit, then HP 700 Hz. -1.0 dB / 0.12 s / 9.9 kHz (8.8 kHz)
    'Closed hat': () => dust(hat({ seconds: 0.12, decay: 0.035, scale: 1.8, noise: 0.5, bp: 8500, bpQ: 0.7, hp: 5000, lp: 9000, seed: 420 }), { lp: 9000, hold: 2, bits: 6, hissDb: 30, crackle: 10, outHp: 700, seed: 421 }),
    // Same, 0.22 s decay. -1.0 dB / 0.45 s / 10.0 kHz (8.7 kHz)
    'Open hat': () => dust(hat({ seconds: 0.45, decay: 0.22, scale: 1.8, noise: 0.5, bp: 8500, bpQ: 0.7, hp: 5000, lp: 9000, seed: 430 }), { lp: 9000, hold: 2, bits: 6, hissDb: 30, crackle: 10, outHp: 700, seed: 431 }),
    // 180 + 310 Hz heads, wires HP 1.2 kHz (0.18 s); 16 kHz / 6 bit. -1.0 dB / 0.34 s / 8.1 kHz (4.6 kHz)
    Snare: () => dust(snare({ seconds: 0.34, tones: [[180, 0.6], [310, 0.4]], toneDecay: 0.06, noiseHp: 1200, noiseLp: 9000, noiseDecay: 0.18, toneLevel: 0.7, noiseLevel: 0.9, seed: 440 }), { lp: 8000, hold: 3, bits: 6, hissDb: 34, crackle: 8, seed: 441 }),
    // 1.6 kHz + 450 Hz, 12 ms; 16 kHz / 7 bit. -1.0 dB / 0.10 s / 5.2 kHz (1.6 kHz)
    Rim: () => dust(ping({ seconds: 0.1, partials: [[1600, 0.6], [450, 0.4]], decay: 0.012, tick: 0.6, tickBp: 2000, seed: 450 }), { lp: 7000, hold: 3, bits: 7, hissDb: 34, crackle: 8, seed: 451 }),
    // HP 5 kHz, 20 ms attack, 50 ms; 24 kHz / 6 bit, then HP 700 Hz. -1.0 dB / 0.18 s / 10.1 kHz (9.0 kHz)
    Shaker: () => dust(shaker({ seconds: 0.18, strokes: [[0, 1]], attack: 0.02, decay: 0.05, hp: 5000, bp: 7000, seed: 460 }), { lp: 9000, hold: 2, bits: 6, hissDb: 30, crackle: 10, outHp: 700, seed: 461 }),
    // Bongo: 420 Hz from ×1.25, slap ×2.1, 60 ms; 12 kHz / 7 bit. -1.0 dB / 0.25 s / 3.4 kHz (489 Hz)
    Perc: () => dust(drum({ seconds: 0.25, f: 420, bend: 1.25, tau: 0.012, decay: 0.06, over: [2.1, 0.3, 0.02], tick: 0.2, seed: 470 }), { lp: 6000, hold: 4, bits: 7, hissDb: 36, crackle: 6, seed: 471 }),
  },
};

/** Roles whose sounds get fadeIn (kicks ramp in kick() itself). */
const ONSET_FADE = new Set(['Clap', 'Snare']);

/** Every kit file as `{ path: "<kit>/<file>", bytes }`, in a fixed order. */
export function renderKits() {
  const out = [];
  for (const [kit, sounds] of Object.entries(KIT_SOUNDS)) {
    for (const [role, file] of Object.entries(ROLE_FILES)) {
      out.push({ path: `${kit}/${file}`, bytes: wav16(finish(fadeTail(ONSET_FADE.has(role) ? fadeIn(sounds[role]()) : sounds[role]()))) });
    }
  }
  return out;
}

const LICENSE = `Drum kits (drum-machine, deep, garage, dusty) — generated by scripts/make-kits.mjs.
Original synthesised sounds, dedicated to the public domain (CC0 1.0).
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = renderKits();
  if (process.argv.includes('--hashes')) {
    const hashes = Object.fromEntries(files.map((f) => [f.path, createHash('sha256').update(f.bytes).digest('hex')]));
    process.stdout.write(JSON.stringify(hashes, null, 2) + '\n');
  } else {
    for (const f of files) {
      const file = join(OUT, f.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, f.bytes);
      console.log(f.path);
    }
    writeFileSync(join(OUT, 'LICENSE.txt'), LICENSE);
  }
}
