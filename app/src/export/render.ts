// The export's render core (docs/architecture/export.md): runs the same
// engine.wasm the AudioWorklet runs, through the same C ABI
// (engine/src/ffi.rs), but offline: as fast as the CPU allows, in
// MAX_BLOCK (1024-frame) blocks. Pure and DOM-free: the render Worker
// (renderWorker.ts) wraps handleRenderMessage, and the tests run renderSong
// directly in Node against the native reference
// (engine/tests/export_render.rs, which mirrors this file's block schedule
// and hash exactly -- change both together).
import { MAX_BLOCK, TELEMETRY, TELEMETRY_LEN } from '../audio/protocol';
import type { EngineCommand } from '../project/commands';
import { encodeWav24 } from './wav';

/** The engine's C ABI (as in worklet.ts). Pointers are byte offsets into `memory`. */
interface EngineExports {
  memory: WebAssembly.Memory;
  engine_new(sampleRate: number): number;
  engine_out_left(e: number): number;
  engine_out_right(e: number): number;
  engine_process(e: number, frames: number): void;
  engine_command(e: number, op: number, a: number, b: number, c: number, d: number): number;
  engine_sample_alloc(e: number, id: number, frames: number, channels: number): number;
  engine_sample_ready(e: number, id: number): number;
  engine_telemetry(e: number): number;
  engine_latency(e: number): number;
}

/** A decoded sample, planar ([ch0 frames..., ch1 frames...]), at its engine id. */
export interface JobSample {
  id: number;
  frames: number;
  channels: number;
  data: Float32Array;
}

/** Everything a render needs; the engine starts blank (engine_new). */
export interface RenderJob {
  sampleRate: number;
  /** Frames of output (the song plus its tail), after the latency trim. */
  frames: number;
  samples: JobSample[];
  /** Sent in order after the samples are loaded (exportCommands). */
  commands: EngineCommand[];
}

/** Main thread -> Worker. `wasm` and the sample buffers are transferred. */
export interface RenderRequest {
  type: 'render';
  wasm: ArrayBuffer;
  job: RenderJob;
}

/** Worker -> main thread. `fraction` 0..1, posted every 0.25 s of audio and at the end. */
export type WorkerReply =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; wav: Blob }
  | { type: 'error'; message: string };

/** A render that cannot produce the song (a sample the engine refused). */
export class RenderError extends Error {}

/**
 * Frames per engine_process call: the AudioWorklet render quantum, the size
 * the live worklet always calls with. A project replay renders the same in
 * any call size (engine Mixer::slot_added: a track added to an empty slot
 * takes its strip settings from its first sample; pinned by
 * export_render_is_call_size_independent), but replacing a sounding track
 * holds its strip for a fade counted per call, so the export stays on the
 * live schedule anyway.
 */
export const ENGINE_QUANTUM = 128;

/**
 * Renders `job` on a fresh engine instance: load samples, send commands,
 * then `frames + latency` frames in MAX_BLOCK (1024-frame) blocks, each as
 * ENGINE_QUANTUM-frame engine_process calls (the last call shorter),
 * dropping the first `latency` frames (the master limiter's lookahead) so
 * the song's first beat is frame 0. `onProgress(done)` is called after every
 * block with the output frames rendered so far.
 */
export function renderSong(
  wasm: BufferSource, job: RenderJob, onProgress?: (done: number) => void,
): { left: Float32Array; right: Float32Array } {
  // Synchronous compile: fine off the main thread (Worker, Node tests).
  const ex = new WebAssembly.Instance(new WebAssembly.Module(wasm), {}).exports as unknown as EngineExports;
  const h = ex.engine_new(job.sampleRate);
  const lastError = () =>
    new Float64Array(ex.memory.buffer, ex.engine_telemetry(h) >>> 0, TELEMETRY_LEN)[TELEMETRY.lastError];

  for (const s of job.samples) {
    const ptr = ex.engine_sample_alloc(h, s.id, s.frames, s.channels) >>> 0;
    if (ptr === 0) throw new RenderError(`sample ${s.id} could not be loaded (engine code ${lastError()})`);
    // Alloc may grow memory: the view is made only now.
    new Float32Array(ex.memory.buffer, ptr, s.frames * s.channels).set(s.data.subarray(0, s.frames * s.channels));
    const code = ex.engine_sample_ready(h, s.id);
    if (code !== 0) throw new RenderError(`sample ${s.id} could not be loaded (engine code ${code})`);
  }
  // A refused command is ignored, exactly as the live worklet does (the
  // command list is the live one, so live and export agree on it).
  for (const c of job.commands) ex.engine_command(h, c[0], c[1] ?? 0, c[2] ?? 0, c[3] ?? 0, c[4] ?? 0);

  const latency = ex.engine_latency(h) >>> 0;
  const total = job.frames + latency;
  const left = new Float32Array(job.frames);
  const right = new Float32Array(job.frames);
  let done = 0; // frames rendered, latency included
  while (done < total) {
    const blockEnd = Math.min(done + MAX_BLOCK, total);
    while (done < blockEnd) {
      const n = Math.min(ENGINE_QUANTUM, blockEnd - done);
      ex.engine_process(h, n);
      // Copy the part of the call past the latency trim.
      const skip = Math.max(0, latency - done);
      if (skip < n) {
        const b = ex.memory.buffer;
        const at = done + skip - latency;
        left.set(new Float32Array(b, (ex.engine_out_left(h) >>> 0) + skip * 4, n - skip), at);
        right.set(new Float32Array(b, (ex.engine_out_right(h) >>> 0) + skip * 4, n - skip), at);
      }
      done += n;
    }
    onProgress?.(Math.max(0, done - latency));
  }
  return { left, right };
}

/**
 * The Worker's whole job: render, encode, reply. Progress goes out every
 * 0.25 s of rendered audio and once at the end (fraction 1); then exactly
 * one 'done' or 'error'.
 */
export function handleRenderMessage(msg: unknown, post: (reply: WorkerReply) => void): void {
  const m = msg as RenderRequest;
  if (m?.type !== 'render') return;
  try {
    const { job } = m;
    const every = Math.max(1, Math.round(job.sampleRate / 4));
    let next = every;
    const { left, right } = renderSong(m.wasm, job, (done) => {
      if (done >= next && done < job.frames) {
        post({ type: 'progress', fraction: done / job.frames });
        while (next <= done) next += every;
      }
    });
    post({ type: 'progress', fraction: 1 });
    post({ type: 'done', wav: encodeWav24(left, right, job.sampleRate) });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

// --- The fixed test job (engine/tests/fixtures/export_render.txt) ----------

/**
 * Generated sample data, planar: the LCG described in export_render.rs
 * (bit-identical to the Rust generator: integer LCG, exact f64 product, one
 * division, rounded to f32 by the Float32Array).
 */
export function sampleData(frames: number, channels: number, seed: number): Float32Array {
  const out = new Float32Array(frames * channels);
  let x = seed >>> 0;
  let k = 0;
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < frames; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      out[k++] = (((x >>> 16) - 32768) * (frames - i)) / (32768 * frames);
    }
  }
  return out;
}

/** Parses the fixture format (see export_render.rs `parse`). */
export function parseJob(text: string): RenderJob {
  const job: RenderJob = { sampleRate: 0, frames: 0, samples: [], commands: [] };
  for (const line of text.split('\n')) {
    const w = line.trim().split(/\s+/);
    if (w[0] === '' || w[0].startsWith('#')) continue;
    const n = w.slice(1).map(Number);
    if (n.some((x) => Number.isNaN(x))) throw new Error(`bad number in ${JSON.stringify(line)}`);
    if (w[0] === 'sample_rate') job.sampleRate = n[0];
    else if (w[0] === 'frames') job.frames = n[0];
    else if (w[0] === 'sample') job.samples.push({ id: n[0], frames: n[1], channels: n[2], data: sampleData(n[1], n[2], n[3]) });
    else if (w[0] === 'cmd') job.commands.push([n[0], n[1], n[2], n[3], n[4]]);
    else throw new Error(`unknown fixture line ${JSON.stringify(w[0])}`);
  }
  return job;
}

/** 32-bit FNV-1a over the little-endian bytes of `left`, then `right` (as export_render.rs). */
export function fnv1a32(left: Float32Array, right: Float32Array): number {
  let h = 0x811c9dc5;
  for (const ch of [left, right]) {
    const bytes = new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength); // LE on every platform we run
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  }
  return h >>> 0;
}
