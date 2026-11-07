//! Reverb: the mixer's 8-line FDN ([`ReverbCore`]) as a rack module, with a
//! dry/wet `mix`.
//!
//! * Inputs `l`/`r` are summed to one channel each (`r` falls back to `l`);
//!   outputs `l`/`r` are 1 channel, which is what makes one reverb per
//!   patch affordable.
//! * Size, decay, damping and predelay glide inside the core; `out = dry +
//!   mix·(wet − dry)`, `mix` smoothed per sample (mix 0 is exactly dry).
//! * The lines live in an FX-pool slot (`rack/fx_pool.rs`); while a reused
//!   slot is still being zeroed (or without a slot) the wet signal is
//!   silent and the dry part still passes.

use super::{param, stereo_in, write_stereo, Smooth};
use crate::dsp::ReverbCore;
use crate::rack::catalog::ModuleKind;
use crate::rack::fx_pool::{FxKind, FxPool};
use crate::rack::port::PortBuf;
use crate::RACK_BLOCK;

const K: ModuleKind = ModuleKind::Reverb;
const SIZE: usize = 0;
const DECAY: usize = 1;
const DAMPING: usize = 2;
const PREDELAY: usize = 3;
const MIX: usize = 4;

#[derive(Clone)]
pub struct Reverb {
    slot: u8,
    /// Set by `reset`: the next `process` restarts the slot's zeroing
    /// (`FxPool::reassign`), so stale ring content never plays.
    rezero: bool,
    core: ReverbCore,
    mix: Smooth,
}

impl Reverb {
    /// A reverb on FX-pool slot `slot`.
    pub fn new(sr: f32, slot: u8) -> Reverb {
        Reverb { slot, rezero: false, core: ReverbCore::new(sr), mix: Smooth::new(sr, super::default(K, MIX)) }
    }

    pub fn slot(&self) -> u8 {
        self.slot
    }

    /// Clear the DSP state; the ring (pool memory) is re-zeroed, in bounded
    /// steps, from the next `process` on (silent wet signal meanwhile).
    pub fn reset(&mut self) {
        self.core.reset();
        self.rezero = true;
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf], fx: &mut FxPool) {
        let (dry_l, dry_r) = stereo_in(ins);
        self.core.set_size(param(params, K, SIZE));
        self.core.set_decay(param(params, K, DECAY));
        self.core.set_damping(param(params, K, DAMPING));
        self.core.set_predelay_ms(param(params, K, PREDELAY));
        let (mut wl, mut wr) = (dry_l, dry_r);
        if std::mem::take(&mut self.rezero) {
            fx.reassign(FxKind::Reverb, self.slot);
        }
        match fx.buffer(FxKind::Reverb, self.slot) {
            Some(buf) => self.core.process(buf, &mut wl, &mut wr),
            None => {
                (wl, wr) = ([0.0; RACK_BLOCK], [0.0; RACK_BLOCK]);
                self.core.reset();
            }
        }
        let target = param(params, K, MIX);
        for i in 0..RACK_BLOCK {
            let m = self.mix.next(target);
            wl[i] = dry_l[i] + m * (wl[i] - dry_l[i]);
            wr[i] = dry_r[i] + m * (wr[i] - dry_r[i]);
        }
        write_stereo(outs, &wl, &wr);
    }
}
