import { RECORD_WORDS, RING_CAPACITY } from './protocol';

const HEADER_BYTES = 16; // Int32Array(4): [0]=write idx, [1]=read idx, [2],[3] reserved
const W = 0;
const R = 1;

export function createRingBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + RING_CAPACITY * RECORD_WORDS * 8);
}

/**
 * Single-producer (main thread, `push`) / single-consumer (audio thread, `pop`)
 * ring of fixed 5-word records. Indices are record indices in [0, RING_CAPACITY).
 * Each side writes only its own index, publishing with Atomics.store after the
 * data is in place. `pop` never allocates (runs on the audio thread).
 */
export class CommandRing {
  private readonly idx: Int32Array;
  private readonly data: Float64Array;

  constructor(sab: SharedArrayBuffer) {
    this.idx = new Int32Array(sab, 0, 4);
    this.data = new Float64Array(sab, HEADER_BYTES, RING_CAPACITY * RECORD_WORDS);
  }

  push(op: number, a = 0, b = 0, c = 0, d = 0): boolean {
    const w = Atomics.load(this.idx, W);
    const next = (w + 1) % RING_CAPACITY;
    if (next === Atomics.load(this.idx, R)) return false; // full
    const o = w * RECORD_WORDS;
    this.data[o] = op;
    this.data[o + 1] = a;
    this.data[o + 2] = b;
    this.data[o + 3] = c;
    this.data[o + 4] = d;
    Atomics.store(this.idx, W, next);
    return true;
  }

  pop(out: Float64Array): boolean {
    const r = Atomics.load(this.idx, R);
    if (r === Atomics.load(this.idx, W)) return false; // empty
    const o = r * RECORD_WORDS;
    for (let i = 0; i < RECORD_WORDS; i++) out[i] = this.data[o + i];
    Atomics.store(this.idx, R, (r + 1) % RING_CAPACITY);
    return true;
  }
}
