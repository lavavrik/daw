// 24-bit PCM stereo WAV encoder for the export (docs/architecture/export.md).
// Runs in the render Worker (and in tests); no DOM.
//
// Float -> int: `round(x * 2^23)`, clipped to [-2^23, 2^23 - 1] (so +1.0
// clips to the largest positive code, -1.0 is exact). NaN encodes as 0. The
// master limiter keeps real output inside its ceiling, so clipping here only
// guards against a misbehaving patch.
//
// Wav24Writer streams: the length is known up front (the export renders a
// fixed frame count), so the header is final from the start, and each
// rendered block is encoded straight into fixed-size byte chunks that become
// Blob parts. The Worker never holds the song as floats, nor the file twice.

const FULL = 8388608; // 2^23
const BYTES_PER_FRAME = 6;

/** The canonical 44-byte RIFF/WAVE header for `frames` stereo 24-bit frames. */
export function wavHeader24(frames: number, sr: number): Uint8Array {
  const dataBytes = frames * BYTES_PER_FRAME;
  if (44 + dataBytes > 0xffffffff) throw new Error('encodeWav24: too long for a WAV file (4 GB)');
  const out = new Uint8Array(44);
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
  v.setUint32(28, sr * BYTES_PER_FRAME, true); // byte rate
  v.setUint16(32, BYTES_PER_FRAME, true); // block align
  v.setUint16(34, 24, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  return out;
}

/**
 * A WAV built block by block: announce the frame count, `write` exactly that
 * many frames in blocks of any size, then `finish`. Bytes are identical to
 * encodeWav24 of the whole signal.
 */
export class Wav24Writer {
  private readonly parts: Uint8Array[];
  private chunk: Uint8Array;
  private at = 0;
  private written = 0;
  private done = false;

  /** `chunkFrames`: frames per Blob part (default 1 s at 48 kHz). */
  constructor(private readonly frames: number, sr: number, private readonly chunkFrames = 48000) {
    this.parts = [wavHeader24(frames, sr)];
    this.chunk = new Uint8Array(Math.min(frames, chunkFrames) * BYTES_PER_FRAME);
  }

  write(left: Float32Array, right: Float32Array): void {
    const n = left.length;
    if (this.done || right.length !== n || this.written + n > this.frames) {
      throw new Error('Wav24Writer: frames beyond the announced length (or channels differ)');
    }
    for (let i = 0; i < n; i++) {
      if (this.at === this.chunk.length) this.flush();
      this.at = put24(this.chunk, this.at, left[i]);
      this.at = put24(this.chunk, this.at, right[i]);
    }
    this.written += n;
  }

  finish(): Blob {
    if (this.written !== this.frames) throw new Error(`Wav24Writer: ${this.written} of ${this.frames} frames written`);
    if (this.at > 0) this.flush();
    this.done = true;
    return new Blob(this.parts as BlobPart[], { type: 'audio/wav' });
  }

  private flush() {
    this.parts.push(this.at === this.chunk.length ? this.chunk : this.chunk.subarray(0, this.at));
    const left = this.frames - this.written;
    this.chunk = new Uint8Array(Math.max(1, Math.min(left, this.chunkFrames)) * BYTES_PER_FRAME);
    this.at = 0;
  }
}

/** Interleaved L/R 24-bit little-endian PCM in a canonical 44-byte RIFF/WAVE header. */
export function encodeWav24(left: Float32Array, right: Float32Array, sr: number): Blob {
  if (left.length !== right.length) throw new Error('encodeWav24: channels differ in length');
  const w = new Wav24Writer(left.length, sr, Math.max(1, left.length));
  w.write(left, right);
  return w.finish();
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
