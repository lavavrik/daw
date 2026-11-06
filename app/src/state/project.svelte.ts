// Reactive project state (Svelte 5 runes). Mutate only through actions.ts so
// every UI edit is mirrored to the audio engine.

/** Must match engine MAX_STEPS / MAX_ROWS / MAX_TRACKS. */
export const MAX_STEPS = 64;
export const MAX_ROWS = 16;
export const MAX_TRACKS = 32;

/** 8 colours that read well on the dark UI; track colour = TRACK_COLORS[slot % 8]. */
export const TRACK_COLORS: string[] = [
  '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c',
  '#38d9a9', '#4dabf7', '#9775fa', '#f783ac',
];

export interface DrumRow {
  id: string;
  name: string; // stays "Row N" until a sample is dropped; UI shows "drop sample" while sampleId is null
  sampleId: number | null;
  gain: number;
  pan: number;
  mute: boolean;
  /** MAX_STEPS velocities, 0 = off. */
  steps: number[];
}

export interface DrumTrack {
  id: string;
  /** Engine track slot (0..MAX_TRACKS-1). */
  slot: number;
  name: string;
  color: string;
  stepCount: 16 | 32 | 64;
  swing: number;
  /** Index in this array is the engine row number (append-only for now). */
  rows: DrumRow[];
}

export class Project {
  tempo = $state(124);
  metronome = $state(false);
  playing = $state(false);
  tracks = $state<DrumTrack[]>([]);
  selectedTrackId = $state<string | null>(null);
  nextSampleId = $state(0);
}
