// Pure maths for NumberField.svelte: stepping, clamping and the vertical
// scrub. No DOM, so it is unit-tested alone (numberField.test.ts).

/** Pixels of vertical travel before a press on the value becomes a scrub (below it, a click focuses the input). */
export const SCRUB_THRESHOLD_PX = 3;
/**
 * The same once the field already has focus: a press there is usually the
 * start of a text selection, which wobbles a few px vertically.
 */
export const SCRUB_FOCUSED_THRESHOLD_PX = 6;
/** Sideways travel that makes a press in a focused field a text selection (no scrub for this press). */
export const SELECT_THRESHOLD_PX = 3;
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

/**
 * The fine (Shift) step: step / 10, but at least the smallest unit the
 * field keeps (10^-decimals), so Shift+arrow on an integer field moves by 1
 * instead of rounding back to where it was.
 */
export function fineStep(step: number, decimals: number): number {
  return Math.max(step / FINE_DIVISOR, 10 ** -decimals);
}

/** One arrow-key / button / wheel step: `dir` is +1 or -1; `fine` is fineStep. */
export function stepValue(v: number, dir: 1 | -1, step: number, fine: boolean, b: Bounds): number {
  return clampValue(v + dir * (fine ? fineStep(step, b.decimals) : step), b);
}

/**
 * What a press on the value has become after travelling (dx, dy) px:
 * - 'scrub': enough vertical travel (3 px; 6 px when the field already had
 *   focus, where a press usually starts a text selection);
 * - 'select': the field had focus and the pointer went sideways first: a
 *   text selection, so this press never scrubs;
 * - 'wait': neither yet.
 */
export function pressIntent(dxPx: number, dyPx: number, focused: boolean): 'wait' | 'scrub' | 'select' {
  const dx = Math.abs(dxPx);
  const dy = Math.abs(dyPx);
  if (focused && dx >= SELECT_THRESHOLD_PX && dx >= dy) return 'select';
  return dy >= (focused ? SCRUB_FOCUSED_THRESHOLD_PX : SCRUB_THRESHOLD_PX) ? 'scrub' : 'wait';
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
