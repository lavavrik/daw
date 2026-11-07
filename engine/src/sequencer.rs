//! Note patterns: the piano-roll sequencer of a synth track.
//!
//! Each synth track owns `MAX_PATTERNS` [`NotePattern`]s (one of them current,
//! see `synth.rs`), each with up to `MAX_NOTES` note slots
//! (fixed storage, preallocated with the track, so editing and playback never
//! allocate) and a length of 1..=`MAX_PATTERN_BARS` bars.
//!
//! # Playback rules
//! * The pattern loops on its own length (`bars * BAR_TICKS`) from tick 0.
//! * A note plays only if it *starts* inside the pattern; notes starting at or
//!   after the pattern end are kept but silent (FL-like, like drum steps beyond
//!   the step count), so growing the pattern again brings them back.
//! * A note's On lands at `start`, its Off at `(start + len') mod period`,
//!   where `len' = min(len, period)`: a note longer than the pattern is cut at
//!   the period, so it never overlaps its own next On.
//! * Ticks below 0 (the count-in) never produce events; a window crossing 0
//!   yields only the events at ticks `>= 0`.
//! * The rack applies notes at `RACK_BLOCK` (32-frame) boundaries, so a note
//!   shorter than one sub-block (about 1.3 ticks at 120 BPM, 48 kHz) may have
//!   its On and Off land together and never open the gate.
//!
//! # Sounding set (per pitch)
//! The pattern tracks which pitches it has switched on (a 128-bit set) and
//! which note slot last switched each one on (its "holder").
//! * An Off is only emitted for a pitch in the set, so an Off whose On never
//!   played (e.g. the wrapped tail of a note in the very first loop) is
//!   dropped.
//! * Same-pitch notes may overlap. The set is per pitch, so *any* Off of a
//!   pitch releases it, even while another note of that pitch is still within
//!   its span (FL-like; it can never leave a note hanging).
//! * Editing or removing the note slot that holds a sounding pitch returns
//!   that pitch so the caller can release it ([`NotePattern::set`],
//!   [`NotePattern::remove`]). Editing another, silent note of the same pitch
//!   does not cut the sounding one. Re-sending an identical note is a no-op.
//! * Changing the length, clearing, or stopping releases every sounding pitch
//!   (the loop phase jumps when the length changes, so held notes could
//!   otherwise end at the wrong time).
//!
//! # Event order and capacity
//! [`NotePattern::events`] appends `(sample offset, NoteEvent)` pairs to an
//! [`EventBuf`] in offset order; at the same offset Offs come before Ons, so a
//! note ending where the next same-pitch note starts retriggers cleanly. The
//! buffer holds `EVENT_CAP` events. Ons are only accepted while there is still
//! room for an Off for every sounding pitch afterwards
//! (`len + 1 + sounding <= EVENT_CAP`), so on overflow extra Ons are dropped
//! and Offs are never dropped.

use crate::rack::modules::NoteEvent;
use crate::transport::tick_to_offset;
use crate::{BAR_TICKS, MAX_NOTES, MAX_PATTERN_BARS};

/// Capacity of an [`EventBuf`] (events per track per block).
pub const EVENT_CAP: usize = 256;
/// Pattern length of a new synth track, in bars.
pub const DEFAULT_BARS: u8 = 4;
/// Longest note and the end of the latest start: `MAX_PATTERN_BARS` bars.
pub const MAX_NOTE_TICKS: u32 = (MAX_PATTERN_BARS as u32) * (BAR_TICKS as u32);

/// Candidates per scan segment: one On and one Off per note.
const SCRATCH: usize = 2 * MAX_NOTES;
/// Loop instances a single window may visit (a real block spans at most two).
const MAX_SEGMENTS: usize = 8;

// Candidate sort key: offset | Off-before-On flag | relative tick | note idx.
const KEY_IDX_BITS: u32 = 10; // MAX_NOTES = 1024
const KEY_TICK_BITS: u32 = 16; // ticks within a period < 61440 < 65536
const KEY_TICK_SHIFT: u32 = KEY_IDX_BITS;
const KEY_ON_SHIFT: u32 = KEY_IDX_BITS + KEY_TICK_BITS;
const KEY_OFFSET_SHIFT: u32 = KEY_ON_SHIFT + 1;
/// Offsets are clamped to this so the key never overflows.
const MAX_KEY_OFFSET: u64 = (1 << (64 - KEY_OFFSET_SHIFT)) - 1;

/// One note of a pattern. `start` and `len` are in ticks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeqNote {
    /// Slot in use (an inactive slot is ignored by playback).
    pub active: bool,
    /// MIDI pitch 0..=127.
    pub pitch: u8,
    /// Velocity 1..=127.
    pub vel: u8,
    /// Start tick, 0..`MAX_NOTE_TICKS`.
    pub start: u32,
    /// Length in ticks, 1..=`MAX_NOTE_TICKS`.
    pub len: u32,
}

impl SeqNote {
    /// An empty slot.
    pub const OFF: SeqNote = SeqNote { active: false, pitch: 0, vel: 0, start: 0, len: 0 };
}

/// Fixed-capacity list of `(sample offset, event)` for one track and block,
/// plus the sort scratch [`NotePattern::events`] uses. Allocated once.
pub struct EventBuf {
    events: [(usize, NoteEvent); EVENT_CAP],
    len: usize,
    scratch: [u64; SCRATCH],
}

impl EventBuf {
    /// An empty buffer (about 20 KB: keep it on the heap).
    pub fn new() -> EventBuf {
        EventBuf { events: [(0, NoteEvent::AllOff); EVENT_CAP], len: 0, scratch: [0; SCRATCH] }
    }

    /// Drop all events.
    pub fn clear(&mut self) {
        self.len = 0;
    }

    /// The events, in offset order.
    pub fn as_slice(&self) -> &[(usize, NoteEvent)] {
        &self.events[..self.len]
    }
}

impl Default for EventBuf {
    fn default() -> Self {
        Self::new()
    }
}

/// A synth track's note pattern (see the module docs).
pub struct NotePattern {
    notes: [SeqNote; MAX_NOTES],
    bars: u8,
    /// High-water mark: every active note has an index below this.
    used: usize,
    /// Pitches this pattern has switched on and not yet off (bit = pitch).
    sounding: u128,
    /// Note slot whose On last switched each pitch on.
    holder: [u16; 128],
}

impl NotePattern {
    /// Empty, `DEFAULT_BARS` long.
    pub fn new() -> NotePattern {
        NotePattern { notes: [SeqNote::OFF; MAX_NOTES], bars: DEFAULT_BARS, used: 0, sounding: 0, holder: [0; 128] }
    }

    /// Back to [`NotePattern::new`] (no allocation). Returns the pitches that
    /// were sounding, for the caller to release.
    pub fn reset(&mut self) -> u128 {
        let released = self.clear();
        self.bars = DEFAULT_BARS;
        released
    }

    /// Length in bars.
    pub fn bars(&self) -> u8 {
        self.bars
    }

    /// Loop length in ticks.
    pub fn period(&self) -> f64 {
        self.bars as f64 * BAR_TICKS
    }

    /// High-water mark of note slots in use.
    pub fn used(&self) -> usize {
        self.used
    }

    /// Note slot `idx` (`None` if out of range).
    pub fn note(&self, idx: usize) -> Option<SeqNote> {
        self.notes.get(idx).copied()
    }

    /// Pitches currently switched on by the pattern (bit = pitch).
    pub fn sounding(&self) -> u128 {
        self.sounding
    }

    /// Store `note` in slot `idx` (an out-of-range `idx` is ignored). Returns
    /// the pitch to release if the slot's previous note was the one holding a
    /// sounding pitch. An identical note changes nothing.
    pub fn set(&mut self, idx: usize, note: SeqNote) -> Option<u8> {
        let note = sanitize(note);
        let slot = self.notes.get_mut(idx)?;
        let old = *slot;
        if old == note {
            return None;
        }
        *slot = note;
        if note.active && idx >= self.used {
            self.used = idx + 1;
        }
        if old.active && self.holds(old.pitch, idx) {
            self.sounding &= !bit(old.pitch);
            return Some(old.pitch);
        }
        None
    }

    /// Is `pitch` sounding, switched on by note slot `idx`?
    fn holds(&self, pitch: u8, idx: usize) -> bool {
        self.sounding & bit(pitch) != 0 && self.holder.get(pitch as usize).is_some_and(|&h| h as usize == idx)
    }

    /// Empty slot `idx`; returns the pitch to release if it was sounding.
    pub fn remove(&mut self, idx: usize) -> Option<u8> {
        self.set(idx, SeqNote::OFF)
    }

    /// Remove every note. Returns the pitches that were sounding.
    pub fn clear(&mut self) -> u128 {
        if let Some(notes) = self.notes.get_mut(..self.used) {
            notes.fill(SeqNote::OFF);
        }
        self.used = 0;
        self.release_all()
    }

    /// Become a copy of `src` (notes and length; no allocation, copies only
    /// the slots either pattern uses). Returns the pitches *this* pattern was
    /// sounding, for the caller to release; the copy starts silent.
    pub fn copy_from(&mut self, src: &NotePattern) -> u128 {
        let (n, old) = (src.used.min(MAX_NOTES), self.used.min(MAX_NOTES));
        if let (Some(dst), Some(from)) = (self.notes.get_mut(..n), src.notes.get(..n)) {
            dst.copy_from_slice(from);
        }
        if let Some(stale) = self.notes.get_mut(n..old.max(n)) {
            stale.fill(SeqNote::OFF);
        }
        self.used = n;
        self.bars = src.bars;
        self.release_all()
    }

    /// Set the length (clamped to 1..=`MAX_PATTERN_BARS`). A real change
    /// releases every sounding pitch (returned); the same length is a no-op.
    pub fn set_bars(&mut self, bars: u8) -> u128 {
        let bars = bars.clamp(1, MAX_PATTERN_BARS as u8);
        if bars == self.bars {
            return 0;
        }
        self.bars = bars;
        self.release_all()
    }

    /// Forget every sounding pitch and return them (Stop).
    pub fn release_all(&mut self) -> u128 {
        core::mem::take(&mut self.sounding)
    }

    /// Clear `out` and fill it with this block's events: the window is the
    /// transport's `[t0, t1)` in ticks, `spt` samples per tick and `frames` the
    /// block length (offsets are clamped to `frames - 1`). See the module docs
    /// for ordering, the count-in and overflow.
    pub fn events(&mut self, t0: f64, t1: f64, spt: f64, frames: usize, out: &mut EventBuf) {
        out.clear();
        let valid = t0.is_finite() && t1.is_finite() && t1 > t0 && spt.is_finite() && spt > 0.0;
        if !valid || t1 <= 0.0 {
            return; // garbage, or entirely inside the count-in
        }
        let period = self.period();
        let from = t0.max(0.0); // the count-in part of the window plays nothing
        // One segment per loop instance the window touches, in time order.
        let mut k = (from / period).floor();
        for _ in 0..MAX_SEGMENTS {
            let base = k * period;
            if base >= t1 {
                break;
            }
            let lo = (from - base).max(0.0);
            let hi = (t1 - base).min(period);
            let w = Window { base, lo, hi, t0, spt, frames };
            self.segment(&w, out);
            k += 1.0;
        }
    }

    /// Events of one loop instance: collect every On/Off whose tick (relative
    /// to the loop start `w.base`) is in `[w.lo, w.hi)`, sort them by
    /// (offset, Off first, tick, slot), then apply the sounding-set and
    /// capacity rules while appending to `out`.
    fn segment(&mut self, w: &Window, out: &mut EventBuf) {
        let period = self.bars as u32 * BAR_TICKS as u32;
        if period == 0 {
            return;
        }
        let EventBuf { events, len, scratch } = out;
        let mut n = 0;
        for (i, note) in self.notes.iter().enumerate().take(self.used) {
            if !note.active || note.start >= period {
                continue; // empty, or starts beyond the pattern end
            }
            let on_rel = note.start;
            let off_rel = (note.start + note.len.clamp(1, period)) % period;
            for (rel, is_on) in [(off_rel, 0u64), (on_rel, 1u64)] {
                let r = rel as f64;
                if r < w.lo || r >= w.hi {
                    continue;
                }
                let offset = (tick_to_offset(w.base + r, w.t0, w.spt, w.frames) as u64).min(MAX_KEY_OFFSET);
                let key = (offset << KEY_OFFSET_SHIFT)
                    | (is_on << KEY_ON_SHIFT)
                    | ((rel as u64) << KEY_TICK_SHIFT)
                    | i as u64;
                if let Some(s) = scratch.get_mut(n) {
                    *s = key;
                    n += 1;
                }
            }
        }
        let Some(keys) = scratch.get_mut(..n) else { return };
        keys.sort_unstable(); // in place: no allocation
        for &key in keys.iter() {
            let idx = (key & ((1 << KEY_IDX_BITS) - 1)) as usize;
            let Some(note) = self.notes.get(idx) else { continue };
            let pitch = note.pitch & 127;
            let b = bit(pitch);
            let offset = (key >> KEY_OFFSET_SHIFT) as usize;
            let ev = if (key >> KEY_ON_SHIFT) & 1 == 1 {
                // Keep room for an Off for every pitch sounding afterwards.
                let sounding_after = (self.sounding | b).count_ones() as usize;
                if *len + 1 + sounding_after > EVENT_CAP {
                    continue; // overflow: drop the On
                }
                NoteEvent::On { note: pitch, vel: note.vel }
            } else if self.sounding & b != 0 {
                NoteEvent::Off { note: pitch }
            } else {
                continue; // nothing to release
            };
            let Some(slot) = events.get_mut(*len) else { continue };
            *slot = (offset, ev);
            *len += 1;
            if let NoteEvent::On { .. } = ev {
                self.sounding |= b;
                if let Some(h) = self.holder.get_mut(pitch as usize) {
                    *h = idx as u16;
                }
            } else {
                self.sounding &= !b;
            }
        }
    }
}

/// One loop instance of an `events` window (see `NotePattern::segment`).
struct Window {
    /// Absolute tick of this loop's start.
    base: f64,
    /// Relative tick range `[lo, hi)` inside the loop.
    lo: f64,
    hi: f64,
    /// Block start tick, samples per tick and block length (for offsets).
    t0: f64,
    spt: f64,
    frames: usize,
}

/// Bit of `pitch` in a sounding set (pitches above 127 alias, never panic).
fn bit(pitch: u8) -> u128 {
    1u128 << (pitch & 127)
}

/// Clamp a note into the protocol's ranges (the decoder already enforces
/// them; this keeps direct API use from ever panicking or hanging a note).
/// Inactive notes are normalised to `SeqNote::OFF`.
fn sanitize(n: SeqNote) -> SeqNote {
    if !n.active {
        return SeqNote::OFF;
    }
    SeqNote {
        active: true,
        pitch: n.pitch.min(127),
        vel: n.vel.clamp(1, 127),
        start: n.start.min(MAX_NOTE_TICKS - 1),
        len: n.len.clamp(1, MAX_NOTE_TICKS),
    }
}

impl Default for NotePattern {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPT: f64 = 25.0; // 120 bpm at 48 kHz

    fn note(pitch: u8, start: u32, len: u32) -> SeqNote {
        SeqNote { active: true, pitch, vel: 100, start, len }
    }

    /// Run `[from, to)` in 128-frame blocks; returns `(absolute tick, event)`.
    fn run(p: &mut NotePattern, from: f64, to: f64) -> Vec<(f64, NoteEvent)> {
        let mut buf = Box::new(EventBuf::new());
        let mut got = Vec::new();
        // Absolute ticks from whole samples, so integral ticks come out exact.
        let mut b = 0usize;
        loop {
            let t0 = from + (b * 128) as f64 / SPT;
            if t0 >= to {
                return got;
            }
            let t1 = from + ((b + 1) * 128) as f64 / SPT;
            p.events(t0, t1, SPT, 128, &mut buf);
            for &(off, ev) in buf.as_slice() {
                got.push((from + (b * 128 + off) as f64 / SPT, ev));
            }
            b += 1;
        }
    }

    fn on(note: u8) -> NoteEvent {
        NoteEvent::On { note, vel: 100 }
    }
    fn off(note: u8) -> NoteEvent {
        NoteEvent::Off { note }
    }

    #[test]
    fn events_have_exact_offsets_and_offs_before_ons() {
        let mut p = NotePattern::new();
        p.set_bars(1);
        p.set(0, note(60, 0, 960));
        p.set(1, note(60, 960, 960)); // starts where note 0 ends: retrigger
        let mut buf = Box::new(EventBuf::new());
        p.events(0.0, 3840.0, SPT, 96000, &mut buf);
        assert_eq!(buf.as_slice(), &[(0, on(60)), (24000, off(60)), (24000, on(60)), (48000, off(60))]);
        assert_eq!(p.sounding(), 0);
    }

    #[test]
    fn note_crossing_loop_end_releases_after_wrap() {
        let mut p = NotePattern::new();
        p.set_bars(1);
        p.set(0, note(60, 3360, 960));
        // First loop: the wrapped Off at 480 has no On yet, so it is dropped.
        let got = run(&mut p, 0.0, 2.0 * 3840.0);
        assert_eq!(got, vec![(3360.0, on(60)), (3840.0 + 480.0, off(60)), (7200.0, on(60))]);
    }

    #[test]
    fn note_longer_than_pattern_is_cut_at_period() {
        let mut p = NotePattern::new();
        p.set_bars(1);
        p.set(0, note(60, 0, 7680));
        let got = run(&mut p, 0.0, 3.0 * 3840.0);
        assert_eq!(
            got,
            vec![(0.0, on(60)), (3840.0, off(60)), (3840.0, on(60)), (7680.0, off(60)), (7680.0, on(60))]
        );
    }

    #[test]
    fn notes_starting_beyond_the_end_are_kept_but_silent() {
        let mut p = NotePattern::new();
        p.set_bars(1);
        p.set(0, note(60, 3840, 100));
        assert!(run(&mut p, 0.0, 2.0 * 3840.0).is_empty());
        p.set_bars(2);
        assert_eq!(run(&mut p, 0.0, 2.0 * 3840.0), vec![(3840.0, on(60)), (3940.0, off(60))]);
    }

    #[test]
    fn count_in_windows_yield_only_ticks_from_zero() {
        let mut p = NotePattern::new();
        p.set(0, note(60, 0, 100));
        let mut buf = Box::new(EventBuf::new());
        p.events(-3840.0, -10.0, SPT, 96000, &mut buf);
        assert!(buf.as_slice().is_empty());
        p.events(-10.0, 0.0, SPT, 250, &mut buf);
        assert!(buf.as_slice().is_empty(), "t1 = 0 is exclusive");
        p.events(-10.0, 10.0, SPT, 500, &mut buf);
        assert_eq!(buf.as_slice(), &[(250, on(60))]);
        // A note whose Off wraps to just after 0 in the count-in bar never fires.
        let mut p = NotePattern::new();
        p.set_bars(1);
        p.set(0, note(61, 3800, 100));
        assert!(run(&mut p, -3840.0, 3700.0).is_empty());
    }

    #[test]
    fn overflow_drops_ons_but_never_offs() {
        // 1024 one-tick notes: 128 pitches at each even tick 0..14.
        let mut p = NotePattern::new();
        p.set_bars(1);
        for i in 0..MAX_NOTES {
            p.set(i, note((i % 128) as u8, (i / 128) as u32 * 2, 1));
        }
        let mut buf = Box::new(EventBuf::new());
        p.events(0.0, 16.0, SPT, 400, &mut buf);
        let evs = buf.as_slice();
        assert!(evs.len() <= EVENT_CAP);
        assert!(evs.windows(2).all(|w| w[0].0 <= w[1].0), "offset order");
        // Every accepted On is followed by its Off: nothing is left sounding.
        assert_eq!(p.sounding(), 0);
        for pitch in 0..128u8 {
            let mine: Vec<_> = evs
                .iter()
                .filter(|(_, e)| matches!(e, NoteEvent::On { note, .. } | NoteEvent::Off { note } if *note == pitch))
                .collect();
            for (k, (_, e)) in mine.iter().enumerate() {
                assert_eq!(matches!(e, NoteEvent::On { .. }), k % 2 == 0, "pitch {pitch} alternates");
            }
            assert_eq!(mine.len() % 2, 0, "pitch {pitch} ends released");
        }
        let ons = evs.iter().filter(|(_, e)| matches!(e, NoteEvent::On { .. })).count();
        assert!(ons >= 64, "still plays what fits ({ons})");

        // 128 pitches sounding at the window start still get their Offs even
        // when a flood of Ons arrives first.
        let mut p = NotePattern::new();
        p.set_bars(1);
        for i in 0..128 {
            p.set(i, note(i as u8, 0, 10)); // On at 0, Off at 10
        }
        for i in 128..MAX_NOTES {
            p.set(i, note((i % 128) as u8, 5, 1)); // retriggers at 5, Off at 6
        }
        p.events(0.0, 1.0, SPT, 25, &mut buf);
        assert_eq!(p.sounding().count_ones(), 128);
        p.events(1.0, 20.0, SPT, 475, &mut buf);
        assert!(buf.as_slice().len() <= EVENT_CAP);
        assert_eq!(p.sounding(), 0, "every sounding pitch was released");
    }

    #[test]
    fn same_pitch_overlap_any_off_releases_the_pitch() {
        let mut p = NotePattern::new();
        p.set_bars(1);
        p.set(0, note(60, 0, 1000));
        p.set(1, note(60, 500, 1000));
        let got = run(&mut p, 0.0, 3840.0);
        // B's Off at 1500 is dropped: A's Off at 1000 already released 60.
        assert_eq!(got, vec![(0.0, on(60)), (500.0, on(60)), (1000.0, off(60))]);
    }

    #[test]
    fn editing_releases_only_the_sounding_note() {
        let mut p = NotePattern::new();
        p.set_bars(1);
        p.set(0, note(60, 0, 2000));
        p.set(1, note(60, 3000, 100)); // same pitch, silent at tick 100
        p.set(2, note(64, 0, 2000));
        run(&mut p, 0.0, 100.0);
        assert_eq!(p.sounding(), (1 << 60) | (1 << 64));
        assert_eq!(p.set(0, note(60, 0, 2000)), None, "identical: no-op");
        assert_eq!(p.set(1, note(60, 3100, 100)), None, "another, silent note of the pitch");
        assert_eq!(p.sounding(), (1 << 60) | (1 << 64));
        assert_eq!(p.set(0, note(62, 0, 2000)), Some(60), "moving the sounding note releases it");
        assert_eq!(p.sounding(), 1 << 64);
        assert_eq!(p.remove(2), Some(64));
        assert_eq!(p.remove(2), None);
        assert_eq!(p.sounding(), 0);
        // Its stale Off later is dropped (pitch not sounding).
        assert!(run(&mut p, 100.0, 1999.0).is_empty());
        assert_eq!(p.set(MAX_NOTES, note(1, 0, 1)), None, "out of range ignored");
        assert_eq!(p.note(0), Some(note(62, 0, 2000)));
        assert_eq!(p.used(), 3);
    }

    #[test]
    fn set_bars_and_clear_release_everything() {
        let mut p = NotePattern::new();
        assert_eq!(p.bars(), DEFAULT_BARS);
        p.set(0, note(60, 0, 2000));
        p.set(1, note(61, 0, 2000));
        run(&mut p, 0.0, 100.0);
        assert_eq!(p.set_bars(4), 0, "same length: no-op");
        assert_eq!(p.set_bars(2), (1 << 60) | (1 << 61));
        assert_eq!(p.bars(), 2);
        run(&mut p, 7680.0, 7780.0);
        assert_eq!(p.clear(), (1 << 60) | (1 << 61));
        assert_eq!((p.used(), p.note(0), p.sounding()), (0, Some(SeqNote::OFF), 0));
        assert!(run(&mut p, 0.0, 7680.0).is_empty());
        assert_eq!(p.set_bars(200), 0);
        assert_eq!(p.bars(), MAX_PATTERN_BARS as u8, "clamped");
        p.set(5, note(70, 0, 10));
        run(&mut p, 0.0, 5.0);
        assert_eq!(p.release_all(), 1 << 70);
        assert_eq!(p.reset(), 0);
        assert_eq!((p.bars(), p.used()), (DEFAULT_BARS, 0));
    }

    #[test]
    fn copy_from_replaces_notes_and_length_and_releases() {
        let mut a = NotePattern::new();
        a.set_bars(2);
        a.set(1, note(60, 100, 50));
        let mut b = NotePattern::new();
        for i in 0..5 {
            b.set(i, note(70, 0, 2000));
        }
        run(&mut b, 0.0, 10.0);
        assert_eq!(b.sounding(), 1 << 70);
        assert_eq!(b.copy_from(&a), 1 << 70, "returns what was sounding");
        assert_eq!((b.bars(), b.used(), b.sounding()), (2, 2, 0));
        assert_eq!(b.note(1), Some(note(60, 100, 50)));
        for i in [0, 2, 3, 4] {
            assert_eq!(b.note(i), Some(SeqNote::OFF), "slot {i} cleared");
        }
        assert_eq!(run(&mut b, 0.0, 7680.0), vec![(100.0, on(60)), (150.0, off(60))]);
    }

    #[test]
    fn garbage_windows_yield_nothing() {
        let mut p = NotePattern::new();
        p.set(0, note(60, 0, 10));
        let mut buf = Box::new(EventBuf::new());
        for (t0, t1, spt) in [
            (f64::NAN, 10.0, SPT),
            (0.0, f64::INFINITY, SPT),
            (10.0, 0.0, SPT),
            (0.0, 10.0, 0.0),
            (0.0, 10.0, f64::NAN),
        ] {
            p.events(t0, t1, spt, 128, &mut buf);
            assert!(buf.as_slice().is_empty(), "{t0} {t1} {spt}");
        }
        // A huge window is bounded (MAX_SEGMENTS loop instances) and never panics.
        p.events(0.0, 1e12, SPT, 128, &mut buf);
        assert!(buf.as_slice().len() <= EVENT_CAP);
    }
}
