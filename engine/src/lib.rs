//! DAW audio engine (compiled to WASM, hosted in an AudioWorklet).

pub mod arena;
pub mod arrangement;
pub mod audio_track;
pub mod automation;
pub mod drums;
pub mod dsp;
pub mod engine;
pub mod ffi;
pub mod metronome;
pub mod mixer;
pub mod protocol;
pub mod rack;
pub mod samples;
pub mod sequencer;
pub mod synth;
#[cfg(test)]
mod test_json;
pub mod transport;
pub mod vis;

pub use engine::Engine;

/// Largest block (frames) `process()` is ever asked to render.
pub const MAX_BLOCK: usize = 1024;
pub const MAX_TRACKS: usize = 32;
pub const MAX_ROWS: usize = 16;
pub const MAX_STEPS: usize = 64;
pub const MAX_SAMPLES: usize = 256;
/// Per-sample size cap in floats (frames * channels; 256 MB).
pub const MAX_SAMPLE_FLOATS: usize = 64 * 1024 * 1024;
/// Sample memory budget in floats (1 GiB): every float the arena has handed
/// out since the last engine reset, live and leaked samples together
/// (`arena.rs`). `sample_alloc` refuses past it with `ERR_OUT_OF_MEMORY`.
pub const MAX_ARENA_FLOATS: usize = 256 * 1024 * 1024;
/// Largest audio-clip gain (linear; +12 dB).
pub const MAX_CLIP_GAIN: f32 = 4.0;
/// Declick fade of every audio-clip edge (seconds; `audio_track.rs`).
pub const CLIP_FADE_SECONDS: f32 = 0.002;
/// Frames per rack sub-block. Modules always process exactly this many frames,
/// so live and sequenced note timing inside a rack resolves to one sub-block.
pub const RACK_BLOCK: usize = 32;
/// Module slots per rack (patch).
pub const MAX_MODULES: usize = 32;
/// Channels (voices) per rack cable.
pub const MAX_POLY: usize = 16;
/// Max inputs, and separately max outputs, per rack module.
pub const MAX_PORTS: usize = 8;
/// Max params per rack module.
pub const MAX_PARAMS: usize = 12;
/// Ticks per quarter note.
pub const PPQ: f64 = 960.0;
/// A step is a 16th note.
pub const STEP_TICKS: f64 = 240.0;
/// Ticks per bar (4/4). Patterns, the metronome and the count-in are bar-based.
pub const BAR_TICKS: f64 = 3840.0;
/// Note slots per synth track's pattern (`sequencer::NotePattern`).
pub const MAX_NOTES: usize = 1024;
/// Longest synth pattern, in bars (lengths are 1..=16; a new track gets 4).
pub const MAX_PATTERN_BARS: usize = 16;
/// Patterns per track (drum and synth alike), all preallocated. Pattern 0
/// always exists and is the current one of a new track.
pub const MAX_PATTERNS: usize = 16;
/// Clip slots per track on the song timeline (`arrangement::Arrangement`).
pub const MAX_CLIPS: usize = 256;
/// Song length limit in ticks (999 bars): clips end at or before it, and the
/// loop range and seek positions lie within `0..=MAX_SONG_TICKS`.
pub const MAX_SONG_TICKS: usize = 999 * 3840;

/// Automation lanes per project (tracks, returns and master together), all
/// preallocated in `Engine::new` (`automation.rs`).
pub const MAX_AUTO_LANES: usize = 64;
/// Breakpoint slots per automation lane; a point is addressed as
/// `lane * MAX_AUTO_POINTS + idx`.
pub const MAX_AUTO_POINTS: usize = 512;

/// Distinct drum rows that can be sidechain keys at once (each renders into
/// its own preallocated key buffer; whole-track keys need no slot).
pub const MAX_KEYS: usize = 8;
// Mixer channels (`mixer` module): 0..MAX_TRACKS-1 are the track strips,
// then up to `MAX_RETURNS` return slots, then the master. Mirrored in
// app/src/audio/protocol.ts.
/// Return slots (each a Reverb or Delay, or off).
pub const MAX_RETURNS: usize = 8;
/// First return channel; slot `k` is channel `MIX_RETURN0 + k`.
pub const MIX_RETURN0: usize = 32;
pub const MIX_MASTER: usize = 40;
pub const MIX_CHANNELS: usize = 41;
/// Floats per channel in the meters array (`Engine::meters`):
/// peak L, peak R, gain reduction (dB, ≥ 0).
pub const MIX_METER_STRIDE: usize = 3;

// Telemetry slots (indices into `Engine::telemetry()`, an `[f64; TELEMETRY_LEN]`
// the worklet copies into the shared telemetry buffer every block). Mirrored
// by `TELEMETRY` in app/src/audio/protocol.ts (parity-checked by
// protocol.test.ts). The engine writes all but CPU and DROPOUTS, which the
// worklet measures itself.
pub const TELEMETRY_BLOCKS: usize = 0;
/// 0 / 1.
pub const TELEMETRY_PLAYING: usize = 1;
/// Playhead (ticks) at the start of the next block.
pub const TELEMETRY_TICKS: usize = 2;
pub const TELEMETRY_CPU: usize = 3;
pub const TELEMETRY_DROPOUTS: usize = 4;
pub const TELEMETRY_PEAK_L: usize = 5;
pub const TELEMETRY_PEAK_R: usize = 6;
/// Most recent failed command / sample-call code (successes leave it).
pub const TELEMETRY_LAST_ERROR: usize = 7;
/// Written by the worklet, not the engine: the AudioContext frame
/// (`currentFrame`) at which `TELEMETRY_TICKS` applies, so the UI can map the
/// playhead to heard time.
pub const TELEMETRY_FRAME: usize = 8;
pub const TELEMETRY_LEN: usize = 9;

// Visual data path (plan 12, docs/architecture/visuals.md). Mirrored in
// app/src/audio/protocol.ts (parity-checked); the shared `visSab` layout
// built from them lives in app/src/audio/visLayout.ts.
/// Scope bank slots (engine-wide).
pub const VIS_SCOPES: usize = 8;
/// Entries per scope ring; an entry is 4 f32: A min, A max, B min, B max.
pub const VIS_SCOPE_RING: usize = 2048;
/// Most entries a scope window shows.
pub const VIS_SCOPE_WINDOW: usize = 1024;
/// i32 per scope header.
pub const VIS_SCOPE_HDR: usize = 8;
/// Frames in the master and strip-tap rings of `visSab` (stereo, planar).
pub const VIS_TAP_RING: usize = 8192;
/// Voice activity floats: level and gate per voice, per track slot
/// (`[(slot * MAX_POLY + k) * 2]` = level, `+ 1` = gate).
pub const VIS_VOICE_LEN: usize = 32 * 16 * 2;

#[cfg(test)]
mod tests {
    use super::*;

    // Constant asserts are the point: they pin layout constants against each other.
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn constants_are_consistent() {
        assert_eq!(STEP_TICKS * 4.0, PPQ);
        assert_eq!(BAR_TICKS, 4.0 * PPQ);
        assert_eq!(MIX_RETURN0, MAX_TRACKS);
        assert_eq!(MIX_MASTER, MAX_TRACKS + MAX_RETURNS);
        assert_eq!(MIX_CHANNELS, MAX_TRACKS + MAX_RETURNS + 1);
        // Key codes pack `slot * 32 + row + 1`.
        assert!(MAX_ROWS < 32 && MAX_TRACKS <= 32);
        assert_eq!(VIS_VOICE_LEN, MAX_TRACKS * MAX_POLY * 2);
        // The worklet adds at most one block per ring per block, and readers
        // keep VIS_GUARD (256) entries away from the head.
        assert!(MAX_BLOCK <= VIS_TAP_RING / 4 && VIS_SCOPE_WINDOW < VIS_SCOPE_RING);
    }
}
