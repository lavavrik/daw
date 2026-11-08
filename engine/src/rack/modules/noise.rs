//! Noise: white noise from a fixed-seed xorshift (deterministic output), one
//! channel, scaled by the smoothed `level` knob; `color` Pink filters it to
//! −3 dB/oct.
//!
//! # Pink (plan 16)
//! Paul Kellet's refined pink filter: six one-poles in parallel plus a
//! direct path and a one-sample-delayed one (accurate to ±0.05 dB from
//! ~9 Hz to Nyquist at 44.1 kHz). Its coefficients are for 44.1 kHz, so at
//! another rate each pole `p` becomes `p^(44100/sr)` (same corner in Hz) and
//! its gain `g` is scaled by `(1 − p')/(1 − p)` (same low-frequency gain, and
//! so the same response in Hz between the corners); the near-Nyquist terms
//! (the negative pole, the delayed path) are kept as they are. The output is
//! normalised by the filter's impulse-response energy (closed form, computed
//! in `new`), so pink's RMS equals white's at every rate. Pink is not bounded
//! to ±level like white: its peaks reach ~4× its RMS (≈ ±2.3 at level 1).
//! All filter state lives in the struct (one per voice); nothing allocates.

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::PortBuf;
use crate::RACK_BLOCK;

const LEVEL: usize = 0;
const COLOR: usize = 1;
const K: ModuleKind = ModuleKind::Noise;
const SEED: u32 = 0x9E37_79B9;

/// Kellet's one-pole sections at 44.1 kHz: (pole, input gain).
const KELLET: [(f64, f64); 6] = [
    (0.99886, 0.0555179),
    (0.99332, 0.0750759),
    (0.96900, 0.1538520),
    (0.86650, 0.3104856),
    (0.55000, 0.5329522),
    (-0.7616, -0.0168980),
];
/// Kellet's direct and one-sample-delayed white paths.
const DIRECT: f64 = 0.5362;
const DELAYED: f64 = 0.115926;
/// Sections whose pole follows the rate (the positive ones).
const RATE_POLES: usize = 5;

/// White or pink noise source.
#[derive(Clone)]
pub struct Noise {
    state: u32,
    level: Smooth,
    /// Pink: the sections' poles and gains at this rate.
    pole: [f32; 6],
    gain: [f32; 6],
    /// Pink: section states and the delayed path's last input.
    b: [f32; 6],
    prev: f32,
    /// Pink: 1 / sqrt(impulse-response energy) (RMS matches white).
    norm: f32,
}

impl Noise {
    /// Automation: the next sub-block takes its `smooth` params at once.
    pub fn snap(&mut self) {
        self.level.snap();
    }

    /// A noise generator at the catalog default level and color.
    pub fn new(sr: f32) -> Noise {
        let sr = if sr.is_finite() && sr > 0.0 { sr as f64 } else { 48000.0 };
        let (mut pole, mut gain) = ([0.0f64; 6], [0.0f64; 6]);
        for (i, &(p, g)) in KELLET.iter().enumerate() {
            if i < RATE_POLES {
                pole[i] = p.powf(44100.0 / sr);
                gain[i] = g * (1.0 - pole[i]) / (1.0 - p);
            } else {
                (pole[i], gain[i]) = (p, g);
            }
        }
        // Impulse response h[n] = Σ g·pⁿ + DIRECT·δ[n] + DELAYED·δ[n−1]; its
        // energy Σ h[n]² in closed form.
        let mut energy = DIRECT * DIRECT + DELAYED * DELAYED;
        for i in 0..6 {
            energy += 2.0 * gain[i] * (DIRECT + DELAYED * pole[i]);
            for j in 0..6 {
                energy += gain[i] * gain[j] / (1.0 - pole[i] * pole[j]);
            }
        }
        Noise {
            state: SEED,
            level: Smooth::new(sr as f32, default(K, LEVEL)),
            pole: pole.map(|p| p as f32),
            gain: gain.map(|g| g as f32),
            b: [0.0; 6],
            prev: 0.0,
            norm: (1.0 / energy.sqrt()) as f32,
        }
    }

    /// Restart the (deterministic) sequence and clear the pink filter.
    pub fn reset(&mut self) {
        self.state = SEED;
        self.b = [0.0; 6];
        self.prev = 0.0;
    }

    /// Render one sub-block into `outs[0]` (1 channel).
    pub fn process(&mut self, params: &[f32], outs: &mut [PortBuf]) {
        let Some(out) = outs.first_mut() else { return };
        out.channels = 1;
        let target = param(params, K, LEVEL);
        let pink = param(params, K, COLOR) >= 0.5;
        for i in 0..RACK_BLOCK {
            // xorshift32
            let mut x = self.state;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            self.state = x;
            // Top 24 bits -> [-1, 1).
            let white = (x >> 8) as f32 * (2.0 / 16_777_216.0) - 1.0;
            let y = if pink { self.pink(white) } else { white };
            out.data[0][i] = y * self.level.next(target);
        }
    }

    /// One sample of Kellet's filter on `white`, normalised.
    #[inline]
    fn pink(&mut self, white: f32) -> f32 {
        let mut sum = white * DIRECT as f32 + self.prev;
        for k in 0..6 {
            // Flushed: the denormal guard every engine filter state gets.
            self.b[k] = crate::dsp::flush(self.pole[k] * self.b[k] + white * self.gain[k]);
            sum += self.b[k];
        }
        self.prev = white * DELAYED as f32;
        sum * self.norm
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

    /// `secs` of noise at `sr`, level 1, `color` 0 (White) or 1 (Pink).
    fn render(sr: f32, color: f32, secs: f32) -> Vec<f32> {
        let mut n = Noise::new(sr);
        let mut params = [0.0f32; MAX_PARAMS];
        params[LEVEL] = 1.0;
        params[COLOR] = color;
        let mut outs = [PortBuf::new()];
        let mut x = Vec::new();
        for _ in 0..(secs * sr) as usize / RACK_BLOCK {
            n.process(&params, &mut outs);
            x.extend_from_slice(&outs[0].data[0]);
        }
        x
    }

    /// In-place radix-2 FFT (test only).
    fn fft(re: &mut [f64], im: &mut [f64]) {
        let n = re.len();
        let mut j = 0;
        for i in 1..n {
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j |= bit;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let ang = -2.0 * std::f64::consts::PI / len as f64;
            for s in (0..n).step_by(len) {
                for k in 0..len / 2 {
                    let (wr, wi) = ((ang * k as f64).cos(), (ang * k as f64).sin());
                    let (a, b) = (s + k, s + k + len / 2);
                    let (tr, ti) = (re[b] * wr - im[b] * wi, re[b] * wi + im[b] * wr);
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            len <<= 1;
        }
    }

    /// Welch power (Hann frames of 8192, hop 2048) summed over `lo..hi` Hz.
    fn band_power(x: &[f32], sr: f32, lo: f32, hi: f32) -> f64 {
        const N: usize = 8192;
        let w: Vec<f64> = (0..N).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / N as f64).cos()).collect();
        let (mut acc, mut s) = (0.0f64, 0);
        while s + N <= x.len() {
            let mut re: Vec<f64> = (0..N).map(|i| x[s + i] as f64 * w[i]).collect();
            let mut im = vec![0.0f64; N];
            fft(&mut re, &mut im);
            for i in 0..N / 2 {
                let f = i as f32 * sr / N as f32;
                if (lo..hi).contains(&f) {
                    acc += re[i] * re[i] + im[i] * im[i];
                }
            }
            s += N / 4;
        }
        acc
    }

    /// Power 100 Hz–1 kHz over 1–10 kHz (dB): one decade each, so pink
    /// (equal power per octave) reads 0 dB and white −10 dB.
    fn decade_ratio_db(x: &[f32], sr: f32) -> f64 {
        10.0 * (band_power(x, sr, 100.0, 1000.0) / band_power(x, sr, 1000.0, 10000.0)).log10()
    }

    fn rms_db(x: &[f32]) -> f64 {
        10.0 * (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).log10()
    }

    #[test]
    fn pink_slope() {
        // Pink: −3 dB/oct, so the two decades carry equal power (±1 dB); the
        // same at 44.1 and 96 kHz (the filter's poles follow the rate). White
        // reads −10 dB, so the check can tell them apart.
        for sr in [44100.0, 96000.0] {
            let (white, pink) = (render(sr, 0.0, 3.0), render(sr, 1.0, 3.0));
            let (w, p) = (decade_ratio_db(&white, sr), decade_ratio_db(&pink, sr));
            eprintln!("{sr} Hz: 100 Hz–1 kHz over 1–10 kHz: white {w:.2} dB, pink {p:.2} dB");
            assert!((w + 10.0).abs() <= 1.0, "{sr} Hz: white reads {w:.2} dB, not −10");
            assert!(p.abs() <= 1.0, "{sr} Hz: pink decade ratio {p:.2} dB, want 0 ± 1");
            // An octave check too (500 Hz–1 kHz vs 4–8 kHz: 9 dB apart at −3 dB/oct).
            let oct = 10.0 * (band_power(&pink, sr, 500.0, 1000.0) / band_power(&pink, sr, 4000.0, 8000.0)).log10();
            assert!((oct - 0.0).abs() <= 1.0, "{sr} Hz: one octave vs another {oct:.2} dB apart, want 0 ± 1");
        }
    }

    #[test]
    fn pink_rms_matches_white() {
        for sr in [44100.0, 48000.0, 96000.0] {
            let (w, p) = (rms_db(&render(sr, 0.0, 3.0)), rms_db(&render(sr, 1.0, 3.0)));
            eprintln!("{sr} Hz: RMS white {w:.2} dB, pink {p:.2} dB");
            assert!((p - w).abs() <= 1.0, "{sr} Hz: pink RMS {p:.2} dB vs white {w:.2} dB");
            assert!(render(sr, 1.0, 0.5).iter().all(|x| x.is_finite()));
        }
    }

    #[test]
    fn white_is_unchanged_by_the_color_param() {
        // Color 0 is the old module, sample for sample (saved patches sound the same).
        let mut a = Noise::new(48000.0);
        let mut params = [0.0f32; MAX_PARAMS];
        params[LEVEL] = 1.0;
        let mut out = [PortBuf::new()];
        a.process(&params, &mut out);
        let mut state = SEED;
        for &y in &out[0].data[0] {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            assert_eq!(y, (state >> 8) as f32 * (2.0 / 16_777_216.0) - 1.0);
        }
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
