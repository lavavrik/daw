//! ADSR envelope: `gate` -> `env` (CV 0..1), one envelope per channel.
//!
//! * Attack is **linear** to 1.0 at a fixed slope of `1 / (attack * sr)` per
//!   sample, so it takes exactly `attack` seconds from 0 (less from a higher
//!   level) and never steps by more than that slope.
//! * Decay and release are **exponential** with time constant
//!   `tau = t / ln(100)`, so each segment is within 1% of the distance to its
//!   target after its stated time `t` (decay -> `sustain`, release -> 0).
//! * A rising gate edge restarts the attack *from the current level* (no jump
//!   when retriggering a sounding voice); a falling edge releases from
//!   whatever the level is, including mid-attack.
//! * `sustain` is smoothed (5 ms), so moving it never clicks. While held at
//!   sustain the level simply tracks it.
//! * Channels follow the `gate` input (min 1); a mono gate is broadcast.
//!   An unconnected gate reads as 0, so the output is silent.
//! * The release is snapped to exactly 0 below `IDLE_LEVEL` (-120 dB), and
//!   values below 1e-20 are flushed (denormal guard).

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::{poly, PortBuf};
use crate::{MAX_POLY, RACK_BLOCK};

const ATTACK: usize = 0;
const DECAY: usize = 1;
const SUSTAIN: usize = 2;
const RELEASE: usize = 3;
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
    sustain: Smooth,
}

/// Per-sample coefficient of an exponential that is 99% done after `seconds`.
fn exp_coef(seconds: f32, sr: f32) -> f32 {
    (-LN_100 / (seconds.max(0.001) * sr)).exp()
}

impl Adsr {
    /// Automation: the next sub-block takes its `smooth` params at once.
    pub fn snap(&mut self) {
        self.sustain.snap();
    }

    pub fn new(sr: f32) -> Adsr {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        Adsr {
            sr,
            level: [0.0; MAX_POLY],
            stage: [Stage::Idle; MAX_POLY],
            sustain: Smooth::new(sr, default(K, SUSTAIN)),
        }
    }

    pub fn reset(&mut self) {
        self.level = [0.0; MAX_POLY];
        self.stage = [Stage::Idle; MAX_POLY];
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let (Some(gate), Some(out)) = (ins.first(), outs.first_mut()) else { return };
        let channels = poly(&ins[..1]);
        out.channels = channels;
        let attack_inc = 1.0 / (param(params, K, ATTACK).max(0.001) * self.sr);
        let decay_coef = exp_coef(param(params, K, DECAY), self.sr);
        let release_coef = exp_coef(param(params, K, RELEASE), self.sr);
        let sustain_target = param(params, K, SUSTAIN).clamp(0.0, 1.0);
        // Channels above the current count must not keep stale state, or raising
        // the count later would resurrect an old level.
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
                    // Rising edge: (re)start the attack from the current level.
                    (true, Stage::Idle | Stage::Release) => st = Stage::Attack,
                    // Falling edge: release from wherever we are.
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
}
