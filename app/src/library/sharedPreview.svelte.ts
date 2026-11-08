// One preview player for the whole app (library/preview.ts underneath): the
// Browser's library and kit samples and the step grid's row samples all play
// through it, so only one preview sounds at a time and the Browser's preview
// bar (always visible) shows whichever is playing, with ■ Stop.
//
// Keys say where a preview came from: a library path ("drums/kick.wav"),
// "kit:<file>" for the starter kit, "row:<sampleId>" for a project sample.
// `label` is what the bar shows.
//
// The preview plays on the engine's AudioContext, straight to its
// destination (not through the engine). An audio restart closes that
// context: bind() with the new engine drops the old player.
import type { AudioEngine } from '../audio/engine';
import { createPreview } from './preview';
import type { Preview } from './preview';

export const previewState = $state<{ key: string | null; label: string | null }>({ key: null, label: null });

let player: Preview | null = null;
let boundTo: AudioEngine | null = null;
let pendingLabel: string | null = null;

/** Use `engine`'s context from now on (a different engine stops and drops the old player). */
export function bindPreview(engine: AudioEngine) {
  if (boundTo === engine) return;
  player?.stop();
  player = null;
  previewState.key = null;
  previewState.label = null;
  boundTo = engine;
}

function pv(): Preview {
  if (!boundTo) throw new Error('preview used before bindPreview');
  return (player ??= createPreview(boundTo.context, (k) => {
    previewState.key = k;
    if (k === null) previewState.label = null;
    else if (pendingLabel !== null) previewState.label = pendingLabel;
  }));
}

/** Start (or, when `key` is already playing, stop) a preview. Rejects like Preview.play. */
export async function togglePreview(key: string, label: string, load: () => Promise<Blob>): Promise<void> {
  if (previewState.key === key) return stopPreview();
  pendingLabel = label;
  // The preview plays on the engine's context: ask it to run (a no-op once it
  // does; still paused before the page's first gesture). Not awaited: Chrome
  // keeps the request pending until a gesture allows it.
  boundTo?.resume().catch(() => {});
  await pv().play(key, load);
}

export function stopPreview() {
  player?.stop();
}

/** Forget decoded audio (a rescanned library may hold other bytes at the same paths). */
export function clearPreviewCache() {
  player?.clearCache();
}
