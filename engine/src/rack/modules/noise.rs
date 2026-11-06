//! Noise: white noise from a fixed-seed xorshift (deterministic output), one
//! channel, scaled by the smoothed `level` knob.

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::PortBuf;
use crate::RACK_BLOCK;

const LEVEL: usize = 0;
const K: ModuleKind = ModuleKind::Noise;
const SEED: u32 = 0x9E37_79B9;

/// White noise source (uniform in -level..level).
#[derive(Clone)]
pub struct Noise {
    state: u32,
    level: Smooth,
}

impl Noise {
    /// A noise generator at the catalog default level.
    pub fn new(sr: f32) -> Noise {
        Noise { state: SEED, level: Smooth::new(sr, default(K, LEVEL)) }
    }

    /// Restart the (deterministic) sequence.
    pub fn reset(&mut self) {
        self.state = SEED;
    }

    /// Render one sub-block into `outs[0]` (1 channel).
    pub fn process(&mut self, params: &[f32], outs: &mut [PortBuf]) {
        let Some(out) = outs.first_mut() else { return };
        out.channels = 1;
        let target = param(params, K, LEVEL);
        for i in 0..RACK_BLOCK {
            // xorshift32
            let mut x = self.state;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            self.state = x;
            // Top 24 bits -> [-1, 1).
            let white = (x >> 8) as f32 * (2.0 / 16_777_216.0) - 1.0;
            out.data[0][i] = white * self.level.next(target);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_PARAMS;

    #[test]
    fn noise_mean_near_zero_and_bounded() {
        let mut n = Noise::new(48000.0);
        let params = [0.0f32; MAX_PARAMS];
        let mut params = params;
        params[LEVEL] = 1.0;
        let mut outs = [PortBuf::new()];
        let (mut sum, mut sq, mut count) = (0.0f64, 0.0f64, 0usize);
        for _ in 0..1500 {
            n.process(&params, &mut outs);
            assert_eq!(outs[0].channels, 1);
            for &x in &outs[0].data[0] {
                assert!(x.is_finite() && (-1.0..=1.0).contains(&x), "{x}");
                sum += x as f64;
                sq += (x * x) as f64;
                count += 1;
            }
        }
        assert!((sum / count as f64).abs() < 0.02, "mean {}", sum / count as f64);
        // Uniform on [-1,1): RMS = 1/sqrt(3).
        assert!(((sq / count as f64).sqrt() - 0.5774).abs() < 0.02);
    }

    #[test]
    fn level_scales_and_is_deterministic() {
        let mut a = Noise::new(48000.0);
        let mut b = Noise::new(48000.0);
        let mut params = [0.0f32; MAX_PARAMS];
        params[LEVEL] = 0.25;
        let (mut oa, mut ob) = ([PortBuf::new()], [PortBuf::new()]);
        for _ in 0..40 {
            a.process(&params, &mut oa);
            b.process(&params, &mut ob);
        }
        assert_eq!(oa[0].data[0], ob[0].data[0]);
        assert!(oa[0].data[0].iter().all(|x| x.abs() <= 0.25 + 0.01));
        assert!(oa[0].data[0].iter().any(|x| x.abs() > 0.1));
    }
}
