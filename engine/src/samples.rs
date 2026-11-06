//! Sample pool: `MAX_SAMPLES` slots describing audio held in the arena.
//! Data is planar: `[L0..Ln, R0..Rn]` (mono is just `[M0..Mn]`).

use crate::arena::{SampleArena, SampleSlice};
use crate::MAX_SAMPLES;

#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub slice: SampleSlice,
    pub frames: usize,
    pub channels: u8,
    pub ready: bool,
}

pub struct SamplePool {
    slots: Vec<Option<Sample>>,
}

impl SamplePool {
    pub fn new() -> Self {
        SamplePool { slots: vec![None; MAX_SAMPLES] }
    }

    /// Out-of-range ids are ignored.
    pub fn set(&mut self, id: usize, s: Sample) {
        if let Some(slot) = self.slots.get_mut(id) {
            *slot = Some(s);
        }
    }

    pub fn get(&self, id: usize) -> Option<&Sample> {
        self.slots.get(id)?.as_ref()
    }

    /// Mark ready; false if the id has no sample.
    pub fn mark_ready(&mut self, id: usize) -> bool {
        match self.slots.get_mut(id).and_then(|s| s.as_mut()) {
            Some(s) => {
                s.ready = true;
                true
            }
            None => false,
        }
    }

    /// Read accessor for voices (Task 6): `(planar data, frames, channels)`,
    /// or `None` while the slot is empty or not yet `ready` (=> silent).
    /// Data is `[L0..Ln, R0..Rn]`; right channel starts at index `frames`.
    pub fn playable<'a>(
        &self,
        arena: &'a SampleArena,
        id: usize,
    ) -> Option<(&'a [f32], usize, u8)> {
        let s = self.get(id).filter(|s| s.ready)?;
        Some((arena.slice(s.slice), s.frames, s.channels))
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
        let (data, frames, ch) = pool.playable(&arena, 3).unwrap();
        assert_eq!((data.len(), frames, ch), (20, 10, 2));
        assert!(!pool.mark_ready(4));
    }
}
