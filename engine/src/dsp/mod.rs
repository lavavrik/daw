//! Shared DSP for the mixer (and later rack effect modules): a TDF-II
//! [`Biquad`](biquad::Biquad) with RBJ designs, a 3-band [`Eq3`](eq::Eq3)
//! with a high-pass, a feed-forward [`Compressor`](compressor::Compressor), an
//! 8-line FDN [`Reverb`](reverb::Reverb), a tempo-synced
//! [`Delay`](delay::Delay) and a lookahead [`Limiter`](limiter::Limiter).
//!
//! Contract for every processor (the audio thread must never allocate, block
//! or panic):
//! * `new(sr)` allocates everything (delay lines, ring buffers) once, sized
//!   from the sample rate. `process*` and every setter never allocate;
//!   `reset()` clears the state without allocating.
//! * Processing is in place on stereo slices (`l`, `r`); the frame count is
//!   `min(l.len(), r.len())`, so mismatched slices never index out of bounds.
//! * Setters are cheap: they clamp to the documented range, ignore non-finite
//!   values, and only store a target. The processor glides to it (5 ms
//!   one-pole by default; per 32-sample sub-block where coefficients are
//!   expensive), so knob moves never click.
//! * Before anything has been processed (after `new` or `reset`) targets are
//!   taken immediately: a freshly configured processor does not glide in from
//!   its defaults.
//! * Non-finite input samples are treated as 0, state values below 1e-20 are
//!   flushed to 0 (denormal guard), and outputs are always finite.

pub mod biquad;
pub mod compressor;
pub mod delay;
pub mod eq;
pub mod limiter;
pub mod reverb;

pub use biquad::Biquad;
pub use compressor::Compressor;
pub use delay::Delay;
pub use eq::Eq3;
pub use limiter::Limiter;
pub use reverb::Reverb;

/// Frames per coefficient-update sub-block (EQ, reverb and delay recompute
/// their filter coefficients at most once per sub-block).
pub const SUB_BLOCK: usize = 32;

/// Parameter smoothing time constant (seconds), the project-wide 5 ms.
pub const SMOOTH_SECONDS: f32 = 0.005;

/// Denormal guard threshold for DSP state.
pub(crate) const FLUSH: f32 = 1e-20;

/// A usable sample rate: `sr` if finite and positive, else 48 kHz.
#[inline]
pub(crate) fn valid_sr(sr: f32) -> f32 {
    if sr.is_finite() && sr > 0.0 {
        sr
    } else {
        48000.0
    }
}

/// `x` if finite, else 0 (input sanitising and the output NaN backstop).
#[inline]
pub(crate) fn finite(x: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

/// `x` with values below [`FLUSH`] (and non-finite values) replaced by 0.
#[inline]
pub(crate) fn flush(x: f32) -> f32 {
    if x.abs() < FLUSH || !x.is_finite() {
        0.0
    } else {
        x
    }
}

/// f64 variant of [`flush`] (biquad state).
#[inline]
pub(crate) fn flush64(x: f64) -> f64 {
    if x.abs() < FLUSH as f64 || !x.is_finite() {
        0.0
    } else {
        x
    }
}

/// `clamp` that maps NaN to `lo` instead of propagating it.
#[inline]
pub(crate) fn clampf(x: f32, lo: f32, hi: f32) -> f32 {
    if x.is_nan() {
        lo
    } else {
        x.max(lo).min(hi)
    }
}

/// dB → linear amplitude.
#[inline]
pub fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db * 0.05)
}

/// Linear amplitude → dB (floored at -200 dB for 0).
#[inline]
pub fn lin_to_db(lin: f32) -> f32 {
    20.0 * lin.max(1e-10).log10()
}

/// One-pole coefficient for a time constant of `seconds` at a rate of
/// `rate` updates per second: `exp(-1 / (seconds · rate))`.
#[inline]
pub(crate) fn pole(seconds: f32, rate: f32) -> f32 {
    (-1.0 / (seconds.max(1e-6) * rate)).exp()
}

/// One-pole smoother stepped once per update (per sample or per sub-block,
/// depending on the `rate` it was built with). Snaps to the target within
/// `eps`, so a settled value equals its target exactly (the EQ relies on this
/// to detect flat bands).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Glide {
    pub value: f32,
    coef: f32,
    eps: f32,
}

impl Glide {
    /// A glide with time constant `seconds` at `rate` updates per second.
    pub fn new(initial: f32, seconds: f32, rate: f32, eps: f32) -> Glide {
        Glide { value: initial, coef: 1.0 - pole(seconds, rate), eps }
    }

    /// Step toward `target`; returns whether the value changed.
    #[inline]
    pub fn step(&mut self, target: f32) -> bool {
        let d = target - self.value;
        if d == 0.0 {
            return false;
        }
        if d.abs() <= self.eps || !d.is_finite() {
            if target.is_finite() {
                self.value = target;
            }
        } else {
            self.value += d * self.coef;
        }
        true
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::f64::consts::PI;

    /// Deterministic white noise in -1..1 (xorshift32).
    pub struct Noise(u32);
    impl Noise {
        pub fn new(seed: u32) -> Noise {
            Noise(seed.max(1))
        }
        pub fn next(&mut self) -> f32 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            self.0 = x;
            (x as f32 / u32::MAX as f32) * 2.0 - 1.0
        }
    }

    /// Steady-state gain (dB) of a stereo in-place processor at `hz`: feeds a
    /// sine for 0.5 s (settling), then measures the fundamental's amplitude
    /// over the next 0.5 s by correlation with sin/cos. Checks the left
    /// channel (the right gets the same signal).
    pub fn tone_gain_db(sr: f32, hz: f64, mut process: impl FnMut(&mut [f32], &mut [f32])) -> f64 {
        let n = (sr as usize) / 2;
        let block = 128;
        let (mut s, mut c) = (0.0f64, 0.0f64);
        let mut i = 0usize;
        while i < 2 * n {
            let mut l = [0.0f32; 128];
            for (k, v) in l.iter_mut().enumerate() {
                *v = (0.5 * (2.0 * PI * hz * (i + k) as f64 / sr as f64).sin()) as f32;
            }
            let mut r = l;
            process(&mut l, &mut r);
            for (k, v) in l.iter().enumerate() {
                let t = i + k;
                if t >= n {
                    let ph = 2.0 * PI * hz * t as f64 / sr as f64;
                    s += *v as f64 * ph.sin();
                    c += *v as f64 * ph.cos();
                }
            }
            i += block;
        }
        let amp = 2.0 * (s * s + c * c).sqrt() / n as f64;
        20.0 * (amp / 0.5).log10()
    }
}
