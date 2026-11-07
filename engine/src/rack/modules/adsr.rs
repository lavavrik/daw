//! ADSR envelope: `gate` (+ `vel`) -> `env` (CV 0..1), one envelope per
//! channel.
//!
//! Stages: Idle -> (Delay) -> Attack -> Decay -> Sustain -> Release -> Idle.
//!
//! * **Delay** (plan 11; `delay` > 0 only): a rising gate first holds the
//!   current level for `delay` seconds (rounded to samples, counted per
//!   channel), then starts the attack. A falling gate during the delay
//!   releases from the held level; a retrigger (falling then rising gate)
//!   restarts the delay; a held gate (legato) never does. `delay` 0 skips the
//!   stage entirely (the pre-plan-11 envelope).
//! * Attack is **linear** to 1.0 at a fixed slope of `1 / (attack * sr)` per
//!   sample, so it takes exactly `attack` seconds from 0 (less from a higher
//!   level) and never steps by more than that slope.
//! * Decay and release are **exponential** with time constant
//!   `tau = t / ln(100)`, so each segment is within 1% of the distance to its
//!   target after its stated time `t` (decay -> `sustain`, release -> 0).
//! * A rising gate edge restarts the attack (or the delay) *from the current
//!   level* (no jump when retriggering a sounding voice); a falling edge
//!   releases from whatever the level is, including mid-attack.
//! * `sustain` is smoothed (5 ms), so moving it never clicks. While held at
//!   sustain the level simply tracks it.
//! * **Velocity** (plan 11): `env = level × (1 − vel_amt + vel_amt × v)`,
//!   where `v` is the `vel` input (0..1; unconnected = 1; mono is broadcast)
//!   **latched at the rising gate edge**, so a note's dynamic holds through
//!   it (mono legato keeps the first note's velocity: no new edge). The
//!   latched value glides over 5 ms (one-pole), so a voice stolen at a
//!   sounding level never steps; from Idle (level 0) it is taken at once.
//!   `vel_amt` is smoothed (5 ms). With `vel_amt` 0 the scale is exactly 1,
//!   so the output is bit-identical to the envelope without velocity.
//! * Channels follow the `gate` input (min 1); a mono gate is broadcast.
//!   An unconnected gate reads as 0, so the output is silent. `vel` never
//!   changes the channel count.
//! * The release is snapped to exactly 0 below `IDLE_LEVEL` (-120 dB), and
//!   values below 1e-20 are flushed (denormal guard).

// `x.max(a).min(b)` is used on purpose instead of `clamp`: it maps NaN to a
// bound rather than propagating it (as in the Filter).
#![allow(clippy::manual_clamp)]

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::{poly, PortBuf};
use crate::{MAX_POLY, RACK_BLOCK};

const ATTACK: usize = 0;
const DECAY: usize = 1;
const SUSTAIN: usize = 2;
const RELEASE: usize = 3;
const DELAY: usize = 4;
const VEL_AMT: usize = 5;
/// Input port indices (catalog order).
const IN_GATE: usize = 0;
const IN_VEL: usize = 1;
const K: ModuleKind = ModuleKind::Adsr;

/// Below this the release snaps to 0 and the voice goes idle.
const IDLE_LEVEL: f32 = 1e-6;
/// Decay hands over to the sustain stage when this close to the sustain level.
const SUSTAIN_CAPTURE: f32 = 1e-4;
/// ln(100): an exponential with `tau = t / LN_100` is at 1% after `t`.
const LN_100: f32 = 4.605_170_2;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Idle,
    Delay,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone)]
pub struct Adsr {
    sr: f32,
    level: [f32; MAX_POLY],
    stage: [Stage; MAX_POLY],
    /// Samples left in the Delay stage, per channel.
    delay_left: [u32; MAX_POLY],
    /// Velocity latched at the last rising edge, per channel.
    vel: [f32; MAX_POLY],
    /// The latched velocity, glided (5 ms) so a steal never steps.
    vel_glide: [Smooth; MAX_POLY],
    sustain: Smooth,
    vel_amt: Smooth,
}

/// Per-sample coefficient of an exponential that is 99% done after `seconds`.
fn exp_coef(seconds: f32, sr: f32) -> f32 {
    (-LN_100 / (seconds.max(0.001) * sr)).exp()
}

impl Adsr {
    /// Automation: the next sub-block takes its `smooth` params at once.
    pub fn snap(&mut self) {
        self.sustain.snap();
        self.vel_amt.snap();
    }

    pub fn new(sr: f32) -> Adsr {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        Adsr {
            sr,
            level: [0.0; MAX_POLY],
            stage: [Stage::Idle; MAX_POLY],
            delay_left: [0; MAX_POLY],
            vel: [1.0; MAX_POLY],
            vel_glide: [Smooth::new(sr, 1.0); MAX_POLY],
            sustain: Smooth::new(sr, default(K, SUSTAIN)),
            vel_amt: Smooth::new(sr, default(K, VEL_AMT)),
        }
    }

    pub fn reset(&mut self) {
        self.level = [0.0; MAX_POLY];
        self.stage = [Stage::Idle; MAX_POLY];
        self.delay_left = [0; MAX_POLY];
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let (Some(gate), Some(out)) = (ins.get(IN_GATE), outs.first_mut()) else { return };
        let vel_in = ins.get(IN_VEL).filter(|p| p.channels > 0);
        let channels = poly(&ins[..1]);
        out.channels = channels;
        let attack_inc = 1.0 / (param(params, K, ATTACK).max(0.001) * self.sr);
        let decay_coef = exp_coef(param(params, K, DECAY), self.sr);
        let release_coef = exp_coef(param(params, K, RELEASE), self.sr);
        let sustain_target = param(params, K, SUSTAIN).clamp(0.0, 1.0);
        // Read at the rising edge. `max/min` (not clamp) maps NaN to 0.
        let delay_samples = (param(params, K, DELAY).max(0.0).min(4.0) * self.sr).round() as u32;
        let amt_target = param(params, K, VEL_AMT).max(0.0).min(1.0);
        // Channels above the current count must not keep stale state, or raising
        // the count later would resurrect an old level.
        for ch in channels..MAX_POLY {
            self.level[ch] = 0.0;
            self.stage[ch] = Stage::Idle;
            self.delay_left[ch] = 0;
        }
        for i in 0..RACK_BLOCK {
            let sus = self.sustain.next(sustain_target);
            let amt = self.vel_amt.next(amt_target);
            for ch in 0..channels {
                let on = gate.get(ch, i) >= 0.5;
                let (mut lv, mut st) = (self.level[ch], self.stage[ch]);
                match (on, st) {
                    // Rising edge: latch the velocity, then (re)start the
                    // delay or the attack from the current level.
                    (true, Stage::Idle | Stage::Release) => {
                        self.vel[ch] = vel_in.map_or(1.0, |p| p.get(ch, i).max(0.0).min(1.0));
                        if st == Stage::Idle {
                            // Level 0: nothing to glide from.
                            self.vel_glide[ch].snap();
                        }
                        if delay_samples > 0 {
                            st = Stage::Delay;
                            self.delay_left[ch] = delay_samples;
                        } else {
                            st = Stage::Attack;
                        }
                    }
                    // Falling edge: release from wherever we are.
                    (false, Stage::Delay | Stage::Attack | Stage::Decay | Stage::Sustain) => st = Stage::Release,
                    _ => {}
                }
                match st {
                    Stage::Idle => lv = 0.0,
                    Stage::Delay => {
                        // Hold the level; the attack starts on the next sample.
                        self.delay_left[ch] = self.delay_left[ch].saturating_sub(1);
                        if self.delay_left[ch] == 0 {
                            st = Stage::Attack;
                        }
                    }
                    Stage::Attack => {
                        lv += attack_inc;
                        if lv >= 1.0 {
                            lv = 1.0;
                            st = Stage::Decay;
                        }
                    }
                    Stage::Decay => {
                        lv = sus + (lv - sus) * decay_coef;
                        if (lv - sus).abs() < SUSTAIN_CAPTURE {
                            st = Stage::Sustain;
                        }
                    }
                    Stage::Sustain => lv = sus,
                    Stage::Release => {
                        lv *= release_coef;
                        if lv < IDLE_LEVEL {
                            lv = 0.0;
                            st = Stage::Idle;
                        }
                    }
                }
                if !lv.is_finite() || lv.abs() < 1e-20 {
                    lv = 0.0;
                }
                self.level[ch] = lv;
                self.stage[ch] = st;
                // amt 0 gives exactly 1.0 (the glided velocity is finite).
                let v = self.vel_glide[ch].next(self.vel[ch]);
                out.data[ch][i] = lv * (1.0 - amt + amt * v);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_PARAMS;

    const SR: f32 = 48000.0;

    fn params(a: f32, d: f32, s: f32, r: f32) -> [f32; MAX_PARAMS] {
        let mut p = [0.0f32; MAX_PARAMS];
        p[ATTACK] = a;
        p[DECAY] = d;
        p[SUSTAIN] = s;
        p[RELEASE] = r;
        p
    }

    /// Run `blocks` sub-blocks with a constant mono gate; returns every sample.
    fn run(env: &mut Adsr, p: &[f32], gate: f32, blocks: usize) -> Vec<f32> {
        let mut g = [PortBuf::new()];
        g[0].channels = 1;
        g[0].data[0] = [gate; RACK_BLOCK];
        let mut outs = [PortBuf::new()];
        let mut all = Vec::new();
        for _ in 0..blocks {
            env.process(p, &g, &mut outs);
            all.extend_from_slice(&outs[0].data[0]);
        }
        all
    }

    #[test]
    fn adsr_timings() {
        let p = params(0.01, 0.1, 0.5, 0.1);
        let mut env = Adsr::new(SR);
        // Attack: 0.01 s = 480 samples = 15 blocks; reaches 1.0 +-0.02.
        let a = run(&mut env, &p, 1.0, 15);
        assert!((a[479] - 1.0).abs() <= 0.02, "attack end {}", a[479]);
        assert!(a[239] > 0.45 && a[239] < 0.55, "linear: {}", a[239]);
        // Decay: 1% of the way to sustain (0.5) after 0.1 s = 4800 samples.
        let d = run(&mut env, &p, 1.0, 150);
        let at = d[4799]; // ~0.1 s after the attack ended (+-1 block)
        assert!((at - 0.5).abs() < 0.01 * 0.5 + 0.002, "decay at 0.1s: {at}");
        let hold = run(&mut env, &p, 1.0, 400);
        assert!((hold[hold.len() - 1] - 0.5).abs() < 1e-3);
        // Release from sustain 0.5: below 0.01 by 0.1 s +10%.
        let r = run(&mut env, &p, 0.0, 500);
        let n = (0.11 * SR) as usize;
        assert!(r[n] < 0.01, "release at 0.11s: {}", r[n]);
        assert!(r[(0.05 * SR) as usize] > 0.01);
        assert!(*r.last().unwrap() == 0.0, "idles at exactly 0");
    }

    #[test]
    fn release_from_full_level_is_one_percent_at_time() {
        let p = params(0.001, 0.001, 1.0, 0.2);
        let mut env = Adsr::new(SR);
        run(&mut env, &p, 1.0, 20);
        let r = run(&mut env, &p, 0.0, 400);
        let v = r[(0.2 * SR) as usize - 1];
        assert!((v - 0.01).abs() < 0.002, "{v}");
    }

    #[test]
    fn adsr_retrigger_from_current_level() {
        let p = params(0.1, 0.2, 0.7, 0.5);
        let mut env = Adsr::new(SR);
        run(&mut env, &p, 1.0, 30); // ~0.02 s into the 0.1 s attack
        let before = run(&mut env, &p, 1.0, 1);
        let lvl = before[RACK_BLOCK - 1];
        assert!(lvl > 0.1 && lvl < 0.5, "mid attack {lvl}");
        // Release for a little, then re-gate: attack continues from there.
        let rel = run(&mut env, &p, 0.0, 10);
        let low = rel[rel.len() - 1];
        assert!(low > 0.0 && low < lvl, "released a bit {low}");
        let again = run(&mut env, &p, 1.0, 2);
        let slope = 1.0 / (0.1 * SR);
        assert!(again[0] > low && again[0] - low <= slope * 1.01, "no jump: {} -> {}", low, again[0]);
        for w in again.windows(2) {
            assert!((w[1] - w[0]).abs() <= slope * 1.01);
        }
    }

    #[test]
    fn release_mid_attack_starts_from_current_level() {
        let p = params(0.1, 0.2, 0.7, 0.5);
        let mut env = Adsr::new(SR);
        let up = run(&mut env, &p, 1.0, 30);
        let lvl = up[up.len() - 1];
        assert!(lvl > 0.1 && lvl < 0.5, "mid attack {lvl}");
        let down = run(&mut env, &p, 0.0, 1);
        assert!(down[0] < lvl && down[0] > lvl * 0.99, "no jump: {lvl} -> {}", down[0]);
        assert!(down.windows(2).all(|w| w[1] <= w[0]), "falls monotonically");
    }

    #[test]
    fn stale_channel_state_is_cleared_when_channels_drop() {
        let p = params(0.001, 0.2, 0.7, 5.0);
        let mut env = Adsr::new(SR);
        let mut g = [PortBuf::new()];
        g[0].channels = 4;
        g[0].data[3] = [1.0; RACK_BLOCK];
        let mut outs = [PortBuf::new()];
        for _ in 0..10 {
            env.process(&p, &g, &mut outs);
        }
        assert!(outs[0].data[3][RACK_BLOCK - 1] > 0.6);
        g[0].channels = 2;
        env.process(&p, &g, &mut outs);
        g[0].channels = 4;
        g[0].data[3] = [0.0; RACK_BLOCK];
        env.process(&p, &g, &mut outs);
        assert_eq!(outs[0].data[3][0], 0.0, "no resurrected level");
    }

    #[test]
    fn channels_follow_gate_and_unconnected_is_silent() {
        let p = params(0.005, 0.2, 0.7, 0.3);
        let mut env = Adsr::new(SR);
        let mut g = [PortBuf::new()];
        g[0].channels = 3;
        g[0].data[1] = [1.0; RACK_BLOCK];
        let mut outs = [PortBuf::new()];
        for _ in 0..20 {
            env.process(&p, &g, &mut outs);
        }
        assert_eq!(outs[0].channels, 3);
        assert_eq!(outs[0].data[0][RACK_BLOCK - 1], 0.0);
        assert!(outs[0].data[1][RACK_BLOCK - 1] > 0.6);
        g[0].channels = 0;
        env.process(&p, &g, &mut outs);
        assert_eq!(outs[0].channels, 1);
    }

    // ---- plan 11: delay stage and velocity -------------------------------

    /// A frozen copy of the ADSR before plan 11 (no delay, no velocity): the
    /// reference for `adsr_defaults_are_bit_identical`. Do not edit.
    struct RefAdsr {
        sr: f32,
        level: [f32; MAX_POLY],
        stage: [Stage; MAX_POLY],
        sustain: Smooth,
    }

    impl RefAdsr {
        fn new(sr: f32) -> RefAdsr {
            RefAdsr { sr, level: [0.0; MAX_POLY], stage: [Stage::Idle; MAX_POLY], sustain: Smooth::new(sr, 0.7) }
        }

        fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
            let (Some(gate), Some(out)) = (ins.first(), outs.first_mut()) else { return };
            let channels = poly(&ins[..1]);
            out.channels = channels;
            let attack_inc = 1.0 / (param(params, K, ATTACK).max(0.001) * self.sr);
            let decay_coef = exp_coef(param(params, K, DECAY), self.sr);
            let release_coef = exp_coef(param(params, K, RELEASE), self.sr);
            let sustain_target = param(params, K, SUSTAIN).clamp(0.0, 1.0);
            for ch in channels..MAX_POLY {
                self.level[ch] = 0.0;
                self.stage[ch] = Stage::Idle;
            }
            for i in 0..RACK_BLOCK {
                let sus = self.sustain.next(sustain_target);
                for ch in 0..channels {
                    let on = gate.get(ch, i) >= 0.5;
                    let (mut lv, mut st) = (self.level[ch], self.stage[ch]);
                    match (on, st) {
                        (true, Stage::Idle | Stage::Release) => st = Stage::Attack,
                        (false, Stage::Attack | Stage::Decay | Stage::Sustain) => st = Stage::Release,
                        _ => {}
                    }
                    match st {
                        Stage::Idle => lv = 0.0,
                        Stage::Attack => {
                            lv += attack_inc;
                            if lv >= 1.0 {
                                lv = 1.0;
                                st = Stage::Decay;
                            }
                        }
                        Stage::Decay => {
                            lv = sus + (lv - sus) * decay_coef;
                            if (lv - sus).abs() < SUSTAIN_CAPTURE {
                                st = Stage::Sustain;
                            }
                        }
                        Stage::Sustain => lv = sus,
                        Stage::Release => {
                            lv *= release_coef;
                            if lv < IDLE_LEVEL {
                                lv = 0.0;
                                st = Stage::Idle;
                            }
                        }
                        #[allow(unreachable_patterns)]
                        _ => {}
                    }
                    if !lv.is_finite() || lv.abs() < 1e-20 {
                        lv = 0.0;
                    }
                    self.level[ch] = lv;
                    self.stage[ch] = st;
                    out.data[ch][i] = lv;
                }
            }
        }
    }

    /// Catalog defaults for every ADSR param (delay 0, vel_amt 0).
    fn defaults() -> [f32; MAX_PARAMS] {
        let mut p = [0.0f32; MAX_PARAMS];
        for (v, s) in p.iter_mut().zip(crate::rack::catalog::spec(K).params) {
            *v = s.default;
        }
        p
    }

    /// Gate `gate` and velocity `vel` (mono, or `None` = unconnected) for
    /// `blocks` sub-blocks; returns channel 0's samples.
    fn run_vel(env: &mut Adsr, p: &[f32], gate: f32, vel: Option<f32>, blocks: usize) -> Vec<f32> {
        let mut ins = [PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        ins[0].data[0] = [gate; RACK_BLOCK];
        if let Some(v) = vel {
            ins[1].channels = 1;
            ins[1].data[0] = [v; RACK_BLOCK];
        }
        let mut outs = [PortBuf::new()];
        let mut all = Vec::new();
        for _ in 0..blocks {
            env.process(p, &ins, &mut outs);
            all.extend_from_slice(&outs[0].data[0]);
        }
        all
    }

    #[test]
    fn adsr_defaults_are_bit_identical() {
        // 3 poly channels: attack/hold/release, a retrigger mid-release, a
        // gate change inside a sub-block, and a sustain move while held.
        let gate_at = |ch: usize, n: usize| -> f32 {
            let t = n as f32 / SR;
            let on = match ch {
                0 => t < 0.3 || (0.4..0.9).contains(&t),
                1 => (0.05..0.25).contains(&t) || (0.27..0.5).contains(&t),
                _ => !((n + 7) / 1013).is_multiple_of(3),
            };
            if on { 1.0 } else { 0.0 }
        };
        for vel_connected in [false, true] {
            let mut p = defaults();
            p[ATTACK] = 0.01;
            p[DECAY] = 0.08;
            p[RELEASE] = 0.15;
            let mut new = Adsr::new(SR);
            let mut old = RefAdsr::new(SR);
            let mut ins = [PortBuf::new(), PortBuf::new()];
            ins[0].channels = 3;
            if vel_connected {
                ins[1].channels = 3;
            }
            let (mut o_new, mut o_old) = ([PortBuf::new()], [PortBuf::new()]);
            for b in 0..(1.2 * SR) as usize / RACK_BLOCK {
                p[SUSTAIN] = if b < 600 { 0.7 } else { 0.4 };
                for ch in 0..3 {
                    for i in 0..RACK_BLOCK {
                        ins[0].data[ch][i] = gate_at(ch, b * RACK_BLOCK + i);
                        ins[1].data[ch][i] = ((b * 7 + ch * 3 + i) % 11) as f32 / 10.0;
                    }
                }
                new.process(&p, &ins, &mut o_new);
                old.process(&p, &ins[..1], &mut o_old);
                assert_eq!(o_new[0].channels, o_old[0].channels);
                for ch in 0..3 {
                    for i in 0..RACK_BLOCK {
                        assert_eq!(
                            o_new[0].data[ch][i].to_bits(),
                            o_old[0].data[ch][i].to_bits(),
                            "vel {vel_connected} block {b} ch {ch} i {i}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn delay_holds_then_attacks() {
        let mut p = defaults();
        p[DELAY] = 0.25;
        p[ATTACK] = 0.1;
        p[SUSTAIN] = 1.0;
        let mut env = Adsr::new(SR);
        let out = run_vel(&mut env, &p, 1.0, None, (0.5 * SR) as usize / RACK_BLOCK);
        let d = (0.25 * SR) as usize;
        assert!(out[..d - RACK_BLOCK].iter().all(|&v| v == 0.0), "silent during the delay");
        assert!(out[d + RACK_BLOCK] > 0.0, "attacking after the delay");
        let top = out.iter().position(|&v| v >= 1.0).expect("reaches 1");
        let want = (0.35 * SR) as usize;
        assert!(top.abs_diff(want) <= (0.001 * SR) as usize, "reaches 1 at {top}, want {want}");
    }

    #[test]
    fn gate_off_during_delay_releases() {
        let mut p = defaults();
        p[ATTACK] = 0.005;
        p[SUSTAIN] = 0.6;
        p[RELEASE] = 0.2;
        let mut env = Adsr::new(SR);
        run_vel(&mut env, &p, 1.0, None, 100);
        let rel = run_vel(&mut env, &p, 0.0, None, 20);
        let lvl = *rel.last().unwrap();
        assert!(lvl > 0.2 && lvl < 0.6, "released a little: {lvl}");
        // Re-gate with a delay: the level holds.
        p[DELAY] = 0.5;
        let held = run_vel(&mut env, &p, 1.0, None, 50);
        assert!(held.iter().all(|&v| v == lvl), "delay holds the current level");
        // Gate off during the delay: releases from that level, no jump.
        let down = run_vel(&mut env, &p, 0.0, None, 1000);
        assert!(down[0] < lvl && down[0] > lvl * 0.99, "no jump: {lvl} -> {}", down[0]);
        assert!(down.windows(2).all(|w| w[1] <= w[0]), "falls monotonically");
        assert_eq!(*down.last().unwrap(), 0.0, "idles");
    }

    #[test]
    fn retrigger_restarts_delay() {
        let mut p = defaults();
        p[DELAY] = 0.1;
        p[ATTACK] = 0.5;
        let mut env = Adsr::new(SR);
        let first = run_vel(&mut env, &p, 1.0, None, (0.2 * SR) as usize / RACK_BLOCK);
        let lvl = *first.last().unwrap();
        assert!(lvl > 0.1, "attacking after the first delay: {lvl}");
        let gap = run_vel(&mut env, &p, 0.0, None, 1);
        let low = *gap.last().unwrap();
        let again = run_vel(&mut env, &p, 1.0, None, (0.2 * SR) as usize / RACK_BLOCK);
        let d = (0.1 * SR) as usize;
        assert!(again[..d - RACK_BLOCK].iter().all(|&v| v == low), "the delay restarted and holds");
        assert!(again[d + RACK_BLOCK] > low, "then attacks");
        // Legato (gate held) never restarts it: the attack just continues.
        let more = run_vel(&mut env, &p, 1.0, None, 10);
        assert!(more.windows(2).all(|w| w[1] > w[0]));
    }

    #[test]
    fn velocity_scales_and_latches() {
        let mut p = defaults();
        p[VEL_AMT] = 1.0;
        p[SUSTAIN] = 1.0;
        let mut env = Adsr::new(SR);
        env.snap(); // a fresh module takes its smooth params at once
        let up = run_vel(&mut env, &p, 1.0, Some(0.5), 40);
        let peak = up.iter().cloned().fold(0.0f32, f32::max);
        assert!((peak - 0.5).abs() < 1e-3, "peak {peak}");
        // The vel input moves mid-note: the latched velocity holds.
        let held = run_vel(&mut env, &p, 1.0, Some(1.0), 20);
        assert!(held.iter().all(|&v| (v - 0.5).abs() < 1e-3), "latched: {:?}", &held[..4]);
        // vel_amt 0.5: env = level × (1 − 0.5 + 0.5 × 0.5) = 0.75.
        p[VEL_AMT] = 0.5;
        let half = run_vel(&mut env, &p, 1.0, Some(1.0), 100);
        assert!((half.last().unwrap() - 0.75).abs() < 1e-3, "{}", half.last().unwrap());
    }

    #[test]
    fn velocity_steal_never_steps() {
        let mut p = defaults();
        p[ATTACK] = 0.01;
        p[SUSTAIN] = 0.8;
        p[VEL_AMT] = 1.0;
        let mut env = Adsr::new(SR);
        env.snap(); // a fresh module takes its smooth params at once
        let mut all = run_vel(&mut env, &p, 1.0, Some(1.0), 600);
        assert!((all.last().unwrap() - 0.8).abs() < 1e-3);
        // A steal: one sub-block of gate 0, then a new note at velocity 0.3.
        all.extend(run_vel(&mut env, &p, 0.0, Some(1.0), 1));
        all.extend(run_vel(&mut env, &p, 1.0, Some(0.3), 400));
        let slope = 1.0 / (0.01 * SR);
        let worst = all.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        assert!(worst <= slope + 0.01, "step {worst}");
        assert!((all.last().unwrap() - 0.24).abs() < 1e-3, "settles at 0.8 × 0.3: {}", all.last().unwrap());
    }

    #[test]
    fn unconnected_vel_reads_full() {
        let mut p = defaults();
        p[VEL_AMT] = 1.0;
        p[SUSTAIN] = 1.0;
        let mut env = Adsr::new(SR);
        env.snap(); // a fresh module takes its smooth params at once
        let up = run_vel(&mut env, &p, 1.0, None, 40);
        assert_eq!(*up.last().unwrap(), 1.0);
        // A 1-port `ins` (no vel slot at all) also reads full.
        let mut env = Adsr::new(SR);
        env.snap(); // a fresh module takes its smooth params at once
        let up = run(&mut env, &p, 1.0, 40);
        assert_eq!(*up.last().unwrap(), 1.0);
    }
}
