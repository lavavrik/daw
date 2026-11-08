import { describe, expect, it } from 'vitest';
import { faderLaw, mixParam } from '../../audio/mixerCatalog';
import {
  FADER_FINE, FADER_LAW, PEAK_HOLD_MS, faderDb, faderDrag, faderKeyStep, faderPos, formatDb, delayClampNote, holdStep, isClip, masterLight, worseLight,
  linToDb, meterPos,
} from './mixMath';

describe('fader law', () => {
  it('is the catalog\'s (engine mixer::catalog::FADER_LAW, plan 19)', () => {
    expect(FADER_LAW).toBe(faderLaw);
  });
  it('covers the catalog range: min (−∞) at the bottom, max at the top', () => {
    expect(FADER_LAW[0][0]).toBe(mixParam('fader').min);
    expect(FADER_LAW[FADER_LAW.length - 1][0]).toBe(mixParam('fader').max);
    expect(faderPos(-60)).toBe(0);
    expect(faderPos(-Infinity)).toBe(0);
    expect(faderPos(6)).toBe(1);
    expect(faderPos(99)).toBe(1);
  });
  it('0 dB sits at 3/4 of the travel; the scale is perceptual (top dB spread out)', () => {
    expect(faderPos(0)).toBeCloseTo(0.75);
    // 6 dB near unity takes more travel than 20 dB near the bottom.
    expect(faderPos(0) - faderPos(-6)).toBeGreaterThan(faderPos(-40) - faderPos(-60) - 0.05);
    expect(faderPos(-10)).toBeGreaterThan(0.5);
    expect(faderPos(-20)).toBeGreaterThan(0.3);
  });
  it('is monotonic and round-trips (to 0.1 dB)', () => {
    let last = -1;
    for (let db = -60; db <= 6; db += 0.5) {
      const pos = faderPos(db);
      expect(pos).toBeGreaterThan(last);
      last = pos;
      expect(faderDb(pos)).toBeCloseTo(db, 1);
    }
  });
  it('faderDb snaps to 0.1 dB and clamps', () => {
    expect(faderDb(0)).toBe(-60);
    expect(faderDb(-1)).toBe(-60);
    expect(faderDb(2)).toBe(6);
    expect(Math.round(faderDb(0.6123) * 10)).toBe(faderDb(0.6123) * 10);
  });
});

describe('fader gestures', () => {
  it('drag: up = louder, the fader height covers the travel, Shift is finer', () => {
    expect(faderDrag(0.5, -100, 100, false)).toBe(1);
    expect(faderDrag(0.5, 10, 100, false)).toBeCloseTo(0.4);
    expect(faderDrag(0.5, 10, 100, true)).toBeCloseTo(0.5 - 0.1 * FADER_FINE);
    expect(faderDrag(0.1, 50, 100, false)).toBe(0);
  });
  it('keys: 1 dB (Shift 0.1 dB), clamped; from −∞ a step up leaves the floor', () => {
    expect(faderKeyStep(0, 1, false)).toBe(1);
    expect(faderKeyStep(0, -1, true)).toBe(-0.1);
    expect(faderKeyStep(5.5, 1, false)).toBe(6);
    expect(faderKeyStep(-60, -1, false)).toBe(-60);
    expect(faderKeyStep(-60, 1, false)).toBe(-59);
    expect(faderKeyStep(-3.3, 1, true)).toBe(-3.2); // no float dust
  });
});

describe('formatDb', () => {
  it('reads −∞ at the floor, one decimal with a real minus otherwise', () => {
    expect(formatDb(-60)).toBe('−∞');
    expect(formatDb(-Infinity)).toBe('−∞');
    expect(formatDb(-6)).toBe('−6.0 dB');
    expect(formatDb(0)).toBe('0.0 dB');
    expect(formatDb(-0.04)).toBe('0.0 dB');
    expect(formatDb(3.25)).toBe('+3.3 dB');
  });
});

describe('meter mapping', () => {
  it('linToDb', () => {
    expect(linToDb(1)).toBe(0);
    expect(linToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(linToDb(0)).toBe(-Infinity);
    expect(linToDb(NaN)).toBe(-Infinity);
  });
  it('meterPos shares the fader scale, so ticks line up', () => {
    expect(meterPos(0)).toBe(0);
    expect(meterPos(1)).toBeCloseTo(faderPos(0));
    expect(meterPos(0.5)).toBeCloseTo(faderPos(linToDb(0.5)));
    expect(meterPos(10)).toBe(1);
    expect(meterPos(1e-9)).toBe(0);
  });
  it('isClip: at or above the ceiling', () => {
    expect(isClip(1, 0)).toBe(true);
    expect(isClip(0.99, 0)).toBe(false);
    expect(isClip(10 ** (-0.3 / 20), -0.3)).toBe(true);
    expect(isClip(10 ** (-0.5 / 20), -0.3)).toBe(false);
  });
});

describe('master light', () => {
  it('amber LIMIT on limiter GR > 1 dB, red CLIP only when the output reaches the ceiling', () => {
    const lin = (db: number) => 10 ** (db / 20);
    expect(masterLight(lin(-0.3), -0.3, 6)).toBe('clip'); // at the ceiling
    expect(masterLight(lin(-0.305), -0.3, 0)).toBe('clip'); // within 0.01 dB
    expect(masterLight(lin(-0.5), -0.3, 3)).toBe('limit'); // working, not at the ceiling
    expect(masterLight(lin(-0.5), -0.3, 0)).toBeNull(); // near but no GR: off
    expect(masterLight(lin(-6), -0.3, 1.5)).toBe('limit');
    expect(masterLight(lin(-6), -0.3, 1)).toBeNull();
  });
  it('latches the worst state until reset', () => {
    expect(worseLight(null, 'limit')).toBe('limit');
    expect(worseLight('limit', null)).toBe('limit');
    expect(worseLight('limit', 'clip')).toBe('clip');
    expect(worseLight('clip', 'limit')).toBe('clip');
  });
});

describe('peak hold', () => {
  it('holds the highest peak for 1 s, then follows the signal', () => {
    let h = holdStep({ db: -Infinity, t: 0 }, -10, 0);
    expect(h).toEqual({ db: -10, t: 0 });
    h = holdStep(h, -20, 500);
    expect(h.db).toBe(-10);
    h = holdStep(h, -5, 600); // a higher peak restarts the hold
    expect(h).toEqual({ db: -5, t: 600 });
    h = holdStep(h, -30, 600 + PEAK_HOLD_MS - 1);
    expect(h.db).toBe(-5);
    h = holdStep(h, -30, 600 + PEAK_HOLD_MS + 1);
    expect(h).toEqual({ db: -30, t: 600 + PEAK_HOLD_MS + 1 });
  });
});

describe('delay clamp note', () => {
  it('shows "(max 2 s)" when the synced division is longer than 2 s at the tempo', () => {
    const div = (label: string) => mixParam('delay_time').choices.indexOf(label);
    expect(delayClampNote(div('1 bar'), 120)).toBe(''); // exactly 2 s
    expect(delayClampNote(div('1 bar'), 119)).toBe('(max 2 s)');
    expect(delayClampNote(div('1/2'), 60)).toBe('');
    expect(delayClampNote(div('1/2'), 59)).toBe('(max 2 s)');
    expect(delayClampNote(div('3/16'), 40)).toBe('');
  });
});
