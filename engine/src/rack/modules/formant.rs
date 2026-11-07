//! Formant: three resonant band-pass peaks with pitch tracking and a CV
//! shift (module id 17, *Shaping*). The body of the Sax; also used for brass
//! and organ "wah".
//!
//! * **Signal flow.** `in` feeds three band-passes in parallel;
//!   `wet = bp1 + g2·bp2 + g3·bp3` and `out = dry + mix·(wet − dry)`, then
//!   the Filter's output soft limiter (linear to ±2, easing into ±3.5).
//! * **Centres.** Peak `i` sits at
//!   `f_i × 2^(shift + track·pitch + cv_amt·cv)`, clamped to
//!   20 Hz..0.45·sr. `pitch` (V/oct) and `cv` read 0 when unconnected. `track`
//!   1 makes the peaks follow the note (a filter), 0 keeps them fixed (a
//!   body); in between, the body brightens a little with pitch, as a real
//!   instrument's does.
//! * **Peaks.** Each is the Filter's TPT state-variable filter
//!   (`filter::svf_step`, `filter::svf_coefs`, `tan_fast`; shared, not
//!   copied), band-pass output `k·v1` with damping `k = 1/q`, so every peak has
//!   **unity gain at its centre** and the sum peaks near 0 dB (`g2`, `g3`
//!   scale the upper two). No input saturation (unlike the Filter's SVF).
//!   Coinciding peaks (overlapping `f` ranges, or centres pushed into the
//!   20 Hz / 0.45·sr clamp) add up to `1 + g2 + g3` (≈ +7 dB at the default
//!   gains); the limiter catches that, it is not normalised.
//! * **Smoothing.** Every param is smoothed (5 ms one-pole); `f1..f3` and `q`
//!   in the log2 domain (like the Filter's cutoff) so sweeps move evenly.
//!   The `pitch` and `cv` inputs are not smoothed (as the Filter's `cv`):
//!   the TPT core keeps its states continuous when the centre moves, so even
//!   a 1-octave cv step does not click (`formant_cv_sweep_is_smooth`).
//!   Coefficients are computed per sample; they are shared by all channels
//!   when `pitch` and `cv` are mono or unconnected, else per channel.
//! * **Channels** are the maximum over the connected inputs (a mono `in`
//!   with a poly `pitch` gives one formant per voice, the mono input
//!   broadcast). Dropped channels restart from silence.
//! * **Safety.** Non-finite inputs read as 0; states below 1e-20 are flushed
//!   after each sub-block and a channel whose state went non-finite is reset.
//! * **No vowel table:** three explicit peaks plus a CV shift cover sax,
//!   brass and organ "wah"; a vowel morph table is a possible follow-up.

// `x.max(a).min(b)` is used on purpose instead of `clamp`: it maps NaN to a
// bound rather than propagating it.
#![allow(clippy::manual_clamp)]

use super::filter::{finite_or_zero, flush, limit, svf_coefs, svf_step, tan_fast, MAX_SR_FRACTION, MIN_HZ};
use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::{poly, PortBuf};
use crate::{MAX_POLY, RACK_BLOCK};

const F1: usize = 0;
const Q: usize = 3;
const G2: usize = 4;
const G3: usize = 5;
const SHIFT: usize = 6;
const TRACK: usize = 7;
const CV_AMT: usize = 8;
const MIX: usize = 9;
/// Number of peaks (`f1..f3` are params `F1..F1 + PEAKS`).
const PEAKS: usize = 3;
const K: ModuleKind = ModuleKind::Formant;

/// Coefficients of the three peaks for one sample (and one channel).
type Coefs = [[f32; 3]; PEAKS];

/// The Formant module (see the module docs).
#[derive(Clone)]
pub struct Formant {
    /// π / sr (the prewarp scale).
    pi_t: f32,
    max_hz: f32,
    /// log2 of `f1..f3` (Hz).
    freq: [Smooth; PEAKS],
    /// log2 of `q`.
    q: Smooth,
    g2: Smooth,
    g3: Smooth,
    shift: Smooth,
    track: Smooth,
    cv_amt: Smooth,
    mix: Smooth,
    /// SVF states (ic1eq, ic2eq) per peak, per channel.
    state: [[[f32; 2]; PEAKS]; MAX_POLY],
    /// Channel count of the previous sub-block.
    channels: usize,
    /// Test-only probes: the largest |pre-limiter output| and |state| seen,
    /// and how many times a non-finite state was reset.
    #[cfg(test)]
    probe: Probe,
}

#[cfg(test)]
#[derive(Clone, Copy, Default)]
struct Probe {
    pre_limit: f32,
    state: f32,
    resets: u32,
}

impl Formant {
    pub fn new(sr: f32) -> Formant {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        let log_default = |i: usize| default(K, i).max(MIN_HZ).log2();
        let lin = |i: usize| Smooth::new(sr, default(K, i));
        Formant {
            pi_t: std::f32::consts::PI / sr,
            max_hz: MAX_SR_FRACTION * sr,
            freq: [Smooth::new(sr, log_default(F1)), Smooth::new(sr, log_default(F1 + 1)), Smooth::new(sr, log_default(F1 + 2))],
            q: Smooth::new(sr, default(K, Q).max(1.0).log2()),
            g2: lin(G2),
            g3: lin(G3),
            shift: lin(SHIFT),
            track: lin(TRACK),
            cv_amt: lin(CV_AMT),
            mix: lin(MIX),
            state: [[[0.0; 2]; PEAKS]; MAX_POLY],
            channels: 0,
            #[cfg(test)]
            probe: Probe::default(),
        }
    }

    /// Clear the filter states (params are kept).
    pub fn reset(&mut self) {
        self.state = [[[0.0; 2]; PEAKS]; MAX_POLY];
    }

    /// Automation: the next sub-block takes every param at its target at once.
    pub fn snap(&mut self) {
        for f in self.freq.iter_mut() {
            f.snap();
        }
        for s in [&mut self.q, &mut self.g2, &mut self.g3, &mut self.shift, &mut self.track, &mut self.cv_amt, &mut self.mix] {
            s.snap();
        }
    }

    /// Coefficients for centres `hz` moved by `oct` octaves, damping `k`.
    #[inline]
    fn coefs(&self, hz: &[f32; PEAKS], oct: f32, k: f32) -> Coefs {
        let m = oct.exp2();
        let mut c = [[0.0; 3]; PEAKS];
        for (ci, &f) in c.iter_mut().zip(hz) {
            // max/min: NaN or inf land on a bound.
            let fc = (f * m).max(MIN_HZ).min(self.max_hz);
            *ci = svf_coefs(tan_fast(self.pi_t * fc), k);
        }
        c
    }

    /// Render one sub-block into `outs[0]`.
    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let Some(out) = outs.first_mut() else { return };
        let none = PortBuf::new();
        let inp = ins.first().unwrap_or(&none);
        let pitch = ins.get(1).unwrap_or(&none);
        let cv = ins.get(2).unwrap_or(&none);
        let channels = poly(&ins[..ins.len().min(3)]);
        out.channels = channels;
        for ch in channels..self.channels.min(MAX_POLY) {
            self.state[ch] = [[0.0; 2]; PEAKS];
        }
        self.channels = channels;

        let mut f_t = [0.0f32; PEAKS];
        for (i, t) in f_t.iter_mut().enumerate() {
            *t = param(params, K, F1 + i).max(MIN_HZ).log2();
        }
        let q_t = param(params, K, Q).max(1.0).log2();
        let (g2_t, g3_t) = (param(params, K, G2), param(params, K, G3));
        let (shift_t, track_t, amt_t, mix_t) =
            (param(params, K, SHIFT), param(params, K, TRACK), param(params, K, CV_AMT), param(params, K, MIX));
        // A poly pitch or cv needs per-channel coefficients.
        let per_channel = pitch.channels > 1 || cv.channels > 1;

        for i in 0..RACK_BLOCK {
            let mut hz = [0.0f32; PEAKS];
            for ((h, f), &t) in hz.iter_mut().zip(self.freq.iter_mut()).zip(&f_t) {
                *h = f.next(t).exp2();
            }
            let k = 1.0 / self.q.next(q_t).exp2().max(1.0);
            let g2 = self.g2.next(g2_t);
            let g3 = self.g3.next(g3_t);
            let shift = self.shift.next(shift_t);
            let track = self.track.next(track_t);
            let amt = self.cv_amt.next(amt_t);
            let mix = self.mix.next(mix_t);
            let oct = |ch: usize| shift + track * finite_or_zero(pitch.get(ch, i)) + amt * finite_or_zero(cv.get(ch, i));
            let shared = if per_channel { [[0.0; 3]; PEAKS] } else { self.coefs(&hz, oct(0), k) };

            for ch in 0..channels {
                let c = if per_channel { self.coefs(&hz, oct(ch), k) } else { shared };
                let x = finite_or_zero(inp.get(ch, i));
                let s = &mut self.state[ch];
                let bp1 = k * svf_step(&mut s[0], x, c[0]).0;
                let bp2 = k * svf_step(&mut s[1], x, c[1]).0;
                let bp3 = k * svf_step(&mut s[2], x, c[2]).0;
                let wet = bp1 + g2 * bp2 + g3 * bp3;
                let y = x + mix * (wet - x);
                #[cfg(test)]
                {
                    self.probe.pre_limit = self.probe.pre_limit.max(y.abs());
                }
                out.data[ch][i] = limit(y);
            }
        }

        // Denormal guard and defensive reset, once per sub-block.
        for st in self.state[..channels].iter_mut() {
            for s in st.iter_mut() {
                #[cfg(test)]
                {
                    if s.iter().any(|x| !x.is_finite()) {
                        self.probe.resets += 1;
                    }
                    self.probe.state = s.iter().fold(self.probe.state, |m, x| m.max(x.abs()));
                }
                flush(s);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::test_util::{tone_gain_db, Noise};
    use crate::rack::port::PortBuf;
    use crate::{MAX_PARAMS, RACK_BLOCK};

    const SR: f32 = 48000.0;
    /// The peaks and bounds are checked at the common rates.
    const SRS: [f32; 3] = [44100.0, 48000.0, 96000.0];

    fn defaults() -> [f32; MAX_PARAMS] {
        let mut p = [0.0f32; MAX_PARAMS];
        for (v, s) in p.iter_mut().zip(crate::rack::catalog::spec(K).params) {
            *v = s.default;
        }
        p
    }

    /// Steady-state gain (dB) at `hz` through a fresh Formant with params
    /// `p` and constant mono `pitch` / `cv` (None = unconnected).
    fn gain_at(p: &[f32], hz: f64, pitch: Option<f32>, cv: Option<f32>) -> f64 {
        gain_at_sr(SR, p, hz, pitch, cv)
    }

    fn gain_at_sr(sr: f32, p: &[f32], hz: f64, pitch: Option<f32>, cv: Option<f32>) -> f64 {
        let mut f = Formant::new(sr);
        f.snap();
        let mut ins = [PortBuf::new(), PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        for (port, v) in [(1, pitch), (2, cv)] {
            if let Some(v) = v {
                ins[port].channels = 1;
                ins[port].data[0] = [v; RACK_BLOCK];
            }
        }
        let mut outs = [PortBuf::new()];
        tone_gain_db(sr, hz, |l, _r| {
            for chunk in l.chunks_mut(RACK_BLOCK) {
                ins[0].data[0].copy_from_slice(chunk);
                f.process(p, &ins, &mut outs);
                chunk.copy_from_slice(&outs[0].data[0]);
            }
        })
    }

    /// The peak's frequency is inside `want ± 3 %`: the response at `want`
    /// beats both ends of the bracket (a resonant peak is unimodal there).
    fn assert_peak_near(p: &[f32], want: f64, pitch: Option<f32>, cv: Option<f32>, what: &str) {
        let mid = gain_at(p, want, pitch, cv);
        let lo = gain_at(p, want * 0.97, pitch, cv);
        let hi = gain_at(p, want * 1.03, pitch, cv);
        assert!(mid > lo && mid > hi, "{what}: no peak at {want:.0} Hz ({lo:.2} / {mid:.2} / {hi:.2} dB)");
    }

    #[test]
    fn formant_peaks_land_on_their_frequencies() {
        let mut p = defaults();
        p[G2] = 1.0;
        p[G3] = 1.0;
        assert_eq!(p[Q], 6.0);
        for sr in SRS {
            for want in [500.0f64, 1500.0, 2600.0] {
                // Sweep ±12 % in 1.5 % steps; the maximum must be inside, not
                // at an edge (a local maximum), and within ±3 % at about 0 dB.
                let steps: Vec<f64> = (-8..=8).map(|k| want * (1.0 + 0.015 * k as f64)).collect();
                let gains: Vec<f64> = steps.iter().map(|&hz| gain_at_sr(sr, &p, hz, None, None)).collect();
                let (best, &g) = gains.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap();
                assert!(best > 0 && best < steps.len() - 1, "{sr}: {want} Hz: maximum at the sweep edge ({:?})", gains);
                let at = steps[best];
                assert!((at / want - 1.0).abs() <= 0.03, "{sr}: {want} Hz peak found at {at:.0} Hz");
                assert!(g.abs() <= 1.5, "{sr}: {want} Hz peak gain {g:.2} dB");
            }
        }
    }

    #[test]
    fn formant_tracks_pitch_and_cv() {
        let base = [500.0f64, 1500.0, 2600.0];
        let mut p = defaults();
        p[G2] = 1.0;
        p[G3] = 1.0;
        // track 1, pitch +1 oct: every peak doubles.
        p[TRACK] = 1.0;
        for f in base {
            assert_peak_near(&p, f * 2.0, Some(1.0), None, "track 1, pitch +1");
        }
        // track 0.15: they move 2^0.15.
        p[TRACK] = 0.15;
        for f in base {
            assert_peak_near(&p, f * 2f64.powf(0.15), Some(1.0), None, "track 0.15");
        }
        // cv_amt −1 with cv 1: they halve (pitch unconnected reads 0).
        p[TRACK] = 0.0;
        p[CV_AMT] = -1.0;
        for f in base {
            assert_peak_near(&p, f * 0.5, None, Some(1.0), "cv_amt -1, cv 1");
        }
        // shift +0.5 oct: ×√2.
        p[CV_AMT] = 0.0;
        p[SHIFT] = 0.5;
        for f in base {
            assert_peak_near(&p, f * 2f64.sqrt(), None, None, "shift +0.5");
        }
    }

    #[test]
    fn formant_mix_zero_is_dry() {
        let mut p = defaults();
        p[MIX] = 0.0;
        p[Q] = 20.0;
        let mut f = Formant::new(SR);
        f.snap();
        let mut noise = Noise::new(3);
        let mut ins = [PortBuf::new(), PortBuf::new(), PortBuf::new()];
        ins[0].channels = 2;
        ins[2].channels = 1;
        let mut outs = [PortBuf::new()];
        for b in 0..200 {
            for i in 0..RACK_BLOCK {
                ins[0].data[0][i] = noise.next();
                ins[0].data[1][i] = 0.5 * noise.next();
                ins[2].data[0][i] = ((b * RACK_BLOCK + i) as f32 * 0.001).sin();
            }
            f.process(&p, &ins, &mut outs);
            assert_eq!(outs[0].channels, 2);
            for ch in 0..2 {
                for i in 0..RACK_BLOCK {
                    assert_eq!(outs[0].data[ch][i].to_bits(), ins[0].data[ch][i].to_bits(), "block {b} ch {ch} i {i}");
                }
            }
        }
    }

    #[test]
    fn formant_is_bounded() {
        for sr in SRS {
            let mut p = defaults();
            p[Q] = 20.0;
            p[G2] = 1.0;
            p[G3] = 1.0;
            p[CV_AMT] = 4.0;
            let mut f = Formant::new(sr);
            f.snap();
            let mut noise = Noise::new(11);
            let mut ins = [PortBuf::new(), PortBuf::new(), PortBuf::new()];
            ins[0].channels = 2;
            ins[2].channels = 1;
            let mut outs = [PortBuf::new()];
            let mut peak = 0.0f32;
            let saw_period = (sr / 110.0) as usize;
            for b in 0..(2.0 * sr) as usize / RACK_BLOCK {
                for i in 0..RACK_BLOCK {
                    let n = b * RACK_BLOCK + i;
                    ins[0].data[0][i] = noise.next();
                    // Full-scale saw at 110 Hz.
                    ins[0].data[1][i] = (n % saw_period) as f32 / (saw_period as f32 / 2.0) - 1.0;
                    // cv ±1 at 20 Hz, × cv_amt 4 = ±4 oct.
                    ins[2].data[0][i] = (std::f32::consts::TAU * 20.0 * n as f32 / sr).sin();
                }
                f.process(&p, &ins, &mut outs);
                for ch in 0..2 {
                    for &y in &outs[0].data[ch] {
                        assert!(y.is_finite(), "{sr}: non-finite output");
                        peak = peak.max(y.abs());
                    }
                }
            }
            assert!(peak <= 3.5, "{sr}: peak {peak}");
            assert!(peak > 0.5, "{sr}: it rings: {peak}");
            // The limiter only bounds the output: the filters themselves must
            // stay bounded and finite (no defensive reset ever fired).
            let pr = f.probe;
            assert_eq!(pr.resets, 0, "{sr}: a non-finite state was reset");
            assert!(pr.pre_limit < 3.5, "{sr}: pre-limiter peak {}", pr.pre_limit);
            assert!(pr.state < 100.0, "{sr}: state peak {}", pr.state);
            // Silence: the states decay and are flushed to exactly 0.
            ins[0].data = [[0.0; RACK_BLOCK]; crate::MAX_POLY];
            for _ in 0..(2.0 * sr) as usize / RACK_BLOCK {
                f.process(&p, &ins, &mut outs);
            }
            assert!(f.state[..2].iter().flatten().flatten().all(|&s| s == 0.0), "{sr}: denormals flushed");
            assert!(outs[0].data[..2].iter().flatten().all(|&y| y == 0.0));
        }
    }

    /// Largest second difference `|y[n] − 2y[n−1] + y[n−2]|`: a sine of
    /// amplitude A at f has A·(2πf/sr)², so a click (a step or a kink)
    /// stands out against the steady signal's own curvature.
    fn max_d2(y: &[f32]) -> f32 {
        y.windows(3).map(|w| (w[2] - 2.0 * w[1] + w[0]).abs()).fold(0.0, f32::max)
    }

    /// Outputs (per channel, after a 0.1 s start-up) for a 0.5-amplitude
    /// 1 kHz sine with a `cv` of `cv_ch` channels given by `cv(ch, n)`.
    fn render_cv(p: &[f32], cv_ch: usize, seconds: f32, cv: impl Fn(usize, usize) -> f32) -> Vec<Vec<f32>> {
        let mut f = Formant::new(SR);
        f.snap();
        let mut ins = [PortBuf::new(), PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        ins[2].channels = cv_ch;
        let mut outs = [PortBuf::new()];
        let mut out = vec![Vec::new(); cv_ch];
        let skip = (0.1 * SR) as usize;
        for b in 0..(seconds * SR) as usize / RACK_BLOCK {
            for i in 0..RACK_BLOCK {
                let n = b * RACK_BLOCK + i;
                ins[0].data[0][i] = 0.5 * (std::f32::consts::TAU * 1000.0 * n as f32 / SR).sin();
                for ch in 0..cv_ch {
                    ins[2].data[ch][i] = cv(ch, n);
                }
            }
            f.process(p, &ins, &mut outs);
            for (ch, o) in out.iter_mut().enumerate() {
                if b * RACK_BLOCK >= skip {
                    o.extend_from_slice(&outs[0].data[ch]);
                }
            }
        }
        out
    }

    #[test]
    fn formant_cv_sweep_is_smooth() {
        for q in [6.0, 20.0] {
            let mut p = defaults();
            p[Q] = q;
            p[CV_AMT] = 1.0;
            let at = (0.25 * SR) as usize;
            let steady_at = |p: &[f32], c: f32| max_d2(&render_cv(p, 1, 0.5, |_, _| c)[0]);
            // A 1-oct cv step, both ways, against the settled states.
            let steady = steady_at(&p, 0.0).max(steady_at(&p, 1.0));
            let bound = 3.0 * steady;
            for (c0, c1) in [(0.0, 1.0), (1.0, 0.0)] {
                let y = &render_cv(&p, 1, 0.5, |_, n| if n >= at { c1 } else { c0 })[0];
                let got = max_d2(y);
                assert!(got <= bound, "q {q}: cv step {c0}->{c1}: max d2 {got} > 3 × steady {steady}");
                // The detector catches a click: a 0.05 step (the old
                // test's threshold) added at the cv step breaks the bound.
                let mut clicked = y.clone();
                let k = at - (0.1 * SR) as usize;
                clicked[k..].iter_mut().for_each(|v| *v += 0.05);
                assert!(max_d2(&clicked) > bound, "q {q}: the metric must see a 0.05 step");
            }
            // A 20 Hz ±4-oct sweep against every settled state in range.
            p[CV_AMT] = 4.0;
            let steady = (-8..=8).map(|k| steady_at(&p, k as f32 / 8.0)).fold(0.0f32, f32::max);
            let sweep = |_: usize, n: usize| (std::f32::consts::TAU * 20.0 * n as f32 / SR).sin();
            let got = max_d2(&render_cv(&p, 1, 0.5, sweep)[0]);
            assert!(got <= 3.0 * steady, "q {q}: 20 Hz sweep: max d2 {got} > 3 × steady {steady}");
            // Poly cv (per-channel coefficients): channel 0 steps, channel 1
            // holds; each matches its own mono behaviour.
            p[CV_AMT] = 1.0;
            let poly = render_cv(&p, 2, 0.5, |ch, n| if ch == 0 && n >= at { 1.0 } else if ch == 0 { 0.0 } else { 0.5 });
            let got = max_d2(&poly[0]);
            assert!(got <= bound, "q {q}: poly cv step: max d2 {got} > {bound}");
            let held = &render_cv(&p, 1, 0.5, |_, _| 0.5)[0];
            let diff = held.iter().zip(&poly[1]).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(diff < 1e-6, "q {q}: the held channel is independent ({diff})");
        }
    }

    #[test]
    fn formant_is_poly() {
        let mut p = defaults();
        p[TRACK] = 1.0;
        let pitches = [-1.0f32, 0.0, 0.5, 1.0];
        let input = |n: usize| ((n % 200) as f32 / 100.0 - 1.0) * 0.5;
        // 4 pitch channels and a mono `in`: 4 outputs.
        let mut f = Formant::new(SR);
        f.snap();
        let mut ins = [PortBuf::new(), PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        ins[1].channels = 4;
        for (ch, &pc) in pitches.iter().enumerate() {
            ins[1].data[ch] = [pc; RACK_BLOCK];
        }
        let mut outs = [PortBuf::new()];
        let mut poly_out = vec![Vec::new(); 4];
        for b in 0..100 {
            for i in 0..RACK_BLOCK {
                ins[0].data[0][i] = input(b * RACK_BLOCK + i);
            }
            f.process(&p, &ins, &mut outs);
            assert_eq!(outs[0].channels, 4);
            for (ch, o) in poly_out.iter_mut().enumerate() {
                o.extend_from_slice(&outs[0].data[ch]);
            }
        }
        // Each channel equals a mono render at its own pitch (independent).
        for (ch, &pc) in pitches.iter().enumerate() {
            let mut f = Formant::new(SR);
            f.snap();
            let mut ins = [PortBuf::new(), PortBuf::new(), PortBuf::new()];
            ins[0].channels = 1;
            ins[1].channels = 1;
            ins[1].data[0] = [pc; RACK_BLOCK];
            let mut mono = Vec::new();
            for b in 0..100 {
                for i in 0..RACK_BLOCK {
                    ins[0].data[0][i] = input(b * RACK_BLOCK + i);
                }
                f.process(&p, &ins, &mut outs);
                assert_eq!(outs[0].channels, 1);
                mono.extend_from_slice(&outs[0].data[0]);
            }
            let diff = mono.iter().zip(&poly_out[ch]).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(diff < 1e-6, "ch {ch} differs from its mono render by {diff}");
        }
        assert!(poly_out[0] != poly_out[3], "channels are distinct");
    }
}
