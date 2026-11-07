import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFixture, fakeDecoder, nullSink } from '../project/testFixture';
import { addDrumTrack } from '../state/actions';
import { banners } from '../state/banners.svelte';
import { Project } from '../state/project.svelte';
import { EMPTY_SONG, ExportError, exportSong } from './exportSong';
import { runExport } from './exportFlow';
import type { FlowDeps } from './exportFlow';
import { renderSong } from './render';
import type { RenderRequest } from './render';
import { fakeWorker } from './testWorker';
import { engineWasmBytes } from './testWasm';
import { encodeWav24 } from './wav';

const ctx = { ...fakeDecoder, sampleRate: 48000 };
const date = new Date(2026, 10, 7);
/** What the fake render streams: a "header" and two "data" parts. */
const wavParts = () => [new Uint8Array(44).fill(1).buffer, new Uint8Array(30).fill(2).buffer, new Uint8Array(6).fill(3).buffer];
const bytes = async (parts: BlobPart[]) => new Uint8Array(await new Blob(parts).arrayBuffer());

/**
 * A save handle whose writable behaves like Chromium's: writes go to a swap
 * file, `close` commits them to the picked file, `abort` discards them. It
 * records every write with the progress shown at that moment.
 */
function handle(name = 'Fixture 2026-11-07.wav') {
  const h = {
    name,
    writes: [] as { part: ArrayBuffer; fraction: number | undefined }[],
    committed: null as Blob | null,
    closed: false,
    aborted: false,
    removed: false,
    async createWritable() {
      return {
        write: async (part: ArrayBuffer) => void h.writes.push({ part, fraction: banners.exporting?.fraction }),
        close: async () => {
          h.closed = true;
          h.committed = new Blob(h.writes.map((w) => w.part));
        },
        abort: async () => void (h.aborted = true),
      };
    },
    async getFile() {
      return { size: h.committed?.size ?? 0 };
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
    render: vi.fn(async (_p, _c, onProgress: (f: number) => void, _s, write: (part: ArrayBuffer) => Promise<void>) => {
      for (const part of wavParts()) await write(part);
      onProgress(0.5);
      onProgress(1);
    }),
    now: () => date,
    ...o,
  } as FlowDeps & { render: ReturnType<typeof vi.fn> };
}

/** The real exportSong, on the in-thread fake worker. */
function realRender() {
  const fw = fakeWorker();
  const render: FlowDeps['render'] = (p, c, f, s, write) => exportSong(p, c, f, s, write, fw.deps);
  return { render, w: fw.w };
}

afterEach(() => {
  banners.error = banners.notice = banners.hint = null;
  banners.exporting = null;
  banners.download = null;
  vi.restoreAllMocks();
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
      render: vi.fn(async (_p, _c, onProgress: (f: number) => void, _s, write: (part: ArrayBuffer) => Promise<void>) => {
        onProgress(0.25);
        seen.push(banners.exporting!.fraction);
        for (const part of wavParts()) await write(part);
      }),
    });
    await runExport(p, ctx, d);
    expect(d.pick).toHaveBeenCalledWith('Fixture 2026-11-07.wav');
    expect(seen).toEqual([0.25]); // the banner follows the progress
    expect(h.closed).toBe(true);
    expect(await bytes([h.committed!])).toEqual(await bytes(wavParts()));
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

  it('cancel aborts the writable', async () => {
    const { p } = await buildFixture();
    const h = handle();
    const d = deps({
      pick: vi.fn(async () => h),
      render: vi.fn(
        async (_p, _c, _f, signal: AbortSignal, write: (part: ArrayBuffer) => Promise<void>) => {
          await write(wavParts()[0]); // the header is already on its way to the file
          await new Promise<void>((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))));
        },
      ),
    });
    const run = runExport(p, ctx, d);
    await vi.waitFor(() => expect(banners.exporting).not.toBeNull());
    banners.exporting!.cancel();
    await run;
    expect(banners.exporting).toBeNull();
    expect(banners.error).toBeNull();
    expect(banners.hint).toBe('Export cancelled');
    expect(h.writes.length).toBe(1);
    expect(h.aborted).toBe(true); // the written part is discarded, never committed
    expect(h.closed).toBe(false);
    expect(h.removed).toBe(true); // and the picked file, still empty, is removed
  });

  it('a failed render is a banner, and the empty file is removed', async () => {
    const { p } = await buildFixture();
    const h = handle();
    const d = deps({ pick: vi.fn(async () => h), render: vi.fn(async () => Promise.reject(new ExportError('Export failed — boom'))) });
    await runExport(p, ctx, d);
    expect(banners.error).toBe('Export failed — boom');
    expect(h.aborted).toBe(true);
    expect(h.removed).toBe(true);
    expect(banners.exporting).toBeNull();
  });

  it('one export at a time', async () => {
    const { p } = await buildFixture();
    let release!: () => void;
    const d = deps({ render: vi.fn(() => new Promise<void>((r) => (release = r))) });
    const first = runExport(p, ctx, d);
    await vi.waitFor(() => expect(banners.exporting).not.toBeNull());
    await runExport(p, ctx, d);
    expect(d.pick).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('parts are written as they arrive', async () => {
    // The real render: the file is written while the progress moves, not
    // once at the end.
    const { p } = await buildFixture();
    const h = handle();
    const { render } = realRender();
    await runExport(p, ctx, deps({ pick: vi.fn(async () => h), render }));
    expect(banners.error).toBeNull();
    expect(h.writes.length).toBeGreaterThan(4); // the header, then ~1 s parts
    const during = h.writes.map((w) => w.fraction!).filter((f) => f > 0 && f < 1);
    expect(during.length).toBeGreaterThan(2);
    expect(during.every((f, i) => i === 0 || f >= during[i - 1])).toBe(true);
    expect(h.closed).toBe(true);
    expect(banners.notice).toBe('Exported "Fixture 2026-11-07.wav"');
  });

  it('download fallback still produces the same bytes', async () => {
    const { p } = await buildFixture();
    const { render, w } = realRender();
    const blobs: Blob[] = [];
    const create = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => (blobs.push(b as Blob), create(b as Blob)));
    await runExport(p, ctx, deps({ pick: undefined, render }));
    expect(banners.download?.name).toBe('Fixture 2026-11-07.wav');
    expect(blobs.length).toBe(1);
    expect(blobs[0].type).toBe('audio/wav');
    const { job } = w.posted as RenderRequest;
    const { left, right } = renderSong(engineWasmBytes(), job);
    expect(await bytes([blobs[0]])).toEqual(await bytes([encodeWav24(left, right, job.sampleRate)]));
  });
});

