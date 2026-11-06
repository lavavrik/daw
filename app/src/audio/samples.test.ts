import { describe, expect, it } from 'vitest';
import { Err, HostErr } from './protocol';
import { fadeOutTail, isProbablyAudio, loadErrorText } from './samples';

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

describe('loadErrorText', () => {
  it('explains each failure without jargon codes', () => {
    // 64 Mi floats at 48 kHz: 23.3 min mono, 11.65 min stereo.
    expect(loadErrorText(Err.BAD_VALUE, 48000)).toBe('too long (max ~23 min mono / ~11 min stereo at 48 kHz)');
    expect(loadErrorText(Err.OUT_OF_MEMORY, 48000)).toBe('not enough memory for this sample');
    expect(loadErrorText(Err.BAD_INDEX, 48000)).toContain('sample limit');
    expect(loadErrorText(HostErr.QUEUE_FULL, 48000)).toContain('drop it again');
    expect(loadErrorText(HostErr.ENGINE_STOPPED, 48000)).toContain('reload');
    for (const c of [Err.BAD_VALUE, Err.OUT_OF_MEMORY, Err.BAD_INDEX, HostErr.QUEUE_FULL, HostErr.ENGINE_STOPPED]) {
      expect(loadErrorText(c, 44100)).not.toMatch(/code/);
    }
  });
});
