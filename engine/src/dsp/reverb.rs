//! Reverb: an 8-line feedback delay network (FDN), 100% wet, stereo in/out.
//!
//! * **Topology.** Per sample: read the 8 line outputs `y`, scale each by its
//!   RT60 gain `g_i`, damp it with a one-pole low-pass, mix the 8 through a
//!   Householder matrix `A = I − (2/N)·11ᵀ` (orthogonal, so the loop itself is
//!   lossless and all the decay comes from `g_i`), add the input and write the
//!   lines back.
//! * **Lengths.** [`BASE_LENGTHS`] are primes at 48 kHz (43..73 ms, mutually
//!   incommensurate to avoid stacked modes), scaled by the sample rate and by
//!   size: `scale = 0.25 + 0.75·size` (size 0 → 11..18 ms, a small room;
//!   size 1 → the full lengths). Lines are allocated once for size 1 at the
//!   construction sample rate. Targets are rounded to whole samples, so a
//!   settled line reads without interpolation (no extra HF loss); while size
//!   moves the read positions glide (≈80 ms one-pole, at most 0.5 sample per
//!   sample) through linearly interpolated reads.
//! * **Decay.** `g_i = 10^(−3·L_i / (sr·decay))`: every trip round line `i`
//!   loses `60·L_i/(sr·decay)` dB, i.e. −60 dB after `decay` seconds whatever
//!   the line length. Recomputed per [`SUB_BLOCK`] when size or decay moves.
//! * **Damping** 0..1 sets the in-loop one-pole `s += (1−p)(x − s)` with
//!   `p = 0.85·damping` (unity at DC, so the low-frequency RT60 stays at
//!   `decay`; highs die faster). Damping 0 is no filtering.
//! * **Stereo.** The (predelayed) left input feeds the even lines and the
//!   right the odd ones, with alternating signs; the outputs are two
//!   orthogonal sign patterns over all 8 lines, so L and R are decorrelated
//!   but share the same tail.
//! * **Predelay** 0..200 ms: a stereo ring read at a gliding position
//!   (same glide as the lines).

use super::{clampf, finite, flush, pole, valid_sr, Glide, SMOOTH_SECONDS, SUB_BLOCK};

/// Line lengths at 48 kHz for size 1 (primes).
pub const BASE_LENGTHS: [usize; 8] = [2053, 2251, 2399, 2617, 2797, 3011, 3251, 3517];
/// Longest predelay (ms).
pub const MAX_PREDELAY_MS: f32 = 200.0;
const N: usize = 8;
/// Input gain into each line.
const IN_GAIN: f32 = 0.5;
/// Output gain over the 8 taps.
const OUT_GAIN: f32 = 0.35;
/// Read-position glide: time constant and max speed (samples per sample).
const GLIDE_SECONDS: f32 = 0.08;
const GLIDE_MAX: f32 = 0.5;

/// Left / right output tap signs (orthogonal to each other).
const TAP_L: [f32; N] = [1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0];
const TAP_R: [f32; N] = [1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0];

/// 8-line FDN reverb (see the module docs).
#[derive(Clone, Debug)]
pub struct Reverb {
    sr: f32,
    size: f32,
    decay: f32,
    damping: f32,
    predelay_ms: f32,
    /// Ring buffers: line `i` occupies `lines[i*cap .. (i+1)*cap]`.
    lines: Vec<f32>,
    cap: usize,
    pos: usize,
    /// Current (gliding) and target read lengths, in samples.
    len: [f32; N],
    len_target: [f32; N],
    gain: [f32; N],
    damp_state: [f32; N],
    decay_s: Glide,
    damp_s: Glide,
    /// Predelay ring (stereo, interleaved per channel blocks).
    pre: Vec<f32>,
    pre_cap: usize,
    pre_pos: usize,
    pre_len: f32,
    glide_coef: f32,
    fresh: bool,
}

impl Reverb {
    /// A reverb at the mixer defaults (size 0.6, decay 2.2 s, damping 0.5,
    /// predelay 20 ms). Allocates the lines for size 1 and the 200 ms
    /// predelay at `sr`.
    pub fn new(sr: f32) -> Reverb {
        let sr = valid_sr(sr);
        let longest = (BASE_LENGTHS[N - 1] as f32 * sr / 48000.0).ceil() as usize;
        let cap = (longest + 4).next_power_of_two();
        let pre_cap = ((MAX_PREDELAY_MS * 1e-3 * sr).ceil() as usize + 4).next_power_of_two();
        let mut r = Reverb {
            sr,
            size: 0.6,
            decay: 2.2,
            damping: 0.5,
            predelay_ms: 20.0,
            lines: vec![0.0; N * cap],
            cap,
            pos: 0,
            len: [1.0; N],
            len_target: [1.0; N],
            gain: [0.0; N],
            damp_state: [0.0; N],
            decay_s: Glide::new(2.2, SMOOTH_SECONDS, sr / SUB_BLOCK as f32, 1e-4),
            damp_s: Glide::new(0.5, SMOOTH_SECONDS, sr / SUB_BLOCK as f32, 1e-4),
            pre: vec![0.0; 2 * pre_cap],
            pre_cap,
            pre_pos: 0,
            pre_len: 0.0,
            glide_coef: 1.0 - pole(GLIDE_SECONDS, sr),
            fresh: true,
        };
        r.set_size(0.6);
        r
    }

    /// Size 0..1 (scales the line lengths).
    pub fn set_size(&mut self, size: f32) {
        if size.is_finite() {
            self.size = clampf(size, 0.0, 1.0);
            let scale = (0.25 + 0.75 * self.size) * self.sr / 48000.0;
            for (t, b) in self.len_target.iter_mut().zip(BASE_LENGTHS) {
                *t = (b as f32 * scale).round().max(2.0).min((self.cap - 3) as f32);
            }
        }
    }

    /// Decay (RT60), 0.2..20 s.
    pub fn set_decay(&mut self, seconds: f32) {
        if seconds.is_finite() {
            self.decay = clampf(seconds, 0.2, 20.0);
        }
    }

    /// High-frequency damping 0..1.
    pub fn set_damping(&mut self, damping: f32) {
        if damping.is_finite() {
            self.damping = clampf(damping, 0.0, 1.0);
        }
    }

    /// Predelay, 0..200 ms.
    pub fn set_predelay_ms(&mut self, ms: f32) {
        if ms.is_finite() {
            self.predelay_ms = clampf(ms, 0.0, MAX_PREDELAY_MS);
        }
    }

    /// Silence the tail and jump to the targets (no allocation).
    pub fn reset(&mut self) {
        self.lines.fill(0.0);
        self.pre.fill(0.0);
        self.damp_state = [0.0; N];
        self.fresh = true;
    }

    /// Process a stereo block in place: the input is replaced by the wet
    /// signal.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        let pre_target = (self.predelay_ms * 1e-3 * self.sr).round().min((self.pre_cap - 2) as f32);
        if self.fresh {
            self.fresh = false;
            self.len = self.len_target;
            self.pre_len = pre_target;
            self.decay_s.value = self.decay;
            self.damp_s.value = self.damping;
            self.update_gains();
        }
        let (cap_mask, pre_mask) = (self.cap - 1, self.pre_cap - 1);
        let mut start = 0;
        while start < n {
            let end = (start + SUB_BLOCK).min(n);
            let gliding = self.len != self.len_target;
            let moved = self.decay_s.step(self.decay) | self.damp_s.step(self.damping);
            if moved || gliding {
                self.update_gains();
            }
            let p = 0.85 * self.damp_s.value;
            for i in start..end {
                // Predelay: write, then read `pre_len` back (0 = this sample).
                let (xl, xr) = (finite(l[i]), finite(r[i]));
                self.pre[self.pre_pos] = xl;
                self.pre[self.pre_cap + self.pre_pos] = xr;
                self.pre_len = glide(self.pre_len, pre_target, self.glide_coef);
                let (il, ir) = (
                    read(&self.pre[..self.pre_cap], self.pre_pos, self.pre_len, pre_mask),
                    read(&self.pre[self.pre_cap..], self.pre_pos, self.pre_len, pre_mask),
                );
                self.pre_pos = (self.pre_pos + 1) & pre_mask;

                // FDN: read the lines (before writing, so a sample written
                // now is read `len` samples later).
                let mut y = [0.0f32; N];
                let mut d = [0.0f32; N];
                for k in 0..N {
                    if gliding {
                        self.len[k] = glide(self.len[k], self.len_target[k], self.glide_coef);
                    }
                    let line = &self.lines[k * self.cap..(k + 1) * self.cap];
                    y[k] = read(line, self.pos, self.len[k], cap_mask);
                    // Decay gain, then the damping low-pass.
                    let s = &mut self.damp_state[k];
                    *s = flush(y[k] * self.gain[k] + p * (*s - y[k] * self.gain[k]));
                    d[k] = *s;
                }
                // Householder: f = d − (2/N)·Σd.
                let sum = d.iter().sum::<f32>() * (2.0 / N as f32);
                let (mut ol, mut or) = (0.0f32, 0.0f32);
                for k in 0..N {
                    let inject = if k % 2 == 0 { il } else { ir };
                    let sign = if k % 4 < 2 { 1.0 } else { -1.0 };
                    self.lines[k * self.cap + self.pos] = flush(d[k] - sum + IN_GAIN * sign * inject);
                    ol += TAP_L[k] * y[k];
                    or += TAP_R[k] * y[k];
                }
                self.pos = (self.pos + 1) & cap_mask;
                l[i] = finite(ol * OUT_GAIN);
                r[i] = finite(or * OUT_GAIN);
            }
            start = end;
        }
    }

    /// RT60 gains from the current lengths and decay:
    /// `g_i = 10^(−3·L_i / (sr·decay))`.
    fn update_gains(&mut self) {
        let k = -3.0 * std::f32::consts::LN_10 / (self.sr * self.decay_s.value);
        for (g, len) in self.gain.iter_mut().zip(self.len) {
            *g = (k * len).exp();
        }
    }
}

/// One step of a read-position glide: one-pole toward `target`, at most
/// [`GLIDE_MAX`] samples per sample, snapping within 1e-3.
#[inline]
fn glide(cur: f32, target: f32, coef: f32) -> f32 {
    let d = target - cur;
    if d.abs() < 1e-3 {
        target
    } else {
        cur + (d * coef).clamp(-GLIDE_MAX, GLIDE_MAX)
    }
}

/// Read `ring` (power-of-two length, `mask = len − 1`) `delay` samples behind
/// `pos`, linearly interpolated (exact for whole-sample delays).
#[inline]
fn read(ring: &[f32], pos: usize, delay: f32, mask: usize) -> f32 {
    let whole = delay as usize;
    let frac = delay - whole as f32;
    let a = ring[(pos.wrapping_sub(whole)) & mask];
    if frac == 0.0 {
        a
    } else {
        let b = ring[(pos.wrapping_sub(whole + 1)) & mask];
        a + (b - a) * frac
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_util::Noise;
    use super::*;

    /// Render `secs` of the reverb's response to `input(i)` (mono into both
    /// channels); returns the left output.
    fn render(rv: &mut Reverb, secs: f32, mut input: impl FnMut(usize) -> f32) -> Vec<f32> {
        let n = (secs * 48000.0) as usize;
        let mut out = Vec::with_capacity(n);
        let mut i = 0;
        while i < n {
            let mut l: [f32; 128] = std::array::from_fn(|k| input(i + k));
            let mut r = l;
            rv.process(&mut l, &mut r);
            for (a, b) in l.iter().zip(r.iter()) {
                assert!(a.is_finite() && b.is_finite());
            }
            out.extend_from_slice(&l);
            i += 128;
        }
        out
    }

    /// RT60 via Schroeder backward integration: twice the time from −5 to
    /// −35 dB on the energy decay curve.
    fn rt60(y: &[f32]) -> f64 {
        let mut edc = vec![0.0f64; y.len() + 1];
        for i in (0..y.len()).rev() {
            edc[i] = edc[i + 1] + (y[i] as f64).powi(2);
        }
        let total = edc[0];
        let t = |db: f64| edc.iter().position(|e| 10.0 * (e / total).log10() < db).unwrap() as f64 / 48000.0;
        2.0 * (t(-35.0) - t(-5.0))
    }

    #[test]
    fn reverb_rt60_close_to_decay() {
        let mut rv = Reverb::new(48000.0);
        rv.set_decay(2.0);
        rv.set_damping(0.0);
        rv.set_predelay_ms(0.0);
        let y = render(&mut rv, 4.0, |i| if i == 0 { 1.0 } else { 0.0 });
        let t = rt60(&y);
        assert!((t - 2.0).abs() <= 0.6, "rt60 {t}");
    }

    #[test]
    fn reverb_rt60_tracks_size_and_decay() {
        for (size, decay) in [(0.0, 0.5), (1.0, 5.0)] {
            let mut rv = Reverb::new(48000.0);
            rv.set_size(size);
            rv.set_decay(decay);
            rv.set_damping(0.0);
            let y = render(&mut rv, decay * 2.0, |i| if i == 0 { 1.0 } else { 0.0 });
            let t = rt60(&y);
            assert!((t / decay as f64 - 1.0).abs() <= 0.3, "size {size} decay {decay}: rt60 {t}");
        }
    }

    #[test]
    fn reverb_stable_extremes() {
        let mut rv = Reverb::new(48000.0);
        rv.set_decay(20.0);
        rv.set_size(1.0);
        rv.set_damping(0.0);
        let mut noise = Noise::new(7);
        let y = render(&mut rv, 10.0, |_| noise.next());
        let peak = y.iter().fold(0.0f32, |p, v| p.max(v.abs()));
        assert!(peak < 50.0, "peak {peak}");
        // And the output is actually reverb, not silence.
        assert!(peak > 0.5);
    }

    #[test]
    fn reverb_predelay_delays_onset_and_stereo_decorrelates() {
        let mut rv = Reverb::new(48000.0);
        rv.set_predelay_ms(100.0);
        rv.set_size(0.0);
        let n = 48000;
        let (mut ls, mut rs) = (Vec::new(), Vec::new());
        let mut i = 0;
        while i < n {
            let mut l = [0.0f32; 128];
            if i == 0 {
                l[0] = 1.0;
            }
            let mut r = l;
            rv.process(&mut l, &mut r);
            ls.extend_from_slice(&l);
            rs.extend_from_slice(&r);
            i += 128;
        }
        let onset = ls.iter().position(|v| v.abs() > 1e-6).unwrap();
        // 100 ms predelay + the shortest size-0 line (2053/4 ≈ 513).
        assert!((onset as i64 - 4800 - 513).abs() <= 2, "onset {onset}");
        let dot: f64 = ls.iter().zip(&rs).map(|(a, b)| (*a as f64) * (*b as f64)).sum();
        let el: f64 = ls.iter().map(|a| (*a as f64).powi(2)).sum();
        let er: f64 = rs.iter().map(|a| (*a as f64).powi(2)).sum();
        assert!((dot / (el * er).sqrt()).abs() < 0.3, "L/R correlation too high");
    }

    #[test]
    fn reverb_param_moves_are_smooth() {
        // Sweep size and predelay while a tail rings: finite, no big steps.
        let mut rv = Reverb::new(48000.0);
        let mut noise = Noise::new(3);
        let mut prev = 0.0f32;
        let mut max_step = 0.0f32;
        for blk in 0..1500 {
            if blk == 300 {
                rv.set_size(1.0);
                rv.set_predelay_ms(200.0);
                rv.set_decay(20.0);
            }
            if blk == 800 {
                rv.set_size(0.0);
                rv.set_predelay_ms(0.0);
                rv.set_damping(1.0);
                rv.set_decay(0.2);
            }
            let mut l: [f32; 128] = std::array::from_fn(|_| if blk < 200 { 0.1 * noise.next() } else { 0.0 });
            let mut r = l;
            rv.process(&mut l, &mut r);
            for v in l {
                assert!(v.is_finite());
                if blk > 250 {
                    max_step = max_step.max((v - prev).abs());
                }
                prev = v;
            }
        }
        assert!(max_step < 0.1, "max step {max_step}");
    }

    #[test]
    fn reverb_reset_silences() {
        let mut rv = Reverb::new(48000.0);
        render(&mut rv, 0.5, |i| if i < 100 { 1.0 } else { 0.0 });
        rv.reset();
        let y = render(&mut rv, 0.5, |_| 0.0);
        assert!(y.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn reverb_sizes_its_lines_from_the_sample_rate() {
        let rv = Reverb::new(96000.0);
        assert!(rv.cap >= 2 * BASE_LENGTHS[N - 1] + 3);
        assert!(rv.pre_cap >= 19200);
        let mut rv = Reverb::new(96000.0);
        rv.set_size(1.0);
        assert_eq!(rv.len_target[0], 4106.0);
    }
}
