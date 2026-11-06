//! Synth tracks: one modular [`Rack`] per track slot.
//!
//! # Memory
//! [`Synths::new`] preallocates all `MAX_TRACKS` racks up front (in
//! `Engine::new`), so adding a synth track, editing its patch, playing notes
//! and rendering never allocate.
//!
//! # Rendering
//! Every *active* synth track renders every block, playing or not: its rack's
//! declick queue only drains while rendering, and free-running modules (LFOs,
//! release tails) must keep moving while stopped. A removed track keeps
//! rendering only while its rack is still sounding (its 2 ms fade-out and the
//! rack's 50 ms "sounding" window), then costs nothing.
//!
//! # Declicking
//! Removing a track (or re-adding it, which resets it to an empty patch)
//! calls [`Rack::clear`]. On a sounding rack that queues the clear behind the
//! rack's own 2 ms output fade, so the track fades out over 2 ms and then
//! clears; on a silent rack it applies at once. Edits sent after the clear
//! (e.g. building a new patch) validate against the empty patch immediately
//! and apply, in order, once the fade-out is done.

use crate::rack::modules::{Ctx, NoteEvent};
use crate::rack::Rack;
use crate::MAX_TRACKS;

/// All synth tracks (racks) of the engine, indexed by track slot.
pub struct Synths {
    racks: Vec<Rack>,
    active: [bool; MAX_TRACKS],
}

impl Synths {
    /// Preallocates `MAX_TRACKS` empty racks. The only allocating call.
    pub fn new(sample_rate: f32) -> Synths {
        let mut racks = Vec::with_capacity(MAX_TRACKS);
        for _ in 0..MAX_TRACKS {
            racks.push(Rack::new(sample_rate));
        }
        Synths { racks, active: [false; MAX_TRACKS] }
    }

    /// Is `slot` an active synth track?
    pub fn is_active(&self, slot: usize) -> bool {
        self.active.get(slot).copied().unwrap_or(false)
    }

    /// Make `slot` an active synth track with an empty patch. If the slot
    /// still holds a patch (active or fading out), it is cleared with the
    /// rack's 2 ms declick fade.
    pub fn add_track(&mut self, slot: usize) {
        if let (Some(rack), Some(a)) = (self.racks.get_mut(slot), self.active.get_mut(slot)) {
            rack.clear();
            *a = true;
        }
    }

    /// Deactivate `slot`: the rack fades out over 2 ms, then clears. A no-op
    /// for an inactive slot.
    pub fn remove_track(&mut self, slot: usize) {
        if let (Some(rack), Some(a)) = (self.racks.get_mut(slot), self.active.get_mut(slot)) {
            if *a {
                rack.clear();
                *a = false;
            }
        }
    }

    /// The rack of an active synth track (for patch edits), else `None`.
    pub fn rack_mut(&mut self, slot: usize) -> Option<&mut Rack> {
        if self.is_active(slot) {
            self.racks.get_mut(slot)
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

    /// Render every active track (and any removed track still fading out),
    /// **adding** into `left`/`right`.
    pub fn render_add(&mut self, ctx: &Ctx, left: &mut [f32], right: &mut [f32]) {
        for (rack, &active) in self.racks.iter_mut().zip(self.active.iter()) {
            if active || rack.is_sounding() {
                rack.render_add(ctx, left, right);
            }
        }
    }
}
