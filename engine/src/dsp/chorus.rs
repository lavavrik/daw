//! Chorus: a stereo modulated delay mixed with the dry signal.
//!
//! * **Line.** One ring per channel of at most [`MAX_MS`] (50 ms), sized at
//!   construction for the sample rate; the memory is borrowed at
//!   [`process`](ChorusCore::process) time (`buffer_len(sr)` floats) so a
//!   rack Chorus can run on pooled memory (`rack/fx_pool.rs`).
//! * **Modulation.** A sine LFO at `rate` (0.05..5 Hz) sweeps the read
//!   position around [`CENTER_MS`] by ±`depth`·[`SWEEP_MS`]
//!   (depth 0..1, so 5..25 ms at full depth). The right channel's LFO runs
//!   90° behind the left one, which widens the image. Reads are linearly
//!   interpolated, so the sweep is continuous (no zipper).
//! * **Mix** 0..1: `out = (1 − mix)·dry + mix·wet`. With no feedback the
//!   output never exceeds the input's peak.
//! * Depth and mix glide per sample (5 ms) and the LFO phase is continuous
//!   across rate changes, so no knob move clicks.

use super::{clampf, finite, flush, valid_sr, SMOOTH_SECONDS};
use crate::rack::modules::Smooth;

/// Longest delay the ring holds (ms).
pub const MAX_MS: f32 = 50.0;
/// Centre of the sweep (ms).
pub const CENTER_MS: f32 = 15.0;
/// Sweep half-width at depth 1 (ms).
pub const SWEEP_MS: f32 = 10.0;

/// Chorus state without its ring (see the module docs). Never allocates.
#[derive(Clone, Debug)]
pub struct ChorusCore {
    sr: f32,
    rate: f32,
    depth: f32,
    mix: f32,
    /// Ring length per channel (power of two): left `buf[0..cap]`, right
    /// `buf[cap..2cap]`.
    cap: usize,
    pos: usize,
    /// LFO phase 0..1 (left; right is a quarter cycle behind).
    phase: f32,
    depth_s: Smooth,
    mix_s: Smooth,
    fresh: bool,
}

impl ChorusCore {
    fn cap_for(sr: f32) -> usize {
        ((MAX_MS * 1e-3 * valid_sr(sr)).ceil() as usize + 4).next_power_of_two()
    }

    /// Floats of ring [`process`](ChorusCore::process) needs at `sr`.
    pub fn buffer_len(sr: f32) -> usize {
        2 * Self::cap_for(sr)
    }

    /// A chorus at the rack defaults: rate 0.6 Hz, depth 0.4, mix 0.5.
    pub fn new(sr: f32) -> ChorusCore {
        let sr = valid_sr(sr);
        ChorusCore {
            sr,
            rate: 0.6,
            depth: 0.4,
            mix: 0.5,
            cap: Self::cap_for(sr),
            pos: 0,
            phase: 0.0,
            depth_s: Smooth::with_time(sr, SMOOTH_SECONDS, 0.4),
            mix_s: Smooth::with_time(sr, SMOOTH_SECONDS, 0.5),
            fresh: true,
        }
    }

    /// LFO rate, 0.05..5 Hz.
    pub fn set_rate(&mut self, hz: f32) {
        if hz.is_finite() {
            self.rate = clampf(hz, 0.05, 5.0);
        }
    }

    /// Sweep depth, 0..1.
    pub fn set_depth(&mut self, depth: f32) {
        if depth.is_finite() {
            self.depth = clampf(depth, 0.0, 1.0);
        }
    }

    /// Dry/wet, 0..1.
    pub fn set_mix(&mut self, mix: f32) {
        if mix.is_finite() {
            self.mix = clampf(mix, 0.0, 1.0);
        }
    }

    /// Restart the LFO and jump to the targets. The ring is the caller's: it
    /// must zero it too to silence the tail.
    pub fn reset(&mut self) {
        self.phase = 0.0;
        self.fresh = true;
    }

    /// Process a stereo block in place through the ring `buf` (at least
    /// [`buffer_len`](ChorusCore::buffer_len) floats, else the output is
    /// silence).
    pub fn process(&mut self, buf: &mut [f32], l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        let Some(buf) = buf.get_mut(..2 * self.cap) else {
            l[..n].fill(0.0);
            r[..n].fill(0.0);
            return;
        };
        if self.fresh {
            self.fresh = false;
            self.depth_s = Smooth::with_time(self.sr, SMOOTH_SECONDS, self.depth);
            self.mix_s = Smooth::with_time(self.sr, SMOOTH_SECONDS, self.mix);
        }
        let (bl, br) = buf.split_at_mut(self.cap);
        let mask = self.cap - 1;
        let ms = self.sr * 1e-3;
        let inc = self.rate / self.sr;
        let max_delay = (self.cap - 3) as f32;
        for i in 0..n {
            let (xl, xr) = (finite(l[i]), finite(r[i]));
            bl[self.pos] = flush(xl);
            br[self.pos] = flush(xr);
            let depth = self.depth_s.next(self.depth);
            let mix = self.mix_s.next(self.mix);
            let tau = std::f32::consts::TAU;
            let (sl, sr) = ((tau * self.phase).sin(), (tau * (self.phase - 0.25)).sin());
            let dl = ((CENTER_MS + SWEEP_MS * depth * sl) * ms).clamp(1.0, max_delay);
            let dr = ((CENTER_MS + SWEEP_MS * depth * sr) * ms).clamp(1.0, max_delay);
            let (wl, wr) = (read(bl, self.pos, dl, mask), read(br, self.pos, dr, mask));
            self.phase += inc;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
            self.pos = (self.pos + 1) & mask;
            l[i] = finite(xl + mix * (wl - xl));
            r[i] = finite(xr + mix * (wr - xr));
        }
    }
}

/// Read `ring` (power-of-two length, `mask = len − 1`) `delay` (≥ 1)
/// samples behind `pos`, linearly interpolated.
#[inline]
fn read(ring: &[f32], pos: usize, delay: f32, mask: usize) -> f32 {
    let whole = delay as usize;
    let frac = delay - whole as f32;
    let a = ring[pos.wrapping_sub(whole) & mask];
    let b = ring[pos.wrapping_sub(whole + 1) & mask];
    a + (b - a) * frac
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_through(c: &mut ChorusCore, secs: f32) -> Vec<f32> {
        let mut buf = vec![0.0; ChorusCore::buffer_len(48000.0)];
        let n = (secs * 48000.0) as usize;
        let mut out = Vec::with_capacity(n);
        let mut i = 0;
        while i < n {
            let mut l: [f32; 128] =
                std::array::from_fn(|k| (std::f32::consts::TAU * 1000.0 * (i + k) as f32 / 48000.0).sin());
            let mut r = l;
            c.process(&mut buf, &mut l, &mut r);
            out.extend_from_slice(&l);
            i += 128;
        }
        out
    }

    /// (shortest, longest) period between rising zero crossings after 0.1 s.
    fn period_range(y: &[f32]) -> (f32, f32) {
        let ups: Vec<f32> = (4801..y.len())
            .filter(|&i| y[i - 1] < 0.0 && y[i] >= 0.0)
            .map(|i| (i - 1) as f32 + y[i - 1] / (y[i - 1] - y[i]))
            .collect();
        ups.windows(2).map(|w| w[1] - w[0]).fold((f32::MAX, 0.0f32), |(lo, hi), p| (lo.min(p), hi.max(p)))
    }

    #[test]
    fn chorus_sweeps_pitch_only_with_depth() {
        let mut c = ChorusCore::new(48000.0);
        c.set_mix(1.0);
        c.set_depth(1.0);
        c.set_rate(2.0);
        let (lo, hi) = period_range(&sine_through(&mut c, 2.0));
        assert!(hi / lo > 1.05, "depth 1: period {lo}..{hi}");
        let mut c = ChorusCore::new(48000.0);
        c.set_mix(1.0);
        c.set_depth(0.0);
        let (lo, hi) = period_range(&sine_through(&mut c, 1.0));
        assert!(hi / lo < 1.001, "depth 0: period {lo}..{hi}");
    }

    #[test]
    fn chorus_short_buffer_is_silent_and_garbage_is_finite() {
        let mut c = ChorusCore::new(48000.0);
        let (mut l, mut r) = ([1.0f32; 64], [1.0f32; 64]);
        c.process(&mut [0.0; 16], &mut l, &mut r);
        assert!(l.iter().chain(&r).all(|&x| x == 0.0));
        c.set_rate(f32::NAN);
        c.set_depth(f32::INFINITY);
        let mut buf = vec![0.0; ChorusCore::buffer_len(48000.0)];
        let (mut l, mut r) = ([f32::NAN; 64], [1e30f32; 64]);
        c.process(&mut buf, &mut l, &mut r);
        assert!(l.iter().chain(&r).all(|x| x.is_finite()));
        assert!(ChorusCore::buffer_len(96000.0) >= 2 * 4800);
    }
}
