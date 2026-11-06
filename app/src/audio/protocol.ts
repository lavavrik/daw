// Mirror of engine/src/protocol.rs and the size/telemetry constants in
// engine/src/lib.rs (the source of truth). protocol.test.ts regex-parses the
// Rust files and fails if names or values drift.

export const Op = {
  NOTE_ON: 1,
  NOTE_OFF: 2,
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

/** Indices into the telemetry Float64Array (lib.rs TELEMETRY_*). */
export const TELEMETRY = {
  blocks: 0,
  playing: 1,
  ticks: 2,
  cpu: 3,
  dropouts: 4,
  peakL: 5,
  peakR: 6,
  lastError: 7,
} as const;
export const TELEMETRY_LEN = 8;

/** Words (f64) per command record: [op, a, b, c, d]. */
export const RECORD_WORDS = 5;
/** Record slots in the ring; one is kept empty, so usable depth is capacity - 1. */
export const RING_CAPACITY = 1024;
