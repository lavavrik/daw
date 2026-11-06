//! DAW audio engine (compiled to WASM, hosted in an AudioWorklet).

pub mod arena;
pub mod drums;
pub mod engine;
pub mod ffi;
pub mod metronome;
pub mod protocol;
pub mod rack;
pub mod samples;
pub mod synth;
pub mod transport;

pub use engine::Engine;

/// Largest block (frames) `process()` is ever asked to render.
pub const MAX_BLOCK: usize = 1024;
pub const MAX_TRACKS: usize = 32;
pub const MAX_ROWS: usize = 16;
pub const MAX_STEPS: usize = 64;
pub const MAX_SAMPLES: usize = 256;
/// Per-sample size cap in floats (frames * channels; 256 MB).
pub const MAX_SAMPLE_FLOATS: usize = 64 * 1024 * 1024;
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
pub const TELEMETRY_LEN: usize = 8;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_are_consistent() {
        assert_eq!(STEP_TICKS * 4.0, PPQ);
    }
}
