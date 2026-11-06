//! LFO: a mono, bipolar (±depth) control signal.
//!
//! * Free mode: the phase advances at `rate` Hz.
//! * Sync mode while the transport plays: the phase is locked to the song
//!   position, `phase = (ticks / division_ticks) mod 1`, so the LFO lines up
//!   with bars and beats however playback started.
//! * Sync mode while stopped: free-runs at the tempo-derived rate of the
//!   chosen division (so it keeps moving at the right speed).
//!
//! Waves (all start at phase 0): Sine `sin(2πφ)`; Tri rises 0 → 1 → -1 → 0
//! in step with the sine; Saw ramps -1 → 1; Square is +1 for the first half
//! of the cycle, -1 for the second.

use super::{param, Ctx, Smooth};
use crate::rack::catalog::LFO_DIVISION_TICKS;
use crate::rack::port::PortBuf;
use crate::{PPQ, RACK_BLOCK};

const WAVE: usize = 0;
const RATE: usize = 1;
const SYNC: usize = 2;
const DIVISION: usize = 3;
const DEPTH: usize = 4;

#[derive(Clone)]
pub struct Lfo {
    sr: f32,
    /// 0..1.
    phase: f64,
    depth: Smooth,
}

impl Lfo {
    pub fn new(sr: f32) -> Lfo {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        Lfo { sr, phase: 0.0, depth: Smooth::new(sr, 1.0) }
    }

    pub fn reset(&mut self) {
        self.phase = 0.0;
    }

    pub fn process(&mut self, ctx: &Ctx, params: &[f32], outs: &mut [PortBuf]) {
        let Some(out) = outs.first_mut() else { return };
        out.channels = 1;
        let wave = param(params, WAVE, 0.0) as u32;
        let synced = param(params, SYNC, 0.0) >= 0.5;
        let div_idx = (param(params, DIVISION, 3.0).max(0.0) as usize).min(LFO_DIVISION_TICKS.len() - 1);
        let div_ticks = LFO_DIVISION_TICKS[div_idx];
        let depth_target = param(params, DEPTH, 1.0);
        let locked = synced && ctx.playing && ctx.ticks.is_finite() && ctx.ticks_per_frame.is_finite();
        let hz = if synced {
            // cycles/s = (ticks/s) / (ticks/cycle)
            ctx.bpm.max(1.0) as f64 * PPQ / 60.0 / div_ticks
        } else {
            param(params, RATE, 2.0).clamp(0.0, 1000.0) as f64
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
            out.data[0][i] = v * self.depth.next(depth_target);
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

    #[test]
    fn synced_phase_follows_ticks_while_playing() {
        let mut lfo = Lfo::new(48000.0);
        let mut params = [0.0f32; MAX_PARAMS];
        params[WAVE] = 2.0; // saw: -1 at phase 0, 0 at phase 0.5
        params[SYNC] = 1.0;
        params[DIVISION] = 3.0; // 1/4 = 960 ticks
        params[DEPTH] = 1.0;
        let mut outs = [PortBuf::new()];
        let ctx = Ctx { sr: 48000.0, bpm: 120.0, playing: true, ticks: 480.0, ticks_per_frame: 0.04 };
        lfo.process(&ctx, &params, &mut outs);
        assert_eq!(outs[0].channels, 1);
        assert!(outs[0].data[0][0].abs() < 1e-6, "phase 0.5 -> 0, got {}", outs[0].data[0][0]);
        let want = 2.0 * ((480.0 + 31.0 * 0.04) / 960.0) - 1.0;
        assert!((outs[0].data[0][31] as f64 - want).abs() < 1e-5);
        // Jumping the transport re-locks immediately.
        let ctx = Ctx { ticks: 960.0 * 7.0, ..ctx };
        lfo.process(&ctx, &params, &mut outs);
        assert!((outs[0].data[0][0] + 1.0).abs() < 1e-6, "phase 0 -> -1");
    }
}
