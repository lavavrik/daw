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

use super::{param, stereo_in, write_stereo, Ctx, Smooth};
use crate::dsp::DelayCore;
use crate::mixer::catalog::DELAY_DIVISION_BEATS;
use crate::rack::catalog::ModuleKind;
use crate::rack::fx_pool::{FxKind, FxPool};
use crate::rack::port::PortBuf;
use crate::RACK_BLOCK;

const K: ModuleKind = ModuleKind::Delay;
const DIVISION: usize = 0;
const FEEDBACK: usize = 1;
const MIX: usize = 2;
const PINGPONG: usize = 3;
const HICUT: usize = 4;

#[derive(Clone)]
pub struct Delay {
    slot: u8,
    core: DelayCore,
    mix: Smooth,
}

impl Delay {
    /// A delay on FX-pool slot `slot`.
    pub fn new(sr: f32, slot: u8) -> Delay {
        Delay { slot, core: DelayCore::new(sr), mix: Smooth::new(sr, super::default(K, MIX)) }
    }

    pub fn slot(&self) -> u8 {
        self.slot
    }

    pub fn reset(&mut self) {
        self.core.reset();
    }

    pub fn process(&mut self, ctx: &Ctx, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf], fx: &mut FxPool) {
        let (dry_l, dry_r) = stereo_in(ins);
        let div = param(params, K, DIVISION) as usize;
        let beats = DELAY_DIVISION_BEATS.get(div).copied().unwrap_or(0.75);
        self.core.set_time_beats(beats);
        self.core.set_tempo(ctx.bpm);
        self.core.set_feedback(param(params, K, FEEDBACK));
        self.core.set_ping_pong(param(params, K, PINGPONG) >= 0.5);
        self.core.set_high_cut(param(params, K, HICUT));
        let (mut wl, mut wr) = (dry_l, dry_r);
        match fx.buffer(FxKind::Delay, self.slot) {
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
