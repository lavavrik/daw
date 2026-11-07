import { describe, expect, it } from 'vitest';
import { FINE_BUDGET_BYTES, createFineSamples } from './fineSamples';
import type { FineRequest } from './fineSamples';

/** A decoder stand-in: counts calls; resolves `frames` stereo frames, or rejects. */
function decoder(frames = 1000, fail = false) {
  const calls: string[] = [];
  const decode = async (_bytes: ArrayBuffer, name: string) => {
    calls.push(name);
    await Promise.resolve();
    if (fail) throw new Error('bad file');
    return [new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(-0.5)];
  };
  return { calls, decode };
}

const req = (name: string, decode: FineRequest['decode'], floats = 2000): FineRequest => ({
  bytes: new ArrayBuffer(8), name, floats, decode,
});

describe('fineSamples', () => {
  it('decodes once and caches one sample', async () => {
    const fine = createFineSamples();
    const d = decoder();
    expect(fine.status('a')).toBe('none');
    // Two requests while decoding share one decode.
    const p1 = fine.load('a', req('a.wav', d.decode));
    expect(fine.status('a')).toBe('decoding');
    const p2 = fine.load('a', req('a.wav', d.decode));
    expect(await p1).toBe('ready');
    expect(await p2).toBe('ready');
    expect(await fine.load('a', req('a.wav', d.decode))).toBe('ready');
    expect(d.calls).toEqual(['a.wav']);
    expect(fine.status('a')).toBe('ready');
    expect(fine.channels('a')?.map((c) => c[0])).toEqual([0.5, -0.5]);
  });

  it('a new sample evicts the old', async () => {
    const fine = createFineSamples();
    const d = decoder();
    let changes = 0;
    const off = fine.subscribe(() => changes++);
    await fine.load('a', req('a.wav', d.decode));
    await fine.load('b', req('b.wav', d.decode));
    expect(fine.status('a')).toBe('none');
    expect(fine.channels('a')).toBeNull();
    expect(fine.status('b')).toBe('ready');
    // A decode overtaken by another sample is dropped when it lands.
    const slow = fine.load('c', req('c.wav', d.decode));
    const fast = fine.load('d', req('d.wav', d.decode));
    expect(await slow).toBe('none');
    expect(await fast).toBe('ready');
    expect(fine.channels('c')).toBeNull();
    expect(fine.status('d')).toBe('ready');
    expect(changes).toBeGreaterThan(0);
    off();
  });

  it('refuses a file over the budget', async () => {
    expect(FINE_BUDGET_BYTES).toBe(256 * 1024 * 1024);
    const fine = createFineSamples(4000); // 1000 floats
    const d = decoder(500);
    await fine.load('a', req('a.wav', d.decode, 1000));
    expect(fine.status('a')).toBe('ready');
    // Known to be too big before decoding: no decode, and the cached one stays.
    expect(fine.fits(1000)).toBe(true);
    expect(fine.fits(1001)).toBe(false);
    expect(await fine.load('big', req('big.wav', d.decode, 1001))).toBe('too-big');
    expect(d.calls).toEqual(['a.wav']);
    expect(fine.status('a')).toBe('ready');
    // Bigger than its estimate once decoded: dropped, not kept.
    const fine2 = createFineSamples(4000);
    expect(await fine2.load('x', req('x.wav', decoder(600).decode, 900))).toBe('too-big');
    expect(fine2.channels('x')).toBeNull();
    expect(fine2.status('x')).toBe('too-big');
  });

  it('a failed decode leaves the peaks view', async () => {
    const fine = createFineSamples();
    const d = decoder(1000, true);
    expect(await fine.load('a', req('a.wav', d.decode))).toBe('failed');
    expect(fine.status('a')).toBe('failed');
    expect(fine.channels('a')).toBeNull();
    // Not retried on every redraw.
    expect(await fine.load('a', req('a.wav', d.decode))).toBe('failed');
    expect(d.calls).toEqual(['a.wav']);
  });
});
