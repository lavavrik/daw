//! Sample Player: plays a sample-pool sample (the project's samples, the
//! ones drum rows use), one voice per channel.
//!
//! * **Voices.** Channels follow the `pitch`/`gate` inputs (poly, like the
//!   ADSR): channel `ch` of `gate` drives voice `ch`, and `out` carries one
//!   mono channel per voice (a stereo sample is played as `(L + R) / 2`).
//! * **Trigger.** A rising gate (`>= 0.5`) starts the voice at
//!   `s = floor(start · frames)` (at most the last frame) of sample `sample`
//!   (`-1` = none); `start` is read at the trigger only. Loop off it is a
//!   one-shot: what the gate does next does not matter (put an ADSR and VCA
//!   after it for gated notes); loop on, the gate also ends the loop (below). A gate with no playable sample (none, not loaded yet)
//!   starts nothing.
//! * **Region** (`end`, `loop`, `loopStart`, read live every sample, so
//!   moving a marker or automating it acts on sounding voices, while
//!   `start` is read at the trigger only and stays the voice's low edge). The voice
//!   plays `[s, e)` with `e = max(floor(end · frames), s + 1)` clamped to
//!   `frames`, so `start ≥ end` still plays one frame and nothing is ever
//!   read outside the sample. Loop off: at `e` the voice holds its last
//!   output and fades it to 0 over 2 ms (the declick fade below), then ends.
//! * **Loop** (a sustain loop). With `loop` on, the loop region is
//!   `[ls, e)`, `ls = max(floor(loopStart · frames), s)`. The voice plays
//!   from `s` into it and repeats it **while its gate is high**; when the
//!   gate falls it stops looping, plays on from where it is to `e` and stops
//!   there with the 2 ms fade, so a looping voice always ends (the ADSR/VCA
//!   after it shapes the release meanwhile; at rate 1 that is at most
//!   `e − ls` frames). A retrigger works as for any voice. A gate that falls
//!   (or `loop` that goes off) during a seam crossfade lets that seam finish
//!   first (one last wrap), so a release never cuts a crossfade short.
//!   The seam has a fixed 10 ms (`xf` frames) equal-power crossfade that
//!   needs no material outside the region: over the last `xf` frames of the
//!   region the tail fades out (`cos`) while the head `[ls, ls + xf)` fades
//!   in (`sin`), and at `e` the read jumps to `ls + xf`, where the head left
//!   off. So after the first pass a loop lasts `e − ls − xf` frames (the
//!   head is heard only inside the crossfade). A loop region shorter than
//!   `2 · xf` is treated as loop off. A rate that jumps past `e` (or a live
//!   `end` moved below the position) wraps modulo the loop length, so the
//!   position stays inside the region at any pitch.
//! * **Pitch.** The playback rate is `2^(pitch − (root − 60)/12 + fine/1200)`
//!   with `pitchTrack` on (pitch in V/oct, 0 = C4 = MIDI 60, read per
//!   sample, so bends and glides follow; `root` is the note at which the
//!   sample plays at its own speed) and `2^(fine/1200)` with it off; the
//!   exponent is clamped to ±11 octaves. Positions between frames are read
//!   with 4-point, 3rd-order Hermite (Catmull-Rom) interpolation, the four
//!   points clamped to `[s, e)` (on whole frames it returns the frame
//!   exactly).
//! * **Declicking** (as the drum voices, `drums.rs`): each channel has an
//!   active and a fading voice. A retrigger moves the sounding voice to the
//!   fading slot, which ramps to 0 over 2 ms, and starts the new one at full
//!   level (the attack is the sample's own).
//! * **Replaced / reset samples.** A voice captures the sample's generation
//!   (`samples.rs`) when it starts. If the pool stops reporting that
//!   generation (the sample was replaced, un-readied, or cleared by
//!   `OP_RESET_ALL`), the voice never reads the slot again: it holds its last
//!   output and fades it to 0 over 2 ms. This holds for looping voices too.
//! * `gain` (0..2) is smoothed per sample; `sample`, `pitchTrack`, `root`
//!   and `loop` are integer params, declicked by the rack; `start`, `end`,
//!   `loopStart` and `fine` are not smoothed (a jump moves a read position
//!   or a rate, never the output level).

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::{poly, PortBuf};
use crate::samples::SampleView;
use crate::{MAX_POLY, RACK_BLOCK};

const K: ModuleKind = ModuleKind::SamplePlayer;
const SAMPLE: usize = 0;
const GAIN: usize = 1;
const START: usize = 2;
const PITCH_TRACK: usize = 3;
const ROOT: usize = 4;
const END: usize = 5;
const LOOP: usize = 6;
const LOOP_START: usize = 7;
const FINE: usize = 8;

/// Rate exponent limit (octaves): beyond ±11 a voice is either over in a few
/// samples or inaudibly slow.
const MAX_OCTAVES: f32 = 11.0;
/// Declick fade length (seconds).
const FADE_SECONDS: f32 = 0.002;
/// Loop seam crossfade length (seconds).
const XFADE_SECONDS: f32 = 0.010;

/// The live region params (fractions of the sample) plus the crossfade
/// length in frames; resolved per voice by `Voice::read`.
#[derive(Clone, Copy, Debug)]
struct Region {
    end: f64,
    looping: bool,
    loop_start: f64,
    xfade: f64,
}

/// One sounding sample. `level` is a linear declick ramp: it moves by `step`
/// per sample for `ramp_left` samples (a falling ramp ends the voice).
#[derive(Clone, Copy, Debug)]
struct Voice {
    live: bool,
    sample: usize,
    /// Pool generation captured at trigger.
    generation: u32,
    /// The start frame `s` (from `start` at trigger): the region's low edge.
    start: f64,
    /// Read position in frames.
    pos: f64,
    /// This voice's gate is high: a sustain loop only loops while it is.
    held: bool,
    /// Inside a seam crossfade: the seam is finished (one more wrap) even if
    /// the gate falls or `loop` goes off meanwhile, so a release never cuts
    /// the crossfade (a step) short.
    seam: bool,
    /// Hold-and-fade: no more reads; `last` is held and faded by `level`.
    hold: bool,
    last: f32,
    level: f32,
    step: f32,
    ramp_left: u32,
}

impl Voice {
    const OFF: Voice = Voice {
        live: false,
        sample: 0,
        generation: 0,
        start: 0.0,
        pos: 0.0,
        held: false,
        seam: false,
        hold: false,
        last: 0.0,
        level: 1.0,
        step: 0.0,
        ramp_left: 0,
    };

    /// Turn into a fade-out from the current level over `fade` samples.
    fn fade_out(&mut self, fade: u32) {
        self.step = -self.level / fade.max(1) as f32;
        self.ramp_left = fade.max(1);
    }

    /// The sample vanished or the region ended: hold the last output and
    /// fade it to 0.
    fn begin_hold(&mut self, fade: u32) {
        if self.last == 0.0 {
            self.live = false;
            return;
        }
        self.hold = true;
        self.level = 1.0;
        self.fade_out(fade);
    }

    /// Read the next frame (pre-level) at `pos` and advance by `rate`;
    /// `None` once the position reaches the region end with loop off.
    #[inline]
    fn read(&mut self, data: &[f32], frames: usize, channels: u8, rate: f64, r: Region) -> Option<f32> {
        let n = frames as f64;
        let lo = self.start;
        let e = (r.end * n).floor().max(lo + 1.0).min(n);
        let ls = (r.loop_start * n).floor().max(lo);
        let xf = r.xfade;
        let looping = e - ls >= 2.0 * xf && ((r.looping && self.held) || self.seam);
        // Frames jumped back at the seam: the loop minus the head the
        // crossfade already played.
        let jump = e - ls - xf;
        if self.pos >= e {
            if !looping {
                return None;
            }
            self.pos = ls + xf + (self.pos - e) % jump;
            self.seam = false;
        }
        let (lo_i, hi_i) = (lo as usize, e as usize - 1);
        let mut x = hermite(data, frames, channels, lo_i, hi_i, self.pos);
        self.seam = looping && self.pos >= e - xf;
        if self.seam {
            // Equal power: tail · cos + head · sin, t 0 → 1 over the last xf.
            let t = ((self.pos - (e - xf)) / xf) as f32;
            let (s, c) = (t.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2).sin_cos();
            x = x * c + hermite(data, frames, channels, lo_i, hi_i, self.pos - jump) * s;
        }
        self.pos += rate;
        // Wrap now too, so a looping voice's position is always inside the
        // region between samples (the check above covers live param moves).
        if looping && self.pos >= e {
            self.pos = ls + xf + (self.pos - e) % jump;
            self.seam = false;
        }
        Some(x)
    }

    /// The next output sample (pre-gain) at playback `rate`.
    #[inline]
    fn next(&mut self, smp: SampleView, rate: f64, fade: u32, region: Region) -> f32 {
        if !self.live {
            return 0.0;
        }
        if !self.hold {
            let x = match smp.playable(self.sample) {
                Some((data, frames, channels, g)) if g == self.generation => {
                    self.read(data, frames, channels, rate, region)
                }
                _ => None,
            };
            match x {
                Some(x) => {
                    let x = x * self.level;
                    self.last = if x.is_finite() { x } else { 0.0 };
                }
                None => {
                    self.begin_hold(fade);
                    if !self.live {
                        return 0.0;
                    }
                }
            }
        }
        let x = if self.hold { self.last * self.level } else { self.last };
        if self.ramp_left > 0 {
            self.level += self.step;
            self.ramp_left -= 1;
            if self.ramp_left == 0 && self.step < 0.0 {
                self.live = false;
            }
        }
        x
    }
}

/// 4-point, 3rd-order Hermite (Catmull-Rom) read at `pos`, the four frames
/// clamped to `[lo, hi]`; a whole-frame `pos` returns that frame exactly.
#[inline]
fn hermite(data: &[f32], frames: usize, channels: u8, lo: usize, hi: usize, pos: f64) -> f32 {
    let i = pos.floor();
    let t = (pos - i) as f32;
    let i = i as usize;
    let at = |k: isize| frame(data, frames, channels, i.saturating_add_signed(k).clamp(lo, hi.max(lo)));
    let x1 = at(0);
    if t == 0.0 {
        return x1;
    }
    let (x0, x2, x3) = (at(-1), at(1), at(2));
    let c1 = 0.5 * (x2 - x0);
    let c2 = x0 - 2.5 * x1 + 2.0 * x2 - 0.5 * x3;
    let c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
    ((c3 * t + c2) * t + c1) * t + x1
}

/// Mono frame `i` of planar `data` (0 past the end): `(L + R) / 2` for stereo.
#[inline]
fn frame(data: &[f32], frames: usize, channels: u8, i: usize) -> f32 {
    if i >= frames {
        return 0.0;
    }
    let l = data.get(i).copied().unwrap_or(0.0);
    if channels == 2 {
        0.5 * (l + data.get(frames + i).copied().unwrap_or(0.0))
    } else {
        l
    }
}

/// A 0..1 fraction param, `fallback` if not finite.
fn frac(params: &[f32], i: usize, fallback: f32) -> f64 {
    let v = param(params, K, i);
    (if v.is_finite() { v.clamp(0.0, 1.0) } else { fallback }) as f64
}

#[derive(Clone)]
pub struct SamplePlayer {
    /// Per channel: the sounding voice and the one fading out under it.
    active: [Voice; MAX_POLY],
    fading: [Voice; MAX_POLY],
    gate: [bool; MAX_POLY],
    gain: Smooth,
    /// 2 ms in samples.
    fade: u32,
    /// 10 ms in samples (the loop crossfade).
    xfade: f64,
}

impl SamplePlayer {
    /// Automation: the next sub-block takes its `smooth` params at once.
    pub fn snap(&mut self) {
        self.gain.snap();
    }

    pub fn new(sr: f32) -> SamplePlayer {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        SamplePlayer {
            active: [Voice::OFF; MAX_POLY],
            fading: [Voice::OFF; MAX_POLY],
            gate: [false; MAX_POLY],
            gain: Smooth::new(sr, default(K, GAIN)),
            fade: ((FADE_SECONDS * sr).round() as u32).max(1),
            xfade: (XFADE_SECONDS * sr).round().max(1.0) as f64,
        }
    }

    /// Silence every voice at once and forget the gates.
    pub fn reset(&mut self) {
        self.active = [Voice::OFF; MAX_POLY];
        self.fading = [Voice::OFF; MAX_POLY];
        self.gate = [false; MAX_POLY];
    }

    /// Start voice `ch` on `sample` at `start` (0..1); the sounding one fades.
    fn trigger(&mut self, ch: usize, sample: Option<usize>, start: f32, smp: SampleView) {
        let (Some(active), Some(fading)) = (self.active.get_mut(ch), self.fading.get_mut(ch)) else { return };
        if active.live {
            *fading = *active;
            fading.held = false;
            fading.fade_out(self.fade);
            active.live = false;
        }
        let Some((sample, (_, frames, _, generation))) = sample.and_then(|id| Some((id, smp.playable(id)?))) else {
            return;
        };
        let start = if start.is_finite() { start.clamp(0.0, 1.0) } else { 0.0 };
        let pos = ((start as f64) * frames as f64).floor().min(frames.saturating_sub(1) as f64);
        *active = Voice { live: true, sample, generation, start: pos, pos, held: true, ..Voice::OFF };
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf], smp: SampleView) {
        let Some(out) = outs.first_mut() else { return };
        let ins = &ins[..ins.len().min(2)];
        let channels = poly(ins);
        out.channels = channels;
        // Channels above the count stop (a later raise must not resurrect them).
        for ch in channels..MAX_POLY {
            self.active[ch].live = false;
            self.fading[ch].live = false;
            self.gate[ch] = false;
        }
        let id = param(params, K, SAMPLE);
        let sample = if id >= 0.0 { Some(id as usize) } else { None };
        let start = param(params, K, START);
        let track = param(params, K, PITCH_TRACK) >= 0.5;
        let root_oct = (param(params, K, ROOT) - 60.0) / 12.0;
        let fine_oct = param(params, K, FINE) / 1200.0;
        let fine_oct = if fine_oct.is_finite() { fine_oct } else { 0.0 };
        let region = Region {
            end: frac(params, END, 1.0),
            looping: param(params, K, LOOP) >= 0.5,
            loop_start: frac(params, LOOP_START, 0.0),
            xfade: self.xfade,
        };
        // Rate exponent (octaves) -> rate; NaN reads as 0.
        let rate_of = |oct: f32| (if oct.is_finite() { oct.clamp(-MAX_OCTAVES, MAX_OCTAVES) } else { 0.0 }).exp2() as f64;
        let fixed_rate = rate_of(fine_oct);
        let target = param(params, K, GAIN);
        let mut gain = [0.0f32; RACK_BLOCK];
        for g in gain.iter_mut() {
            *g = self.gain.next(target);
        }
        let (pitch, gate) = (ins.first(), ins.get(1));
        for ch in 0..channels {
            for (i, &g) in gain.iter().enumerate() {
                let on = gate.map_or(0.0, |p| p.get(ch, i)) >= 0.5;
                if on && !self.gate[ch] {
                    self.trigger(ch, sample, start, smp);
                }
                self.gate[ch] = on;
                // Gate low ends a sustain loop (a retrigger sets it again).
                self.active[ch].held &= on;
                // A silent channel (no live or fading voice) costs no exp2
                // and no sample lookup.
                if !self.active[ch].live && !self.fading[ch].live {
                    out.data[ch][i] = 0.0;
                    continue;
                }
                let rate = if track {
                    rate_of(pitch.map_or(0.0, |p| p.get(ch, i)) - root_oct + fine_oct)
                } else {
                    fixed_rate
                };
                let x = self.active[ch].next(smp, rate, self.fade, region)
                    + self.fading[ch].next(smp, rate, self.fade, region);
                out.data[ch][i] = x * g;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arena::SampleArena;
    use crate::rack::catalog::{spec, ModuleKind};
    use crate::rack::port::PortBuf;
    use crate::samples::{Sample, SamplePool, SampleView};
    use crate::{MAX_PARAMS, RACK_BLOCK};

    const SR: f32 = 48000.0;
    const N: usize = 4800;
    const K: ModuleKind = ModuleKind::SamplePlayer;

    fn p(name: &str) -> usize {
        spec(K).params.iter().position(|p| p.name == name).expect("param")
    }

    /// Load `data` (planar, `channels`) as sample `id`, ready.
    fn load(arena: &mut SampleArena, pool: &mut SamplePool, id: usize, data: &[f32], channels: u8) {
        let slice = arena.alloc(data.len(), true).unwrap();
        arena.slice_mut(slice).copy_from_slice(data);
        let frames = data.len() / channels as usize;
        pool.set(id, Sample { slice, frames, channels, ready: true });
    }

    fn ramp() -> Vec<f32> {
        (0..N).map(|i| i as f32 / N as f32).collect()
    }

    struct Rig {
        sp: SamplePlayer,
        params: [f32; MAX_PARAMS],
        ins: [PortBuf; 2],
        outs: [PortBuf; 1],
    }

    impl Rig {
        fn new() -> Rig {
            let mut params = [0.0; MAX_PARAMS];
            for (d, s) in params.iter_mut().zip(spec(K).params) {
                *d = s.default;
            }
            params[p("sample")] = 0.0;
            Rig { sp: SamplePlayer::new(SR), params, ins: [PortBuf::new(), PortBuf::new()], outs: [PortBuf::new()] }
        }

        /// Render whole sub-blocks: `pitch(ch)` (V/oct) and `gate(ch, frame)`
        /// on `channels` channels. Returns each channel's output.
        fn run(
            &mut self,
            view: SampleView,
            frames: usize,
            channels: usize,
            pitch: impl Fn(usize) -> f32,
            gate: impl Fn(usize, usize) -> bool,
            at: usize,
        ) -> Vec<Vec<f32>> {
            let mut out = vec![Vec::new(); channels];
            let mut f = 0;
            while f < frames {
                self.ins[0].channels = channels;
                self.ins[1].channels = channels;
                for ch in 0..channels {
                    for i in 0..RACK_BLOCK {
                        self.ins[0].data[ch][i] = pitch(ch);
                        self.ins[1].data[ch][i] = if gate(ch, at + f + i) { 1.0 } else { 0.0 };
                    }
                }
                self.sp.process(&self.params, &self.ins, &mut self.outs, view);
                assert_eq!(self.outs[0].channels, channels);
                for (ch, o) in out.iter_mut().enumerate() {
                    o.extend_from_slice(&self.outs[0].data[ch]);
                }
                f += RACK_BLOCK;
            }
            out
        }
    }

    fn max_step(prev: f32, xs: &[f32]) -> f32 {
        let mut last = prev;
        xs.iter().fold(0.0f32, |m, &x| {
            let d = (x - last).abs();
            last = x;
            m.max(d)
        })
    }

    #[test]
    fn sample_player_plays_at_root_and_octave() {
        let (mut arena, mut pool) = (SampleArena::with_capacity(4 * N), SamplePool::new());
        load(&mut arena, &mut pool, 0, &ramp(), 1);
        let view = SampleView::new(&pool, &arena);
        let close = |a: f32, b: f32| (a - b).abs() < 1e-5;

        // At the root (C4 = pitch 0, root 60): 1:1, then silent past the end.
        let mut r = Rig::new();
        let out = r.run(view, N + 320, 1, |_| 0.0, |_, _| true, 0).remove(0);
        for (i, &x) in out[..N].iter().enumerate() {
            assert!(close(x, i as f32 / N as f32), "frame {i}: {x}");
        }
        // At the end the last value is held and faded over 2 ms.
        let fade = (0.002 * SR) as usize;
        assert!(max_step(out[N - 1], &out[N..]) <= 1.0 / fade as f32 + 1e-4);
        assert!(out[N + fade..].iter().all(|&x| x == 0.0), "voice ends with the sample");

        // One octave up: twice as fast, so it reaches the end at N/2.
        let mut r = Rig::new();
        let out = r.run(view, N, 1, |_| 1.0, |_, _| true, 0).remove(0);
        for (i, &x) in out[..N / 2].iter().enumerate() {
            assert!(close(x, 2.0 * i as f32 / N as f32), "octave frame {i}: {x}");
        }
        assert!(out[N / 2 + fade + 1..].iter().all(|&x| x == 0.0));

        // Root 72 played at C4: an octave down. Hermite reproduces a ramp
        // exactly, except at frame 1 (pos 0.5), whose left point is clamped
        // to the region edge.
        let mut r = Rig::new();
        r.params[p("root")] = 72.0;
        let out = r.run(view, 2 * N - 64, 1, |_| 0.0, |_, _| true, 0).remove(0);
        assert!((out[1] - 0.5 / N as f32).abs() < 0.1 / N as f32);
        for (i, &x) in out[..2 * N - 64].iter().enumerate().filter(|&(i, _)| i != 1) {
            assert!(close(x, i as f32 / (2 * N) as f32), "half-speed frame {i}: {x}");
        }

        // pitchTrack off: the pitch input is ignored.
        let mut r = Rig::new();
        r.params[p("pitchTrack")] = 0.0;
        let out = r.run(view, 640, 1, |_| 1.0, |_, _| true, 0).remove(0);
        assert!((0..640).all(|i| close(out[i], i as f32 / N as f32)));

        // start = 0.5 starts half way in; gain (smoothed: let it settle
        // before the gate) scales.
        let mut r = Rig::new();
        r.params[p("start")] = 0.5;
        r.params[p("gain")] = 0.5;
        let out = r.run(view, N + 64, 1, |_| 0.0, |_, f| f >= N, 0).remove(0);
        assert!(close(out[N], 0.25) && close(out[N + 10], 0.5 * (N / 2 + 10) as f32 / N as f32), "{}", out[N]);

        // Poly: each channel is its own voice (its own pitch, its own gate).
        let mut r = Rig::new();
        let out = r.run(view, 640, 2, |ch| ch as f32, |ch, f| ch == 0 || f >= 320, 0);
        assert!((0..640).all(|i| close(out[0][i], i as f32 / N as f32)));
        assert!(out[1][..320].iter().all(|&x| x == 0.0));
        assert!(close(out[1][330], 20.0 / N as f32));

        // A stereo sample plays mono: (L + R) / 2 per frame.
        let mut stereo: Vec<f32> = ramp();
        stereo.extend(std::iter::repeat_n(0.5, N));
        load(&mut arena, &mut pool, 1, &stereo, 2);
        let view = SampleView::new(&pool, &arena);
        let mut r = Rig::new();
        r.params[p("sample")] = 1.0;
        let out = r.run(view, 64, 1, |_| 0.0, |_, _| true, 0).remove(0);
        assert!(close(out[8], (8.0 / N as f32 + 0.5) / 2.0));

        // No sample (-1), or a sample that is not ready, is silent.
        let mut r = Rig::new();
        r.params[p("sample")] = -1.0;
        assert!(r.run(view, 128, 1, |_| 0.0, |_, _| true, 0)[0].iter().all(|&x| x == 0.0));
        let slice = arena.alloc(N, true).unwrap();
        pool.set(2, Sample { slice, frames: N, channels: 1, ready: false });
        let view = SampleView::new(&pool, &arena);
        let mut r = Rig::new();
        r.params[p("sample")] = 2.0;
        assert!(r.run(view, 128, 1, |_| 0.0, |_, _| true, 0)[0].iter().all(|&x| x == 0.0));
    }

    #[test]
    fn sample_player_retrigger_is_declicked() {
        // A constant sample: a retrigger restarts it at full level while the
        // old voice fades over 2 ms (no step), like the drum voices.
        let (mut arena, mut pool) = (SampleArena::with_capacity(4 * N), SamplePool::new());
        load(&mut arena, &mut pool, 0, &ramp(), 1);
        let view = SampleView::new(&pool, &arena);
        let mut r = Rig::new();
        let gate = |_: usize, f: usize| !(2000..2032).contains(&f);
        let out = r.run(view, 4000, 1, |_| 0.0, gate, 0).remove(0);
        // Gate low for one sub-block: the voice plays on (one-shot), then the
        // retrigger at 2032 restarts from 0 while the old one (~0.42) fades.
        assert!(max_step(0.0, &out) < 0.02, "step {}", max_step(0.0, &out));
        let fade = (0.002 * SR) as usize;
        let after = 2032 + fade + 4;
        assert!((out[after] - (after - 2032) as f32 / N as f32).abs() < 1e-5, "old voice gone after 2 ms");
    }

    #[test]
    fn sample_player_survives_replace_and_reset() {
        let (mut arena, mut pool) = (SampleArena::with_capacity(4 * N), SamplePool::new());
        load(&mut arena, &mut pool, 0, &[0.5; N], 1);
        let mut r = Rig::new();
        let fade = (0.002 * SR) as usize;
        let out = r.run(SampleView::new(&pool, &arena), 640, 1, |_| 0.0, |_, _| true, 0).remove(0);
        assert!(out.iter().all(|&x| x == 0.5));

        // Replaced (new data elsewhere in the arena): the voice must not read
        // it. It holds its last value and fades it out over 2 ms.
        load(&mut arena, &mut pool, 0, &[1.0; N], 1);
        let out = r.run(SampleView::new(&pool, &arena), 640, 1, |_| 0.0, |_, _| true, 640).remove(0);
        assert!(out.iter().all(|&x| x <= 0.5), "read the replacement");
        assert!(max_step(0.5, &out) <= 0.05, "step {}", max_step(0.5, &out));
        assert!(out[fade + 1..].iter().all(|&x| x == 0.0), "silent after the fade");
        // A new gate plays the new sample.
        let out = r.run(SampleView::new(&pool, &arena), 640, 1, |_| 0.0, |_, f| f >= 1312, 1280).remove(0);
        assert!(out[32..].iter().all(|&x| x == 1.0), "{:?}", &out[30..40]);

        // Engine reset: the pool is cleared and the arena rewound, then a new
        // sample lands on the very same id *and* arena slice. The slice is
        // identical, only the generation tells the voice apart.
        pool.clear();
        arena.reset();
        load(&mut arena, &mut pool, 0, &[0.25; N], 1);
        let out = r.run(SampleView::new(&pool, &arena), 640, 1, |_| 0.0, |_, _| true, 1920).remove(0);
        // A fade of the held 1.0, never the new 0.25s.
        assert!(out.windows(2).all(|w| w[1] <= w[0]), "read the post-reset data");
        assert!(max_step(1.0, &out) <= 0.05);
        assert!(out[fade + 1..].iter().all(|&x| x == 0.0));
        // Cleared without a new sample: also silent (never reads freed memory).
        pool.clear();
        let out = r.run(SampleView::new(&pool, &arena), 640, 1, |_| 0.0, |_, f| f >= 2600, 2560).remove(0);
        assert!(out.iter().all(|&x| x == 0.0));
    }

    /// `n` frames of `amp · sin(2π · i / period + phase)`.
    fn sine(n: usize, period: f32, phase: f32) -> Vec<f32> {
        (0..n).map(|i| (std::f32::consts::TAU * i as f32 / period + phase).sin()).collect()
    }

    #[test]
    fn end_stops_early() {
        // end 0.5 on a 1000-frame ramp: plays frames 0..500, then the 2 ms
        // fade of the held last value, then silence.
        let (mut arena, mut pool) = (SampleArena::with_capacity(4 * N), SamplePool::new());
        let ramp: Vec<f32> = (0..1000).map(|i| 0.1 + i as f32 / 1000.0).collect();
        load(&mut arena, &mut pool, 0, &ramp, 1);
        let view = SampleView::new(&pool, &arena);
        let fade = (0.002 * SR) as usize;
        let mut r = Rig::new();
        r.params[p("end")] = 0.5;
        let out = r.run(view, 1024, 1, |_| 0.0, |_, _| true, 0).remove(0);
        for (i, &x) in out[..500].iter().enumerate() {
            assert!((x - ramp[i]).abs() < 1e-5, "frame {i}: {x}");
        }
        // The fade starts from the last played value (no step) ...
        assert!(max_step(out[499], &out[500..]) <= 0.6 / fade as f32 + 1e-4, "step {}", max_step(out[499], &out[500..]));
        // ... and never reads past `end`.
        assert!(out[500..].iter().all(|&x| x <= out[499] + 1e-6));
        assert!(out[500 + fade + 1..].iter().all(|&x| x == 0.0), "silent after end + fade");
        assert!(!r.sp.active[0].live);
    }

    #[test]
    fn loop_sustains() {
        // Loop on, the gate held: the voice is still sounding after 3× the
        // sample length, and every read stays inside [loopStart, end).
        let (mut arena, mut pool) = (SampleArena::with_capacity(4 * N), SamplePool::new());
        load(&mut arena, &mut pool, 0, &[0.5; N], 1);
        let view = SampleView::new(&pool, &arena);
        let mut r = Rig::new();
        r.params[p("loop")] = 1.0;
        r.params[p("loopStart")] = 0.25;
        r.params[p("end")] = 0.75;
        let out = r.run(view, 3 * N + 640, 1, |_| 0.0, |_, _| true, 0).remove(0);
        let tail = &out[3 * N..];
        assert!(tail.iter().all(|&x| x > 0.3 && x <= 0.5 * std::f32::consts::SQRT_2 + 1e-4), "{:?}", &tail[..8]);
        let pos = r.sp.active[0].pos;
        assert!((0.25 * N as f64..0.75 * N as f64).contains(&pos), "pos {pos}");
        // Loop off again: it plays on to `end` and stops.
        r.params[p("loop")] = 0.0;
        let out = r.run(view, N, 1, |_| 0.0, |_, _| true, 4 * N).remove(0);
        assert!(out[N - 64..].iter().all(|&x| x == 0.0));
    }

    #[test]
    fn loop_seam_is_smooth() {
        // A sine whose loop points are not zero crossings (a hard splice
        // would step by ~1): with the 10 ms equal-power crossfade, the largest
        // sample-to-sample step near the seam stays within 2× the largest
        // step of the plain playback.
        let (mut arena, mut pool) = (SampleArena::with_capacity(4 * N), SamplePool::new());
        let period = 109.3;
        load(&mut arena, &mut pool, 0, &sine(N, period, 0.0), 1);
        let view = SampleView::new(&pool, &arena);
        let mut r = Rig::new();
        r.params[p("loop")] = 1.0;
        r.params[p("loopStart")] = 0.2137;
        r.params[p("end")] = 0.8711;
        let out = r.run(view, 4 * N, 1, |_| 0.0, |_, _| true, 0).remove(0);
        let e = (0.8711 * N as f64).floor() as usize;
        let plain = max_step(out[0], &out[..e - 480]);
        let seam = max_step(out[e - 600], &out[e - 600..]);
        assert!(plain > 0.05, "{plain}");
        assert!(seam <= 2.0 * plain, "seam step {seam} vs plain {plain}");
        assert!(out.iter().all(|x| x.is_finite() && x.abs() <= 1.5));
    }

    #[test]
    fn fine_shifts_rate() {
        // +100 ct is one semitone up: after n output frames the read
        // position is n · 2^(1/12), within a frame. A ramp's value is its
        // position / N.
        let (mut arena, mut pool) = (SampleArena::with_capacity(4 * N), SamplePool::new());
        load(&mut arena, &mut pool, 0, &ramp(), 1);
        let view = SampleView::new(&pool, &arena);
        let semi = 2f32.powf(1.0 / 12.0);
        for track in [1.0, 0.0] {
            let mut r = Rig::new();
            r.params[p("fine")] = 100.0;
            r.params[p("pitchTrack")] = track;
            let out = r.run(view, 3200, 1, |_| 0.0, |_, _| true, 0).remove(0);
            for n in [100usize, 1000, 3000] {
                let pos = out[n] * N as f32;
                assert!((pos - n as f32 * semi).abs() <= 1.0, "track {track}: frame {n} at {pos}");
            }
        }
        // With pitch tracking, fine adds to the note: pitch 1/12 V − 100 ct = root speed.
        let mut r = Rig::new();
        r.params[p("fine")] = -100.0;
        let out = r.run(view, 2000, 1, |_| 1.0 / 12.0, |_, _| true, 0).remove(0);
        assert!((out[1500] * N as f32 - 1500.0).abs() <= 1.0, "{}", out[1500] * N as f32);
    }

    #[test]
    fn hermite_matches_on_integer_positions() {
        // Rate 1: exactly the sample's values (no smoothing of the data).
        let (mut arena, mut pool) = (SampleArena::with_capacity(4 * N), SamplePool::new());
        let data: Vec<f32> = (0..N).map(|i| ((i * 7919) % 1000) as f32 / 1000.0 - 0.5).collect();
        load(&mut arena, &mut pool, 0, &data, 1);
        let period = 12.0;
        load(&mut arena, &mut pool, 1, &sine(N, period, 0.0), 1);
        let view = SampleView::new(&pool, &arena);
        let mut r = Rig::new();
        let out = r.run(view, N, 1, |_| 0.0, |_, _| true, 0).remove(0);
        assert!(out.iter().zip(&data).all(|(a, b)| a == b));

        // Half speed (root 72): between frames it is the 4-point Hermite, so
        // a sine reads much closer to the true curve than linear would
        // (linear's midpoint error is 1 − cos(π/period) ≈ 0.034 here).
        let mut r = Rig::new();
        r.params[p("sample")] = 1.0;
        r.params[p("root")] = 72.0;
        let out = r.run(view, 2 * N - 64, 1, |_| 0.0, |_, _| true, 0).remove(0);
        let err = (8..2 * N - 64)
            .map(|i| (out[i] - (std::f32::consts::TAU * (i as f32 * 0.5) / period).sin()).abs())
            .fold(0.0f32, f32::max);
        let linear = 1.0 - (std::f32::consts::PI / period).cos();
        assert!(err < 0.25 * linear, "hermite err {err} vs linear {linear}");
    }

    #[test]
    fn loop_extreme_rate() {
        // root 60, notes C8 (+4 V) and C0 (−4 V), plus the ±11-octave clamp,
        // on the shortest loop that still loops: no NaN, bounded, and the
        // position never leaves [loopStart, end).
        let (mut arena, mut pool) = (SampleArena::with_capacity(4 * N), SamplePool::new());
        load(&mut arena, &mut pool, 0, &sine(N, 37.7, 0.4), 1);
        let view = SampleView::new(&pool, &arena);
        let (ls, e) = (0.3, 0.3 + 1000.0 / N as f32);
        for v in [4.0f32, -4.0, 30.0, -30.0, f32::NAN] {
            let mut r = Rig::new();
            r.params[p("loop")] = 1.0;
            r.params[p("start")] = ls;
            r.params[p("loopStart")] = ls;
            r.params[p("end")] = e;
            let mut all = Vec::new();
            for b in 0..200 {
                let out = r.run(view, 32, 1, |_| v, |_, _| true, b * 32).remove(0);
                all.extend(out);
                let pos = r.sp.active[0].pos;
                assert!(r.sp.active[0].live, "pitch {v}: the loop voice died");
                let lo = (ls as f64 * N as f64).floor();
                let hi = (e as f64 * N as f64).floor();
                assert!((lo..hi).contains(&pos), "pitch {v}: pos {pos} outside [{lo}, {hi})");
            }
            assert!(all.iter().all(|x| x.is_finite() && x.abs() <= 1.5), "pitch {v}");
        }
        // C0 (1/16 speed): slow enough to hear the seam; still smooth.
        let mut r = Rig::new();
        r.params[p("loop")] = 1.0;
        r.params[p("start")] = ls;
        r.params[p("loopStart")] = ls;
        r.params[p("end")] = e;
        let out = r.run(view, 16 * 2000, 1, |_| -4.0, |_, _| true, 0).remove(0);
        let plain = max_step(out[0], &out[..16 * 400]);
        assert!(max_step(out[0], &out) <= 2.0 * plain, "{} vs {plain}", max_step(out[0], &out));
    }

    #[test]
    fn degenerate_regions() {
        let (mut arena, mut pool) = (SampleArena::with_capacity(4 * N), SamplePool::new());
        load(&mut arena, &mut pool, 0, &[0.5; 1000], 1);
        let view = SampleView::new(&pool, &arena);
        let fade = (0.002 * SR) as usize;
        // start 0.9, end 0.1: a 1-frame region at 900, then the fade.
        for lp in [0.0, 1.0] {
            let mut r = Rig::new();
            r.params[p("start")] = 0.9;
            r.params[p("end")] = 0.1;
            r.params[p("loop")] = lp;
            let out = r.run(view, 256, 1, |_| 0.0, |_, _| true, 0).remove(0);
            assert_eq!(out[0], 0.5);
            assert!(out.iter().all(|&x| (0.0..=0.5).contains(&x)));
            assert!(out[1 + fade..].iter().all(|&x| x == 0.0), "loop {lp}: still sounding");
        }
        // start 1: the last frame only.
        let mut r = Rig::new();
        r.params[p("start")] = 1.0;
        let out = r.run(view, 256, 1, |_| 0.0, |_, _| true, 0).remove(0);
        assert_eq!(out[0], 0.5);
        assert!(out[1 + fade..].iter().all(|&x| x == 0.0));
        // loopStart 0.99, end 1, loop on: a 10-frame loop is shorter than two
        // crossfades, so loop is off: it plays to the end and stops.
        let mut r = Rig::new();
        r.params[p("loop")] = 1.0;
        r.params[p("loopStart")] = 0.99;
        let out = r.run(view, 1280, 1, |_| 0.0, |_, _| true, 0).remove(0);
        assert!(out[..1000].iter().all(|&x| x == 0.5));
        assert!(out[1000 + fade..].iter().all(|&x| x == 0.0));
        // loopStart past end (0.8 vs 0.5): no loop either.
        let mut r = Rig::new();
        r.params[p("loop")] = 1.0;
        r.params[p("loopStart")] = 0.8;
        r.params[p("end")] = 0.5;
        let out = r.run(view, 640, 1, |_| 0.0, |_, _| true, 0).remove(0);
        assert!(out[500 + fade..].iter().all(|&x| x == 0.0));
    }

    #[test]
    fn loop_voice_fades_when_the_sample_is_replaced() {
        let (mut arena, mut pool) = (SampleArena::with_capacity(8 * N), SamplePool::new());
        load(&mut arena, &mut pool, 0, &[0.5; N], 1);
        let fade = (0.002 * SR) as usize;
        let mut r = Rig::new();
        r.params[p("loop")] = 1.0;
        r.params[p("end")] = 0.5;
        let out = r.run(SampleView::new(&pool, &arena), 2 * N, 1, |_| 0.0, |_, _| true, 0).remove(0);
        assert!(out[N..].iter().all(|&x| x > 0.3), "loops");
        load(&mut arena, &mut pool, 0, &[1.0; N], 1);
        let out = r.run(SampleView::new(&pool, &arena), 640, 1, |_| 0.0, |_, _| true, 2 * N).remove(0);
        assert!(out.iter().all(|&x| x <= 0.5 * std::f32::consts::SQRT_2), "read the replacement");
        assert!(out[fade + 1..].iter().all(|&x| x == 0.0), "silent after the fade");
    }

    #[test]
    fn loop_releases_at_gate_off() {
        // A sustain loop: it loops only while the gate is high. Gate low: the
        // voice plays on from where it is to `end` and stops (2 ms fade), so
        // it is silent within (e − loopStart) frames + fade.
        let (mut arena, mut pool) = (SampleArena::with_capacity(4 * N), SamplePool::new());
        load(&mut arena, &mut pool, 0, &[0.5; N], 1);
        let fade = (0.002 * SR) as usize;
        let view = SampleView::new(&pool, &arena);
        let mut r = Rig::new();
        r.params[p("loop")] = 1.0;
        r.params[p("loopStart")] = 0.25;
        r.params[p("end")] = 0.75;
        let off = 3 * N;
        let out = r.run(view, 5 * N, 1, |_| 0.0, |_, f| f < off, 0).remove(0);
        assert!(out[off - 64..off].iter().all(|&x| x > 0.3), "sounding while held");
        let bound = off + N / 2 + fade + 1;
        assert!(out[bound..].iter().all(|&x| x == 0.0), "still sounding after the release");
        assert!(!r.sp.active[0].live);

        // A release anywhere, also in the middle of the seam crossfade, is
        // smooth: a seam under way is finished first, then the voice plays
        // to `end`.
        let mut arena = SampleArena::with_capacity(4 * N);
        let mut pool = SamplePool::new();
        load(&mut arena, &mut pool, 0, &sine(N, 109.3, 0.0), 1);
        let view = SampleView::new(&pool, &arena);
        let e = (0.8711 * N as f64).floor() as usize;
        for off in [e - 400, e - 240, e - 30, e + 100, 2 * e - 900] {
            let mut r = Rig::new();
            r.params[p("loop")] = 1.0;
            r.params[p("loopStart")] = 0.2137;
            r.params[p("end")] = 0.8711;
            let out = r.run(view, 4 * N, 1, |_| 0.0, |_, f| f < off, 0).remove(0);
            let plain = max_step(out[0], &out[..e - 480]);
            assert!(max_step(out[0], &out) <= 2.0 * plain, "release at {off}: {} vs {plain}", max_step(out[0], &out));
            let ls = (0.2137 * N as f64).floor() as usize;
            assert!(out[off + (e - ls) + fade + 1..].iter().all(|&x| x == 0.0), "release at {off}: still sounding");
        }
    }
}
