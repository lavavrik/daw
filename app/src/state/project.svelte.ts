// Reactive project state (Svelte 5 runes). Mutate only through actions.ts so
// every UI edit is mirrored to the audio engine.

/** Must match engine/src/lib.rs (parity-checked by audio/protocol.test.ts). */
export const MAX_STEPS = 64;
export const MAX_ROWS = 16;
export const MAX_TRACKS = 32;
/** Bars in a new synth track's pattern (1..MAX_PATTERN_BARS). */
export const DEFAULT_PATTERN_BARS = 4;
/** Engine sample slots; sample ids are never reused within a session. */
export const MAX_SAMPLES = 256;

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
  kind: 'drum';
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

/** One module in a synth track's rack; `idx` is the engine module slot (0..31). */
export interface RackModule {
  idx: number;
  /** Numeric kind from engine/catalog.json. */
  kind: number;
  /** Full param array in catalog order (defaults filled in). */
  params: number[];
}

/** A cable from output `from.port` of module `from.m` to input `to.port` of `to.m`. */
export interface RackCable {
  from: { m: number; port: number };
  to: { m: number; port: number };
}

/** One sequenced note. `idx` is the engine note slot (0..MAX_NOTES-1) within the track. */
export interface Note {
  id: string;
  idx: number;
  /** 0..127 */
  pitch: number;
  /** 1..127 */
  vel: number;
  /** Ticks from pattern start (960 PPQ). */
  start: number;
  /** Ticks, 1..61440. */
  len: number;
}

export interface SynthTrack {
  kind: 'synth';
  id: string;
  /** Engine track slot, shared with drum tracks. */
  slot: number;
  name: string;
  color: string;
  patchName: string;
  modules: RackModule[];
  cables: RackCable[];
  /** Looping note pattern; notes at/after bars*BAR_TICKS are kept but do not play. */
  pattern: { bars: number; notes: Note[] };
}

export type Track = DrumTrack | SynthTrack;

export class Project {
  tempo = $state(124);
  metronome = $state(false);
  playing = $state(false);
  tracks = $state<Track[]>([]);
  selectedTrackId = $state<string | null>(null);
  /** Most recently selected synth track; keeps receiving keys while a drum track is selected. */
  lastSynthTrackId = $state<string | null>(null);
  nextSampleId = $state(0);
}

/** The synth track with this id, or null (unknown id or a drum track). */
export function synthTrack(p: Project, trackId: string): SynthTrack | null {
  const t = p.tracks.find((x) => x.id === trackId);
  return t && t.kind === 'synth' ? t : null;
}
