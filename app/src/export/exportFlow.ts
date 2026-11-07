// Project ▸ Export WAV… (docs/architecture/export.md): the UI flow around
// exportSong. Inline messages only (banners), never alert/confirm.
//
//   1. An empty song (no clips) is a banner at once: no save dialog, so no
//      zero-length file is ever created.
//   2. The save dialog opens first, still inside the menu click (the picker
//      needs the user gesture, which a render could outlast). It suggests
//      "<project name> <YYYY-MM-DD>.wav". Closing it exports nothing.
//      Without showSaveFilePicker the render runs and a download link
//      banner offers the file instead.
//   3. While rendering, banners.exporting shows the progress and Cancel
//      (AbortSignal -> the Worker is terminated). One export at a time.
//      With a picked file, the WAV's parts stream straight into its
//      writable as they arrive (exportSong's back-pressure keeps only a few
//      parts in memory); without one, they are collected into a Blob for
//      the download link (unavoidable: a download needs the whole file).
//   4. Done: the writable is closed, which commits the file ("Exported …"
//      notice). Cancelled or failed: the writable is aborted, so nothing
//      half-written is committed (Chromium writes to a swap file until
//      close), a hint / an error banner shows, and the picked file, still
//      empty, is removed again.
import type { SampleDecoder } from '../audio/samples';
import { serialize } from '../project/serialize';
import { banners, flashHint } from '../state/banners.svelte';
import type { Project } from '../state/project.svelte';
import { EMPTY_SONG, ExportError, exportFileName, exportSong, songEndTicks } from './exportSong';

/** The slice of FileSystemWritableFileStream the flow uses. */
export interface SaveWritable {
  write(part: ArrayBuffer): Promise<void>;
  /** Commits what was written to the file. */
  close(): Promise<void>;
  /** Discards what was written; the file keeps its previous (empty) contents. */
  abort(): Promise<void>;
}

/** The slice of FileSystemFileHandle the flow uses (tests pass a fake). */
export interface SaveHandle {
  readonly name: string;
  createWritable(): Promise<SaveWritable>;
  getFile(): Promise<{ size: number }>;
  remove?(): Promise<void>;
}

export interface FlowDeps {
  /** The save dialog: a handle, or null when the user closed it. Absent: no picker (download link). */
  pick?: (suggestedName: string) => Promise<SaveHandle | null>;
  render: typeof exportSong;
  now: () => Date;
}

type Picker = (o: object) => Promise<SaveHandle>;

/** showSaveFilePicker when the browser has it (Chromium), else undefined. */
function savePicker(): FlowDeps['pick'] {
  const show = (globalThis as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  if (typeof show !== 'function') return undefined;
  return async (suggestedName) => {
    try {
      return await show({ suggestedName, types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }] });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null; // dialog closed
      throw e;
    }
  };
}

export const defaultFlowDeps = (): FlowDeps => ({ pick: savePicker(), render: exportSong, now: () => new Date() });

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';
const message = (e: unknown) => (e instanceof ExportError ? e.message : `Export failed — ${e instanceof Error ? e.message : String(e)}`);

/** Removes a file the dialog created if nothing was written to it (best effort). */
async function removeIfEmpty(h: SaveHandle) {
  try {
    if ((await h.getFile()).size === 0) await h.remove?.();
  } catch {
    // Not removable (or already gone): leave it.
  }
}

/** Hides the download-link banner and frees its object URL. */
export function clearDownload() {
  if (banners.download) URL.revokeObjectURL(banners.download.href);
  banners.download = null;
}

/** Call from the menu click (the save dialog needs its user gesture). Never throws. */
export async function runExport(
  p: Project, ctx: SampleDecoder & { readonly sampleRate: number }, deps: FlowDeps = defaultFlowDeps(),
): Promise<void> {
  if (banners.exporting) return;
  if (songEndTicks(serialize(p)) === 0) {
    banners.error = EMPTY_SONG;
    return;
  }
  const name = exportFileName(p.name, deps.now());
  let handle: SaveHandle | null = null;
  if (deps.pick) {
    try {
      handle = await deps.pick(name);
    } catch (e) {
      banners.error = message(e);
      return;
    }
    if (handle === null) return;
  }

  const ac = new AbortController();
  banners.exporting = { fraction: 0, cancel: () => ac.abort() };
  clearDownload();
  let writable: SaveWritable | null = null;
  try {
    const parts: ArrayBuffer[] = []; // download fallback only
    const write = handle
      ? async (part: ArrayBuffer) => writable!.write(part)
      : async (part: ArrayBuffer) => void parts.push(part);
    if (handle) writable = await handle.createWritable();
    await deps.render(p, ctx, (f) => {
      if (banners.exporting) banners.exporting.fraction = f;
    }, ac.signal, write);
    if (handle) {
      const w = writable!;
      writable = null; // committed: nothing to abort from here on
      await w.close();
      banners.notice = `Exported "${handle.name}"`;
    } else {
      banners.download = { href: URL.createObjectURL(new Blob(parts, { type: 'audio/wav' })), name };
    }
  } catch (e) {
    if (isAbort(e)) flashHint('Export cancelled');
    else banners.error = message(e);
    if (writable) await (writable as SaveWritable).abort().catch(() => {}); // already errored: nothing to discard
    if (handle) await removeIfEmpty(handle);
  } finally {
    banners.exporting = null;
  }
}

