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

use super::{param, pooled_dry_wet, PoolSlot, Smooth};
use crate::dsp::ReverbCore;
use crate::rack::catalog::ModuleKind;
use crate::rack::fx_pool::{FxKind, FxPool};
use crate::rack::port::PortBuf;

const K: ModuleKind = ModuleKind::Reverb;
const SIZE: usize = 0;
const DECAY: usize = 1;
const DAMPING: usize = 2;
const PREDELAY: usize = 3;
const MIX: usize = 4;

#[derive(Clone)]
pub struct Reverb {
    pool: PoolSlot,
    core: ReverbCore,
    mix: Smooth,
}

impl Reverb {
    /// Automation: the next sub-block takes its `smooth` params at once.
    pub fn snap(&mut self) {
        self.mix.snap();
    }

    /// A reverb on FX-pool slot `slot`.
    pub fn new(sr: f32, slot: u8) -> Reverb {
        Reverb { pool: PoolSlot::new(FxKind::Reverb, slot), core: ReverbCore::new(sr), mix: Smooth::new(sr, super::default(K, MIX)) }
    }

    pub fn slot(&self) -> u8 {
        self.pool.slot()
    }

    /// Clear the DSP state; the ring (pool memory) is re-zeroed, in bounded
    /// steps, from the next `process` on (silent wet signal meanwhile).
    pub fn reset(&mut self) {
        self.core.reset();
        self.pool.rezero();
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf], fx: &mut FxPool) {
        self.core.set_size(param(params, K, SIZE));
        self.core.set_decay(param(params, K, DECAY));
        self.core.set_damping(param(params, K, DAMPING));
        self.core.set_predelay_ms(param(params, K, PREDELAY));
        let mix = param(params, K, MIX);
        pooled_dry_wet(&mut self.core, &mut self.pool, fx, &mut self.mix, mix, ins, outs);
    }
}
