import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentHash, sampleFile } from './sampleFiles';

describe('sample files', () => {
  afterEach(() => vi.restoreAllMocks());

  it('contentHash is a stable 8-hex digest of the bytes', async () => {
    const a = new Uint8Array([1, 2, 3]).buffer;
    expect(await contentHash(a)).toMatch(/^[0-9a-f]{8}$/);
    expect(await contentHash(a)).toBe(await contentHash(new Uint8Array([1, 2, 3]).buffer));
    expect(await contentHash(a)).not.toBe(await contentHash(new Uint8Array([1, 2, 4]).buffer));
    expect(await contentHash(new ArrayBuffer(0))).toMatch(/^[0-9a-f]{8}$/);
  });

  it('hashes off the UI thread (crypto.subtle.digest), not in a synchronous loop (M4)', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const big = new Uint8Array(1 << 20).buffer;
    const pending = contentHash(big);
    expect(pending).toBeInstanceOf(Promise);
    expect(digest).toHaveBeenCalledWith('SHA-256', big);
    // SHA-256 of 1 MiB of zeros, first 8 hex digits.
    expect(await pending).toBe('30e14955');
  });

  it('sampleFile keeps the bytes and their hash', async () => {
    const bytes = new Uint8Array([9, 9]).buffer;
    expect(await sampleFile('kick.wav', 'audio/wav', bytes)).toEqual({ name: 'kick.wav', type: 'audio/wav', bytes, hash: await contentHash(bytes) });
  });
});
