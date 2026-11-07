import { describe, expect, it } from 'vitest';
import { encodeWav24, Wav24Writer } from './wav';

const bytesOf = async (b: Blob) => new DataView(await b.arrayBuffer());
const str = (v: DataView, at: number, n: number) =>
  String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + at, n));
/** Signed 24-bit little-endian sample at byte offset `at`. */
const s24 = (v: DataView, at: number) => ((v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getUint8(at + 2) << 16)) << 8) >> 8;

describe('encodeWav24', () => {
  it('wav header correct', async () => {
    const n = 5;
    const blob = encodeWav24(new Float32Array(n), new Float32Array(n), 44100);
    expect(blob.type).toBe('audio/wav');
    const v = await bytesOf(blob);
    expect(v.byteLength).toBe(44 + n * 6);
    expect(str(v, 0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + n * 6);
    expect(str(v, 8, 8)).toBe('WAVEfmt ');
    expect(v.getUint32(16, true)).toBe(16); // PCM fmt chunk size
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(2); // stereo
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(44100 * 6); // byte rate
    expect(v.getUint16(32, true)).toBe(6); // block align
    expect(v.getUint16(34, true)).toBe(24); // bits
    expect(str(v, 36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(n * 6);
  });

  it('samples are interleaved 24-bit, rounded and clipped', async () => {
    const l = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2, 1 / 8388608]);
    const r = new Float32Array([0.25, -0.25, 0, 0, 0, NaN, 0, 0]);
    const v = await bytesOf(encodeWav24(l, r, 48000));
    const at = (i: number, ch: number) => s24(v, 44 + i * 6 + ch * 3);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(i, 0))).toEqual([
      0, 4194304, -4194304, 8388607, -8388608, 8388607, -8388608, 1,
    ]);
    expect([0, 1, 2, 5].map((i) => at(i, 1))).toEqual([2097152, -2097152, 0, 0]); // NaN -> 0
  });

  it('refuses channels of different lengths', () => {
    expect(() => encodeWav24(new Float32Array(2), new Float32Array(3), 48000)).toThrow();
  });

  it('the streaming writer gives the same bytes as encodeWav24, in any block sizes', async () => {
    const n = 5000;
    const l = new Float32Array(n).map((_, i) => Math.sin(i / 7) * 1.2);
    const r = new Float32Array(n).map((_, i) => Math.cos(i / 5) * 0.5);
    const parts: Uint8Array[] = [];
    const w = new Wav24Writer(n, 44100, (p) => parts.push(p), 1000); // small chunks: several parts
    expect(parts.length).toBe(1); // the header, final, before any frame
    expect(parts[0].length).toBe(44);
    for (const [a, b] of [[0, 1], [1, 1024], [1024, 1100], [1100, 4999], [4999, 5000]]) w.write(l.subarray(a, b), r.subarray(a, b));
    w.finish();
    expect(parts.length).toBe(1 + 5);
    // Each part owns its whole buffer, so it can be transferred as is.
    for (const p of parts) expect([p.byteOffset, p.byteLength]).toEqual([0, p.buffer.byteLength]);
    const streamed = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
    const whole = new Uint8Array(await encodeWav24(l, r, 44100).arrayBuffer());
    expect(streamed).toEqual(whole);
  });

  it('the streaming writer emits each part as soon as it is full', () => {
    const parts: Uint8Array[] = [];
    const w = new Wav24Writer(10, 48000, (p) => parts.push(p), 4);
    w.write(new Float32Array(3), new Float32Array(3));
    expect(parts.length).toBe(1); // header only: the first chunk is not full yet
    w.write(new Float32Array(2), new Float32Array(2));
    expect(parts.map((p) => p.length)).toEqual([44, 24]);
    w.write(new Float32Array(5), new Float32Array(5));
    w.finish();
    expect(parts.map((p) => p.length)).toEqual([44, 24, 24, 12]);
  });

  it('the streaming writer refuses a length other than announced', () => {
    const w = new Wav24Writer(3, 48000, () => {});
    w.write(new Float32Array(2), new Float32Array(2));
    expect(() => w.finish()).toThrow();
    expect(() => w.write(new Float32Array(2), new Float32Array(2))).toThrow();
  });
});
