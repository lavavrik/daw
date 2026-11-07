//! Synth tracks: one modular [`Rack`] and one [`NotePattern`] per track slot.
//!
//! # Memory
//! [`Synths::new`] preallocates all `MAX_TRACKS` tracks (racks and patterns)
//! and the shared event buffer up front (in `Engine::new`), so adding a synth
//! track, editing its patch or pattern, playing notes and rendering never
//! allocate.
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

use crate::rack::modules::{Ctx, NoteEvent};
use crate::rack::Rack;
use crate::sequencer::{EventBuf, NotePattern, SeqNote};
use crate::MAX_TRACKS;

/// One synth track: its patch and its note pattern.
pub struct SynthTrack {
    pub rack: Rack,
    pub pattern: NotePattern,
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
            tracks.push(SynthTrack { rack: Rack::new(sample_rate), pattern: NotePattern::new() });
        }
        Synths { tracks, active: [false; MAX_TRACKS], events: Box::new(EventBuf::new()) }
    }

    /// Is `slot` an active synth track?
    pub fn is_active(&self, slot: usize) -> bool {
        self.active.get(slot).copied().unwrap_or(false)
    }

    /// Make `slot` an active synth track with an empty patch and an empty
    /// pattern. If the slot still holds a patch (active or fading out), it is
    /// cleared with the rack's 2 ms declick fade.
    pub fn add_track(&mut self, slot: usize) {
        if let (Some(t), Some(a)) = (self.tracks.get_mut(slot), self.active.get_mut(slot)) {
            t.rack.clear();
            t.pattern.reset(); // the cleared rack drops its notes anyway
            *a = true;
        }
    }

    /// Deactivate `slot`: the rack fades out over 2 ms, then clears, and the
    /// pattern is reset. A no-op for an inactive slot.
    pub fn remove_track(&mut self, slot: usize) {
        if let (Some(t), Some(a)) = (self.tracks.get_mut(slot), self.active.get_mut(slot)) {
            if *a {
                t.rack.clear();
                t.pattern.reset();
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

    /// The pattern of an active synth track, else `None`.
    pub fn pattern(&self, slot: usize) -> Option<&NotePattern> {
        if self.is_active(slot) {
            self.tracks.get(slot).map(|t| &t.pattern)
        } else {
            None
        }
    }

    /// Deliver a live note/controller event to an active synth track (ignored
    /// for any other slot).
    pub fn note(&mut self, slot: usize, ev: NoteEvent) {
        if let Some(rack) = self.rack_mut(slot) {
            rack.note(ev);
        }
    }

    /// Store a pattern note; a sounding note it replaces is released. Returns
    /// `false` if `slot` is not an active synth track.
    pub fn set_note(&mut self, slot: usize, idx: usize, note: SeqNote) -> bool {
        let Some(t) = self.track_mut(slot) else { return false };
        if let Some(pitch) = t.pattern.set(idx, note) {
            t.rack.note(NoteEvent::Off { note: pitch });
        }
        true
    }

    /// Remove a pattern note (released if sounding). `false` if `slot` is not
    /// an active synth track.
    pub fn remove_note(&mut self, slot: usize, idx: usize) -> bool {
        let Some(t) = self.track_mut(slot) else { return false };
        if let Some(pitch) = t.pattern.remove(idx) {
            t.rack.note(NoteEvent::Off { note: pitch });
        }
        true
    }

    /// Remove every pattern note, releasing the sounding ones. `false` if
    /// `slot` is not an active synth track.
    pub fn clear_notes(&mut self, slot: usize) -> bool {
        let Some(t) = self.track_mut(slot) else { return false };
        let released = t.pattern.clear();
        release(&mut t.rack, released);
        true
    }

    /// Set the pattern length (a change releases the sounding notes). `false`
    /// if `slot` is not an active synth track.
    pub fn set_pattern_bars(&mut self, slot: usize, bars: u8) -> bool {
        let Some(t) = self.track_mut(slot) else { return false };
        let released = t.pattern.set_bars(bars);
        release(&mut t.rack, released);
        true
    }

    /// Stop: send `Off` for every sequenced pitch still sounding on every
    /// track. Never `AllOff`, so live keys (and the pedal) stay held.
    pub fn release_sequenced(&mut self) {
        for t in self.tracks.iter_mut() {
            let released = t.pattern.release_all();
            release(&mut t.rack, released);
        }
    }

    /// Render every active track (and any removed track still fading out),
    /// **adding** into `left`/`right`. `window` is the transport's
    /// `(t0, t1, samples_per_tick)` for this block while playing (patterns
    /// play), `None` while stopped. `ctx.ticks` must equal `t0`.
    pub fn render_add(&mut self, ctx: &Ctx, window: Option<(f64, f64, f64)>, left: &mut [f32], right: &mut [f32]) {
        let n = left.len().min(right.len());
        let events = &mut *self.events;
        for (t, &active) in self.tracks.iter_mut().zip(self.active.iter()) {
            if !(active || t.rack.is_sounding()) {
                continue;
            }
            events.clear();
            if let (true, Some((t0, t1, spt))) = (active, window) {
                t.pattern.events(t0, t1, spt, n, events);
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
