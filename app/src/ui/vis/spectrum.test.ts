import { describe, expect, it } from 'vitest';
import { Ballistics, Bands, DB_FLOOR, SPEC_N, SpectrumAnalyser, freqToX, hoverReadout, xToFreq } from './spectrum';

const SR = 48000;

function sine(f: number, amp = 1, phase = 0.3, sr = SR): Float64Array {
  const x = new Float64Array(SPEC_N);
  for (let i = 0; i < SPEC_N; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / sr + phase);
  return x;
}

describe('spectrum', () => {
  it('a full-scale sine reads 0 dB in its band', () => {
    for (const sr of [44100, 48000, 96000]) {
      const an = new SpectrumAnalyser(sr);
      for (const count of [60, 20]) {
        const bands = new Bands(count, sr);
        for (const phase of [0, 0.3, 1.1, 2.0]) {
          for (const f of [50, 1000, 10000]) {
            const raw = bands.measure(an.analyse(sine(f, 1, phase, sr)));
            expect(Math.abs(raw[bands.bandOf(f)]), `${f} Hz, ${count} bands, ${sr} Hz, phase ${phase}`).toBeLessThanOrEqual(0.5);
          }
        }
      }
    }
  });

  it('a full-scale sine reads 0 dB in its band at any frequency', () => {
    // From 30 Hz up (45 Hz at 96 kHz, where a bin is 23 Hz): below that the
    // sine's mirror image near 0 Hz bends the lowest bins (up to ~1.5 dB).
    for (const sr of [44100, 48000, 96000]) {
      const an = new SpectrumAnalyser(sr);
      const sets = [new Bands(60, sr), new Bands(20, sr)];
      for (const phase of [0.3, 2.0]) {
        for (let f = sr > 48000 ? 45 : 30; f < 19900; f *= 1.023) {
          const bins = an.analyse(sine(f, 1, phase, sr));
          for (const b of sets) {
            expect(Math.abs(b.measure(bins)[b.bandOf(f)]), `${f.toFixed(1)} Hz, ${b.count} bands, ${sr} Hz`).toBeLessThanOrEqual(0.5);
          }
        }
      }
    }
  });

  it('bands two octaves away are below −60 dB', () => {
    const an = new SpectrumAnalyser(SR);
    for (const count of [60, 20]) {
      const bands = new Bands(count, SR);
      for (const f of [50, 1000, 10000]) {
        const raw = bands.measure(an.analyse(sine(f)));
        for (const g of [f / 4, f * 4]) {
          if (g < 20 || g > 20000) continue;
          expect(raw[bands.bandOf(g)], `${g} Hz with a ${f} Hz sine, ${count} bands`).toBeLessThan(-60);
        }
      }
    }
  });

  it('log axis', () => {
    expect(freqToX(20)).toBeCloseTo(0, 9);
    expect(freqToX(20000)).toBeCloseTo(1, 9);
    expect(Math.abs(freqToX(1000) - 0.566)).toBeLessThanOrEqual(0.002);
    for (const f of [20, 31.5, 55, 440, 1000, 4321, 20000]) expect(xToFreq(freqToX(f))).toBeCloseTo(f, 6);
    for (const x of [0, 0.1, 0.5, 0.9, 1]) expect(freqToX(xToFreq(x))).toBeCloseTo(x, 9);
  });

  it('fall and peak hold', () => {
    const b = new Ballistics(1);
    const dt = 1 / 30;
    b.step(Float32Array.of(0), dt);
    expect(b.level[0]).toBe(0);
    expect(b.peak[0]).toBe(0);
    const silence = Float32Array.of(DB_FLOOR);
    let t = 0;
    const until = (s: number) => {
      while (t < s - 1e-9) {
        b.step(silence, dt);
        t += dt;
      }
    };
    until(1);
    // Fall 24 dB/s: at least 23 dB lower one second later.
    expect(b.level[0]).toBeLessThanOrEqual(-23);
    expect(b.level[0]).toBeGreaterThanOrEqual(-25);
    // The hold dot stays for 1 s...
    expect(b.peak[0]).toBeCloseTo(0, 6);
    // ...then falls 12 dB/s.
    until(1.5);
    expect(b.peak[0]).toBeCloseTo(-6, 0);
    until(2);
    expect(b.peak[0]).toBeCloseTo(-12, 0);
    // Never below the level, never below the floor.
    until(20);
    expect(b.level[0]).toBe(DB_FLOOR);
    expect(b.peak[0]).toBe(DB_FLOOR);
  });

  it('a rise is instant and resets the hold', () => {
    const b = new Ballistics(1);
    b.step(Float32Array.of(-40), 1 / 30);
    b.step(Float32Array.of(-3), 1 / 30);
    expect(b.level[0]).toBe(-3);
    expect(b.peak[0]).toBe(-3);
    b.reset();
    expect(b.level[0]).toBe(DB_FLOOR);
    expect(b.peak[0]).toBe(DB_FLOOR);
  });

  it('hover readout names the note', () => {
    expect(hoverReadout(55, -8.24)).toBe('55 Hz · A1 · −8.2 dB');
    expect(hoverReadout(440, 0)).toBe('440 Hz · A4 · 0.0 dB');
    expect(hoverReadout(1234, -20)).toBe('1.23 kHz · D#6 · −20.0 dB');
    expect(hoverReadout(12000, DB_FLOOR)).toBe('12.0 kHz · F#9 · −∞ dB');
  });
});
