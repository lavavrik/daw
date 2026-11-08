import { describe, expect, it } from 'vitest';
import { clampValue, decimalsOf, fineStep, formatValue, pressIntent, roundTo, scrubValue, stepValue } from './numberField';

const b = { min: 0, max: 10, decimals: 2 };

describe('numberField maths', () => {
  it('rounds away float noise', () => {
    expect(roundTo(0.1 + 0.2, 2)).toBe(0.3);
    expect(decimalsOf(0.25)).toBe(2);
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.1)).toBe(1);
  });
  it('formats without trailing zeros', () => {
    expect(formatValue(0.5, 3)).toBe('0.5');
    expect(formatValue(12, 3)).toBe('12');
    expect(formatValue(1.23456, 3)).toBe('1.235');
  });
  it('clamps and rounds; bounds are optional', () => {
    expect(clampValue(-1, b)).toBe(0);
    expect(clampValue(11, b)).toBe(10);
    expect(clampValue(1.234, b)).toBe(1.23);
    expect(clampValue(-50, { decimals: 0 })).toBe(-50);
  });
  it('steps up and down, fine = step / 10, clamped', () => {
    expect(stepValue(1, 1, 0.25, false, b)).toBe(1.25);
    expect(stepValue(1, -1, 0.25, true, b)).toBe(0.98); // 0.975 rounds to 2 decimals
    expect(stepValue(0, -1, 1, false, b)).toBe(0);
    expect(stepValue(10, 1, 1, false, b)).toBe(10);
  });
  it('fine step on an integer field still moves a whole unit (Shift+arrow)', () => {
    expect(fineStep(1, 0)).toBe(1);
    expect(fineStep(10, 0)).toBe(1);
    expect(fineStep(0.25, 2)).toBe(0.025);
    expect(fineStep(0.1, 1)).toBe(0.1); // 0.01 would round to nothing at 1 decimal
    const ints = { min: 0, max: 100, decimals: 0 };
    expect(stepValue(5, 1, 1, true, ints)).toBe(6);
    expect(stepValue(5, -1, 1, true, ints)).toBe(4);
    expect(stepValue(50, 1, 10, true, ints)).toBe(51);
  });
  it('an unfocused press scrubs after 3 px of vertical travel either way', () => {
    expect(pressIntent(0, 2, false)).toBe('wait');
    expect(pressIntent(0, -2.9, false)).toBe('wait');
    expect(pressIntent(0, 3, false)).toBe('scrub');
    expect(pressIntent(0, -3, false)).toBe('scrub');
    expect(pressIntent(20, 1, false)).toBe('wait'); // sideways never scrubs
  });
  it('a press in a focused field selects text unless it is clearly a vertical drag', () => {
    expect(pressIntent(0, 4, true)).toBe('wait'); // 3 px is not enough once focused
    expect(pressIntent(0, 6, true)).toBe('scrub');
    expect(pressIntent(1, -7, true)).toBe('scrub');
    expect(pressIntent(3, 1, true)).toBe('select'); // sideways first: a text selection
    expect(pressIntent(5, 5, true)).toBe('select');
    expect(pressIntent(2, 2, true)).toBe('wait');
  });
  it('scrub: one step per 4 px, up is bigger, in whole steps', () => {
    const s = { min: 0, max: 100, decimals: 0 };
    expect(scrubValue(50, -3, 1, false, s)).toBe(50);
    expect(scrubValue(50, -4, 1, false, s)).toBe(51);
    expect(scrubValue(50, -17, 1, false, s)).toBe(54);
    expect(scrubValue(50, 8, 1, false, s)).toBe(48);
    expect(scrubValue(50, -4000, 1, false, s)).toBe(100);
    expect(scrubValue(50, 4000, 1, false, s)).toBe(0);
  });
  it('scrub with Shift is step / 10 and respects decimals', () => {
    const s = { min: 0, max: 10, decimals: 2 };
    expect(scrubValue(1, -8, 0.25, true, s)).toBe(1.05); // 2 steps of 0.025 = 0.05
    // Integer field: still moves, once per 40 px.
    expect(scrubValue(5, -40, 1, true, { decimals: 0 })).toBe(6); // 10 steps of 0.1
    expect(scrubValue(5, -16, 1, true, { decimals: 0 })).toBe(5); // 4 steps of 0.1 round away
  });
});
