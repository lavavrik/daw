// Spectrum analysis for the mixer analyser and the top-bar spectrum (plan 12
// Task 3; docs/architecture/visuals.md *Analyser*). Pure, DOM-free; every
// buffer is allocated once per instance, so a 30 Hz analysis allocates
// nothing.
//
// - SpectrumAnalyser: SPEC_N (4096) mono frames → Hann window → RealFft →
//   dB per bin, corrected by the window's coherent gain, so a full-scale
//   sine centred on a bin reads 0 dB.
// - Bands: log-spaced bands from 20 Hz to 20 kHz (60 = 1/6 octave for the
//   panel, 20 = 1/2 octave for the top bar). The spectrum between two bins
//   is read from a parabola (in dB) through the taller of them and its
//   neighbours, which is near exact at a sine's peak (it undoes the Hann
//   window's scalloping, up to −1.4 dB halfway between bins). A band takes
//   the max of that curve over its span: for a band wider than a bin that
//   is the max of its bins, or a peak's parabola top when it lies in the
//   band (a sine whose nearest bin is just across the band's edge still
//   reads in its own band); a band narrower than a bin (the low end: a bin
//   is 11.7 Hz at 48 kHz) reads the curve interpolated across its span,
//   which for the narrowest bands is their centre, so the low end is a
//   smooth curve, not a staircase. A full-scale sine reads 0 ± 0.5 dB in its
//   band (measured ±0.32) from 30 Hz up at 44.1/48 kHz and from 45 Hz up at
//   96 kHz (a bin is 23 Hz there); below that the sine's mirror image near
//   0 Hz bends the lowest bins and a reading can be off by up to ~1.5 dB.
// - Ballistics: instant rise, fall FALL_DB_PER_S; peak-hold dots hold
//   HOLD_S, then fall PEAK_FALL_DB_PER_S. The display range is
//   DB_FLOOR..DB_TOP (−90..+6 dB); levels never go below the floor.
// - freqToX / xToFreq: the log10 axis, 20 Hz → 0, 20 kHz → 1.
import { noteName } from '../pianoroll/prMath';
import { RealFft } from './fft';

/** FFT points: the newest 4096 frames (85 ms at 48 kHz). */
export const SPEC_N = 4096;
/** Display range (dB). */
export const DB_FLOOR = -90;
export const DB_TOP = 6;
/** The axis ends (Hz). */
export const F_LO = 20;
export const F_HI = 20000;
/** Ballistics. */
export const FALL_DB_PER_S = 24;
export const HOLD_S = 1;
export const PEAK_FALL_DB_PER_S = 12;
/** Bin dB never go below this (log of 0), well under the display floor. */
const BIN_FLOOR = -160;
/** The Hann window's worst scalloping loss (a sine halfway between bins), dB. */
const SCALLOP_DB = 1.42;

const DECADES = Math.log10(F_HI / F_LO); // 3

/** 20 Hz → 0, 20 kHz → 1 on a log10 axis. */
export function freqToX(f: number): number {
  return Math.log10(f / F_LO) / DECADES;
}

/** The inverse of freqToX. */
export function xToFreq(x: number): number {
  return F_LO * 10 ** (x * DECADES);
}

/** y (0 = top) of `db` in a plot `h` tall, DB_TOP..DB_FLOOR, clamped. */
export function dbToY(db: number, h: number): number {
  const t = (DB_TOP - db) / (DB_TOP - DB_FLOOR);
  return Math.min(1, Math.max(0, t)) * h;
}

/** "55 Hz · A1 · −8.2 dB": the analyser's hover readout. */
export function hoverReadout(f: number, db: number): string {
  const hz = f < 1000 ? `${Math.round(f)} Hz` : f < 10000 ? `${(f / 1000).toFixed(2)} kHz` : `${(f / 1000).toFixed(1)} kHz`;
  const note = noteName(Math.round(69 + 12 * Math.log2(f / 440)));
  const level = db <= DB_FLOOR ? '−∞' : `${db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)}`;
  return `${hz} · ${note} · ${level} dB`;
}

/** SPEC_N mono frames → dB per bin (bins 0..SPEC_N/2, the same array every call). */
export class SpectrumAnalyser {
  readonly sampleRate: number;
  readonly binDb = new Float32Array(SPEC_N / 2 + 1);
  private readonly fft = new RealFft(SPEC_N);
  /** |X| of a full-scale bin-centred sine: n/2 · coherent gain. */
  private readonly full = (SPEC_N / 2) * this.fft.coherentGain;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  analyse(mono: ArrayLike<number>): Float32Array {
    const mag = this.fft.magnitudes(mono);
    const { binDb, full } = this;
    for (let k = 0; k < binDb.length; k++) {
      const a = mag[k] / full;
      binDb[k] = a > 1e-8 ? 20 * Math.log10(a) : BIN_FLOOR;
    }
    return binDb;
  }
}

/** Log-spaced bands, 20 Hz–20 kHz, read from SpectrumAnalyser bins. */
export class Bands {
  readonly count: number;
  /** Edges and geometric centres (Hz). */
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  readonly centre: Float64Array;
  /** The last measure(): dB per band (the same array every call). */
  readonly raw: Float32Array;
  /** The band's edges in bins (fractional). */
  private readonly xLo: Float64Array;
  private readonly xHi: Float64Array;

  constructor(count: number, sampleRate: number) {
    this.count = count;
    this.lo = new Float64Array(count);
    this.hi = new Float64Array(count);
    this.centre = new Float64Array(count);
    this.raw = new Float32Array(count).fill(DB_FLOOR);
    this.xLo = new Float64Array(count);
    this.xHi = new Float64Array(count);
    const binHz = sampleRate / SPEC_N;
    for (let i = 0; i < count; i++) {
      const lo = xToFreq(i / count);
      const hi = xToFreq((i + 1) / count);
      this.lo[i] = lo;
      this.hi[i] = hi;
      this.centre[i] = Math.sqrt(lo * hi);
      this.xLo[i] = lo / binHz;
      this.xHi[i] = hi / binHz;
    }
  }

  /** The band `f` falls in (clamped to the ends). */
  bandOf(f: number): number {
    return Math.min(this.count - 1, Math.max(0, Math.floor(freqToX(f) * this.count)));
  }

  /** dB per band from dB per bin (SpectrumAnalyser.binDb): the max of `curve` over each band. */
  measure(binDb: Float32Array): Float32Array {
    const { raw, xLo, xHi } = this;
    const top = binDb.length - 1;
    for (let i = 0; i < this.count; i++) {
      const x0 = xLo[i];
      const x1 = xHi[i];
      // The curve at the band's ends...
      let db = Math.max(curve(binDb, x0), curve(binDb, x1));
      const kEnd = Math.min(top - 1, Math.floor(x1));
      for (let k = Math.max(0, Math.floor(x0)); k <= kEnd; k++) {
        // ...at its bins (for a wide band, the max of its bins)...
        if (k > x0 && binDb[k] > db) db = binDb[k];
        // ...and a parabola's top inside this bin interval and the band.
        const j = pick(binDb, k);
        const a = binDb[j - 1];
        const b = binDb[j];
        const c = binDb[j + 1];
        const den = a - 2 * b + c;
        if (den < 0) {
          const v = j + (0.5 * (a - c)) / den;
          if (v >= Math.max(x0, k) && v <= Math.min(x1, k + 1)) db = Math.max(db, clampTop(parabola(a, b, c, v - j), a, b, c));
        }
      }
      raw[i] = db;
    }
    return raw;
  }
}

/** The parabola through (−1, a), (0, b), (1, c), at t. */
function parabola(a: number, b: number, c: number, t: number): number {
  return b + 0.5 * t * (c - a) + 0.5 * t * t * (a - 2 * b + c);
}

/** At most the Hann scalloping above the tallest of the three bins. */
function clampTop(v: number, a: number, b: number, c: number): number {
  return Math.min(v, Math.max(a, b, c) + SCALLOP_DB);
}

/**
 * The bin whose parabola draws the interval (k, k + 1): the taller of k and
 * k + 1 (kept off the array's ends). Both of them lie on that parabola, so
 * the curve is continuous at every bin; and next to a peak it is the peak
 * bin's parabola, the one that models the window's main lobe (a parabola
 * through a sidelobe null would invent a peak).
 */
function pick(binDb: Float32Array, k: number): number {
  const j = binDb[k + 1] > binDb[k] ? k + 1 : k;
  return Math.min(binDb.length - 2, Math.max(1, j));
}

/** The interpolated spectrum at `x` bins (dB). */
function curve(binDb: Float32Array, x: number): number {
  const k = Math.min(binDb.length - 2, Math.max(0, Math.floor(x)));
  const j = pick(binDb, k);
  const a = binDb[j - 1];
  const b = binDb[j];
  const c = binDb[j + 1];
  return clampTop(parabola(a, b, c, x - j), a, b, c);
}

/** Analyser ballistics per band: instant rise, a falling level and peak-hold dots. */
export class Ballistics {
  readonly level: Float32Array;
  readonly peak: Float32Array;
  /** Seconds since each peak was set. */
  private readonly age: Float64Array;

  constructor(count: number) {
    this.level = new Float32Array(count).fill(DB_FLOOR);
    this.peak = new Float32Array(count).fill(DB_FLOOR);
    this.age = new Float64Array(count);
  }

  /** Advance by `dt` seconds with the new raw band levels (dB). */
  step(raw: ArrayLike<number>, dt: number): void {
    const { level, peak, age } = this;
    for (let i = 0; i < level.length; i++) {
      const l = Math.max(raw[i], level[i] - FALL_DB_PER_S * dt, DB_FLOOR);
      level[i] = l;
      if (l >= peak[i]) {
        peak[i] = l;
        age[i] = 0;
        continue;
      }
      age[i] += dt;
      const over = age[i] - HOLD_S;
      if (over > 0) peak[i] = Math.max(l, peak[i] - PEAK_FALL_DB_PER_S * Math.min(dt, over));
    }
  }

  /** Back to silence (a new source: no history carried over). */
  reset(): void {
    this.level.fill(DB_FLOOR);
    this.peak.fill(DB_FLOOR);
    this.age.fill(0);
  }
}
