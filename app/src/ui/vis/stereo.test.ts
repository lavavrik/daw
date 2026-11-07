import { describe, expect, it } from 'vitest';
import { CORR_FRAMES, GONIO_FRAMES, correlation, goniometer, smoothCorrelation } from './stereo';

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
    expect(Math.abs(r)).toBeLessThan(0.1);
  });

  it('silence reads 0 without NaN', () => {
    const z = new Float32Array(CORR_FRAMES);
    expect(correlation(z, z)).toBe(0);
    // One silent side: no correlation either.
    expect(correlation(sine(CORR_FRAMES), z)).toBe(0);
    let s = 0;
    for (let i = 0; i < 30; i++) s = smoothCorrelation(s, correlation(z, z), 1 / 30);
    expect(s).toBe(0);
    const n = goniometer(z, z, x, y);
    for (let i = 0; i < n; i++) expect(Number.isNaN(x[i]) || Number.isNaN(y[i])).toBe(false);
  });

  it('smoothing settles over about 300 ms', () => {
    let s = 0;
    for (let t = 0; t < 0.3 - 1e-9; t += 1 / 30) s = smoothCorrelation(s, 1, 1 / 30);
    // One time constant: 1 − 1/e of the way.
    expect(s).toBeCloseTo(1 - Math.exp(-1), 2);
    for (let t = 0; t < 2; t += 1 / 30) s = smoothCorrelation(s, 1, 1 / 30);
    expect(s).toBeGreaterThan(0.99);
  });
});
