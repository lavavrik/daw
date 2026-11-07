//! Chorus: [`ChorusCore`] (a 50 ms modulated stereo delay, see
//! `dsp/chorus.rs`) as a rack module.
//!
//! * Inputs `l`/`r` are summed to one channel each (`r` falls back to `l`);
//!   outputs `l`/`r` are 1 channel.
//! * `rate`, `depth` and `mix` go straight to the core, which glides depth
//!   and mix and keeps its LFO phase continuous.
//! * The ring is an FX-pool slot (`rack/fx_pool.rs`); while a reused slot is
//!   still being zeroed (or without a slot) the output is the dry signal.

use super::{param, stereo_in, write_stereo, PoolSlot};
use crate::dsp::ChorusCore;
use crate::rack::catalog::ModuleKind;
use crate::rack::fx_pool::{FxKind, FxPool};
use crate::rack::port::PortBuf;

const K: ModuleKind = ModuleKind::Chorus;
const RATE: usize = 0;
const DEPTH: usize = 1;
const MIX: usize = 2;

#[derive(Clone)]
pub struct Chorus {
    pool: PoolSlot,
    core: ChorusCore,
}

impl Chorus {
    /// A chorus on FX-pool slot `slot`.
    pub fn new(sr: f32, slot: u8) -> Chorus {
        Chorus { pool: PoolSlot::new(FxKind::Chorus, slot), core: ChorusCore::new(sr) }
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
        let (mut l, mut r) = stereo_in(ins);
        self.core.set_rate(param(params, K, RATE));
        self.core.set_depth(param(params, K, DEPTH));
        self.core.set_mix(param(params, K, MIX));
        match self.pool.buffer(fx) {
            Some(buf) => self.core.process(buf, &mut l, &mut r),
            None => self.core.reset(),
        }
        write_stereo(outs, &l, &r);
    }
}
