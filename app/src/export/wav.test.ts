import { describe, expect, it } from 'vitest';
import { encodeWav24 } from './wav';

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
});
