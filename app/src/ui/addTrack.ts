// "Add a track" in one place (plan 21): the menu bar's Add menu
// (MenuBar.svelte) runs exactly what the playlist footer's add-track buttons
// run (ui/song/Timeline.svelte; Task 5 turns those buttons into one menu and
// can use this too). Every add is one undo entry (the actions' own edit()).
import type { Project } from '../state/project.svelte';
import { MAX_TRACKS } from '../state/project.svelte';
import type { CommandSink } from '../state/actions';
import { TRACKS_FULL_TEXT } from '../state/actions';
import { addKitDrumTrack } from '../state/kit-actions';
import { STARTER_KIT_ID } from '../state/kits';
import { addSynthTrack } from '../state/rack-actions';
import { addSamplerTrack } from '../state/sampler-actions';
import { addAudioTrack } from '../state/audio-actions';
import type { ImportEngine } from '../state/sampleImport';
import { STARTER_PATCHES } from '../state/patches';
import { addTransition } from '../state/transitions';
import type { TransitionKind } from '../state/transitions';
import { laneView, setOpen } from './song/laneView.svelte';
import { MASTER_ROW } from './song/tlMath';

export type AddKind = 'drum' | 'synth' | 'sampler' | 'audio' | 'master';

/** The footer's "+ Synth track" patch. */
const DEEP_BASS = STARTER_PATCHES.find((x) => x.name === 'Deep Bass') ?? STARTER_PATCHES[0];

export interface AddItem {
  kind: AddKind;
  label: string;
  title: string;
}

export const ADD_ITEMS: AddItem[] = [
  { kind: 'drum', label: 'Drum track', title: 'Add a drum track with the starter kit (as a new project has)' },
  { kind: 'synth', label: 'Synth track', title: 'Add a synth track (Deep Bass)' },
  { kind: 'sampler', label: 'Sampler track', title: 'Add a sampler track (drop a sample on its Sample Player)' },
  { kind: 'audio', label: 'Audio track', title: 'Add an audio track: drop audio files on its lane' },
  { kind: 'master', label: 'Master row', title: 'Show the Master row: automation lanes for the master, reverb and delay' },
];

/**
 * The track kinds and the Master row apart: both Add menus list the track
 * kinds, then Transition ▸ (state/transitions.ts), then the Master row.
 */
export const TRACK_ITEMS = ADD_ITEMS.filter((a) => a.kind !== 'master');
export const MASTER_ITEM = ADD_ITEMS.find((a) => a.kind === 'master')!;

/** Is the Master row on screen (it has a lane, or it was asked for)? Same rule as the timeline's masterShown. */
export const masterRowShown = (p: Project) => p.mixer.automation.length > 0 || laneView.master;

/** Why `kind` can't be added now (the item's disabled tooltip), or null. */
export function addBlocked(p: Project, kind: AddKind): string | null {
  if (kind === 'master') return masterRowShown(p) ? 'The Master row is already shown' : null;
  return p.tracks.length >= MAX_TRACKS ? TRACKS_FULL_TEXT : null;
}

/**
 * A drum track made of a built-in kit (state/kit-actions.ts addKitDrumTrack:
 * one undo entry; the track appears once its samples are in). "Drum track"
 * is the starter kit's (plan 25 review: like a new project's default track);
 * the kit choices name another.
 */
export function addKitTrack(p: Project, engine: CommandSink & ImportEngine, kitId = STARTER_KIT_ID) {
  if (addBlocked(p, 'drum')) return Promise.resolve(null);
  return addKitDrumTrack(p, engine, kitId);
}

export function addTrack(p: Project, engine: CommandSink & ImportEngine, kind: AddKind) {
  if (addBlocked(p, kind)) return;
  if (kind === 'drum') void addKitTrack(p, engine);
  else if (kind === 'synth') addSynthTrack(p, engine, undefined, DEEP_BASS);
  else if (kind === 'sampler') void addSamplerTrack(p, engine);
  else if (kind === 'audio') {
    // As the footer does: close the mixer, so the bottom panel shows the new track.
    if (addAudioTrack(p, engine)) p.mixerOpen = false;
  } else {
    laneView.master = true;
    setOpen(MASTER_ROW, true);
  }
}

/**
 * Add ▸ Transition ▸ <kind> (plan 28 Task 3; state/transitions.ts: one undo
 * entry) with its clip at the bar of `playhead` (the song playhead: the
 * AutoBus's songTick, as both menus pass it). The new track's lanes are
 * opened under its row so the sweep shows at once.
 */
export function addTransitionTrack(p: Project, engine: CommandSink, kind: TransitionKind, playhead: number) {
  const t = addTransition(p, engine, kind, playhead);
  if (t?.automation.length) setOpen(t.id, true);
  return t;
}
