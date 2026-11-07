import { describe, expect, it } from 'vitest';
import { ContextClosedError, FINE_BUDGET_BYTES, createFineSamples, decodeFine } from './fineSamples';
import type { FineRequest } from './fineSamples';

/** A decoder stand-in: counts calls; resolves `frames` stereo frames, or rejects. */
function decoder(frames = 1000, fail = false) {
  const calls: string[] = [];
  const decode = async (bytes: ArrayBuffer) => {
    calls.push(new TextDecoder().decode(new Uint8Array(bytes)));
    await Promise.resolve();
    if (fail) throw new Error('bad file');
    return [new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(-0.5)];
  };
  return { calls, decode };
}

const req = (name: string, decode: FineRequest['decode'], floats = 2000): FineRequest => ({
  bytes: new TextEncoder().encode(name).buffer as ArrayBuffer, name, floats, decode,
});

/** A decode that waits for `go()` (to see what overlaps). */
function gated() {
  const started: string[] = [];
  const waits: (() => void)[] = [];
  const decode = (bytes: ArrayBuffer) => {
    started.push(new TextDecoder().decode(new Uint8Array(bytes)));
    return new Promise<Float32Array[]>((res) => waits.push(() => res([new Float32Array(10)])));
  };
  const go = async () => {
    waits.shift()?.();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { started, decode, go };
}

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

  it('decodes one at a time, so two never sit in memory', async () => {
    const fine = createFineSamples();
    const g = gated();
    const a = fine.load('a', req('a.wav', g.decode));
    const b = fine.load('b', req('b.wav', g.decode));
    const c = fine.load('c', req('c.wav', g.decode));
    expect(g.started).toEqual(['a.wav']); // b and c wait for a to land
    expect(fine.status('c')).toBe('decoding');
    await g.go();
    expect(await a).toBe('none'); // overtaken: dropped
    expect(await b).toBe('none'); // never started: c took over first
    expect(g.started).toEqual(['a.wav', 'c.wav']);
    await g.go();
    expect(await c).toBe('ready');
  });

  it('release drops the floats and abandons a running decode', async () => {
    const fine = createFineSamples();
    const d = decoder();
    await fine.load('a', req('a.wav', d.decode));
    fine.release('b'); // not the cached one: no-op
    expect(fine.status('a')).toBe('ready');
    fine.release('a');
    expect(fine.status('a')).toBe('none');
    expect(fine.channels('a')).toBeNull();
    // A late result after release (an unmounted view) is not kept.
    const g = gated();
    const p = fine.load('x', req('x.wav', g.decode));
    fine.release('x');
    await g.go();
    expect(await p).toBe('none');
    expect(fine.channels('x')).toBeNull();
    // retain(): the floats go when the LAST view holding the key lets go
    // (a {#key} remount may mount the new view before the old one leaves).
    await fine.load('r', req('r.wav', d.decode));
    const off1 = fine.retain('r');
    const off2 = fine.retain('r');
    off1();
    off1(); // idempotent
    expect(fine.status('r')).toBe('ready');
    off2();
    expect(fine.status('r')).toBe('none');
    // clear() (a project load) drops whatever is there.
    await fine.load('y', req('y.wav', d.decode));
    fine.clear();
    expect(fine.status('y')).toBe('none');
  });

  it('a closed context is not remembered as a failure', async () => {
    const fine = createFineSamples();
    const closed = async (): Promise<Float32Array[]> => {
      throw new ContextClosedError();
    };
    expect(await fine.load('a', req('a.wav', closed))).toBe('none');
    expect(fine.status('a')).toBe('none'); // the next engine may decode it
    const d = decoder();
    expect(await fine.load('a', req('a.wav', d.decode))).toBe('ready');
  });

  it('decodeFine keeps the decoded channels without copying, with the engine tail fade', async () => {
    const data = [new Float32Array(1000).fill(1), new Float32Array(1000).fill(-1), new Float32Array(1000)];
    let got: ArrayBuffer | null = null;
    const ctx = {
      state: 'running' as AudioContextState,
      decodeAudioData: async (b: ArrayBuffer) => {
        got = b;
        return { length: 1000, numberOfChannels: 3, sampleRate: 48000, getChannelData: (c: number) => data[c] } as unknown as AudioBuffer;
      },
    };
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const ch = await decodeFine(bytes, ctx);
    expect(bytes.byteLength).toBe(3); // the kept original is not detached
    expect(got).not.toBe(bytes);
    expect(ch).toHaveLength(2); // at most 2 channels, as the engine gets
    expect(ch[0]).toBe(data[0]); // no copy
    // decodeBytes's 2 ms (96 frames at 48 kHz) fade to exactly 0.
    expect(ch[0][1000 - 97]).toBe(1);
    expect(ch[0][999]).toBe(0);
    expect(ch[1][999]).toBe(-0);
    // A context closed under the decode (an audio restart): ContextClosedError.
    const dead = { state: 'closed' as AudioContextState, decodeAudioData: async () => { throw new Error('closed'); } };
    await expect(decodeFine(bytes, dead)).rejects.toBeInstanceOf(ContextClosedError);
    const bad = { state: 'running' as AudioContextState, decodeAudioData: async () => { throw new Error('bad'); } };
    await expect(decodeFine(bytes, bad)).rejects.not.toBeInstanceOf(ContextClosedError);
  });
});
