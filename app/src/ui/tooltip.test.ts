import { describe, expect, it } from 'vitest';
import { createTipTiming, placeTip, TIP_GAP, TIP_MARGIN } from './tooltip';

const vp = { width: 1000, height: 800 };
const tip = { width: 100, height: 30 };

describe('placeTip', () => {
  it('sits below the element, centred', () => {
    const p = placeTip({ left: 400, top: 100, width: 40, height: 20 }, tip, vp);
    expect(p).toEqual({ x: 370, y: 100 + 20 + TIP_GAP, side: 'below' });
  });
  it('flips above near the bottom edge', () => {
    const p = placeTip({ left: 400, top: 770, width: 40, height: 20 }, tip, vp);
    expect(p.side).toBe('above');
    expect(p.y).toBe(770 - TIP_GAP - 30);
  });
  it('clamps horizontally at both edges', () => {
    expect(placeTip({ left: 0, top: 100, width: 10, height: 10 }, tip, vp).x).toBe(TIP_MARGIN);
    expect(placeTip({ left: 995, top: 100, width: 5, height: 10 }, tip, vp).x).toBe(1000 - TIP_MARGIN - 100);
  });
  it('stays on screen when neither side fits', () => {
    const p = placeTip({ left: 10, top: 5, width: 10, height: 40 }, { width: 50, height: 90 }, { width: 200, height: 100 });
    expect(p.y).toBeGreaterThanOrEqual(TIP_MARGIN);
    expect(p.y + 90).toBeLessThanOrEqual(100 - TIP_MARGIN);
  });
});

describe('tip timing', () => {
  it('waits 250 ms for the first tip', () => {
    const t = createTipTiming();
    expect(t.delayFor(1000)).toBe(250);
  });
  it('is instant while a tip is showing', () => {
    const t = createTipTiming();
    t.shown();
    expect(t.delayFor(5000)).toBe(0);
  });
  it('is instant within 600 ms of a hide, then back to 250 ms', () => {
    const t = createTipTiming();
    t.shown();
    t.hidden(1000);
    expect(t.delayFor(1500)).toBe(0);
    expect(t.delayFor(1601)).toBe(250);
  });
  it('a tip that never showed does not open the quick window', () => {
    const t = createTipTiming();
    t.hidden(1000);
    expect(t.delayFor(1100)).toBe(250);
  });
});
