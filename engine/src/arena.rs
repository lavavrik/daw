//! Sample arena: a bump allocator over zeroed `Vec<f32>` chunks.
//! Chunks are only ever added (never reallocated), so earlier slices stay valid
//! and the heap grows only when the caller allows it (transport stopped).
//! Freed space is reclaimed only by `reset` (engine reset on project load);
//! removed samples leak until then.
//!
//! # Budget
//! The floats handed out since the last reset ([`allocated`](SampleArena::allocated),
//! live and leaked samples together) never pass the budget
//! (`MAX_ARENA_FLOATS`, 1 GiB, in the engine): `alloc` refuses a request
//! that would, whether or not it may grow, and a grown chunk is cut so it
//! never extends past the budget either. The engine maps that refusal to
//! `ERR_OUT_OF_MEMORY` (playing or stopped), checking
//! [`over_budget`](SampleArena::over_budget) first. Space wasted at the end
//! of a chunk that a request skipped is not handed out, so it does not count.

/// Handle to a region inside the arena.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SampleSlice {
    chunk: u32,
    start: u32,
    len: u32,
}

/// Minimum size of a grown chunk, in floats (64 MB).
const GROW_CHUNK: usize = 16 * 1024 * 1024;

pub struct SampleArena {
    chunks: Vec<Vec<f32>>,
    /// Bump offset within each chunk (parallel to `chunks`).
    used: Vec<usize>,
    /// Floats handed out since the last reset.
    allocated: usize,
    /// Most floats `allocated` may reach.
    budget: usize,
}

impl SampleArena {
    /// First chunk of `frames` zeroed floats (the pre-reserved arena), with
    /// the engine's budget (`MAX_ARENA_FLOATS`).
    pub fn with_capacity(frames: usize) -> Self {
        Self::with_budget(frames, crate::MAX_ARENA_FLOATS)
    }

    /// [`with_capacity`](Self::with_capacity) with another budget (tests use
    /// a small one so they never touch 1 GiB).
    pub fn with_budget(frames: usize, budget: usize) -> Self {
        SampleArena { chunks: vec![vec![0.0; frames]], used: vec![0], allocated: 0, budget }
    }

    /// Floats handed out since the last [`reset`](Self::reset).
    pub fn allocated(&self) -> usize {
        self.allocated
    }

    /// Would handing out `len` more floats pass the budget?
    pub fn over_budget(&self, len: usize) -> bool {
        self.allocated.checked_add(len).is_none_or(|total| total > self.budget)
    }

    /// Bump-allocate `len` floats. A request never straddles chunks: if the
    /// current (last) chunk lacks room, a new chunk of `max(64 MB, len)` is
    /// added when `may_grow` (cut at the budget). Returns `None` (changing
    /// nothing) when the request would pass the budget, when there is no
    /// room and `!may_grow`, or when growing fails (out of memory: on WASM
    /// `memory.grow` hit the max). Growth is fallible on purpose: `vec![]`
    /// would abort (a WASM trap that kills the engine) instead.
    pub fn alloc(&mut self, len: usize, may_grow: bool) -> Option<SampleSlice> {
        if self.over_budget(len) {
            return None;
        }
        let last = self.chunks.len() - 1;
        if self.chunks[last].len() - self.used[last] < len {
            if !may_grow {
                return None;
            }
            self.chunks.try_reserve(1).ok()?;
            self.used.try_reserve(1).ok()?;
            // `budget - allocated >= len` (checked above).
            let size = GROW_CHUNK.max(len).min(self.budget - self.allocated);
            let chunk = try_zeroed(size)?; // heap grows here
            self.chunks.push(chunk); // capacity reserved above: cannot fail
            self.used.push(0);
        }
        let chunk = self.chunks.len() - 1;
        let start = self.used[chunk];
        if start > u32::MAX as usize || len > u32::MAX as usize {
            return None; // unrepresentable handle; unreachable with real sizes
        }
        self.used[chunk] += len;
        self.allocated += len;
        Some(SampleSlice { chunk: chunk as u32, start: start as u32, len: len as u32 })
    }

    pub fn slice(&self, s: SampleSlice) -> &[f32] {
        let st = s.start as usize;
        &self.chunks[s.chunk as usize][st..st + s.len as usize]
    }

    pub fn slice_mut(&mut self, s: SampleSlice) -> &mut [f32] {
        let st = s.start as usize;
        &mut self.chunks[s.chunk as usize][st..st + s.len as usize]
    }

    /// Free everything but the first chunk, which is reused from its start.
    /// Allocation-free (grown chunks are only freed), and the first chunk is
    /// **not** re-zeroed: that would be a 128 MB memset on the audio thread
    /// (tens of ms, a dropout). Nothing needs it: the UI fills every
    /// allocation completely before marking its sample ready, voices never
    /// read a sample that is not ready, and a voice still holding an old
    /// sample stops reading it when the pool's generation changes
    /// (`samples.rs`).
    pub fn reset(&mut self) {
        self.chunks.truncate(1);
        self.used.truncate(1);
        if let Some(u) = self.used.first_mut() {
            *u = 0;
        }
        self.allocated = 0;
    }
}

/// A zeroed `Vec<f32>` of `len`, or `None` if the allocation fails.
///
/// Like `vec![0.0; len]` (which aborts on failure) but fallible. Uses
/// `alloc_zeroed` rather than `Vec::try_reserve_exact` + `resize` so fresh
/// pages from `memory.grow` (already zero) are not written again: zeroing a
/// 256 MB chunk by hand would stall the audio thread for many blocks.
fn try_zeroed(len: usize) -> Option<Vec<f32>> {
    if len == 0 {
        return Some(Vec::new());
    }
    let layout = std::alloc::Layout::array::<f32>(len).ok()?;
    // SAFETY: `layout` has non-zero size (len > 0). On success the block is
    // zeroed (all-zero bits are a valid f32 0.0) and was allocated by the
    // global allocator with exactly the layout `Vec<f32>` uses for capacity
    // `len`, so `from_raw_parts(p, len, len)` takes ownership soundly.
    unsafe {
        let p = std::alloc::alloc_zeroed(layout) as *mut f32;
        if p.is_null() {
            return None;
        }
        Some(Vec::from_raw_parts(p, len, len))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alloc_bumps_and_slices_are_disjoint() {
        let mut a = SampleArena::with_capacity(1000);
        let s1 = a.alloc(100, false).unwrap();
        let s2 = a.alloc(200, false).unwrap();
        a.slice_mut(s1).fill(1.0);
        a.slice_mut(s2).fill(2.0);
        assert_eq!(a.slice(s1).len(), 100);
        assert_eq!(a.slice(s2).len(), 200);
        assert!(a.slice(s1).iter().all(|&x| x == 1.0));
        assert!(a.slice(s2).iter().all(|&x| x == 2.0));
        assert_eq!(s2.start, s1.start + 100); // bumped
    }

    #[test]
    fn alloc_when_full_and_playing_defers() {
        let mut a = SampleArena::with_capacity(1000);
        assert!(a.alloc(800, false).is_some());
        assert!(a.alloc(300, false).is_none());
        // the failed alloc consumed nothing
        assert!(a.alloc(200, false).is_some());
    }

    #[test]
    fn alloc_when_full_and_stopped_grows() {
        let mut a = SampleArena::with_capacity(1000);
        let s1 = a.alloc(800, true).unwrap();
        a.slice_mut(s1).fill(7.0);
        let s2 = a.alloc(300, true).unwrap();
        assert_eq!(a.slice(s2).len(), 300);
        assert_ne!(s1.chunk, s2.chunk);
        assert!(a.slice(s1).iter().all(|&x| x == 7.0)); // old data intact
        // an oversized request gets a chunk of its own size
        let big = a.alloc(GROW_CHUNK + 5, true).unwrap();
        assert_eq!(a.slice(big).len(), GROW_CHUNK + 5);
    }

    #[test]
    fn failed_growth_returns_none_instead_of_aborting() {
        // No budget, so the growth itself is what fails.
        let mut a = SampleArena::with_budget(1000, usize::MAX);
        let s1 = a.alloc(800, true).unwrap();
        // Unallocatable (byte size overflows isize): must not abort the process.
        assert!(a.alloc(usize::MAX / 2, true).is_none());
        assert!(a.alloc(isize::MAX as usize / 4 + 1, true).is_none());
        // Nothing changed: the arena still works and old data is intact.
        a.slice_mut(s1).fill(3.0);
        let s2 = a.alloc(200, true).unwrap();
        assert_eq!((s2.chunk, s2.start), (0, 800));
        assert!(a.slice(s1).iter().all(|&x| x == 3.0));
    }

    #[test]
    fn arena_budget_refuses_past_the_limit() {
        let mut a = SampleArena::with_budget(1000, 3000);
        assert_eq!(a.allocated(), 0);
        assert!(a.alloc(800, false).is_some());
        assert_eq!(a.allocated(), 800);
        // Over the budget: refused even when growing is allowed, and the
        // refusal consumes nothing.
        assert!(a.alloc(2201, true).is_none());
        assert_eq!(a.allocated(), 800);
        // Up to the budget: a grown chunk never extends past it.
        let s = a.alloc(2200, true).unwrap();
        assert_eq!(s.chunk, 1);
        assert_eq!(a.chunks[1].len(), 2200, "the chunk is cut at the budget, not 64 MB");
        assert_eq!(a.allocated(), 3000);
        assert!(a.alloc(1, true).is_none() && a.alloc(1, false).is_none());
        // A reset hands everything back.
        a.reset();
        assert_eq!(a.allocated(), 0);
        assert!(a.alloc(1000, false).is_some());
        // The engine's arena uses the real budget.
        assert_eq!(SampleArena::with_capacity(10).budget, crate::MAX_ARENA_FLOATS);
    }

    #[test]
    fn reset_reuses_first_chunk() {
        let mut a = SampleArena::with_capacity(1000);
        a.alloc(800, true).unwrap();
        a.alloc(300, true).unwrap(); // second chunk
        a.reset();
        let s = a.alloc(1000, false).unwrap(); // whole first chunk is free again
        assert_eq!((s.chunk, s.start), (0, 0));
        assert!(a.alloc(1, false).is_none()); // extra chunks were freed
    }
}
