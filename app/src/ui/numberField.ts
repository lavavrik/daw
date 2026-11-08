// Pure maths for NumberField.svelte: stepping, clamping and the vertical
// scrub. No DOM, so it is unit-tested alone (numberField.test.ts).

/** Pixels of vertical travel before a press on the value becomes a scrub (below it, a click focuses the input). */
export const SCRUB_THRESHOLD_PX = 3;
/** Pixels of vertical travel per step once scrubbing. */
export const SCRUB_PX_PER_STEP = 4;
/** Shift divides the step by this much. */
export const FINE_DIVISOR = 10;

/** Round to `decimals` places (kills 0.1 + 0.2 style noise). */
export function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** The number of decimals `step` itself needs (0.25 -> 2, 1 -> 0). */
export function decimalsOf(step: number): number {
  let d = 0;
  while (d < 6 && Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) > 1e-9) d++;
  return d;
}

export interface Bounds {
  min?: number;
  max?: number;
  decimals: number;
}

/** Clamp into [min, max] (either may be absent), then round to `decimals`. */
export function clampValue(v: number, b: Bounds): number {
  let x = v;
  if (b.min !== undefined && x < b.min) x = b.min;
  if (b.max !== undefined && x > b.max) x = b.max;
  return roundTo(x, b.decimals);
}

/** The value as text: rounded to `decimals`, no trailing zeros ("0.5", "12"). */
export function formatValue(v: number, decimals: number): string {
  return String(roundTo(v, decimals));
}

/** One arrow-key / button / wheel step: `dir` is +1 or -1; `fine` divides the step by 10. */
export function stepValue(v: number, dir: 1 | -1, step: number, fine: boolean, b: Bounds): number {
  return clampValue(v + dir * (fine ? step / FINE_DIVISOR : step), b);
}

/** Has the pointer travelled far enough from the press to start a scrub? */
export function scrubStarted(dyPx: number): boolean {
  return Math.abs(dyPx) >= SCRUB_THRESHOLD_PX;
}

/**
 * The scrubbed value: `startValue` moved by whole steps of travel from the
 * press (up = bigger; `dyPx` is clientY - startY, so negative is up).
 * The raw sum is clamped and rounded once, so a fine scrub on an integer
 * field still moves, one unit every 40 px.
 */
export function scrubValue(startValue: number, dyPx: number, step: number, fine: boolean, b: Bounds): number {
  const steps = Math.trunc(-dyPx / SCRUB_PX_PER_STEP);
  return clampValue(startValue + steps * (fine ? step / FINE_DIVISOR : step), b);
}
