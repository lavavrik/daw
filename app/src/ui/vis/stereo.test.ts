import { describe, expect, it } from 'vitest';
import { CORR_FRAMES, CORR_HOLD_S, CorrelationMeter, GONIO_FRAMES, corrFrames, correlation, goniometer, gonioFrames } from './stereo';

const sine = (n: number, f = 0.013) => Float32Array.from({ length: n }, (_, i) => 0.8 * Math.sin(2 * Math.PI * f * i));
const x = new Float32Array(GONIO_FRAMES);
const y = new Float32Array(GONIO_FRAMES);

/** Deterministic noise in [-1, 1). */
function noise(n: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s / 2 ** 31 - 1;
  }
  return out;
}

describe('stereo', () => {
  it('mono is +1 and vertical', () => {
    const l = sine(CORR_FRAMES);
    expect(correlation(l, l)).toBeCloseTo(1, 9);
    const n = goniometer(l, l, x, y);
    expect(n).toBe(GONIO_FRAMES);
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < n; i++) {
      maxX = Math.max(maxX, Math.abs(x[i]));
      maxY = Math.max(maxY, Math.abs(y[i]));
    }
    expect(maxX).toBe(0);
    // x = (R − L)/√2, y = (L + R)/√2: a 0.8 mono sine reaches 0.8·√2.
    expect(maxY).toBeCloseTo(0.8 * Math.SQRT2, 2);
  });

  it('inverted is −1 and horizontal', () => {
    const l = sine(CORR_FRAMES);
    const r = l.map((v) => -v);
    expect(correlation(l, r)).toBeCloseTo(-1, 9);
    const n = goniometer(l, r, x, y);
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < n; i++) {
      maxX = Math.max(maxX, Math.abs(x[i]));
      maxY = Math.max(maxY, Math.abs(y[i]));
    }
    expect(maxY).toBe(0);
    expect(maxX).toBeCloseTo(0.8 * Math.SQRT2, 2);
  });

  it('independent noise is near 0', () => {
    const r = correlation(noise(CORR_FRAMES, 1), noise(CORR_FRAMES, 99));
    expect(r).not.toBeNull();
    expect(Math.abs(r ?? 1)).toBeLessThan(0.1);
  });

  it('silence reads 0 without NaN', () => {
    const z = new Float32Array(CORR_FRAMES);
    // Below the gate there is no correlation to read...
    expect(correlation(z, z)).toBeNull();
    // ...and one silent side correlates with nothing.
    expect(correlation(sine(CORR_FRAMES), z)).toBe(0);
    const m = new CorrelationMeter();
    for (let i = 0; i < 90; i++) m.step(z, z, 0, z.length, 1 / 30);
    expect(m.value).toBe(0);
    const nan = Float32Array.of(NaN, 1, 2);
    m.step(nan, nan, 0, 3, 1 / 30);
    expect(Number.isNaN(m.value)).toBe(false);
    const n = goniometer(z, z, x, y);
    for (let i = 0; i < n; i++) expect(Number.isNaN(x[i]) || Number.isNaN(y[i])).toBe(false);
  });

  it('smoothing settles over about 300 ms', () => {
    const l = sine(CORR_FRAMES);
    const inv = l.map((v) => -v);
    const m = new CorrelationMeter();
    for (let i = 0; i < 60; i++) m.step(l, inv, 0, l.length, 1 / 30);
    expect(m.value).toBeCloseTo(-1, 3);
    // Mono from now on: the smoothed sums move with a 300 ms time constant,
    // so the ratio is 1 − 2e^(−t/0.3).
    let t = 0;
    for (; t < 0.3 - 1e-9; t += 1 / 30) m.step(l, l, 0, l.length, 1 / 30);
    expect(m.value).toBeCloseTo(1 - 2 * Math.exp(-1), 2);
    for (; t < 2.3; t += 1 / 30) m.step(l, l, 0, l.length, 1 / 30);
    expect(m.value).toBeGreaterThan(0.99);
  });

  it('silence holds the last value, then eases to 0 after 2 s', () => {
    const l = sine(CORR_FRAMES);
    const z = new Float32Array(CORR_FRAMES);
    const m = new CorrelationMeter();
    for (let i = 0; i < 30; i++) m.step(l, l, 0, l.length, 1 / 30);
    expect(m.value).toBeCloseTo(1, 6);
    // Silence: the smoothed level sinks under the gate; until then, and for
    // 2 s after, the reading holds.
    let steps = 0;
    while (!m.gated) {
      m.step(z, z, 0, z.length, 1 / 30);
      expect(m.value).toBeCloseTo(1, 6);
      expect(++steps).toBeLessThan(30 * 10);
    }
    for (let t = 1 / 30; t < CORR_HOLD_S - 0.05; t += 1 / 30) m.step(z, z, 0, z.length, 1 / 30);
    expect(m.value).toBeCloseTo(1, 6);
    // Then it eases to 0 (300 ms time constant).
    for (let t = 0; t < 2; t += 1 / 30) m.step(z, z, 0, z.length, 1 / 30);
    expect(Math.abs(m.value)).toBeLessThan(0.01);
  });

  it('a sparse mono click (5 ms hit every 500 ms) reads > 0.95', () => {
    const SR = 48000;
    // A 4 s stream: a 5 ms decaying burst every 500 ms, the same on both sides.
    const len = 4 * SR;
    const s = new Float32Array(len);
    for (let at = 0; at < len; at += SR / 2) {
      for (let i = 0; i < 0.005 * SR; i++) s[at + i] = 0.5 * Math.sin(i * 0.37) * Math.exp(-i / 60);
    }
    const m = new CorrelationMeter();
    const hop = SR / 30;
    for (let k = 1, end = CORR_FRAMES; end <= len; k++, end = CORR_FRAMES + Math.round(k * hop)) {
      m.step(s, s, end - CORR_FRAMES, end, 1 / 30);
      if (end > SR) expect(m.value, `at ${(end / SR).toFixed(2)} s`).toBeGreaterThan(0.95);
    }
  });

  it('windows follow the sample rate, within the readable ring', () => {
    expect(corrFrames(48000)).toBe(CORR_FRAMES);
    expect(corrFrames(44100)).toBe(4410);
    expect(gonioFrames(48000)).toBe(GONIO_FRAMES);
    expect(gonioFrames(96000)).toBe(4096);
    // 100 ms at 96 / 192 kHz is more than the ring can give (8192 − 256).
    expect(corrFrames(96000)).toBe(7936);
    expect(gonioFrames(192000)).toBe(7936);
  });
});
