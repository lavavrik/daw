import { describe, expect, it } from 'vitest';
import { RealFft } from './fft';

/** Deterministic pseudo-random input (xorshift), in [-1, 1). */
function noise(n: number, seed = 12345): Float64Array {
  const x = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    x[i] = s / 2 ** 31 - 1;
  }
  return x;
}

describe('RealFft', () => {
  it('matches a naive DFT', () => {
    const n = 4096;
    const fft = new RealFft(n);
    const x = noise(n);
    fft.forward(x);
    // 16 bins spread over the spectrum, the ends included.
    const bins = [0, 1, 2, 3, 7, 64, 255, 511, 1000, 1023, 1024, 1500, 2000, 2047, 2048 - 5, 2048];
    for (const k of bins) {
      let re = 0;
      let im = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        re += x[t] * Math.cos(a);
        im += x[t] * Math.sin(a);
      }
      const err = Math.hypot(fft.re[k] - re, fft.im[k] - im);
      expect(err / Math.max(1e-9, Math.hypot(re, im)), `bin ${k}`).toBeLessThan(1e-4);
    }
  });

  it('reuses its buffers', () => {
    const fft = new RealFft(4096);
    const re = fft.re;
    const im = fft.im;
    const a = fft.magnitudes(noise(4096, 1));
    const b = fft.magnitudes(noise(4096, 2));
    expect(b).toBe(a);
    fft.forward(noise(4096, 3));
    expect(fft.re).toBe(re);
    expect(fft.im).toBe(im);
    expect(a.length).toBe(4096 / 2 + 1);
  });
});
