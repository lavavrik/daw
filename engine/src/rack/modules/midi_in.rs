//! MIDI In: turns note events into `pitch` / `gate` / `vel` / `mod` signals.
//!
//! Outputs: `pitch` (V/oct, `(note - 60)/12 + bend * range/12`), `gate`
//! (0/1), `vel` (CV 0..1) carry one channel per voice (`voices` in Poly, 1 in
//! Mono); `mod` is the mod wheel, always 1 channel.
//!
//! Events arrive between sub-blocks through [`MidiIn::note`] and take effect
//! in the next [`MidiIn::process`], so note timing resolves to one sub-block.
//!
//! # Poly
//! * A new note takes a free voice (never-used voices first, then the one
//!   whose gate went low longest ago, so fresh release tails survive); with none
//!   free it steals the voice whose current note-on is oldest (a monotonic
//!   counter, no clock). Re-pressing a sounding note reuses its voice.
//! * Retrigger gap: on a steal or re-press, that channel's gate is 0 for the
//!   whole next sub-block (32 frames) and 1 afterwards, so envelopes see a
//!   falling then a rising edge. Pitch updates immediately at note-on. The
//!   same gap is inserted if a voice is released and re-used before its
//!   previous gate-high block was emitted.
//! * Unused voices keep their last pitch (released notes' release tails stay
//!   in tune) and gate 0. Poly `vel` per voice is `vel/127`.
//! * Lowering `voices` while notes sound releases voices >= the new count.
//!
//! # Mono
//! * Last-note priority on 1 channel. Legato: a note pressed while another is
//!   held keeps the gate high (no retrigger). Releasing returns to the
//!   previous held note. `vel` follows the most recent note-on: it jumps to
//!   a note started from silence (an ADSR `vel` latches it on the rising
//!   gate) and glides 5 ms on a legato note.
//! * `glide` moves the pitch exponentially toward the target. Convention
//!   (same as the ADSR): the remaining distance is 1% after `glide` seconds,
//!   i.e. `tau = glide / ln(100)`. Poly mode ignores glide. `glide` 0 = off.
//! * `glide_mode` (plan 11) decides which notes glide. Each mono note-on sets
//!   a `gliding` flag: **Always** (0, the default and the pre-plan-11
//!   behaviour) sets it on every note; **Legato** (1) only when another note
//!   is held (the gate is already high), so a note from silence jumps to its
//!   pitch and only overlapping notes slide (the house "slide"). Without the
//!   flag the pitch snaps to the target. Returning to a held note on release
//!   keeps the flag of the last note-on. Poly ignores both modes.
//!
//! # Common
//! * Pitch bend (`Bend`, -1..1 times the `bend` range in semitones) and the
//!   mod wheel are ramped linearly across each sub-block from the previous
//!   block's value, so controller steps never zipper and the exact value is
//!   reached at the end of the first block after the event.
//! * Sustain: note-offs while the pedal is down are held until pedal-up.
//! * `AllOff` closes every gate and clears held and sustained notes (the
//!   pedal's own state is kept).
//! * Changing `mode` releases everything (no stuck notes across the switch).

use super::{param, NoteEvent, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::PortBuf;
use crate::{MAX_POLY, RACK_BLOCK};

const VOICES: usize = 0;
const MODE: usize = 1;
const GLIDE: usize = 2;
const BEND: usize = 3;
const GLIDE_MODE: usize = 4;
const K: ModuleKind = ModuleKind::MidiIn;

/// Depth of the mono held-note stack (oldest entries drop when exceeded).
const STACK: usize = 32;
const LN_100: f32 = 4.605_170_2;

#[derive(Clone, Copy)]
struct Voice {
    note: u8,
    /// Wants the gate high (key down, or held by the sustain pedal).
    gate: bool,
    /// Key physically down (false while only the pedal holds it).
    down: bool,
    vel: f32,
    /// `(note - 60)/12`, without bend.
    pitch: f32,
    /// Counter value at the current note-on (smallest = oldest).
    age: u64,
    /// Counter value when the gate last went low (0 = never used).
    released_at: u64,
    /// Output a 0 gate for the next sub-block before going high.
    retrig: bool,
    /// The last sub-block emitted gate 1 on this voice.
    emitted: bool,
}

impl Voice {
    const IDLE: Voice = Voice { note: 0, gate: false, down: false, vel: 0.0, pitch: 0.0, age: 0, released_at: 0, retrig: false, emitted: false };

    /// Close the gate, stamping when (for longest-released free-voice choice).
    fn release(&mut self, stamp: u64) {
        if self.gate {
            self.released_at = stamp;
        }
        self.gate = false;
        self.down = false;
    }

    /// The gate level to emit for this sub-block; consumes the retrigger gap.
    fn gate_out(&mut self) -> f32 {
        let g = if self.retrig {
            self.retrig = false;
            0.0
        } else if self.gate {
            1.0
        } else {
            0.0
        };
        self.emitted = g > 0.5;
        g
    }
}

/// An entry of the mono held-note stack.
#[derive(Clone, Copy)]
struct Held {
    note: u8,
    /// Key physically down (false while only the pedal holds it).
    down: bool,
}

#[derive(Clone)]
pub struct MidiIn {
    sr: f32,
    voices: [Voice; MAX_POLY],
    /// Monotonic note-on counter.
    counter: u64,
    stack: [Held; STACK],
    stack_len: usize,
    /// Mono: current (gliding) pitch and whether it was ever set.
    mono_pitch: f32,
    mono_init: bool,
    /// Mono: the current note glides (see `glide_mode`).
    gliding: bool,
    /// `glide_mode` is Legato (synced from the params like `mode`).
    legato: bool,
    mono_vel: Smooth,
    pedal: bool,
    /// Raw bend -1..1 and mod wheel 0..1, plus the values at the end of the
    /// previous block (ramp starts).
    bend: f32,
    bend_prev: f32,
    wheel: f32,
    wheel_prev: f32,
    mono: bool,
    /// Poly voice count in effect (1..=16).
    n_voices: usize,
}

/// `voices` param as a count in 1..=MAX_POLY.
fn voice_count(params: &[f32]) -> usize {
    (param(params, K, VOICES).max(1.0) as usize).min(MAX_POLY)
}

fn note_pitch(note: u8) -> f32 {
    (note.min(127) as f32 - 60.0) / 12.0
}

impl MidiIn {
    pub fn new(sr: f32) -> MidiIn {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        MidiIn {
            sr,
            voices: [Voice::IDLE; MAX_POLY],
            counter: 1,
            stack: [Held { note: 0, down: false }; STACK],
            stack_len: 0,
            mono_pitch: 0.0,
            mono_init: false,
            gliding: true,
            legato: false,
            mono_vel: Smooth::new(sr, 0.0),
            pedal: false,
            bend: 0.0,
            bend_prev: 0.0,
            wheel: 0.0,
            wheel_prev: 0.0,
            mono: false,
            n_voices: super::default(K, VOICES) as usize,
        }
    }

    /// Clear held notes and controllers (params untouched).
    pub fn reset(&mut self) {
        self.all_off();
        self.pedal = false;
        self.bend = 0.0;
        self.bend_prev = 0.0;
        self.wheel = 0.0;
        self.wheel_prev = 0.0;
        for v in self.voices.iter_mut() {
            v.retrig = false;
            v.emitted = false;
        }
    }

    /// A fresh, unique counter value for stamping events.
    fn stamp(&mut self) -> u64 {
        self.counter += 1;
        self.counter
    }

    fn all_off(&mut self) {
        let t = self.stamp();
        for v in self.voices.iter_mut() {
            v.release(t);
        }
        self.stack_len = 0;
    }

    /// Apply `mode` / `voices` changes (called before every event and block).
    fn sync(&mut self, params: &[f32]) {
        let mono = param(params, K, MODE) >= 0.5;
        if mono != self.mono {
            self.all_off();
            self.mono = mono;
        }
        let n = voice_count(params);
        if n < self.n_voices {
            let t = self.stamp();
            for v in self.voices.iter_mut().skip(n) {
                v.release(t);
            }
        }
        self.n_voices = n;
        self.legato = param(params, K, GLIDE_MODE) >= 0.5;
    }

    /// Deliver one event; `params` are the module's current param values.
    pub fn note(&mut self, ev: NoteEvent, params: &[f32]) {
        self.sync(params);
        match ev {
            NoteEvent::On { note, vel } if vel > 0 => self.note_on(note.min(127), vel.min(127)),
            NoteEvent::On { note, .. } | NoteEvent::Off { note } => self.note_off(note.min(127)),
            NoteEvent::Bend(b) => {
                if b.is_finite() {
                    self.bend = b.clamp(-1.0, 1.0);
                }
            }
            NoteEvent::Mod(m) => {
                if m.is_finite() {
                    self.wheel = m.clamp(0.0, 1.0);
                }
            }
            NoteEvent::Sustain(on) => self.sustain(on),
            NoteEvent::AllOff => self.all_off(),
        }
    }

    fn note_on(&mut self, note: u8, vel: u8) {
        let vel = vel as f32 / 127.0;
        let age = self.stamp();
        if self.mono {
            self.mono_note_on(note, vel);
            return;
        }
        let n = self.n_voices;
        // Re-press of a sounding note reuses its voice; otherwise a free
        // voice (released longest ago), otherwise steal the oldest note-on.
        let idx = self.voices[..n]
            .iter()
            .position(|v| v.gate && v.note == note)
            .or_else(|| self.voices[..n].iter().position(|v| !v.gate && v.released_at == 0))
            .or_else(|| longest_released(&self.voices[..n]))
            .or_else(|| oldest(&self.voices[..n], |_| true));
        let Some(v) = idx.and_then(|i| self.voices.get_mut(i)) else { return };
        // Gate was high in the last emitted block (re-press, steal, or a
        // release + re-use inside one block): force the 0 gap.
        v.retrig |= v.emitted;
        v.note = note;
        v.gate = true;
        v.down = true;
        v.vel = vel;
        v.pitch = note_pitch(note);
        v.age = age;
    }

    fn mono_note_on(&mut self, note: u8, vel: f32) {
        self.stack_remove(note);
        if self.stack_len == STACK {
            self.stack.copy_within(1.., 0);
            self.stack_len -= 1;
        }
        self.stack[self.stack_len] = Held { note, down: true };
        self.stack_len += 1;
        let v = &mut self.voices[0];
        // Legato mode glides only a note pressed while another is held.
        self.gliding = !self.legato || v.gate;
        if !v.gate {
            // Fresh press from silence (not legato).
            v.retrig |= v.emitted;
            v.gate = true;
            // An ADSR latches `vel` on this note's rising gate sample: it
            // must read this note's velocity, not a glide from the last one.
            self.mono_vel.snap();
        }
        v.vel = vel;
        v.down = true;
        self.mono_retarget();
    }

    fn note_off(&mut self, note: u8) {
        if self.mono {
            if let Some(h) = self.stack[..self.stack_len].iter_mut().find(|h| h.note == note && h.down) {
                if self.pedal {
                    h.down = false;
                } else {
                    self.stack_remove(note);
                }
            }
            self.mono_retarget();
        } else {
            let (pedal, t) = (self.pedal, self.stamp());
            if let Some(v) = self.voices.iter_mut().find(|v| v.gate && v.down && v.note == note) {
                if pedal {
                    v.down = false;
                } else {
                    v.release(t);
                }
            }
        }
    }

    fn sustain(&mut self, on: bool) {
        self.pedal = on;
        if on {
            return;
        }
        if self.mono {
            let mut w = 0;
            for r in 0..self.stack_len {
                if self.stack[r].down {
                    self.stack[w] = self.stack[r];
                    w += 1;
                }
            }
            self.stack_len = w;
            self.mono_retarget();
        } else {
            let t = self.stamp();
            for v in self.voices.iter_mut().filter(|v| v.gate && !v.down) {
                v.release(t);
            }
        }
    }

    fn stack_remove(&mut self, note: u8) {
        if let Some(i) = self.stack[..self.stack_len].iter().position(|h| h.note == note) {
            self.stack.copy_within(i + 1..self.stack_len, i);
            self.stack_len -= 1;
        }
    }

    /// Mono: gate and pitch target follow the top of the held stack.
    fn mono_retarget(&mut self) {
        let v = &mut self.voices[0];
        if self.stack_len == 0 {
            v.gate = false;
            v.down = false;
            return;
        }
        let top = self.stack[self.stack_len - 1].note;
        v.note = top;
        v.pitch = note_pitch(top);
        if !self.mono_init {
            self.mono_init = true;
            self.mono_pitch = v.pitch;
        }
    }

    pub fn process(&mut self, params: &[f32], outs: &mut [PortBuf]) {
        self.sync(params);
        // Port order: pitch, gate, vel, mod.
        let [pitch, gate, vel, wheel] = outs else { return };
        let range = param(params, K, BEND).clamp(0.0, 12.0) / 12.0;
        let (b0, b1) = (self.bend_prev * range, self.bend * range);
        let (w0, w1) = (self.wheel_prev, self.wheel);
        self.bend_prev = self.bend;
        self.wheel_prev = self.wheel;
        let ramp = |a: f32, b: f32, i: usize| a + (b - a) * ((i + 1) as f32 / RACK_BLOCK as f32);

        wheel.channels = 1;
        for i in 0..RACK_BLOCK {
            wheel.data[0][i] = ramp(w0, w1, i);
        }

        if self.mono {
            let (pitch, gate, vel) = (&mut *pitch, &mut *gate, &mut *vel);
            pitch.channels = 1;
            gate.channels = 1;
            vel.channels = 1;
            let target = self.voices[0].pitch;
            let glide = param(params, K, GLIDE).clamp(0.0, 2.0);
            let coef = if glide > 0.0 { 1.0 - (-LN_100 / (glide * self.sr)).exp() } else { 1.0 };
            if !self.gliding {
                self.mono_pitch = target;
            }
            let g = self.voices[0].gate_out();
            let vel_target = self.voices[0].vel;
            for i in 0..RACK_BLOCK {
                let d = target - self.mono_pitch;
                self.mono_pitch = if d.abs() < 1e-7 { target } else { self.mono_pitch + d * coef };
                pitch.data[0][i] = self.mono_pitch + ramp(b0, b1, i);
                gate.data[0][i] = g;
                vel.data[0][i] = self.mono_vel.next(vel_target);
            }
        } else {
            let n = self.n_voices;
            pitch.channels = n;
            gate.channels = n;
            vel.channels = n;
            for (ch, v) in self.voices[..n].iter_mut().enumerate() {
                let g = v.gate_out();
                for i in 0..RACK_BLOCK {
                    pitch.data[ch][i] = v.pitch + ramp(b0, b1, i);
                    gate.data[ch][i] = g;
                    vel.data[ch][i] = v.vel;
                }
            }
        }
    }
}

/// The free voice whose gate went low longest ago (smallest `released_at`).
fn longest_released(voices: &[Voice]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, v) in voices.iter().enumerate() {
        if !v.gate && best.is_none_or(|b| v.released_at < voices[b].released_at) {
            best = Some(i);
        }
    }
    best
}

/// Index of the matching voice with the smallest age (ties: lowest index).
fn oldest(voices: &[Voice], pick: impl Fn(&Voice) -> bool) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, v) in voices.iter().enumerate() {
        if pick(v) && best.is_none_or(|b| v.age < voices[b].age) {
            best = Some(i);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rack::modules::adsr::Adsr;
    use crate::MAX_PARAMS;

    const SR: f32 = 48000.0;
    // Output port indices (catalog order).
    const PITCH: usize = 0;
    const GATE: usize = 1;
    const VEL: usize = 2;
    const MOD: usize = 3;

    struct Rig {
        m: MidiIn,
        p: [f32; MAX_PARAMS],
        outs: [PortBuf; 4],
    }

    impl Rig {
        fn new() -> Rig {
            let mut p = [0.0f32; MAX_PARAMS];
            for (i, s) in p.iter_mut().zip(crate::rack::catalog::spec(K).params) {
                *i = s.default;
            }
            Rig { m: MidiIn::new(SR), p, outs: [PortBuf::new(), PortBuf::new(), PortBuf::new(), PortBuf::new()] }
        }
        fn ev(&mut self, e: NoteEvent) {
            self.m.note(e, &self.p);
        }
        fn on(&mut self, n: u8) {
            self.ev(NoteEvent::On { note: n, vel: 127 });
        }
        fn off(&mut self, n: u8) {
            self.ev(NoteEvent::Off { note: n });
        }
        fn block(&mut self) {
            self.m.process(&self.p, &mut self.outs);
        }
        fn gate(&self, ch: usize) -> f32 {
            self.outs[GATE].data[ch][RACK_BLOCK - 1]
        }
        fn pitch(&self, ch: usize) -> f32 {
            self.outs[PITCH].data[ch][RACK_BLOCK - 1]
        }
    }

    #[test]
    fn poly_assigns_distinct_voices() {
        let mut r = Rig::new();
        for n in [60, 64, 67] {
            r.on(n);
        }
        r.block();
        r.block();
        assert_eq!(r.outs[GATE].channels, 8);
        let mut ps: Vec<f32> = (0..3).map(|c| r.pitch(c)).collect();
        for (c, n) in [60, 64, 67].iter().enumerate() {
            assert_eq!(r.gate(c), 1.0);
            assert!((r.pitch(c) - (*n as f32 - 60.0) / 12.0).abs() < 1e-6);
        }
        ps.dedup();
        assert_eq!(ps.len(), 3);
        assert_eq!(r.gate(3), 0.0);
        assert!((r.outs[VEL].data[0][0] - 1.0).abs() < 1e-6);
        assert_eq!(r.outs[MOD].channels, 1);
    }

    #[test]
    fn voice_steal_retriggers_without_jump() {
        let mut r = Rig::new();
        r.p[VOICES] = 2.0;
        let mut env = Adsr::new(SR);
        let (a, d, s, rel) = (0.005f32, 0.2f32, 0.7f32, 0.3f32);
        let mut ep = [0.0f32; MAX_PARAMS];
        ep[..4].copy_from_slice(&[a, d, s, rel]);
        let mut e_out = [PortBuf::new()];
        let env_run = |r: &Rig, env: &mut Adsr, e_out: &mut [PortBuf; 1], trace: &mut Vec<f32>| {
            let mut g = [PortBuf::new()];
            g[0].channels = 2;
            g[0].data[0] = r.outs[GATE].data[0];
            g[0].data[1] = r.outs[GATE].data[1];
            env.process(&ep, &g, e_out);
            trace.extend_from_slice(&e_out[0].data[0]);
        };
        let mut trace = Vec::new();
        let mut gates = Vec::new();
        r.on(60);
        r.on(62);
        for _ in 0..40 {
            r.block();
            gates.push(r.gate(0));
            env_run(&r, &mut env, &mut e_out, &mut trace);
        }
        r.on(64); // steals voice 0 (oldest note-on)
        for _ in 0..40 {
            r.block();
            gates.push(r.gate(0));
            env_run(&r, &mut env, &mut e_out, &mut trace);
        }
        assert!((r.pitch(0) - 4.0 / 12.0).abs() < 1e-6, "voice 0 plays 64 now");
        assert!((r.pitch(1) - 2.0 / 12.0).abs() < 1e-6, "voice 1 untouched");
        // One sub-block of 0 between the two highs.
        assert_eq!(&gates[39..42], &[1.0, 0.0, 1.0]);
        assert_eq!(gates[41..].iter().filter(|&&g| g == 0.0).count(), 0);
        // The envelope fell during the gap (retriggered) and never jumped.
        let slope = 1.0 / (a * SR);
        assert!(trace.windows(2).all(|w| (w[1] - w[0]).abs() <= slope * 1.001));
        let gap = &trace[40 * RACK_BLOCK..41 * RACK_BLOCK];
        assert!(gap[RACK_BLOCK - 1] < gap[0], "envelope releases during the gap");
        let after = trace[41 * RACK_BLOCK];
        assert!(after > gap[RACK_BLOCK - 1], "attack resumes after the gap");
    }

    #[test]
    fn repress_reuses_voice_with_gap() {
        let mut r = Rig::new();
        r.on(60);
        r.block();
        r.on(60);
        r.block();
        assert_eq!(r.gate(0), 0.0, "gap block");
        r.block();
        assert_eq!(r.gate(0), 1.0);
        assert_eq!(r.gate(1), 0.0, "no second voice used");
    }

    #[test]
    fn free_voice_prefers_longest_released() {
        let mut r = Rig::new();
        r.p[VOICES] = 2.0;
        r.on(60); // A (long) -> voice 0
        r.on(62); // B (short) -> voice 1
        r.block();
        r.off(62); // B released first
        r.block();
        r.off(60); // A released later: its tail is the freshest
        r.block();
        r.on(64); // C must reuse B's voice (1), not A's (0)
        r.block();
        assert_eq!(r.gate(1), 1.0);
        assert!((r.pitch(1) - 4.0 / 12.0).abs() < 1e-6);
        assert_eq!(r.gate(0), 0.0);
        assert!((r.pitch(0) - 0.0).abs() < 1e-6, "A's tail keeps its pitch");
    }

    #[test]
    fn steal_takes_oldest_even_when_not_voice_zero() {
        let mut r = Rig::new();
        r.p[VOICES] = 2.0;
        r.on(60);
        r.on(62);
        r.block();
        r.on(60); // re-press: voice 0 becomes the newest, voice 1 (62) oldest
        r.block();
        r.block();
        r.on(64);
        r.block();
        assert_eq!(r.gate(1), 0.0, "voice 1 stolen: gap");
        assert!((r.pitch(1) - 4.0 / 12.0).abs() < 1e-6);
        assert!((r.pitch(0) - 0.0).abs() < 1e-6, "voice 0 untouched");
        assert_eq!(r.gate(0), 1.0);
    }

    #[test]
    fn mono_release_of_non_top_note_keeps_top() {
        let mut r = Rig::new();
        r.p[MODE] = 1.0;
        r.on(48);
        r.on(55);
        r.on(60);
        r.off(55);
        r.block();
        assert!((r.pitch(0) - 0.0).abs() < 1e-6, "still 60");
        r.off(60);
        r.block();
        assert_eq!(r.gate(0), 1.0);
        assert!((r.pitch(0) - (48.0 - 60.0) / 12.0).abs() < 1e-6, "back to 48");
    }

    #[test]
    fn mono_legato_no_retrigger_and_returns_to_held_note() {
        let mut r = Rig::new();
        r.p[MODE] = 1.0;
        r.on(48);
        r.block();
        assert_eq!(r.outs[GATE].channels, 1);
        assert_eq!(r.gate(0), 1.0);
        r.on(55);
        for _ in 0..3 {
            r.block();
            assert!(r.outs[GATE].data[0].iter().all(|&g| g == 1.0), "legato: gate stays high");
        }
        assert!((r.pitch(0) - (55.0 - 60.0) / 12.0).abs() < 1e-6);
        r.off(55);
        r.block();
        assert_eq!(r.gate(0), 1.0, "still holding 48");
        assert!((r.pitch(0) - (48.0 - 60.0) / 12.0).abs() < 1e-6);
        r.off(48);
        r.block();
        assert_eq!(r.gate(0), 0.0);
    }

    #[test]
    fn glide_reaches_target_in_time() {
        let mut r = Rig::new();
        r.p[MODE] = 1.0;
        r.p[GLIDE] = 0.1;
        r.on(48);
        r.block();
        r.on(60);
        let blocks = (0.3 * SR) as usize / RACK_BLOCK;
        let mut first = 0.0;
        for b in 0..blocks {
            r.block();
            if b == 0 {
                first = r.pitch(0);
            }
        }
        assert!(r.pitch(0).abs() < 0.01, "pitch {}", r.pitch(0));
        assert!(first < -0.5, "glides rather than jumps: {first}");
    }

    #[test]
    fn bend_range_applied() {
        let mut r = Rig::new();
        r.on(60);
        r.ev(NoteEvent::Bend(1.0));
        r.block();
        assert!((r.pitch(0) - 2.0 / 12.0).abs() < 1e-6);
        // Ramped across the block, no step.
        assert!(r.outs[PITCH].data[0][0] < r.outs[PITCH].data[0][RACK_BLOCK - 1]);
        r.p[BEND] = 12.0;
        r.block();
        assert!((r.pitch(0) - 1.0).abs() < 1e-6);
        r.ev(NoteEvent::Mod(0.5));
        r.block();
        assert!((r.outs[MOD].data[0][RACK_BLOCK - 1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn sustain_holds_until_pedal_up() {
        let mut r = Rig::new();
        r.ev(NoteEvent::Sustain(true));
        r.on(60);
        r.off(60);
        r.block();
        r.block();
        assert_eq!(r.gate(0), 1.0, "held by pedal");
        r.on(62);
        r.block();
        assert_eq!(r.gate(1), 1.0);
        r.ev(NoteEvent::Sustain(false));
        r.block();
        assert_eq!(r.gate(0), 0.0);
        assert_eq!(r.gate(1), 1.0, "key 62 still down");
        // Mono variant.
        let mut m = Rig::new();
        m.p[MODE] = 1.0;
        m.ev(NoteEvent::Sustain(true));
        m.on(60);
        m.off(60);
        m.block();
        assert_eq!(m.gate(0), 1.0);
        m.ev(NoteEvent::Sustain(false));
        m.block();
        assert_eq!(m.gate(0), 0.0);
    }

    #[test]
    fn all_off_closes_gates() {
        for mono in [0.0, 1.0] {
            let mut r = Rig::new();
            r.p[MODE] = mono;
            r.ev(NoteEvent::Sustain(true));
            for n in [60, 64, 67] {
                r.on(n);
            }
            r.off(67);
            r.block();
            r.ev(NoteEvent::AllOff);
            r.block();
            assert!((0..r.outs[GATE].channels).all(|c| r.gate(c) == 0.0));
            r.ev(NoteEvent::Sustain(false));
            r.block();
            assert!((0..r.outs[GATE].channels).all(|c| r.gate(c) == 0.0), "nothing left held");
        }
    }

    #[test]
    fn lowering_voices_releases_upper_voices() {
        let mut r = Rig::new();
        for n in [60, 62, 64, 65] {
            r.on(n);
        }
        r.block();
        r.p[VOICES] = 2.0;
        r.block();
        assert_eq!(r.outs[GATE].channels, 2);
        assert_eq!(r.gate(0), 1.0);
        r.p[VOICES] = 4.0;
        r.block();
        assert_eq!(r.outs[GATE].channels, 4);
        assert_eq!(r.gate(2), 0.0, "released when the count dropped");
        assert_eq!(r.gate(3), 0.0);
    }

    #[test]
    fn velocity_and_zero_velocity_note_on() {
        let mut r = Rig::new();
        r.ev(NoteEvent::On { note: 60, vel: 64 });
        r.block();
        assert!((r.outs[VEL].data[0][0] - 64.0 / 127.0).abs() < 1e-6);
        r.ev(NoteEvent::On { note: 60, vel: 0 });
        r.block();
        assert_eq!(r.gate(0), 0.0);
    }

    // ---- plan 11: glide modes --------------------------------------------

    /// A frozen model of the mono pitch before plan 11 (glide always on):
    /// last-note priority over the held keys, then per sample
    /// `p += (target − p)·coef`, snapping within 1e-7. Do not edit.
    struct RefMono {
        held: Vec<u8>,
        target: f32,
        p: Option<f32>,
        coef: f32,
    }

    impl RefMono {
        fn on(&mut self, n: u8) {
            self.held.retain(|&h| h != n);
            self.held.push(n);
            self.retarget();
        }
        fn off(&mut self, n: u8) {
            self.held.retain(|&h| h != n);
            self.retarget();
        }
        fn retarget(&mut self) {
            if let Some(&top) = self.held.last() {
                self.target = (top as f32 - 60.0) / 12.0;
                self.p.get_or_insert(self.target);
            }
        }
        fn block(&mut self) -> [f32; RACK_BLOCK] {
            let mut out = [0.0; RACK_BLOCK];
            let Some(mut p) = self.p else { return out };
            for o in out.iter_mut() {
                let d = self.target - p;
                p = if d.abs() < 1e-7 { self.target } else { p + d * self.coef };
                *o = p;
            }
            self.p = Some(p);
            out
        }
    }

    #[test]
    fn midi_in_glide_always_is_unchanged() {
        // glide_mode Always (0) and a pre-plan-11 param slice (no glide_mode
        // entry at all) both match the frozen model sample-exactly.
        for short in [false, true] {
            let mut r = Rig::new();
            r.p[MODE] = 1.0;
            r.p[GLIDE] = 0.05;
            r.p[GLIDE_MODE] = 0.0;
            let coef = 1.0 - (-LN_100 / (0.05 * SR)).exp();
            let mut m = RefMono { held: Vec::new(), target: 0.0, p: None, coef };
            // (block, note, on): from silence, legato up, back, release,
            // then a fresh note from silence (which glides in Always).
            let script: &[(usize, u8, bool)] =
                &[(0, 48, true), (20, 55, true), (60, 55, false), (100, 48, false), (130, 60, true), (200, 67, true)];
            let n = if short { 4 } else { MAX_PARAMS };
            for b in 0..260 {
                for &(_, note, on) in script.iter().filter(|s| s.0 == b) {
                    let ev = if on { NoteEvent::On { note, vel: 100 } } else { NoteEvent::Off { note } };
                    r.m.note(ev, &r.p[..n]);
                    if on { m.on(note) } else { m.off(note) }
                }
                r.m.process(&r.p[..n], &mut r.outs);
                let want = m.block();
                if m.p.is_some() {
                    for (i, (got, want)) in r.outs[PITCH].data[0].iter().zip(want).enumerate() {
                        assert_eq!(got.to_bits(), want.to_bits(), "short {short} block {b} i {i}");
                    }
                }
            }
        }
    }

    #[test]
    fn legato_mode_glides_only_on_overlap() {
        let mut r = Rig::new();
        r.p[MODE] = 1.0;
        r.p[GLIDE] = 0.1;
        r.p[GLIDE_MODE] = 1.0;
        r.on(60);
        r.block();
        assert_eq!(r.outs[PITCH].data[0][0], 0.0, "first note: at pitch at once");
        // Overlapped 60 -> 62: glides.
        r.on(62);
        r.block();
        let first = r.outs[PITCH].data[0][0];
        assert!(first > 0.0 && first < 1.0 / 12.0, "glides from 60: {first}");
        for _ in 0..(0.3 * SR) as usize / RACK_BLOCK {
            r.block();
        }
        assert!((r.pitch(0) - 2.0 / 12.0).abs() < 1e-3);
        // Released, then 62 -> 60 pressed from silence: jumps within one sample.
        r.off(62);
        r.off(60);
        r.block();
        assert_eq!(r.gate(0), 0.0);
        r.on(60);
        r.block();
        assert_eq!(r.outs[PITCH].data[0][0], 0.0, "from silence: no glide");
        // Released, 60 off then 62 on (not overlapping): jumps.
        r.off(60);
        r.block();
        r.on(62);
        r.block();
        assert_eq!(r.outs[PITCH].data[0][0], 2.0 / 12.0, "not overlapping: jumps");
        // Poly ignores both modes (no glide), as before.
        let mut p = Rig::new();
        p.p[GLIDE] = 0.1;
        p.p[GLIDE_MODE] = 1.0;
        p.on(60);
        p.block();
        p.on(64);
        p.block();
        assert_eq!(p.outs[PITCH].data[1][0], 4.0 / 12.0);
    }
}
