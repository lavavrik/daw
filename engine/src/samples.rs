//! Sample pool: `MAX_SAMPLES` slots describing audio held in the arena.
//! Data is planar: `[L0..Ln, R0..Rn]` (mono is just `[M0..Mn]`).
//!
//! # Generations
//! Every `set` stamps its slot with a new pool-wide *generation* number, and
//! [`clear`](SamplePool::clear) (engine reset) bumps it too, so a generation
//! names one particular upload of one id. A voice (drum row, Sample Player)
//! captures the generation when it starts and, each block, plays on only
//! while [`playable`](SamplePool::playable) still reports the same one. A
//! replaced, un-readied or cleared sample therefore never has its new (or
//! freed) memory read by an old voice, even when an arena reset hands the
//! very same arena slice to the new sample; the voice holds its last value
//! and fades it out instead (2 ms). The counter is `u32` and wraps after
//! 4 billion uploads, which never happens in a session.

use crate::arena::{SampleArena, SampleSlice};
use crate::MAX_SAMPLES;

#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub slice: SampleSlice,
    pub frames: usize,
    pub channels: u8,
    pub ready: bool,
}

#[derive(Clone, Copy, Debug)]
struct Slot {
    sample: Option<Sample>,
    /// The generation `set` stamped on it (meaningless while empty).
    generation: u32,
}

pub struct SamplePool {
    slots: Vec<Slot>,
    /// Last generation handed out (see the module docs).
    generation: u32,
}

impl SamplePool {
    pub fn new() -> Self {
        SamplePool { slots: vec![Slot { sample: None, generation: 0 }; MAX_SAMPLES], generation: 0 }
    }

    /// Store `s` under `id` with a new generation. Out-of-range ids are ignored.
    pub fn set(&mut self, id: usize, s: Sample) {
        if let Some(slot) = self.slots.get_mut(id) {
            self.generation = self.generation.wrapping_add(1);
            *slot = Slot { sample: Some(s), generation: self.generation };
        }
    }

    /// Empty every slot (engine reset; allocation-free). The generation moves
    /// on, so nothing captured before matches anything set after.
    pub fn clear(&mut self) {
        for slot in self.slots.iter_mut() {
            slot.sample = None;
        }
        self.generation = self.generation.wrapping_add(1);
    }

    pub fn get(&self, id: usize) -> Option<&Sample> {
        self.slots.get(id)?.sample.as_ref()
    }

    /// Generation of the sample under `id` (ready or not), `None` if empty.
    pub fn generation(&self, id: usize) -> Option<u32> {
        let slot = self.slots.get(id)?;
        slot.sample.map(|_| slot.generation)
    }

    /// Mark ready; false if the id has no sample.
    pub fn mark_ready(&mut self, id: usize) -> bool {
        match self.slots.get_mut(id).and_then(|s| s.sample.as_mut()) {
            Some(s) => {
                s.ready = true;
                true
            }
            None => false,
        }
    }

    /// Read accessor for voices: `(planar data, frames, channels, generation)`,
    /// or `None` while the slot is empty or not yet `ready` (=> silent).
    /// Data is `[L0..Ln, R0..Rn]`; right channel starts at index `frames`.
    pub fn playable<'a>(&self, arena: &'a SampleArena, id: usize) -> Option<(&'a [f32], usize, u8, u32)> {
        let slot = self.slots.get(id)?;
        let s = slot.sample.filter(|s| s.ready)?;
        Some((arena.slice(s.slice), s.frames, s.channels, slot.generation))
    }
}

impl Default for SamplePool {
    fn default() -> Self {
        Self::new()
    }
}

/// Read-only access to the sample pool for rack modules (the Sample Player),
/// passed down `Synths::render_add` -> `Rack::render_add` -> `Module::process`
/// next to the FX pool. `Copy`; [`NONE`](SampleView::NONE) has no samples
/// (racks rendered outside an engine, tests).
#[derive(Clone, Copy)]
pub struct SampleView<'a> {
    pool: Option<(&'a SamplePool, &'a SampleArena)>,
}

impl<'a> SampleView<'a> {
    /// No samples: every lookup is `None`.
    pub const NONE: SampleView<'static> = SampleView { pool: None };

    pub fn new(pool: &'a SamplePool, arena: &'a SampleArena) -> SampleView<'a> {
        SampleView { pool: Some((pool, arena)) }
    }

    /// [`SamplePool::playable`] of `id`.
    pub fn playable(&self, id: usize) -> Option<(&'a [f32], usize, u8, u32)> {
        let (pool, arena) = self.pool?;
        pool.playable(arena, id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unready_sample_is_silent() {
        let mut arena = SampleArena::with_capacity(1000);
        let mut pool = SamplePool::new();
        let slice = arena.alloc(20, false).unwrap();
        arena.slice_mut(slice).fill(0.5);
        pool.set(3, Sample { slice, frames: 10, channels: 2, ready: false });
        assert!(pool.playable(&arena, 3).is_none()); // not ready -> voices skip
        assert!(pool.playable(&arena, 4).is_none()); // empty slot
        assert!(pool.playable(&arena, 9999).is_none()); // out of range, no panic
        assert!(pool.mark_ready(3));
        let (data, frames, ch, _) = pool.playable(&arena, 3).unwrap();
        assert_eq!((data.len(), frames, ch), (20, 10, 2));
        assert!(!pool.mark_ready(4));
    }

    #[test]
    fn generation_changes_on_set_and_clear() {
        let mut arena = SampleArena::with_capacity(1000);
        let mut pool = SamplePool::new();
        let slice = arena.alloc(10, false).unwrap();
        pool.set(0, Sample { slice, frames: 10, channels: 1, ready: true });
        let g0 = pool.playable(&arena, 0).unwrap().3;
        // Replacing a sample (even with the very same slice) is a new generation.
        pool.set(0, Sample { slice, frames: 10, channels: 1, ready: true });
        let g1 = pool.playable(&arena, 0).unwrap().3;
        assert_ne!(g0, g1);
        // clear() empties every slot...
        pool.clear();
        assert!(pool.get(0).is_none() && pool.playable(&arena, 0).is_none());
        assert_eq!(pool.generation(0), None);
        // ...and after an arena reset the same id at the same slice is still a
        // generation no voice captured before.
        arena.reset();
        let again = arena.alloc(10, false).unwrap();
        assert_eq!(again, slice);
        pool.set(0, Sample { slice: again, frames: 10, channels: 1, ready: true });
        let g2 = pool.playable(&arena, 0).unwrap().3;
        assert!(g2 != g0 && g2 != g1);
        assert_eq!(pool.generation(0), Some(g2));
        // The read-only view used by rack modules sees the same thing.
        let v = SampleView::new(&pool, &arena);
        assert_eq!(v.playable(0).map(|p| p.3), Some(g2));
        assert!(v.playable(1).is_none() && SampleView::NONE.playable(0).is_none());
    }
}
