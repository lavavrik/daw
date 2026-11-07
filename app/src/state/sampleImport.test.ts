import { describe, expect, it } from 'vitest';
import { Err, HostErr } from '../audio/protocol';
import { Project } from './project.svelte';
import { importSample } from './sampleImport';
import { blankState } from '../project/load';

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
});
