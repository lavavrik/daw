//! Compressor: feed-forward, stereo-linked, with an external key (sidechain).
//!
//! * **Detector.** Per sample the key level is `max(|key_l|, |key_r|)` (an
//!   instantaneous peak; the ballistics below do the smoothing). Levels below
//!   −80 dBFS (far under the −60 dB minimum threshold minus the knee) skip
//!   the log and count as no reduction.
//! * **Gain computer** (dB domain, Giannoulis/Massberg/Reiss 2012) with a
//!   6 dB soft knee `W` around threshold `T`, ratio `R`:
//!   * `2(x−T) < −W`: no reduction;
//!   * `|2(x−T)| ≤ W`: `gr = (1 − 1/R)(x − T + W/2)² / (2W)`;
//!   * above: `gr = (x − T)(1 − 1/R)`.
//! * **Ballistics.** The reduction (dB) is smoothed by a branching one-pole:
//!   the attack coefficient while the target reduction rises, the release
//!   coefficient while it falls (smoothing in the gain domain, so release is
//!   exponential in dB and there is no level-dependent attack).
//! * **Gain** = `10^((makeup − gr)/20)`, applied to both channels (linked, so
//!   the stereo image never shifts). Threshold, ratio and makeup glide per
//!   sample (5 ms) so knob moves do not click even at 0.1 ms attack.
//! * [`Compressor::gain_reduction_db`] is the smoothed reduction (≥ 0 dB),
//!   for meters.

use super::{clampf, finite, pole, valid_sr, Glide, SMOOTH_SECONDS};

/// Soft knee width (dB).
pub const KNEE_DB: f32 = 6.0;
/// Below this key level the detector skips the log (no reduction).
const FLOOR: f32 = 1e-4; // −80 dBFS

/// Feed-forward stereo-linked compressor with a sidechain key.
#[derive(Clone, Debug)]
pub struct Compressor {
    sr: f32,
    threshold: f32,
    ratio: f32,
    makeup: f32,
    thr_s: Glide,
    ratio_s: Glide,
    makeup_s: Glide,
    att: f32,
    rel: f32,
    /// Smoothed gain reduction (dB, ≥ 0).
    gr: f32,
    /// [`release_to_unity`](Compressor::release_to_unity): samples left and
    /// dB per sample.
    unity_left: u32,
    unity_step: f32,
    fresh: bool,
}

impl Compressor {
    /// A compressor at the mixer defaults: threshold −18 dB, ratio 4,
    /// attack 5 ms, release 120 ms, makeup 0 dB.
    pub fn new(sr: f32) -> Compressor {
        let sr = valid_sr(sr);
        let mut c = Compressor {
            sr,
            threshold: -18.0,
            ratio: 4.0,
            makeup: 0.0,
            thr_s: Glide::new(-18.0, SMOOTH_SECONDS, sr, 1e-4),
            ratio_s: Glide::new(4.0, SMOOTH_SECONDS, sr, 1e-5),
            makeup_s: Glide::new(0.0, SMOOTH_SECONDS, sr, 1e-4),
            att: 0.0,
            rel: 0.0,
            gr: 0.0,
            unity_left: 0,
            unity_step: 0.0,
            fresh: true,
        };
        c.set_attack_ms(5.0);
        c.set_release_ms(120.0);
        c
    }

    /// Threshold, −60..0 dBFS.
    pub fn set_threshold_db(&mut self, db: f32) {
        if db.is_finite() {
            self.threshold = clampf(db, -60.0, 0.0);
        }
    }

    /// Ratio, 1..20 (1 = no compression).
    pub fn set_ratio(&mut self, ratio: f32) {
        if ratio.is_finite() {
            self.ratio = clampf(ratio, 1.0, 20.0);
        }
    }

    /// Attack time constant, 0.1..100 ms.
    pub fn set_attack_ms(&mut self, ms: f32) {
        if ms.is_finite() {
            self.att = pole(clampf(ms, 0.1, 100.0) * 1e-3, self.sr);
        }
    }

    /// Release time constant, 10..1000 ms.
    pub fn set_release_ms(&mut self, ms: f32) {
        if ms.is_finite() {
            self.rel = pole(clampf(ms, 10.0, 1000.0) * 1e-3, self.sr);
        }
    }

    /// Makeup gain, 0..24 dB.
    pub fn set_makeup_db(&mut self, db: f32) {
        if db.is_finite() {
            self.makeup = clampf(db, 0.0, 24.0);
        }
    }

    /// Current (smoothed) gain reduction in dB, ≥ 0. Excludes makeup.
    pub fn gain_reduction_db(&self) -> f32 {
        self.gr
    }

    /// The key source vanished (the mixer's sidechain fallback): ramp the
    /// reduction linearly (in dB) to 0 over `samples`, ignoring the detector
    /// meanwhile, then detect normally again (attacking from 0 dB). A 2 ms
    /// ramp is a declick, so the duck never snaps open.
    pub fn release_to_unity(&mut self, samples: usize) {
        if self.gr > 0.0 && samples > 0 {
            self.unity_left = samples.min(u32::MAX as usize) as u32;
            self.unity_step = self.gr / samples as f32;
        }
    }

    /// Clear the detector state and jump to the targets (no allocation).
    pub fn reset(&mut self) {
        self.gr = 0.0;
        self.unity_left = 0;
        self.fresh = true;
    }

    /// Static curve: reduction (dB, ≥ 0) for a key level `x` (dBFS).
    #[inline]
    fn curve(x: f32, t: f32, r: f32) -> f32 {
        let over = x - t;
        let slope = 1.0 - 1.0 / r;
        if 2.0 * over < -KNEE_DB {
            0.0
        } else if 2.0 * over <= KNEE_DB {
            let k = over + KNEE_DB * 0.5;
            slope * k * k / (2.0 * KNEE_DB)
        } else {
            slope * over
        }
    }

    /// Jump the glides to their targets if nothing was processed yet.
    fn begin(&mut self) {
        if self.fresh {
            self.fresh = false;
            self.thr_s.value = self.threshold;
            self.ratio_s.value = self.ratio;
            self.makeup_s.value = self.makeup;
        }
    }

    /// One detector step for key samples `(kl, kr)`; returns the linear gain.
    #[inline]
    fn tick(&mut self, kl: f32, kr: f32) -> f32 {
        self.thr_s.step(self.threshold);
        self.ratio_s.step(self.ratio);
        self.makeup_s.step(self.makeup);
        if self.unity_left > 0 {
            self.unity_left -= 1;
            self.gr = if self.unity_left == 0 { 0.0 } else { (self.gr - self.unity_step).max(0.0) };
            return 10f32.powf((self.makeup_s.value - self.gr) * 0.05);
        }
        let level = finite(kl).abs().max(finite(kr).abs());
        let target = if level < FLOOR {
            0.0
        } else {
            // Finite: level ≥ 1e-4 and ≤ f32::MAX.
            Self::curve(20.0 * level.log10(), self.thr_s.value, self.ratio_s.value)
        };
        let coef = if target > self.gr { self.att } else { self.rel };
        let gr = target + (self.gr - target) * coef;
        // Snap a released reduction to exactly 0 (skips the pow below).
        self.gr = if gr < 1e-6 { 0.0 } else { gr };
        let db = self.makeup_s.value - self.gr;
        if db == 0.0 {
            1.0
        } else {
            10f32.powf(db * 0.05)
        }
    }

    /// Compress `l`/`r` in place, keyed by `key_l`/`key_r` (frames past the
    /// end of a shorter key count as silence).
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], key_l: &[f32], key_r: &[f32]) {
        self.begin();
        let n = l.len().min(r.len());
        for i in 0..n {
            let kl = key_l.get(i).copied().unwrap_or(0.0);
            let kr = key_r.get(i).copied().unwrap_or(0.0);
            let g = self.tick(kl, kr);
            l[i] = finite(finite(l[i]) * g);
            r[i] = finite(finite(r[i]) * g);
        }
    }

    /// Compress `l`/`r` in place keyed by themselves (no sidechain), without
    /// the caller needing a copy of the input.
    pub fn process_self(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.begin();
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let g = self.tick(*a, *b);
            *a = finite(finite(*a) * g);
            *b = finite(finite(*b) * g);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn sine(i: usize, amp: f32) -> f32 {
        amp * (2.0 * PI * 1000.0 * i as f32 / 48000.0).sin()
    }

    #[test]
    fn compressor_static_curve() {
        let mut c = Compressor::new(48000.0);
        c.set_threshold_db(-18.0);
        c.set_ratio(4.0);
        c.set_attack_ms(1.0);
        c.set_release_ms(200.0);
        let amp = db_amp(-6.0);
        let mut peak = 0.0f32;
        for b in 0..375 {
            let mut l = [0.0f32; 128];
            for (k, v) in l.iter_mut().enumerate() {
                *v = sine(b * 128 + k, amp);
            }
            let mut r = l;
            c.process_self(&mut l, &mut r);
            if b >= 300 {
                peak = l.iter().fold(peak, |p, v| p.max(v.abs()));
            }
        }
        let out_db = 20.0 * peak.log10();
        assert!((out_db + 15.0).abs() <= 0.5, "out {out_db} dBFS");
        assert!((c.gain_reduction_db() - 9.0).abs() < 0.5, "gr {}", c.gain_reduction_db());
    }

    fn db_amp(db: f32) -> f32 {
        10f32.powf(db / 20.0)
    }

    #[test]
    fn compressor_key_drives_gr() {
        let mut c = Compressor::new(48000.0);
        // Silent main, loud key.
        let key: Vec<f32> = (0..128).map(|i| sine(i, 0.9)).collect();
        for _ in 0..50 {
            let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
            c.process(&mut l, &mut r, &key, &key);
        }
        assert!(c.gain_reduction_db() > 1.0, "gr {}", c.gain_reduction_db());

        // Loud main, silent key.
        let mut c = Compressor::new(48000.0);
        let silent = [0.0f32; 128];
        for _ in 0..50 {
            let mut l: [f32; 128] = std::array::from_fn(|i| sine(i, 0.9));
            let mut r = l;
            c.process(&mut l, &mut r, &silent, &silent);
            assert!(l.iter().enumerate().all(|(i, v)| (v - sine(i, 0.9)).abs() < 1e-6));
        }
        assert!(c.gain_reduction_db().abs() < 1e-3, "gr {}", c.gain_reduction_db());
    }

    #[test]
    fn knee_is_continuous() {
        let (t, r) = (-18.0, 4.0);
        assert_eq!(Compressor::curve(-30.0, t, r), 0.0);
        assert!((Compressor::curve(-6.0, t, r) - 9.0).abs() < 1e-4);
        assert!((Compressor::curve(-18.0, t, r) - 0.75 * 9.0 / 12.0).abs() < 1e-4);
        let mut prev = 0.0;
        for i in 0..2000 {
            let x = -30.0 + i as f32 * 0.01;
            let g = Compressor::curve(x, t, r);
            assert!(g >= prev && g - prev < 0.01, "jump at {x}");
            prev = g;
        }
    }

    #[test]
    fn release_recovers_and_makeup_applies() {
        let mut c = Compressor::new(48000.0);
        c.set_makeup_db(6.0);
        let loud: [f32; 128] = std::array::from_fn(|i| sine(i, 1.0));
        for _ in 0..100 {
            c.process(&mut [0.0; 128], &mut [0.0; 128], &loud, &loud);
        }
        assert!(c.gain_reduction_db() > 6.0);
        // 2 s of silent key at release 120 ms: fully recovered.
        for _ in 0..750 {
            c.process(&mut [0.0; 128], &mut [0.0; 128], &[], &[]);
        }
        assert!(c.gain_reduction_db() < 1e-3);
        let (mut l, mut r) = ([0.1f32; 128], [0.1f32; 128]);
        c.process(&mut l, &mut r, &[], &[]);
        assert!((l[127] - 0.1 * db_amp(6.0)).abs() < 1e-4, "{}", l[127]);
    }

    #[test]
    fn release_to_unity_ramps_gr_to_zero_linearly() {
        // Deep ducking from a loud key, then the key source vanishes: the
        // reduction falls to 0 dB linearly over exactly the given samples
        // (ignoring the detector meanwhile), then normal detection resumes.
        let mut c = Compressor::new(48000.0);
        let loud: [f32; 128] = std::array::from_fn(|i| sine(i, 1.0));
        for _ in 0..50 {
            c.process(&mut [0.0; 128], &mut [0.0; 128], &loud, &loud);
        }
        let gr0 = c.gain_reduction_db();
        assert!(gr0 > 6.0, "{gr0}");
        c.release_to_unity(96);
        let mut gains = Vec::new();
        for _ in 0..96 {
            // A still-loud key during the fade is ignored.
            let (mut l, mut r) = ([1.0f32], [1.0f32]);
            c.process(&mut l, &mut r, &[1.0], &[1.0]);
            gains.push(-20.0 * l[0].log10());
        }
        assert!(c.gain_reduction_db().abs() < 1e-4, "{}", c.gain_reduction_db());
        for w in gains.windows(2) {
            assert!((w[0] - w[1] - gr0 / 96.0).abs() < 1e-3, "linear in dB: {w:?}");
        }
        // Afterwards the detector works again (attack from 0 dB).
        for _ in 0..50 {
            c.process(&mut [0.0; 128], &mut [0.0; 128], &loud, &loud);
        }
        assert!(c.gain_reduction_db() > 6.0);
        // From no reduction it is a no-op.
        let mut c = Compressor::new(48000.0);
        c.release_to_unity(96);
        let (mut l, mut r) = ([0.01f32; 4], [0.01f32; 4]);
        c.process_self(&mut l, &mut r);
        assert_eq!(l, [0.01; 4]);
    }

    #[test]
    fn compressor_survives_garbage() {
        let mut c = Compressor::new(48000.0);
        c.set_ratio(f32::NAN);
        c.set_attack_ms(-5.0);
        let key = [f32::NAN, f32::INFINITY, 1e30, -1e30];
        let (mut l, mut r) = ([f32::NAN, 1.0, 1e30, 0.5], [f32::NEG_INFINITY, 1.0, 1.0, 0.5]);
        c.process(&mut l, &mut r, &key, &key);
        assert!(l.iter().chain(r.iter()).all(|v| v.is_finite()));
        assert!(c.gain_reduction_db().is_finite());
    }
}
