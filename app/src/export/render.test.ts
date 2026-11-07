// The export render core against the native Rust reference
// (engine/tests/export_render.rs): the same fixed job, the same block
// schedule, the same golden hash. Needs a built engine.wasm: `npm test`
// builds it first (npm run build:engine).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fnv1a32, handleRenderMessage, parseJob, renderSong, sampleData } from './render';
import type { WorkerReply } from './render';
import { encodeWav24 } from './wav';
import { engineWasmBytes as wasmBytes } from './testWasm';

const fixture = (f: string) => readFileSync(new URL(`../../../engine/tests/fixtures/${f}`, import.meta.url), 'utf8');

const job = () => parseJob(fixture('export_render.txt'));

describe('export render core', () => {
  it('sample data matches the Rust generator', () => {
    // First values of the LCG stream (seed 1), checked by hand against
    // export_render.rs sample_data.
    const d = sampleData(4, 1, 1);
    expect(d.length).toBe(4);
    const x1 = (1 * 1664525 + 1013904223) >>> 0;
    expect(d[0]).toBe(Math.fround((((x1 >>> 16) - 32768) * 4) / (32768 * 4)));
    expect(sampleData(3, 2, 7).length).toBe(6);
  });

  it('render matches native', () => {
    const j = job();
    const { left, right } = renderSong(wasmBytes(), j);
    expect(left.length).toBe(j.frames);
    const golden = fixture('export_render.hash').trim();
    expect(fnv1a32(left, right).toString(16).padStart(8, '0')).toBe(golden);
  });

  it('the render is deterministic', () => {
    const j = job();
    const bytes = wasmBytes();
    const a = renderSong(bytes, j);
    const b = renderSong(bytes, j);
    expect(fnv1a32(a.left, a.right)).toBe(fnv1a32(b.left, b.right));
  });

  it('the Worker streams the WAV block by block: same bytes as encoding the whole render', async () => {
    const j = job();
    const bytes = wasmBytes();
    const { left, right } = renderSong(bytes, j);
    const want = new Uint8Array(await encodeWav24(left, right, j.sampleRate).arrayBuffer());
    const replies: WorkerReply[] = [];
    handleRenderMessage({ type: 'render', wasm: bytes, job: j }, (r) => replies.push(r));
    const done = replies.at(-1)!;
    expect(done.type).toBe('done');
    const got = new Uint8Array(await (done as { wav: Blob }).wav.arrayBuffer());
    expect(got.length).toBe(want.length);
    expect(got).toEqual(want);
  });
});
