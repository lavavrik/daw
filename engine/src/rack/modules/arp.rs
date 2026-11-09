//! Arp (kind 21, plan 26 Task 3): a note module that plays the held notes one
//! at a time on a tempo grid. Like Chord it has no jacks: the rack routes the
//! note stream through it (Chord -> Arp -> MIDI In; `Rack::note`) and calls
//! [`Arp::tick`] at the start of every sub-block, before any module renders,
//! so the notes it emits reach MIDI In in the same sub-block.
//!
//! # Params
//! `rate` 1/4, 1/8, 1/16, 1/32, 1/8T, 1/16T (= 960, 480, 240, 120, 320, 160
//! ticks at 960 PPQ); `mode` Up, Down, Up-down, Random, As played; `octaves`
//! 1..4 (the pattern repeats an octave higher each time); `gate` 10..100 % of
//! a step; `latch` Off/On.
//!
//! # Timing (sample-accurate against the transport)
//! Step times are exact ticks. While the transport plays they sit on the
//! song's own grid (multiples of the step, from tick 0, so they line up with
//! the bars in Song and Pattern mode alike); while stopped the arp runs its
//! own clock at the project tempo, starting at the first key. A step (or a
//! gate end) at tick T is applied at the first rack sub-block boundary whose
//! frame is at or after `round(frame(T))`, which is exactly where the
//! sequencer's own note at tick T is applied (`tick_to_offset` rounds, the
//! rack applies a note at its next sub-block): an arpeggio of a held note
//! renders bit for bit like the same notes drawn in a pattern at gates below
//! 100 % (`synth.rs` `arp_renders_like_drawn_notes_*`: Pattern mode, and Song
//! mode across loop wraps on and off the sub-block grid, 120/124/133 BPM).
//! Nothing accumulates: the clock is the transport's tick, or a tick count
//! advanced by exactly one sub-block of ticks per sub-block.
//!
//! The first key from silence starts on the first grid step whose frame
//! falls after the previous sub-block boundary (one inside the sub-block the
//! key arrived in counts, so a pattern note on the grid plays at once);
//! stopped, it starts at once. A transport jump (Play, Stop, loop wrap, seek)
//! or a switch between the two clocks ends the sounding note and restarts the
//! pattern from its first note with the same rule on the new clock, so the
//! downbeat after a loop wrap that lands mid-sub-block still plays. (Side
//! effect: a Play or seek to a point just past a grid step, within one
//! sub-block, plays that step at once, at most one sub-block early.)
//!
//! # Gate extremes
//! * At 100 % a step's Off is due with the next step's On: the On goes first,
//!   then the old Off (a repeated pitch is just re-pressed), so a mono MIDI In
//!   ties the steps (and glides with glide on) instead of retriggering. This
//!   is where the arp differs from drawn notes, whose Offs go first.
//! * A note lasts at least one sub-block (`RACK_BLOCK` frames): a very short
//!   gate at a very high tempo would otherwise put its On and Off in one
//!   sub-block and never sound.
//!
//! # Random
//! Random picks from an xorshift generator that is re-seeded whenever the
//! pattern restarts: at the first key from silence (each pattern pass that
//! plays the chord again) and at every transport jump. Playback, a replay and
//! the export therefore pick the same notes. A pick never repeats the
//! previous one when there are two or more.
//!
//! # Keys, latch, pedal
//! Held keys are kept in the order played (As played) and sorted for the
//! other modes. A key-off removes the key unless `latch` is on or the
//! sustain pedal is down (the pedal is the arp's: MIDI In never sees it go
//! down, or it would hold every step's Off; pedal-up is passed on, so a
//! pedal that was down before the Arp was added is released). With latch on, the released set keeps
//! playing; a key pressed while no key is down starts a new set. Turning
//! latch off (or lifting the pedal) drops the released keys. **Stop clears
//! a latch** (keys still physically held keep playing on the free clock), so
//! Stop always silences sequenced arps (Stop pressed while already stopped
//! leaves a live latch alone: toggle Latch or panic). An Off for a key the arp does not
//! hold (pressed before the module was added) passes through. Allocation-free.

use super::{param, Ctx, NoteBuf, NoteEvent};
use crate::rack::catalog::ModuleKind;
use crate::RACK_BLOCK;

const RATE: usize = 0;
const MODE: usize = 1;
const OCTAVES: usize = 2;
const GATE: usize = 3;
const LATCH: usize = 4;
const K: ModuleKind = ModuleKind::Arp;

/// Step length per `rate` choice, in ticks (960 PPQ).
pub const RATE_TICKS: [f64; 6] = [960.0, 480.0, 240.0, 120.0, 320.0, 160.0];

/// Keys the arp holds at most (a Chord in front can make 5 per key).
pub const MAX_HELD: usize = 32;

const SEED: u32 = 0x9e37_79b9;

#[derive(Clone, Copy)]
struct Key {
    note: u8,
    vel: u8,
    /// Physically down (false: held by latch or the pedal).
    down: bool,
}

#[derive(Clone)]
pub struct Arp {
    held: [Key; MAX_HELD],
    n_held: usize,
    pedal: bool,
    /// Stepping (keys held and the clock started).
    running: bool,
    /// The next tick needs to pick the first step (a key from silence).
    start: bool,
    /// The note now sounding and the tick its gate ends.
    sounding: Option<u8>,
    off_at: f64,
    /// The tick of the next step.
    next: f64,
    /// Steps since the pattern (re)started.
    idx: u64,
    rng: u32,
    last_pick: usize,
    /// The previous tick's clock: was the transport playing, and the tick
    /// it expected this sub-block to start at (a mismatch is a jump).
    was_playing: bool,
    expect: f64,
    /// The free clock (stopped): ticks at the current sub-block start.
    free: f64,
}

impl Default for Arp {
    fn default() -> Self {
        Self::new()
    }
}

impl Arp {
    pub fn new() -> Arp {
        Arp {
            held: [Key { note: 0, vel: 0, down: false }; MAX_HELD],
            n_held: 0,
            pedal: false,
            running: false,
            start: false,
            sounding: None,
            off_at: 0.0,
            next: 0.0,
            idx: 0,
            rng: SEED,
            last_pick: usize::MAX,
            was_playing: false,
            expect: f64::NAN,
            free: 0.0,
        }
    }

    /// Forget every key and the clock (no events: the caller silences).
    pub fn reset(&mut self) {
        *self = Arp::new();
    }

    fn find(&self, note: u8) -> Option<usize> {
        self.held[..self.n_held].iter().position(|k| k.note == note)
    }

    fn remove_at(&mut self, i: usize) {
        if i < self.n_held {
            self.held.copy_within(i + 1..self.n_held, i);
            self.n_held -= 1;
        }
    }

    /// Drop the keys not physically down.
    fn drop_released(&mut self) {
        let mut k = 0;
        for i in 0..self.n_held {
            if self.held[i].down {
                self.held[k] = self.held[i];
                k += 1;
            }
        }
        self.n_held = k;
    }

    /// No keys left: end the sounding note and stop stepping.
    fn stop_if_empty(&mut self, out: &mut NoteBuf) {
        if self.n_held == 0 {
            if let Some(n) = self.sounding.take() {
                out.push(NoteEvent::Off { note: n });
            }
            self.running = false;
            self.start = false;
        }
    }

    /// The pattern starts over from its first note (and the random seed).
    fn restart(&mut self) {
        self.idx = 0;
        self.rng = SEED;
        self.last_pick = usize::MAX;
    }

    /// A key event from the note stream (see the module docs).
    pub fn input(&mut self, ev: NoteEvent, params: &[f32], out: &mut NoteBuf) {
        let latch = param(params, K, LATCH) >= 0.5;
        match ev {
            NoteEvent::On { note, vel } => {
                if latch && self.n_held > 0 && !self.held[..self.n_held].iter().any(|k| k.down) {
                    self.n_held = 0; // a new latched set replaces the old one
                    self.restart();
                }
                match self.find(note) {
                    Some(i) => self.held[i] = Key { note, vel, down: true },
                    None if self.n_held < MAX_HELD => {
                        self.held[self.n_held] = Key { note, vel, down: true };
                        self.n_held += 1;
                    }
                    None => {}
                }
                if !self.running {
                    self.running = true;
                    self.start = true;
                }
            }
            NoteEvent::Off { note } => match self.find(note) {
                Some(i) => {
                    self.held[i].down = false;
                    if !(latch || self.pedal) {
                        self.remove_at(i);
                        self.stop_if_empty(out);
                    }
                }
                None => out.push(ev),
            },
            NoteEvent::Sustain(on) => {
                self.pedal = on;
                if !on {
                    if !latch {
                        self.drop_released();
                        self.stop_if_empty(out);
                    }
                    // Pedal-up also reaches MIDI In: a pedal pressed before
                    // the Arp was added is down there, and would sustain
                    // every step's Off for good. Always safe.
                    out.push(ev);
                }
            }
            NoteEvent::AllOff => {
                self.n_held = 0;
                self.sounding = None; // MIDI In closes every gate itself
                self.running = false;
                self.start = false;
                out.push(ev);
            }
            NoteEvent::Bend(_) | NoteEvent::Mod(_) => out.push(ev),
        }
    }

    /// The module is going away: end its sounding note.
    pub fn flush(&mut self, out: &mut NoteBuf) {
        if let Some(n) = self.sounding.take() {
            out.push(NoteEvent::Off { note: n });
        }
        self.reset();
    }

    /// The pitch and velocity of pattern position `j` (0..len).
    fn note_at(&self, j: usize, as_played: bool) -> (u8, u8) {
        let n = self.n_held.max(1);
        let (i, oct) = (j % n, j / n);
        let key = if as_played {
            self.held[i]
        } else {
            // The i-th lowest held key (n <= 32: a selection count, no sort buffer).
            let mut pick = self.held[0];
            for k in &self.held[..self.n_held] {
                let below = self.held[..self.n_held].iter().filter(|o| o.note < k.note).count();
                if below == i {
                    pick = *k;
                    break;
                }
            }
            pick
        };
        let mut p = key.note as u32 + 12 * oct as u32;
        while p > 127 {
            p -= 12;
        }
        (p as u8, key.vel)
    }

    /// The next step's pattern position (advances the step count / rng).
    fn pick(&mut self, params: &[f32]) -> usize {
        let octaves = (param(params, K, OCTAVES) as usize).clamp(1, 4);
        let len = self.n_held * octaves;
        let k = self.idx;
        self.idx += 1;
        if len <= 1 {
            return 0;
        }
        match param(params, K, MODE) as usize {
            1 => len - 1 - (k % len as u64) as usize,
            2 => {
                let period = 2 * len as u64 - 2;
                let k = (k % period) as usize;
                if k < len {
                    k
                } else {
                    2 * len - 2 - k
                }
            }
            3 => {
                // xorshift32
                let mut x = self.rng;
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                self.rng = x;
                let mut j = (x as usize) % len;
                if j == self.last_pick {
                    j = (j + 1) % len;
                }
                self.last_pick = j;
                j
            }
            _ => (k % len as u64) as usize,
        }
    }

    /// The first grid step strictly after tick `t` (the transport clock).
    fn grid_after(t: f64, step: f64) -> f64 {
        ((t / step + 1e-6).floor() + 1.0) * step
    }

    /// Run the clock to this sub-block's start and emit what falls due (see
    /// "Timing" in the module docs). Called once per sub-block, before the
    /// modules render.
    pub fn tick(&mut self, ctx: &Ctx, params: &[f32], out: &mut NoteBuf) {
        let tpf = if ctx.ticks_per_frame.is_finite() && ctx.ticks_per_frame > 0.0 { ctx.ticks_per_frame } else { 0.0 };
        let span = RACK_BLOCK as f64 * tpf;
        let step = RATE_TICKS[(param(params, K, RATE) as usize).min(RATE_TICKS.len() - 1)];
        let latch = param(params, K, LATCH) >= 0.5;
        let playing = ctx.playing;

        if !(latch || self.pedal) && self.held[..self.n_held].iter().any(|k| !k.down) {
            self.drop_released(); // latch was turned off
            self.stop_if_empty(out);
        }
        // `expect` is NaN before the first tick: that counts as a jump too.
        let on_time = (ctx.ticks - self.expect).abs() <= 1e-6;
        let jumped = playing != self.was_playing || (playing && !on_time);
        if jumped && self.was_playing && !playing {
            self.drop_released(); // Stop clears a latch
            self.stop_if_empty(out);
        }
        if jumped {
            if let Some(n) = self.sounding.take() {
                out.push(NoteEvent::Off { note: n });
            }
            if !playing {
                self.free = 0.0;
            }
            if self.running {
                // On the new clock, as for a first key: the first grid step
                // whose frame falls after the previous boundary's, so a step
                // inside the sub-block ending here (the downbeat after a loop
                // wrap that lands mid-sub-block) plays now; stopped: at once.
                self.restart();
                self.next = if playing { Arp::grid_after(ctx.ticks - span + 0.5 * tpf, step) } else { 0.0 };
                self.start = false;
            }
        }
        self.was_playing = playing;
        self.expect = ctx.ticks + span;
        let now = if playing { ctx.ticks } else { self.free };

        if self.start {
            self.start = false;
            self.restart();
            // The first grid step after the previous boundary's frame: the
            // key arrived in the sub-block that ends here, so a step that
            // fell inside it (a pattern note on the grid) plays now.
            self.next = if playing { Arp::grid_after(now - span + 0.5 * tpf, step) } else { now };
        }

        // Due at this boundary: its frame rounds to at or before `now`'s.
        let due = |t: f64| if tpf > 0.0 { (t - now) / tpf < 0.5 } else { t <= now };
        let gate = (param(params, K, GATE) as f64).clamp(10.0, 100.0) / 100.0;
        let as_played = param(params, K, MODE) as usize == 4;
        for _ in 0..8 {
            let off = self.sounding.is_some() && due(self.off_at);
            let on = self.running && self.n_held > 0 && due(self.next);
            if off && (!on || self.off_at < self.next) {
                if let Some(n) = self.sounding.take() {
                    out.push(NoteEvent::Off { note: n });
                }
            } else if on {
                // Gate 100 % (the Off due with this step): the new On first,
                // then the old Off, so a mono MIDI In ties (or glides); the
                // same pitch again is just re-pressed.
                let old = self.sounding.take();
                let j = self.pick(params);
                let (note, vel) = self.note_at(j, as_played);
                out.push(NoteEvent::On { note, vel });
                if let Some(n) = old.filter(|&n| n != note) {
                    out.push(NoteEvent::Off { note: n });
                }
                self.sounding = Some(note);
                let t = self.next;
                // Never shorter than one sub-block: a note is never zero length.
                self.off_at = t + (step * gate).max(span);
                self.next = if playing { Arp::grid_after(t, step) } else { t + step };
            } else {
                break;
            }
        }
        if !playing {
            self.free += span;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48000.0;
    /// 120 BPM at 48 kHz: 25 frames per tick, a 1/16 (240 ticks) = 6000 frames.
    const TPF: f64 = 1.0 / 25.0;

    /// Params: rate, mode, octaves, gate %, latch.
    fn params(rate: f32, mode: f32, octaves: f32, gate: f32, latch: f32) -> [f32; 5] {
        [rate, mode, octaves, gate, latch]
    }

    /// Drive `arp` sub-block by sub-block for `frames` frames, as the rack
    /// does: key events (frame, event) arrive at the first boundary at or
    /// after their frame, before that boundary's tick. Playing: transport
    /// tick = `t0 + frame * TPF`. Returns (boundary frame, event) out.
    fn drive(arp: &mut Arp, p: &[f32], playing: bool, t0: f64, frames: usize, keys: &[(usize, NoteEvent)]) -> Vec<(usize, NoteEvent)> {
        let mut got = Vec::new();
        let mut b = 0;
        while b < frames {
            let mut out = NoteBuf::new();
            for &(f, e) in keys {
                if f <= b && (b < RACK_BLOCK || f > b - RACK_BLOCK) {
                    arp.input(e, p, &mut out);
                }
            }
            let ctx = Ctx { sr: SR as f32, bpm: 120.0, playing, ticks: t0 + b as f64 * TPF, ticks_per_frame: TPF };
            arp.tick(&ctx, p, &mut out);
            got.extend(out.as_slice().iter().map(|&e| (b, e)));
            b += RACK_BLOCK;
        }
        got
    }

    /// The first sub-block boundary at or after frame `f` (the rack's note resolution).
    fn boundary(f: f64) -> usize {
        (f.round() as usize).div_ceil(RACK_BLOCK) * RACK_BLOCK
    }

    fn ons(evs: &[(usize, NoteEvent)]) -> Vec<(usize, u8)> {
        evs.iter().filter_map(|&(f, e)| if let NoteEvent::On { note, .. } = e { Some((f, note)) } else { None }).collect()
    }

    fn offs(evs: &[(usize, NoteEvent)]) -> Vec<(usize, u8)> {
        evs.iter().filter_map(|&(f, e)| if let NoteEvent::Off { note } = e { Some((f, note)) } else { None }).collect()
    }

    fn on(note: u8) -> NoteEvent {
        NoteEvent::On { note, vel: 100 }
    }

    #[test]
    fn sixteenths_at_120_bpm_land_on_exact_ticks() {
        let mut a = Arp::new();
        let p = params(2.0, 0.0, 1.0, 50.0, 0.0);
        let steps = 64;
        let evs = drive(&mut a, &p, true, 0.0, steps * 6000, &[(0, on(60))]);
        let got = ons(&evs);
        assert_eq!(got.len(), steps);
        for (k, &(f, n)) in got.iter().enumerate() {
            // Step k at tick 240k = frame 6000k exactly: no drift after 64 steps.
            assert_eq!((f, n), (boundary(6000.0 * k as f64), 60), "step {k}");
        }
        // Gate 50 %: each Off at tick 240k + 120.
        let o = offs(&evs);
        for (k, &(f, _)) in o.iter().enumerate().take(steps - 1) {
            assert_eq!(f, boundary(6000.0 * k as f64 + 3000.0), "gate end {k}");
        }
    }

    #[test]
    fn every_rate_is_its_tick_length() {
        for (r, &ticks) in RATE_TICKS.iter().enumerate() {
            let mut a = Arp::new();
            let p = params(r as f32, 0.0, 1.0, 50.0, 0.0);
            let frames = (ticks * 25.0) as usize * 8;
            let got = ons(&drive(&mut a, &p, true, 0.0, frames, &[(0, on(60))]));
            let want: Vec<_> = (0..8).map(|k| (boundary(ticks * 25.0 * k as f64), 60)).collect();
            assert_eq!(got, want, "rate {r} ({ticks} ticks)");
        }
    }

    #[test]
    fn gate_length_follows_the_gate_param() {
        for gate in [10.0f32, 25.0, 99.0] {
            let mut a = Arp::new();
            let p = params(2.0, 0.0, 1.0, gate, 0.0);
            let evs = drive(&mut a, &p, true, 0.0, 3 * 6000, &[(0, on(60))]);
            let first_off = offs(&evs)[0].0;
            assert_eq!(first_off, boundary(6000.0 * gate as f64 / 100.0), "gate {gate} %");
        }
        // 100 %: one held pitch is re-pressed step after step, never let go.
        let mut a = Arp::new();
        let evs = drive(&mut a, &params(2.0, 0.0, 1.0, 100.0, 0.0), true, 0.0, 3 * 6000, &[(0, on(60))]);
        assert_eq!((ons(&evs).len(), offs(&evs).len()), (3, 0));
    }

    #[test]
    fn up_down_turns_at_the_edges_without_repeating_them() {
        let mut a = Arp::new();
        let p = params(2.0, 2.0, 1.0, 50.0, 0.0);
        let keys = [(0, on(67)), (0, on(60)), (0, on(64))];
        let notes: Vec<u8> = ons(&drive(&mut a, &p, true, 0.0, 9 * 6000, &keys)).iter().map(|x| x.1).collect();
        assert_eq!(notes, [60, 64, 67, 64, 60, 64, 67, 64, 60]);
        // Two octaves: 60 64 72 76, then back down.
        let mut a = Arp::new();
        let p = params(2.0, 2.0, 2.0, 50.0, 0.0);
        let notes: Vec<u8> = ons(&drive(&mut a, &p, true, 0.0, 8 * 6000, &[(0, on(60)), (0, on(64))])).iter().map(|x| x.1).collect();
        assert_eq!(notes, [60, 64, 72, 76, 72, 64, 60, 64]);
    }

    #[test]
    fn modes_down_and_as_played() {
        let keys = [(0, on(67)), (0, on(60)), (0, on(64))];
        let mut a = Arp::new();
        let notes: Vec<u8> = ons(&drive(&mut a, &params(2.0, 1.0, 1.0, 50.0, 0.0), true, 0.0, 4 * 6000, &keys)).iter().map(|x| x.1).collect();
        assert_eq!(notes, [67, 64, 60, 67]);
        let mut a = Arp::new();
        let notes: Vec<u8> = ons(&drive(&mut a, &params(2.0, 4.0, 1.0, 50.0, 0.0), true, 0.0, 4 * 6000, &keys)).iter().map(|x| x.1).collect();
        assert_eq!(notes, [67, 60, 64, 67]);
    }

    #[test]
    fn latch_holds_after_the_keys_are_released() {
        let p = params(2.0, 0.0, 1.0, 50.0, 1.0);
        let mut a = Arp::new();
        let keys = [(0, on(60)), (0, on(64)), (100, NoteEvent::Off { note: 60 }), (100, NoteEvent::Off { note: 64 })];
        let notes: Vec<u8> = ons(&drive(&mut a, &p, true, 0.0, 6 * 6000, &keys)).iter().map(|x| x.1).collect();
        assert_eq!(notes, [60, 64, 60, 64, 60, 64], "keeps playing after both keys are up");
        // Without latch it stops at the release, with an Off for the sounding note.
        let mut a = Arp::new();
        let evs = drive(&mut a, &params(2.0, 0.0, 1.0, 50.0, 0.0), true, 0.0, 6 * 6000, &keys);
        assert_eq!(ons(&evs), [(0, 60)]);
        assert_eq!(offs(&evs), [(128, 60)]);
        // A key pressed while none is down starts a new latched set.
        let mut a = Arp::new();
        let mut keys2 = keys.to_vec();
        keys2.push((11990, on(70))); // arrives just before the third step
        let notes: Vec<u8> = ons(&drive(&mut a, &p, true, 0.0, 5 * 6000, &keys2)).iter().map(|x| x.1).collect();
        assert_eq!(notes, [60, 64, 70, 70, 70]);
    }

    #[test]
    fn random_is_deterministic_and_restarts_with_the_pattern() {
        let p = params(3.0, 3.0, 2.0, 50.0, 0.0);
        let keys = [(0, on(60)), (0, on(63)), (0, on(67)), (0, on(70))];
        let run = || ons(&drive(&mut Arp::new(), &p, true, 0.0, 32 * 3000, &keys));
        let a = run();
        assert_eq!(a, run(), "same input, same notes");
        assert!(a.windows(2).all(|w| w[0].1 != w[1].1), "never the same pick twice in a row");
        let distinct: std::collections::BTreeSet<u8> = a.iter().map(|x| x.1).collect();
        assert!(distinct.len() >= 6, "spreads over the 8 notes: {distinct:?}");
        // A new pass (keys from silence) repeats the sequence.
        let mut arp = Arp::new();
        let mut keys2 = keys.to_vec();
        for n in [60, 63, 67, 70] {
            keys2.push((8 * 3000 - 10, NoteEvent::Off { note: n }));
        }
        for n in [60, 63, 67, 70] {
            keys2.push((8 * 3000, on(n)));
        }
        let b = ons(&drive(&mut arp, &p, true, 0.0, 16 * 3000, &keys2));
        let notes: Vec<u8> = b.iter().map(|x| x.1).collect();
        assert_eq!(notes[..8], notes[8..16]);
    }

    #[test]
    fn stopped_it_runs_on_its_own_clock_at_the_tempo() {
        let mut a = Arp::new();
        let p = params(2.0, 0.0, 1.0, 50.0, 0.0);
        // A key at frame 1000 (stopped): the first step at once, then every 6000 frames.
        let evs = drive(&mut a, &p, false, 0.0, 1000 + 5 * 6000, &[(1000, on(60))]);
        let start = boundary(1000.0);
        let got: Vec<usize> = ons(&evs).iter().map(|x| x.0).collect();
        let want: Vec<usize> = (0..5).map(|k| start + boundary(6000.0 * k as f64)).collect();
        assert_eq!(got, want);
    }

    #[test]
    fn a_key_off_the_grid_waits_for_the_next_step_and_play_resyncs() {
        let p = params(2.0, 0.0, 1.0, 50.0, 0.0);
        let mut a = Arp::new();
        let got = ons(&drive(&mut a, &p, true, 0.0, 3 * 6000, &[(1000, on(60))]));
        assert_eq!(got[0].0, boundary(6000.0), "the next 1/16 after the key");
        // Held while stopped, then the transport starts at tick 0: the
        // running note ends and the pattern restarts on the grid.
        let mut a = Arp::new();
        let mut out = NoteBuf::new();
        a.input(on(60), &p, &mut out);
        a.input(on(64), &p, &mut out);
        let stopped = Ctx { sr: 48000.0, bpm: 120.0, playing: false, ticks: 0.0, ticks_per_frame: TPF };
        a.tick(&stopped, &p, &mut out);
        assert_eq!(out.as_slice(), &[on(60)]);
        let evs = drive(&mut a, &p, true, 0.0, 2 * 6000, &[]);
        assert_eq!(evs[0], (0, NoteEvent::Off { note: 60 }));
        assert_eq!(ons(&evs), [(0, 60), (boundary(6000.0), 64)]);
        // Stop clears a latch.
        let p = params(2.0, 0.0, 1.0, 50.0, 1.0);
        let mut a = Arp::new();
        drive(&mut a, &p, true, 0.0, 6000, &[(0, on(60)), (10, NoteEvent::Off { note: 60 })]);
        let evs = drive(&mut a, &p, false, 0.0, 12000, &[]);
        assert!(ons(&evs).is_empty(), "silent after Stop: {evs:?}");
    }

    #[test]
    fn gate_100_puts_the_next_on_before_the_previous_off() {
        // Gate 100 %: the next step's On comes first, then the old note's Off,
        // on the same boundary, so a mono patch ties (or glides) step to step.
        let mut a = Arp::new();
        let p = params(2.0, 0.0, 1.0, 100.0, 0.0);
        let evs = drive(&mut a, &p, true, 0.0, 3 * 6000, &[(0, on(60)), (0, on(64))]);
        let at = boundary(6000.0);
        let there: Vec<NoteEvent> = evs.iter().filter(|e| e.0 == at).map(|e| e.1).collect();
        assert_eq!(there, [on(64), NoteEvent::Off { note: 60 }]);
        // The same pitch again: just the On (MIDI In re-presses it), no Off after it.
        let mut a = Arp::new();
        let evs = drive(&mut a, &p, true, 0.0, 3 * 6000, &[(0, on(60))]);
        let there: Vec<NoteEvent> = evs.iter().filter(|e| e.0 == at).map(|e| e.1).collect();
        assert_eq!(there, [on(60)]);
    }

    #[test]
    fn a_note_lasts_at_least_one_sub_block() {
        // 1/32 at gate 10 % = 12 ticks; at half a tick per frame that is 24
        // frames, less than a sub-block: the Off still waits for the next one.
        let tpf = 0.5;
        let mut a = Arp::new();
        let p = params(3.0, 0.0, 1.0, 10.0, 0.0);
        let mut out = NoteBuf::new();
        a.input(on(60), &p, &mut out);
        let mut got = Vec::new();
        for m in 0..40 {
            let b = m * RACK_BLOCK;
            let mut out = NoteBuf::new();
            let ctx = Ctx { sr: SR as f32, bpm: 1800.0, playing: true, ticks: b as f64 * tpf, ticks_per_frame: tpf };
            a.tick(&ctx, &p, &mut out);
            got.extend(out.as_slice().iter().map(|&e| (b, e)));
        }
        let (o, f) = (ons(&got), offs(&got));
        assert!(o.len() >= 3);
        for (k, &(t_on, _)) in o.iter().enumerate().take(3) {
            assert_eq!(f[k].0, t_on + RACK_BLOCK, "step {k}: the Off one sub-block after its On");
        }
    }

    #[test]
    fn passthrough_and_flush() {
        let p = params(2.0, 0.0, 1.0, 100.0, 0.0);
        let mut a = Arp::new();
        let mut out = NoteBuf::new();
        a.input(NoteEvent::Off { note: 50 }, &p, &mut out);
        a.input(NoteEvent::Bend(0.25), &p, &mut out);
        a.input(NoteEvent::Sustain(true), &p, &mut out);
        assert_eq!(out.as_slice(), &[NoteEvent::Off { note: 50 }, NoteEvent::Bend(0.25)], "pedal-down is the arp's");
        let mut up = NoteBuf::new();
        a.clone().input(NoteEvent::Sustain(false), &p, &mut up);
        assert_eq!(up.as_slice(), &[NoteEvent::Sustain(false)], "pedal-up reaches MIDI In");
        let evs = drive(&mut a, &p, true, 0.0, 6000, &[(0, on(60)), (10, NoteEvent::Off { note: 60 })]);
        assert_eq!(ons(&evs), [(0, 60)], "the pedal holds the released key");
        let mut out = NoteBuf::new();
        a.flush(&mut out);
        assert_eq!(out.as_slice(), &[NoteEvent::Off { note: 60 }]);
    }
}
