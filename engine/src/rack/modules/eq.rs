//! EQ: the mixer strip's [`Eq3`] (high-pass, low shelf, mid peak, high
//! shelf) as a rack module. Inline state, no pool slot.
//!
//! Inputs `l`/`r` are summed to one channel each (`r` falls back to `l`);
//! outputs `l`/`r` are 1 channel. Every param glides inside `Eq3` (5 ms, per
//! 32-frame sub-block), so the response equals the mixer EQ's exactly.

use super::{param, stereo_in, write_stereo};
use crate::dsp::Eq3;
use crate::rack::catalog::ModuleKind;
use crate::rack::port::PortBuf;

const K: ModuleKind = ModuleKind::Eq;
const HP: usize = 0;
const LOW: usize = 1;
const MID_F: usize = 2;
const MID: usize = 3;
const MID_Q: usize = 4;
const HIGH: usize = 5;

#[derive(Clone)]
pub struct Eq {
    eq: Eq3,
}

impl Eq {
    pub fn new(sr: f32) -> Eq {
        Eq { eq: Eq3::new(sr) }
    }

    pub fn reset(&mut self) {
        self.eq.reset();
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let (mut l, mut r) = stereo_in(ins);
        self.eq.set_hp(param(params, K, HP));
        self.eq.set_low(param(params, K, LOW));
        self.eq.set_mid(param(params, K, MID_F), param(params, K, MID), param(params, K, MID_Q));
        self.eq.set_high(param(params, K, HIGH));
        self.eq.process(&mut l, &mut r);
        write_stereo(outs, &l, &r);
    }
}
