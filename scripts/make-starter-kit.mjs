#!/usr/bin/env node
// Generates the starter sample kit in samples/starter/ — original sounds
// synthesised from scratch (no third-party audio), so the kit is ours to ship
// and free of licence questions (CC0). Re-run any time:
//
//   node scripts/make-starter-kit.mjs
//
// Output: 48 kHz, 16-bit, mono WAV. Each sound is normalised to -1 dBFS and
// ends with a 2 ms fade so nothing clicks at the tail. The noise generator is
// seeded, so every run produces byte-identical files.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'starter');
const TAU = Math.PI * 2;

// ---------- building blocks ----------

/** Deterministic white noise in [-1, 1] (mulberry32). */
function makeNoise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** RBJ-cookbook biquad. `set` may be called per sample for sweeps. */
class Biquad {
  constructor(type, freq, q = 0.707) {
    this.type = type;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(freq, q);
  }
  set(freq, q = this.q) {
    this.q = q;
    const w0 = (TAU * Math.min(freq, SR * 0.49)) / SR;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    let b0, b1, b2;
    if (this.type === 'lp') [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
    else if (this.type === 'hp') [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
    else [b0, b1, b2] = [alpha, 0, -alpha]; // 'bp', 0 dB peak gain
    const a0 = 1 + alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0; this.a2 = (1 - alpha) / a0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Exponential decay with a short linear attack (avoids onset clicks on tones). */
const env = (t, decay, attack = 0.0005) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

/** Band-limited sawtooth by additive synthesis (harmonics below Nyquist only). */
function saw(phase, freq) {
  let s = 0;
  const n = Math.floor((SR * 0.45) / freq);
  for (let k = 1; k <= n; k++) s += Math.sin(phase * k) / k;
  return s * (2 / Math.PI);
}

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

/** Render `seconds` of audio from a per-sample function f(t, i). */
function render(seconds, f) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = f(i / SR, i);
  return out;
}

// ---------- the kit ----------

const sounds = {
  // Deep house kick: pitch sweep 150 → 48 Hz, long-ish body, small click on top.
  'kick-deep': () => {
    let ph = 0;
    const n = makeNoise(1);
    const click = new Biquad('hp', 2500);
    return render(0.7, (t) => {
      ph += (TAU * (48 + 102 * Math.exp(-t / 0.035))) / SR;
      const body = Math.sin(ph) * env(t, 0.32, 0.001);
      const c = click.process(n()) * Math.exp(-t / 0.002) * 0.35;
      return Math.tanh(1.6 * (body + c));
    });
  },

  // Punchier, shorter kick for tech-house grooves.
  'kick-punch': () => {
    let ph = 0;
    const n = makeNoise(2);
    const click = new Biquad('hp', 3000);
    return render(0.4, (t) => {
      ph += (TAU * (55 + 175 * Math.exp(-t / 0.025))) / SR;
      const body = Math.sin(ph) * env(t, 0.16, 0.0008);
      const c = click.process(n()) * Math.exp(-t / 0.0025) * 0.5;
      return Math.tanh(2.2 * (body + c));
    });
  },

  // Clap: three quick band-passed noise bursts, then a short room tail.
  clap: () => {
    const n = makeNoise(3);
    const bp = new Biquad('bp', 1300, 1.4);
    const hp = new Biquad('hp', 600);
    return render(0.45, (t) => {
      let e = 0;
      for (const at of [0, 0.011, 0.022]) if (t >= at) e = Math.max(e, Math.exp(-(t - at) / 0.0045));
      if (t >= 0.03) e = Math.max(e, 0.7 * Math.exp(-(t - 0.03) / 0.11));
      return hp.process(bp.process(n())) * e * 3;
    });
  },

  // Snare: two drum-head tones plus bright noise.
  snare: () => {
    const n = makeNoise(4);
    const hp = new Biquad('hp', 1200);
    return render(0.35, (t) => {
      const tone = (Math.sin(TAU * 185 * t) * 0.6 + Math.sin(TAU * 330 * t) * 0.4) * env(t, 0.06);
      const noise = hp.process(n()) * env(t, 0.12);
      return 0.6 * tone + 0.9 * noise;
    });
  },

  // Rimshot: short woody ping.
  rim: () => {
    const n = makeNoise(5);
    const bp = new Biquad('bp', 1800, 3);
    return render(0.12, (t) => {
      const tone = (Math.sin(TAU * 1720 * t) * 0.6 + Math.sin(TAU * 480 * t) * 0.4) * env(t, 0.012);
      return tone + bp.process(n()) * env(t, 0.004) * 0.8;
    });
  },

  // Hats: six detuned square waves (classic metallic cluster) + a little noise,
  // band-limited to the top octaves.
  'hat-closed': () => metallicHat(0.15, 0.035, 6),
  'hat-open': () => metallicHat(0.7, 0.28, 7),

  // Shaker: high noise with a soft attack.
  shaker: () => {
    const n = makeNoise(8);
    const hp = new Biquad('hp', 6000);
    return render(0.16, (t) => hp.process(n()) * (t < 0.018 ? t / 0.018 : Math.exp(-(t - 0.018) / 0.04)));
  },

  // Conga-ish tom for percussion fills.
  'perc-tom': () => {
    let ph = 0;
    return render(0.4, (t) => {
      ph += (TAU * (180 + 60 * Math.exp(-t / 0.02))) / SR;
      return Math.sin(ph) * env(t, 0.13, 0.001);
    });
  },

  // Classic house chord stab: C minor 9 on detuned saws through a closing low-pass.
  'stab-cm9': () => {
    const notes = [48, 55, 58, 62, 63].map(midiHz); // C3 G3 Bb3 D4 Eb4
    const phases = notes.flatMap(() => [0, 0]);
    const lp1 = new Biquad('lp', 4000, 0.9);
    const lp2 = new Biquad('lp', 4000, 0.9);
    return render(0.8, (t) => {
      let s = 0;
      notes.forEach((f, k) => {
        for (const [j, det] of [[0, 0.997], [1, 1.003]]) {
          const idx = k * 2 + j;
          phases[idx] += (TAU * f * det) / SR;
          s += saw(phases[idx], f * det);
        }
      });
      const cutoff = 600 + 5000 * Math.exp(-t / 0.09);
      lp1.set(cutoff); lp2.set(cutoff);
      return lp2.process(lp1.process(s * 0.12)) * env(t, 0.28, 0.002);
    });
  },

  // House organ stab (M1-style): sine partials, fast decay, C minor 7.
  'stab-organ': () => {
    const notes = [60, 63, 67, 70].map(midiHz); // C4 Eb4 G4 Bb4
    return render(0.6, (t) => {
      let s = 0;
      for (const f of notes)
        s += Math.sin(TAU * f * t) + 0.5 * Math.sin(TAU * 2 * f * t) + 0.25 * Math.sin(TAU * 4 * f * t) * Math.exp(-t / 0.03);
      return Math.tanh(0.4 * s) * env(t, 0.16, 0.002);
    });
  },

  // Sub-bass one-shot on C2 with light saturation.
  'bass-sub-c2': () => {
    const f = midiHz(36);
    return render(0.6, (t) => Math.tanh(1.4 * Math.sin(TAU * f * t)) * env(t, 0.25, 0.003));
  },
};

function metallicHat(seconds, decay, seed) {
  const ratios = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 1.8);
  const n = makeNoise(seed);
  const bp = new Biquad('bp', 10000, 0.8);
  const hp = new Biquad('hp', 7000);
  return render(seconds, (t) => {
    let s = 0;
    for (const f of ratios) s += Math.sin(TAU * f * t) >= 0 ? 1 : -1;
    s = s / 6 + 0.4 * n();
    return hp.process(bp.process(s)) * env(t, decay);
  });
}

// ---------- finishing + WAV ----------

/** Normalise to -1 dBFS and fade the last 2 ms to silence. */
function finish(x) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 10 ** (-1 / 20) / peak : 0;
  const fade = Math.min(x.length, Math.round(0.002 * SR));
  for (let i = 0; i < x.length; i++) {
    const k = i - (x.length - fade);
    x[i] *= g * (k >= 0 ? (fade - 1 - k) / fade : 1);
  }
  return x;
}

function wav16(x) {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, make] of Object.entries(sounds)) {
  const file = join(OUT, `${name}.wav`);
  writeFileSync(file, wav16(finish(make())));
  console.log(`${name}.wav`);
}
