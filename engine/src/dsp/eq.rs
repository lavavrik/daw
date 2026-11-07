//! Eq3: the channel-strip EQ: a high-pass, a low shelf, a mid peak and a high
//! shelf, in that order, stereo.
//!
//! | band  | type                  | freq          | gain        | Q       |
//! |-------|-----------------------|---------------|-------------|---------|
//! | HP    | 12 dB/oct Butterworth | 20..1000 Hz   | –           | 0.7071  |
//! | low   | RBJ shelf (S = 1)     | 100 Hz        | −15..+15 dB | –       |
//! | mid   | RBJ peaking           | 200..8000 Hz  | −15..+15 dB | 0.3..4  |
//! | high  | RBJ shelf (S = 1)     | 8 kHz         | −15..+15 dB | –       |
//!
//! * **HP off at the bottom of its range.** A 20 Hz Butterworth is still
//!   −0.1 dB at 50 Hz, so "all flat" would not be flat. At the 20 Hz minimum
//!   the HP therefore parks its cutoff at [`HP_PARK_HZ`] (5 Hz: −0.0004 dB at
//!   50 Hz, and still a DC blocker) instead of switching out; moving the knob
//!   up from 20 Hz glides from 5 Hz, so there is no on/off click.
//! * **Smoothing.** Parameters glide in their natural domains (log2 Hz, dB,
//!   log2 Q) with a 5 ms one-pole stepped once per [`SUB_BLOCK`] frames, and
//!   the coefficients are recomputed only for bands that moved. Settled
//!   values equal their targets exactly, so a band at 0 dB is recognised as
//!   flat and skipped; its tiny leftover state (~1e-5 of the signal, from the
//!   last 1e-4 dB of the glide) is zeroed then, so skipping is seamless.

use super::biquad::{Biquad, Coefs};
use super::{clampf, finite, valid_sr, Glide, SMOOTH_SECONDS, SUB_BLOCK};

/// Where the HP cutoff sits when the knob is at its 20 Hz minimum ("off").
pub const HP_PARK_HZ: f32 = 5.0;
/// Low shelf corner.
pub const LOW_SHELF_HZ: f32 = 100.0;
/// High shelf corner.
pub const HIGH_SHELF_HZ: f32 = 8000.0;
/// HP knob range (Hz).
pub const HP_MIN: f32 = 20.0;
pub const HP_MAX: f32 = 1000.0;
/// Mid frequency range (Hz).
pub const MID_MIN: f32 = 200.0;
pub const MID_MAX: f32 = 8000.0;
/// Q range of the mid band.
pub const Q_MIN: f32 = 0.3;
pub const Q_MAX: f32 = 4.0;
/// Gain range of the shelves and the mid band (± dB).
pub const GAIN_MAX: f32 = 15.0;

const BUTTERWORTH_Q: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// Smoothed parameter indices.
const HP: usize = 0; // log2 Hz
const LOW: usize = 1; // dB
const MID_F: usize = 2; // log2 Hz
const MID_G: usize = 3; // dB
const MID_Q: usize = 4; // log2 Q
const HIGH: usize = 5; // dB
const NP: usize = 6;

/// Stereo 3-band EQ with high-pass (see the module docs).
#[derive(Clone, Debug)]
pub struct Eq3 {
    sr: f32,
    target: [f32; NP],
    cur: [Glide; NP],
    /// Bands: HP, low shelf, mid, high shelf; `[band][channel]`.
    bands: [[Biquad; 2]; 4],
    /// Whether each band is non-flat (flat bands are skipped).
    active: [bool; 4],
    fresh: bool,
}

impl Eq3 {
    /// A flat EQ (HP off, gains 0 dB, mid 1 kHz / Q 0.7).
    pub fn new(sr: f32) -> Eq3 {
        let sr = valid_sr(sr);
        let rate = sr / SUB_BLOCK as f32;
        let target = [HP_PARK_HZ.log2(), 0.0, 1000f32.log2(), 0.0, 0.7f32.log2(), 0.0];
        let mut cur = [Glide::new(0.0, SMOOTH_SECONDS, rate, 1e-4); NP];
        for (g, t) in cur.iter_mut().zip(target) {
            g.value = t;
        }
        let mut eq = Eq3 { sr, target, cur, bands: [[Biquad::default(); 2]; 4], active: [true; 4], fresh: true };
        eq.update(&[true; 4]);
        eq
    }

    /// High-pass cutoff, 20..1000 Hz; 20 Hz (the minimum) is "off".
    pub fn set_hp(&mut self, hz: f32) {
        if hz.is_finite() {
            let hz = clampf(hz, HP_MIN, HP_MAX);
            self.target[HP] = if hz <= HP_MIN { HP_PARK_HZ } else { hz }.log2();
        }
    }

    /// Low shelf (100 Hz) gain, −15..+15 dB.
    pub fn set_low(&mut self, db: f32) {
        if db.is_finite() {
            self.target[LOW] = clampf(db, -GAIN_MAX, GAIN_MAX);
        }
    }

    /// Mid peak: frequency 200..8000 Hz, gain −15..+15 dB, Q 0.3..4.
    pub fn set_mid(&mut self, hz: f32, db: f32, q: f32) {
        if hz.is_finite() {
            self.target[MID_F] = clampf(hz, MID_MIN, MID_MAX).log2();
        }
        if db.is_finite() {
            self.target[MID_G] = clampf(db, -GAIN_MAX, GAIN_MAX);
        }
        if q.is_finite() {
            self.target[MID_Q] = clampf(q, Q_MIN, Q_MAX).log2();
        }
    }

    /// High shelf (8 kHz) gain, −15..+15 dB.
    pub fn set_high(&mut self, db: f32) {
        if db.is_finite() {
            self.target[HIGH] = clampf(db, -GAIN_MAX, GAIN_MAX);
        }
    }

    /// Clear the filter state and jump to the targets (no allocation).
    pub fn reset(&mut self) {
        for b in self.bands.iter_mut().flatten() {
            b.reset();
        }
        self.fresh = true;
    }

    /// Recompute the coefficients of the bands flagged in `dirty`.
    fn update(&mut self, dirty: &[bool; 4]) {
        let v = self.cur.map(|g| g.value);
        let sr = self.sr;
        let coefs = [
            dirty[0].then(|| Coefs::high_pass(sr, v[HP].exp2(), BUTTERWORTH_Q)),
            dirty[1].then(|| Coefs::low_shelf(sr, LOW_SHELF_HZ, v[LOW])),
            dirty[2].then(|| Coefs::peaking(sr, v[MID_F].exp2(), v[MID_G], v[MID_Q].exp2())),
            dirty[3].then(|| Coefs::high_shelf(sr, HIGH_SHELF_HZ, v[HIGH])),
        ];
        let flat = [false, v[LOW] == 0.0, v[MID_G] == 0.0, v[HIGH] == 0.0];
        for (b, c) in coefs.into_iter().enumerate() {
            let Some(c) = c else { continue };
            for ch in &mut self.bands[b] {
                ch.set(c);
                if flat[b] {
                    // A 0 dB RBJ shelf/peak has b == a, i.e. y = x once its
                    // state is 0, but leftover state would only decay with
                    // the filter's own poles. The glide snaps to exactly 0 dB
                    // from within 1e-4 dB, where the state is ~1e-5 of the
                    // signal (it scales with b − a), so zeroing it here and
                    // skipping the band is seamless far below audibility.
                    ch.reset();
                }
            }
            self.active[b] = !flat[b];
        }
    }

    /// Filter a stereo block in place.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        if self.fresh {
            self.fresh = false;
            for (g, t) in self.cur.iter_mut().zip(self.target) {
                g.value = t;
            }
            self.update(&[true; 4]);
        }
        let mut start = 0;
        while start < n {
            let end = (start + SUB_BLOCK).min(n);
            // Step the glides once per sub-block; recompute moved bands.
            let mut moved = [false; NP];
            for (i, m) in moved.iter_mut().enumerate() {
                *m = self.cur[i].step(self.target[i]);
            }
            if moved.iter().any(|m| *m) {
                let dirty = [moved[HP], moved[LOW], moved[MID_F] || moved[MID_G] || moved[MID_Q], moved[HIGH]];
                self.update(&dirty);
            }
            for (b, band) in self.bands.iter_mut().enumerate() {
                if !self.active[b] {
                    continue;
                }
                let [bl, br] = band;
                for x in &mut l[start..end] {
                    *x = bl.tick(*x);
                }
                for x in &mut r[start..end] {
                    *x = br.tick(*x);
                }
                bl.flush();
                br.flush();
            }
            // Flat bands are skipped, so sanitise the input here too.
            for x in l[start..end].iter_mut().chain(r[start..end].iter_mut()) {
                *x = finite(*x);
            }
            start = end;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_util::tone_gain_db;
    use super::*;

    fn gain(eq: &mut Eq3, hz: f64) -> f64 {
        eq.reset();
        tone_gain_db(48000.0, hz, |l, r| eq.process(l, r))
    }

    #[test]
    fn eq_flat_when_zero_gain() {
        let mut eq = Eq3::new(48000.0);
        eq.set_hp(20.0);
        eq.set_low(0.0);
        eq.set_mid(1000.0, 0.0, 1.0);
        eq.set_high(0.0);
        for hz in [50.0, 1000.0, 10000.0] {
            let g = gain(&mut eq, hz);
            assert!(g.abs() <= 0.1, "{hz} Hz: {g} dB");
        }
    }

    #[test]
    fn eq_mid_boost_peaks_at_freq() {
        let mut eq = Eq3::new(48000.0);
        eq.set_mid(1000.0, 6.0, 1.0);
        let g = gain(&mut eq, 1000.0);
        assert!((g - 6.0).abs() <= 0.5, "{g} dB");
        // It is a peak: an octave either side is lower.
        assert!(gain(&mut eq, 500.0) < g - 1.0);
        assert!(gain(&mut eq, 2000.0) < g - 1.0);
    }

    #[test]
    fn hp_cuts_low() {
        for fc in [80.0f32, 400.0, 1000.0] {
            let mut eq = Eq3::new(48000.0);
            eq.set_hp(fc);
            let g = gain(&mut eq, fc as f64 / 4.0);
            assert!(g <= -12.0, "HP {fc}: {g} dB at fc/4");
            assert!(gain(&mut eq, fc as f64 * 4.0).abs() < 0.5);
        }
    }

    #[test]
    fn shelves_shelve() {
        let mut eq = Eq3::new(48000.0);
        eq.set_low(12.0);
        eq.set_high(-9.0);
        assert!((gain(&mut eq, 25.0) - 12.0).abs() < 0.5);
        assert!((gain(&mut eq, 20000.0) + 9.0).abs() < 0.7);
        assert!(gain(&mut eq, 1000.0).abs() < 0.5);
    }

    /// Largest kink (second difference, |Δ²y|) of an 80 Hz tone (0.1) through
    /// `eq` while the low shelf jumps −15 -> +15 dB at block 200 (and the mid
    /// band moves too). A low tone's own Δ² is ~6e-5, so this isolates the
    /// coefficient changes (a TDF-II jump barely *steps* a low tone, but it
    /// bends it). `smooth = false` is the control: the new coefficients are
    /// applied at once (the `fresh` jump), keeping the filter state.
    fn sweep_max_kink(eq: &mut Eq3, smooth: bool) -> f32 {
        let sr = 48000.0;
        eq.set_low(-15.0);
        eq.set_mid(200.0, -15.0, 0.3);
        let (mut prev, mut prev_step) = (0.0f32, 0.0f32);
        let mut max_step = 0.0f32;
        let mut t = 0usize;
        for blk in 0..400 {
            if blk == 200 {
                eq.set_low(15.0);
                eq.set_mid(400.0, 15.0, 4.0);
                if !smooth {
                    eq.fresh = true;
                }
            }
            let mut l = [0.0f32; 128];
            for (k, v) in l.iter_mut().enumerate() {
                *v = 0.1 * (2.0 * std::f32::consts::PI * 80.0 * (t + k) as f32 / sr).sin();
            }
            let mut r = l;
            eq.process(&mut l, &mut r);
            for v in l {
                assert!(v.is_finite());
                let step = v - prev;
                if t > 1 {
                    max_step = max_step.max((step - prev_step).abs());
                }
                (prev, prev_step) = (v, step);
                t += 1;
            }
        }
        max_step
    }

    #[test]
    fn eq_sweep_is_smooth_and_settles() {
        // A full-range shelf jump during a low tone: only small kinks, and
        // the gain lands on the target.
        let mut eq = Eq3::new(48000.0);
        let smooth = sweep_max_kink(&mut eq, true);
        assert_eq!(eq.cur.map(|g| g.value), eq.target);
        // The control (coefficients jumped) kinks far more: the bound below
        // only holds because of the glide.
        let jumped = sweep_max_kink(&mut Eq3::new(48000.0), false);
        assert!(smooth < 0.0015, "max kink {smooth}");
        assert!(jumped > 2.5 * smooth && jumped > 0.0015, "control {jumped} vs {smooth}");
    }

    #[test]
    fn eq_survives_garbage() {
        let mut eq = Eq3::new(48000.0);
        eq.set_mid(f32::NAN, f32::INFINITY, -1.0);
        eq.set_hp(1e9);
        let mut l = [f32::NAN, f32::INFINITY, 1e30, -1e30];
        let mut r = [0.0; 3];
        eq.process(&mut l, &mut r);
        eq.process(&mut [0.5; 64], &mut [0.5; 64]);
        let mut l = [0.25f32; 64];
        let mut r = [0.25f32; 64];
        eq.process(&mut l, &mut r);
        assert!(l.iter().chain(r.iter()).all(|v| v.is_finite()));
    }
}
