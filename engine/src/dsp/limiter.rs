//! Limiter: a stereo-linked lookahead peak limiter (the master bus guarantee).
//!
//! The signal is delayed by `D = round(1.5 ms · sr)` samples (the
//! [`latency`](Limiter::latency)). Per input sample `n`:
//!
//! 1. **Required gain** `g[n] = min(1, ceiling / max(|l|, |r|))`.
//! 2. **Hold** (the max-filter on the peak, as a min-filter on the gain):
//!    `m[n] = min(g[n−D ..= n])`, a sliding-window minimum over `D+1`
//!    samples (monotonic deque in fixed rings, O(1) amortised).
//! 3. **Release:** `e[n] = m[n]` when `m[n] < e[n−1]` (instant: the next stage
//!    shapes the attack), else `e` rises toward `m` exponentially with the
//!    release time constant (10..500 ms). Always `e[n] ≤ m[n]`.
//! 4. **Attack smoothing:** `s[n]` = mean of `e[n−D ..= n]` (a box filter
//!    over the same `D+1` samples), so the gain ramps down linearly across
//!    the lookahead instead of stepping.
//! 5. **Output** `y[n] = x[n−D] · s[n]`, clamped to ±ceiling.
//!
//! Why it never exceeds the ceiling: `g[n−D]` is inside every hold window
//! `m[n−D ..= n]`, so all `D+1` values the box averages are `≤ g[n−D]`, hence
//! `s[n] ≤ g[n−D]` and `|x[n−D]|·s[n] ≤ ceiling`. The final clamp only absorbs
//! float rounding (and a ceiling that is still gliding down); tests check it
//! almost never engages. The box sum runs in f64 (no drift).
//!
//! The ceiling (linear, 0.001..1) glides per sample (5 ms).

use super::{clampf, finite, pole, valid_sr, Glide, SMOOTH_SECONDS};

/// Lookahead (seconds).
pub const LOOKAHEAD_SECONDS: f32 = 0.0015;

/// Stereo lookahead limiter (see the module docs).
#[derive(Clone, Debug)]
pub struct Limiter {
    sr: f32,
    ceiling: f32,
    ceil_s: Glide,
    rel: f32,
    /// Lookahead `D` (samples); windows are `D + 1` long.
    d: usize,
    /// Signal delay ring (stereo: L at `[0..dcap]`, R at `[dcap..2dcap]`).
    dl: Vec<f32>,
    dcap: usize,
    /// Monotonic deque of (sample index, gain) for the sliding minimum.
    dq_idx: Vec<u64>,
    dq_val: Vec<f32>,
    dq_head: usize,
    dq_len: usize,
    /// Box filter ring and its running sum.
    boxr: Vec<f32>,
    box_pos: usize,
    box_sum: f64,
    env: f32,
    gain: f32,
    n: u64,
    fresh: bool,
    /// Samples the final clamp changed by more than float rounding (test
    /// diagnostics: the design should make this 0).
    #[cfg(test)]
    clamp_hits: usize,
}

impl Limiter {
    /// A limiter with ceiling 1.0 (0 dBFS) and release 50 ms.
    pub fn new(sr: f32) -> Limiter {
        let sr = valid_sr(sr);
        let d = (LOOKAHEAD_SECONDS * sr).round().max(1.0) as usize;
        let w = d + 1;
        let dcap = w.next_power_of_two();
        let mut lim = Limiter {
            sr,
            ceiling: 1.0,
            ceil_s: Glide::new(1.0, SMOOTH_SECONDS, sr, 1e-7),
            rel: 0.0,
            d,
            dl: vec![0.0; 2 * dcap],
            dcap,
            dq_idx: vec![0; w + 1],
            dq_val: vec![1.0; w + 1],
            dq_head: 0,
            dq_len: 0,
            boxr: vec![1.0; w],
            box_pos: 0,
            box_sum: w as f64,
            env: 1.0,
            gain: 1.0,
            n: 0,
            fresh: true,
            #[cfg(test)]
            clamp_hits: 0,
        };
        lim.set_release_ms(50.0);
        lim
    }

    /// Ceiling as a linear amplitude, 0.001..1.
    pub fn set_ceiling(&mut self, lin: f32) {
        if lin.is_finite() {
            self.ceiling = clampf(lin, 0.001, 1.0);
        }
    }

    /// Release time constant, 10..500 ms.
    pub fn set_release_ms(&mut self, ms: f32) {
        if ms.is_finite() {
            self.rel = pole(clampf(ms, 10.0, 500.0) * 1e-3, self.sr);
        }
    }

    /// Latency (the lookahead) in samples.
    pub fn latency(&self) -> usize {
        self.d
    }

    /// Current gain reduction in dB (≥ 0).
    pub fn gain_reduction_db(&self) -> f32 {
        if self.gain >= 1.0 {
            0.0
        } else {
            -20.0 * self.gain.max(1e-10).log10()
        }
    }

    /// Clear the state (delay line, windows, envelope) without allocating.
    pub fn reset(&mut self) {
        self.dl.fill(0.0);
        self.boxr.fill(1.0);
        self.box_sum = self.boxr.len() as f64;
        self.dq_len = 0;
        self.env = 1.0;
        self.gain = 1.0;
        self.fresh = true;
    }

    /// Limit a stereo block in place (output delayed by
    /// [`latency`](Limiter::latency) samples).
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if self.fresh {
            self.fresh = false;
            self.ceil_s.value = self.ceiling;
        }
        let n = l.len().min(r.len());
        let w = self.d + 1;
        let (dmask, qcap) = (self.dcap - 1, self.dq_idx.len());
        for i in 0..n {
            let (xl, xr) = (finite(l[i]), finite(r[i]));
            self.ceil_s.step(self.ceiling);
            let c = self.ceil_s.value;

            // 1. Required gain.
            let peak = xl.abs().max(xr.abs());
            let g = if peak > c { c / peak } else { 1.0 };

            // 2. Sliding minimum over the last D+1 gains (monotonic deque:
            //    values increase from front to back).
            let now = self.n;
            while self.dq_len > 0 {
                let back = (self.dq_head + self.dq_len - 1) % qcap;
                if self.dq_val[back] >= g {
                    self.dq_len -= 1;
                } else {
                    break;
                }
            }
            let slot = (self.dq_head + self.dq_len) % qcap;
            self.dq_idx[slot] = now;
            self.dq_val[slot] = g;
            self.dq_len += 1;
            while self.dq_idx[self.dq_head] + (w as u64) <= now {
                self.dq_head = (self.dq_head + 1) % qcap;
                self.dq_len -= 1;
            }
            let m = self.dq_val[self.dq_head];
            self.n += 1;

            // 3. Release: instant down, exponential up (never above m).
            self.env = if m < self.env { m } else { m + (self.env - m) * self.rel };

            // 4. Box filter over the last D+1 envelope values.
            self.box_sum += self.env as f64 - self.boxr[self.box_pos] as f64;
            self.boxr[self.box_pos] = self.env;
            self.box_pos = if self.box_pos + 1 == w { 0 } else { self.box_pos + 1 };
            let s = ((self.box_sum / w as f64) as f32).clamp(0.0, 1.0);
            self.gain = s;

            // 5. Delay the signal by D, apply the gain, clamp (guarantee).
            let pos = (self.n as usize) & dmask;
            self.dl[pos] = xl;
            self.dl[self.dcap + pos] = xr;
            let back = pos.wrapping_sub(self.d) & dmask;
            let (yl, yr) = (self.dl[back] * s, self.dl[self.dcap + back] * s);
            #[cfg(test)]
            {
                if yl.abs() > c * (1.0 + 1e-6) || yr.abs() > c * (1.0 + 1e-6) {
                    self.clamp_hits += 1;
                }
            }
            l[i] = yl.clamp(-c, c);
            r[i] = yr.clamp(-c, c);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_util::Noise;
    use super::*;

    fn run(lim: &mut Limiter, input: &[(f32, f32)]) -> Vec<(f32, f32)> {
        let mut out = Vec::with_capacity(input.len());
        for chunk in input.chunks(128) {
            let mut l: Vec<f32> = chunk.iter().map(|p| p.0).collect();
            let mut r: Vec<f32> = chunk.iter().map(|p| p.1).collect();
            lim.process(&mut l, &mut r);
            out.extend(l.into_iter().zip(r));
        }
        out
    }

    #[test]
    fn limiter_never_exceeds_ceiling() {
        let ceiling = 10f32.powf(-0.3 / 20.0);
        let mut lim = Limiter::new(48000.0);
        lim.set_ceiling(ceiling);
        let mut noise = Noise::new(5);
        let mut input = Vec::new();
        // 2 s of noise at +12 dB.
        for _ in 0..96000 {
            input.push((4.0 * noise.next(), 4.0 * noise.next()));
        }
        // Sine bursts of rising level separated by silence (attack + release).
        for burst in 0..10 {
            let amp = 0.5 + burst as f32 * 0.6;
            for i in 0..4800 {
                let s = amp * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 48000.0).sin();
                input.push((s, -s * 0.7));
            }
            input.extend(std::iter::repeat_n((0.0, 0.0), 2400));
        }
        // Single-sample spikes.
        for i in 0..4800 {
            input.push(if i % 997 == 0 { (8.0, -8.0) } else { (0.01, 0.01) });
        }
        let out = run(&mut lim, &input);
        let peak = out.iter().fold(0.0f32, |p, (a, b)| p.max(a.abs()).max(b.abs()));
        assert!(peak <= ceiling, "peak {peak} > ceiling {ceiling}");
        assert!(peak > ceiling * 0.95, "it is a limiter, not a mute: {peak}");
        assert_eq!(lim.clamp_hits, 0, "the gain envelope alone must hold the ceiling");
    }

    #[test]
    fn limiter_transparent_below_ceiling() {
        let mut lim = Limiter::new(48000.0);
        lim.set_ceiling(10f32.powf(-0.3 / 20.0));
        let amp = 10f32.powf(-12.0 / 20.0);
        let input: Vec<(f32, f32)> = (0..48000)
            .map(|i| {
                let s = amp * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 48000.0).sin();
                (s, -s)
            })
            .collect();
        let out = run(&mut lim, &input);
        let d = lim.latency();
        assert_eq!(d, 72);
        for i in d..input.len() {
            let (x, y) = (input[i - d], out[i]);
            for (a, b) in [(x.0, y.0), (x.1, y.1)] {
                if a.abs() > 1e-3 {
                    let db = 20.0 * (b / a).abs().log10();
                    assert!(db.abs() <= 0.05, "sample {i}: {db} dB");
                }
            }
        }
        assert_eq!(lim.gain_reduction_db(), 0.0);
    }

    #[test]
    fn limiter_reports_gr_and_releases() {
        let mut lim = Limiter::new(48000.0);
        lim.set_ceiling(0.5);
        lim.set_release_ms(50.0);
        let loud = vec![(1.0f32, 1.0f32); 4800];
        run(&mut lim, &loud);
        assert!((lim.gain_reduction_db() - 6.02).abs() < 0.1, "{}", lim.gain_reduction_db());
        // 0.5 s of quiet (10 release time constants): back to ~0 dB.
        let quiet = vec![(0.1f32, 0.1f32); 24000];
        let out = run(&mut lim, &quiet);
        assert!(lim.gain_reduction_db() < 0.01, "{}", lim.gain_reduction_db());
        // The release is gradual: no step bigger than the envelope allows.
        let max_step = out[lim.latency() + 1..].windows(2).fold(0.0f32, |m, w| m.max((w[1].0 - w[0].0).abs()));
        assert!(max_step < 0.01, "{max_step}");
    }

    #[test]
    fn limiter_attack_is_smooth() {
        // A step from quiet to loud: the gain ramps linearly across the
        // lookahead (box filter), at most (1 − 0.5)/(D+1) per sample, and has
        // reached 0.5 when the loud part comes out.
        let mut lim = Limiter::new(48000.0);
        lim.set_ceiling(0.5);
        let mut input = vec![(0.2f32, 0.2f32); 1000];
        input.extend(vec![(1.0f32, 1.0f32); 1000]);
        let out = run(&mut lim, &input);
        let d = lim.latency();
        let gain: Vec<f32> = (d..out.len()).map(|i| out[i].0 / input[i - d].0).collect();
        let max_step = gain.windows(2).fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
        assert!(max_step <= 0.5 / (d + 1) as f32 + 1e-5, "gain step {max_step}");
        assert!((gain[1000..].iter().fold(0.0f32, |m, g| m.max(*g)) - 0.5).abs() < 1e-5);
    }

    #[test]
    fn limiter_handles_garbage_and_rates() {
        for sr in [44100.0, 96000.0, f32::NAN] {
            let mut lim = Limiter::new(sr);
            lim.set_ceiling(f32::NAN);
            lim.set_release_ms(1e9);
            let input: Vec<(f32, f32)> = (0..1000).map(|i| if i % 2 == 0 { (f32::NAN, f32::INFINITY) } else { (1e30, -1e30) }).collect();
            let out = run(&mut lim, &input);
            assert!(out.iter().all(|(a, b)| a.is_finite() && b.is_finite() && a.abs() <= 1.0 && b.abs() <= 1.0));
            assert!(lim.gain_reduction_db().is_finite());
        }
    }
}
