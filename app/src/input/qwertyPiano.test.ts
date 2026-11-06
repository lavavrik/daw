import { describe, expect, it } from 'vitest';
import { keyToNote } from './qwertyPiano';

describe('keyToNote', () => {
  it('maps KeyA at octave 4 to middle C (60)', () => expect(keyToNote('KeyA', 4)).toBe(60));
  it('maps KeyK at octave 4 to 72', () => expect(keyToNote('KeyK', 4)).toBe(72));
  it('maps KeyA at octave 0 to 12', () => expect(keyToNote('KeyA', 0)).toBe(12));
  it('maps KeyL at octave 8 to 122 (14 + 12*9; brief said 110, contradicting its own formula)', () => expect(keyToNote('KeyL', 8)).toBe(122));
  it('returns null for non-piano keys', () => expect(keyToNote('Digit1', 4)).toBeNull());
  it('returns null when out of the MIDI range', () => expect(keyToNote('KeyA', 11)).toBeNull());
});
