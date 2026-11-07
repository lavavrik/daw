//! Delay: a tempo-synced stereo delay, 100% wet, with feedback, ping-pong
//! and a high-cut in the feedback path.
//!
//! * **Time** = `beats × 60 / bpm` seconds (`beats` in quarter notes: 1/4 note
//!   = 1, 3/16 = 0.75), clamped to 1 sample..[`MAX_SECONDS`]. Rings are
//!   allocated once for 2 s at the construction sample rate.
//! * **Time changes crossfade.** The delay reads through one head; when the
//!   target time moves, a second head starts at the new time and the output
//!   crossfades linearly over [`XFADE_SECONDS`]. Each head's signal is
//!   continuous, so the output is too (no zipper, no pitch warble). A change
//!   during a fade is picked up when that fade ends.
//! * **Feedback path:** `write = input + sat(fb · lp(read))`, where `lp` is a
//!   one-pole high-cut (1..20 kHz, coefficient updated per [`SUB_BLOCK`]) and
//!   `sat` is linear up to ±1 and soft-limits towards ±2.5. With feedback up
//!   to 0.95 a resonant input could otherwise build up 20× (1/(1−0.95)); the
//!   saturator keeps the tail bounded by `|input| + 2.5` and only colours
//!   tails already above full scale.
//! * **Ping-pong:** the mono sum `(L+R)/2` enters the left line only and the
//!   feedback crosses over (L→R→L…). Switching ping-pong morphs the routing
//!   with a 5 ms glide instead of switching, so the written signal stays
//!   continuous. The first echo is the unfiltered input; each repeat passes
//!   the high-cut once more.

use super::{clampf, finite, flush, valid_sr, Glide, SMOOTH_SECONDS, SUB_BLOCK};
use crate::rack::modules::Smooth;

/// Longest delay time (seconds).
pub const MAX_SECONDS: f32 = 2.0;
/// Crossfade time for delay-time changes (seconds).
pub const XFADE_SECONDS: f32 = 0.05;
/// Feedback saturator: linear up to `SAT_KNEE`, approaching `SAT_CEIL`.
const SAT_KNEE: f32 = 1.0;
const SAT_CEIL: f32 = 2.5;

/// Tempo-synced stereo delay (see the module docs).
#[derive(Clone, Debug)]
pub struct Delay {
    sr: f32,
    beats: f32,
    bpm: f32,
    feedback: f32,
    ping_pong: bool,
    high_cut: f32,
    /// Rings: left `buf[0..cap]`, right `buf[cap..2cap]`.
    buf: Vec<f32>,
    cap: usize,
    pos: usize,
    /// Current head time, and the incoming head's time during a fade
    /// (samples).
    time: f32,
    next_time: f32,
    /// Crossfade progress 0..1 (`None`-like when `fading` is false).
    fade: f32,
    fading: bool,
    fade_step: f32,
    fb_s: Smooth,
    pp_s: Smooth,
    cut_s: Glide,
    /// High-cut one-pole coefficient and states (L, R).
    lp_a: f32,
    lp: [f32; 2],
    fresh: bool,
}

impl Delay {
    /// A delay at the mixer defaults: 3/16 note at 120 BPM, feedback 0.35,
    /// ping-pong on, high-cut 6 kHz. Allocates 2 s of stereo ring at `sr`.
    pub fn new(sr: f32) -> Delay {
        let sr = valid_sr(sr);
        let cap = ((MAX_SECONDS * sr).ceil() as usize + 4).next_power_of_two();
        let mut d = Delay {
            sr,
            beats: 0.75,
            bpm: 120.0,
            feedback: 0.35,
            ping_pong: true,
            high_cut: 6000.0,
            buf: vec![0.0; 2 * cap],
            cap,
            pos: 0,
            time: 1.0,
            next_time: 1.0,
            fade: 0.0,
            fading: false,
            fade_step: 1.0 / (XFADE_SECONDS * sr),
            fb_s: Smooth::new(sr, 0.35),
            pp_s: Smooth::new(sr, 1.0),
            cut_s: Glide::new(6000f32.log2(), SMOOTH_SECONDS, sr / SUB_BLOCK as f32, 1e-4),
            lp_a: 0.0,
            lp: [0.0; 2],
            fresh: true,
        };
        d.time = d.target_time();
        d.next_time = d.time;
        d
    }

    /// Delay time as a note length in quarter-note beats (1/4 = 1, 3/16 =
    /// 0.75, 1/8 dotted = 0.75, …), > 0.
    pub fn set_time_beats(&mut self, beats: f32) {
        if beats.is_finite() && beats > 0.0 {
            self.beats = beats.min(64.0);
        }
    }

    /// Tempo (BPM), > 0.
    pub fn set_tempo(&mut self, bpm: f32) {
        if bpm.is_finite() && bpm > 0.0 {
            self.bpm = clampf(bpm, 1.0, 999.0);
        }
    }

    /// Feedback, 0..0.95.
    pub fn set_feedback(&mut self, fb: f32) {
        if fb.is_finite() {
            self.feedback = clampf(fb, 0.0, 0.95);
        }
    }

    /// Ping-pong on/off.
    pub fn set_ping_pong(&mut self, on: bool) {
        self.ping_pong = on;
    }

    /// Feedback-path high-cut, 1..20 kHz (capped at 0.45·sr).
    pub fn set_high_cut(&mut self, hz: f32) {
        if hz.is_finite() {
            self.high_cut = clampf(hz, 1000.0, 20000.0);
        }
    }

    /// The delay time the settings ask for, in samples (clamped to the ring).
    fn target_time(&self) -> f32 {
        let t = self.beats * 60.0 / self.bpm * self.sr;
        clampf(t, 1.0, (self.cap - 3) as f32).min(MAX_SECONDS * self.sr)
    }

    /// Silence the tail and jump to the targets (no allocation).
    pub fn reset(&mut self) {
        self.buf.fill(0.0);
        self.lp = [0.0; 2];
        self.fresh = true;
    }

    /// Process a stereo block in place: the input is replaced by the wet
    /// signal.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        let target = self.target_time();
        let pp_target = if self.ping_pong { 1.0 } else { 0.0 };
        let cut_target = self.high_cut.min(0.45 * self.sr).log2();
        if self.fresh {
            self.fresh = false;
            self.time = target;
            self.next_time = target;
            self.fading = false;
            self.fb_s = Smooth::new(self.sr, self.feedback);
            self.pp_s = Smooth::new(self.sr, pp_target);
            self.cut_s.value = cut_target;
            self.update_cut();
        }
        let mask = self.cap - 1;
        let mut start = 0;
        while start < n {
            let end = (start + SUB_BLOCK).min(n);
            if self.cut_s.step(cut_target) {
                self.update_cut();
            }
            // Start a crossfade to the new time (a change during a fade waits
            // for it to finish).
            if !self.fading && (target - self.time).abs() > 1e-3 {
                self.next_time = target;
                self.fade = 0.0;
                self.fading = true;
            }
            for i in start..end {
                let (xl, xr) = (finite(l[i]), finite(r[i]));
                let (bl, br) = self.buf.split_at(self.cap);
                let mut yl = read(bl, self.pos, self.time, mask);
                let mut yr = read(br, self.pos, self.time, mask);
                if self.fading {
                    let (nl, nr) = (read(bl, self.pos, self.next_time, mask), read(br, self.pos, self.next_time, mask));
                    yl += (nl - yl) * self.fade;
                    yr += (nr - yr) * self.fade;
                    self.fade += self.fade_step;
                    if self.fade >= 1.0 {
                        self.time = self.next_time;
                        self.fading = false;
                    }
                }
                let fb = self.fb_s.next(self.feedback);
                let pp = self.pp_s.next(pp_target);
                // High-cut in the feedback path, then feedback gain and the
                // saturator.
                let a = self.lp_a;
                self.lp[0] = flush(yl + a * (self.lp[0] - yl));
                self.lp[1] = flush(yr + a * (self.lp[1] - yr));
                let (fl, fr) = (sat(fb * self.lp[0]), sat(fb * self.lp[1]));
                // Straight: L→L, R→R. Ping-pong: mono in → L, L→R→L.
                let mono = 0.5 * (xl + xr);
                let wl = (xl + fl) + pp * ((mono + fr) - (xl + fl));
                let wr = (xr + fr) + pp * (fl - (xr + fr));
                self.buf[self.pos] = flush(wl);
                self.buf[self.cap + self.pos] = flush(wr);
                self.pos = (self.pos + 1) & mask;
                l[i] = finite(yl);
                r[i] = finite(yr);
            }
            start = end;
        }
    }

    /// High-cut coefficient from the gliding cutoff: `a = exp(−2π·fc/sr)`.
    fn update_cut(&mut self) {
        self.lp_a = (-2.0 * std::f32::consts::PI * self.cut_s.value.exp2() / self.sr).exp();
    }
}

/// Feedback saturator: identity up to ±[`SAT_KNEE`], then a soft approach
/// to ±[`SAT_CEIL`] (continuous slope 1 at the knee).
#[inline]
fn sat(x: f32) -> f32 {
    let a = x.abs();
    if a <= SAT_KNEE {
        x
    } else {
        let room = SAT_CEIL - SAT_KNEE;
        (SAT_KNEE + room * crate::rack::modules::filter::tanh_fast((a - SAT_KNEE) / room)).copysign(x)
    }
}

/// Read `ring` (power-of-two length, `mask = len − 1`) `delay` samples behind
/// the write position `pos`, linearly interpolated (exact for whole-sample
/// delays). `delay ≥ 1`, so the slot about to be written is never read.
#[inline]
fn read(ring: &[f32], pos: usize, delay: f32, mask: usize) -> f32 {
    let whole = delay as usize;
    let frac = delay - whole as f32;
    let a = ring[pos.wrapping_sub(whole) & mask];
    if frac == 0.0 {
        a
    } else {
        let b = ring[pos.wrapping_sub(whole + 1) & mask];
        a + (b - a) * frac
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_util::Noise;
    use super::*;

    fn run(d: &mut Delay, n: usize, mut input: impl FnMut(usize) -> (f32, f32)) -> (Vec<f32>, Vec<f32>) {
        let (mut ls, mut rs) = (Vec::with_capacity(n), Vec::with_capacity(n));
        let mut i = 0;
        while i < n {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            for k in 0..128 {
                (l[k], r[k]) = input(i + k);
            }
            d.process(&mut l, &mut r);
            ls.extend_from_slice(&l);
            rs.extend_from_slice(&r);
            i += 128;
        }
        (ls, rs)
    }

    #[test]
    fn delay_echo_timing() {
        for pp in [false, true] {
            let mut d = Delay::new(48000.0);
            d.set_time_beats(1.0);
            d.set_tempo(120.0);
            d.set_ping_pong(pp);
            let (l, r) = run(&mut d, 30000, |i| if i == 0 { (1.0, 1.0) } else { (0.0, 0.0) });
            let first = l.iter().position(|v| v.abs() > 1e-3).unwrap();
            assert!((first as i64 - 24000).abs() <= 1, "pp {pp}: echo at {first}");
            if pp {
                assert!(r.iter().all(|v| v.abs() < 1e-6), "ping-pong: first echo is left only");
            } else {
                assert_eq!(r.iter().position(|v| v.abs() > 1e-3), Some(first));
            }
        }
    }

    #[test]
    fn delay_ping_pong_alternates() {
        let mut d = Delay::new(48000.0);
        d.set_time_beats(0.5);
        d.set_tempo(120.0); // 12000 samples
        d.set_feedback(0.5);
        let (l, r) = run(&mut d, 40000, |i| if i == 0 { (1.0, 1.0) } else { (0.0, 0.0) });
        assert!(l[12000] > 0.5 && r[12000].abs() < 1e-6);
        assert!(r[24000..24010].iter().any(|v| v.abs() > 0.1) && l[24000..24010].iter().all(|v| v.abs() < 1e-3));
        assert!(l[36000..36010].iter().any(|v| v.abs() > 0.05));
    }

    #[test]
    fn delay_feedback_bounded() {
        let mut d = Delay::new(48000.0);
        d.set_feedback(0.95);
        d.set_high_cut(20000.0);
        d.set_ping_pong(false);
        d.set_time_beats(0.25);
        d.set_tempo(120.0);
        // 30 s of full-scale noise plus a sine coherent with the delay time
        // (the comb's worst case).
        let mut noise = Noise::new(11);
        let period = 6000.0 / 4.0;
        let (l, r) = run(&mut d, 30 * 48000, |i| {
            let s = (2.0 * std::f32::consts::PI * i as f32 / period).sin();
            (0.5 * noise.next() + 0.5 * s, s)
        });
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |p, v| {
            assert!(v.is_finite());
            p.max(v.abs())
        });
        assert!(peak < 4.0, "peak {peak}");
    }

    #[test]
    fn delay_time_change_is_smooth() {
        let mut d = Delay::new(48000.0);
        d.set_time_beats(0.75);
        d.set_tempo(120.0);
        d.set_feedback(0.8);
        d.set_ping_pong(false);
        let mut prev = (0.0f32, 0.0f32);
        let mut max_step = 0.0f32;
        let mut tail = 0.0f32;
        let mut i = 0usize;
        // 0.5 s of a 0.5-amplitude 110 Hz sine, then silence; tempo jumps
        // twice mid-tail.
        for blk in 0..1500 {
            if blk == 400 {
                d.set_tempo(97.0);
            }
            if blk == 403 {
                d.set_tempo(160.0); // during the first fade
            }
            let mut l = [0.0f32; 128];
            for (k, v) in l.iter_mut().enumerate() {
                if i + k < 24000 {
                    *v = 0.5 * (2.0 * std::f32::consts::PI * 110.0 * (i + k) as f32 / 48000.0).sin();
                }
            }
            let mut r = l;
            d.process(&mut l, &mut r);
            for k in 0..128 {
                max_step = max_step.max((l[k] - prev.0).abs()).max((r[k] - prev.1).abs());
                prev = (l[k], r[k]);
                if blk >= 400 {
                    tail = tail.max(l[k].abs());
                }
            }
            i += 128;
        }
        assert!(tail > 0.1, "the change happened mid-tail");
        assert!(max_step < 0.1, "max step {max_step}");
        // Settled on the new time.
        assert!((d.time - 0.75 * 60.0 / 160.0 * 48000.0).abs() < 1e-3);
    }

    #[test]
    fn delay_high_cut_darkens_repeats() {
        // Second repeat of a 10 kHz burst through a 1 kHz high-cut is much
        // quieter than the (unfiltered) first.
        let mut d = Delay::new(48000.0);
        d.set_time_beats(0.25);
        d.set_tempo(120.0); // 6000 samples
        d.set_feedback(0.9);
        d.set_ping_pong(false);
        d.set_high_cut(1000.0);
        let (l, _) = run(&mut d, 20000, |i| {
            let s = if i < 1000 { (2.0 * std::f32::consts::PI * 10000.0 * i as f32 / 48000.0).sin() } else { 0.0 };
            (s, s)
        });
        let pk = |a: usize| l[a..a + 1000].iter().fold(0.0f32, |p, v| p.max(v.abs()));
        assert!(pk(6000) > 0.9);
        assert!(pk(12000) < 0.2 * pk(6000), "{} vs {}", pk(12000), pk(6000));
    }

    #[test]
    fn delay_sizes_from_sample_rate_and_survives_garbage() {
        let mut d = Delay::new(96000.0);
        assert!(d.cap >= 192000);
        d.set_time_beats(16.0);
        d.set_tempo(20.0); // 48 s requested: clamped to 2 s
        d.set_feedback(f32::NAN);
        d.set_high_cut(f32::INFINITY);
        let (l, r) = run(&mut d, 4096, |i| if i % 3 == 0 { (f32::NAN, f32::INFINITY) } else { (1e30, -1e30) });
        assert!(l.iter().chain(r.iter()).all(|v| v.is_finite()));
        assert!(d.target_time() <= 2.0 * 96000.0);
    }
}
