// Reactive project state (Svelte 5 runes). Mutate only through actions.ts so
// every UI edit is mirrored to the audio engine.
import { BAR_TICKS, STEP_TICKS } from '../audio/protocol';
import { defaultMixParams } from '../audio/mixerCatalog';
import type { History } from '../history/history';

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

/**
 * What an automation lane drives (spec addendum §3.4), by catalog NAME. The
 * channel is implied by the lane's owner: a track's lanes target its own
 * mixer strip ('mix') or its own rack ('rack', synth tracks only); a Master
 * row lane (MixerState.automation) targets its channel. Only non-integer
 * params (state/automation.ts automatableParams).
 */
export type AutoTarget = { kind: 'mix'; param: string } | { kind: 'rack'; module: number; param: string };

/**
 * One breakpoint. `idx` is the engine point slot (0..MAX_AUTO_POINTS-1) within
 * the lane; a lane's points always use idx 0..n-1 (dense), so the saved
 * order (idx order) is the engine address (state/automation-actions.ts).
 */
export interface AutoPoint {
  id: string;
  idx: number;
  /** Song tick, 0..MAX_SONG_TICKS; unique within the lane. */
  tick: number;
  /** Param units, within the catalog range. */
  value: number;
  /** Keeps its value up to the next point (else: linear in knob space to it). */
  hold: boolean;
}

/**
 * An automation lane. `lane` is the engine lane (0..MAX_AUTO_LANES-1), unique
 * across the whole project. Edit through state/automation-actions.ts.
 */
export interface AutomationLane {
  id: string;
  lane: number;
  target: AutoTarget;
  enabled: boolean;
  /** Sorted by tick. */
  points: AutoPoint[];
}

/** The mixer channels a Master row lane can target. */
export type MasterChannel = 'reverb' | 'delay' | 'master';

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
  /** Mixer-strip lanes (rack lanes: synth tracks only). */
  automation: AutomationLane[];
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
  /** Mixer-strip lanes (rack lanes: synth tracks only). */
  automation: AutomationLane[];
}

/**
 * An audio clip on an Audio track's lane (spec addendum §3.1). `idx` is the
 * engine clip slot (0..MAX_CLIPS-1) within the track, like Clip.idx. The
 * clip plays sample `sampleId` at native speed for start <= t < start+len,
 * from file position `offset + (t - start)` seconds (modulo the file length
 * when `loop`). Edits go through state/audio-actions.ts.
 */
export interface AudioClip {
  id: string;
  idx: number;
  /** Session sample id (p.sampleFiles); null: "missing sample", silent. */
  sampleId: number | null;
  /** Song ticks; start + len <= MAX_SONG_TICKS, len >= 1. */
  start: number;
  len: number;
  /** Trim start: seconds into the file (>= 0), so it does not depend on the sample rate. */
  offset: number;
  /** Loop to fill: the file repeats until the clip ends. */
  loop: boolean;
  /** dB, CLIP_GAIN_MIN_DB (= -inf, silence) .. CLIP_GAIN_MAX_DB (+12). */
  gain: number;
  /** Linear fades in song ticks; fadeIn + fadeOut <= len. */
  fadeIn: number;
  fadeOut: number;
}

/** A track of audio clips (no patterns, rows or rack); its own mixer strip. */
export interface AudioTrack {
  kind: 'audio';
  id: string;
  /** Engine track slot, shared with drum and synth tracks. */
  slot: number;
  name: string;
  color: string;
  clips: AudioClip[];
  /** Mixer-strip lanes only (an Audio slot has no rack). */
  automation: AutomationLane[];
}

export type Track = DrumTrack | SynthTrack | AudioTrack;
/** A track that plays patterns (has `patterns`, `currentPatternId` and pattern clips). */
export type PatternTrack = DrumTrack | SynthTrack;

/** Waveform peaks of one sample (computed by plan 9 Task 5's audio/peaks.ts; never saved). */
export interface Peaks {
  /** Frames per min/max pair at level 0 (256); each further level is 4x coarser. */
  framesPerPeak: number;
  /** levels[l][ch]: interleaved Int8 min/max pairs. */
  levels: Int8Array[][];
}

/** What the session knows about a loaded sample (Project.sampleMeta). */
export interface SampleMeta {
  /** File length in seconds (decoded frames / the context's rate). */
  seconds: number;
  channels: number;
  /** null until computed (the lane draws a flat placeholder). */
  peaks: Peaks | null;
}

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
  /** The Master row's lanes (returns and master), in creation order. */
  automation: { channel: MasterChannel; lane: AutomationLane }[];
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
  channels: {}, reverb: newChannel(), delay: newChannel(), master: newChannel(), automation: [],
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
   * Set and cleared through state/idle.ts markBusy / markIdle (whenIdle
   * waits for the clear).
   */
  loading = $state(false);
  /**
   * Bumped whenever the session is replaced (project/load.ts blankState):
   * async work started in an older session (a sample upload) checks it
   * before touching the project. Not reactive.
   */
  generation = 0;
  /**
   * An audio restart (audio/restart.ts) is running; `loading` is set too.
   * Lets a sample import tell it apart from a project load ("drop it again"
   * rather than a silent drop). Not reactive. Set by markBusy(p,
   * { restarting: true }), cleared by markIdle (state/idle.ts).
   */
  restarting = false;
  /**
   * Bumped by each successful audio restart: an import that decoded or
   * uploaded on the old engine checks it. Not reactive.
   */
  audioRestarts = 0;
  /**
   * A change to the session's starting point is being applied, not an edit
   * (the default kit's samples landing, state/defaultKit.ts): edits.ts marks
   * nothing (no dirty, no version bump, so no autosave) and records no undo
   * entry. Set only around a synchronous call. Not reactive.
   */
  baselining = false;
  /**
   * Bumped by every starting-point change that reaches the saved state (a
   * default-kit sample landing). A save compares it like `version`: one that
   * landed while the files were written is not in the folder. Not reactive.
   */
  baselineEpoch = 0;
  /** Where Save writes (null: Save does a Save As). Not reactive. */
  folder: FileSystemDirectoryHandle | null = null;
  /**
   * Engine sample id -> the file it came from (not reactive). Filled on drop
   * and on load; a save writes the ones the project uses.
   */
  readonly sampleFiles = new Map<number, SampleFile>();
  /**
   * Engine sample id -> its length, channels and waveform peaks (not
   * reactive: bump `peaksVersion` after a change the lanes must redraw).
   * Filled on import, load, restore and restart; cleared with the session.
   */
  readonly sampleMeta = new Map<number, SampleMeta>();
  /** Bumped when sampleMeta changes, so the audio lanes redraw. */
  peaksVersion = $state(0);
  /**
   * Sample floats uploaded into the current engine since the last load or
   * audio restart, live and replaced ones together: the engine's arena is a
   * bump allocator (state/sampleBudget.ts). Reactive: the Browser footer
   * shows it (budgetText).
   */
  arenaFloats = $state(0);
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
  /**
   * Undo/redo (history/history.ts), installed by App once audio runs; null
   * in tests that do not need it (edits then just run). Not reactive.
   */
  history: History | null = null;
}

/** Narrows to the pattern-playing kinds (drum, synth). */
export const isPatternTrack = (t: Track): t is PatternTrack => t.kind !== 'audio';

/** The synth track with this id, or null (unknown id or a drum track). */
export function synthTrack(p: Project, trackId: string): SynthTrack | null {
  const t = p.tracks.find((x) => x.id === trackId);
  return t && t.kind === 'synth' ? t : null;
}

/** The track's current pattern (falls back to the first; patterns is never empty). */
export function currentPattern(t: DrumTrack): DrumPattern;
export function currentPattern(t: SynthTrack): NotePatternState;
export function currentPattern(t: PatternTrack): DrumPattern | NotePatternState;
export function currentPattern(t: PatternTrack): DrumPattern | NotePatternState {
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
