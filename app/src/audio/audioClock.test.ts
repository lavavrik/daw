import { describe, expect, it } from 'vitest';
import { heardContextTime, heardTicksFallback, mod, ticksAtContextTime } from './audioClock';

const SR = 48000;

describe('audioClock', () => {
  it('ticksAtContextTime extrapolates at tempo', () => {
    // 120 BPM = 2 beats/s = 1920 ticks/s.
    const tele = { ticks: 100, frame: 48000 };
    expect(ticksAtContextTime(2, tele, SR, 120)).toBeCloseTo(100 + 1920, 6);
    expect(ticksAtContextTime(1, tele, SR, 120)).toBeCloseTo(100, 6);
  });

  it('heard tick subtracts output latency', () => {
    const ts = { contextTime: 10, performanceTime: 5000 };
    const c = heardContextTime(5100, ts, 0);
    expect(c).toBeCloseTo(10.1, 9);
    const tele = { ticks: 1000, frame: 10.25 * SR };
    expect(ticksAtContextTime(c, tele, SR, 120)).toBeCloseTo(1000 - 0.15 * 1920, 6);
  });

  it('offset shifts earlier', () => {
    const ts = { contextTime: 10, performanceTime: 5000 };
    expect(heardContextTime(5100, ts, 50)).toBeCloseTo(10.05, 9);
    expect(heardContextTime(5100, ts, -50)).toBeCloseTo(10.15, 9);
  });

  it('fallback without getOutputTimestamp', () => {
    // currentTime 5 s, base 0.01 + output 0.25 latency -> heard 4.74 s.
    expect(heardTicksFallback(5, 0.01, 0.25)).toBeCloseTo(4.74, 9);
    expect(heardTicksFallback(5, 0.01, 0)).toBeCloseTo(4.99, 9);
  });

  it('mod is non-negative', () => {
    expect(mod(-1, 3840)).toBe(3839);
    expect(mod(3840, 3840)).toBe(0);
  });
});
