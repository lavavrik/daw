//! Accent (plan 17): `gate` + `vel` -> `cv` (0..1), a charge that builds up
//! across accented notes. Patched to the filter's cutoff cv (and/or a VCA),
//! it gives the acid "accent sweep": a run of accents opens the filter a
//! little further each time, and a rest lets it settle back.
//!
//! * **Accent.** A rising `gate` edge (gate crosses 0.5) whose `vel` is at
//!   least `threshold` (default 110/127, the MIDI velocity the step editor
//!   reads as an accent; it writes 120 for an accent, 80 for a plain note) adds [`CHARGE`] to the store: `store = min(1,
//!   store + 0.6)`. A plain note (below the threshold) adds nothing. `vel`
//!   is read at the edge: 0..1 as MIDI In outputs it; unconnected (or a
//!   gate channel beyond a poly `vel`'s channels) reads 1, as on the ADSR,
//!   so with `vel` unpatched every note is an accent. The comparison has a
//!   1e-6 tolerance, so MIDI velocity 110 (110/127 in f32) always counts.
//!   Why 110 and not 100: the app's default velocity is 100 (QWERTY piano,
//!   notes drawn in the piano roll), so at 100 every ordinary note accented.
//! * **Decay.** The store decays exponentially, `store ·= exp(−dt/decay)`
//!   per sample (`decay` 0.05..2 s, read per sub-block). With the default
//!   0.25 s and accents one 1/16 step apart at 120 BPM (0.125 s) the store
//!   peaks at 0.6, 0.6·e^(−0.5) + 0.6 ≈ 0.96, then 1.0 (capped); after 2 s
//!   of rest only e^(−8) ≈ 0.03% of it is left, so the next accent peaks at
//!   0.6 again.
//!   Below 1e-6 (−120 dB) it snaps to 0 (also the denormal guard).
//! * **Output.** `cv = amount · level`, where `level` follows the store:
//!   it rises toward a new charge at most `1 / RISE_SECONDS` per second (a
//!   0.6 step becomes a 0.6 ms ramp, so the cv never steps), and falls with
//!   the store exactly. `amount` (0..1) is smoothed (5 ms one-pole), like
//!   every `smooth` param.
//!   * Why a short ramp and not a 5 ms one-pole on the store (the plan's
//!     first wording): the store decays from the moment of the accent, and a
//!     5 ms one-pole lags it so much that a single accent would peak at ≈0.55
//!     (decay 0.25 s) or ≈0.47 (decay 0.05 s) instead of 0.6, and the peak
//!     would depend on `decay`. The 1 ms full-scale ramp keeps every peak
//!     within 0.01 of the store's (0.6 at any sample rate and decay) while
//!     still removing the step.
//! * **Channels** follow `gate` (min 1; an unconnected gate reads 0, so the
//!   output stays 0), one store per channel; `vel` never changes the count.
//!   A channel that goes away is cleared, so it restarts at 0 if it returns.
//! * Non-finite inputs are safe: a NaN gate reads low, a non-finite `vel`
//!   never charges, and the output stays finite and within 0..1.

// `x.max(a).min(b)` is used on purpose instead of `clamp`: it maps NaN to a
// bound rather than propagating it (as in the Filter).
#![allow(clippy::manual_clamp)]

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::{poly, PortBuf};
use crate::{MAX_POLY, RACK_BLOCK};

const THRESHOLD: usize = 0;
const AMOUNT: usize = 1;
const DECAY: usize = 2;
/// Input port indices (catalog order).
const IN_GATE: usize = 0;
const IN_VEL: usize = 1;
const K: ModuleKind = ModuleKind::Accent;

/// What one accent adds to the store (capped at 1).
pub const CHARGE: f32 = 0.6;
/// The `decay` range (s), as in the catalog.
const DECAY_MIN: f32 = 0.05;
const DECAY_MAX: f32 = 2.0;
/// The cv's rise time for a full-scale (0 -> 1) step.
pub const RISE_SECONDS: f32 = 0.001;
/// Below this the store (and the level) snap to 0.
const IDLE_LEVEL: f32 = 1e-6;
/// Tolerance of the `vel >= threshold` test.
const THRESHOLD_EPS: f32 = 1e-6;

/// The Accent module (see the module docs).
#[derive(Clone)]
pub struct Accent {
    sr: f32,
    /// Largest per-sample rise of `level`.
    rise_step: f32,
    /// The charge, per channel.
    store: [f32; MAX_POLY],
    /// The output before `amount`: the store, with its rises ramped.
    level: [f32; MAX_POLY],
    /// Gate state at the previous sample, per channel (edge detection).
    gate: [bool; MAX_POLY],
    amount: Smooth,
}

impl Accent {
    /// Automation: the next sub-block takes its `smooth` params at once.
    pub fn snap(&mut self) {
        self.amount.snap();
    }

    /// An empty store at the catalog defaults.
    pub fn new(sr: f32) -> Accent {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        Accent {
            sr,
            rise_step: 1.0 / (RISE_SECONDS * sr),
            store: [0.0; MAX_POLY],
            level: [0.0; MAX_POLY],
            gate: [false; MAX_POLY],
            amount: Smooth::new(sr, default(K, AMOUNT)),
        }
    }

    /// Empty every store (params are kept).
    pub fn reset(&mut self) {
        self.store = [0.0; MAX_POLY];
        self.level = [0.0; MAX_POLY];
        self.gate = [false; MAX_POLY];
    }

    /// Render one sub-block into `outs[0]`.
    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let (Some(gate), Some(out)) = (ins.get(IN_GATE), outs.first_mut()) else { return };
        let vel_in = ins.get(IN_VEL).filter(|p| p.channels > 0);
        let channels = poly(&ins[..1]);
        out.channels = channels;
        // Channels above the count must not keep a stale charge.
        for ch in channels..MAX_POLY {
            self.store[ch] = 0.0;
            self.level[ch] = 0.0;
            self.gate[ch] = false;
        }
        let threshold = param(params, K, THRESHOLD).max(0.0).min(1.0) - THRESHOLD_EPS;
        let decay = param(params, K, DECAY).max(DECAY_MIN).min(DECAY_MAX);
        let keep = (-1.0 / (decay * self.sr)).exp();
        let amt_target = param(params, K, AMOUNT).max(0.0).min(1.0);

        for i in 0..RACK_BLOCK {
            let amt = self.amount.next(amt_target).max(0.0).min(1.0);
            for ch in 0..channels {
                // NaN compares false: a non-finite gate reads low.
                let on = gate.get(ch, i) >= 0.5;
                let mut store = self.store[ch] * keep;
                if on && !self.gate[ch] {
                    let vel = match vel_in {
                        Some(p) if p.channels == 1 || ch < p.channels => p.get(ch, i),
                        _ => 1.0,
                    };
                    if vel.is_finite() && vel >= threshold {
                        store = (store + CHARGE).min(1.0);
                    }
                }
                self.gate[ch] = on;
                if !store.is_finite() || store < IDLE_LEVEL {
                    store = 0.0;
                }
                let lv = self.level[ch];
                let lv = if lv < store { (lv + self.rise_step).min(store) } else { store };
                self.store[ch] = store;
                self.level[ch] = lv;
                out.data[ch][i] = amt * lv;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_PARAMS;

    /// Params at the catalog defaults, with `decay` overridden.
    fn params(decay: f32) -> [f32; MAX_PARAMS] {
        let mut p = [0.0f32; MAX_PARAMS];
        for (i, v) in p.iter_mut().enumerate().take(3) {
            *v = default(K, i);
        }
        p[DECAY] = decay;
        p
    }

    /// Render `seconds` at `sr` with a mono gate that is high for `len`
    /// seconds from each of `starts` (seconds), `vel` on the vel input.
    /// Returns every `cv` sample.
    fn run(sr: f32, p: &[f32], starts: &[f64], len: f64, vel: f32, seconds: f64) -> Vec<f32> {
        let mut a = Accent::new(sr);
        let mut ins = [PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        ins[1].channels = 1;
        ins[1].data[0] = [vel; RACK_BLOCK];
        let mut outs = [PortBuf::new()];
        let blocks = (seconds * sr as f64 / RACK_BLOCK as f64).ceil() as usize;
        let mut cv = Vec::with_capacity(blocks * RACK_BLOCK);
        for b in 0..blocks {
            for i in 0..RACK_BLOCK {
                let t = (b * RACK_BLOCK + i) as f64 / sr as f64;
                let on = starts.iter().any(|&s| t >= s && t < s + len);
                ins[0].data[0][i] = if on { 1.0 } else { 0.0 };
            }
            a.process(p, &ins, &mut outs);
            assert_eq!(outs[0].channels, 1);
            cv.extend_from_slice(&outs[0].data[0]);
        }
        cv
    }

    /// The largest value in `cv` between `from` and `to` seconds.
    fn peak(cv: &[f32], sr: f32, from: f64, to: f64) -> f32 {
        let (a, b) = ((from * sr as f64) as usize, ((to * sr as f64) as usize).min(cv.len()));
        cv[a..b].iter().fold(0.0f32, |m, &x| m.max(x))
    }

    /// 120 BPM: one 1/16 step is 0.125 s; a plain note is half a step.
    const STEP: f64 = 0.125;

    #[test]
    fn stacked_accents_rise() {
        let sr = 48000.0;
        let cv = run(sr, &params(0.25), &[0.0, STEP, 2.0 * STEP], STEP / 2.0, 1.0, 4.0 * STEP);
        let peaks = [peak(&cv, sr, 0.0, STEP), peak(&cv, sr, STEP, 2.0 * STEP), peak(&cv, sr, 2.0 * STEP, 3.0 * STEP)];
        for (got, want) in peaks.iter().zip([0.60f32, 0.96, 1.0]) {
            assert!((got - want).abs() <= 0.02, "peaks {peaks:?}");
        }
        assert!(peaks[1] >= peaks[0] && peaks[2] >= peaks[1], "peaks {peaks:?}");
        assert!(cv.iter().all(|&x| (0.0..=1.0).contains(&x)));
    }

    #[test]
    fn rested_accent_matches_first() {
        let sr = 48000.0;
        let cv = run(sr, &params(0.25), &[0.0, 2.0], STEP / 2.0, 1.0, 2.5);
        let (first, second) = (peak(&cv, sr, 0.0, 1.0), peak(&cv, sr, 2.0, 2.5));
        assert!((first - second).abs() <= 0.01, "first {first}, after 2 s rest {second}");
    }

    #[test]
    fn below_threshold_no_charge() {
        let cv = run(48000.0, &params(0.25), &[0.0, STEP, 2.0 * STEP], STEP / 2.0, 0.5, 4.0 * STEP);
        assert!(cv.iter().all(|&x| x == 0.0), "vel 0.5 must not charge");
        // MIDI velocity 109 is a plain note, 110 an accent (default threshold 110/127);
        // 100 (the app's default velocity) is plain.
        for v in [100.0, 109.0] {
            let plain = run(48000.0, &params(0.25), &[0.0], STEP / 2.0, v / 127.0, STEP);
            assert!(plain.iter().all(|&x| x == 0.0), "vel {v} must not charge");
        }
        let accent = run(48000.0, &params(0.25), &[0.0], STEP / 2.0, 110.0 / 127.0, STEP);
        assert!(peak(&accent, 48000.0, 0.0, STEP) > 0.5);
    }

    #[test]
    fn amount_scales_and_rise_never_steps() {
        let sr = 48000.0;
        let mut p = params(0.25);
        p[AMOUNT] = 0.5;
        // (The accent comes after the amount's 5 ms glide from its default.)
        let cv = run(sr, &p, &[0.05], STEP / 2.0, 1.0, 0.05 + STEP);
        assert!((peak(&cv, sr, 0.05, 0.05 + STEP) - 0.3).abs() <= 0.01);
        // The 0.6 charge arrives as a ramp, never a step bigger than the
        // rise rate allows (amount 1).
        let cv = run(sr, &params(0.25), &[0.0, STEP], STEP / 2.0, 1.0, 2.0 * STEP);
        let step = cv.windows(2).fold(0.0f32, |m, w| m.max(w[1] - w[0]));
        assert!(step <= 1.0 / (RISE_SECONDS * sr) + 1e-6, "largest rise per sample {step}");
    }

    #[test]
    fn poly_channels_follow_gate_and_clear() {
        let mut a = Accent::new(48000.0);
        let p = params(0.25);
        let mut ins = [PortBuf::new(), PortBuf::new()];
        let mut outs = [PortBuf::new()];
        a.process(&p, &ins, &mut outs);
        assert_eq!(outs[0].channels, 1, "unconnected gate: 1 silent channel");
        assert!(outs[0].data[0].iter().all(|&x| x == 0.0));
        // Gate on 3 voices; a poly vel with 2 channels: voice 0 plain, voice
        // 1 accented, voice 2 (beyond vel) reads full velocity.
        ins[0].channels = 3;
        ins[1].channels = 2;
        for ch in 0..3 {
            ins[0].data[ch] = [1.0; RACK_BLOCK];
        }
        ins[1].data[0] = [0.3; RACK_BLOCK];
        ins[1].data[1] = [0.9; RACK_BLOCK];
        for _ in 0..20 {
            a.process(&p, &ins, &mut outs);
        }
        assert_eq!(outs[0].channels, 3);
        let last = |o: &PortBuf, ch: usize| o.data[ch][RACK_BLOCK - 1];
        assert_eq!(last(&outs[0], 0), 0.0);
        assert!(last(&outs[0], 1) > 0.5 && last(&outs[0], 2) > 0.5);
        // Dropping to 1 channel clears voices 1..; they come back empty.
        ins[0].channels = 1;
        a.process(&p, &ins, &mut outs);
        ins[0].channels = 3;
        ins[0].data = [[0.0; RACK_BLOCK]; MAX_POLY];
        a.process(&p, &ins, &mut outs);
        assert!(outs[0].data[1..3].iter().flatten().all(|&x| x == 0.0));
    }

    #[test]
    fn garbage_inputs_and_reset() {
        let mut a = Accent::new(48000.0);
        let mut ins = [PortBuf::new(), PortBuf::new()];
        ins[0].channels = 4;
        ins[1].channels = 4;
        let vals = [f32::NAN, f32::INFINITY, -1e30, 1.0];
        for ch in 0..4 {
            ins[0].data[ch] = [vals[ch]; RACK_BLOCK];
            ins[1].data[ch] = [vals[3 - ch]; RACK_BLOCK];
        }
        let mut outs = [PortBuf::new()];
        let mut p = params(0.25);
        p[THRESHOLD] = f32::NAN;
        p[DECAY] = f32::INFINITY;
        p[AMOUNT] = f32::NAN;
        for _ in 0..20 {
            a.process(&p, &ins, &mut outs);
            assert!(outs[0].data[..4].iter().flatten().all(|x| x.is_finite() && (0.0..=1.0).contains(x)));
        }
        // Gate 1.0 with vel NaN (ch 3) never charges.
        assert_eq!(outs[0].data[3][RACK_BLOCK - 1], 0.0);
        // A held gate charged once (ch 2: gate -1e30 is low; ch 1: +inf gate,
        // vel -1e30, no charge); after a reset the store is empty.
        let p = params(0.25);
        ins[0].channels = 1;
        ins[0].data[0] = [1.0; RACK_BLOCK];
        ins[1].channels = 0;
        a.process(&p, &ins, &mut outs);
        assert!(outs[0].data[0][RACK_BLOCK - 1] > 0.0);
        a.reset();
        ins[0].data[0] = [0.0; RACK_BLOCK];
        a.process(&p, &ins, &mut outs);
        assert!(outs[0].data[0].iter().all(|&x| x == 0.0));
        // Short slices are tolerated.
        a.process(&[], &ins[..1], &mut outs);
        a.process(&[], &[], &mut []);
    }

    #[test]
    fn short_decay_96k() {
        // Accents every 1 ms (0.5 ms high) for 0.1 s at the shortest decay.
        let starts: Vec<f64> = (0..100).map(|n| n as f64 * 0.001).collect();
        let cv = run(96000.0, &params(0.05), &starts, 0.0005, 1.0, 0.2);
        assert!(cv.iter().all(|&x| x.is_finite() && (0.0..=1.0).contains(&x)), "cv out of 0..1");
        // A single accent peaks at 0.6 whatever the sample rate and decay.
        for sr in [44100.0, 48000.0, 96000.0] {
            for decay in [0.05, 0.25, 2.0] {
                let cv = run(sr, &params(decay), &[0.0], STEP / 2.0, 1.0, STEP);
                let pk = peak(&cv, sr, 0.0, STEP);
                assert!((pk - 0.6).abs() <= 0.02, "sr {sr} decay {decay}: peak {pk}");
            }
        }
    }
}
