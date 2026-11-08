import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyToNote, loadOctave, saveOctave, wheelOctaveSteps } from './qwertyPiano';

describe('keyToNote', () => {
  it('maps KeyA at octave 4 to middle C (60)', () => expect(keyToNote('KeyA', 4)).toBe(60));
  it('maps KeyK at octave 4 to 72', () => expect(keyToNote('KeyK', 4)).toBe(72));
  it('maps KeyA at octave 0 to 12', () => expect(keyToNote('KeyA', 0)).toBe(12));
  it('maps KeyL at octave 8 to 122 (14 + 12*9; brief said 110, contradicting its own formula)', () => expect(keyToNote('KeyL', 8)).toBe(122));
  it('returns null for non-piano keys', () => expect(keyToNote('Digit1', 4)).toBeNull());
  it('returns null when out of the MIDI range', () => expect(keyToNote('KeyA', 11)).toBeNull());
});

describe('loadOctave / saveOctave', () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    return m;
  };
  it('round-trips through daw.octave', () => {
    const m = store();
    saveOctave(6);
    expect(m.get('daw.octave')).toBe('6');
    expect(loadOctave()).toBe(6);
  });
  it('falls back to 4 on garbage / missing / out-of-range / throwing storage', () => {
    store();
    expect(loadOctave()).toBe(4);
    for (const bad of ['abc', '', '4.5', '-1', '9', 'NaN']) {
      store({ 'daw.octave': bad });
      expect(loadOctave()).toBe(4);
    }
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(loadOctave()).toBe(4);
    expect(() => saveOctave(5)).not.toThrow();
  });
});

describe('wheelOctaveSteps', () => {
  it('ignores deltaY 0', () => expect(wheelOctaveSteps(30, 0)).toEqual({ steps: 0, acc: 30 }));
  it('accumulates small trackpad deltas, one step per 100 px, up = raise', () => {
    let acc = 0, total = 0;
    for (let i = 0; i < 25; i++) { const r = wheelOctaveSteps(acc, -10); acc = r.acc; total += r.steps; }
    expect(total).toBe(2); // 250 px
    expect(acc).toBe(-50);
    expect(wheelOctaveSteps(0, 120)).toEqual({ steps: -1, acc: 20 });
  });
  it('a line-mode notch is one step', () => expect(wheelOctaveSteps(0, -3, 1).steps).toBe(1));
});
