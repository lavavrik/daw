//! Mixer: `out = in1·lvl1 + in2·lvl2 + in3·lvl3 + in4·lvl4`.
//!
//! * Levels are smoothed per sample (5 ms), so fader moves never click.
//! * Channels are the maximum over the connected inputs (minimum 1), with
//!   mono broadcast: a 1-channel input is added to every channel, a poly
//!   input with fewer channels than the output adds nothing to the extra
//!   channels, and unconnected inputs contribute nothing.
//! * Non-finite input samples are skipped (read as 0), so one bad source
//!   cannot poison the mix.

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::{poly, PortBuf};
use crate::RACK_BLOCK;

const K: ModuleKind = ModuleKind::Mixer;
/// Number of inputs (and `lvlN` params, which share their index).
pub const INPUTS: usize = 4;

/// The 4-input mixer module (see the module docs).
#[derive(Clone)]
pub struct Mixer {
    level: [Smooth; INPUTS],
}

impl Mixer {
    /// A mixer with its levels at the catalog defaults.
    pub fn new(sr: f32) -> Mixer {
        Mixer { level: [0, 1, 2, 3].map(|i| Smooth::new(sr, default(K, i))) }
    }

    /// Render one sub-block into `outs[0]`.
    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let Some(out) = outs.first_mut() else { return };
        let ins = &ins[..ins.len().min(INPUTS)];
        let channels = poly(ins);
        out.channels = channels;
        let targets: [f32; INPUTS] = [0, 1, 2, 3].map(|j| param(params, K, j));
        for i in 0..RACK_BLOCK {
            let mut lv = [0.0f32; INPUTS];
            for (j, l) in lv.iter_mut().enumerate() {
                *l = self.level[j].next(targets[j]);
            }
            for (ch, row) in out.data.iter_mut().take(channels).enumerate() {
                let mut acc = 0.0f32;
                for (inp, &l) in ins.iter().zip(&lv) {
                    let x = inp.get(ch, i);
                    if x.is_finite() {
                        acc += x * l;
                    }
                }
                row[i] = if acc.is_finite() { acc } else { 0.0 };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_PARAMS;

    #[test]
    fn mixer_sums_with_levels_and_broadcast() {
        let mut m = Mixer::new(48000.0);
        let mut ins = [PortBuf::new(), PortBuf::new(), PortBuf::new(), PortBuf::new()];
        let mut outs = [PortBuf::new()];
        let mut p = [0.0f32; MAX_PARAMS];
        p[..4].copy_from_slice(&[0.5, 1.0, 0.3, 0.25]);

        // Nothing connected: one silent channel.
        m.process(&p, &ins, &mut outs);
        assert_eq!(outs[0].channels, 1);
        assert!(outs[0].data[0].iter().all(|&y| y == 0.0));

        // in1 mono (broadcast), in2 3 channels, in3 unconnected, in4 2 channels.
        ins[0].channels = 1;
        ins[0].data[0] = [0.5; RACK_BLOCK];
        ins[1].channels = 3;
        for ch in 0..3 {
            ins[1].data[ch] = [0.1 * (ch + 1) as f32; RACK_BLOCK];
        }
        ins[2].data[0] = [9.0; RACK_BLOCK]; // stale data on an unconnected input
        ins[3].channels = 2;
        ins[3].data[0] = [-0.4; RACK_BLOCK];
        ins[3].data[1] = [0.8; RACK_BLOCK];
        for _ in 0..100 {
            m.process(&p, &ins, &mut outs);
        }
        assert_eq!(outs[0].channels, 3);
        let want = [0.25 + 0.1 - 0.1, 0.25 + 0.2 + 0.2, 0.25 + 0.3];
        for (ch, &w) in want.iter().enumerate() {
            let y = outs[0].data[ch][RACK_BLOCK - 1];
            assert!((y - w).abs() < 1e-4, "ch {ch}: {y} vs {w}");
        }

        // Level moves are smoothed (5 ms), not stepped.
        p[0] = 0.0;
        m.process(&p, &ins, &mut outs);
        let first = outs[0].data[1][0];
        assert!((first - 0.65).abs() < 0.02, "first sample after the move: {first}");
        for _ in 0..100 {
            m.process(&p, &ins, &mut outs);
        }
        assert!((outs[0].data[1][RACK_BLOCK - 1] - 0.4).abs() < 1e-4);
    }

    #[test]
    fn mixer_defaults_and_non_finite_inputs() {
        let mut m = Mixer::new(48000.0);
        let mut ins = [PortBuf::new(), PortBuf::new(), PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        ins[0].data[0] = [1.0; RACK_BLOCK];
        ins[1].channels = 1;
        ins[1].data[0] = [f32::NAN; RACK_BLOCK];
        let mut outs = [PortBuf::new()];
        // Empty params: catalog defaults (0.8).
        m.process(&[], &ins, &mut outs);
        assert!(outs[0].data[0].iter().all(|&y| y.is_finite()));
        assert!((outs[0].data[0][0] - 0.8).abs() < 1e-6);
        // Short slices are tolerated.
        m.process(&[], &ins[..2], &mut outs);
        m.process(&[], &[], &mut []);
    }
}
