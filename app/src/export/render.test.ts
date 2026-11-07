// The export render core against the native Rust reference
// (engine/tests/export_render.rs): the same fixed job, the same block
// schedule, the same golden hash. Needs a built engine.wasm: `npm test`
// builds it first (npm run build:engine).
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fnv1a32, MAX_PARTS_IN_FLIGHT, parseJob, renderService, renderSong, sampleData } from './render';
import type { WorkerReply } from './render';
import { encodeWav24 } from './wav';
import { engineWasmBytes as wasmBytes } from './testWasm';
import { exportCommands, exportFrames } from './exportSong';
import { serialize } from '../project/serialize';
import { buildAudioFixture } from '../project/testFixture';

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
    const transfers: Transferable[][] = [];
    let service!: (msg: unknown) => void;
    const done = new Promise<void>((resolve) => {
      service = renderService((r, transfer) => {
        replies.push(r);
        if (r.type === 'part') {
          transfers.push(transfer ?? []);
          queueMicrotask(() => service({ type: 'ack' })); // an instant disk
        }
        if (r.type === 'done' || r.type === 'error') resolve();
      });
    });
    service({ type: 'render', wasm: bytes, job: j });
    await done;
    expect(replies.at(-1)!.type).toBe('done');
    const parts = replies.flatMap((r) => (r.type === 'part' ? [r.bytes] : []));
    expect(parts.length).toBeGreaterThan(2); // the header, then ~1 s parts
    expect(new Uint8Array(parts[0]).length).toBe(44);
    // Each part is transferred, not copied.
    expect(transfers).toEqual(parts.map((b) => [b]));
    const got = new Uint8Array(await new Blob(parts).arrayBuffer());
    expect(got.length).toBe(want.length);
    expect(got).toEqual(want);
    // Progress is interleaved with the parts, not all before or after them.
    const types = replies.map((r) => r.type);
    const firstData = types.indexOf('part', 1);
    expect(types.slice(firstData).filter((t) => t === 'progress').length).toBeGreaterThan(1);
  });

  it('the Worker pauses after MAX_PARTS_IN_FLIGHT un-acked parts', async () => {
    const j = { ...job(), frames: 0 };
    j.frames = 10 * j.sampleRate; // ~10 parts of 1 s: well past the limit
    const replies: WorkerReply[] = [];
    const service = renderService((r) => replies.push(r));
    const parts = () => replies.filter((r) => r.type === 'part').length;
    service({ type: 'render', wasm: wasmBytes(), job: j });
    await new Promise((r) => setTimeout(r, 20));
    expect(parts()).toBe(MAX_PARTS_IN_FLIGHT); // the render is parked, nothing more is encoded
    expect(replies.some((r) => r.type === 'done')).toBe(false);
    service({ type: 'ack' });
    await new Promise((r) => setTimeout(r, 20));
    expect(parts()).toBe(MAX_PARTS_IN_FLIGHT + 1); // one ack, one more part
    // Ack everything from here: it runs to the end.
    while (!replies.some((r) => r.type === 'done' || r.type === 'error')) {
      service({ type: 'ack' });
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(replies.at(-1)!.type).toBe('done');
    const bytes = replies.reduce((n, r) => n + (r.type === 'part' ? r.bytes.byteLength : 0), 0);
    expect(bytes).toBe(44 + j.frames * 6);
  });

  it('the last part needs no ack: a render that ends at the in-flight limit still says done (final P2)', async () => {
    const j = job();
    j.frames = (MAX_PARTS_IN_FLIGHT - 1) * 48000; // the header + 3 one-second parts = exactly the limit
    const replies: WorkerReply[] = [];
    const service = renderService((r) => replies.push(r));
    service({ type: 'render', wasm: wasmBytes(), job: j }); // never acked
    await vi.waitFor(() => expect(replies.at(-1)?.type).toBe('done'), { timeout: 2000 });
    expect(replies.filter((r) => r.type === 'part')).toHaveLength(MAX_PARTS_IN_FLIGHT);
  });

  it('audio render matches native', () => {
    const j = parseJob(fixture('export_audio.txt'));
    const { left, right } = renderSong(wasmBytes(), j);
    expect(left.length).toBe(j.frames);
    expect(left.some((x) => Math.abs(x) > 0.01)).toBe(true);
    const golden = fixture('export_audio.hash').trim();
    expect(fnv1a32(left, right).toString(16).padStart(8, '0')).toBe(golden);
  });

  it('export_audio.txt is the export command list of the audio test project, frozen', async () => {
    // engine/tests/export_render.rs renders this file natively; it must stay
    // what exportCommands builds for project/testFixture.ts buildAudioFixture
    // (2 Audio tracks: a loop clip, a trimmed and faded clip, a sidechained
    // strip). Regenerate after an intended change with UPDATE_FIXTURE=1, then
    // UPDATE_GOLDEN=1 cargo test -p daw-engine --test export_render.
    const { p, ids } = await buildAudioFixture();
    const json = serialize(p);
    const rate = 48000;
    const lines = [
      '# Fixed render job shared by engine/tests/export_render.rs (native) and',
      '# app/src/export/render.test.ts (engine.wasm), like export_render.txt.',
      '# Frozen: the export command list (exportCommands) of the audio test',
      '# project (project/testFixture.ts buildAudioFixture: 2 Audio tracks -- a',
      '# loop clip of a mono sample, a missing-sample clip, a trimmed and faded',
      '# clip of a stereo sample on a strip sidechained from the first -- 120 BPM,',
      '# Song mode). Sample data is generated (see export_render.rs); the lengths',
      '# match the fixture\'s sampleMeta (0.5 s mono, 1 s stereo at 48 kHz).',
      `sample_rate ${rate}`,
      `frames ${exportFrames(json, rate)}`,
      `sample ${ids[0]} ${rate / 2} 1 11`,
      `sample ${ids[1]} ${rate} 2 12`,
      ...exportCommands(json, new Map(json.samples.map((s) => [s.id, s.id]))).commands.map(
        ([op, a = 0, b = 0, c = 0, d = 0]) => `cmd ${op} ${a} ${b} ${c} ${d}`,
      ),
    ];
    const text = `${lines.join('\n')}\n`;
    if (process.env.UPDATE_FIXTURE) writeFileSync(new URL('../../../engine/tests/fixtures/export_audio.txt', import.meta.url), text);
    expect(fixture('export_audio.txt')).toBe(text);
  });
});
