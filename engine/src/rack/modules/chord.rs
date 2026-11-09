//! Chord (kind 20, plan 26 Task 3): a note module. Every incoming note-on
//! becomes the chord's notes (`theory::voice_chord`: `type`, `inversion`, and
//! the song key for "In key"); its note-off releases exactly the notes that
//! note-on produced, even if the params or the key changed in between.
//!
//! A note module has no jacks and no `process`: the rack routes the MIDI note
//! stream through it before voice allocation (`Rack::note`; order Chord ->
//! Arp -> MIDI In, see docs/architecture/modular.md "Note modules").
//!
//! # Overlapping chords
//! Two held chords may share a pitch (C maj and E min both hold E and G).
//! The module counts how many sounding chords hold each output pitch: every
//! chord sends its On (MIDI In re-presses, i.e. retriggers, a sounding pitch),
//! but an Off goes out only when the last chord holding that pitch lets go,
//! so releasing one chord never cuts a note another still holds.
//!
//! An Off for a pitch with no chord recorded (pressed before the module was
//! added) passes through unchanged, so nothing is left hanging. Re-pressing a
//! held input pitch releases its old chord first. Allocation-free.

use super::theory::{voice_chord, Key, MAX_CHORD};
use super::{param, NoteBuf, NoteEvent};
use crate::rack::catalog::ModuleKind;

const TYPE: usize = 0;
const INVERSION: usize = 1;
const K: ModuleKind = ModuleKind::Chord;

#[derive(Clone)]
pub struct Chord {
    /// Per input pitch: the output pitches its note-on produced.
    made: [[u8; MAX_CHORD]; 128],
    made_n: [u8; 128],
    /// How many sounding chords hold each output pitch.
    count: [u8; 128],
}

impl Default for Chord {
    fn default() -> Self {
        Self::new()
    }
}

impl Chord {
    pub fn new() -> Chord {
        Chord { made: [[0; MAX_CHORD]; 128], made_n: [0; 128], count: [0; 128] }
    }

    /// Forget every held chord (no events: the caller silences the voices).
    pub fn reset(&mut self) {
        self.made_n = [0; 128];
        self.count = [0; 128];
    }

    /// Transform one event into `out` (see the module docs). Controllers
    /// pass through; `AllOff` passes through and forgets every chord.
    pub fn input(&mut self, ev: NoteEvent, params: &[f32], key: Key, out: &mut NoteBuf) {
        match ev {
            NoteEvent::On { note, vel } => {
                let n = (note & 127) as usize;
                if self.made_n[n] > 0 {
                    self.release(n, out);
                }
                let ty = param(params, K, TYPE).max(0.0) as usize;
                let inv = param(params, K, INVERSION).max(0.0) as usize;
                let mut pitches = [0u8; MAX_CHORD];
                let k = voice_chord(n as i32, ty, inv, key, &mut pitches);
                for &p in &pitches[..k] {
                    let c = &mut self.count[p as usize];
                    *c = c.saturating_add(1);
                    out.push(NoteEvent::On { note: p, vel });
                }
                self.made[n] = pitches;
                self.made_n[n] = k as u8;
            }
            NoteEvent::Off { note } => {
                let n = (note & 127) as usize;
                if self.made_n[n] > 0 {
                    self.release(n, out);
                } else {
                    out.push(ev);
                }
            }
            NoteEvent::AllOff => {
                self.reset();
                out.push(ev);
            }
            _ => out.push(ev),
        }
    }

    /// Release input pitch `n`'s chord: an Off per output pitch no other
    /// chord still holds.
    fn release(&mut self, n: usize, out: &mut NoteBuf) {
        let k = (self.made_n[n] as usize).min(MAX_CHORD);
        for &p in &self.made[n][..k] {
            let c = &mut self.count[p as usize];
            *c = c.saturating_sub(1);
            if *c == 0 {
                out.push(NoteEvent::Off { note: p });
            }
        }
        self.made_n[n] = 0;
    }

    /// The module is going away: an Off for every output pitch still held.
    pub fn flush(&mut self, out: &mut NoteBuf) {
        for (p, c) in self.count.iter().enumerate() {
            if *c > 0 {
                out.push(NoteEvent::Off { note: p as u8 });
            }
        }
        self.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::super::theory::DEFAULT_KEY;
    use super::*;

    fn run(c: &mut Chord, ev: NoteEvent, params: &[f32]) -> Vec<NoteEvent> {
        let mut out = NoteBuf::new();
        c.input(ev, params, DEFAULT_KEY, &mut out);
        out.as_slice().to_vec()
    }

    const IN_KEY: f32 = super::super::theory::IN_KEY as f32;

    #[test]
    fn note_on_makes_the_chord_and_note_off_releases_it() {
        let mut c = Chord::new();
        let on = run(&mut c, NoteEvent::On { note: 57, vel: 90 }, &[IN_KEY, 0.0]);
        let ons: Vec<_> = [57, 60, 64, 67].iter().map(|&n| NoteEvent::On { note: n, vel: 90 }).collect();
        assert_eq!(on, ons, "A3 In key in A minor = Am7");
        // The params change while held: the Off still releases what the On made.
        let off = run(&mut c, NoteEvent::Off { note: 57 }, &[0.0, 2.0]);
        let offs: Vec<_> = [57, 60, 64, 67].iter().map(|&n| NoteEvent::Off { note: n }).collect();
        assert_eq!(off, offs);
        // Nothing left: a second Off passes through as is.
        assert_eq!(run(&mut c, NoteEvent::Off { note: 57 }, &[0.0, 0.0]), [NoteEvent::Off { note: 57 }]);
    }

    #[test]
    fn fixed_types_and_inversions() {
        let mut c = Chord::new();
        // m9 on C4, inversion 1: C moves up an octave.
        let on = run(&mut c, NoteEvent::On { note: 60, vel: 100 }, &[5.0, 1.0]);
        let pitches: Vec<u8> = on.iter().map(|e| if let NoteEvent::On { note, .. } = e { *note } else { 0 }).collect();
        assert_eq!(pitches, [63, 67, 70, 72, 74]);
    }

    #[test]
    fn shared_pitches_stay_until_the_last_chord_lets_go() {
        let mut c = Chord::new();
        run(&mut c, NoteEvent::On { note: 60, vel: 100 }, &[0.0, 0.0]); // C E G
        run(&mut c, NoteEvent::On { note: 64, vel: 100 }, &[1.0, 0.0]); // E G B
        let off = run(&mut c, NoteEvent::Off { note: 60 }, &[0.0, 0.0]);
        assert_eq!(off, [NoteEvent::Off { note: 60 }], "E and G are still held by E minor");
        let off = run(&mut c, NoteEvent::Off { note: 64 }, &[0.0, 0.0]);
        assert_eq!(off, [64, 67, 71].map(|n| NoteEvent::Off { note: n }));
    }

    #[test]
    fn repress_flush_and_passthrough() {
        let mut c = Chord::new();
        run(&mut c, NoteEvent::On { note: 60, vel: 100 }, &[0.0, 0.0]);
        let again = run(&mut c, NoteEvent::On { note: 60, vel: 50 }, &[1.0, 0.0]);
        assert_eq!(&again[..3], &[60, 64, 67].map(|n| NoteEvent::Off { note: n }), "old chord released first");
        assert_eq!(&again[3..], &[60, 63, 67].map(|n| NoteEvent::On { note: n, vel: 50 }));
        assert_eq!(run(&mut c, NoteEvent::Bend(0.5), &[0.0, 0.0]), [NoteEvent::Bend(0.5)]);
        let mut out = NoteBuf::new();
        c.flush(&mut out);
        assert_eq!(out.as_slice(), &[60, 63, 67].map(|n| NoteEvent::Off { note: n }));
        assert_eq!(run(&mut c, NoteEvent::Off { note: 60 }, &[0.0, 0.0]), [NoteEvent::Off { note: 60 }], "flushed: passes through");
    }
}
