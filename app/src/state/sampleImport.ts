// Copying an audio file into the project: the one path for a Finder drop
// and a library drag, onto a step-grid row, "+ Add row" or a SamplePlayer.
//
// Decode first (a failed drop leaves state unchanged), then check the drop
// target still exists (`stillThere`: the track or module may have been
// removed during the decode, or a project load started), then load it into
// the next sample id; a session replaced during that upload (Project.generation)
// drops the result. The file's original bytes are kept in p.sampleFiles so
// a project save writes them unchanged (decoding gets a copy:
// decodeAudioData detaches its input). The caller attaches the id: at once,
// or for `deferred` (dropped while playing, Err.DEFERRED) through
// sampleLoads.ts once playback stops.
//
// An audio restart (audio/restart.ts) that overlaps the decode or the
// upload (the old context may close under the decode; the old engine may
// close before it answers) ends the import with "Audio restarted — drop it
// again": the bytes never reached the new engine.
//
// `busy` marks a failure that only says the project was busy (an audio
// restart, or Project.loading with the session still the same one: an
// autosave restore still reading, which may fail and leave it). The same
// file can be imported again once that is over; the default kit does
// (state/defaultKit.ts), a drop just reports it / drops it as before.
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
  /** `error` null: dropped silently (its target or session is gone, or the project was busy). */
  | { ok: false; error: string | null; busy?: true };

export async function importSample(
  p: Project, engine: ImportEngine, file: File, stillThere: () => boolean,
): Promise<ImportResult> {
  const unreadable = { ok: false, error: `Couldn't load "${file.name}" — not a readable audio file` } as const;
  if (!isProbablyAudio(file)) return unreadable;
  const restarts = p.audioRestarts;
  const again = { ok: false, error: `Audio restarted — drop "${file.name}" again`, busy: true } as const;
  const restarted = () => p.restarting || p.audioRestarts !== restarts;
  let bytes: ArrayBuffer;
  let channels: Float32Array[];
  try {
    bytes = await file.arrayBuffer();
    channels = await decodeBytes(bytes.slice(0), file.name, engine.context);
  } catch {
    return restarted() ? again : unreadable;
  }
  const kept = await sampleFile(file.name, file.type, bytes); // hashed async, before the id is taken
  if (restarted()) return again;
  // A project load started meanwhile: this drop belonged to the old session.
  if (!stillThere()) return { ok: false, error: null };
  if (p.loading) return { ok: false, error: null, busy: true };
  if (p.nextSampleId >= MAX_SAMPLES) return { ok: false, error: `Sample limit reached (${MAX_SAMPLES} loads per session)` };
  const gen = p.generation;
  const id = p.nextSampleId++;
  const code = await engine.loadSample(id, channels);
  if (restarted()) return again; // uploaded to the old engine (or refused by it, closed)
  // A New / Open / Restore started (or finished) during the upload: the id
  // belonged to the old session (RESET_ALL dropped the sample); the new
  // session's id `id` is someone else's. Drop it silently.
  if (p.generation !== gen) return { ok: false, error: null };
  if (p.loading) return { ok: false, error: null, busy: true };
  if (code !== Err.OK && code !== Err.DEFERRED) {
    return { ok: false, error: `Couldn't load "${file.name}" — ${loadErrorText(code, engine.sampleRate)}` };
  }
  p.sampleFiles.set(id, kept);
  return { ok: true, id, name: baseName(file.name), deferred: code === Err.DEFERRED };
}
