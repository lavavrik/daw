//! Compressor: the mixer strip's feed-forward, stereo-linked
//! [`Compressor`](crate::dsp::Compressor) as a rack module. Inline state.
//!
//! * Inputs `l`/`r` are summed to one channel each (`r` falls back to `l`);
//!   outputs `l`/`r` are 1 channel.
//! * `sc` is the key, summed to mono and fed to both detector channels: a
//!   kick patched into `sc` ducks a pad on `l`/`r`. Unconnected, the
//!   compressor keys on its own input. (Patches are self-contained: the key
//!   comes from inside the patch, not from another track.)
//! * Threshold, ratio and makeup glide per sample inside the dsp; attack and
//!   release apply at once (they only change the ballistics).

use super::{mono_sum, param, stereo_in, write_stereo};
use crate::dsp;
use crate::rack::catalog::ModuleKind;
use crate::rack::port::PortBuf;
use crate::RACK_BLOCK;

const K: ModuleKind = ModuleKind::Compressor;
const SC: usize = 2;
const THRESHOLD: usize = 0;
const RATIO: usize = 1;
const ATTACK: usize = 2;
const RELEASE: usize = 3;
const MAKEUP: usize = 4;

#[derive(Clone)]
pub struct Compressor {
    comp: dsp::Compressor,
}

impl Compressor {
    pub fn new(sr: f32) -> Compressor {
        Compressor { comp: dsp::Compressor::new(sr) }
    }

    pub fn reset(&mut self) {
        self.comp.reset();
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let (mut l, mut r) = stereo_in(ins);
        self.comp.set_threshold_db(param(params, K, THRESHOLD));
        self.comp.set_ratio(param(params, K, RATIO));
        self.comp.set_attack_ms(param(params, K, ATTACK));
        self.comp.set_release_ms(param(params, K, RELEASE));
        self.comp.set_makeup_db(param(params, K, MAKEUP));
        match ins.get(SC).filter(|p| p.channels > 0) {
            Some(sc) => {
                let mut key = [0.0f32; RACK_BLOCK];
                mono_sum(sc, &mut key);
                self.comp.process(&mut l, &mut r, &key, &key);
            }
            None => self.comp.process_self(&mut l, &mut r),
        }
        write_stereo(outs, &l, &r);
    }
}
