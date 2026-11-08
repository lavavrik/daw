import { describe, expect, it } from 'vitest';
import { RANGE_HANDLE_PX, rangeFill, rangeFillBipolar, rangeFillSpan } from './rangeFill';

/**
 * Evaluate one of rangeFill's `calc(<a>% + <b>px)` strings the way CSS does
 * for a background layer: `size` against the groove width `w`, `pos` against
 * the room left beside the layer (w − size).
 */
function calc(s: string, basis: number): number {
  const m = /^calc\((-?[\d.e-]+)% \+ (-?[\d.e-]+)px\)$/.exec(s);
  if (!m) throw new Error(`not a calc(%+px): ${s}`);
  return (Number(m[1]) / 100) * basis + Number(m[2]);
}
/** The fill's [left, right] edges in px on a groove `w` px wide. */
function edges(v: { fill: string; pos: string }, w: number): [number, number] {
  const size = calc(v.fill, w);
  const left = calc(v.pos, w - size);
  return [left, left + size];
}
/** Where the handle's centre sits at travel fraction `f` (Chrome's thumb travel). */
const centre = (f: number, w: number) => RANGE_HANDLE_PX / 2 + f * (w - RANGE_HANDLE_PX);

// toBeCloseTo(_, 2) = within 0.005 px: the calc() numbers are rounded to 4 places.
describe('rangeFill', () => {
  const widths = [60, 104, 180, 333];

  it('a left fill runs from the groove start to the handle centre', () => {
    for (const w of widths) {
      for (const f of [0.01, 0.25, 0.5, 0.8, 0.99]) {
        const [l, r] = edges(rangeFill(f), w);
        expect(l).toBeCloseTo(0, 2);
        expect(r).toBeCloseTo(centre(f, w), 2);
      }
    }
  });

  it('empty at 0 and full at 1 (the ends sit under the handle)', () => {
    for (const w of widths) {
      expect(edges(rangeFill(0), w)).toEqual([0, 0]);
      const [l, r] = edges(rangeFill(1), w);
      expect(l).toBeCloseTo(0, 2);
      expect(r).toBeCloseTo(w, 2);
    }
  });

  it('clamps out-of-range fractions', () => {
    expect(rangeFill(-1)).toEqual(rangeFill(0));
    expect(rangeFill(2)).toEqual(rangeFill(1));
    expect(rangeFill(NaN)).toEqual(rangeFill(0));
  });

  it('a bipolar fill runs from the centre to the handle centre, either side', () => {
    for (const w of widths) {
      for (const f of [0.1, 0.3, 0.7, 0.9]) {
        const [l, r] = edges(rangeFillBipolar(f), w);
        expect(l).toBeCloseTo(Math.min(centre(0.5, w), centre(f, w)), 2);
        expect(r).toBeCloseTo(Math.max(centre(0.5, w), centre(f, w)), 2);
      }
      expect(edges(rangeFillBipolar(0.5), w)).toEqual([0, 0]); // centred: nothing
      // the extremes reach the groove's ends
      expect(edges(rangeFillBipolar(0), w)[0]).toBeCloseTo(0, 2);
      expect(edges(rangeFillBipolar(1), w)[1]).toBeCloseTo(w, 2);
    }
  });

  it('a span of any two fractions lands under the handle centres', () => {
    const w = 200;
    const [l, r] = edges(rangeFillSpan(0.2, 0.6), w);
    expect(l).toBeCloseTo(centre(0.2, w), 2);
    expect(r).toBeCloseTo(centre(0.6, w), 2);
    // reversed arguments are the same span
    expect(rangeFillSpan(0.6, 0.2)).toEqual(rangeFillSpan(0.2, 0.6));
  });

  it('takes a restyled thumb width (TrackVol: 10 px)', () => {
    const w = 120;
    const [, r] = edges(rangeFill(0.3, 10), w);
    expect(r).toBeCloseTo(5 + 0.3 * (w - 10), 2);
  });
});
