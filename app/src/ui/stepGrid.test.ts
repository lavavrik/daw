import { describe, expect, it } from 'vitest';
import { ACCENT_MIN_VEL } from '../state/acidSteps';
import { TRACK_COLORS } from './theme';
import { rowColor, stepCellStyle } from './stepGrid';

describe('stepCellStyle', () => {
  it('off: no fill, no accent, not playing', () => {
    expect(stepCellStyle(0, 0, false)).toEqual({ on: false, accent: false, playing: false, alt: false, fill: 0 });
  });

  it('on: the fill height is velocity / 127 of the cell', () => {
    expect(stepCellStyle(127, 0, false)).toMatchObject({ on: true, fill: 100 });
    expect(stepCellStyle(64, 0, false).fill).toBeCloseTo(50.39, 2);
    expect(stepCellStyle(100, 0, false).fill).toBeCloseTo(78.74, 2); // a click
    expect(stepCellStyle(60, 0, false).fill).toBeCloseTo(47.24, 2); // an Alt-click ghost
    expect(stepCellStyle(1, 0, false)).toMatchObject({ on: true });
    expect(stepCellStyle(1, 0, false).fill).toBeGreaterThan(0);
  });

  it('accent from the Acid rule (velocity >= 110), never on an off cell', () => {
    expect(ACCENT_MIN_VEL).toBe(110);
    expect(stepCellStyle(109, 0, false).accent).toBe(false);
    expect(stepCellStyle(110, 0, false).accent).toBe(true);
    expect(stepCellStyle(127, 0, false).accent).toBe(true);
    expect(stepCellStyle(100, 0, false).accent).toBe(false); // the default velocity reads plain
  });

  it('playing passes through, on or off', () => {
    expect(stepCellStyle(0, 3, true)).toMatchObject({ on: false, playing: true });
    expect(stepCellStyle(80, 3, true)).toMatchObject({ on: true, playing: true });
  });

  it('group shading: every other group of four is a shade lighter', () => {
    const alt = Array.from({ length: 16 }, (_, s) => stepCellStyle(0, s, false).alt);
    expect(alt).toEqual([
      false, false, false, false, true, true, true, true,
      false, false, false, false, true, true, true, true,
    ]);
    expect(stepCellStyle(0, 60, false).alt).toBe(true); // group 15 of a 64-step pattern
  });
});

describe('rowColor', () => {
  it('walks the palette from the track slot, wrapping at 8', () => {
    expect(rowColor(0, 0)).toBe(TRACK_COLORS[0]);
    expect(rowColor(0, 3)).toBe(TRACK_COLORS[3]);
    expect(rowColor(2, 0)).toBe(TRACK_COLORS[2]);
    expect(rowColor(5, 4)).toBe(TRACK_COLORS[1]);
    expect(rowColor(17, 0)).toBe(TRACK_COLORS[1]);
  });
});
