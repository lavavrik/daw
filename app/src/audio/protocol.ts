// Mirror of engine/src/protocol.rs and the size/telemetry constants in
// engine/src/lib.rs (the source of truth). protocol.test.ts regex-parses the
// Rust files and fails if names or values drift.

export const Op = {
  NOTE_ON: 1,
  NOTE_OFF: 2,
  /** a=count-in ticks: 0, or BAR_TICKS for a one-bar count-in (else BAD_VALUE). */
  PLAY: 3,
  STOP: 4,
  SET_TEMPO: 5,
  SET_METRONOME: 6,
  ADD_DRUM_TRACK: 7,
  REMOVE_TRACK: 8,
  SET_ROW_SAMPLE: 9,
  SET_ROW_GAIN: 10,
  SET_ROW_PAN: 11,
  SET_ROW_MUTE: 12,
  SET_STEP: 13,
  SET_STEP_COUNT: 14,
  SET_SWING: 15,
  SET_MASTER_GAIN: 16,
  /** a=slot: make it a synth track with an empty patch. */
  ADD_SYNTH_TRACK: 17,
  /** a=slot b=module idx c=kind id (catalog.json). */
  RACK_ADD_MODULE: 18,
  /** a=slot b=module idx. */
  RACK_REMOVE_MODULE: 19,
  /** a=slot b=from c=to (ports packed with `packPort`). */
  RACK_CONNECT: 20,
  /** a=slot b=to (packed input port). */
  RACK_DISCONNECT: 21,
  /** a=slot b=module c=param d=value. */
  RACK_SET_PARAM: 22,
  /** a=slot. */
  RACK_CLEAR: 23,
  /** a=slot that receives live notes, or -1 for none. */
  SET_INPUT_TRACK: 24,
  /** a=-1..1. */
  PITCH_BEND: 25,
  /** a=0..1. */
  MOD_WHEEL: 26,
  /** a=0/1. */
  SUSTAIN: 27,
  /** a=slot*MAX_NOTES+idx b=pitch*128+vel (pitch 0..127, vel 1..127)
   *  c=start ticks (0..61439) d=length ticks (1..61440). Synth slots only. */
  NOTE_SET: 28,
  /** a=slot*MAX_NOTES+idx (releases the note if it is sounding). */
  NOTE_REMOVE: 29,
  /** a=slot: remove every note of the pattern. */
  NOTE_CLEAR: 30,
  /** a=slot b=pattern length in bars, 1..MAX_PATTERN_BARS. */
  SET_PATTERN_BARS: 31,
  // Patterns: SET_STEP, SET_STEP_COUNT, SET_SWING, NOTE_SET, NOTE_REMOVE,
  // NOTE_CLEAR and SET_PATTERN_BARS act on the track's current pattern.
  // These three take a drum or synth slot (an empty slot is BAD_INDEX).
  /** a=slot b=pattern 0..MAX_PATTERNS-1: play/edit it (synth: releases the
   *  old pattern's sounding notes; playback continues at ticks mod newPeriod). */
  SET_CURRENT_PATTERN: 32,
  /** a=slot b=from c=to: copy pattern data within one track (from == to: no-op). */
  COPY_PATTERN: 33,
  /** a=slot b=pattern: clear its steps/notes, keeping step count, swing and bars. */
  CLEAR_PATTERN_DATA: 34,
  // Song timeline: clips per track (drum or synth slot; empty slot is BAD_INDEX).
  /** a=slot*MAX_CLIPS+idx b=offset*16+pattern (offset 0..61439 ticks into the
   *  pattern) c=start ticks d=length ticks (len >= 1, start+len <= MAX_SONG_TICKS).
   *  Editing a clip releases the notes it is sounding. */
  CLIP_SET: 35,
  /** a=slot*MAX_CLIPS+idx (releases its notes). */
  CLIP_REMOVE: 36,
  /** a=slot: remove every clip of the track. */
  CLIP_CLEAR: 37,
  /** a=0 pattern / 1 song. Switching releases sequenced notes; Pattern->Song
   *  goes to the song start. */
  SET_MODE: 38,
  /** a=start ticks b=end ticks (b <= a disables the loop). */
  SET_LOOP: 39,
  /** a=song ticks 0..MAX_SONG_TICKS (Song mode only; ignored in Pattern mode). */
  SEEK: 40,
  // Mixer (engine/src/mixer). Channels: 0..31 track strips, MIX_REVERB,
  // MIX_DELAY, MIX_MASTER. Params, ranges and which channels take them:
  // engine/mixer_catalog.json.
  /** a=channel 0..MIX_CHANNELS-1 b=param id c=value (catalog range; flags 0/1).
   *  BAD_INDEX for an unknown param or one the channel does not take. */
  MIX_SET: 41,
  /** a=track channel 0..31 b=key: -1 none, slot*32 a track, slot*32+row+1 a
   *  drum row (the source must exist; a track keyed by itself is none; at most
   *  MAX_KEYS distinct rows, else BAD_VALUE). */
  MIX_SET_KEY: 42,
  /** a=channel: every param to its catalog default, key none. */
  MIX_RESET: 43,
} as const;
export type OpCode = (typeof Op)[keyof typeof Op];

export const Err = {
  OK: 0,
  UNKNOWN_OP: -1,
  BAD_INDEX: -2,
  BAD_VALUE: -3,
  DEFERRED: -4,
  OUT_OF_MEMORY: -5,
} as const;
export type ErrCode = (typeof Err)[keyof typeof Err];

/**
 * Result codes produced by the worklet / AudioEngine themselves, never by the
 * engine (so they are not in protocol.rs). Kept far from Err's range.
 */
export const HostErr = {
  /** The engine trapped (or never started): it is gone until reload. */
  ENGINE_STOPPED: -100,
  /** A deferred load was evicted from the full 32-entry retry queue. */
  QUEUE_FULL: -101,
} as const;

/** Largest block (frames) the engine renders per call (lib.rs MAX_BLOCK). */
export const MAX_BLOCK = 1024;
/** Per-sample cap, frames * channels (lib.rs MAX_SAMPLE_FLOATS). */
export const MAX_SAMPLE_FLOATS = 64 * 1024 * 1024;
/** Rack sizes (lib.rs MAX_MODULES etc.): module slots per patch, channels per
 *  cable, inputs (and separately outputs) per module, params per module. */
export const MAX_MODULES = 32;
export const MAX_POLY = 16;
export const MAX_PORTS = 8;
export const MAX_PARAMS = 12;

/** Note slots per synth track's pattern (lib.rs MAX_NOTES). */
export const MAX_NOTES = 1024;
/** Longest synth pattern in bars (lib.rs MAX_PATTERN_BARS). */
export const MAX_PATTERN_BARS = 16;
/** Patterns per track, drum and synth (lib.rs MAX_PATTERNS). */
export const MAX_PATTERNS = 16;
/** Clip slots per track on the song timeline (lib.rs MAX_CLIPS). */
export const MAX_CLIPS = 256;
/** Song length limit in ticks, 999 bars (lib.rs MAX_SONG_TICKS). */
export const MAX_SONG_TICKS = 999 * 3840;
/** Distinct drum rows usable as sidechain keys at once (lib.rs MAX_KEYS). */
export const MAX_KEYS = 8;
/** Mixer channels (lib.rs MIX_*): 0..31 are the track strips. */
export const MIX_REVERB = 32;
export const MIX_DELAY = 33;
export const MIX_MASTER = 34;
export const MIX_CHANNELS = 35;
/** Floats per channel in the meters array: peak L, peak R, gain reduction dB. */
export const MIX_METER_STRIDE = 3;
/** Sidechain key code (Op.MIX_SET_KEY b): none, a whole track, or a drum row. */
export const keyCode = (key: { slot: number; row?: number } | null): number =>
  key === null ? -1 : key.slot * 32 + (key.row === undefined ? 0 : key.row + 1);

/** Ticks per bar, 4/4 at 960 PPQ (lib.rs BAR_TICKS); also the count-in length. */
export const BAR_TICKS = 3840;
/** Ticks per drum step, a 1/16 note (lib.rs STEP_TICKS). */
export const STEP_TICKS = 240;

/** Ports per module in a packed port argument (protocol.rs PORT_STRIDE). */
export const PORT_STRIDE = 16;
/** Pack `(module, port)` into one rack-command argument: `module * 16 + port`. */
export const packPort = (module: number, port: number): number => module * PORT_STRIDE + port;

/** Indices into the telemetry Float64Array (lib.rs TELEMETRY_*). */
export const TELEMETRY = {
  blocks: 0,
  playing: 1,
  /** Playhead at the start of the next block: the song position in Song mode. */
  ticks: 2,
  cpu: 3,
  dropouts: 4,
  peakL: 5,
  peakR: 6,
  lastError: 7,
  /** Written by the worklet: the context frame at which `ticks` applies. */
  frame: 8,
} as const;
export const TELEMETRY_LEN = 9;

/** Words (f64) per command record: [op, a, b, c, d]. */
export const RECORD_WORDS = 5;
/** Record slots in the ring; one is kept empty, so usable depth is capacity - 1. */
export const RING_CAPACITY = 1024;
