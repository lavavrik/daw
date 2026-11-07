import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFixture, fakeDecoder, nullSink } from '../project/testFixture';
import { addDrumTrack } from '../state/actions';
import { banners } from '../state/banners.svelte';
import { Project } from '../state/project.svelte';
import { EMPTY_SONG, ExportError } from './exportSong';
import { runExport } from './exportFlow';
import type { FlowDeps } from './exportFlow';

const ctx = { ...fakeDecoder, sampleRate: 48000 };
const date = new Date(2026, 10, 7);
const wav = new Blob([new Uint8Array(50)], { type: 'audio/wav' });

/** A save handle that records what was written (and whether it was removed). */
function handle(name = 'Fixture 2026-11-07.wav') {
  const h = {
    name,
    written: null as Blob | null,
    removed: false,
    async createWritable() {
      return {
        write: async (b: Blob) => void (h.written = b),
        close: async () => {},
      };
    },
    async getFile() {
      return { size: h.written?.size ?? 0 };
    },
    async remove() {
      h.removed = true;
    },
  };
  return h;
}

function deps(o: Partial<FlowDeps> = {}): FlowDeps & { render: ReturnType<typeof vi.fn> } {
  return {
    pick: vi.fn(async () => handle()),
    render: vi.fn(async (_p, _c, onProgress: (f: number) => void) => {
      onProgress(0.5);
      onProgress(1);
      return wav;
    }),
    now: () => date,
    ...o,
  } as FlowDeps & { render: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  banners.error = banners.notice = banners.hint = null;
  banners.exporting = null;
  banners.download = null;
});

describe('Export WAV… (menu flow)', () => {
  it('empty song shows message', async () => {
    const p = new Project();
    addDrumTrack(p, nullSink);
    const d = deps();
    await runExport(p, ctx, d);
    expect(banners.error).toBe(EMPTY_SONG);
    expect(d.pick).not.toHaveBeenCalled(); // no picker, so no zero-length file
    expect(d.render).not.toHaveBeenCalled();
    expect(banners.exporting).toBeNull();
  });

  it('asks where to save first (named "<project> <date>.wav"), renders, writes the file', async () => {
    const { p } = await buildFixture();
    const h = handle();
    const seen: number[] = [];
    const d = deps({
      pick: vi.fn(async () => h),
      render: vi.fn(async (_p, _c, onProgress: (f: number) => void) => {
        onProgress(0.25);
        seen.push(banners.exporting!.fraction);
        return wav;
      }),
    });
    await runExport(p, ctx, d);
    expect(d.pick).toHaveBeenCalledWith('Fixture 2026-11-07.wav');
    expect(seen).toEqual([0.25]); // the banner follows the progress
    expect(h.written).toBe(wav);
    expect(banners.notice).toBe('Exported "Fixture 2026-11-07.wav"');
    expect(banners.exporting).toBeNull();
    expect(banners.error).toBeNull();
  });

  it('closing the save dialog exports nothing', async () => {
    const { p } = await buildFixture();
    const d = deps({ pick: vi.fn(async () => null) });
    await runExport(p, ctx, d);
    expect(d.render).not.toHaveBeenCalled();
    expect(banners.error).toBeNull();
  });

  it('without showSaveFilePicker: a download link with the file name', async () => {
    const { p } = await buildFixture();
    const d = deps({ pick: undefined });
    await runExport(p, ctx, d);
    expect(banners.download?.name).toBe('Fixture 2026-11-07.wav');
    expect(banners.download?.href).toMatch(/^blob:/);
  });

  it('cancel stops the render and removes the empty file', async () => {
    const { p } = await buildFixture();
    const h = handle();
    const d = deps({
      pick: vi.fn(async () => h),
      render: vi.fn(
        (_p, _c, _f, signal: AbortSignal) =>
          new Promise<Blob>((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('x', 'AbortError')))),
      ),
    });
    const run = runExport(p, ctx, d);
    await vi.waitFor(() => expect(banners.exporting).not.toBeNull());
    banners.exporting!.cancel();
    await run;
    expect(banners.exporting).toBeNull();
    expect(banners.error).toBeNull();
    expect(banners.hint).toBe('Export cancelled');
    expect(h.removed).toBe(true);
  });

  it('a failed render is a banner, and the empty file is removed', async () => {
    const { p } = await buildFixture();
    const h = handle();
    const d = deps({ pick: vi.fn(async () => h), render: vi.fn(async () => Promise.reject(new ExportError('Export failed — boom'))) });
    await runExport(p, ctx, d);
    expect(banners.error).toBe('Export failed — boom');
    expect(h.removed).toBe(true);
    expect(banners.exporting).toBeNull();
  });

  it('one export at a time', async () => {
    const { p } = await buildFixture();
    let release!: (b: Blob) => void;
    const d = deps({ render: vi.fn(() => new Promise<Blob>((r) => (release = r))) });
    const first = runExport(p, ctx, d);
    await vi.waitFor(() => expect(banners.exporting).not.toBeNull());
    await runExport(p, ctx, d);
    expect(d.pick).toHaveBeenCalledTimes(1);
    release(wav);
    await first;
  });
});

