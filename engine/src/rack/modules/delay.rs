//! Delay: the mixer's tempo-synced stereo delay ([`DelayCore`]) as a rack
//! module, with a dry/wet `mix`.
//!
//! * Inputs `l`/`r` are summed to one channel each (`r` falls back to `l`);
//!   outputs `l`/`r` are 1 channel (see the catalog's effect notes).
//! * Time = the `division` (the mixer's `DELAY_DIVISIONS` table) at the
//!   transport tempo (`Ctx::bpm`), clamped to 2 s. Time, feedback,
//!   ping-pong and high-cut changes glide / crossfade inside the core.
//! * `out = dry + mix·(wet − dry)`, `mix` smoothed per sample.
//! * The 2 s ring is an FX-pool slot (`rack/fx_pool.rs`). While the pool is
//!   still zeroing a reused slot (or without a slot) the wet signal is
//!   silent and the dry part still passes.

use super::{param, pooled_dry_wet, Ctx, PoolSlot, Smooth};
use crate::dsp::DelayCore;
use crate::mixer::catalog::DELAY_DIVISION_BEATS;
use crate::rack::catalog::ModuleKind;
use crate::rack::fx_pool::{FxKind, FxPool};
use crate::rack::port::PortBuf;

const K: ModuleKind = ModuleKind::Delay;
const DIVISION: usize = 0;
const FEEDBACK: usize = 1;
const MIX: usize = 2;
const PINGPONG: usize = 3;
const HICUT: usize = 4;

#[derive(Clone)]
pub struct Delay {
    pool: PoolSlot,
    core: DelayCore,
    mix: Smooth,
}

impl Delay {
    /// Automation: the next sub-block takes its `smooth` params at once.
    pub fn snap(&mut self) {
        self.mix.snap();
    }

    /// A delay on FX-pool slot `slot`.
    pub fn new(sr: f32, slot: u8) -> Delay {
        Delay { pool: PoolSlot::new(FxKind::Delay, slot), core: DelayCore::new(sr), mix: Smooth::new(sr, super::default(K, MIX)) }
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

    pub fn process(&mut self, ctx: &Ctx, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf], fx: &mut FxPool) {
        let div = param(params, K, DIVISION) as usize;
        let beats = DELAY_DIVISION_BEATS.get(div).copied().unwrap_or(0.75);
        self.core.set_time_beats(beats);
        self.core.set_tempo(ctx.bpm);
        self.core.set_feedback(param(params, K, FEEDBACK));
        self.core.set_ping_pong(param(params, K, PINGPONG) >= 0.5);
        self.core.set_high_cut(param(params, K, HICUT));
        let mix = param(params, K, MIX);
        pooled_dry_wet(&mut self.core, &mut self.pool, fx, &mut self.mix, mix, ins, outs);
    }
}
