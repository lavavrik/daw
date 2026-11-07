import { describe, expect, it } from 'vitest';
import { Err, HostErr, MAX_ARENA_FLOATS } from '../audio/protocol';
import { Project } from './project.svelte';
import { importSample } from './sampleImport';
import { addAudioClip, addAudioTrack } from './audio-actions';
import { blankState, loadProject } from '../project/load';
import { serialize } from '../project/serialize';
import { fakeEngine } from '../project/testFixture';

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
    expect(r).toEqual({ ok: false, error: 'Couldn\'t load "kick.wav" — not enough sample memory (1 GB limit; removed samples free on reopen)' });
    expect(p.sampleFiles.size).toBe(0);
    expect((await importSample(p, engine(HostErr.ENGINE_STOPPED).e, wav(), () => true)).ok).toBe(false);
  });

  it('target gone or a project load started meanwhile: silently dropped (busy: the same session may outlive the load)', async () => {
    const p = new Project();
    expect(await importSample(p, engine(Err.OK).e, wav(), () => false)).toEqual({ ok: false, error: null });
    p.loading = true;
    expect(await importSample(p, engine(Err.OK).e, wav(), () => true)).toEqual({ ok: false, error: null, busy: true });
    expect(p.sampleFiles.size).toBe(0);
  });

  it('a project load that started (or even finished) during the upload: the result never touches the new session (M5)', async () => {
    for (const finished of [false, true]) {
      const p = new Project();
      let answer!: (code: number) => void;
      const e = { ...engine(Err.OK).e, loadSample: () => new Promise<number>((r) => (answer = r)) };
      const importing = importSample(p, e, wav(), () => true);
      await expect.poll(() => answer).toBeDefined(); // the upload is in flight
      // New / Open / Restore: loadProject blanks the session (blankState).
      p.loading = true;
      blankState(p);
      if (finished) {
        p.loading = false;
        p.sampleFiles.set(0, { name: 'new.wav', type: 'audio/wav', bytes: new ArrayBuffer(1), hash: 'aaaaaaaa' });
        p.nextSampleId = 1;
      }
      answer(Err.OK); // the old session's upload landed before the reset
      expect(await importing).toEqual({ ok: false, error: null });
      expect(p.sampleFiles.get(0)?.name ?? null).toBe(finished ? 'new.wav' : null);
      expect(p.nextSampleId).toBe(finished ? 1 : 0);
    }
  });

  it('an audio restart during the decode or the upload: "drop it again", never a misleading error or a silent drop', async () => {
    // Restart running while the decode finishes.
    const p = new Project();
    const { e } = engine(Err.OK);
    const dec = e.context.decodeAudioData;
    e.context.decodeAudioData = async (b: ArrayBuffer) => {
      p.restarting = true;
      p.loading = true;
      return dec(b);
    };
    const again = { ok: false, error: 'Audio restarted — drop "kick.wav" again', busy: true };
    expect(await importSample(p, e, wav(), () => true)).toEqual(again);
    // The old context closed under the decode (it rejects): same message, not "not readable".
    const p2 = new Project();
    const e2 = engine(Err.OK).e;
    e2.context.decodeAudioData = async () => {
      p2.audioRestarts++;
      throw new Error('context closed');
    };
    expect(await importSample(p2, e2, wav(), () => true)).toEqual(again);
    // A restart finished during the upload to the old engine (ENGINE_STOPPED).
    const p3 = new Project();
    const e3 = engine(HostErr.ENGINE_STOPPED).e;
    const load = e3.loadSample;
    e3.loadSample = async (id: number) => {
      p3.audioRestarts++;
      return load(id);
    };
    expect(await importSample(p3, e3, wav(), () => true)).toEqual(again);
    expect(p3.sampleFiles.size).toBe(0);
  });

  it('records the sample length and channels (sampleMeta) and counts its floats', async () => {
    const p = new Project();
    const v = p.peaksVersion;
    const r = await importSample(p, engine(Err.OK).e, new File([new Uint8Array(4800)], 'a.wav', { type: 'audio/wav' }), () => true);
    expect(r.ok).toBe(true);
    expect(p.sampleMeta.get(0)).toMatchObject({ seconds: 0.1, channels: 1 });
    // Waveform peaks, computed before the upload took the channels: 4800 frames = 19 pairs.
    expect(p.sampleMeta.get(0)!.peaks!.levels[0][0]).toHaveLength(2 * 19);
    expect(p.peaksVersion).toBeGreaterThan(v);
    expect(p.arenaFloats).toBe(4800);
  });

  it('import over the sample budget is refused', async () => {
    const p = new Project();
    const sink = { send: () => true };
    const t = addAudioTrack(p, sink)!;
    p.arenaFloats = MAX_ARENA_FLOATS - 3; // 4 floats (the fake file) do not fit
    const { e, loads } = engine(Err.OK);
    const r = await importSample(p, e, wav('long.wav'), () => true);
    expect(r).toEqual({
      ok: false,
      error: 'long.wav needs 1 MB of sample memory; 0 MB is free (1 GB limit). Removed samples are freed when the project is reopened.',
    });
    expect(loads).toEqual([]); // checked after the decode, before any upload
    expect(p.sampleFiles.size).toBe(0);
    expect(p.nextSampleId).toBe(0); // no id taken
    expect(p.arenaFloats).toBe(MAX_ARENA_FLOATS - 3);
    // The caller only places a clip for an ok result: nothing is placed.
    if (r.ok) addAudioClip(p, sink, t.id, { sampleId: r.id, start: 0 });
    expect(t.clips).toEqual([]);
  });

  it('an upload the engine refuses gives its floats back', async () => {
    const p = new Project();
    await importSample(p, engine(Err.OUT_OF_MEMORY).e, wav(), () => true);
    expect(p.arenaFloats).toBe(0);
  });

  it('budget counts leaked samples until reload', async () => {
    const p = new Project();
    const sink = { send: () => true };
    const t = addAudioTrack(p, sink)!;
    const file = (n: number, name: string) => new File([new Uint8Array(n)], name, { type: 'audio/wav' });
    const a = await importSample(p, engine(Err.OK).e, file(100, 'a.wav'), () => true);
    const b = await importSample(p, engine(Err.OK).e, file(30, 'b.wav'), () => true);
    if (!a.ok || !b.ok) throw new Error('import');
    // Sample a is replaced by b: the arena keeps a's space (a bump allocator).
    const c = addAudioClip(p, sink, t.id, { sampleId: b.id, start: 0 })!;
    expect(c.sampleId).toBe(b.id);
    expect(p.arenaFloats).toBe(130);
    // A reload re-uploads only what the project uses: a's space is free again.
    const json = JSON.parse(JSON.stringify(serialize(p)));
    const bytes = new Map(json.samples.map((s: { id: number; file: string }) => [s.file, p.sampleFiles.get(s.id)!.bytes]));
    const ctx = engine(Err.OK).e.context;
    await loadProject(p, fakeEngine(), json, bytes as Map<string, ArrayBuffer>, ctx);
    expect(p.arenaFloats).toBe(30);
    expect(p.sampleMeta.get(0)?.seconds).toBeCloseTo(30 / 48000, 12);
  });
});
