// Reactive project state (Svelte 5 runes). Mutate only through actions.ts so
// every UI edit is mirrored to the audio engine.
import { BAR_TICKS, STEP_TICKS } from '../audio/protocol';
import { defaultMixParams } from '../audio/mixerCatalog';

/** Must match engine/src/lib.rs (parity-checked by audio/protocol.test.ts). */
export const MAX_STEPS = 64;
export const MAX_ROWS = 16;
export const MAX_TRACKS = 32;
/** Bars in a new synth track's pattern (1..MAX_PATTERN_BARS). */
export const DEFAULT_PATTERN_BARS = 4;
/** Engine sample slots; sample ids are never reused within a session. */
export const MAX_SAMPLES = 256;
/** Default loop range: bars 1-4. */
export const DEFAULT_LOOP_END = 4 * BAR_TICKS;

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
}

/**
 * One drum pattern. `engineIdx` is the engine pattern slot (0..MAX_PATTERNS-1,
 * lowest free when created, stable for the pattern's life; never renumbered).
 */
export interface DrumPattern {
  id: string;
  engineIdx: number;
  name: string;
  stepCount: 16 | 32 | 64;
  swing: number;
  /** MAX_ROWS x MAX_STEPS velocities (0 = off); steps[r] belongs to rows[r]. */
  steps: number[][];
}

/** One synth note pattern (plan-3 NotePattern); `engineIdx` as in DrumPattern. */
export interface NotePatternState {
  id: string;
  engineIdx: number;
  name: string;
  /** Loop length in bars; notes at/after bars*BAR_TICKS are kept but do not play. */
  bars: number;
  notes: Note[];
}

/**
 * A pattern placed on the song timeline. `idx` is the engine clip slot
 * (0..MAX_CLIPS-1) within the track. The clip plays its pattern at song tick t
 * for start <= t < start+len, at pattern position (offset + t - start) mod length.
 */
export interface Clip {
  id: string;
  idx: number;
  /** A pattern of the same track. */
  patternId: string;
  start: number;
  len: number;
  /** Ticks into the pattern, 0..61439. */
  offset: number;
}

export interface DrumTrack {
  kind: 'drum';
  id: string;
  /** Engine track slot (0..MAX_TRACKS-1). */
  slot: number;
  name: string;
  color: string;
  /** Index in this array is the engine row number (append-only for now). */
  rows: DrumRow[];
  /** Never empty. Order is creation order, not engineIdx. */
  patterns: DrumPattern[];
  /** The pattern Pattern mode loops and the step grid edits (engine current pattern). */
  currentPatternId: string;
  clips: Clip[];
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
  /** Never empty. Order is creation order, not engineIdx. */
  patterns: NotePatternState[];
  /** The pattern Pattern mode loops, the piano roll edits and recording targets. */
  currentPatternId: string;
  clips: Clip[];
}

export type Track = DrumTrack | SynthTrack;

/** A sidechain source: a whole track (row null) or one drum row of a drum track. */
export interface SidechainKey {
  trackId: string;
  row: number | null;
}

/** One mixer strip (track, return or master). */
export interface ChannelState {
  /** All mixer params in catalog order (index = param id), defaults filled in. */
  params: number[];
  /** Compressor sidechain source; null = the channel's own signal. Tracks only. */
  key: SidechainKey | null;
}

export interface MixerState {
  /** Keyed by track id; created with the track, deleted with it. */
  channels: Record<string, ChannelState>;
  reverb: ChannelState;
  delay: ChannelState;
  master: ChannelState;
}

/** The original bytes of a loaded sample, kept so a save writes them unchanged. */
export interface SampleFile {
  /** Original file name with extension ("kick.wav"). */
  name: string;
  /** MIME type as the browser reported it ("" if unknown). */
  type: string;
  bytes: ArrayBuffer;
  /** contentHash(bytes) (state/sampleFiles.ts); part of the saved file name. */
  hash: string;
}

export const newChannel = (): ChannelState => ({ params: defaultMixParams(), key: null });
export const newMixer = (): MixerState => ({
  channels: {}, reverb: newChannel(), delay: newChannel(), master: newChannel(),
});

export class Project {
  /** Shown in the top bar; a Save As takes the folder's name. */
  name = $state('Untitled');
  /**
   * projectFingerprint (project/serialize.ts) at the last save, load or New;
   * null before the session starts. App keeps `dirty` = "differs from it".
   */
  savedFingerprint = $state<string | null>(null);
  /**
   * Unsaved changes ("● unsaved" in the top bar): set by every edit
   * (state/edits.ts markEdited), cleared by save/load/New and by the
   * debounced fingerprint check (project/dirtyCheck.ts).
   */
  dirty = $state(false);
  /** Bumped by every edit (markEdited). Task 4's autosave subscribes to it. */
  version = $state(0);
  /**
   * A load / New is replacing the session (project/load.ts): edits, drops,
   * shortcuts and the transport are ignored and App shows "Loading…".
   */
  loading = $state(false);
  /** Where Save writes (null: Save does a Save As). Not reactive. */
  folder: FileSystemDirectoryHandle | null = null;
  /**
   * Engine sample id -> the file it came from (not reactive). Filled on drop
   * and on load; a save writes the ones the project uses.
   */
  readonly sampleFiles = new Map<number, SampleFile>();
  tempo = $state(124);
  metronome = $state(false);
  playing = $state(false);
  tracks = $state<Track[]>([]);
  selectedTrackId = $state<string | null>(null);
  /** The bottom panel shows the Mixer tab instead of the selected track's editor. */
  mixerOpen = $state(false);
  /** Most recently selected synth track; keeps receiving keys while a drum track is selected. */
  lastSynthTrackId = $state<string | null>(null);
  nextSampleId = $state(0);
  /** Mixer strips, returns and master; edit only through mixer-actions.ts. */
  mixer = $state<MixerState>(newMixer());
  /** 'pattern': each track loops its current pattern; 'song': clips play on the timeline. */
  mode = $state<'pattern' | 'song'>('pattern');
  /** Song-mode loop range in ticks (sent to the engine only while `on`). */
  loop = $state({ on: false, start: 0, end: DEFAULT_LOOP_END });
  /** Where Song mode is parked (last seek, or the loop start after a looped Stop). */
  songPosition = $state(0);
  /**
   * Called by selectPattern just BEFORE a track's current pattern changes
   * (the engine still edits the old one). App wires it to the recorder so
   * notes held across the switch are written into the old pattern. Not reactive.
   */
  beforePatternSwitch: ((trackId: string) => void) | null = null;
}

/** The synth track with this id, or null (unknown id or a drum track). */
export function synthTrack(p: Project, trackId: string): SynthTrack | null {
  const t = p.tracks.find((x) => x.id === trackId);
  return t && t.kind === 'synth' ? t : null;
}

/** The track's current pattern (falls back to the first; patterns is never empty). */
export function currentPattern(t: DrumTrack): DrumPattern;
export function currentPattern(t: SynthTrack): NotePatternState;
export function currentPattern(t: Track): DrumPattern | NotePatternState;
export function currentPattern(t: Track): DrumPattern | NotePatternState {
  const ps: (DrumPattern | NotePatternState)[] = t.patterns;
  const pat = ps.find((x) => x.id === t.currentPatternId);
  if (!pat && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
    console.error(`currentPattern: track ${t.name} has no pattern ${t.currentPatternId} (invariant broken)`);
  }
  return pat ?? ps[0];
}

/** Pattern length in ticks (drum: stepCount sixteenths; synth: bars). */
export function patternLength(pat: DrumPattern | NotePatternState): number {
  return 'stepCount' in pat ? pat.stepCount * STEP_TICKS : pat.bars * BAR_TICKS;
}
