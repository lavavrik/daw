// Library drags: a sample dragged out of the Browser carries its library
// path under a private MIME type (no 'Files', no text/plain: the window-level
// drop guard in App.svelte ignores it, and dropping it on a text field or
// outside the app does nothing). Drop targets (step-grid rows, "+ Add row",
// a SamplePlayer) take Finder files and library samples through
// droppedFiles(), then import them the same way (state/sampleImport.ts).
import { LibraryLostError, library } from './library.svelte';

export const LIB_SAMPLE_MIME = 'application/x-daw-library-sample';

export function startLibraryDrag(e: DragEvent, path: string) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(LIB_SAMPLE_MIME, path);
  e.dataTransfer.effectAllowed = 'copy';
}

/** The drag carries Finder files or a library sample (dragenter/over: data is not readable yet). */
export function isSampleDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types ?? [];
  return types.includes('Files') || types.includes(LIB_SAMPLE_MIME);
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
  const files = [...dt.files];
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
