//! Sample arena: a bump allocator over zeroed `Vec<f32>` chunks.
//! Chunks are only ever added (never reallocated), so earlier slices stay valid
//! and the heap grows only when the caller allows it (transport stopped).
//! Freed space is reclaimed only by `reset` (project load); removed samples leak.

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
}

impl SampleArena {
    /// First chunk of `frames` zeroed floats (the pre-reserved arena).
    pub fn with_capacity(frames: usize) -> Self {
        SampleArena { chunks: vec![vec![0.0; frames]], used: vec![0] }
    }

    /// Bump-allocate `len` floats. A request never straddles chunks: if the
    /// current (last) chunk lacks room, a new chunk of `max(64 MB, len)` is
    /// added when `may_grow`. Returns `None` (changing nothing) when there is
    /// no room and `!may_grow`, or when growing fails (out of memory: on WASM
    /// `memory.grow` hit the max). Growth is fallible on purpose: `vec![]`
    /// would abort (a WASM trap that kills the engine) instead.
    pub fn alloc(&mut self, len: usize, may_grow: bool) -> Option<SampleSlice> {
        let last = self.chunks.len() - 1;
        if self.chunks[last].len() - self.used[last] < len {
            if !may_grow {
                return None;
            }
            self.chunks.try_reserve(1).ok()?;
            self.used.try_reserve(1).ok()?;
            let chunk = try_zeroed(GROW_CHUNK.max(len))?; // heap grows here
            self.chunks.push(chunk); // capacity reserved above: cannot fail
            self.used.push(0);
        }
        let chunk = self.chunks.len() - 1;
        let start = self.used[chunk];
        if start > u32::MAX as usize || len > u32::MAX as usize {
            return None; // unrepresentable handle; unreachable with real sizes
        }
        self.used[chunk] += len;
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

    /// Free everything but the first chunk, which is re-zeroed and reused.
    pub fn reset(&mut self) {
        self.chunks.truncate(1);
        self.used.truncate(1);
        self.used[0] = 0;
        self.chunks[0].fill(0.0);
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
        let mut a = SampleArena::with_capacity(1000);
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
    fn reset_reuses_first_chunk() {
        let mut a = SampleArena::with_capacity(1000);
        a.alloc(800, true).unwrap();
        a.alloc(300, true).unwrap(); // second chunk
        a.reset();
        let s = a.alloc(1000, false).unwrap(); // whole first chunk is free again
        assert_eq!((s.chunk, s.start), (0, 0));
        assert!(a.slice(s).iter().all(|&x| x == 0.0)); // re-zeroed
        assert!(a.alloc(1, false).is_none()); // extra chunks were freed
    }
}
