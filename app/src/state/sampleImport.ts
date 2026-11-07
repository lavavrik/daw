// Copying an audio file into the project: the one path for a Finder drop
// and a library drag, onto a step-grid row, "+ Add row" or a SamplePlayer.
//
// Decode first (a failed drop leaves state unchanged), then check the drop
// target still exists (`stillThere`: the track or module may have been
// removed during the decode, or a project load started), then load it into
// the next sample id. The file's original bytes are kept in p.sampleFiles so
// a project save writes them unchanged (decoding gets a copy:
// decodeAudioData detaches its input). The caller attaches the id: at once,
// or for `deferred` (dropped while playing, Err.DEFERRED) through
// sampleLoads.ts once playback stops.
import { Err } from '../audio/protocol';
import { baseName, decodeBytes, isProbablyAudio, loadErrorText } from '../audio/samples';
import type { SampleDecoder } from '../audio/samples';
import { MAX_SAMPLES } from './project.svelte';
import type { Project } from './project.svelte';
import { sampleFile } from './sampleFiles';

/** The slice of AudioEngine an import needs (tests pass a fake). */
export interface ImportEngine {
  readonly context: SampleDecoder;
  readonly sampleRate: number;
  loadSample(id: number, channels: Float32Array[]): Promise<number>;
}

export type ImportResult =
  | { ok: true; id: number; name: string; deferred: boolean }
  /** `error` null: dropped silently (its target or session is gone). */
  | { ok: false; error: string | null };

export async function importSample(
  p: Project, engine: ImportEngine, file: File, stillThere: () => boolean,
): Promise<ImportResult> {
  const unreadable = { ok: false, error: `Couldn't load "${file.name}" — not a readable audio file` } as const;
  if (!isProbablyAudio(file)) return unreadable;
  let bytes: ArrayBuffer;
  let channels: Float32Array[];
  try {
    bytes = await file.arrayBuffer();
    channels = await decodeBytes(bytes.slice(0), file.name, engine.context);
  } catch {
    return unreadable;
  }
  // A project load started meanwhile: this drop belonged to the old session.
  if (p.loading || !stillThere()) return { ok: false, error: null };
  if (p.nextSampleId >= MAX_SAMPLES) return { ok: false, error: `Sample limit reached (${MAX_SAMPLES} loads per session)` };
  const id = p.nextSampleId++;
  const code = await engine.loadSample(id, channels);
  if (code !== Err.OK && code !== Err.DEFERRED) {
    return { ok: false, error: `Couldn't load "${file.name}" — ${loadErrorText(code, engine.sampleRate)}` };
  }
  p.sampleFiles.set(id, sampleFile(file.name, file.type, bytes));
  return { ok: true, id, name: baseName(file.name), deferred: code === Err.DEFERRED };
}
