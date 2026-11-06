//! LFO: a mono, bipolar (±depth) control signal.
//!
//! * Free mode: the phase advances at `rate` Hz.
//! * Sync mode while the transport plays: the phase is locked to the song
//!   position, `phase = (ticks / division_ticks) mod 1`, so the LFO lines up
//!   with bars and beats however playback started.
//! * Sync mode while stopped: free-runs at the tempo-derived rate of the
//!   chosen division (so it keeps moving at the right speed).
//!
//! The output passes through a 1 ms one-pole slew (`SLEW_SECONDS`), so wave,
//! sync or division changes, transport jumps in Sync mode and the square's
//! edges never step a VCA's gain (no clicks when an LFO modulates audio).
//!
//! Waves (all start at phase 0): Sine `sin(2πφ)`; Tri rises 0 → 1 → -1 → 0
//! in step with the sine; Saw ramps -1 → 1; Square is +1 for the first half
//! of the cycle, -1 for the second.

use super::{default, param, Ctx, Smooth};
use crate::rack::catalog::{ModuleKind, LFO_DIVISION_TICKS};
use crate::rack::port::PortBuf;
use crate::{PPQ, RACK_BLOCK};

const WAVE: usize = 0;
const RATE: usize = 1;
const SYNC: usize = 2;
const DIVISION: usize = 3;
const DEPTH: usize = 4;

/// Output slew time constant.
pub const SLEW_SECONDS: f32 = 0.001;
const K: ModuleKind = ModuleKind::Lfo;

#[derive(Clone)]
pub struct Lfo {
    sr: f32,
    /// 0..1.
    phase: f64,
    depth: Smooth,
    /// Output slew (starts at 0, so a new LFO also fades in).
    slew: Smooth,
}

impl Lfo {
    pub fn new(sr: f32) -> Lfo {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        Lfo { sr, phase: 0.0, depth: Smooth::new(sr, default(K, DEPTH)), slew: Smooth::with_time(sr, SLEW_SECONDS, 0.0) }
    }

    pub fn reset(&mut self) {
        self.phase = 0.0;
    }

    pub fn process(&mut self, ctx: &Ctx, params: &[f32], outs: &mut [PortBuf]) {
        let Some(out) = outs.first_mut() else { return };
        out.channels = 1;
        let wave = param(params, K, WAVE) as u32;
        let synced = param(params, K, SYNC) >= 0.5;
        let div_idx = (param(params, K, DIVISION).max(0.0) as usize).min(LFO_DIVISION_TICKS.len() - 1);
        let div_ticks = LFO_DIVISION_TICKS[div_idx];
        let depth_target = param(params, K, DEPTH);
        let locked = synced && ctx.playing && ctx.ticks.is_finite() && ctx.ticks_per_frame.is_finite();
        let hz = if synced {
            // cycles/s = (ticks/s) / (ticks/cycle)
            ctx.bpm.max(1.0) as f64 * PPQ / 60.0 / div_ticks
        } else {
            param(params, K, RATE).clamp(0.0, 1000.0) as f64
        };
        let inc = hz / self.sr as f64;
        for i in 0..RACK_BLOCK {
            if locked {
                let t = ctx.ticks + i as f64 * ctx.ticks_per_frame;
                self.phase = (t / div_ticks).rem_euclid(1.0);
            }
            let p = self.phase;
            let v = match wave {
                0 => (std::f64::consts::TAU * p).sin(),
                1 => 1.0 - 4.0 * ((p + 0.25).rem_euclid(1.0) - 0.5).abs(),
                2 => 2.0 * p - 1.0,
                _ => {
                    if p < 0.5 {
                        1.0
                    } else {
                        -1.0
                    }
                }
            } as f32;
            out.data[0][i] = self.slew.next(v * self.depth.next(depth_target));
            if !locked {
                self.phase += inc;
                if self.phase >= 1.0 {
                    self.phase -= self.phase.floor();
                }
            }
        }
        if !self.phase.is_finite() {
            self.phase = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_PARAMS;

    /// Render `blocks` sub-blocks from `ticks` (advancing); returns the last
    /// sample and the ticks at that sample.
    fn run(lfo: &mut Lfo, params: &[f32], ticks: f64, blocks: usize) -> (f32, f64, f32) {
        let tpf = 0.04;
        let mut outs = [PortBuf::new()];
        let mut max_jump = 0.0f32;
        let mut last: Option<f32> = None;
        for b in 0..blocks {
            let t0 = ticks + (b * RACK_BLOCK) as f64 * tpf;
            let ctx = Ctx { sr: 48000.0, bpm: 120.0, playing: true, ticks: t0, ticks_per_frame: tpf };
            lfo.process(&ctx, params, &mut outs);
            for &x in &outs[0].data[0] {
                if let Some(l) = last {
                    max_jump = max_jump.max((x - l).abs());
                }
                last = Some(x);
            }
        }
        (outs[0].data[0][RACK_BLOCK - 1], ticks + (blocks * RACK_BLOCK - 1) as f64 * tpf, max_jump)
    }

    fn saw(ticks: f64) -> f32 {
        (2.0 * (ticks / 960.0).rem_euclid(1.0) - 1.0) as f32
    }

    #[test]
    fn synced_phase_follows_ticks_while_playing() {
        let mut lfo = Lfo::new(48000.0);
        let mut params = [0.0f32; MAX_PARAMS];
        params[WAVE] = 2.0; // saw
        params[SYNC] = 1.0;
        params[DIVISION] = 3.0; // 1/4 = 960 ticks
        params[DEPTH] = 1.0;
        // 20 sub-blocks (13 ms = 13 slew time constants) to settle.
        let (x, t, _) = run(&mut lfo, &params, 100.0, 20);
        assert!((x - saw(t)).abs() < 0.01, "{x} vs {}", saw(t));
        // A transport jump re-locks the phase, through the slew (no step).
        let (x, t, jump) = run(&mut lfo, &params, 960.0 * 7.0 + 300.0, 20);
        assert!((x - saw(t)).abs() < 0.01, "{x} vs {}", saw(t));
        assert!(jump < 0.05, "slewed jump {jump}");
    }

    #[test]
    fn wave_change_is_slewed() {
        let mut lfo = Lfo::new(48000.0);
        let mut params = [0.0f32; MAX_PARAMS];
        params[WAVE] = 3.0; // square: +1 for the first half cycle
        params[RATE] = 0.1;
        params[DEPTH] = 1.0;
        let mut outs = [PortBuf::new()];
        let ctx = Ctx { sr: 48000.0, bpm: 120.0, playing: false, ticks: 0.0, ticks_per_frame: 0.0 };
        let mut last = 0.0f32;
        let mut jump = 0.0f32;
        for b in 0..40 {
            if b == 20 {
                params[WAVE] = 2.0; // saw: near -1 at this phase
            }
            lfo.process(&ctx, &params, &mut outs);
            for &x in &outs[0].data[0] {
                jump = jump.max((x - last).abs());
                last = x;
            }
        }
        assert!(jump < 0.05, "jump {jump}");
        assert!(last < -0.9, "reached the saw: {last}");
    }
}
