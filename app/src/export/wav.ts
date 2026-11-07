// 24-bit PCM stereo WAV encoder for the export (docs/architecture/export.md).
// Runs in the render Worker (and in tests); no DOM.
//
// Float -> int: `round(x * 2^23)`, clipped to [-2^23, 2^23 - 1] (so +1.0
// clips to the largest positive code, -1.0 is exact). NaN encodes as 0. The
// master limiter keeps real output inside its ceiling, so clipping here only
// guards against a misbehaving patch.

const FULL = 8388608; // 2^23

/** Interleaved L/R 24-bit little-endian PCM in a canonical 44-byte RIFF/WAVE header. */
export function encodeWav24(left: Float32Array, right: Float32Array, sr: number): Blob {
  if (left.length !== right.length) throw new Error('encodeWav24: channels differ in length');
  const n = left.length;
  const dataBytes = n * 6;
  if (44 + dataBytes > 0xffffffff) throw new Error('encodeWav24: too long for a WAV file (4 GB)');
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true); // channels
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 6, true); // byte rate
  v.setUint16(32, 6, true); // block align
  v.setUint16(34, 24, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  let at = 44;
  for (let i = 0; i < n; i++) {
    at = put24(out, at, left[i]);
    at = put24(out, at, right[i]);
  }
  return new Blob([out], { type: 'audio/wav' });
}

function put24(out: Uint8Array, at: number, x: number): number {
  let s = Math.round(x * FULL);
  if (!(s === s)) s = 0; // NaN
  else if (s > FULL - 1) s = FULL - 1;
  else if (s < -FULL) s = -FULL;
  out[at] = s & 0xff;
  out[at + 1] = (s >> 8) & 0xff;
  out[at + 2] = (s >> 16) & 0xff;
  return at + 3;
}
