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
  /** No args. Back to a blank session (project load): every track, rack, clip,
   *  sample (the arena rewinds), mixer setting, FX-pool slot, the transport and
   *  the metronome. Stopped only (BAD_VALUE while playing: send STOP first, the
   *  same batch is fine). Applies at once; the output fades over 5 ms. */
  RESET_ALL: 44,
  // Audio tracks (engine/src/audio_track.rs). An audio clip is addressed like
  // a clip, slot*MAX_CLIPS+idx; every audio-clip op on a non-Audio slot is
  // BAD_INDEX. One edit is SOURCE + GAIN (staged) then SET (commits both
  // with the position), so the engine never plays a half-applied edit.
  /** a=slot: an Audio track (no patterns or rack; its own mixer strip). The
   *  old track and every clip there fade out over 2 ms. */
  ADD_AUDIO_TRACK: 45,
  /** a=slot*MAX_CLIPS+idx b=sample id or -1 c=offset in seconds (>= 0; the
   *  engine converts to frames at its rate, clamped to MAX_SAMPLE_FLOATS
   *  frames) d=loop 0/1. Stages the change. */
  AUDIO_CLIP_SOURCE: 46,
  /** a=slot*MAX_CLIPS+idx b=gain 0..MAX_CLIP_GAIN (linear) c=fade-in ticks
   *  d=fade-out ticks. Stages the change. */
  AUDIO_CLIP_GAIN: 47,
  /** a=slot*MAX_CLIPS+idx b=start ticks c=length ticks (len >= 1, start+len
   *  <= MAX_SONG_TICKS, fadeIn+fadeOut <= len else BAD_VALUE): commits the
   *  staged source and gain and activates the clip. CLIP_REMOVE / CLIP_CLEAR
   *  remove audio clips too. */
  AUDIO_CLIP_SET: 48,
  // Automation lanes (engine/src/automation.rs; docs/architecture/automation.md).
  // 64 lanes x 512 point slots, preallocated; a point is addressed as
  // lane*MAX_AUTO_POINTS+idx. A lane applies in Song mode only (playing or
  // stopped); otherwise its target plays its base value (the last MIX_SET /
  // RACK_SET_PARAM, which on an automated target only stores the base).
  /** a=lane b=AUTO_KIND (0 none, 1 mix, 2 rack) c=mix channel 0..34 or rack
   *  slot d=mix param id or packAutoParam(module, param). The target must
   *  exist and be a non-integer param (else BAD_VALUE; a bad lane, channel or
   *  slot is BAD_INDEX); a second lane on the same target is BAD_VALUE.
   *  Captures the target's current value as the base. On a lane with points
   *  the points stay, re-validated against the new range. */
  AUTO_LANE_SET: 49,
  /** a=lane*MAX_AUTO_POINTS+idx b=tick 0..MAX_SONG_TICKS c=value (param
   *  units, catalog range; the UI clamps first) d=0 linear / 1 hold. A tick
   *  another point of the lane uses is BAD_VALUE (an instant change is a hold
   *  point followed by the next point); so is a lane without a target. */
  AUTO_POINT_SET: 50,
  /** a=lane*MAX_AUTO_POINTS+idx (an inactive point: no-op). */
  AUTO_POINT_REMOVE: 51,
  /** a=lane: no points, no target; the param goes back to its base. */
  AUTO_LANE_CLEAR: 52,
  /** a=lane b=0/1 (a disabled lane plays the base). */
  AUTO_LANE_ENABLE: 53,
  /** a=lane: suspend it until the playhead passes its next breakpoint, or a
   *  Play / Stop / seek / loop wrap / mode switch (stopped: until Play or a
   *  seek). Not an edit (NON_EDIT_OPS): sent right before a manual move's own
   *  MIX_SET / RACK_SET_PARAM, so that edit is heard at once. */
  AUTO_OVERRIDE: 54,
  /** a=mixer channel 0..MIX_DELAY (track strips, returns) or -1 = off: the
   *  strip the engine taps for the visuals (visCopy.ts); the master is
   *  BAD_VALUE (the worklet taps the output itself). Not an edit
   *  (NON_EDIT_OPS), never in projectCommands; re-sent after a restart. */
  VIS_TAP: 55,
  /** a=lane*MAX_AUTO_POINTS+idx b=curve -1..1 (0 linear) of the segment from
   *  that point to the next: f(x) = x^(2^(-3 curve)) of the way at fraction x,
   *  in knob space (plan 16; state/automation.ts bend). An inactive point or
   *  a curve out of range is BAD_VALUE. AUTO_POINT_SET resets the point's
   *  curve to 0, so a curved point is sent SET, then CURVE (pointCommands).
   *  56: 55 was VIS_TAP's already. */
  AUTO_POINT_CURVE: 56,
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
  /** A deferred load was dropped by RESET_ALL (project load) before it ran:
   *  the session it belonged to is gone, so it is moot (not an error). */
  RESET: -102,
} as const;

/** Largest block (frames) the engine renders per call (lib.rs MAX_BLOCK). */
export const MAX_BLOCK = 1024;
/** Per-sample cap, frames * channels (lib.rs MAX_SAMPLE_FLOATS). */
export const MAX_SAMPLE_FLOATS = 64 * 1024 * 1024;
/** Sample memory budget in floats, 1 GiB: everything uploaded since the last
 *  RESET_ALL, live and replaced samples together (lib.rs MAX_ARENA_FLOATS).
 *  The engine refuses past it with Err.OUT_OF_MEMORY, playing or not. */
export const MAX_ARENA_FLOATS = 256 * 1024 * 1024;
/** Largest audio-clip gain, linear (+12 dB; lib.rs MAX_CLIP_GAIN). */
export const MAX_CLIP_GAIN = 4.0;
/** Declick fade of every audio-clip edge, seconds (lib.rs CLIP_FADE_SECONDS). */
export const CLIP_FADE_SECONDS = 0.002;
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
/**
 * MIDI note of drum row 0: a live note 36 + r plays (and records into) row r,
 * r = 0..15, i.e. notes 36..51 (engine drums.rs live hits; plan 15).
 */
export const DRUM_BASE_NOTE = 36;

/** Automation lanes per project, and point slots per lane (lib.rs). */
// Visual data path (lib.rs VIS_*; plan 12, docs/architecture/visuals.md).
// The shared visSab layout built from these lives in visLayout.ts.
/** Scope bank slots (engine-wide). */
export const VIS_SCOPES = 8;
/** Entries per scope ring; an entry is 4 f32: A min, A max, B min, B max. */
export const VIS_SCOPE_RING = 2048;
/** Most entries a scope window shows. */
export const VIS_SCOPE_WINDOW = 1024;
/** i32 per scope header. */
export const VIS_SCOPE_HDR = 8;
/** Frames in the master and strip-tap rings (stereo, planar). */
export const VIS_TAP_RING = 8192;
/** Level and gate per voice, per track slot (`(slot * MAX_POLY + k) * 2`). */
export const VIS_VOICE_LEN = 32 * 16 * 2;
export const MAX_AUTO_LANES = 64;
export const MAX_AUTO_POINTS = 512;
/** AUTO_LANE_SET target kinds (b). */
export const AUTO_KIND = { NONE: 0, MIX: 1, RACK: 2 } as const;

/** Ports per module in a packed port argument (protocol.rs PORT_STRIDE). */
export const PORT_STRIDE = 16;
/** Pack `(module, port)` into one rack-command argument: `module * 16 + port`. */
export const packPort = (module: number, port: number): number => module * PORT_STRIDE + port;
/** Pack a rack automation target's `(module, param)` for AUTO_LANE_SET d. */
export const packAutoParam = (module: number, param: number): number => module * PORT_STRIDE + param;
/** AUTO_POINT_SET / AUTO_POINT_REMOVE address of point `idx` of `lane`. */
export const autoPoint = (lane: number, idx: number): number => lane * MAX_AUTO_POINTS + idx;

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
