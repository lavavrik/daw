import { describe, expect, it } from 'vitest';
import { createPreview } from './preview';
import type { PreviewContext } from './preview';

/** A fake AudioContext: decode resolves when the test says so; sources log start/stop. */
function fakeCtx() {
  const log: string[] = [];
  const decodes: { resolve: (b: AudioBuffer) => void; reject: (e: Error) => void }[] = [];
  const ctx = {
    destination: {} as AudioNode,
    decodeAudioData: (b: ArrayBuffer) =>
      new Promise<AudioBuffer>((resolve, reject) => decodes.push({ resolve, reject: (e) => reject(e) })).then((x) => {
        void b;
        return x;
      }),
    createBufferSource() {
      const src = {
        buffer: null as AudioBuffer | null,
        onended: null as (() => void) | null,
        connect: () => log.push(`connect ${(src.buffer as unknown as { id: string }).id}`),
        disconnect: () => {},
        start: () => log.push(`start ${(src.buffer as unknown as { id: string }).id}`),
        stop: () => log.push(`stop ${(src.buffer as unknown as { id: string }).id}`),
      };
      return src as unknown as AudioBufferSourceNode;
    },
  };
  const buf = (id: string) => ({ id }) as unknown as AudioBuffer;
  return { ctx: ctx as unknown as PreviewContext, log, decodes, buf };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('sample preview', () => {
  it('plays one preview at a time, straight to the destination', async () => {
    const { ctx, log, decodes, buf } = fakeCtx();
    const states: (string | null)[] = [];
    const pv = createPreview(ctx, (k) => states.push(k));
    const a = pv.play('a.wav', async () => new ArrayBuffer(4));
    await flush();
    decodes[0].resolve(buf('A'));
    await a;
    expect(log).toEqual(['connect A', 'start A']);
    expect(pv.current).toBe('a.wav');
    const b = pv.play('b.wav', async () => new ArrayBuffer(4));
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
    const a = pv.play('a.wav', async () => new ArrayBuffer(4));
    await flush();
    const b = pv.play('b.wav', async () => new ArrayBuffer(4));
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
    const a = pv.play('a.wav', async () => new ArrayBuffer(4));
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
    const load = async () => (reads++, new ArrayBuffer(4));
    const a = pv.play('a.wav', load);
    await flush();
    decodes[0].resolve(buf('A'));
    await a;
    await pv.play('a.wav', load);
    expect(reads).toBe(1);
    pv.clearCache();
    const again = pv.play('a.wav', load);
    await flush();
    decodes[1].resolve(buf('A'));
    await again;
    expect(reads).toBe(2);
  });

  it('a failed decode throws to the caller and leaves nothing playing', async () => {
    const { ctx, decodes } = fakeCtx();
    const pv = createPreview(ctx, () => {});
    const a = pv.play('bad.wav', async () => new ArrayBuffer(4));
    await flush();
    decodes[0].reject(new Error('EncodingError'));
    await expect(a).rejects.toThrow();
    expect(pv.current).toBeNull();
  });
});
