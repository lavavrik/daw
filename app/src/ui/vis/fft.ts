// An in-place radix-2 real FFT for the analysers (plan 12 Task 3;
// docs/architecture/visuals.md *Analyser*). Hand-written, no dependency.
//
// A real N-point transform runs as one complex N/2-point FFT: the input is
// packed as z[m] = x[2m] + i·x[2m+1], transformed in place (iterative
// radix-2, bit-reversal table and twiddles precomputed), then split into the
// spectrum of x:
//
//   E[k] = (Z[k] + conj Z[M−k]) / 2,  O[k] = (Z[k] − conj Z[M−k]) / 2i,
//   X[k] = E[k] + e^(−2πik/N) · O[k],  k = 0..M  (M = N/2, Z[M] = Z[0]).
//
// Every buffer (packing, twiddles, window, output) is allocated once per
// instance; forward() / magnitudes() allocate nothing, so the analysers can
// run them 30 times a second without garbage.

export class RealFft {
  /** Points (a power of two ≥ 4). */
  readonly n: number;
  /** Real and imaginary parts of the last forward(): bins 0..n/2. */
  readonly re: Float64Array;
  readonly im: Float64Array;
  /** The periodic Hann window magnitudes() applies (w[i] = sin²(πi/n)). */
  readonly window: Float64Array;
  /** Sum of the window / n (the coherent gain: 0.5 for Hann). */
  readonly coherentGain: number;
  private readonly m: number;
  /** Packed complex input / in-place work buffer (M points). */
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;
  private readonly rev: Uint32Array;
  /** e^(−2πik/M), k < M/2: the complex FFT's twiddles. */
  private readonly cosM: Float64Array;
  private readonly sinM: Float64Array;
  /** e^(−2πik/N), k ≤ M: the real split's twiddles. */
  private readonly cosN: Float64Array;
  private readonly sinN: Float64Array;
  private readonly windowed: Float64Array;
  private readonly mag: Float64Array;

  constructor(n = 4096) {
    if (n < 4 || (n & (n - 1)) !== 0) throw new Error(`RealFft: ${n} is not a power of two ≥ 4`);
    this.n = n;
    const m = (this.m = n >> 1);
    this.re = new Float64Array(m + 1);
    this.im = new Float64Array(m + 1);
    this.mag = new Float64Array(m + 1);
    this.zr = new Float64Array(m);
    this.zi = new Float64Array(m);
    this.windowed = new Float64Array(n);
    this.window = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.sin((Math.PI * i) / n);
      this.window[i] = s * s;
      sum += s * s;
    }
    this.coherentGain = sum / n;
    const bits = Math.log2(m);
    this.rev = new Uint32Array(m);
    for (let i = 0; i < m; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cosM = new Float64Array(m >> 1);
    this.sinM = new Float64Array(m >> 1);
    for (let k = 0; k < m >> 1; k++) {
      this.cosM[k] = Math.cos((2 * Math.PI * k) / m);
      this.sinM[k] = -Math.sin((2 * Math.PI * k) / m);
    }
    this.cosN = new Float64Array(m + 1);
    this.sinN = new Float64Array(m + 1);
    for (let k = 0; k <= m; k++) {
      this.cosN[k] = Math.cos((2 * Math.PI * k) / n);
      this.sinN[k] = -Math.sin((2 * Math.PI * k) / n);
    }
  }

  /** The DFT of `x` (n samples, no window) into `re` / `im`, bins 0..n/2. */
  forward(x: ArrayLike<number>): void {
    const { m, zr, zi, rev } = this;
    // Pack pairs, in bit-reversed order (the in-place butterflies want it).
    for (let i = 0; i < m; i++) {
      const j = rev[i];
      zr[j] = x[2 * i];
      zi[j] = x[2 * i + 1];
    }
    // Iterative radix-2 butterflies.
    for (let size = 2; size <= m; size <<= 1) {
      const half = size >> 1;
      const step = m / size;
      for (let start = 0; start < m; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cosM[k * step];
          const wi = this.sinM[k * step];
          const a = start + k;
          const b = a + half;
          const tr = zr[b] * wr - zi[b] * wi;
          const ti = zr[b] * wi + zi[b] * wr;
          zr[b] = zr[a] - tr;
          zi[b] = zi[a] - ti;
          zr[a] += tr;
          zi[a] += ti;
        }
      }
    }
    // Split into the real input's spectrum.
    const { re, im, cosN, sinN } = this;
    for (let k = 0; k <= m; k++) {
      const k1 = k === m ? 0 : k;
      const k2 = k === 0 ? 0 : m - k;
      const ar = zr[k1];
      const ai = zi[k1];
      const br = zr[k2];
      const bi = -zi[k2]; // conj Z[M−k]
      const er = (ar + br) / 2;
      const ei = (ai + bi) / 2;
      // O = (Z[k] − conj Z[M−k]) / 2i  →  (dr + i·di) / 2i = (di − i·dr) / 2
      const dr = ar - br;
      const di = ai - bi;
      const or = di / 2;
      const oi = -dr / 2;
      const wr = cosN[k];
      const wi = sinN[k];
      re[k] = er + or * wr - oi * wi;
      im[k] = ei + or * wi + oi * wr;
    }
  }

  /**
   * |X[k]| of the Hann-windowed `x`, bins 0..n/2 (unnormalised: a sine of
   * amplitude A centred on a bin reads A · n/2 · coherentGain). The same
   * array every call.
   */
  magnitudes(x: ArrayLike<number>): Float64Array {
    const { n, windowed, window, mag, re, im } = this;
    for (let i = 0; i < n; i++) windowed[i] = x[i] * window[i];
    this.forward(windowed);
    for (let k = 0; k < mag.length; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    return mag;
  }
}
