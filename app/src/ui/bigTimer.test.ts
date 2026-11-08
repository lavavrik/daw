import { describe, expect, it } from 'vitest';
import { hintText, timerParts, timerSeconds } from './bigTimer';

const BAR = 3840;

describe('timerParts (bar:beat:tick, 4/4 at 960 PPQ)', () => {
  it('the start is 1:01:000', () => {
    expect(timerParts(0)).toEqual({ bar: '1', beat: '01', tick: '000' });
  });
  it('beats and ticks within a bar', () => {
    expect(timerParts(960)).toEqual({ bar: '1', beat: '02', tick: '000' });
    expect(timerParts(2 * 960 + 288)).toEqual({ bar: '1', beat: '03', tick: '288' });
    expect(timerParts(BAR - 1)).toEqual({ bar: '1', beat: '04', tick: '959' });
  });
  it('later bars, up to 3 digits', () => {
    expect(timerParts(2 * BAR + 960 + 288)).toEqual({ bar: '3', beat: '02', tick: '288' });
    expect(timerParts(998 * BAR)).toEqual({ bar: '999', beat: '01', tick: '000' });
  });
  it('fractional, negative (count-in) or unreadable ticks: floored, clamped to the start', () => {
    expect(timerParts(960.9)).toEqual({ bar: '1', beat: '02', tick: '000' });
    expect(timerParts(-500)).toEqual({ bar: '1', beat: '01', tick: '000' });
    expect(timerParts(NaN)).toEqual({ bar: '1', beat: '01', tick: '000' });
  });
});

describe('timerSeconds (m:ss.cc at the project tempo)', () => {
  it('zero', () => expect(timerSeconds(0, 120)).toBe('0:00.00'));
  it('one beat at 120 BPM is half a second', () => expect(timerSeconds(960, 120)).toBe('0:00.50'));
  it('minutes roll over', () => {
    // 124 BPM: 2 bars of 4 beats = 8 beats = 3.870967.. s
    expect(timerSeconds(2 * BAR, 124)).toBe('0:03.87');
    expect(timerSeconds(60 * 2 * 960, 120)).toBe('1:00.00'); // 120 beats at 120 BPM
    expect(timerSeconds((61.5 * 2) * 960, 120)).toBe('1:01.50');
  });
  it('never shows a rounding to 60 seconds', () => {
    // 59.996 s rounds to 1:00.00, not 0:60.00
    expect(timerSeconds((59.996 * 2) * 960, 120)).toBe('1:00.00');
  });
  it('negative or unreadable: zero', () => {
    expect(timerSeconds(-100, 120)).toBe('0:00.00');
    expect(timerSeconds(NaN, 120)).toBe('0:00.00');
    expect(timerSeconds(960, 0)).toBe('0:00.00');
  });
});

describe('hintText (the hovered control for the top bar hint line)', () => {
  const el = (attrs: Record<string, string>, parent: Element | null = null) => {
    const e = {
      attrs,
      parentElement: parent,
      getAttribute: (n: string) => attrs[n] ?? null,
    };
    return e as unknown as Element;
  };
  it('the nearest title, else aria-label, walking up', () => {
    const btn = el({ title: 'Metronome' });
    const icon = el({}, btn);
    expect(hintText(icon)).toBe('Metronome');
    expect(hintText(el({ 'aria-label': 'Undo' }))).toBe('Undo');
    expect(hintText(el({ title: 'T', 'aria-label': 'A' }))).toBe('T');
  });
  it('blank attributes are skipped; nothing found is null', () => {
    const outer = el({ title: 'Outer' });
    expect(hintText(el({ title: '  ' }, outer))).toBe('Outer');
    expect(hintText(el({}))).toBeNull();
    expect(hintText(null)).toBeNull();
  });
});
