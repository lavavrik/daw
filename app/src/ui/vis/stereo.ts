// The master's stereo picture (plan 12 Task 3; docs/architecture/visuals.md
// *Analyser*): phase correlation and the goniometer's points. Pure,
// DOM-free, allocation-free (the caller owns every array).
//
// - correlation(l, r): Σ l·r / √(Σ l² · Σ r²) over one window (the
//   analyser passes the newest corrFrames(rate) = 100 ms): +1 mono, 0
//   unrelated, −1 one side inverted; null when the window is below the gate
//   (−60 dBFS RMS: nothing to correlate), 0 when one side alone is silent.
// - CorrelationMeter: what the bar shows. Each window's mean sums (Σlr/n,
//   Σl²/n, Σr²/n) go through a one-pole with a CORR_SMOOTH_S (300 ms) time
//   constant and the meter reads the ratio of the SMOOTHED sums, so sparse
//   material (a click every half second, a kick between gaps) reads its
//   true correlation instead of being pulled to 0 by the silent windows in
//   between. Below the gate (smoothed RMS under −60 dBFS) it HOLDS the last
//   reading; after CORR_HOLD_S (2 s) of sustained gating it eases to 0 with
//   the same 300 ms constant. It starts at 0 and never reads NaN.
// - goniometer(l, r, x, y, n): the mid/side rotation of the newest n frames
//   (gonioFrames(rate): 2048 at 48 kHz, ~43 ms), x = (R − L)/√2 (side,
//   right is +), y = (L + R)/√2 (mid, up is +). Mono draws a vertical line,
//   an inverted side a horizontal one. It is drawn at a fixed scale where
//   the circle's radius is full scale: |(L, R)| ≤ √2 for samples within ±1,
//   so the view maps √2 to the radius and a full-scale mono (or inverted)
//   sine just touches the circle.
//
// Window lengths follow the sample rate but never exceed what a vis ring can
// give (VIS_TAP_RING − VIS_GUARD = 7936 frames: at 96 kHz the correlation
// window is 83 ms, at 192 kHz 41 ms).
import { VIS_GUARD } from '../../audio/visLayout';
import { VIS_TAP_RING } from '../../audio/protocol';

/** The correlation window (s) and its 48 kHz frame count. */
export const CORR_WINDOW_S = 0.1;
export const CORR_FRAMES = 4800;
/** Goniometer points at 48 kHz (the same time span at other rates). */
export const GONIO_FRAMES = 2048;
/** The most frames a ring read can return (and the most any window takes). */
export const MAX_STEREO_FRAMES = VIS_TAP_RING - VIS_GUARD;
export const CORR_SMOOTH_S = 0.3;
/** Below this smoothed RMS (−60 dBFS) the meter holds. */
export const CORR_GATE = 1e-3;
/** Held this long below the gate before easing to 0 (s). */
export const CORR_HOLD_S = 2;

/** Correlation window at `rate` (frames). */
export function corrFrames(rate: number): number {
  return Math.min(MAX_STEREO_FRAMES, Math.round(CORR_WINDOW_S * rate));
}

/** Goniometer points at `rate`. */
export function gonioFrames(rate: number): number {
  return Math.min(MAX_STEREO_FRAMES, Math.round((GONIO_FRAMES * rate) / 48000));
}

/** Phase correlation of l and r over [from, to); null below the gate. */
export function correlation(l: ArrayLike<number>, r: ArrayLike<number>, from = 0, to = l.length): number | null {
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
  const n = Math.max(1, to - from);
  if (!((ll + rr) / (2 * n) >= CORR_GATE * CORR_GATE)) return null; // silence, or NaN in the input
  return ratio(lr, ll, rr);
}

/** lr / √(ll·rr), clamped; 0 when one side is silent. */
function ratio(lr: number, ll: number, rr: number): number {
  const d = ll * rr;
  if (!(d > 1e-30)) return 0;
  const c = lr / Math.sqrt(d);
  return c > 1 ? 1 : c < -1 ? -1 : c;
}

/** The correlation bar's reading (see above). */
export class CorrelationMeter {
  /** What the bar shows, −1..+1. */
  value = 0;
  /** Below the gate now. */
  gated = true;
  private lr = 0;
  private ll = 0;
  private rr = 0;
  /** Seconds below the gate. */
  private gatedFor = 0;

  /** One window [from, to) of l / r, `dt` seconds after the last. */
  step(l: ArrayLike<number>, r: ArrayLike<number>, from: number, to: number, dt: number): void {
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
    const n = Math.max(1, to - from);
    const k = 1 - Math.exp(-dt / CORR_SMOOTH_S);
    // A window with NaN / infinity in it is skipped (the sums stay finite).
    if (Number.isFinite(lr + ll + rr)) {
      this.lr += (lr / n - this.lr) * k;
      this.ll += (ll / n - this.ll) * k;
      this.rr += (rr / n - this.rr) * k;
    }
    this.gated = !((this.ll + this.rr) / 2 >= CORR_GATE * CORR_GATE);
    if (!this.gated) {
      this.gatedFor = 0;
      this.value = ratio(this.lr, this.ll, this.rr);
    } else {
      this.gatedFor += dt;
      if (this.gatedFor > CORR_HOLD_S) this.value -= this.value * k;
    }
  }

  reset(): void {
    this.value = this.lr = this.ll = this.rr = this.gatedFor = 0;
    this.gated = true;
  }
}

/**
 * Goniometer points of the newest `n` frames of l / r before `to` (default:
 * GONIO_FRAMES before the end) into x / y; returns how many.
 */
export function goniometer(
  l: ArrayLike<number>,
  r: ArrayLike<number>,
  x: Float32Array,
  y: Float32Array,
  n = GONIO_FRAMES,
  to = Math.min(l.length, r.length),
): number {
  const m = Math.min(n, to, x.length, y.length);
  const off = to - m;
  for (let i = 0; i < m; i++) {
    const a = l[off + i];
    const b = r[off + i];
    x[i] = (b - a) * Math.SQRT1_2;
    y[i] = (a + b) * Math.SQRT1_2;
  }
  return m;
}
