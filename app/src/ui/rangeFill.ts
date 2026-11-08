// The fill of a skinned native range (theme.css "range"): the values for its
// `--fill` (the fill layer's width) and `--fill-pos` (its background-position)
// custom properties, so the fill's ends sit under the handle's centre.
//
// Why it is not just `--fill: <pct>%`: Chrome moves the thumb's centre from
// h/2 to W − h/2 (h = the handle's width, W = the groove's), so at value
// fraction f the centre is at h/2 + f·(W − h), not f·W. A plain percentage
// would end up to h/2 px off the centre (hidden under the handle, but a
// sliver shows past the round handle's edge). CSS can't multiply a length by
// a percentage, so the component computes the calc() here and passes it in.
//
// Each edge is `a·W + b` px. A fill that starts at 0 begins at the groove's
// left end (not under the handle's centre), and one that ends at 1 runs to
// the right end, so the rounded ends of the groove stay filled.
//
// background-position, unlike size, is a percentage of the room left beside
// the layer (W − size), so the position is solved for that:
//   left = p·(W − size) + y   with   p = a_left / (1 − a_size),  y = b_left + p·b_size.

/** The range handle's width in px: theme.css `::-webkit-slider-thumb` (keep in step). */
export const RANGE_HANDLE_PX = 15;

export interface RangeFillVars {
  /** For `style:--fill`: the fill layer's width, `calc(<a>% + <b>px)`. */
  fill: string;
  /** For `style:--fill-pos`: the layer's background-position. */
  pos: string;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const num = (x: number) => String(Math.round(x * 1e4) / 1e4);
const calc = (pct: number, px: number) => `calc(${num(pct)}% + ${num(px)}px)`;

/**
 * A fill between two value fractions (0..1, either order). `handle` is the
 * thumb's width when a component restyles it (TrackVol's 10 px thumb).
 */
export function rangeFillSpan(a: number, b: number, handle = RANGE_HANDLE_PX): RangeFillVars {
  const from = clamp01(Math.min(a, b));
  const to = clamp01(Math.max(a, b));
  if (to <= from) return { fill: calc(0, 0), pos: calc(0, 0) }; // nothing to fill
  const h = handle;
  // edge = k·W + c (px)
  const [lk, lc] = from <= 0 ? [0, 0] : [from, h / 2 - from * h];
  const [rk, rc] = to >= 1 ? [1, 0] : [to, h / 2 - to * h];
  const sk = rk - lk;
  const sc = rc - lc;
  const p = sk >= 1 ? 0 : lk / (1 - sk);
  return { fill: calc(sk * 100, sc), pos: calc(p * 100, lc + p * sc) };
}

/** A fill from the left end to value fraction `f` (0..1). */
export const rangeFill = (f: number, handle = RANGE_HANDLE_PX): RangeFillVars => rangeFillSpan(0, f, handle);

/** A bipolar fill (pan, gains): from the centre to value fraction `f` (0..1). */
export const rangeFillBipolar = (f: number, handle = RANGE_HANDLE_PX): RangeFillVars => rangeFillSpan(0.5, f, handle);
