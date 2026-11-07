// Browser drags: a sample dragged out of the Browser carries its library
// path (or, from the built-in Starter kit section, its kit file name) under
// a private MIME type (no 'Files', no text/plain: the window-level drop
// guard in App.svelte ignores it, and dropping it on a text field or
// outside the app does nothing). Drop targets (step-grid rows, "+ Add row",
// a SamplePlayer) take Finder files, library and kit samples through
// droppedFiles(), then import them the same way (state/sampleImport.ts).
import { LibraryLostError, library } from './library.svelte';
import { starterSample } from './starter';

export const LIB_SAMPLE_MIME = 'application/x-daw-library-sample';
/** A starter-kit sample (library/starter.ts): its own type, so no library path can be mistaken for it. */
export const STARTER_SAMPLE_MIME = 'application/x-daw-starter-sample';

export function startLibraryDrag(e: DragEvent, path: string, mime = LIB_SAMPLE_MIME) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(mime, path);
  e.dataTransfer.effectAllowed = 'copy';
}

/** The drag carries Finder files or a Browser sample (dragenter/over: data is not readable yet). */
export function isSampleDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types ?? [];
  return types.includes('Files') || types.includes(LIB_SAMPLE_MIME) || types.includes(STARTER_SAMPLE_MIME);
}

/**
 * What a drop carries, as Files. Must be called synchronously in the drop
 * handler (the DataTransfer is emptied once the event returns); the reading
 * happens after. A library sample whose folder became unreachable resolves
 * to [] (the Browser shows "Reconnect folder"; no second message); other
 * read failures reject with a message for the error banner.
 */
export function droppedFiles(e: DragEvent): Promise<File[]> {
  const dt = e.dataTransfer;
  if (!dt) return Promise.resolve([]);
  const path = dt.getData(LIB_SAMPLE_MIME);
  const kit = dt.getData(STARTER_SAMPLE_MIME);
  const files = [...dt.files];
  if (kit) {
    return starterSample(kit).then(
      (f) => [f],
      (err: unknown) => {
        throw new Error(`Couldn't read "${kit}" from the starter kit — ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }
  if (!path) return Promise.resolve(files);
  return library.readSample(path).then(
    (f) => [f],
    (err: unknown) => {
      if (err instanceof LibraryLostError) return [];
      const name = path.slice(path.lastIndexOf('/') + 1);
      throw new Error(err instanceof Error && err.message.includes(name) ? err.message : `Couldn't read "${name}" from the library`);
    },
  );
}
