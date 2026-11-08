//! Song arrangement: the clips of one track on the song timeline.
//!
//! A [`Clip`] `{pattern, start, len, offset}` plays one of the track's
//! patterns at song tick `t` for `start <= t < start + len`, at pattern
//! position `(offset + (t - start)) mod patternLength` (the pattern repeats
//! inside the clip and is cut at the clip end). Clips of one track may
//! overlap; overlapping clips all play.
//!
//! Each track slot owns one [`Arrangement`] of `MAX_CLIPS` clip slots, all
//! preallocated in `Engine::new`. The UI addresses clips by index
//! (`OP_CLIP_SET` / `OP_CLIP_REMOVE` / `OP_CLIP_CLEAR`) and keeps the
//! authoritative clip list, like note slots. Playback state that belongs to a
//! clip lives with the track kind that needs it, indexed by the same clip
//! index: a synth track keeps one note `Voicing` per clip (the notes that clip
//! switched on, so a sounding note always knows its owning clip; see
//! `synth.rs`), a drum track keeps one latched swing per clip (see
//! `drums.rs`).
//!
//! # Time mapping
//! [`Clip::pattern_window`] maps a song-tick window onto the clip in
//! *unwrapped* pattern time `p = offset + (t - start)`. The pattern's own event
//! scanners already reduce `p` modulo the pattern length (and handle any
//! number of repeats inside one window), so the window never has to be split
//! at the pattern's repeat wrap and needs no period argument; a window always
//! maps to at most one piece (the part inside the clip).
//!
//! Everything here is plain data and allocation-free.

use crate::MAX_CLIPS;

/// One clip on a track's song timeline (ticks). An inactive clip is ignored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clip {
    pub active: bool,
    /// Pattern index, `< MAX_PATTERNS`.
    pub pattern: u8,
    /// First song tick.
    pub start: u32,
    /// Length in ticks, `>= 1`; `start + len <= MAX_SONG_TICKS`.
    pub len: u32,
    /// Pattern tick played at `start` (`< MAX_NOTE_TICKS`; reduced modulo the
    /// pattern length when played).
    pub offset: u32,
}

impl Clip {
    /// An empty slot.
    pub const OFF: Clip = Clip { active: false, pattern: 0, start: 0, len: 0, offset: 0 };

    /// First song tick after the clip.
    pub fn end(&self) -> u32 {
        self.start.saturating_add(self.len)
    }

    /// Does the clip play anywhere in the song window `[t0, t1)`?
    pub fn overlaps(&self, t0: f64, t1: f64) -> bool {
        self.active && (self.start as f64) < t1 && (self.end() as f64) > t0
    }

    /// Map the song window `[t0, t1)` (frame 0 of the rendered segment is at
    /// `t0`) onto this clip: `Some((p0, p1, origin))` where `[p0, p1)` is the
    /// part of the window inside the clip in unwrapped pattern time and
    /// `origin` is the pattern time of frame 0 (it may lie before the clip;
    /// event sample offsets are `(p - origin) * samplesPerTick`). `None` if the
    /// clip is inactive or does not overlap the window.
    pub fn pattern_window(&self, t0: f64, t1: f64) -> Option<(f64, f64, f64)> {
        if !self.overlaps(t0, t1) {
            return None;
        }
        let base = self.offset as f64 - self.start as f64; // p = t + base
        let a = t0.max(self.start as f64);
        let b = t1.min(self.end() as f64);
        if b > a {
            Some((a + base, b + base, t0 + base))
        } else {
            None
        }
    }
}

/// What the tracks play while the transport runs.
#[derive(Clone, Copy)]
pub enum Timeline<'a> {
    /// Pattern mode: every track loops its current pattern from tick 0;
    /// with a `focus` (`SET_PATTERN_FOCUS`) only that slot's pattern
    /// schedules steps / notes, every other track is silent (tails and live
    /// input still sound).
    Pattern { focus: Option<usize> },
    /// Song mode: every track plays its clips, `arrangements[slot]`
    /// (`MAX_TRACKS` entries; a missing entry means no clips).
    Song(&'a [Arrangement]),
}

impl Timeline<'_> {
    /// The clips of track `slot` in Song mode (empty otherwise).
    pub fn clips(&self, slot: usize) -> &[Clip] {
        match self {
            Timeline::Pattern { .. } => &[],
            Timeline::Song(a) => a.get(slot).map_or(&[], |a| a.clips()),
        }
    }

    /// Pattern mode: does track `slot` schedule its current pattern (no
    /// focus, or the focus is `slot`)? Always false in Song mode.
    pub fn pattern_plays(&self, slot: usize) -> bool {
        match self {
            Timeline::Pattern { focus } => focus.is_none_or(|f| f == slot),
            Timeline::Song(_) => false,
        }
    }
}

/// The clips of one track (see the module docs).
pub struct Arrangement {
    clips: [Clip; MAX_CLIPS],
    /// High-water mark: every active clip has an index below this.
    used: usize,
}

impl Arrangement {
    /// No clips.
    pub fn new() -> Arrangement {
        Arrangement { clips: [Clip::OFF; MAX_CLIPS], used: 0 }
    }

    /// Clip slot `idx` (`None` if out of range).
    pub fn clip(&self, idx: usize) -> Option<Clip> {
        self.clips.get(idx).copied()
    }

    /// The clip slots that may be active (`..used`), in index order.
    pub fn clips(&self) -> &[Clip] {
        self.clips.get(..self.used).unwrap_or(&[])
    }

    /// Store `clip` in slot `idx` (out of range: ignored). Returns `true` if
    /// the slot changed (an identical clip is a no-op, so the caller only
    /// releases a clip's notes on a real edit).
    pub fn set(&mut self, idx: usize, clip: Clip) -> bool {
        let clip = if clip.active { clip } else { Clip::OFF };
        let Some(slot) = self.clips.get_mut(idx) else { return false };
        if *slot == clip {
            return false;
        }
        *slot = clip;
        if clip.active && idx >= self.used {
            self.used = idx + 1;
        }
        self.shrink();
        true
    }

    /// Empty slot `idx`; `true` if it held a clip.
    pub fn remove(&mut self, idx: usize) -> bool {
        self.set(idx, Clip::OFF)
    }

    /// Remove every clip.
    pub fn clear(&mut self) {
        if let Some(c) = self.clips.get_mut(..self.used) {
            c.fill(Clip::OFF);
        }
        self.used = 0;
    }

    /// Call `f(idx, clip)` for every active clip overlapping the song window
    /// `[t0, t1)`, in index order (a fixed-size scan of `..used`).
    pub fn for_each_overlapping(&self, t0: f64, t1: f64, f: impl FnMut(usize, &Clip)) {
        for_each_overlapping(self.clips(), t0, t1, f);
    }

    /// Drop trailing empty slots from the high-water mark.
    fn shrink(&mut self) {
        while self.used > 0 && self.clips.get(self.used - 1).is_some_and(|c| !c.active) {
            self.used -= 1;
        }
    }
}

/// [`Arrangement::for_each_overlapping`] over a clip slice (as handed out by
/// [`Timeline::clips`] / [`Arrangement::clips`]).
pub fn for_each_overlapping(clips: &[Clip], t0: f64, t1: f64, mut f: impl FnMut(usize, &Clip)) {
    for (i, c) in clips.iter().enumerate() {
        if c.overlaps(t0, t1) {
            f(i, c);
        }
    }
}

impl Default for Arrangement {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(pattern: u8, start: u32, len: u32, offset: u32) -> Clip {
        Clip { active: true, pattern, start, len, offset }
    }

    #[test]
    fn pattern_window_clamps_to_the_clip_and_maps_offset() {
        let c = clip(3, 7680, 9600, 0);
        assert_eq!(c.pattern_window(0.0, 7680.0), None, "before");
        assert_eq!(c.pattern_window(17280.0, 17300.0), None, "after (end is exclusive)");
        assert_eq!(c.pattern_window(7600.0, 7700.0), Some((0.0, 20.0, -80.0)));
        assert_eq!(c.pattern_window(17200.0, 17300.0), Some((9520.0, 9600.0, 9520.0)));
        let c = clip(0, 3840, 3840, 1920);
        assert_eq!(c.pattern_window(3840.0, 3900.0), Some((1920.0, 1980.0, 1920.0)));
        assert_eq!(Clip::OFF.pattern_window(0.0, 1e9), None, "inactive");
        assert_eq!(c.pattern_window(f64::NAN, 4000.0), None);
    }

    #[test]
    fn set_remove_and_high_water_mark() {
        let mut a = Arrangement::new();
        assert!(a.set(5, clip(1, 0, 10, 0)));
        assert!(!a.set(5, clip(1, 0, 10, 0)), "identical: no-op");
        assert_eq!(a.clips().len(), 6);
        assert!(a.set(2, clip(2, 100, 10, 0)));
        assert!(a.remove(5));
        assert!(!a.remove(5));
        assert_eq!(a.clips().len(), 3, "trailing empties dropped");
        assert!(!a.set(MAX_CLIPS, clip(0, 0, 1, 0)), "out of range");
        let mut seen = Vec::new();
        a.set(0, clip(0, 0, 200, 0));
        a.for_each_overlapping(105.0, 106.0, |i, c| seen.push((i, c.pattern)));
        assert_eq!(seen, vec![(0, 0), (2, 2)]);
        a.clear();
        assert!(a.clips().is_empty());
        assert_eq!(a.clip(2), Some(Clip::OFF));
    }
}
