//! Filter: a resonant 4-pole ladder (LP24) plus a state-variable filter
//! (LP12 / HP / BP / Notch). The heart of house basses and stabs.
//!
//! * **Cutoff.** Effective cutoff = `cutoff × 2^(cv × cv_amt)` (cv in V/oct),
//!   clamped to 20 Hz..0.45 × sample rate. It is computed per sample and per
//!   channel (cv may be a per-voice envelope); the `cutoff` knob is smoothed
//!   in the log2 domain (5 ms), so sweeps move evenly in octaves. `reso`,
//!   `cv_amt` and `drive` are smoothed linearly (5 ms).
//! * **Coefficients.** Both cores are TPT/zero-delay-feedback designs that
//!   need `g = tan(π·fc/sr)` every sample. We use [`tan_fast`], a rational
//!   approximation (Lambert continued fraction, 4 mults + 1 div) whose error
//!   is < 0.01% up to 0.45·sr, far below the 1% budget, and much cheaper than
//!   libm `tan` in wasm. When `cv` is unconnected or mono the coefficients
//!   are shared by all channels (computed once per sample).
//! * **LP24 (ladder).** Four one-pole TPT stages with global feedback
//!   `k = 4.2 × reso`, solved with the zero-delay-feedback estimate: the
//!   linear prediction `y4 = (G⁴u + S)/(1 + kG⁴)` gives the feedback, then the
//!   loop input `u − k·y4` passes through a soft saturator (`3·tanh(v/3)`,
//!   via [`tanh_fast`]) and the stages run. The loop gain is `k/4`, so
//!   self-oscillation starts at reso ≈ 0.95; the in-loop saturator bounds it.
//!   * Loop saturation is intended ladder character (ruling R10): because the
//!     saturator sits inside the feedback loop, at high resonance the loop
//!     signal is hot and the resonant peak is compressed by input level, as
//!     in an analog ladder. A quiet signal rings relatively more than a loud
//!     one. Review measurements on a full-scale 55 Hz saw sweep put the
//!     resonance ~14 dB below a linear ladder's at reso 0.6 and ~6 dB below
//!     at 0.8; a 0 dBFS 120 Hz saw's peak at reso 0.9 sits ~5.5 dB below a
//!     −20 dBFS one's (`lp24_resonance_compresses_with_level`). At low
//!     resonance or low level the ladder is linear (within 0.5 dB at
//!     −20 dBFS, reso 0.3; the −20 dBFS reso-0.9 peak matches too).
//!   * Passband makeup: the input is scaled by `1 + k/2`, so at reso 1 the
//!     passband drops to about −4.5 dB instead of a bare ladder's −14 dB.
//!   * Stage tuning: at reso 0 the four stages sit 0.585 oct (×1.5) above the
//!     cutoff, so the knob marks roughly the −6 dB point (a bare cascade is
//!     −12 dB at its stage frequency, which sounds too dull for the label).
//!     The offset shrinks linearly with reso to 0 at reso 1, so the resonant
//!     peak (which sits at the stage frequency) lands on the cutoff knob, as
//!     it does for the SVF modes.
//! * **LP12/HP/BP/Notch (SVF).** Simper/Zavalishin TPT state-variable filter,
//!   damping `k = 2 − 2·reso·0.975` (Q 0.5..20). All four outputs come from
//!   the same core: LP = v2, HP = x − k·v1 − v2, BP = k·v1 (unity peak gain),
//!   Notch = x − k·v1.
//! * **Drive.** Input gain `D = 1 + 7·drive` (×1..×8) into the soft saturator
//!   (inside the ladder's loop; before the SVF), then the output is scaled by
//!   `1/√D`. Drive 0 means no *added* input saturation: the SVF modes are
//!   clean (headroom 3: a full-scale signal loses < 0.3 dB), and LP24 is
//!   clean at low resonance or low level but still has its loop saturation
//!   at high resonance (above). Drive adds input saturation on top; at
//!   drive 1 a full-scale signal stays near unity while quiet ones gain up
//!   to +9 dB of grit.
//! * **Output stage.** A soft limiter, linear up to ±2 and easing into ±3.5,
//!   tames the SVF's resonant peak (up to +26 dB at Q 20) on hot inputs, so
//!   the output never exceeds ±3.5 even with full-scale noise at reso 1.
//!   It does engage (audibly soft-clipping the peak) on hot resonant LP12/HP
//!   sweeps, e.g. a full-scale saw at reso ≳ 0.8. LP24's loop saturation
//!   keeps it below the knee: a full-scale saw swept 100 Hz..12.8 kHz at reso
//!   0.3..0.9 peaks below ±2 (`lp24_never_hits_the_limiter`).
//! * **Mode switches** crossfade the old and new outputs linearly over 2 ms.
//!   The SVF modes share one state, so switching between them is seamless;
//!   switching to or from LP24 starts the incoming core from zero state, and
//!   the crossfade hides its start-up. At very low cutoffs (≲ 100 Hz) that
//!   core takes longer than the 2 ms fade to charge up, so an LP24 <-> SVF
//!   switch can dip in level briefly (no click, just a short swell back).
//!   A switch requested mid-crossfade waits for the current one to finish
//!   (≤ 2 ms).
//! * **Safety.** Non-finite inputs (audio or cv) read as 0. After each
//!   sub-block, states below 1e-20 are flushed to 0 (denormal guard) and a
//!   channel whose state went non-finite is reset (defensive; the filters are
//!   stable without it). Outputs are checked finite per sample.
//! * **Channels** are the maximum over the connected inputs (the global poly
//!   rule; normally that is `in`'s count, but a poly `cv` with a mono `in`
//!   gives one filter per cv voice). When the count drops, the dropped
//!   channels' state is cleared so they restart silent.

// `x.max(a).min(b)` is used on purpose instead of `clamp`: it maps NaN to a
// bound rather than propagating it (audio-thread values must stay finite).
#![allow(clippy::manual_clamp)]

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::{poly, PortBuf};
use crate::{MAX_POLY, RACK_BLOCK};

const MODE: usize = 0;
const CUTOFF: usize = 1;
const RESO: usize = 2;
const CV_AMT: usize = 3;
const DRIVE: usize = 4;
const K: ModuleKind = ModuleKind::Filter;

/// Mode ids (the `mode` choice param, `catalog::FILTER_MODES`).
pub const LP24: u8 = 0;
pub const LP12: u8 = 1;
pub const HP: u8 = 2;
pub const BP: u8 = 3;
pub const NOTCH: u8 = 4;

/// Lowest effective cutoff (Hz).
pub const MIN_HZ: f32 = 20.0;
/// Highest effective cutoff as a fraction of the sample rate.
pub const MAX_SR_FRACTION: f32 = 0.45;
/// Mode-switch crossfade length.
pub const XFADE_SECONDS: f32 = 0.002;
/// Ladder feedback at reso 1 (`k = 4.2 × reso`; self-oscillation above k = 4).
pub const LADDER_K_MAX: f32 = 4.2;
/// Ladder stage frequency above the cutoff at reso 0, in octaves (×1.5).
pub const LADDER_OFFSET_OCT: f32 = 0.585;
/// SVF resonance scale: `k = 2 − 2·reso·0.975`, so Q runs 0.5..20.
const SVF_RESO_SCALE: f32 = 0.975;
/// Saturator headroom: `sat(v) = 3·tanh(v/3)`.
const HEADROOM: f32 = 3.0;
/// Drive gain at drive 1.
const DRIVE_GAIN_MAX: f32 = 8.0;
/// Output soft limiter: linear below `OUT_KNEE`, approaching `OUT_CEIL`.
const OUT_KNEE: f32 = 2.0;
const OUT_CEIL: f32 = 3.5;
/// Denormal guard threshold for filter states.
const FLUSH: f32 = 1e-20;

/// `tan(x)` for `0 <= x <= 0.45π` (the TPT prewarp `tan(π·fc/sr)`):
/// truncated Lambert continued fraction `x(945 − 105x² + x⁴)/(945 − 420x² +
/// 15x⁴)`. Relative error < 1e-4 over the range (pole at π/2, outside it).
#[inline]
pub(crate) fn tan_fast(x: f32) -> f32 {
    let x2 = x * x;
    x * (945.0 - 105.0 * x2 + x2 * x2) / (945.0 - 420.0 * x2 + 15.0 * x2 * x2)
}

/// Cheap `tanh`: `x(27 + x²)/(27 + 9x²)` on `|x| <= 3`, ±1 beyond (smooth:
/// the slope reaches 0 at ±3). Within ~2.5% of `tanh`; used as a saturator.
#[inline]
pub(crate) fn tanh_fast(x: f32) -> f32 {
    let x = x.max(-3.0).min(3.0);
    let x2 = x * x;
    x * (27.0 + x2) / (27.0 + 9.0 * x2)
}

/// Soft saturator with headroom: unity slope at 0, bounded by ±3.
#[inline]
fn sat(v: f32) -> f32 {
    HEADROOM * tanh_fast(v * (1.0 / HEADROOM))
}

/// Output soft limiter (see the module docs). Non-finite in -> 0 out.
#[inline]
fn limit(y: f32) -> f32 {
    let a = y.abs();
    let y = if a <= OUT_KNEE {
        y
    } else {
        let room = OUT_CEIL - OUT_KNEE;
        (OUT_KNEE + room * tanh_fast((a - OUT_KNEE) / room)).copysign(y)
    };
    if y.is_finite() {
        y
    } else {
        0.0
    }
}

#[inline]
fn finite_or_zero(x: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

/// Per-sample coefficients for one cutoff/reso pair.
#[derive(Clone, Copy, Default)]
struct Coefs {
    /// SVF damping `k` and Simper's a1..a3.
    svf_k: f32,
    a1: f32,
    a2: f32,
    a3: f32,
    /// Ladder stage gain `G = g/(1+g)`, `1/(1+g)` and feedback `k`.
    lg: f32,
    linv: f32,
    lk: f32,
}

/// The filter module (see the module docs).
#[derive(Clone)]
pub struct Filter {
    inv_sr: f32,
    min_l2: f32,
    max_l2: f32,
    /// Current mode, and the mode fading out while `fade > 0`.
    mode: u8,
    prev: u8,
    /// Samples left in the mode crossfade (0 = none), of `fade_len`.
    fade: u32,
    fade_len: u32,
    /// log2 of the cutoff knob (Hz).
    cutoff: Smooth,
    reso: Smooth,
    cv_amt: Smooth,
    drive: Smooth,
    /// Ladder stage states per channel.
    ladder: [[f32; 4]; MAX_POLY],
    /// SVF integrator states (ic1eq, ic2eq) per channel.
    svf: [[f32; 2]; MAX_POLY],
    /// Channel count of the previous sub-block.
    channels: usize,
}

impl Filter {
    /// A silent filter at the catalog defaults.
    pub fn new(sr: f32) -> Filter {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        let min_l2 = MIN_HZ.log2();
        let mode = (default(K, MODE) as u8).min(NOTCH);
        Filter {
            inv_sr: 1.0 / sr,
            min_l2,
            // Never below min_l2, so the log-domain clamp can't invert.
            max_l2: (MAX_SR_FRACTION * sr).log2().max(min_l2),
            mode,
            prev: mode,
            fade: 0,
            fade_len: ((XFADE_SECONDS * sr).round() as u32).max(1),
            cutoff: Smooth::new(sr, default(K, CUTOFF).max(MIN_HZ).log2()),
            reso: Smooth::new(sr, default(K, RESO)),
            cv_amt: Smooth::new(sr, default(K, CV_AMT)),
            drive: Smooth::new(sr, default(K, DRIVE)),
            ladder: [[0.0; 4]; MAX_POLY],
            svf: [[0.0; 2]; MAX_POLY],
            channels: 0,
        }
    }

    /// Clear the filter states and any crossfade (params are kept).
    pub fn reset(&mut self) {
        self.ladder = [[0.0; 4]; MAX_POLY];
        self.svf = [[0.0; 2]; MAX_POLY];
        self.fade = 0;
        self.prev = self.mode;
    }

    /// Coefficients for log2 cutoff `l2` (unclamped) and resonance `reso`.
    #[inline]
    fn coefs(&self, l2: f32, reso: f32, svf: bool, ladder: bool) -> Coefs {
        let l2 = if l2.is_finite() { l2.max(self.min_l2).min(self.max_l2) } else { self.min_l2 };
        let pi_t = std::f32::consts::PI * self.inv_sr;
        let mut c = Coefs::default();
        if svf {
            let g = tan_fast(pi_t * l2.exp2());
            let k = 2.0 - 2.0 * reso * SVF_RESO_SCALE;
            c.svf_k = k;
            c.a1 = 1.0 / (1.0 + g * (g + k));
            c.a2 = g * c.a1;
            c.a3 = g * c.a2;
        }
        if ladder {
            let ll2 = (l2 + LADDER_OFFSET_OCT * (1.0 - reso)).min(self.max_l2);
            let g = tan_fast(pi_t * ll2.exp2());
            c.linv = 1.0 / (1.0 + g);
            c.lg = g * c.linv;
            c.lk = LADDER_K_MAX * reso;
        }
        c
    }

    /// Render one sub-block into `outs[0]`.
    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let Some(out) = outs.first_mut() else { return };
        let none = PortBuf::new();
        let inp = ins.first().unwrap_or(&none);
        let cv_in = ins.get(1).unwrap_or(&none);
        let channels = poly(&ins[..ins.len().min(2)]);
        out.channels = channels;
        // Channels that just went away restart from silence if they return.
        for ch in channels..self.channels.min(MAX_POLY) {
            self.ladder[ch] = [0.0; 4];
            self.svf[ch] = [0.0; 2];
        }
        self.channels = channels;

        // Mode switch: start a crossfade (one at a time).
        let want = param(params, K, MODE);
        let want = if want.is_finite() { (want.round().max(0.0) as u8).min(NOTCH) } else { self.mode };
        if self.fade == 0 && want != self.mode {
            if (want == LP24) != (self.mode == LP24) {
                // The incoming core was idle: start it from zero state.
                if want == LP24 {
                    self.ladder = [[0.0; 4]; MAX_POLY];
                } else {
                    self.svf = [[0.0; 2]; MAX_POLY];
                }
            }
            self.prev = self.mode;
            self.mode = want;
            self.fade = self.fade_len;
        }

        let cut_t = param(params, K, CUTOFF).max(MIN_HZ).log2();
        let (reso_t, amt_t, drive_t) = (param(params, K, RESO), param(params, K, CV_AMT), param(params, K, DRIVE));
        // A poly cv needs per-channel coefficients; a mono one is shared.
        let cv_poly = cv_in.channels > 1;

        for i in 0..RACK_BLOCK {
            let base = self.cutoff.next(cut_t);
            let reso = self.reso.next(reso_t).max(0.0).min(1.0);
            let amt = self.cv_amt.next(amt_t);
            let dgain = 1.0 + (DRIVE_GAIN_MAX - 1.0) * self.drive.next(drive_t).max(0.0).min(1.0);
            let out_gain = 1.0 / dgain.sqrt();

            let (mode, prev) = (self.mode, self.prev);
            let fading = self.fade > 0;
            // Weight of the outgoing mode (1 -> 0 over the crossfade).
            let w_old = self.fade as f32 / self.fade_len as f32;
            let need_ladder = mode == LP24 || (fading && prev == LP24);
            let need_svf = mode != LP24 || (fading && prev != LP24);
            let shared = if cv_poly {
                Coefs::default() // unused
            } else {
                // cv_in.get reads 0 when unconnected.
                self.coefs(base + finite_or_zero(cv_in.get(0, i)) * amt, reso, need_svf, need_ladder)
            };

            for ch in 0..channels {
                let c = if cv_poly {
                    self.coefs(base + finite_or_zero(cv_in.get(ch, i)) * amt, reso, need_svf, need_ladder)
                } else {
                    shared
                };
                let x = finite_or_zero(inp.get(ch, i)) * dgain;

                let mut lp24 = 0.0;
                if need_ladder {
                    let s = &mut self.ladder[ch];
                    let g = c.lg;
                    let g2 = g * g;
                    let g4 = g2 * g2;
                    // y4 = G⁴·x1 + S, with S from the stage states.
                    let sum = (((s[0] * g + s[1]) * g + s[2]) * g + s[3]) * c.linv;
                    let u = x * (1.0 + 0.5 * c.lk);
                    let est = (g4 * u + sum) / (1.0 + c.lk * g4);
                    let mut y = sat(u - c.lk * est);
                    for st in s.iter_mut() {
                        let v = (y - *st) * g;
                        let o = v + *st;
                        *st = o + v;
                        y = o;
                    }
                    lp24 = y;
                }
                let (mut v0, mut v1, mut v2) = (0.0, 0.0, 0.0);
                if need_svf {
                    let s = &mut self.svf[ch];
                    v0 = sat(x);
                    let v3 = v0 - s[1];
                    v1 = c.a1 * s[0] + c.a2 * v3;
                    v2 = s[1] + c.a2 * s[0] + c.a3 * v3;
                    s[0] = 2.0 * v1 - s[0];
                    s[1] = 2.0 * v2 - s[1];
                }
                let pick = |m: u8| match m {
                    LP24 => lp24,
                    LP12 => v2,
                    HP => v0 - c.svf_k * v1 - v2,
                    BP => c.svf_k * v1,
                    _ => v0 - c.svf_k * v1,
                };
                let y = if fading { pick(mode) * (1.0 - w_old) + pick(prev) * w_old } else { pick(mode) };
                out.data[ch][i] = limit(y * out_gain);
            }
            if self.fade > 0 {
                self.fade -= 1;
            }
        }

        // Denormal guard and defensive reset, once per sub-block.
        for ch in 0..channels {
            flush(&mut self.ladder[ch]);
            flush(&mut self.svf[ch]);
        }
    }
}

/// Zero states below `FLUSH`; zero them all if any is non-finite.
#[inline]
fn flush<const N: usize>(s: &mut [f32; N]) {
    if s.iter().any(|x| !x.is_finite()) {
        *s = [0.0; N];
        return;
    }
    for x in s.iter_mut() {
        if x.abs() < FLUSH {
            *x = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_PARAMS;

    const SR: f32 = 48000.0;

    fn params(mode: u8, cutoff: f32, reso: f32) -> [f32; MAX_PARAMS] {
        let mut p = [0.0f32; MAX_PARAMS];
        for (i, v) in p.iter_mut().enumerate().take(5) {
            *v = default(K, i);
        }
        p[MODE] = mode as f32;
        p[CUTOFF] = cutoff;
        p[RESO] = reso;
        p
    }

    fn blocks(seconds: f32) -> usize {
        (seconds * SR / RACK_BLOCK as f32).ceil() as usize
    }

    /// Gain in dB of a 0.5-amplitude sine at `hz` through a fresh filter (with
    /// a constant `cv`, or unconnected): 0.2 s warm-up (cutoff smoothing and
    /// the filter's own transient settle), then RMS(out)/RMS(in) over 0.3 s.
    fn gain_db(p: &[f32], hz: f32, cv: Option<f32>) -> f64 {
        let mut f = Filter::new(SR);
        let mut ins = [PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        if let Some(c) = cv {
            ins[1].channels = 1;
            ins[1].data[0] = [c; RACK_BLOCK];
        }
        let mut outs = [PortBuf::new()];
        let (warm, total) = (blocks(0.2), blocks(0.5));
        let inc = hz as f64 / SR as f64;
        let mut ph = 0.0f64;
        let (mut e_in, mut e_out) = (0.0f64, 0.0f64);
        for b in 0..total {
            for i in 0..RACK_BLOCK {
                ins[0].data[0][i] = (0.5 * (std::f64::consts::TAU * ph).sin()) as f32;
                ph = (ph + inc).fract();
            }
            f.process(p, &ins, &mut outs);
            if b >= warm {
                for i in 0..RACK_BLOCK {
                    e_in += (ins[0].data[0][i] as f64).powi(2);
                    e_out += (outs[0].data[0][i] as f64).powi(2);
                }
            }
        }
        10.0 * (e_out.max(1e-30) / e_in).log10()
    }

    /// Frequency (Hz) where the low-pass gain crosses -3 dB, by bisection in
    /// log-frequency between 20 Hz and 20 kHz.
    fn minus_3db_point(p: &[f32], cv: Option<f32>) -> f64 {
        let (mut lo, mut hi) = (20.0f64.ln(), 20000.0f64.ln());
        for _ in 0..16 {
            let mid = 0.5 * (lo + hi);
            if gain_db(p, mid.exp() as f32, cv) > -3.0 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        (0.5 * (lo + hi)).exp()
    }

    #[test]
    fn fast_tan_accurate_to_045_sr() {
        let max_x = 0.45 * std::f32::consts::PI;
        for i in 0..=1000 {
            let x = max_x * i as f32 / 1000.0;
            let (want, got) = (x.tan(), tan_fast(x));
            if want > 0.0 {
                assert!(((got - want) / want).abs() < 0.01, "tan({x}) = {want}, approx {got}");
            }
        }
    }

    #[test]
    fn lp24_response() {
        let p = params(LP24, 1000.0, 0.0);
        let (g250, g1k, g4k) = (gain_db(&p, 250.0, None), gain_db(&p, 1000.0, None), gain_db(&p, 4000.0, None));
        assert!(g250 > -1.5, "250 Hz: {g250} dB");
        assert!((-9.0..=-1.5).contains(&g1k), "1 kHz: {g1k} dB");
        assert!(g4k < -30.0, "4 kHz: {g4k} dB");
    }

    #[test]
    fn lp24_resonance_keeps_passband_level() {
        // Makeup gain (1 + k/2) keeps the passband from collapsing at reso 1
        // (a bare ladder loses 1/(1+k), about -14 dB).
        let g = gain_db(&params(LP24, 1000.0, 1.0), 100.0, None);
        assert!(g > -6.0, "100 Hz at reso 1: {g} dB");
        // And the resonant peak sits near the cutoff knob at high reso.
        let p = params(LP24, 1000.0, 0.9);
        let (peak, below, above) = (gain_db(&p, 1000.0, None), gain_db(&p, 700.0, None), gain_db(&p, 1400.0, None));
        assert!(peak > below && peak > above, "peak {peak}, 700 Hz {below}, 1.4 kHz {above}");
    }

    #[test]
    fn lp12_response() {
        let p = params(LP12, 1000.0, 0.0);
        let (g250, g4k) = (gain_db(&p, 250.0, None), gain_db(&p, 4000.0, None));
        assert!(g250 > -1.5, "250 Hz: {g250} dB");
        assert!(g4k < -18.0, "4 kHz: {g4k} dB");
    }

    #[test]
    fn hp_bp_notch_shapes() {
        let hp = params(HP, 1000.0, 0.0);
        let (pass, cut) = (gain_db(&hp, 4000.0, None), gain_db(&hp, 250.0, None));
        assert!(pass > -3.0, "HP 4 kHz: {pass} dB");
        assert!(cut < -18.0, "HP 250 Hz: {cut} dB");

        let bp = params(BP, 1000.0, 0.5);
        let at = gain_db(&bp, 1000.0, None);
        for hz in [250.0, 500.0, 2000.0, 4000.0] {
            let g = gain_db(&bp, hz, None);
            assert!(at > g + 3.0, "BP: {at} dB at 1 kHz vs {g} dB at {hz} Hz");
        }
        assert!(at.abs() < 1.0, "BP peak is unity: {at} dB");

        let notch = gain_db(&params(NOTCH, 1000.0, 0.2), 1000.0, None);
        assert!(notch < -20.0, "notch at cutoff: {notch} dB");
        let side = gain_db(&params(NOTCH, 1000.0, 0.2), 250.0, None);
        assert!(side > -3.0, "notch 250 Hz: {side} dB");
    }

    #[test]
    fn filter_stable_at_extremes() {
        let mut ins = [PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        let mut outs = [PortBuf::new()];
        for mode in [LP24, LP12, HP, BP, NOTCH] {
            for cutoff in [20000.0, 20.0] {
                let mut p = params(mode, cutoff, 1.0);
                p[DRIVE] = 1.0;
                let mut f = Filter::new(SR);
                let mut x = 0x1234_5678u32;
                let mut peak = 0.0f32;
                for b in 0..blocks(2.0) {
                    // Full-scale white noise plus a +1 DC step after 0.5 s.
                    let dc = if b >= blocks(0.5) { 1.0 } else { 0.0 };
                    for i in 0..RACK_BLOCK {
                        x ^= x << 13;
                        x ^= x >> 17;
                        x ^= x << 5;
                        ins[0].data[0][i] = (x >> 8) as f32 * (2.0 / 16_777_216.0) - 1.0 + dc;
                    }
                    f.process(&p, &ins, &mut outs);
                    for &y in &outs[0].data[0] {
                        assert!(y.is_finite(), "mode {mode} cutoff {cutoff}: {y}");
                        peak = peak.max(y.abs());
                    }
                    // The cores themselves stay bounded, not just the limited
                    // output: the SVF at Q 20 legitimately rings to ~66 here
                    // (±3 saturated noise × 20 peak gain), the ladder to ~11.
                    for &s in f.ladder[0].iter().chain(f.svf[0].iter()) {
                        assert!(s.is_finite() && s.abs() < 100.0, "mode {mode} cutoff {cutoff}: state {s}");
                    }
                }
                assert!(peak < 4.0, "mode {mode} cutoff {cutoff}: peak {peak}");
            }
        }
    }

    #[test]
    fn filter_survives_garbage_inputs() {
        let mut f = Filter::new(SR);
        let mut ins = [PortBuf::new(), PortBuf::new()];
        ins[0].channels = 4;
        ins[1].channels = 4;
        let vals = [f32::NAN, f32::INFINITY, -1e30, 1.0];
        for ch in 0..4 {
            ins[0].data[ch] = [vals[ch]; RACK_BLOCK];
            ins[1].data[ch] = [vals[3 - ch]; RACK_BLOCK];
        }
        let mut outs = [PortBuf::new()];
        for mode in 0..5u8 {
            let mut p = params(mode, 20000.0, 1.0);
            p[CV_AMT] = 8.0;
            p[DRIVE] = 1.0;
            for _ in 0..20 {
                f.process(&p, &ins, &mut outs);
                assert_eq!(outs[0].channels, 4);
                assert!(outs[0].data[..4].iter().flatten().all(|y| y.is_finite() && y.abs() < 4.0));
            }
        }
        // Short slices are tolerated.
        f.process(&[], &ins[..1], &mut outs);
        f.process(&[], &[], &mut []);
    }

    #[test]
    fn cv_moves_cutoff_by_octaves() {
        for mode in [LP24, LP12] {
            let mut p = params(mode, 500.0, 0.0);
            p[CV_AMT] = 1.0;
            let base = minus_3db_point(&p, Some(0.0));
            let up = minus_3db_point(&p, Some(1.0));
            let ratio = up / base;
            assert!((ratio - 2.0).abs() < 0.3, "mode {mode}: {base} Hz -> {up} Hz (x{ratio})");
            // cv_amt scales: cv 0.5 at 2 oct/V is also one octave; -1 halves.
            p[CV_AMT] = 2.0;
            let r2 = minus_3db_point(&p, Some(0.5)) / base;
            assert!((r2 - 2.0).abs() < 0.3, "mode {mode}: x{r2}");
            p[CV_AMT] = -1.0;
            let r3 = minus_3db_point(&p, Some(1.0)) / base;
            assert!((r3 - 0.5).abs() < 0.075, "mode {mode}: x{r3}");
        }
    }

    #[test]
    fn lp24_self_oscillates_bounded() {
        let p = params(LP24, 1000.0, 1.0);
        let mut f = Filter::new(SR);
        let mut ins = [PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        let mut outs = [PortBuf::new()];
        let mut tail = Vec::new();
        let n = blocks(1.5);
        for b in 0..n {
            // A short noise burst to start it, then silence.
            for i in 0..RACK_BLOCK {
                ins[0].data[0][i] = if b < 2 { ((i * 7919 + b * 31) % 17) as f32 / 8.0 - 1.0 } else { 0.0 };
            }
            f.process(&p, &ins, &mut outs);
            if b >= n - blocks(0.25) {
                tail.extend_from_slice(&outs[0].data[0]);
            }
        }
        let rms = (tail.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / tail.len() as f64).sqrt();
        let peak = tail.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(rms > 0.05, "self-oscillation rms {rms}");
        assert!(peak < 4.0, "peak {peak}");
        let crossings = tail.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count() as f64 / 0.25;
        assert!((crossings - 1000.0).abs() < 100.0, "oscillates at {crossings} Hz");
    }

    #[test]
    fn mode_switch_is_click_free() {
        // A 300 Hz sine through every mode transition: a hard switch would step
        // the output (e.g. LP passes it, HP blocks it); the 2 ms crossfade keeps
        // sample-to-sample jumps near the sine's own slope (~0.04 at 1.0 amp).
        let mut f = Filter::new(SR);
        let mut ins = [PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        let mut outs = [PortBuf::new()];
        let mut p = params(LP24, 1000.0, 0.2);
        let inc = 300.0 / SR as f64;
        let mut ph = 0.0f64;
        let mut last = 0.0f32;
        let mut jump = 0.0f32;
        let seq = [LP24, HP, LP12, NOTCH, BP, LP24, BP, HP, LP24];
        for (k, &mode) in seq.iter().enumerate() {
            p[MODE] = mode as f32;
            for b in 0..blocks(0.1) {
                for i in 0..RACK_BLOCK {
                    ins[0].data[0][i] = (std::f64::consts::TAU * ph).sin() as f32;
                    ph = (ph + inc).fract();
                }
                f.process(&p, &ins, &mut outs);
                for &y in &outs[0].data[0] {
                    if k > 0 || b > blocks(0.05) {
                        jump = jump.max((y - last).abs());
                    }
                    last = y;
                }
            }
        }
        assert!(jump < 0.08, "max step {jump}");
    }

    #[test]
    fn channels_follow_inputs_and_stale_state_clears() {
        let mut f = Filter::new(SR);
        let p = params(LP24, 1000.0, 0.5);
        let mut ins = [PortBuf::new(), PortBuf::new()];
        let mut outs = [PortBuf::new()];
        f.process(&p, &ins, &mut outs);
        assert_eq!(outs[0].channels, 1, "unconnected -> 1 silent channel");
        assert!(outs[0].data[0].iter().all(|&y| y == 0.0));
        ins[0].channels = 4;
        for ch in 0..4 {
            ins[0].data[ch] = [0.5 + 0.1 * ch as f32; RACK_BLOCK];
        }
        for _ in 0..50 {
            f.process(&p, &ins, &mut outs);
        }
        assert_eq!(outs[0].channels, 4);
        assert!(outs[0].data[3][RACK_BLOCK - 1].abs() > 0.1);
        // A mono input with a poly cv: one filter per cv channel (poly rule).
        ins[0].channels = 1;
        ins[1].channels = 6;
        f.process(&p, &ins, &mut outs);
        assert_eq!(outs[0].channels, 6);
        // Dropping to 1 channel clears channels 1.. so they restart silent.
        ins[1].channels = 0;
        f.process(&p, &ins, &mut outs);
        ins[0].channels = 4;
        ins[0].data = [[0.0; RACK_BLOCK]; MAX_POLY];
        f.process(&p, &ins, &mut outs);
        for ch in 1..4 {
            assert!(outs[0].data[ch].iter().all(|&y| y == 0.0), "ch {ch} restarted from stale state");
        }
    }

    /// One period (400 samples = 120 Hz at 48 kHz) of a band-limited saw
    /// of peak-ish amplitude `amp`: `amp·(2/π)·Σ (−1)^(n+1) sin(nωt)/n` over the
    /// harmonics below 20 kHz.
    fn saw_period(amp: f32) -> Vec<f32> {
        (0..400)
            .map(|t| {
                let mut acc = 0.0f64;
                for n in 1..=166 {
                    let sign = if n % 2 == 1 { 1.0 } else { -1.0 };
                    acc += sign * (std::f64::consts::TAU * n as f64 * t as f64 / 400.0).sin() / n as f64;
                }
                (amp as f64 * 2.0 / std::f64::consts::PI * acc) as f32
            })
            .collect()
    }

    /// Amplitude of harmonic `n` of a 400-sample-periodic signal (single-bin
    /// DFT over a whole number of periods).
    fn harmonic(x: &[f32], n: usize) -> f64 {
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for (t, &s) in x.iter().enumerate() {
            let a = std::f64::consts::TAU * n as f64 * t as f64 / 400.0;
            re += s as f64 * a.cos();
            im += s as f64 * a.sin();
        }
        2.0 * (re * re + im * im).sqrt() / x.len() as f64
    }

    /// LP24 output for the 120 Hz saw (after 0.3 s), 0.25 s = 30 periods.
    fn lp24_saw(amp: f32, cutoff: f32, reso: f32) -> (Vec<f32>, Vec<f32>) {
        let mut p = params(LP24, cutoff, reso);
        p[DRIVE] = 0.0;
        let period = saw_period(amp);
        let mut f = Filter::new(SR);
        let mut ins = [PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        let mut outs = [PortBuf::new()];
        let (warm, total) = (blocks(0.3), blocks(0.3) + 375); // 375 blocks = 12000 = 30 periods
        let (mut x, mut y) = (Vec::new(), Vec::new());
        let mut t = 0usize;
        for b in 0..total {
            for i in 0..RACK_BLOCK {
                ins[0].data[0][i] = period[t % 400];
                t += 1;
            }
            f.process(&p, &ins, &mut outs);
            if b >= warm {
                x.extend_from_slice(&ins[0].data[0]);
                y.extend_from_slice(&outs[0].data[0]);
            }
        }
        // Align the analysis window to whole periods.
        let skip = (400 - (warm * RACK_BLOCK) % 400) % 400;
        let n = (x.len() - skip) / 400 * 400;
        (x[skip..skip + n].to_vec(), y[skip..skip + n].to_vec())
    }

    /// The linear ladder's gain at `hz` (exact for the TPT design: each stage
    /// is the prewarped analog one-pole `g/(g + j·tan(πf/sr))`; with makeup
    /// `1 + k/2` and feedback `k`).
    fn lp24_linear_gain(cutoff: f32, reso: f32, hz: f64) -> f64 {
        let fl = (cutoff as f64 * 2f64.powf((LADDER_OFFSET_OCT * (1.0 - reso)) as f64)).min(0.45 * SR as f64);
        let g = (std::f64::consts::PI * fl / SR as f64).tan();
        let t = (std::f64::consts::PI * hz / SR as f64).tan();
        let k = (LADDER_K_MAX * reso) as f64;
        // h = g/(g + jt); h⁴ as (re, im).
        let d = g * g + t * t;
        let (hr, hi) = (g * g / d, -g * t / d);
        let (h2r, h2i) = (hr * hr - hi * hi, 2.0 * hr * hi);
        let (h4r, h4i) = (h2r * h2r - h2i * h2i, 2.0 * h2r * h2i);
        let (nr, ni) = ((1.0 + k / 2.0) * h4r, (1.0 + k / 2.0) * h4i);
        let (dr, di) = (1.0 + k * h4r, k * h4i);
        ((nr * nr + ni * ni) / (dr * dr + di * di)).sqrt()
    }

    #[test]
    fn lp24_resonance_compresses_with_level() {
        // Ruling R10: in-loop saturation compresses the resonant peak of a
        // loud signal (analog-ladder character), even at drive 0. Cutoff 960 Hz
        // puts the reso-0.9 peak on the saw's 8th harmonic.
        let peak_gain = |amp: f32| {
            let (x, y) = lp24_saw(amp, 960.0, 0.9);
            20.0 * (harmonic(&y, 8) / harmonic(&x, 8)).log10()
        };
        let (quiet, loud) = (peak_gain(0.1), peak_gain(1.0));
        assert!(quiet > loud + 3.0, "resonant peak gain: -20 dBFS {quiet:.2} dB vs 0 dBFS {loud:.2} dB");
        // The quiet one is close to the linear filter's peak.
        let lin = 20.0 * lp24_linear_gain(960.0, 0.9, 960.0).log10();
        assert!((quiet - lin).abs() < 0.5, "quiet {quiet:.2} dB vs linear {lin:.2} dB");

        // At low resonance and low level the ladder is linear (within 0.5 dB)
        // across the spectrum: fundamental, near cutoff, and above it.
        let (x, y) = lp24_saw(0.1, 960.0, 0.3);
        for n in [1usize, 4, 8, 16] {
            let got = 20.0 * (harmonic(&y, n) / harmonic(&x, n)).log10();
            let want = 20.0 * lp24_linear_gain(960.0, 0.3, 120.0 * n as f64).log10();
            assert!((got - want).abs() < 0.5, "harmonic {n}: {got:.2} dB vs linear {want:.2} dB");
        }
    }

    #[test]
    fn lp24_never_hits_the_limiter() {
        // A full-scale (naive, so worst-case edges) 55 Hz saw with the cutoff
        // swept 100 Hz -> 12.8 kHz over 1 s: the ladder's own loop saturation
        // keeps the output below the limiter's knee (2.0), at drive 0 and 1.
        let mut ins = [PortBuf::new(), PortBuf::new()];
        ins[0].channels = 1;
        let mut outs = [PortBuf::new()];
        for drive in [0.0f32, 1.0] {
            for reso in [0.3f32, 0.5, 0.7, 0.9] {
                let mut p = params(LP24, 100.0, reso);
                p[DRIVE] = drive;
                let mut f = Filter::new(SR);
                let (mut ph, inc) = (0.0f64, 55.0 / SR as f64);
                let mut peak = 0.0f32;
                let n = blocks(1.0);
                for b in 0..n + blocks(0.1) {
                    // 7 octaves over 1 s, then hold at the top.
                    p[CUTOFF] = 100.0 * 2f32.powf(7.0 * (b.min(n) as f32 / n as f32));
                    for i in 0..RACK_BLOCK {
                        ins[0].data[0][i] = (2.0 * ph - 1.0) as f32;
                        ph = (ph + inc).fract();
                    }
                    f.process(&p, &ins, &mut outs);
                    peak = outs[0].data[0].iter().fold(peak, |m, s| m.max(s.abs()));
                }
                assert!(peak < OUT_KNEE, "drive {drive} reso {reso}: peak {peak}");
            }
        }
    }
}
