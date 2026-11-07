// 24-bit PCM stereo WAV encoder for the export (docs/architecture/export.md).
// Runs in the render Worker (and in tests); no DOM.
//
// Float -> int: `round(x * 2^23)`, clipped to [-2^23, 2^23 - 1] (so +1.0
// clips to the largest positive code, -1.0 is exact). NaN encodes as 0. The
// master limiter keeps real output inside its ceiling, so clipping here only
// guards against a misbehaving patch.
//
// Wav24Writer streams: the length is known up front (the export renders a
// fixed frame count), so the header is final from the start and is the first
// part out; each rendered block is encoded straight into fixed-size byte
// chunks, and every chunk is handed on (`onPart`) the moment it is full. The
// render Worker posts each part to the page, which writes it to the file, so
// the song is never held as floats, nor the file as a whole anywhere.

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
 * many frames in blocks of any size, then `finish`. `onPart` receives the
 * header (in the constructor), then each full chunk of `chunkFrames` frames
 * as soon as it fills (the last one shorter). Every part owns its whole
 * ArrayBuffer (offset 0, no spare bytes), so it can be transferred as is and
 * is never touched again here. The parts concatenated are byte-identical to
 * encodeWav24 of the whole signal.
 */
export class Wav24Writer {
  private chunk: Uint8Array;
  private at = 0;
  private written = 0;
  private done = false;

  /** `chunkFrames`: frames per part (default 1 s at 48 kHz, 288 KB). */
  constructor(
    private readonly frames: number, sr: number, private readonly onPart: (part: Uint8Array) => void,
    private readonly chunkFrames = 48000,
  ) {
    onPart(wavHeader24(frames, sr));
    this.chunk = this.nextChunk();
  }

  write(left: Float32Array, right: Float32Array): void {
    const n = left.length;
    if (this.done || right.length !== n || this.written + n > this.frames) {
      throw new Error('Wav24Writer: frames beyond the announced length (or channels differ)');
    }
    for (let i = 0; i < n; i++) {
      this.at = put24(this.chunk, this.at, left[i]);
      this.at = put24(this.chunk, this.at, right[i]);
      this.written++;
      if (this.at === this.chunk.length) {
        // Sized to the frames left, so a full chunk is exactly a part.
        this.onPart(this.chunk);
        this.chunk = this.nextChunk();
        this.at = 0;
      }
    }
  }

  /** Checks the announced length was written (every part has gone out by then). */
  finish(): void {
    if (this.written !== this.frames) throw new Error(`Wav24Writer: ${this.written} of ${this.frames} frames written`);
    this.done = true;
  }

  private nextChunk() {
    return new Uint8Array(Math.min(this.frames - this.written, this.chunkFrames) * BYTES_PER_FRAME);
  }
}

/** Interleaved L/R 24-bit little-endian PCM in a canonical 44-byte RIFF/WAVE header. */
export function encodeWav24(left: Float32Array, right: Float32Array, sr: number): Blob {
  if (left.length !== right.length) throw new Error('encodeWav24: channels differ in length');
  const parts: Uint8Array[] = [];
  const w = new Wav24Writer(left.length, sr, (p) => parts.push(p), Math.max(1, left.length));
  w.write(left, right);
  w.finish();
  return new Blob(parts as BlobPart[], { type: 'audio/wav' });
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
