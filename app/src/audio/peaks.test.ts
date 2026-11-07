import { describe, expect, it } from 'vitest';
import { PEAK_FRAMES, WORKER_FRAMES, computePeaks, peaksFor, peaksInWorker, peaksLevel, peaksWorkerReply } from './peaks';
import type { PeaksWorkerLike } from './peaks';

/** A worker stand-in with postMessage semantics: structuredClone with `transfer` detaches the sender's buffers. */
function fakeWorker(): PeaksWorkerLike & { terminated: boolean } {
  const w = {
    terminated: false,
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null as ((e: unknown) => void) | null,
    postMessage(msg: unknown, transfer: Transferable[]) {
      const inside = structuredClone(msg, { transfer }) as { channels: Float32Array[] };
      const reply = peaksWorkerReply(inside.channels);
      const back = structuredClone(reply.msg, { transfer: reply.transfer });
      queueMicrotask(() => w.onmessage?.({ data: back }));
    },
    terminate() {
      w.terminated = true;
    },
  };
  return w;
}

describe('peaks', () => {
  it('peaks min/max per 256 frames', () => {
    expect(PEAK_FRAMES).toBe(256);
    const a = new Float32Array(600);
    a[3] = -0.5;
    a[100] = 1;
    a[300] = 0.25;
    a[599] = -1;
    const b = new Float32Array(600).fill(0.5);
    const pk = computePeaks([a, b]);
    expect(pk.framesPerPeak).toBe(256);
    expect(pk.frames).toBe(600);
    const [l0a, l0b] = pk.levels[0];
    expect(l0a).toBeInstanceOf(Int8Array);
    // ceil(600 / 256) = 3 min/max pairs, interleaved.
    expect([...l0a]).toEqual([-64, 127, 0, 32, -127, 0]);
    // Quantized outward (min floors, max ceils): a peak is never drawn smaller than it is.
    expect([...l0b]).toEqual([63, 64, 63, 64, 63, 64]);
    // Out-of-range / NaN samples are clamped, never wrap or poison the picture.
    const pk2 = computePeaks([Float32Array.from([2, -3, NaN])]);
    expect([...pk2.levels[0][0]]).toEqual([-127, 127]);
  });

  it('levels are 4x coarser', () => {
    const n = 256 * 4 * 4 * 3 + 5; // 3 level-2 pairs and a partial one
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.sin(i / 37) * (i / n);
    const pk = computePeaks([a]);
    expect(pk.levels.length).toBeGreaterThanOrEqual(3);
    for (let l = 1; l < pk.levels.length; l++) {
      const fine = pk.levels[l - 1][0];
      const coarse = pk.levels[l][0];
      expect(coarse.length / 2).toBe(Math.ceil(fine.length / 2 / 4));
      for (let i = 0; i < coarse.length / 2; i++) {
        let lo = 127;
        let hi = -127;
        for (let j = 4 * i; j < Math.min(4 * i + 4, fine.length / 2); j++) {
          lo = Math.min(lo, fine[2 * j]);
          hi = Math.max(hi, fine[2 * j + 1]);
        }
        expect([coarse[2 * i], coarse[2 * i + 1]]).toEqual([lo, hi]);
      }
    }
    // The coarsest level has a single pair.
    expect(pk.levels.at(-1)![0].length).toBe(2);
    // The level for a zoom: the coarsest one that still has a pair per pixel.
    expect(peaksLevel(pk, 100).framesPerPeak).toBe(256);
    expect(peaksLevel(pk, 256).framesPerPeak).toBe(256);
    expect(peaksLevel(pk, 1023).framesPerPeak).toBe(256);
    expect(peaksLevel(pk, 1024).framesPerPeak).toBe(1024);
    expect(peaksLevel(pk, 5000).framesPerPeak).toBe(4096);
    expect(peaksLevel(pk, 1e9).framesPerPeak).toBe(256 * 4 ** (pk.levels.length - 1));
    expect(peaksLevel(pk, 1024).data).toBe(pk.levels[1]);
  });

  it('worker returns the channel buffers', async () => {
    const a = new Float32Array(5000).map((_, i) => Math.sin(i / 10));
    const b = new Float32Array(5000).map((_, i) => Math.cos(i / 10) / 2);
    const copyA = a.slice();
    const copyB = b.slice();
    const w = fakeWorker();
    const r = await peaksInWorker([a, b], () => w);
    // Transferred in (the caller's views are detached: nothing was copied) ...
    expect(a.byteLength).toBe(0);
    expect(b.byteLength).toBe(0);
    // ... and back, unchanged, with the peaks.
    expect(r.channels).toHaveLength(2);
    expect([...r.channels[0]]).toEqual([...copyA]);
    expect([...r.channels[1]]).toEqual([...copyB]);
    expect(r.peaks).toEqual(computePeaks([copyA, copyB]));
    expect(w.terminated).toBe(true);

    // Small files are computed inline; big ones go to the worker; both cache by content hash.
    expect(WORKER_FRAMES).toBe(2 ** 21);
    let spawned = 0;
    const small = [new Float32Array(1000).fill(0.25)];
    const s1 = await peaksFor(small, 'hash-small', () => (spawned++, fakeWorker()));
    expect(spawned).toBe(0);
    expect(s1.channels[0]).toBe(small[0]);
    const s2 = await peaksFor([new Float32Array(1000)], 'hash-small', () => (spawned++, fakeWorker()));
    expect(s2.peaks).toBe(s1.peaks); // cached: same object, not recomputed
    const big = [new Float32Array(WORKER_FRAMES + 1)];
    const g = await peaksFor(big, 'hash-big', () => (spawned++, fakeWorker()));
    expect(spawned).toBe(1);
    expect(big[0].byteLength).toBe(0);
    expect(g.channels[0].length).toBe(WORKER_FRAMES + 1);
  });
});
