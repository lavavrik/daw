import { describe, expect, it } from 'vitest';
import { contentHash, sampleFile } from './sampleFiles';

describe('sample files', () => {
  it('contentHash is a stable 8-hex digest of the bytes', () => {
    const a = new Uint8Array([1, 2, 3]).buffer;
    expect(contentHash(a)).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHash(a)).toBe(contentHash(new Uint8Array([1, 2, 3]).buffer));
    expect(contentHash(a)).not.toBe(contentHash(new Uint8Array([1, 2, 4]).buffer));
    expect(contentHash(new ArrayBuffer(0))).toMatch(/^[0-9a-f]{8}$/);
  });
  it('sampleFile keeps the bytes and their hash', () => {
    const bytes = new Uint8Array([9, 9]).buffer;
    expect(sampleFile('kick.wav', 'audio/wav', bytes)).toEqual({ name: 'kick.wav', type: 'audio/wav', bytes, hash: contentHash(bytes) });
  });
});
