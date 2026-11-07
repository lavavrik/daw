//! Sample Player: plays a sample-pool sample (the project's samples, the
//! ones drum rows use), one voice per channel.
//!
//! * **Voices.** Channels follow the `pitch`/`gate` inputs (poly, like the
//!   ADSR): channel `ch` of `gate` drives voice `ch`, and `out` carries one
//!   mono channel per voice (a stereo sample is played as `(L + R) / 2`).
//! * **Trigger.** A rising gate (`>= 0.5`) starts the voice at
//!   `start · frames` of sample `sample` (`-1` = none). It is a one-shot: it
//!   plays to the end of the sample whatever the gate does next (put an ADSR
//!   and VCA after it for gated notes). A gate with no playable sample (none,
//!   not loaded yet) starts nothing.
//! * **Pitch.** With `pitchTrack` on, the playback rate is
//!   `2^(pitch − (root − 60)/12)` (pitch in V/oct, 0 = C4 = MIDI 60), read per
//!   sample, so bends and glides follow; `root` is the note at which the
//!   sample plays at its own speed. Off, the rate is 1. Positions between
//!   frames are read with linear interpolation.
//! * **Declicking** (as the drum voices, `drums.rs`): each channel has an
//!   active and a fading voice. A retrigger moves the sounding voice to the
//!   fading slot, which ramps to 0 over 2 ms, and starts the new one at full
//!   level (the attack is the sample's own).
//! * **Replaced / reset samples.** A voice captures the sample's generation
//!   (`samples.rs`) when it starts. If the pool stops reporting that
//!   generation (the sample was replaced, un-readied, or cleared by
//!   `OP_RESET_ALL`), the voice never reads the slot again: it holds its last
//!   output and fades it to 0 over 2 ms.
//! * `gain` (0..2) is smoothed per sample; `sample`, `pitchTrack` and `root`
//!   are integer params, declicked by the rack.

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

/// Rate exponent limit (octaves): beyond ±11 a voice is either over in a few
/// samples or inaudibly slow.
const MAX_OCTAVES: f32 = 11.0;
/// Declick fade length (seconds).
const FADE_SECONDS: f32 = 0.002;

/// One sounding sample. `level` is a linear declick ramp: it moves by `step`
/// per sample for `ramp_left` samples (a falling ramp ends the voice).
#[derive(Clone, Copy, Debug)]
struct Voice {
    live: bool,
    sample: usize,
    /// Pool generation captured at trigger.
    generation: u32,
    /// Read position in frames.
    pos: f64,
    /// Hold-and-fade: no more reads; `last` is held and faded by `level`.
    hold: bool,
    last: f32,
    level: f32,
    step: f32,
    ramp_left: u32,
}

impl Voice {
    const OFF: Voice =
        Voice { live: false, sample: 0, generation: 0, pos: 0.0, hold: false, last: 0.0, level: 1.0, step: 0.0, ramp_left: 0 };

    /// Turn into a fade-out from the current level over `fade` samples.
    fn fade_out(&mut self, fade: u32) {
        self.step = -self.level / fade.max(1) as f32;
        self.ramp_left = fade.max(1);
    }

    /// The sample vanished: hold the last output and fade it to 0.
    fn begin_hold(&mut self, fade: u32) {
        if self.last == 0.0 {
            self.live = false;
            return;
        }
        self.hold = true;
        self.level = 1.0;
        self.fade_out(fade);
    }

    /// The next output sample (pre-gain) at playback `rate`.
    #[inline]
    fn next(&mut self, smp: SampleView, rate: f64, fade: u32) -> f32 {
        if !self.live {
            return 0.0;
        }
        let x = if self.hold {
            self.last * self.level
        } else {
            match smp.playable(self.sample) {
                Some((data, frames, channels, g)) if g == self.generation => {
                    let i0 = self.pos as usize;
                    if i0 >= frames {
                        self.live = false;
                        return 0.0;
                    }
                    let frac = (self.pos - i0 as f64) as f32;
                    let a = frame(data, frames, channels, i0);
                    let b = if frac == 0.0 { a } else { frame(data, frames, channels, i0 + 1) };
                    self.pos += rate;
                    let x = (a + (b - a) * frac) * self.level;
                    let x = if x.is_finite() { x } else { 0.0 };
                    self.last = x;
                    x
                }
                _ => {
                    self.begin_hold(fade);
                    if !self.live {
                        return 0.0;
                    }
                    self.last * self.level
                }
            }
        };
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

#[derive(Clone)]
pub struct SamplePlayer {
    /// Per channel: the sounding voice and the one fading out under it.
    active: [Voice; MAX_POLY],
    fading: [Voice; MAX_POLY],
    gate: [bool; MAX_POLY],
    gain: Smooth,
    /// 2 ms in samples.
    fade: u32,
}

impl SamplePlayer {
    pub fn new(sr: f32) -> SamplePlayer {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        SamplePlayer {
            active: [Voice::OFF; MAX_POLY],
            fading: [Voice::OFF; MAX_POLY],
            gate: [false; MAX_POLY],
            gain: Smooth::new(sr, default(K, GAIN)),
            fade: ((FADE_SECONDS * sr).round() as u32).max(1),
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
            fading.fade_out(self.fade);
            active.live = false;
        }
        let Some((sample, (_, frames, _, generation))) = sample.and_then(|id| Some((id, smp.playable(id)?))) else {
            return;
        };
        let pos = ((start.clamp(0.0, 1.0) as f64) * frames as f64).floor().min(frames.saturating_sub(1) as f64);
        *active = Voice { live: true, sample, generation, pos, ..Voice::OFF };
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
                // A silent channel (no live or fading voice) costs no exp2
                // and no sample lookup.
                if !self.active[ch].live && !self.fading[ch].live {
                    out.data[ch][i] = 0.0;
                    continue;
                }
                let rate = if track {
                    let oct = pitch.map_or(0.0, |p| p.get(ch, i)) - root_oct;
                    let oct = if oct.is_finite() { oct.clamp(-MAX_OCTAVES, MAX_OCTAVES) } else { 0.0 };
                    oct.exp2() as f64
                } else {
                    1.0
                };
                let x = self.active[ch].next(smp, rate, self.fade) + self.fading[ch].next(smp, rate, self.fade);
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
        assert!(out[N..].iter().all(|&x| x == 0.0), "voice ends with the sample");

        // One octave up: twice as fast, so it reaches the end at N/2.
        let mut r = Rig::new();
        let out = r.run(view, N, 1, |_| 1.0, |_, _| true, 0).remove(0);
        for (i, &x) in out[..N / 2].iter().enumerate() {
            assert!(close(x, 2.0 * i as f32 / N as f32), "octave frame {i}: {x}");
        }
        assert!(out[N / 2 + 1..].iter().all(|&x| x == 0.0));

        // Root 72 played at C4: an octave down, linearly interpolated.
        let mut r = Rig::new();
        r.params[p("root")] = 72.0;
        let out = r.run(view, 2 * N - 64, 1, |_| 0.0, |_, _| true, 0).remove(0);
        for (i, &x) in out[..2 * N - 64].iter().enumerate() {
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
}
