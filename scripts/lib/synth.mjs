// Synthesis helpers shared by the sample generators (scripts/make-starter-kit.mjs,
// scripts/make-kits.mjs). Everything here is deterministic: the only
// randomness is the seeded noise below, so a generator re-run writes
// byte-identical files (state/kits.test.ts pins the kits' hashes).
//
// Output format of every generator: 48 kHz, 16-bit, mono WAV.

export const SR = 48000;
export const TAU = Math.PI * 2;

/** Deterministic white noise in [-1, 1] (mulberry32). */
export function makeNoise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** RBJ-cookbook biquad ('lp' | 'hp' | 'bp', 0 dB peak). `set` may be called per sample for sweeps. */
export class Biquad {
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
export const env = (t, decay, attack = 0.0005) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

/** Band-limited sawtooth by additive synthesis (harmonics below Nyquist only). */
export function saw(phase, freq) {
  let s = 0;
  const n = Math.floor((SR * 0.45) / freq);
  for (let k = 1; k <= n; k++) s += Math.sin(phase * k) / k;
  return s * (2 / Math.PI);
}

export const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

/** Render `seconds` of audio from a per-sample function f(t, i). */
export function render(seconds, f) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = f(i / SR, i);
  return out;
}

/**
 * Normalise the peak to `peakDb` dBFS (default -1) and fade the last 2 ms to
 * silence, in place.
 */
export function finish(x, peakDb = -1) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 10 ** (peakDb / 20) / peak : 0;
  const fade = Math.min(x.length, Math.round(0.002 * SR));
  for (let i = 0; i < x.length; i++) {
    const k = i - (x.length - fade);
    x[i] *= g * (k >= 0 ? (fade - 1 - k) / fade : 1);
  }
  return x;
}

/** A 16-bit mono PCM WAV file of `x` (clipped to [-1, 1]). */
export function wav16(x) {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
