//! Saturator: per-channel (poly) soft clipper with a tone tilt and dry/wet.
//!
//! Per sample and channel:
//! * **Tone** tilts the input before the shaper around a ~800 Hz one-pole
//!   split: `pre = x + (2·tone − 1)·(x − lp(x))`. Tone 0.5 is flat (exactly
//!   `x`), 0 keeps only the lows (dark), 1 doubles the highs (+6 dB shelf,
//!   bright, so they saturate first).
//! * **Drive** 0..1 is a 0..+24 dB pre-gain `g` into
//!   [`tanh_fast`](super::filter::tanh_fast) (a monotone tanh approximation
//!   that reaches exactly ±1 at ±3): `wet = tanh(g·pre)`. So the wet signal
//!   is bounded by ±1 and its static curve is monotone; drive 0 is a gentle
//!   tanh (unity gain for small signals), drive 1 hard and ~16× louder at
//!   low levels. There is no output compensation (follow it with a VCA).
//! * **Mix**: `out = x + mix·(wet − x)`; mix 1 (default) is fully wet.
//!
//! Channels follow `in` (min 1). Drive, tone and mix are smoothed per sample.

use super::filter::tanh_fast;
use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::{poly, PortBuf};
use crate::{MAX_POLY, RACK_BLOCK};

const K: ModuleKind = ModuleKind::Saturator;
const DRIVE: usize = 0;
const MIX: usize = 1;
const TONE: usize = 2;
/// Tone split frequency (Hz).
const TONE_HZ: f32 = 800.0;
/// Pre-gain at drive 1 (dB).
const DRIVE_DB: f32 = 24.0;

#[derive(Clone)]
pub struct Saturator {
    drive: Smooth,
    mix: Smooth,
    tone: Smooth,
    /// Tone one-pole coefficient and per-channel state.
    a: f32,
    lp: [f32; MAX_POLY],
}

impl Saturator {
    pub fn new(sr: f32) -> Saturator {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        Saturator {
            drive: Smooth::new(sr, default(K, DRIVE)),
            mix: Smooth::new(sr, default(K, MIX)),
            tone: Smooth::new(sr, default(K, TONE)),
            a: (-std::f32::consts::TAU * TONE_HZ / sr).exp(),
            lp: [0.0; MAX_POLY],
        }
    }

    pub fn reset(&mut self) {
        self.lp = [0.0; MAX_POLY];
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let (Some(inp), Some(out)) = (ins.first(), outs.first_mut()) else { return };
        let channels = poly(&ins[..1]);
        out.channels = channels;
        let (dt, mt, tt) = (param(params, K, DRIVE), param(params, K, MIX), param(params, K, TONE));
        let a = self.a;
        for i in 0..RACK_BLOCK {
            let g = 10f32.powf(self.drive.next(dt) * DRIVE_DB / 20.0);
            let mix = self.mix.next(mt);
            let tilt = 2.0 * self.tone.next(tt) - 1.0;
            for (ch, row) in out.data.iter_mut().take(channels).enumerate() {
                let x = inp.get(ch, i);
                let x = if x.is_finite() { x } else { 0.0 };
                let lp = &mut self.lp[ch];
                *lp = x + a * (*lp - x);
                if lp.abs() < 1e-20 {
                    *lp = 0.0;
                }
                let pre = x + tilt * (x - *lp);
                let wet = tanh_fast(g * pre);
                let y = x + mix * (wet - x);
                row[i] = if y.is_finite() { y } else { 0.0 };
            }
        }
    }
}
