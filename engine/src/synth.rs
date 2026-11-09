//! Synth tracks: one modular [`Rack`] and `MAX_PATTERNS` [`NotePattern`]s per
//! track slot.
//!
//! # Memory
//! [`Synths::new`] preallocates all `MAX_TRACKS` tracks (racks and all
//! `MAX_PATTERNS` patterns each, ~12.3 KB per pattern, ~6.3 MB in all), the
//! shared event buffer and the rack effects' [`FxPool`] (8 delay, 8 reverb,
//! 16 chorus and 8 scope slots shared by every track, ~10.75 MiB at 48 kHz;
//! see `rack/fx_pool.rs`) up front (in `Engine::new`, for the context sample
//! rate), so adding a synth track, editing its patch or patterns, switching or
//! copying patterns, playing notes and rendering never allocate.
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
use crate::automation::AutoFrame;
use crate::mixer::StereoBufs;
use crate::rack::modules::theory::{Key, DEFAULT_KEY};
use crate::rack::modules::{Ctx, NoteEvent};
use crate::rack::catalog::ModuleKind;
use crate::rack::fx_pool::FxPool;
use crate::rack::Rack;
use crate::samples::SampleView;
use crate::sequencer::{EventBuf, NotePattern, SeqNote, Voicing};
use crate::transport::tick_to_offset;
use crate::{MAX_CLIPS, MAX_PATTERNS, MAX_POLY, MAX_TRACKS};

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
    /// Memory for the racks' Delay/Reverb/Chorus/Scope modules, shared by
    /// all tracks.
    fx: FxPool,
}

impl Synths {
    /// Preallocates `MAX_TRACKS` empty tracks and the event buffer. The only
    /// allocating call.
    pub fn new(sample_rate: f32) -> Synths {
        let mut tracks = Vec::with_capacity(MAX_TRACKS);
        for slot in 0..MAX_TRACKS {
            let mut t = SynthTrack::new(sample_rate);
            t.rack.set_track(slot); // its Scopes name it (plan 12)
            tracks.push(t);
        }
        Synths { tracks, active: [false; MAX_TRACKS], events: Box::new(EventBuf::new()), fx: FxPool::new(sample_rate) }
    }

    /// The shared FX pool (slot usage, for tests and telemetry).
    pub fn fx_pool(&self) -> &FxPool {
        &self.fx
    }

    /// Voice activity (plan 12, `vis.rs`): for every track slot, `voices[(slot
    /// × MAX_POLY + k) × 2]` = voice `k`'s peak level since the last call
    /// (its racks' Outs; below `vis::VOICE_FLOOR` it reads 0), `+ 1` = its
    /// gate. Every rack that rendered meanwhile writes its values, every
    /// other slot zeros. The engine calls it once per block, after the
    /// tracks rendered. Allocation-free; reads only.
    pub fn write_voices(&mut self, voices: &mut [f32]) {
        for (t, out) in self.tracks.iter_mut().zip(voices.chunks_exact_mut(MAX_POLY * 2)) {
            t.rack.take_voices(out, crate::vis::VOICE_FLOOR);
        }
    }

    /// Add a module to the patch of active synth track `slot` (see
    /// [`Rack::add_module`]: `ERR_OUT_OF_MEMORY` when a pooled effect's bank
    /// is full). Slots freed by edits on any track that applied at once
    /// (silent racks) are reclaimed first, so removing a Delay on one track
    /// and adding one on another in the same batch works. `None` if `slot`
    /// is not an active synth track.
    pub fn add_module(&mut self, slot: usize, idx: usize, kind: ModuleKind) -> Option<i32> {
        if !self.is_active(slot) {
            return None;
        }
        for t in self.tracks.iter_mut() {
            t.rack.reclaim(&mut self.fx);
        }
        let t = self.tracks.get_mut(slot)?;
        Some(t.rack.add_module(idx, kind, &mut self.fx))
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
            t.rack.reclaim(&mut self.fx); // a silent rack's clear applied at once
            t.reset_patterns(); // the cleared rack drops its notes anyway
            *a = true;
        }
    }

    /// The song key (`SET_KEY`) for every rack's Chord (In key).
    pub fn set_key(&mut self, key: Key) {
        for t in self.tracks.iter_mut() {
            t.rack.set_key(key);
        }
    }

    /// Engine reset (`OP_RESET_ALL`): every track inactive with an empty
    /// patch and empty patterns, at once (no fade; the engine fades its
    /// master output instead). Each rack is hard-cleared first, dropping its
    /// fading modules, queued edits and pending releases, and only then is
    /// the whole FX pool freed, so no stale release can later free a slot a
    /// new module claimed. Allocation-free.
    pub fn reset_all(&mut self) {
        for (t, a) in self.tracks.iter_mut().zip(self.active.iter_mut()) {
            t.rack.reset_hard();
            t.reset_patterns();
            *a = false;
        }
        self.set_key(DEFAULT_KEY); // a blank session is in A minor
        self.fx.release_all();
    }

    /// Every rack empty, nothing queued (tests).
    #[doc(hidden)]
    pub fn racks_empty(&self) -> bool {
        self.tracks.iter().all(|t| t.rack.is_empty())
    }

    /// Deactivate `slot`: the rack fades out over 2 ms, then clears, and the
    /// patterns are reset. A no-op for an inactive slot.
    pub fn remove_track(&mut self, slot: usize) {
        if let (Some(t), Some(a)) = (self.tracks.get_mut(slot), self.active.get_mut(slot)) {
            if *a {
                t.rack.clear();
                t.rack.reclaim(&mut self.fx);
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

    /// The pattern focus moved to `keep`: `Off` for every note the
    /// Pattern-mode voicing of any other track holds (clip voicings are
    /// untouched; they only sound in Song mode, which ignores the focus).
    pub fn release_patterns_except(&mut self, keep: usize) {
        for (slot, t) in self.tracks.iter_mut().enumerate() {
            if slot != keep {
                let released = t.patterns.iter_mut().fold(0, |m, p| m | p.release_all());
                release(&mut t.rack, released);
            }
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
    /// `t0`. Sample Players read the engine's samples through `smp`.
    #[allow(clippy::too_many_arguments)]
    pub fn render_add(
        &mut self,
        ctx: &Ctx,
        smp: SampleView,
        window: Option<(f64, f64, f64)>,
        timeline: Timeline,
        tracks: &mut StereoBufs,
        (from, to): (usize, usize),
        auto: &AutoFrame,
    ) -> u32 {
        let n = to.saturating_sub(from);
        let events = &mut *self.events;
        let fx = &mut self.fx;
        let mut rendered = 0u32;
        for (slot, (t, &active)) in self.tracks.iter_mut().zip(self.active.iter()).enumerate() {
            if !(active || t.rack.is_sounding()) {
                continue;
            }
            let Some((left, right)) = tracks.pair_mut(slot, from, to) else { continue };
            rendered |= 1 << slot;
            // Automation lanes on this rack: applied at its sub-block starts
            // (`seg` turns a segment start into that frame of the block).
            let lanes = (active && auto.has_rack(slot)).then_some(auto);
            let seg = |pos: usize| lanes.map(|a| (a, slot, from + pos));
            events.clear();
            if let (true, Some((t0, t1, spt))) = (active, window) {
                match timeline {
                    // Pattern focus: an unfocused track schedules nothing
                    // (its held notes were released when the focus moved).
                    Timeline::Pattern { .. } if !timeline.pattern_plays(slot) => {}
                    Timeline::Pattern { .. } => {
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
                    render_segment(&mut t.rack, fx, smp, ctx, pos, &mut left[pos..at], &mut right[pos..at], seg(pos));
                    pos = at;
                }
                t.rack.note(ev);
            }
            if pos < n {
                render_segment(&mut t.rack, fx, smp, ctx, pos, &mut left[pos..n], &mut right[pos..n], seg(pos));
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

/// Render frames `from..` of the piece (`left`/`right` are that sub-slice),
/// with the `Ctx` playhead moved to the segment start while playing; `auto`:
/// the automation frame, slot and block frame of the segment start.
#[allow(clippy::too_many_arguments)]
fn render_segment(
    rack: &mut Rack,
    fx: &mut FxPool,
    smp: SampleView,
    ctx: &Ctx,
    from: usize,
    left: &mut [f32],
    right: &mut [f32],
    auto: Option<(&AutoFrame, usize, usize)>,
) {
    let mut seg = *ctx;
    if ctx.playing {
        seg.ticks = ctx.ticks + from as f64 * ctx.ticks_per_frame;
    }
    rack.render_add_auto(&seg, fx, smp, left, right, auto);
}

/// Send `Off` for every pitch in `mask` (bit = pitch).
fn release(rack: &mut Rack, mut mask: u128) {
    while mask != 0 {
        let pitch = mask.trailing_zeros() as u8;
        rack.note(NoteEvent::Off { note: pitch });
        mask &= mask - 1;
    }
}

#[cfg(test)]
mod tests {
    use crate::protocol::{
        OK, OP_ADD_SYNTH_TRACK, OP_NOTE_OFF, OP_NOTE_ON, OP_RACK_ADD_MODULE, OP_RACK_CONNECT, OP_RACK_SET_PARAM,
        OP_SET_INPUT_TRACK,
    };
    use crate::{Engine, MAX_POLY};

    const SR: f32 = 48000.0;
    const RELEASE: f64 = 0.1;

    /// Synth track `slot`: MIDI In (`mode` 0 Poly / 1 Mono) -> Osc (sine) ->
    /// VCA <- ADSR (release `RELEASE`) -> Out.l, the live input track.
    fn patch(e: &mut Engine, slot: f64, mode: f64) {
        assert_eq!(e.command(OP_ADD_SYNTH_TRACK, slot, 0.0, 0.0, 0.0), OK);
        for (m, kind) in [(0.0, 0.0), (1.0, 1.0), (2.0, 4.0), (3.0, 5.0), (4.0, 8.0)] {
            assert_eq!(e.command(OP_RACK_ADD_MODULE, slot, m, kind, 0.0), OK);
        }
        let pk = |m: usize, p: usize| (m * 16 + p) as f64;
        for (from, to) in [((0, 0), (1, 0)), ((0, 1), (2, 0)), ((1, 0), (3, 0)), ((2, 0), (3, 1)), ((3, 0), (4, 0))] {
            assert_eq!(e.command(OP_RACK_CONNECT, slot, pk(from.0, from.1), pk(to.0, to.1), 0.0), OK);
        }
        assert_eq!(e.command(OP_RACK_SET_PARAM, slot, 0.0, 1.0, mode), OK);
        assert_eq!(e.command(OP_RACK_SET_PARAM, slot, 1.0, 0.0, 3.0), OK); // sine
        assert_eq!(e.command(OP_RACK_SET_PARAM, slot, 2.0, 3.0, RELEASE), OK);
        assert_eq!(e.command(OP_SET_INPUT_TRACK, slot, 0.0, 0.0, 0.0), OK);
    }

    fn blocks(e: &mut Engine, n: usize) {
        let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
        for _ in 0..n {
            e.process(&mut l, &mut r);
        }
    }

    /// `(level, gate)` of voice `k` of track `slot`.
    fn voice(e: &Engine, slot: usize, k: usize) -> (f32, f32) {
        let v = &e.vis().voices;
        (v[(slot * MAX_POLY + k) * 2], v[(slot * MAX_POLY + k) * 2 + 1])
    }

    #[test]
    fn voice_activity_follows_voices() {
        let mut e = Engine::new(SR);
        patch(&mut e, 2.0, 0.0);
        for n in [60.0, 64.0, 67.0] {
            assert_eq!(e.command(OP_NOTE_ON, n, 100.0, 0.0, 0.0), OK);
        }
        blocks(&mut e, 40); // ~107 ms: attack done
        for k in 0..MAX_POLY {
            let (level, gate) = voice(&e, 2, k);
            if k < 3 {
                assert!(level > 0.0 && gate == 1.0, "voice {k}: {level} {gate}");
            } else {
                assert_eq!((level, gate), (0.0, 0.0), "voice {k}");
            }
        }
        // Every other track slot is all zeros.
        assert!((0..32).filter(|&s| s != 2).all(|s| (0..MAX_POLY).all(|k| voice(&e, s, k) == (0.0, 0.0))));
        for n in [60.0, 64.0, 67.0] {
            assert_eq!(e.command(OP_NOTE_OFF, n, 0.0, 0.0, 0.0), OK);
        }
        blocks(&mut e, 1);
        blocks(&mut e, 1); // the gate drops at the next sub-block
        assert!((0..MAX_POLY).all(|k| voice(&e, 2, k).1 == 0.0), "gates closed");
        // Within release + 100 ms every level is 0.
        let limit = ((RELEASE + 0.1) * SR as f64 / 128.0).ceil() as usize;
        let mut at = None;
        for b in 0..limit {
            blocks(&mut e, 1);
            if (0..MAX_POLY).all(|k| voice(&e, 2, k).0 == 0.0) {
                at = Some(b);
                break;
            }
        }
        assert!(at.is_some(), "levels reach 0 within release + 100 ms");

        // A mono patch uses only voice 0.
        let mut e = Engine::new(SR);
        patch(&mut e, 0.0, 1.0);
        for n in [60.0, 64.0, 67.0] {
            assert_eq!(e.command(OP_NOTE_ON, n, 100.0, 0.0, 0.0), OK);
        }
        blocks(&mut e, 40);
        let (level, gate) = voice(&e, 0, 0);
        assert!(level > 0.0 && gate == 1.0);
        assert!((1..MAX_POLY).all(|k| voice(&e, 0, k) == (0.0, 0.0)));
    }

    // ---- note modules (plan 26 Task 3) -------------------------------------

    use crate::protocol::{
        OP_CLIP_SET, OP_NOTE_SET, OP_PLAY, OP_RACK_REMOVE_MODULE, OP_SET_KEY, OP_SET_LOOP, OP_SET_MODE,
        OP_SET_PATTERN_BARS, OP_SET_TEMPO,
    };
    use crate::MAX_NOTES;

    const K_CHORD: f64 = 20.0;
    const K_ARP: f64 = 21.0;

    /// Note `idx` of track `slot`'s current pattern.
    fn set_note(e: &mut Engine, slot: usize, idx: usize, pitch: u32, start: u32, len: u32) {
        let a = (slot * MAX_NOTES + idx) as f64;
        assert_eq!(e.command(OP_NOTE_SET, a, (pitch * 128 + 100) as f64, start as f64, len as f64), OK);
    }

    /// Play for `frames` and return the master output (left).
    fn play(e: &mut Engine, frames: usize) -> Vec<f32> {
        let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
        let mut out = Vec::with_capacity(frames);
        for _ in 0..frames / 128 {
            e.process(&mut l, &mut r);
            out.extend_from_slice(&l);
        }
        out
    }

    /// Track 0 (`patch`, mono so every step retriggers one voice), 1-bar
    /// patterns, at `bpm`; with `arp`: an Arp (1/16, Up, gate 50 %) and one
    /// held C4 per bar; without: the same 1/16 notes drawn, 120 ticks long.
    fn arp_or_drawn(bpm: f64, arp: bool) -> Engine {
        let mut e = Engine::new(SR);
        patch(&mut e, 0.0, 1.0);
        assert_eq!(e.command(OP_SET_TEMPO, bpm, 0.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_SET_PATTERN_BARS, 0.0, 1.0, 0.0, 0.0), OK);
        if arp {
            assert_eq!(e.command(OP_RACK_ADD_MODULE, 0.0, 5.0, K_ARP, 0.0), OK);
            set_note(&mut e, 0, 0, 60, 0, 3840);
        } else {
            for k in 0..16 {
                set_note(&mut e, 0, k, 60, k as u32 * 240, 120);
            }
        }
        e
    }

    #[test]
    fn arp_renders_like_drawn_notes_in_pattern_mode() {
        // 128 BPM: 23.4375 frames per tick, so steps fall between frames and
        // between sub-blocks; three passes of the 1-bar pattern.
        for bpm in [120.0, 128.0] {
            let frames = (3.0 * 3840.0 * 48000.0 * 60.0 / (bpm * 960.0)) as usize;
            let mut a = arp_or_drawn(bpm, true);
            let mut d = arp_or_drawn(bpm, false);
            assert_eq!(a.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0), OK);
            assert_eq!(d.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0), OK);
            let (x, y) = (play(&mut a, frames), play(&mut d, frames));
            assert!(y.iter().any(|v| v.abs() > 0.01), "it sounds");
            let first = x.iter().zip(&y).position(|(p, q)| p != q);
            assert_eq!(first, None, "{bpm} BPM: the arp is bit-identical to the drawn notes");
        }
    }

    #[test]
    fn arp_renders_like_drawn_notes_in_song_mode_across_the_loop() {
        let song = |e: &mut Engine| {
            assert_eq!(e.command(OP_SET_MODE, 1.0, 0.0, 0.0, 0.0), OK);
            // One clip of pattern 0, bars 0..2, and the loop over it.
            assert_eq!(e.command(OP_CLIP_SET, 0.0, 0.0, 0.0, 7680.0), OK);
            assert_eq!(e.command(OP_SET_LOOP, 0.0, 7680.0, 0.0, 0.0), OK);
            assert_eq!(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0), OK);
        };
        let mut a = arp_or_drawn(120.0, true);
        let mut d = arp_or_drawn(120.0, false);
        song(&mut a);
        song(&mut d);
        let frames = 2 * 7680 * 25 + 40_000; // twice round the loop and on
        let (x, y) = (play(&mut a, frames), play(&mut d, frames));
        assert!(y.iter().any(|v| v.abs() > 0.01));
        assert_eq!(x.iter().zip(&y).position(|(p, q)| p != q), None);
    }

    #[test]
    fn chord_in_key_turns_one_note_into_four_voices() {
        let mut e = Engine::new(SR);
        patch(&mut e, 0.0, 0.0);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 0.0, 5.0, K_CHORD, 0.0), OK); // default: In key
        assert_eq!(e.command(OP_NOTE_ON, 57.0, 100.0, 0.0, 0.0), OK);
        blocks(&mut e, 40);
        let held = (0..MAX_POLY).filter(|&k| voice(&e, 0, k).1 == 1.0).count();
        assert_eq!(held, 4, "A3 In key in A minor: Am7");
        assert_eq!(e.command(OP_NOTE_OFF, 57.0, 0.0, 0.0, 0.0), OK);
        blocks(&mut e, 2);
        assert!((0..MAX_POLY).all(|k| voice(&e, 0, k).1 == 0.0), "the Off releases all four");
        // Removing the Chord while a chord is held releases it (no stuck voice).
        assert_eq!(e.command(OP_NOTE_ON, 60.0, 100.0, 0.0, 0.0), OK);
        blocks(&mut e, 10);
        assert_eq!((0..MAX_POLY).filter(|&k| voice(&e, 0, k).1 == 1.0).count(), 4);
        assert_eq!(e.command(OP_RACK_REMOVE_MODULE, 0.0, 5.0, 0.0, 0.0), OK);
        blocks(&mut e, 4); // the removal waits for the 2 ms fade
        assert!((0..MAX_POLY).all(|k| voice(&e, 0, k).1 == 0.0), "removal flushes the chord");
        assert_eq!(e.command(OP_NOTE_OFF, 60.0, 0.0, 0.0, 0.0), OK); // harmless now
        // SET_KEY is validated.
        assert_eq!(e.command(OP_SET_KEY, 4.0, 0.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_SET_KEY, 12.0, 0.0, 0.0, 0.0), crate::protocol::ERR_BAD_INDEX);
    }

    #[test]
    fn arp_while_stopped_plays_live_keys_on_its_own_clock() {
        let mut e = Engine::new(SR);
        patch(&mut e, 0.0, 1.0);
        assert_eq!(e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 0.0, 5.0, K_ARP, 0.0), OK);
        assert_eq!(e.command(OP_NOTE_ON, 60.0, 100.0, 0.0, 0.0), OK);
        // 120 BPM 1/16 = 6000 frames, gate 50 %: the gate is high for the
        // first half of every step.
        let mut highs = 0;
        let mut edges = 0;
        let mut was = 0.0;
        for _ in 0..(4 * 6000 / 128) {
            blocks(&mut e, 1);
            let g = voice(&e, 0, 0).1;
            if g == 1.0 {
                highs += 1;
            }
            if g == 1.0 && was == 0.0 {
                edges += 1;
            }
            was = g;
        }
        assert_eq!(edges, 4, "four steps in four sixteenths");
        assert!((80..=100).contains(&highs), "about half the blocks: {highs}");
    }
}
