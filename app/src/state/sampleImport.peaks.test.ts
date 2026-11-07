// A peaks Worker that fails after taking a sample's channel buffers must not
// lose the sample: import and load decode it again from the kept bytes and
// go on with no peaks (the lane draws a flat placeholder). audio/peaks.ts is
// mocked here so its peaksFor reports that failure for every file.
import { describe, expect, it, vi } from 'vitest';
import { Err } from '../audio/protocol';
import { Project } from './project.svelte';
import { importSample } from './sampleImport';
import { loadProject } from '../project/load';
import { serialize } from '../project/serialize';
import { buildFixture, fakeDecoder, fakeEngine } from '../project/testFixture';

vi.mock('../audio/peaks', () => ({
  // What peaksFor gives when the worker died with the buffers: nothing back.
  peaksFor: async (channels: Float32Array[]) => {
    for (const c of channels) structuredClone(c.buffer, { transfer: [c.buffer] }); // detached, like a transfer
    return { peaks: null, channels: null };
  },
}));

describe('a peaks worker failure keeps the sample', () => {
  it('import decodes again from the kept bytes and uploads with no peaks', async () => {
    const p = new Project();
    let decodes = 0;
    const uploaded: number[] = [];
    const e = {
      sampleRate: 48000,
      context: {
        decodeAudioData: async () => (decodes++, { length: 4800, numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(4800) }) as unknown as AudioBuffer,
      },
      loadSample: async (_id: number, channels: Float32Array[]) => (uploaded.push(channels[0].length), Err.OK),
    };
    const r = await importSample(p, e, new File([new Uint8Array([1, 2, 3])], 'long.wav', { type: 'audio/wav' }), () => true);
    expect(r).toMatchObject({ ok: true, id: 0 });
    expect(decodes).toBe(2);
    expect(uploaded).toEqual([4800]); // whole channels, not detached ones
    expect(p.sampleMeta.get(0)).toEqual({ seconds: 0.1, channels: 1, peaks: null });
  });

  it('load decodes again too', async () => {
    const { p: src } = await buildFixture();
    const json = JSON.parse(JSON.stringify(serialize(src)));
    const files = new Map<string, ArrayBuffer>(json.samples.map((s: { file: string; id: number }) => [s.file, src.sampleFiles.get(s.id)!.bytes]));
    const p = new Project();
    const e = fakeEngine();
    const warnings = await loadProject(p, e, json, files, fakeDecoder);
    expect(warnings).toEqual([]);
    expect(p.sampleMeta.size).toBe(json.samples.length);
    for (const m of p.sampleMeta.values()) expect(m.peaks).toBeNull();
    for (const m of p.sampleMeta.values()) expect(m.seconds).toBeGreaterThan(0);
  });
});
