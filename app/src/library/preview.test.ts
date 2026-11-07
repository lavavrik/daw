import { describe, expect, it } from 'vitest';
import { createPreview } from './preview';
import type { PreviewContext, PreviewOptions } from './preview';

type FakeBuf = { id: string; length: number; numberOfChannels: number; duration: number };

/** A fake AudioContext: decode resolves when the test says so; sources log start/stop. */
function fakeCtx() {
  const log: string[] = [];
  const decodes: { resolve: (b: AudioBuffer) => void; reject: (e: Error) => void }[] = [];
  const ctx = {
    destination: {} as AudioNode,
    decodeAudioData: () => new Promise<AudioBuffer>((resolve, reject) => decodes.push({ resolve, reject })),
    createBufferSource() {
      const src = {
        buffer: null as AudioBuffer | null,
        onended: null as (() => void) | null,
        connect: () => log.push(`connect ${(src.buffer as unknown as FakeBuf).id}`),
        disconnect: () => {},
        start: () => log.push(`start ${(src.buffer as unknown as FakeBuf).id}`),
        stop: () => log.push(`stop ${(src.buffer as unknown as FakeBuf).id}`),
      };
      return src as unknown as AudioBufferSourceNode;
    },
  };
  /** A decoded buffer: `seconds` of `channels` channels at 48 kHz (1 s mono by default). */
  const buf = (id: string, seconds = 1, channels = 1) =>
    ({ id, length: seconds * 48000, numberOfChannels: channels, duration: seconds }) as unknown as AudioBuffer;
  return { ctx: ctx as unknown as PreviewContext, log, decodes, buf };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const small = async () => new Blob([new Uint8Array(4)]);

/** A fake streaming player (stands in for an HTMLAudioElement on an object URL). */
function fakeStreamer() {
  const log: string[] = [];
  const ends: (() => void)[] = [];
  const stream: NonNullable<PreviewOptions['stream']> = async (blob, onEnded) => {
    log.push(`stream ${blob.size}`);
    ends.push(onEnded);
    return { stop: () => log.push(`stop ${blob.size}`) };
  };
  return { stream, log, ends };
}

/** Decode `key` (resolving decode `n` with `b`) and wait until it plays. */
async function playDecoded(pv: ReturnType<typeof createPreview>, decodes: ReturnType<typeof fakeCtx>['decodes'], key: string, b: AudioBuffer, load = small) {
  const p = pv.play(key, load);
  await flush();
  decodes.at(-1)!.resolve(b);
  await p;
}

describe('sample preview', () => {
  it('plays one preview at a time, straight to the destination', async () => {
    const { ctx, log, decodes, buf } = fakeCtx();
    const states: (string | null)[] = [];
    const pv = createPreview(ctx, (k) => states.push(k));
    await playDecoded(pv, decodes, 'a.wav', buf('A'));
    expect(log).toEqual(['connect A', 'start A']);
    expect(pv.current).toBe('a.wav');
    const b = pv.play('b.wav', small);
    expect(log).toContain('stop A'); // the old one stops at once
    await flush();
    decodes[1].resolve(buf('B'));
    await b;
    expect(log.slice(-2)).toEqual(['connect B', 'start B']);
    expect(pv.current).toBe('b.wav');
    pv.stop();
    expect(log.at(-1)).toBe('stop B');
    expect(pv.current).toBeNull();
    expect(states).toEqual(['a.wav', 'b.wav', null]);
  });

  it('a slow decode that was superseded never starts', async () => {
    const { ctx, log, decodes, buf } = fakeCtx();
    const pv = createPreview(ctx, () => {});
    const a = pv.play('a.wav', small);
    await flush();
    const b = pv.play('b.wav', small);
    await flush();
    decodes[1].resolve(buf('B'));
    await b;
    decodes[0].resolve(buf('A')); // late
    await a;
    expect(log).toEqual(['connect B', 'start B']);
    expect(pv.current).toBe('b.wav');
  });

  it('stop during a decode cancels it', async () => {
    const { ctx, log, decodes, buf } = fakeCtx();
    const pv = createPreview(ctx, () => {});
    const a = pv.play('a.wav', small);
    await flush();
    pv.stop();
    decodes[0].resolve(buf('A'));
    await a;
    expect(log).toEqual([]);
    expect(pv.current).toBeNull();
  });

  it('decoded buffers are cached (replaying does not re-read)', async () => {
    const { ctx, decodes, buf } = fakeCtx();
    const pv = createPreview(ctx, () => {});
    let reads = 0;
    const load = async () => (reads++, new Blob([new Uint8Array(4)]));
    await playDecoded(pv, decodes, 'a.wav', buf('A'), load);
    await pv.play('a.wav', load);
    expect(reads).toBe(1);
    pv.clearCache();
    await playDecoded(pv, decodes, 'a.wav', buf('A'), load);
    expect(reads).toBe(2);
  });

  it('the cache is bounded by memory: least recently used out first', async () => {
    const { ctx, decodes, buf } = fakeCtx();
    // Budget 10 s of mono at 48 kHz.
    const pv = createPreview(ctx, () => {}, { cacheFloats: 10 * 48000 });
    await playDecoded(pv, decodes, 'a', buf('A', 4)); // 4 s
    await playDecoded(pv, decodes, 'b', buf('B', 2, 2)); // 4 s worth (stereo)
    await pv.play('a', small); // a is now the most recently used
    expect(pv.cachedFloats()).toBe(8 * 48000);
    await playDecoded(pv, decodes, 'c', buf('C', 3)); // 11 s > 10: b goes, not a
    expect(pv.cachedKeys()).toEqual(['a', 'c']);
    expect(pv.cachedFloats()).toBe(7 * 48000);
  });

  it('long sounds are never cached (default: over 30 s)', async () => {
    const { ctx, decodes, buf } = fakeCtx();
    const pv = createPreview(ctx, () => {});
    await playDecoded(pv, decodes, 'stem', buf('S', 31, 2));
    expect(pv.cachedKeys()).toEqual([]);
    await playDecoded(pv, decodes, 'loop', buf('L', 30, 2));
    expect(pv.cachedKeys()).toEqual(['loop']);
  });

  it('big files stream instead of decoding; stop ends the stream', async () => {
    const { ctx, log, decodes } = fakeCtx();
    const s = fakeStreamer();
    const states: (string | null)[] = [];
    const pv = createPreview(ctx, (k) => states.push(k), { streamBytes: 100, stream: s.stream });
    await pv.play('huge.wav', async () => new Blob([new Uint8Array(101)]));
    expect(decodes).toHaveLength(0); // never decodeAudioData
    expect(log).toEqual([]);
    expect(s.log).toEqual(['stream 101']);
    expect(pv.current).toBe('huge.wav');
    pv.stop();
    expect(s.log).toEqual(['stream 101', 'stop 101']);
    expect(pv.current).toBeNull();
    // It ending on its own clears it too.
    await pv.play('huge.wav', async () => new Blob([new Uint8Array(102)]));
    s.ends.at(-1)!();
    expect(pv.current).toBeNull();
    expect(states).toEqual(['huge.wav', null, 'huge.wav', null]);
  });

  it('compressed files stream from a lower size (they expand ~10x when decoded)', async () => {
    const { ctx, decodes } = fakeCtx();
    const s = fakeStreamer();
    const pv = createPreview(ctx, () => {}, { streamBytes: 100, streamCompressedBytes: 10, stream: s.stream });
    await pv.play('song.mp3', async () => new Blob([new Uint8Array(11)], { type: 'audio/mpeg' }));
    expect(s.log).toEqual(['stream 11']);
    expect(decodes).toHaveLength(0);
  });

  it('a stream superseded while starting is stopped at once', async () => {
    const { ctx, decodes, buf } = fakeCtx();
    const s = fakeStreamer();
    const pv = createPreview(ctx, () => {}, { streamBytes: 100, stream: s.stream });
    let release!: () => void;
    const slow = new Promise<Blob>((r) => (release = () => r(new Blob([new Uint8Array(200)]))));
    const a = pv.play('huge.wav', () => slow);
    const b = pv.play('b.wav', small);
    await flush();
    decodes[0].resolve(buf('B'));
    await b;
    release();
    await a;
    expect(s.log).toEqual([]); // the read finished after b: never streamed
    expect(pv.current).toBe('b.wav');
  });

  it('a failed decode throws to the caller and leaves nothing playing', async () => {
    const { ctx, decodes } = fakeCtx();
    const pv = createPreview(ctx, () => {});
    const a = pv.play('bad.wav', small);
    await flush();
    decodes[0].reject(new Error('EncodingError'));
    await expect(a).rejects.toThrow();
    expect(pv.current).toBeNull();
  });
});
