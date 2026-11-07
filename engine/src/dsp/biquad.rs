//! Biquad: a second-order IIR section in transposed direct form II (TDF-II)
//! with the RBJ "Audio EQ Cookbook" designs (low/high shelf, peaking,
//! high-pass, low-pass).
//!
//! * Coefficients are designed and run in f64: low cutoffs at high sample
//!   rates (a 5 Hz high-pass at 96 kHz) put the poles within 1e-3 of the unit
//!   circle, where f32 coefficients and state lose too much precision.
//! * [`Biquad::set`] swaps coefficients **without** clearing the state, so a
//!   smoothed parameter sweep stays continuous (TDF-II tolerates coefficient
//!   changes well: its state holds partial outputs, not past inputs).
//! * One `Biquad` is one channel; stereo users keep two sharing one
//!   [`Coefs`].

use super::flush64;
use std::f64::consts::PI;

/// Normalised biquad coefficients (`a0 = 1`):
/// `y = b0·x + b1·x₋₁ + b2·x₋₂ − a1·y₋₁ − a2·y₋₂`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coefs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Coefs {
    /// The identity (`y = x`).
    pub const IDENTITY: Coefs = Coefs { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 };

    /// Shared prelude: clamps `hz` into 1 Hz..0.49·sr and returns
    /// `(cos w0, sin w0)`.
    fn w0(sr: f32, hz: f32) -> (f64, f64) {
        let sr = super::valid_sr(sr) as f64;
        let hz = super::clampf(hz, 1.0, 0.49 * sr as f32) as f64;
        let w = 2.0 * PI * hz / sr;
        (w.cos(), w.sin())
    }

    fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Coefs {
        let k = 1.0 / a0;
        Coefs { b0: b0 * k, b1: b1 * k, b2: b2 * k, a1: a1 * k, a2: a2 * k }
    }

    /// 2nd-order high-pass (RBJ), `q` = 0.7071 for Butterworth.
    pub fn high_pass(sr: f32, hz: f32, q: f32) -> Coefs {
        let (c, s) = Self::w0(sr, hz);
        let alpha = s / (2.0 * q.max(0.05) as f64);
        Self::norm((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    /// 2nd-order low-pass (RBJ).
    pub fn low_pass(sr: f32, hz: f32, q: f32) -> Coefs {
        let (c, s) = Self::w0(sr, hz);
        let alpha = s / (2.0 * q.max(0.05) as f64);
        Self::norm((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    /// Peaking EQ (RBJ, constant-Q bell): `gain_db` at `hz`, bandwidth `q`.
    pub fn peaking(sr: f32, hz: f32, gain_db: f32, q: f32) -> Coefs {
        let (c, s) = Self::w0(sr, hz);
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let alpha = s / (2.0 * q.max(0.05) as f64);
        Self::norm(1.0 + alpha * a, -2.0 * c, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * c, 1.0 - alpha / a)
    }

    /// Low shelf (RBJ, shelf slope S = 1): `gain_db` below `hz` (the
    /// half-gain point).
    pub fn low_shelf(sr: f32, hz: f32, gain_db: f32) -> Coefs {
        let (c, s) = Self::w0(sr, hz);
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let alpha = s / 2.0 * 2f64.sqrt(); // S = 1
        let k = 2.0 * a.sqrt() * alpha;
        Self::norm(
            a * ((a + 1.0) - (a - 1.0) * c + k),
            2.0 * a * ((a - 1.0) - (a + 1.0) * c),
            a * ((a + 1.0) - (a - 1.0) * c - k),
            (a + 1.0) + (a - 1.0) * c + k,
            -2.0 * ((a - 1.0) + (a + 1.0) * c),
            (a + 1.0) + (a - 1.0) * c - k,
        )
    }

    /// High shelf (RBJ, shelf slope S = 1): `gain_db` above `hz`.
    pub fn high_shelf(sr: f32, hz: f32, gain_db: f32) -> Coefs {
        let (c, s) = Self::w0(sr, hz);
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let alpha = s / 2.0 * 2f64.sqrt();
        let k = 2.0 * a.sqrt() * alpha;
        Self::norm(
            a * ((a + 1.0) + (a - 1.0) * c + k),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - k),
            (a + 1.0) - (a - 1.0) * c + k,
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - k,
        )
    }
}

/// One channel of a TDF-II biquad.
#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    c: Coefs,
    s1: f64,
    s2: f64,
}

impl Default for Biquad {
    fn default() -> Self {
        Biquad::new(Coefs::IDENTITY)
    }
}

impl Biquad {
    /// A biquad with coefficients `c` and zeroed state.
    pub fn new(c: Coefs) -> Biquad {
        Biquad { c, s1: 0.0, s2: 0.0 }
    }

    /// Replace the coefficients, keeping the state (no click on a sweep).
    #[inline]
    pub fn set(&mut self, c: Coefs) {
        self.c = c;
    }

    /// Current coefficients.
    pub fn coefs(&self) -> Coefs {
        self.c
    }

    /// Clear the state.
    pub fn reset(&mut self) {
        self.s1 = 0.0;
        self.s2 = 0.0;
    }

    /// Filter one sample (TDF-II).
    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        let x = super::finite(x) as f64;
        let c = &self.c;
        let y = c.b0 * x + self.s1;
        self.s1 = c.b1 * x - c.a1 * y + self.s2;
        self.s2 = c.b2 * x - c.a2 * y;
        y as f32
    }

    /// Flush denormal / non-finite state (call once per sub-block).
    #[inline]
    pub fn flush(&mut self) {
        self.s1 = flush64(self.s1);
        self.s2 = flush64(self.s2);
    }

    /// Magnitude response (dB) of `c` at `hz` (analysis helper for tests and
    /// UI curves; not for the audio thread).
    pub fn response_db(c: &Coefs, sr: f32, hz: f32) -> f64 {
        let w = 2.0 * PI * hz as f64 / super::valid_sr(sr) as f64;
        let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
        let nr = c.b0 + c.b1 * c1 + c.b2 * c2;
        let ni = -(c.b1 * s1 + c.b2 * s2);
        let dr = 1.0 + c.a1 * c1 + c.a2 * c2;
        let di = -(c.a1 * s1 + c.a2 * s2);
        10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_util::tone_gain_db;
    use super::*;

    const Q: f32 = std::f32::consts::FRAC_1_SQRT_2;

    fn measured(c: Coefs, hz: f64) -> f64 {
        let (mut bl, mut br) = (Biquad::new(c), Biquad::new(c));
        tone_gain_db(48000.0, hz, |l, r| {
            for v in l.iter_mut() {
                *v = bl.tick(*v);
            }
            for v in r.iter_mut() {
                *v = br.tick(*v);
            }
        })
    }

    #[test]
    fn biquad_designs_match_their_responses() {
        let sr = 48000.0;
        let cases = [
            (Coefs::low_pass(sr, 1000.0, Q), 1000.0, -3.01),
            (Coefs::high_pass(sr, 1000.0, Q), 1000.0, -3.01),
            (Coefs::peaking(sr, 2000.0, 9.0, 1.0), 2000.0, 9.0),
            (Coefs::low_shelf(sr, 100.0, 12.0), 20.0, 12.0),
            (Coefs::high_shelf(sr, 8000.0, -12.0), 20000.0, -12.0),
        ];
        for (c, hz, want) in cases {
            let m = measured(c, hz);
            assert!((m - want).abs() < 0.3, "{c:?} at {hz} Hz: {m} dB, want {want}");
            assert!((Biquad::response_db(&c, sr, hz as f32) - m).abs() < 0.05);
        }
    }

    #[test]
    fn coefficient_change_keeps_state() {
        // A sweep from 500 Hz to 520 Hz mid-signal must not jump.
        let sr = 48000.0;
        let mut b = Biquad::new(Coefs::low_pass(sr, 500.0, Q));
        let mut prev = 0.0f32;
        let mut max_step = 0.0f32;
        for i in 0..4800 {
            if i == 2400 {
                b.set(Coefs::low_pass(sr, 520.0, Q));
            }
            let x = (2.0 * std::f32::consts::PI * 100.0 * i as f32 / sr).sin();
            let y = b.tick(x);
            if i > 100 {
                max_step = max_step.max((y - prev).abs());
            }
            prev = y;
        }
        assert!(max_step > 0.0 && max_step < 0.02, "max step {max_step}");
    }

    #[test]
    fn non_finite_state_recovers() {
        let mut b = Biquad::new(Coefs::high_pass(48000.0, 5.0, Q));
        b.tick(f32::NAN);
        b.flush();
        assert!(b.tick(0.5).is_finite());
    }
}
