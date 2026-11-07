// Audio files dropped on the timeline (plan 9; the UI side is
// ui/song/Timeline.svelte, which resolves the target with tlMath.dropTarget):
// every file is imported first, one at a time and in order
// (sampleImport.ts: decode, budget, peaks, upload; a failed one sets the
// error banner and is skipped), then the track (new when `trackId` is null)
// and all clips are placed in ONE edit, one after another from `start`, so
// one undo takes the whole drop back.
//
// Dropped while playing: a load the engine parks (DEFERRED) is registered
// with sampleLoads.ts RIGHT AFTER its import, not after the whole drop: a
// Stop during a later file's import settles it, and a registration after
// that would wait forever (a stuck notice, a clip hatched for good). Its clip
// is placed at once on the sample id (the engine chases it in when it
// lands). If the load fails, the clip keeps its id but is marked failed
// (sampleLoads.sampleFailed: drawn as such) and the banner says which track
// went silent.
import type { CommandSink } from './actions';
import { addAudioClip, addAudioTrack } from './audio-actions';
import { banners } from './banners.svelte';
import { edit } from './edits';
import { MAX_SONG_TICKS } from '../audio/protocol';
import type { AudioClip, AudioTrack, Project } from './project.svelte';
import { importSample } from './sampleImport';
import type { ImportEngine } from './sampleImport';
import { deferSampleAssign } from './sampleLoads';

export interface DropResult {
  /** The track the clips went to (null: no free track slot for a new one, or the target lane was removed during the import: the UI says so). */
  track: AudioTrack | null;
  /** The clips placed, in order (fewer than imported when the lane or song ran out). */
  placed: AudioClip[];
  /** Files imported (placed or not). */
  imported: number;
}

/** Drop `files` on Audio track `trackId` (null: a new one) from tick `start`. */
export async function dropAudioFiles(
  p: Project, engine: CommandSink & ImportEngine, files: File[], trackId: string | null, start: number,
): Promise<DropResult> {
  const none: DropResult = { track: null, placed: [], imported: 0 };
  const gen = p.generation;
  const alive = () => p.generation === gen && (trackId === null || p.tracks.some((t) => t.id === trackId));
  const loaded: { id: number; name: string }[] = [];
  for (const f of files) {
    const r = await importSample(p, engine, f, alive);
    if (!r.ok) {
      if (r.error) banners.error = r.error;
      continue;
    }
    loaded.push(r);
    if (r.deferred) deferSampleAssign(r.id, r.name, () => p.peaksVersion++, (id) => failedLoad(p, id, r.name));
  }
  if (!loaded.length || !alive() || p.loading) return { ...none, imported: loaded.length };
  let track = null as AudioTrack | null; // set inside the edit
  const placed = edit(p, loaded.length > 1 ? 'Drop audio files' : 'Drop audio file', () => {
    const t = trackId ? p.tracks.find((x) => x.id === trackId) ?? null : addAudioTrack(p, engine);
    if (!t || t.kind !== 'audio') return [];
    track = t;
    const out: AudioClip[] = [];
    let at = start;
    for (const r of loaded) {
      if (at >= MAX_SONG_TICKS) break;
      const c = addAudioClip(p, engine, t.id, { sampleId: r.id, start: at });
      if (!c) break; // 256 clips on this lane
      out.push(c);
      at = c.start + c.len;
    }
    return out;
  });
  if (placed.length && loaded.length === files.length) banners.error = null; // a stale import error is moot now
  return { track, placed, imported: loaded.length };
}

/** A deferred load failed: redraw its clips as failed and say which track went silent. */
function failedLoad(p: Project, id: number, name: string) {
  p.peaksVersion++;
  const t = p.tracks.find((x) => x.kind === 'audio' && x.clips.some((c) => c.sampleId === id));
  if (t) banners.error = `Couldn't load "${name}" — its clip on ${t.name} is silent; stop and drop it again`;
}
