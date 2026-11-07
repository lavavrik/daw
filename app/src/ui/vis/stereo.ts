// The master's stereo picture (plan 12 Task 3; docs/architecture/visuals.md
// *Analyser*): phase correlation and the goniometer's points. Pure,
// DOM-free, allocation-free (the caller owns every array).
//
// - correlation(l, r): Σ l·r / √(Σ l² · Σ r²) over the frames given (the
//   analyser passes the newest CORR_FRAMES = 4800, 100 ms at 48 kHz):
//   +1 mono, 0 unrelated, −1 one side inverted. Silence (either side) reads
//   0, never NaN. Shown smoothed by smoothCorrelation, a one-pole filter
//   with a CORR_SMOOTH_S (300 ms) time constant.
// - goniometer(l, r, x, y): the mid/side rotation of the newest
//   GONIO_FRAMES = 2048 frames, x = (R − L)/√2 (side, right is +),
//   y = (L + R)/√2 (mid, up is +). Mono draws a vertical line, an
//   inverted side a horizontal one. It is drawn at a fixed scale where the
//   circle's radius is full scale: |(L, R)| ≤ √2 for samples within ±1, so
//   the view maps √2 to the radius and a full-scale mono (or inverted)
//   sine just touches the circle.

export const CORR_FRAMES = 4800;
export const GONIO_FRAMES = 2048;
export const CORR_SMOOTH_S = 0.3;

/** Below this energy (per side) a signal counts as silence: 0. */
const SILENT = 1e-12;

/** Phase correlation of l and r over [from, to) (default: all of them). */
export function correlation(l: ArrayLike<number>, r: ArrayLike<number>, from = 0, to = l.length): number {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = from; i < to; i++) {
    const a = l[i];
    const b = r[i];
    lr += a * b;
    ll += a * a;
    rr += b * b;
  }
  if (!(ll > SILENT && rr > SILENT)) return 0; // silence, or NaN in the input
  const c = lr / Math.sqrt(ll * rr);
  return c > 1 ? 1 : c < -1 ? -1 : c;
}

/** One step of the 300 ms smoothing: `prev` toward `r` over `dt` seconds. */
export function smoothCorrelation(prev: number, r: number, dt: number): number {
  const s = prev + (r - prev) * (1 - Math.exp(-dt / CORR_SMOOTH_S));
  return Number.isFinite(s) ? s : 0;
}

/**
 * Goniometer points of the newest GONIO_FRAMES of l / r (or fewer, if they
 * are shorter) into x / y; returns how many.
 */
export function goniometer(
  l: ArrayLike<number>,
  r: ArrayLike<number>,
  x: Float32Array,
  y: Float32Array,
): number {
  const n = Math.min(GONIO_FRAMES, l.length, r.length, x.length, y.length);
  const off = l.length - n;
  for (let i = 0; i < n; i++) {
    const a = l[off + i];
    const b = r[off + i];
    x[i] = (b - a) * Math.SQRT1_2;
    y[i] = (a + b) * Math.SQRT1_2;
  }
  return n;
}
