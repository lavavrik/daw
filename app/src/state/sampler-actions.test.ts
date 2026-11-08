import { describe, expect, it } from 'vitest';
import { moduleDef, paramIndex } from '../audio/catalog';
import { Err, MAX_ARENA_FLOATS } from '../audio/protocol';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';
import { TRACKS_FULL_TEXT, removeTrack } from './actions';
import { banners } from './banners.svelte';
import { installSampleLoads, pendingSampleLoads } from './sampleLoads';
import { MAX_SAMPLES, Project } from './project.svelte';
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

  it('is one undo entry: undo removes the whole track, redo brings it back with the sample', async () => {
    const p = new Project();
    const e = engine();
    const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, e, from, to) });
    p.history = h;
    await addSamplerTrack(p, e, wav('k.wav'));
    expect(p.tracks).toHaveLength(1);
    h.undo();
    expect(p.tracks).toHaveLength(0);
    h.redo();
    expect(p.tracks).toHaveLength(1);
    const sp = (p.tracks[0] as SynthTrack).modules.find((m) => m.kind === moduleDef('sample_player').kind)!;
    expect(p.tracks[0].name).toBe('k');
    expect(sp.params[SAMPLE]).toBe(0);
    expect(h.labels.undo).toBe('Add sampler track');
    expect(h.undo() && h.labels.undo).toBeNull(); // nothing else was recorded
  });

  it('deferred load: track made on sample -1, assigned when the load settles', async () => {
    const p = new Project();
    const e = Object.assign(engine(Err.DEFERRED), { onSampleLoaded: undefined as ((id: number, c: number) => void) | undefined });
    installSampleLoads(p, e);
    const t = (await addSamplerTrack(p, e, wav('d.wav')))!;
    const sp = () => t.modules.find((m) => m.kind === moduleDef('sample_player').kind)!;
    expect(sp().params[SAMPLE]).toBe(-1);
    expect(pendingSampleLoads()).toBe(1);
    e.onSampleLoaded!(0, Err.OK);
    expect(sp().params[SAMPLE]).toBe(0);
    expect(pendingSampleLoads()).toBe(0);
  });

  it('deferred load: removing the track before it settles does not throw', async () => {
    const p = new Project();
    const e = Object.assign(engine(Err.DEFERRED), { onSampleLoaded: undefined as ((id: number, c: number) => void) | undefined });
    installSampleLoads(p, e);
    const t = (await addSamplerTrack(p, e, wav('d.wav')))!;
    removeTrack(p, e, t.id);
    expect(() => e.onSampleLoaded!(0, Err.OK)).not.toThrow();
  });

  it('refusals (sample limit, sample budget) add no track and set the error banner', async () => {
    for (const setup of [
      (p: Project) => { p.nextSampleId = MAX_SAMPLES; },
      (p: Project) => { p.arenaFloats = MAX_ARENA_FLOATS; },
    ]) {
      const p = new Project();
      setup(p);
      banners.error = null;
      expect(await addSamplerTrack(p, engine(), wav('big.wav'))).toBeNull();
      expect(p.tracks).toHaveLength(0);
      expect(banners.error).toBeTruthy();
    }
  });

  it('tracks filled up during the decode: null, no extra track, the full text', async () => {
    const p = new Project();
    const e = engine();
    const decode = e.context.decodeAudioData;
    e.context.decodeAudioData = async (b: ArrayBuffer) => {
      for (let i = 0; i < 32; i++) addSynthTrack(p, e);
      return decode(b);
    };
    banners.error = null;
    expect(await addSamplerTrack(p, e, wav('late.wav'))).toBeNull();
    expect(p.tracks).toHaveLength(32);
    expect(banners.error).toBe(TRACKS_FULL_TEXT);
  });

  it('a full project returns null', async () => {
    const p = new Project();
    const e = engine();
    for (let i = 0; i < 32; i++) addSynthTrack(p, e);
    expect(await addSamplerTrack(p, e)).toBeNull();
  });
});
