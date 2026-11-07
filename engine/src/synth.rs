//! Synth tracks: one modular [`Rack`] and `MAX_PATTERNS` [`NotePattern`]s per
//! track slot.
//!
//! # Memory
//! [`Synths::new`] preallocates all `MAX_TRACKS` tracks (racks and all
//! `MAX_PATTERNS` patterns each, ~12.3 KB per pattern, ~6.3 MB in all) and the
//! shared event buffer up front (in `Engine::new`), so adding a synth track,
//! editing its patch or patterns, switching or copying patterns, playing notes
//! and rendering never allocate.
//!
//! # Patterns
//! Each track has a *current* pattern: the one that plays (Pattern mode) and
//! that note / bars edits target. Only the current pattern ever has sounding
//! notes. Switching to another pattern first releases the old one's sounding
//! notes (`Off` per pitch, never `AllOff`); the new pattern then plays from
//! the same absolute playhead, i.e. at `ticks mod newPeriod` (its notes that
//! started before the switch point do not sound). Selecting the current
//! pattern again is a no-op. Copying over, or clearing, a sounding pattern
//! releases its sounding notes first. Adding or removing a track resets all of
//! its patterns and selects pattern 0.
//!
//! # Song mode: clips own their notes
//! In Song mode a track plays its clips (`arrangement.rs`) instead of the
//! current pattern. Every clip slot has its own [`Voicing`] (the notes that
//! clip switched on), so each sounding sequenced note belongs either to a clip
//! or, in Pattern mode, to its pattern. A clip's notes are released (`Off` per
//! pitch, never `AllOff`):
//! * at the clip end, at its sample offset (the window is cut there);
//! * whenever the clip is not playing in the block (belt and braces: catches a
//!   clip that ended exactly on a block boundary);
//! * when the clip is edited (moved, shortened, re-pointed) or removed, or the
//!   track's clips are cleared (`Synths::release_clip`, `release_clips`);
//! * on any jump of song time: loop wrap, seek, mode switch, Stop
//!   (`Synths::release_song` / `release_sequenced`);
//! * when its pattern is edited like a Pattern-mode pattern would be (length
//!   change, copy over, clear: all its notes; moving or removing a note: that
//!   note only if this clip's voicing holds it).
//!
//! Clips of one track may overlap and then both play, through the one rack.
//! The rack's MIDI In is per pitch, so an `Off` from one clip cuts the same
//! pitch sounding from another (FL-like, accepted): the other clip still sends
//! its own `Off` later, which is harmless, so nothing is ever left hanging.
//! Events of all clips playing in a block are merged into one buffer and
//! sorted by offset (Offs first at equal offsets), so a clip starting where
//! another ends retriggers cleanly.
//!
//! # Rendering
//! Every *active* synth track renders every block, playing or not: its rack's
//! declick queue only drains while rendering, and free-running modules (LFOs,
//! release tails) must keep moving while stopped. A removed track keeps
//! rendering only while its rack is still sounding (its 2 ms fade-out and the
//! rack's 50 ms "sounding" window), then costs nothing.
//!
//! While the transport plays, each active track's pattern is asked for the
//! block's note events ([`NotePattern::events`]); the rack is then rendered in
//! segments split at the events' sample offsets, with [`Rack::note`] called at
//! each split. The rack applies a note at its next sub-block boundary and
//! carries partial sub-blocks across calls, so splitting changes nothing but
//! the note timing (one `RACK_BLOCK` resolution). Sequenced and live notes
//! share the rack's MIDI In voices.
//!
//! # Declicking
//! Removing a track (or re-adding it, which resets it to an empty patch)
//! calls [`Rack::clear`]. On a sounding rack that queues the clear behind the
//! rack's own 2 ms output fade, so the track fades out over 2 ms and then
//! clears; on a silent rack it applies at once. Edits sent after the clear
//! (e.g. building a new patch) validate against the empty patch immediately
//! and apply, in order, once the fade-out is done. Adding or removing a track
//! also resets its pattern (empty, `DEFAULT_BARS` long).

use crate::arrangement::{Clip, Timeline};
use crate::mixer::StereoBufs;
use crate::rack::modules::{Ctx, NoteEvent};
use crate::rack::Rack;
use crate::sequencer::{EventBuf, NotePattern, SeqNote, Voicing};
use crate::transport::tick_to_offset;
use crate::{MAX_CLIPS, MAX_PATTERNS, MAX_TRACKS};

/// One synth track: its patch, its note patterns and one voicing per clip.
pub struct SynthTrack {
    pub rack: Rack,
    /// Exactly `MAX_PATTERNS` patterns (heap, allocated in `Synths::new`).
    patterns: Vec<NotePattern>,
    /// Index of the current pattern (always < `MAX_PATTERNS`).
    current: usize,
    /// Song mode: the notes clip `i` has switched on (exactly `MAX_CLIPS`).
    voicings: Vec<Voicing>,
}

impl SynthTrack {
    fn new(sample_rate: f32) -> SynthTrack {
        let mut patterns = Vec::with_capacity(MAX_PATTERNS);
        for _ in 0..MAX_PATTERNS {
            patterns.push(NotePattern::new());
        }
        SynthTrack { rack: Rack::new(sample_rate), patterns, current: 0, voicings: vec![Voicing::NEW; MAX_CLIPS] }
    }

    /// Off for every note of clip `idx`.
    fn release_clip(&mut self, idx: usize) {
        if let Some(v) = self.voicings.get_mut(idx) {
            release(&mut self.rack, v.release_all());
        }
    }

    /// Off for every note of every clip.
    fn release_clips(&mut self) {
        let mask = self.voicings.iter_mut().fold(0, |m, v| m | v.release_all());
        release(&mut self.rack, mask);
    }

    /// Off for every note of the clips (of `clips`) that play `pattern`.
    fn release_clips_of(&mut self, clips: &[Clip], pattern: usize) {
        let mut mask = 0;
        for (c, v) in clips.iter().zip(self.voicings.iter_mut()) {
            if c.active && c.pattern as usize == pattern {
                mask |= v.release_all();
            }
        }
        release(&mut self.rack, mask);
    }

    /// Note slot `idx` of `pattern` changed from `old`: release `old`'s pitch
    /// from every clip of that pattern whose voicing it holds.
    fn release_clip_note(&mut self, clips: &[Clip], pattern: usize, idx: usize, old: SeqNote) {
        if !old.active {
            return;
        }
        let mut hit = false;
        for (c, v) in clips.iter().zip(self.voicings.iter_mut()) {
            if c.active && c.pattern as usize == pattern {
                hit |= v.release_held(old.pitch, idx);
            }
        }
        if hit {
            self.rack.note(NoteEvent::Off { note: old.pitch });
        }
    }

    /// The current pattern. `patterns` is never empty, so the fallback to
    /// the first one (which would only matter if `current` were corrupt)
    /// keeps this panic-free.
    fn pattern_mut(&mut self) -> Option<&mut NotePattern> {
        let i = if self.current < self.patterns.len() { self.current } else { 0 };
        self.patterns.get_mut(i)
    }

    /// Every pattern empty and `DEFAULT_BARS` long, pattern 0 current, no
    /// clip voicing sounding. Returns the pitches that were sounding.
    fn reset_patterns(&mut self) -> u128 {
        self.current = 0;
        let clips = self.voicings.iter_mut().fold(0, |m, v| m | v.release_all());
        self.patterns.iter_mut().fold(clips, |m, p| m | p.reset())
    }
}

/// All synth tracks of the engine, indexed by track slot.
pub struct Synths {
    tracks: Vec<SynthTrack>,
    active: [bool; MAX_TRACKS],
    /// Per-block event scratch, shared by the tracks (they render in turn).
    events: Box<EventBuf>,
}

impl Synths {
    /// Preallocates `MAX_TRACKS` empty tracks and the event buffer. The only
    /// allocating call.
    pub fn new(sample_rate: f32) -> Synths {
        let mut tracks = Vec::with_capacity(MAX_TRACKS);
        for _ in 0..MAX_TRACKS {
            tracks.push(SynthTrack::new(sample_rate));
        }
        Synths { tracks, active: [false; MAX_TRACKS], events: Box::new(EventBuf::new()) }
    }

    /// Is `slot` an active synth track?
    pub fn is_active(&self, slot: usize) -> bool {
        self.active.get(slot).copied().unwrap_or(false)
    }

    /// Make `slot` an active synth track with an empty patch and empty
    /// patterns (pattern 0 current). If the slot still holds a patch (active or fading out), it is
    /// cleared with the rack's 2 ms declick fade.
    pub fn add_track(&mut self, slot: usize) {
        if let (Some(t), Some(a)) = (self.tracks.get_mut(slot), self.active.get_mut(slot)) {
            t.rack.clear();
            t.reset_patterns(); // the cleared rack drops its notes anyway
            *a = true;
        }
    }

    /// Deactivate `slot`: the rack fades out over 2 ms, then clears, and the
    /// patterns are reset. A no-op for an inactive slot.
    pub fn remove_track(&mut self, slot: usize) {
        if let (Some(t), Some(a)) = (self.tracks.get_mut(slot), self.active.get_mut(slot)) {
            if *a {
                t.rack.clear();
                t.reset_patterns();
                *a = false;
            }
        }
    }

    /// The active synth track at `slot`, else `None`.
    fn track_mut(&mut self, slot: usize) -> Option<&mut SynthTrack> {
        if self.is_active(slot) {
            self.tracks.get_mut(slot)
        } else {
            None
        }
    }

    /// The rack of an active synth track (for patch edits), else `None`.
    pub fn rack_mut(&mut self, slot: usize) -> Option<&mut Rack> {
        self.track_mut(slot).map(|t| &mut t.rack)
    }

    /// The current pattern of an active synth track, else `None`.
    pub fn pattern(&self, slot: usize) -> Option<&NotePattern> {
        if self.is_active(slot) {
            self.tracks.get(slot).and_then(|t| t.patterns.get(t.current))
        } else {
            None
        }
    }

    /// Index of the current pattern of an active synth track.
    pub fn current(&self, slot: usize) -> Option<usize> {
        if self.is_active(slot) {
            self.tracks.get(slot).map(|t| t.current)
        } else {
            None
        }
    }

    /// Make `pattern` current, releasing the old current pattern's sounding
    /// notes; the same pattern is a no-op. `false` if `slot` is not an active
    /// synth track or `pattern` is out of range.
    pub fn set_current(&mut self, slot: usize, pattern: usize) -> bool {
        let Some(t) = self.track_mut(slot) else { return false };
        if pattern >= t.patterns.len() {
            return false;
        }
        if pattern != t.current {
            let released = t.pattern_mut().map_or(0, |p| p.release_all());
            release(&mut t.rack, released);
            t.current = pattern;
        }
        true
    }

    /// Copy pattern `from` over pattern `to` (notes and length), releasing
    /// what `to` was sounding (in Pattern mode, and in every clip of `clips`
    /// playing it); `from == to` is a no-op. `false` if `slot` is not an
    /// active synth track or an index is out of range.
    pub fn copy_pattern(&mut self, slot: usize, from: usize, to: usize, clips: &[Clip]) -> bool {
        let Some(t) = self.track_mut(slot) else { return false };
        let n = t.patterns.len();
        if from >= n || to >= n {
            return false;
        }
        if from == to {
            return true;
        }
        // Borrow the two patterns disjointly.
        let (lo, hi) = t.patterns.split_at_mut(from.max(to));
        let (Some(a), Some(b)) = (lo.get_mut(from.min(to)), hi.first_mut()) else { return false };
        let (src, dst) = if from < to { (&*a, b) } else { (&*b, a) };
        let released = dst.copy_from(src);
        release(&mut t.rack, released);
        t.release_clips_of(clips, to);
        true
    }

    /// Remove every note of `pattern` (its length stays), releasing the
    /// sounding ones (Pattern mode and every clip of `clips` playing it).
    /// `false` if `slot` is not an active synth track or `pattern` is out of
    /// range.
    pub fn clear_pattern(&mut self, slot: usize, pattern: usize, clips: &[Clip]) -> bool {
        let Some(t) = self.track_mut(slot) else { return false };
        let Some(p) = t.patterns.get_mut(pattern) else { return false };
        let released = p.clear();
        release(&mut t.rack, released);
        t.release_clips_of(clips, pattern);
        true
    }

    /// Deliver a live note/controller event to an active synth track (ignored
    /// for any other slot).
    pub fn note(&mut self, slot: usize, ev: NoteEvent) {
        if let Some(rack) = self.rack_mut(slot) {
            rack.note(ev);
        }
    }

    /// Store a note in the current pattern; a sounding note it replaces is
    /// released (Pattern mode, and in every clip of `clips` whose voicing
    /// holds it). Returns `false` if `slot` is not an active synth track.
    pub fn set_note(&mut self, slot: usize, idx: usize, note: SeqNote, clips: &[Clip]) -> bool {
        let Some(t) = self.track_mut(slot) else { return false };
        let current = t.current;
        let Some(p) = t.pattern_mut() else { return false };
        let old = p.note(idx);
        let released = p.set(idx, note);
        let changed = p.note(idx) != old;
        if let Some(pitch) = released {
            t.rack.note(NoteEvent::Off { note: pitch });
        }
        if let (true, Some(old)) = (changed, old) {
            t.release_clip_note(clips, current, idx, old);
        }
        true
    }

    /// Remove a note of the current pattern (released if sounding, as for
    /// `set_note`). `false` if `slot` is not an active synth track.
    pub fn remove_note(&mut self, slot: usize, idx: usize, clips: &[Clip]) -> bool {
        self.set_note(slot, idx, SeqNote::OFF, clips)
    }

    /// Remove every note of the current pattern, releasing the sounding
    /// ones (Pattern mode and clips). `false` if `slot` is not an active
    /// synth track.
    pub fn clear_notes(&mut self, slot: usize, clips: &[Clip]) -> bool {
        let Some(current) = self.current(slot) else { return false };
        self.clear_pattern(slot, current, clips)
    }

    /// Set the current pattern's length (a change releases the sounding
    /// notes, Pattern mode and clips). `false` if `slot` is not an active
    /// synth track.
    pub fn set_pattern_bars(&mut self, slot: usize, bars: u8, clips: &[Clip]) -> bool {
        let Some(t) = self.track_mut(slot) else { return false };
        let current = t.current;
        let Some(p) = t.pattern_mut() else { return false };
        let before = p.bars();
        let released = p.set_bars(bars);
        let changed = p.bars() != before;
        release(&mut t.rack, released);
        if changed {
            t.release_clips_of(clips, current);
        }
        true
    }

    /// Stop / mode switch: send `Off` for every sequenced pitch still
    /// sounding on every track (patterns and clips). Never `AllOff`, so live
    /// keys (and the pedal) stay held.
    pub fn release_sequenced(&mut self) {
        for t in self.tracks.iter_mut() {
            // Only the current pattern can sound; asking all 16 is cheap.
            let released = t.patterns.iter_mut().fold(0, |m, p| m | p.release_all());
            release(&mut t.rack, released);
            t.release_clips();
        }
    }

    /// A jump of song time (loop wrap, seek): `Off` for every note any clip
    /// of any track is holding.
    pub fn release_song(&mut self) {
        for t in self.tracks.iter_mut() {
            t.release_clips();
        }
    }

    /// Clip `idx` of track `slot` was edited or removed: release its notes.
    pub fn release_clip(&mut self, slot: usize, idx: usize) {
        if let Some(t) = self.tracks.get_mut(slot) {
            t.release_clip(idx);
        }
    }

    /// The clips of track `slot` were cleared: release all their notes.
    pub fn release_clips(&mut self, slot: usize) {
        if let Some(t) = self.tracks.get_mut(slot) {
            t.release_clips();
        }
    }

    /// Every pitch the sequencer (current pattern or any clip) holds on
    /// track `slot`.
    pub fn sequenced_sounding(&self, slot: usize) -> u128 {
        let Some(t) = self.tracks.get(slot).filter(|_| self.is_active(slot)) else { return 0 };
        let pat = t.patterns.get(t.current).map_or(0, |p| p.sounding());
        t.voicings.iter().fold(pat, |m, v| m | v.sounding())
    }

    /// Render every active track (and any removed track still fading out),
    /// **adding** into frames `from..to` of its own buffer in `tracks`
    /// (pair = slot). Returns a mask of the slots rendered (bit = slot).
    /// `window` is the transport's
    /// `(t0, t1, samples_per_tick)` for this block (or block segment, split at
    /// a loop wrap) while playing, `None` while stopped; `timeline` says
    /// whether the current patterns or the clips play. `ctx.ticks` must equal
    /// `t0`.
    pub fn render_add(
        &mut self,
        ctx: &Ctx,
        window: Option<(f64, f64, f64)>,
        timeline: Timeline,
        tracks: &mut StereoBufs,
        (from, to): (usize, usize),
    ) -> u32 {
        let n = to.saturating_sub(from);
        let events = &mut *self.events;
        let mut rendered = 0u32;
        for (slot, (t, &active)) in self.tracks.iter_mut().zip(self.active.iter()).enumerate() {
            if !(active || t.rack.is_sounding()) {
                continue;
            }
            let Some((left, right)) = tracks.pair_mut(slot, from, to) else { continue };
            rendered |= 1 << slot;
            events.clear();
            if let (true, Some((t0, t1, spt))) = (active, window) {
                match timeline {
                    Timeline::Pattern => {
                        if let Some(p) = t.pattern_mut() {
                            p.events(t0, t1, spt, n, events);
                        }
                    }
                    Timeline::Song(_) => song_events(t, timeline.clips(slot), (t0, t1, spt), n, events),
                }
                // Offs that found the buffer full go out now (early, never lost).
                release(&mut t.rack, events.take_overflow());
            }
            // Render up to each event's offset, deliver it, continue.
            let mut pos = 0;
            for &(offset, ev) in events.as_slice() {
                let at = offset.min(n).max(pos); // pos <= n always
                if at > pos {
                    render_segment(&mut t.rack, ctx, pos, &mut left[pos..at], &mut right[pos..at]);
                    pos = at;
                }
                t.rack.note(ev);
            }
            if pos < n {
                render_segment(&mut t.rack, ctx, pos, &mut left[pos..n], &mut right[pos..n]);
            }
        }
        rendered
    }
}

/// Song mode: fill `events` with this window's events of every clip of the
/// track (see the module docs), sorted by offset. Clips not playing here
/// release whatever they still hold right away.
fn song_events(t: &mut SynthTrack, clips: &[Clip], (t0, t1, spt): (f64, f64, f64), n: usize, events: &mut EventBuf) {
    let SynthTrack { rack, patterns, voicings, .. } = t;
    let mut players = 0;
    for (c, v) in clips.iter().zip(voicings.iter_mut()) {
        let (Some((lo, hi, origin)), Some(p)) = (c.pattern_window(t0, t1), patterns.get(c.pattern as usize)) else {
            release(rack, v.release_all()); // not playing in this window
            continue;
        };
        let before = events.len();
        p.scan(v, lo, hi, origin, spt, n, events);
        if (c.end() as f64) < t1 {
            // The clip ends inside the window: release what it still holds
            // there (never before one of its own Ons in this block).
            let mut at = tick_to_offset(c.end() as f64, t0, spt, n);
            for &(offset, ev) in events.as_slice().get(before..).unwrap_or(&[]) {
                if let NoteEvent::On { .. } = ev {
                    at = at.max(offset + 1);
                }
            }
            events.push_offs(v.release_all(), at);
        }
        if events.len() > before {
            players += 1;
        }
    }
    if players > 1 {
        events.sort();
    }
}

/// Render frames `from..` of the block (`left`/`right` are that sub-slice),
/// with the `Ctx` playhead moved to the segment start while playing.
fn render_segment(rack: &mut Rack, ctx: &Ctx, from: usize, left: &mut [f32], right: &mut [f32]) {
    let mut seg = *ctx;
    if ctx.playing {
        seg.ticks = ctx.ticks + from as f64 * ctx.ticks_per_frame;
    }
    rack.render_add(&seg, left, right);
}

/// Send `Off` for every pitch in `mask` (bit = pitch).
fn release(rack: &mut Rack, mut mask: u128) {
    while mask != 0 {
        let pitch = mask.trailing_zeros() as u8;
        rack.note(NoteEvent::Off { note: pitch });
        mask &= mask - 1;
    }
}
