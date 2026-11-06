//! DAW audio engine (compiled to WASM, hosted in an AudioWorklet).

pub mod protocol;

/// Largest block (frames) `process()` is ever asked to render.
pub const MAX_BLOCK: usize = 1024;
pub const MAX_TRACKS: usize = 32;
pub const MAX_ROWS: usize = 16;
pub const MAX_STEPS: usize = 64;
pub const MAX_SAMPLES: usize = 256;
/// Ticks per quarter note.
pub const PPQ: f64 = 960.0;
/// A step is a 16th note.
pub const STEP_TICKS: f64 = 240.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_are_consistent() {
        assert_eq!(STEP_TICKS * 4.0, PPQ);
    }
}
