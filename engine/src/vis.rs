//! Visual data the engine leaves for the UI each block (plan 12; see
//! docs/architecture/visuals.md).
//!
//! [`VisBlock`] is one flat, `#[repr(C)]` array of f32, preallocated in
//! `Engine::new` (boxed, so its address never moves) and exported by
//! `engine_vis`. The worklet reads it after `engine_process` and copies only
//! what the UI asks for (the want mask in `visSab`) into the shared rings;
//! the engine itself never knows whether anyone looks.
//!
//! * **Strip tap** (`tap_l`, `tap_r`, `tap_ch`): `OP_VIS_TAP` picks one mixer
//!   channel (a track strip or a return; −1 = off). The mixer writes that
//!   strip's post-fader stereo, the very values it adds to the master bus,
//!   into the first `n` frames each block (`Mixer::process`); a strip that
//!   does not run leaves zeros. The master is not tappable: the worklet
//!   copies the engine output itself.
//! * **Voice activity** (`voices`): per synth track slot and voice `k`,
//!   `voices[(slot * MAX_POLY + k) * 2]` is the voice's peak level this block
//!   (its Out input channel `k`, `max(|l|, |r|) × level`, the max over the
//!   rack's Outs; below `VOICE_FLOOR` it reads 0) and `+ 1` its gate (the
//!   rack's first MIDI In, last frame). A rack that did not render this block
//!   writes zeros (`Synths::write_voices`).
//!
//! Reading signals only: nothing here changes what the engine renders.

use crate::{MAX_BLOCK, VIS_VOICE_LEN};

/// Float offset of `tap_l` in the block.
pub const VIS_TAP_L: usize = 0;
/// Float offset of `tap_r`.
pub const VIS_TAP_R: usize = MAX_BLOCK;
/// Float offset of `tap_ch` (−1.0 = off, else the mixer channel).
pub const VIS_TAP_CH: usize = 2 * MAX_BLOCK;
/// Float offset of `voices` (`VIS_VOICE_LEN` floats).
pub const VIS_VOICES: usize = 2 * MAX_BLOCK + 1;
/// Floats in the whole block.
pub const VIS_BLOCK_LEN: usize = VIS_VOICES + VIS_VOICE_LEN;

/// A voice whose peak is below −60 dBFS reads as silent (level 0): an
/// activity light, not a meter, so an exponential release tail does not
/// keep it lit long after it is inaudible in the mix.
pub const VOICE_FLOOR: f32 = 1e-3;

/// See the module docs. Field order is the wire layout (`VIS_*` offsets).
#[repr(C)]
pub struct VisBlock {
    pub tap_l: [f32; MAX_BLOCK],
    pub tap_r: [f32; MAX_BLOCK],
    pub tap_ch: f32,
    pub voices: [f32; VIS_VOICE_LEN],
}

impl VisBlock {
    /// Zeroed, tap off. Allocates (`Engine::new` only).
    pub fn new() -> Box<VisBlock> {
        Box::new(VisBlock { tap_l: [0.0; MAX_BLOCK], tap_r: [0.0; MAX_BLOCK], tap_ch: -1.0, voices: [0.0; VIS_VOICE_LEN] })
    }

    /// The block's first float (the `engine_vis` pointer).
    pub fn as_ptr(&self) -> *const f32 {
        self.tap_l.as_ptr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_offsets() {
        let v = VisBlock::new();
        let base = v.as_ptr() as usize;
        let at = |p: *const f32| (p as usize - base) / 4;
        assert_eq!(at(v.tap_l.as_ptr()), VIS_TAP_L);
        assert_eq!(at(v.tap_r.as_ptr()), VIS_TAP_R);
        assert_eq!(at(&v.tap_ch), VIS_TAP_CH);
        assert_eq!(at(v.voices.as_ptr()), VIS_VOICES);
        assert_eq!(core::mem::size_of::<VisBlock>(), VIS_BLOCK_LEN * 4);
    }
}
