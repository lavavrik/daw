import { describe, expect, it } from 'vitest';
import { METER_FALL_DB_PER_S, applyMeters, meterFall } from './meterBallistics';

describe('meter ballistics (worklet side)', () => {
  it('fall per block matches the dB/s rate', () => {
    const f = meterFall(48000, 128);
    const perSecond = Math.pow(f, 48000 / 128);
    expect(20 * Math.log10(perSecond)).toBeCloseTo(-METER_FALL_DB_PER_S, 6);
  });

  it('peaks jump up at once and fall at the rate; GR slots copy through', () => {
    const fall = 0.5;
    const dst = new Float32Array(6);
    applyMeters(dst, Float32Array.from([0.8, 0.4, -3, 0, 0, 0]), fall);
    expect([...dst]).toEqual([0.8, 0.4, -3, 0, 0, 0].map(Math.fround));
    applyMeters(dst, Float32Array.from([0.1, 0.3, -1, 0, 0, 0]), fall);
    expect(dst[0]).toBeCloseTo(0.4);
    expect(dst[1]).toBeCloseTo(0.3); // the new peak is higher than 0.4 * 0.5
    expect(dst[2]).toBeCloseTo(-1); // gain reduction is not decayed
  });

  it('flushes tiny values to 0 and never lets NaN stick', () => {
    const dst = Float32Array.from([1e-7, NaN, 0]);
    applyMeters(dst, Float32Array.from([0, 0, 0]), 0.9);
    expect(dst[0]).toBe(0);
    expect(dst[1]).toBe(0);
    applyMeters(dst, Float32Array.from([NaN, 0.5, 0]), 0.9);
    expect(dst[0]).toBe(0);
    expect(dst[1]).toBeCloseTo(0.5);
  });
});
