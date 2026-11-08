// "+ Sampler track": a synth track on the Sampler patch (patches.ts), with a
// dropped sample already assigned to its Sample Player.
//
// The import (decode + upload) is async and runs BEFORE the track exists, so
// the whole thing is one undo entry ("Add sampler track") made after the
// import lands, and an unreadable file leaves no half-made track behind.
// A load that the engine parks (Err.DEFERRED, dropped while playing) assigns
// itself via sampleLoads.ts once playback stops, like a Sample Player drop.
import { moduleDef, paramIndex } from '../audio/catalog';
import { TRACKS_FULL_TEXT, uniqueTrackName } from './actions';
import { banners } from './banners.svelte';
import { edit } from './edits';
import { SAMPLER_PATCH } from './patches';
import { MAX_TRACKS } from './project.svelte';
import type { Project, SynthTrack } from './project.svelte';
import { addSynthTrack, setParam } from './rack-actions';
import type { CommandSink } from './actions';
import { importSample } from './sampleImport';
import type { ImportEngine } from './sampleImport';
import { deferSampleAssign } from './sampleLoads';

/** The track, or null (tracks full, or the file could not be imported: the banner says why). */
export async function addSamplerTrack(
  p: Project, engine: CommandSink & ImportEngine, file?: File,
): Promise<SynthTrack | null> {
  if (p.tracks.length >= MAX_TRACKS) {
    banners.error = TRACKS_FULL_TEXT;
    return null;
  }
  const spKind = moduleDef('sample_player').kind;
  const SAMPLE = paramIndex(moduleDef('sample_player'), 'sample');
  const spIdx = SAMPLER_PATCH.modules.findIndex((m) => m.id === 'sample_player');
  const generation = p.generation;

  if (!file) return edit(p, 'Add sampler track', () => addSynthTrack(p, engine, uniqueTrackName(p, 'Sampler'), SAMPLER_PATCH));

  const r = await importSample(p, engine, file, () => p.generation === generation);
  if (!r.ok) {
    if (r.error) banners.error = r.error;
    return null;
  }
  const track = edit(p, 'Add sampler track', () => {
    if (p.generation !== generation || p.tracks.length >= MAX_TRACKS) return null;
    const t = addSynthTrack(p, engine, uniqueTrackName(p, r.name), SAMPLER_PATCH);
    if (t && !r.deferred) setParam(p, engine, t.id, spIdx, SAMPLE, r.id);
    return t;
  });
  if (!track) {
    banners.error = p.tracks.length >= MAX_TRACKS ? TRACKS_FULL_TEXT : null;
    return null;
  }
  if (r.deferred) {
    const tid = track.id;
    deferSampleAssign(r.id, r.name, (id) => {
      const t = p.tracks.find((x) => x.id === tid) as SynthTrack | undefined;
      if (t?.modules.some((m) => m.idx === spIdx && m.kind === spKind)) setParam(p, engine, tid, spIdx, SAMPLE, id);
    });
  } else banners.error = null;
  return track;
}
