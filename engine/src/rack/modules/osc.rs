//! Oscillator: PolyBLEP saw/square, PolyBLAMP triangle, sine; up to 4 unison
//! voices per channel and linear FM.
//!
//! * Frequency = `261.6256 × 2^(pitch + octave + (tune + fine/100)/12)`, where
//!   `pitch` is the (poly) input in V/oct (unconnected = 0 = C4).
//! * Linear FM: `f × (1 + fm × 5 × fm_in)`, floored at 0 (not through-zero).
//!   The final frequency is capped at 0.45 × sample rate, so extreme pitch/FM
//!   settings stay finite and well-behaved instead of aliasing wildly.
//! * `pw` input is added to the smoothed `pw` knob per sample, then clamped to
//!   `0.05..=0.95`. Knob moves are smoothed (5 ms), so they do not click.
//! * Saw and square are corrected with 2-point PolyBLEP at every edge. The
//!   triangle is corrected with 2-point PolyBLAMP at both corners (the integral
//!   of PolyBLEP), so it rolls off as 1/n² with no DC drift (it is evaluated
//!   directly from the phase; there is no integrator state).
//! * Unison: `n` copies spread evenly over ±detune/2 cents, each with its own
//!   phase starting from a fixed-seed xorshift (output is deterministic), summed
//!   and scaled by `1/√n`.
//! * Channels: the maximum over the connected inputs (minimum 1).

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::{poly, PortBuf};
use crate::{MAX_POLY, RACK_BLOCK};

const WAVE: usize = 0;
const OCTAVE: usize = 1;
const TUNE: usize = 2;
const FINE: usize = 3;
const PW: usize = 4;
const FM: usize = 5;
const UNISON: usize = 6;
const DETUNE: usize = 7;

const K: ModuleKind = ModuleKind::Osc;
/// Maximum unison voices (matches the `unison` param's catalog max).
pub const MAX_UNISON: usize = 4;
/// C4 in Hz (pitch 0.0).
const C4_HZ: f32 = 261.6256;
const PHASE_SEED: u32 = 0x2545_F491;

/// PolyBLEP residual for a unit step at distance `d` (phase, wrapped to
/// -0.5..0.5, positive = after the edge), `dt` = phase increment per sample.
/// Add `+b` for a rising edge, `-b` for a falling edge.
#[inline]
fn blep(d: f64, dt: f64) -> f64 {
    if d >= 0.0 && d < dt {
        let t = d / dt;
        2.0 * t - t * t - 1.0
    } else if d < 0.0 && d > -dt {
        let t = d / dt;
        t * t + 2.0 * t + 1.0
    } else {
        0.0
    }
}

/// PolyBLAMP residual (integral of `blep`, in samples) at a slope-change
/// corner; scale by half the slope change per sample.
#[inline]
fn blamp(d: f64, dt: f64) -> f64 {
    if d >= 0.0 && d < dt {
        let t = d / dt;
        1.0 / 3.0 + t * t - t * t * t / 3.0 - t
    } else if d < 0.0 && d > -dt {
        let t = d / dt + 1.0;
        t * t * t / 3.0
    } else {
        0.0
    }
}

/// Signed distance `p - corner` wrapped into -0.5..0.5.
#[inline]
fn dist(p: f64, corner: f64) -> f64 {
    let d = p - corner;
    if d > 0.5 {
        d - 1.0
    } else if d < -0.5 {
        d + 1.0
    } else {
        d
    }
}

/// One band-limited sample of `wave` at phase `p` (0..1) with increment `dt`.
#[inline]
fn voice(wave: u32, p: f64, dt: f64, pw: f64) -> f64 {
    match wave {
        0 => 2.0 * p - 1.0 - blep(dist(p, 0.0), dt),
        1 => {
            let naive = if p < pw { 1.0 } else { -1.0 };
            naive + blep(dist(p, 0.0), dt) - blep(dist(p, pw), dt)
        }
        2 => {
            // 4|p - 0.5| - 1: peak +1 at p = 0, trough -1 at p = 0.5; slope
            // change +8/cycle at the trough, -8/cycle at the peak.
            let naive = 4.0 * (p - 0.5).abs() - 1.0;
            naive + 4.0 * dt * (blamp(dist(p, 0.5), dt) - blamp(dist(p, 0.0), dt))
        }
        _ => (std::f64::consts::TAU * p).sin(),
    }
}

/// The oscillator module (see the module docs).
#[derive(Clone)]
pub struct Osc {
    sr: f32,
    /// Phase (0..1) per channel per unison voice.
    phase: [[f64; MAX_UNISON]; MAX_POLY],
    pw: Smooth,
    fm: Smooth,
    detune: Smooth,
}

impl Osc {
    /// A fresh oscillator with deterministic start phases.
    pub fn new(sr: f32) -> Osc {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        let mut o = Osc {
            sr,
            phase: [[0.0; MAX_UNISON]; MAX_POLY],
            pw: Smooth::new(sr, default(K, PW)),
            fm: Smooth::new(sr, default(K, FM)),
            detune: Smooth::new(sr, default(K, DETUNE)),
        };
        o.reset();
        o
    }

    /// Restore the fixed-seed start phases.
    pub fn reset(&mut self) {
        let mut x = PHASE_SEED;
        for row in self.phase.iter_mut() {
            for p in row.iter_mut() {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                *p = (x >> 8) as f64 / 16_777_216.0;
            }
        }
    }

    /// Render one sub-block into `outs[0]`.
    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let Some(out) = outs.first_mut() else { return };
        out.channels = 1;
        let none = PortBuf::new();
        let pitch_in = ins.first().unwrap_or(&none);
        let fm_in = ins.get(1).unwrap_or(&none);
        let pw_in = ins.get(2).unwrap_or(&none);
        let channels = poly(ins);
        out.channels = channels;

        let wave = param(params, K, WAVE) as u32;
        let base_pitch = param(params, K, OCTAVE).round()
            + (param(params, K, TUNE) + param(params, K, FINE) / 100.0) / 12.0;
        let (pw_t, fm_t, det_t) = (param(params, K, PW), param(params, K, FM), param(params, K, DETUNE));
        let n = (param(params, K, UNISON).round().max(1.0) as usize).min(MAX_UNISON);
        let norm = 1.0 / (n as f32).sqrt();
        let sr = self.sr;
        let max_hz = 0.45 * sr;

        for i in 0..RACK_BLOCK {
            let pw_knob = self.pw.next(pw_t);
            let fm_amt = self.fm.next(fm_t) * 5.0;
            let det = self.detune.next(det_t);
            // Per-voice frequency ratio (shared by all channels).
            let mut ratio = [1.0f64; MAX_UNISON];
            if n > 1 {
                for (v, r) in ratio.iter_mut().enumerate().take(n) {
                    let cents = (v as f32 / (n - 1) as f32 - 0.5) * det;
                    *r = (cents / 1200.0 * std::f32::consts::LN_2).exp() as f64;
                }
            }
            for ch in 0..channels {
                let pitch = pitch_in.get(ch, i) + base_pitch;
                let pitch = if pitch.is_finite() { pitch.clamp(-12.0, 8.0) } else { 0.0 };
                let fm_mul = (1.0 + fm_amt * fm_in.get(ch, i)).max(0.0);
                let mut f = C4_HZ * pitch.exp2() * fm_mul;
                f = if f.is_finite() { f.clamp(0.0, max_hz) } else { 0.0 };
                let pw = (pw_knob + pw_in.get(ch, i)).clamp(0.05, 0.95) as f64;
                let mut acc = 0.0f64;
                for (v, &r) in ratio.iter().enumerate().take(n) {
                    let dt = (f as f64 * r / sr as f64).min(0.49);
                    let p = self.phase[ch][v];
                    acc += voice(wave, p, dt, pw);
                    let mut np = p + dt;
                    if np >= 1.0 {
                        np -= 1.0;
                    }
                    self.phase[ch][v] = if np.is_finite() { np } else { 0.0 };
                }
                out.data[ch][i] = (acc as f32 * norm).clamp(-2.0, 2.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_PARAMS;

    const SR: f32 = 48000.0;

    fn params(wave: f32) -> [f32; MAX_PARAMS] {
        let mut p = [0.0f32; MAX_PARAMS];
        for (i, v) in p.iter_mut().enumerate().take(8) {
            *v = default(K, i);
        }
        p[WAVE] = wave;
        p
    }

    /// Render `blocks` sub-blocks of channel 0 with a constant pitch input
    /// (`None` = unconnected).
    fn render(p: &[f32], pitch: Option<f32>, blocks: usize) -> Vec<f32> {
        let mut o = Osc::new(SR);
        let mut ins = [PortBuf::new(), PortBuf::new(), PortBuf::new()];
        if let Some(v) = pitch {
            ins[0].channels = 1;
            ins[0].data[0] = [v; RACK_BLOCK];
        }
        let mut outs = [PortBuf::new()];
        let mut v = Vec::with_capacity(blocks * RACK_BLOCK);
        for _ in 0..blocks {
            o.process(p, &ins, &mut outs);
            v.extend_from_slice(&outs[0].data[0]);
        }
        v
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn osc_frequency_accuracy() {
        for wave in 0..4 {
            let x = render(&params(wave as f32), Some(0.75), 1500); // 1 s, A4
            let crossings = x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
            assert!((crossings as f32 - 440.0).abs() <= 1.0, "wave {wave}: {crossings} Hz");
        }
    }

    #[test]
    fn unconnected_pitch_is_c4_one_channel() {
        let mut o = Osc::new(SR);
        let ins = [PortBuf::new(), PortBuf::new(), PortBuf::new()];
        let mut outs = [PortBuf::new()];
        o.process(&params(3.0), &ins, &mut outs);
        assert_eq!(outs[0].channels, 1);
        let x = render(&params(3.0), None, 1500);
        let crossings = x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        assert!((crossings as f32 - 261.6).abs() <= 1.0, "{crossings}");
    }

    /// Hann-windowed DFT magnitude squared of `x` at `hz`.
    fn power_at(x: &[f32], hz: f64) -> f64 {
        let n = x.len();
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for (i, &s) in x.iter().enumerate() {
            let w = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos();
            let a = std::f64::consts::TAU * hz * i as f64 / SR as f64;
            re += s as f64 * w * a.cos();
            im -= s as f64 * w * a.sin();
        }
        re * re + im * im
    }

    /// Fraction of the signal's energy in the (one-sided) bins 100..4000 Hz.
    fn low_band_fraction(x: &[f32]) -> f64 {
        let n = x.len();
        let win: Vec<f32> =
            (0..n).map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos()) as f32).collect();
        let xw: Vec<f32> = x.iter().zip(&win).map(|(a, b)| a * b).collect();
        let total: f64 = xw.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() * n as f64; // Parseval: sum |X_k|^2
        // Table of cos/sin for index (k*i) mod n.
        let cs: Vec<(f64, f64)> = (0..n)
            .map(|m| {
                let a = std::f64::consts::TAU * m as f64 / n as f64;
                (a.cos(), a.sin())
            })
            .collect();
        let (k0, k1) = ((100.0 * n as f64 / SR as f64).ceil() as usize, (4000.0 * n as f64 / SR as f64) as usize);
        let mut band = 0.0f64;
        for k in k0..=k1 {
            let (mut re, mut im) = (0.0f64, 0.0f64);
            for (i, &s) in xw.iter().enumerate() {
                let (c, sn) = cs[(k * i) % n];
                re += s as f64 * c;
                im -= s as f64 * sn;
            }
            band += re * re + im * im;
        }
        2.0 * band / total
    }

    #[test]
    fn saw_is_band_limited() {
        // 4186 Hz saw (pitch 4), 1 s; analyse 8192 samples of it.
        let x = render(&params(0.0), Some(4.0), 1500);
        let seg = &x[10_000..10_000 + 8192];
        let frac = low_band_fraction(seg);
        assert!(frac < 0.01, "aliasing energy below the fundamental: {frac}");
        // A naive saw at the same pitch fails the same test (validates it).
        let (mut ph, inc) = (0.3f64, 4186.0 / 48000.0);
        let naive: Vec<f32> = (0..8192)
            .map(|_| {
                ph = (ph + inc).fract();
                (2.0 * ph - 1.0) as f32
            })
            .collect();
        let nfrac = low_band_fraction(&naive);
        assert!(nfrac > frac * 3.0 && nfrac > 0.005, "naive {nfrac} vs {frac}");
    }

    #[test]
    fn triangle_rolls_off_as_inverse_square_without_dc() {
        let x = render(&params(2.0), Some(0.75), 1500); // 440 Hz
        let x = &x[4800..];
        let mean = x.iter().map(|&s| s as f64).sum::<f64>() / x.len() as f64;
        assert!(mean.abs() < 1e-3, "dc {mean}");
        let (p1, p3) = (power_at(x, 440.0).sqrt(), power_at(x, 1320.0).sqrt());
        let ratio = p3 / p1;
        assert!((ratio - 1.0 / 9.0).abs() < 0.02, "3rd/1st = {ratio}");
        let peak = x.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((0.97..=1.001).contains(&peak), "peak {peak}");
    }

    #[test]
    fn pulse_width_sets_duty_and_input_adds() {
        let mut p = params(1.0);
        p[PW] = 0.25;
        let x = render(&p, Some(0.0), 600);
        let duty = x.iter().filter(|&&s| s > 0.0).count() as f64 / x.len() as f64;
        assert!((duty - 0.25).abs() < 0.01, "duty {duty}");
        // pw input +0.25 on top of the knob -> 0.5; huge input clamps at 0.95.
        let mut o = Osc::new(SR);
        let mut ins = [PortBuf::new(), PortBuf::new(), PortBuf::new()];
        ins[2].channels = 1;
        ins[2].data[0] = [0.25; RACK_BLOCK];
        let mut outs = [PortBuf::new()];
        let mut pos = 0usize;
        for b in 0..600 {
            if b == 300 {
                ins[2].data[0] = [9.0; RACK_BLOCK];
                pos = 0;
            }
            o.process(&p, &ins, &mut outs);
            if (100..300).contains(&b) || b >= 400 {
                pos += outs[0].data[0].iter().filter(|&&s| s > 0.0).count();
            }
            if b == 299 {
                let duty = pos as f64 / (200 * RACK_BLOCK) as f64;
                assert!((duty - 0.5).abs() < 0.01, "added duty {duty}");
                pos = 0;
            }
        }
        let duty = pos as f64 / (200 * RACK_BLOCK) as f64;
        assert!((duty - 0.95).abs() < 0.01, "clamped duty {duty}");
    }

    #[test]
    fn unison_detune_spreads_and_normalises() {
        for wave in 0..4 {
            let mut p = params(wave as f32);
            // 3 s: several beat periods of the detuned voices.
            let one = rms(&render(&p, Some(0.0), 2250));
            p[UNISON] = 4.0;
            let four = render(&p, Some(0.0), 2250);
            let r = rms(&four) / one;
            assert!((0.7..=1.3).contains(&r), "wave {wave}: rms ratio {r}");
            // Detuned voices beat: the 4-voice signal is not just 1 voice.
            let single = render(&params(wave as f32), Some(0.0), 2250);
            assert!(four.iter().zip(&single).any(|(a, b)| (a - b).abs() > 0.1));
        }
    }

    #[test]
    fn oscillator_extremes_finite() {
        for wave in 0..4 {
            let mut p = params(wave as f32);
            p[FM] = 1.0;
            p[UNISON] = 4.0;
            p[DETUNE] = 100.0;
            p[PW] = 0.95;
            let mut o = Osc::new(SR);
            let mut ins = [PortBuf::new(), PortBuf::new(), PortBuf::new()];
            ins[0].channels = 16;
            ins[1].channels = 16;
            for ch in 0..16 {
                ins[0].data[ch] = [if ch % 2 == 0 { 5.0 } else { -8.0 }; RACK_BLOCK];
                ins[1].data[ch] = [1.0; RACK_BLOCK];
            }
            let mut outs = [PortBuf::new()];
            for _ in 0..100 {
                o.process(&p, &ins, &mut outs);
                assert_eq!(outs[0].channels, 16);
                for ch in 0..16 {
                    for &x in &outs[0].data[ch] {
                        assert!(x.is_finite() && x.abs() <= 2.0, "wave {wave} ch {ch}: {x}");
                    }
                }
            }
            // Garbage inputs must not poison the output either.
            ins[0].data[0] = [f32::NAN; RACK_BLOCK];
            ins[1].data[0] = [f32::INFINITY; RACK_BLOCK];
            for _ in 0..4 {
                o.process(&p, &ins, &mut outs);
                assert!(outs[0].data.iter().flatten().all(|x| x.is_finite()));
            }
        }
    }

    #[test]
    fn octave_tune_fine_shift_pitch() {
        let mut p = params(3.0);
        p[OCTAVE] = 1.0;
        p[TUNE] = 12.0;
        p[FINE] = -100.0; // +1 oct +11 st: 261.6256 * 2^(23/12)
        let x = render(&p, None, 1500);
        let crossings = x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        let want = 261.6256 * 2f32.powf(23.0 / 12.0);
        assert!((crossings as f32 - want).abs() <= 1.0, "{crossings} vs {want}");
    }
}
