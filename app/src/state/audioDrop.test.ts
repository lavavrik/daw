import { describe, expect, it } from 'vitest';
import { Err } from '../audio/protocol';
import { banners } from './banners.svelte';
import { Project } from './project.svelte';
import type { AudioTrack } from './project.svelte';
import { dropAudioFiles } from './audioDrop';
import { installSampleLoads, pendingSampleLoads, sampleFailed } from './sampleLoads';

/** An engine that decodes any bytes to a 0.25 s mono file and answers loads with `code(id)`. */
function engine(code: (id: number, e: { onSampleLoaded?: (id: number, code: number) => void }) => number) {
  const e = {
    sampleRate: 48000,
    onSampleLoaded: undefined as ((id: number, code: number) => void) | undefined,
    send: () => true,
    context: {
      decodeAudioData: async () => ({ length: 12000, numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(12000) }) as unknown as AudioBuffer,
    },
    loadSample: async (id: number) => code(id, e),
  };
  return e;
}
const wav = (name: string) => new File([new Uint8Array([1, 2, 3, name.length])], name, { type: 'audio/wav' });

describe('dropAudioFiles (timeline drops)', () => {
  it('places every file one after another on a new audio track, in one undo-able edit', async () => {
    const p = new Project();
    const e = engine(() => Err.OK);
    const off = installSampleLoads(p, e);
    const r = await dropAudioFiles(p, e, [wav('a.wav'), wav('b.wav')], null, 960);
    expect(r.track?.kind).toBe('audio');
    expect(r.placed.map((c) => [c.sampleId, c.start])).toEqual([[0, 960], [1, 960 + r.placed[0].len]]);
    off();
  });

  it('a multi-file drop while playing registers each deferred load as it lands (a Stop mid-drop settles it)', async () => {
    const p = new Project();
    // File 2's upload: playback stops meanwhile and the engine settles file 1's deferred load.
    const e = engine((id, eng) => {
      if (id === 1) eng.onSampleLoaded?.(0, Err.OK);
      return Err.DEFERRED;
    });
    const off = installSampleLoads(p, e);
    const r = await dropAudioFiles(p, e, [wav('a.wav'), wav('b.wav')], null, 0);
    expect(r.placed).toHaveLength(2);
    expect(pendingSampleLoads()).toBe(1); // only b still waits
    expect(banners.notice).not.toBeNull();
    e.onSampleLoaded!(1, Err.OK);
    expect(pendingSampleLoads()).toBe(0);
    expect(banners.notice).toBeNull(); // never stuck
    off();
  });

  it('a deferred load that fails marks its clip failed and says which track went silent', async () => {
    const p = new Project();
    const e = engine(() => Err.DEFERRED);
    const off = installSampleLoads(p, e);
    banners.error = null;
    const r = await dropAudioFiles(p, e, [wav('vox.wav')], null, 0);
    const t = r.track as AudioTrack;
    const v = p.peaksVersion;
    e.onSampleLoaded!(0, Err.OUT_OF_MEMORY);
    expect(sampleFailed(0)).toBe(true);
    expect(t.clips[0].sampleId).toBe(0); // kept: a save still writes it, a reopen loads it
    expect(p.peaksVersion).toBeGreaterThan(v); // the lane redraws it as failed
    expect(banners.error).toBe(`Couldn't load "vox" — its clip on ${t.name} is silent; stop and drop it again`);
    off();
  });
});
