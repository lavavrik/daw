//! Out: the rack's stereo output.
//!
//! Sums every channel of `l` and of `r` (a poly voice signal mixes down here),
//! times `level`. If `r` is unconnected, `l` feeds both sides. The result for
//! the current sub-block is left in `l`/`r`, which the rack adds to the track
//! output (several Out modules sum). Non-finite samples are replaced by 0.
//!
//! Voice activity (plan 12, `vis.rs`): beside the sum, which is computed
//! exactly as before, Out records each input channel's peak over the
//! sub-block, `peak[k] = max(|l_k|, |r_k|) × level` (channel `k` of the poly
//! cable is voice `k`; channels past the inputs' read 0; non-finite samples
//! are skipped, as the sum zeroes them). The rack takes the
//! max over its Outs. It only reads the inputs: the output is unchanged.

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::PortBuf;
use crate::{MAX_POLY, RACK_BLOCK};

const LEVEL: usize = 0;

#[derive(Clone)]
pub struct Out {
    level: Smooth,
    /// This sub-block's stereo output.
    pub l: [f32; RACK_BLOCK],
    pub r: [f32; RACK_BLOCK],
    /// This sub-block's peak per input channel (voice activity, see above).
    pub peak: [f32; MAX_POLY],
}

impl Out {
    /// Automation: the next sub-block takes its `smooth` params at once.
    pub fn snap(&mut self) {
        self.level.snap();
    }

    pub fn new(sr: f32) -> Out {
        Out {
            level: Smooth::new(sr, default(ModuleKind::Out, LEVEL)),
            l: [0.0; RACK_BLOCK],
            r: [0.0; RACK_BLOCK],
            peak: [0.0; MAX_POLY],
        }
    }

    pub fn reset(&mut self) {
        self.l = [0.0; RACK_BLOCK];
        self.r = [0.0; RACK_BLOCK];
        self.peak = [0.0; MAX_POLY];
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf]) {
        let (Some(l), Some(r)) = (ins.first(), ins.get(1)) else {
            self.reset();
            return;
        };
        let r = if r.channels == 0 { l } else { r };
        let target = param(params, ModuleKind::Out, LEVEL);
        let (nl, nr) = (l.channels.min(MAX_POLY), r.channels.min(MAX_POLY));
        self.peak = [0.0; MAX_POLY];
        for i in 0..RACK_BLOCK {
            let level = self.level.next(target);
            let sl: f32 = (0..nl).map(|ch| l.get(ch, i)).sum();
            let sr: f32 = (0..nr).map(|ch| r.get(ch, i)).sum();
            let (ol, or) = (sl * level, sr * level);
            self.l[i] = if ol.is_finite() { ol } else { 0.0 };
            self.r[i] = if or.is_finite() { or } else { 0.0 };
            // Voice activity: reads the rows the sum read (no broadcast).
            for (k, p) in self.peak.iter_mut().enumerate().take(nl.max(nr)) {
                let a = if k < nl { l.data[k][i].abs() } else { 0.0 };
                let b = if k < nr { r.data[k][i].abs() } else { 0.0 };
                let v = a.max(b) * level;
                // `a.max(b)` drops a NaN; an infinite sample never counts.
                if v > *p && v.is_finite() {
                    *p = v;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Out exactly as plan 11 shipped it (frozen): the sum the rack hears.
    struct Plan11Out {
        level: Smooth,
        l: [f32; RACK_BLOCK],
        r: [f32; RACK_BLOCK],
    }

    impl Plan11Out {
        fn process(&mut self, params: &[f32], ins: &[PortBuf]) {
            let (Some(l), Some(r)) = (ins.first(), ins.get(1)) else {
                self.l = [0.0; RACK_BLOCK];
                self.r = [0.0; RACK_BLOCK];
                return;
            };
            let r = if r.channels == 0 { l } else { r };
            let target = param(params, ModuleKind::Out, LEVEL);
            for i in 0..RACK_BLOCK {
                let level = self.level.next(target);
                let sl: f32 = (0..l.channels.min(MAX_POLY)).map(|ch| l.get(ch, i)).sum();
                let sr: f32 = (0..r.channels.min(MAX_POLY)).map(|ch| r.get(ch, i)).sum();
                let (ol, or) = (sl * level, sr * level);
                self.l[i] = if ol.is_finite() { ol } else { 0.0 };
                self.r[i] = if or.is_finite() { or } else { 0.0 };
            }
        }
    }

    /// A poly input of `channels` channels of pseudo-random audio.
    fn poly(channels: usize, seed: u32) -> PortBuf {
        let mut p = PortBuf::new();
        p.channels = channels;
        let mut x = seed;
        for ch in 0..channels {
            for i in 0..RACK_BLOCK {
                x = x.wrapping_mul(1664525).wrapping_add(1013904223);
                p.data[ch][i] = ((x >> 8) as f32 / (1u32 << 24) as f32) * 2.0 - 1.0;
            }
        }
        p
    }

    #[test]
    fn out_sum_unchanged() {
        let sr = 48000.0;
        let mut out = Out::new(sr);
        let mut old = Plan11Out { level: Smooth::new(sr, default(ModuleKind::Out, LEVEL)), l: [0.0; RACK_BLOCK], r: [0.0; RACK_BLOCK] };
        for b in 0..64u32 {
            // Poly l (5 voices) and r (3 voices), then r unconnected, with
            // level moves (smoothed) on the way.
            let l = poly(5, b + 1);
            let r = if b < 32 { poly(3, b + 100) } else { PortBuf::new() };
            let level = if b < 20 { 0.8 } else if b < 40 { 0.3 } else { 1.0 };
            out.process(&[level], &[l.clone(), r.clone()]);
            old.process(&[level], &[l, r]);
            for i in 0..RACK_BLOCK {
                assert_eq!(out.l[i].to_bits(), old.l[i].to_bits(), "block {b} L {i}");
                assert_eq!(out.r[i].to_bits(), old.r[i].to_bits(), "block {b} R {i}");
            }
        }
    }

    #[test]
    fn out_records_each_voice_peak() {
        // Voice k's peak is max(|l_k|, |r_k|) x level over the sub-block;
        // channels past the input's are 0.
        let mut out = Out::new(48000.0);
        let (mut l, mut r) = (PortBuf::new(), PortBuf::new());
        l.channels = 3;
        r.channels = 2;
        for i in 0..RACK_BLOCK {
            l.data[0][i] = if i == 7 { -0.5 } else { 0.1 };
            l.data[1][i] = 0.0;
            l.data[2][i] = 0.25;
            r.data[0][i] = 0.2;
            r.data[1][i] = if i == 3 { 0.75 } else { 0.0 };
        }
        // Level 1 (snapped) so the peaks are the raw magnitudes.
        out.snap();
        out.process(&[1.0], &[l, r]);
        assert_eq!(&out.peak[..4], &[0.5, 0.75, 0.25, 0.0]);
        assert!(out.peak[4..].iter().all(|&p| p == 0.0));
        out.reset();
        assert!(out.peak.iter().all(|&p| p == 0.0));
    }

    #[test]
    fn out_peaks_skip_non_finite_samples() {
        // A NaN or infinite sample (which the sum turns into 0) never
        // reaches the voice LEDs: the peak stays the finite maximum.
        let mut out = Out::new(48000.0);
        let mut l = PortBuf::new();
        l.channels = 2;
        for i in 0..RACK_BLOCK {
            l.data[0][i] = if i == 5 { f32::INFINITY } else { 0.25 };
            l.data[1][i] = if i == 9 { f32::NAN } else if i == 10 { f32::NEG_INFINITY } else { -0.5 };
        }
        out.snap();
        out.process(&[1.0], &[l, PortBuf::new()]);
        assert_eq!(&out.peak[..2], &[0.25, 0.5]);
        assert!(out.peak.iter().all(|p| p.is_finite()));
    }
}
