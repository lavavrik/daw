import { describe, expect, it } from 'vitest';
import { Err, HostErr } from '../audio/protocol';
import { Project } from './project.svelte';
import { importSample } from './sampleImport';

function engine(code: number) {
  const loads: number[] = [];
  return {
    loads,
    e: {
      sampleRate: 48000,
      context: { decodeAudioData: async (b: ArrayBuffer) => ({ length: b.byteLength, numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(b.byteLength) }) as unknown as AudioBuffer },
      loadSample: async (id: number) => (loads.push(id), code),
    },
  };
}
const wav = (name = 'kick.wav', type = 'audio/wav') => new File([new Uint8Array([1, 2, 3, 4])], name, { type });

describe('importSample (Finder drop and library drag share it)', () => {
  it('decodes, loads into the next id and keeps the original bytes', async () => {
    const p = new Project();
    const { e, loads } = engine(Err.OK);
    const r = await importSample(p, e, wav(), () => true);
    expect(r).toEqual({ ok: true, id: 0, name: 'kick', deferred: false });
    expect(loads).toEqual([0]);
    const f = p.sampleFiles.get(0)!;
    expect(f.name).toBe('kick.wav');
    expect(new Uint8Array(f.bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(p.nextSampleId).toBe(1);
  });

  it('DEFERRED is a success (attach later)', async () => {
    const p = new Project();
    const r = await importSample(p, engine(Err.DEFERRED).e, wav(), () => true);
    expect(r).toMatchObject({ ok: true, deferred: true });
    expect(p.sampleFiles.size).toBe(1);
  });

  it('not audio / engine refusal: an error text, nothing kept', async () => {
    const p = new Project();
    expect(await importSample(p, engine(Err.OK).e, wav('notes.txt', 'text/plain'), () => true)).toEqual({
      ok: false, error: 'Couldn\'t load "notes.txt" — not a readable audio file',
    });
    const r = await importSample(p, engine(Err.OUT_OF_MEMORY).e, wav(), () => true);
    expect(r).toEqual({ ok: false, error: 'Couldn\'t load "kick.wav" — not enough memory for this sample' });
    expect(p.sampleFiles.size).toBe(0);
    expect((await importSample(p, engine(HostErr.ENGINE_STOPPED).e, wav(), () => true)).ok).toBe(false);
  });

  it('target gone or a project load started meanwhile: silently dropped', async () => {
    const p = new Project();
    expect(await importSample(p, engine(Err.OK).e, wav(), () => false)).toEqual({ ok: false, error: null });
    p.loading = true;
    expect(await importSample(p, engine(Err.OK).e, wav(), () => true)).toEqual({ ok: false, error: null });
    expect(p.sampleFiles.size).toBe(0);
  });
});
