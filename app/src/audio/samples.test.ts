import { describe, expect, it } from 'vitest';
import { fadeOutTail, isProbablyAudio } from './samples';

const f = (name: string, type = '') => ({ name, type }) as File;

describe('isProbablyAudio', () => {
  it('accepts kick.wav and audio/mpeg, rejects notes.txt and image/png', () => {
    expect(isProbablyAudio(f('kick.wav'))).toBe(true);
    expect(isProbablyAudio(f('x', 'audio/mpeg'))).toBe(true);
    expect(isProbablyAudio(f('HAT.FLAC'))).toBe(true);
    expect(isProbablyAudio(f('notes.txt'))).toBe(false);
    expect(isProbablyAudio(f('pic.png', 'image/png'))).toBe(false);
  });
});

describe('fadeOutTail', () => {
  it('ramps the last N frames linearly to zero, leaving the rest alone', () => {
    const ch = new Float32Array(10).fill(1);
    fadeOutTail(ch, 4);
    expect(Array.from(ch.slice(0, 6))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(ch[9]).toBe(0);
    for (let i = 7; i < 10; i++) expect(ch[i]).toBeLessThan(ch[i - 1]);
  });
  it('fades the whole sample when shorter than the fade', () => {
    const ch = new Float32Array(3).fill(1);
    fadeOutTail(ch, 100);
    expect(ch[0]).toBeGreaterThan(0.5);
    expect(ch[2]).toBe(0);
  });
  it('handles empty input and zero frames', () => {
    fadeOutTail(new Float32Array(0), 5);
    const ch = new Float32Array(3).fill(1);
    fadeOutTail(ch, 0);
    expect(Array.from(ch)).toEqual([1, 1, 1]);
  });
});
