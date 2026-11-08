import { describe, expect, it } from 'vitest';
import { moduleDef, paramIndex } from '../audio/catalog';
import { Err } from '../audio/protocol';
import { Project } from './project.svelte';
import type { SynthTrack } from './project.svelte';
import { BUILTIN_GROUPS, SAMPLER_PATCH, validatePatch } from './patches';
import { addSamplerTrack } from './sampler-actions';
import { addSynthTrack } from './rack-actions';

function engine(code: number = Err.OK) {
  const sent: number[][] = [];
  return {
    sent,
    send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; },
    sampleRate: 48000,
    context: { decodeAudioData: async (b: ArrayBuffer) => ({ length: b.byteLength, numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(b.byteLength) }) as unknown as AudioBuffer },
    loadSample: async () => code,
  };
}
const wav = (name: string) => new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'audio/wav' });
const SAMPLE = paramIndex(moduleDef('sample_player'), 'sample');

describe('Sampler patch', () => {
  it('validates cleanly and sits in its own group after Starter', () => {
    expect(validatePatch(SAMPLER_PATCH).warnings).toEqual([]);
    expect(SAMPLER_PATCH.name).toBe('Sampler');
    expect(BUILTIN_GROUPS[1]).toEqual({ label: 'Sampler', patches: [SAMPLER_PATCH] });
  });
});

describe('addSamplerTrack', () => {
  it('without a file: a synth track with a sample_player on sample -1', async () => {
    const p = new Project();
    const t = await addSamplerTrack(p, engine());
    expect(t).not.toBeNull();
    expect(p.tracks).toHaveLength(1);
    const sp = (t as SynthTrack).modules.find((m) => m.kind === moduleDef('sample_player').kind)!;
    expect(sp.params[SAMPLE]).toBe(-1);
    expect(t!.patchName).toBe('Sampler');
  });

  it('with a file: assigns the imported id and names the track after the file', async () => {
    const p = new Project();
    const t = (await addSamplerTrack(p, engine(), wav('Kick Loop.wav')))!;
    expect(t.name).toBe('Kick Loop');
    const sp = t.modules.find((m) => m.kind === moduleDef('sample_player').kind)!;
    expect(sp.params[SAMPLE]).toBe(0);
    expect(p.sampleFiles.size).toBe(1);
  });

  it('a second drop of the same name gets a unique track name', async () => {
    const p = new Project();
    const e = engine();
    await addSamplerTrack(p, e, wav('a.wav'));
    const t = (await addSamplerTrack(p, e, wav('a.wav')))!;
    expect(t.name).toBe('a 2');
  });

  it('an unreadable file adds no track', async () => {
    const p = new Project();
    expect(await addSamplerTrack(p, engine(), new File(['x'], 'notes.txt', { type: 'text/plain' }))).toBeNull();
    expect(p.tracks).toHaveLength(0);
  });

  it('is one undo entry (no history here: one transact label)', async () => {
    const p = new Project();
    const labels: string[] = [];
    let depth = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).history = {
      settle() {},
      transact: (l: string, fn: () => unknown) => { if (!depth) labels.push(l); depth++; try { return fn(); } finally { depth--; } },
    };
    await addSamplerTrack(p, engine(), wav('k.wav'));
    expect(labels).toEqual(['Add sampler track']);
  });

  it('a full project returns null', async () => {
    const p = new Project();
    const e = engine();
    for (let i = 0; i < 32; i++) addSynthTrack(p, e);
    expect(await addSamplerTrack(p, e)).toBeNull();
  });
});
