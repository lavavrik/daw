//! Sample-accurate transport clock. Pure math, allocation-free.
//!
//! Time is measured in ticks (960 per quarter note, see `crate::PPQ`) as `f64`.
//! Tempo changes take effect at the next block boundary and never move the
//! tick position (position is integrated, never recomputed from time).
//! Within one tempo the playhead is `anchor + frames / samplesPerTick`, counted
//! from the last jump or tempo change ([`Transport::anchored`]), rather than a
//! running sum of per-block increments, so it does not drift: tick 11520 at
//! 120 bpm / 48 kHz is exactly frame 288000, and a step on a block boundary
//! fires on the boundary frame, not one frame early.
//!
//! # Modes and the loop
//! In Pattern mode `ticks` is the pattern playhead (every track loops its
//! current pattern from tick 0). In Song mode it is the song position, and
//! with the loop on (`loop_start < loop_end`) playback wraps from `loop_end`
//! to `loop_start`: [`Transport::split`] cuts a block at the wrap, so the
//! engine renders the part before it with the window `[t, loop_end)` and the
//! rest from `loop_start`. The wrap lands on the first frame whose tick
//! reaches `loop_end`, and that frame plays exactly `loop_start` (the
//! sub-sample remainder is dropped), so every pass lasts exactly
//! `ceil(loopLength * samplesPerTick)` frames and an event at `loop_start`
//! fires on the wrap frame itself: nothing double-fires or skips. A playhead
//! exactly at `loop_end` wraps at once; one already *after* `loop_end` when it
//! starts (seeked there while stopped) plays on without looping. A loop set
//! behind a playing song playhead is handled by the engine (`SetLoop` jumps
//! to `loop_start`), so `split` never sees that case while playing.

use crate::PPQ;

/// Float-noise tolerance (frames) of the loop-wrap split.
const SNAP_FRAMES: f64 = 1e-6;

/// One piece of a block (`Transport::split`): frames `from..to` render the
/// song-time window `[t0, t1)` at `spt` samples per tick; `wraps`: the loop
/// wraps at its end (the next piece starts at `loop_start`). The engine
/// renders the pieces and evaluates automation over the same list.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Piece {
    pub from: usize,
    pub to: usize,
    pub t0: f64,
    pub t1: f64,
    pub spt: f64,
    pub wraps: bool,
}

/// What the transport plays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Every track loops its current pattern.
    Pattern,
    /// The arrangement (clips) plays on the song timeline.
    Song,
}

/// Tempo, run state, playhead, mode and loop range.
pub struct Transport {
    pub bpm: f32,
    pub playing: bool,
    /// Playhead in ticks at the start of the next block to render. Pattern
    /// mode: negative during a count-in (`PLAY` starts at `-count_in`), 0
    /// after Stop. Song mode: the song position.
    pub ticks: f64,
    pub mode: Mode,
    /// Loop range in song ticks; the loop is on while `loop_start < loop_end`.
    pub loop_start: f64,
    pub loop_end: f64,
    /// Song mode: where playback last started (or the last seek); Stop
    /// returns here when the loop is off.
    pub song_start: f64,
    /// `(tick, frames, spt)`: `ticks == tick + frames / spt` since the last
    /// jump or tempo change (see the module docs).
    anchor: (f64, f64, f64),
}

impl Transport {
    pub fn new() -> Transport {
        Transport {
            bpm: 124.0,
            playing: false,
            ticks: 0.0,
            mode: Mode::Pattern,
            loop_start: 0.0,
            loop_end: 0.0,
            song_start: 0.0,
            anchor: (0.0, 0.0, 0.0),
        }
    }

    /// The anchor `(tick, frames)` to continue the playhead from at `spt`
    /// samples per tick: the stored one if nothing moved `ticks` and the tempo
    /// is unchanged, else a fresh one at `ticks`.
    pub fn anchored(&self, spt: f64) -> (f64, f64) {
        let (tick, frames, a_spt) = self.anchor;
        if a_spt == spt && tick + frames / spt == self.ticks {
            (tick, frames)
        } else {
            (self.ticks, 0.0)
        }
    }

    /// Store the playhead `tick + frames / spt` and its anchor.
    pub fn set_anchored(&mut self, tick: f64, frames: f64, spt: f64) {
        self.ticks = tick + frames / spt;
        self.anchor = (tick, frames, spt);
    }

    /// Is the song loop on?
    pub fn loop_on(&self) -> bool {
        self.loop_start < self.loop_end
    }

    /// Song mode's Stop position: the loop start with the loop on, else
    /// where playback last started.
    pub fn song_home(&self) -> f64 {
        if self.loop_on() {
            self.loop_start
        } else {
            self.song_start
        }
    }

    /// The next piece of a block that starts (or continues) at tick `t` with
    /// `frames` frames left, at `spt` samples per tick:
    /// `(frames in this piece, window end tick, wraps)`. The piece's window is
    /// `[t, end)`. Without a wrap it is the whole rest, `end = t + frames/spt`.
    /// With `wraps` (Song mode, playing, loop on, `t < loop_end` and the rest
    /// reaches `loop_end`) the piece ends on the wrap frame, `end = loop_end`,
    /// and the next piece starts at `loop_start` (see the module docs).
    ///
    /// The playhead is integrated block by block, so it carries float noise
    /// (~1e-12 ticks): a frame count within `SNAP_FRAMES` of a whole number
    /// counts as that number, and a playhead that noise put a hair past
    /// `loop_end` still wraps (with a 0-frame piece) instead of escaping the
    /// loop.
    pub fn split(&self, t: f64, frames: usize, spt: f64) -> (usize, f64, bool) {
        let whole = (frames, t + frames as f64 / spt, false);
        let looping = self.playing && self.mode == Mode::Song && self.loop_on();
        if !(looping && spt > 0.0 && spt.is_finite()) {
            return whole;
        }
        // Frames whose tick is still below loop_end.
        let x = (self.loop_end - t) * spt;
        if !(x > -SNAP_FRAMES) {
            return whole; // after loop_end (or garbage): plays on
        }
        let before = if (x - x.round()).abs() < SNAP_FRAMES { x.round() } else { x.ceil() };
        if before <= frames as f64 {
            (before.max(0.0) as usize, self.loop_end, true)
        } else {
            whole
        }
    }

    /// `sr * 60 / (bpm * PPQ)`.
    pub fn samples_per_tick(&self, sr: f32) -> f64 {
        sr as f64 * 60.0 / (self.bpm as f64 * PPQ)
    }


}

impl Default for Transport {
    fn default() -> Self {
        Self::new()
    }
}

/// Allocation-free event scheduler shared by the metronome and the drum
/// sequencer. Events repeat every `period` ticks; event `i` of loop `k` sits
/// at absolute tick `k*period + offsets[i]` (offsets should lie in
/// `[0, period)`). For every such event with tick in the half-open window
/// `[t0, t1)`, calls `f(i, tick)` in time order, handling the wrap at the
/// period boundary (the window may span several loops). `tick` is absolute,
/// so use `tick_to_offset` to place it in the block, and `i` to look up what
/// to play. Callers wanting a different loop origin should subtract it from
/// `t0`/`t1` first.
///
/// Ticks below 0 (the count-in) never yield events: a window entirely below 0
/// yields nothing, and one crossing 0 only its events at ticks `>= 0`. (The
/// metronome, which does click during the count-in, shifts its window by
/// whole bars.)
pub fn events_in_window(
    t0: f64,
    t1: f64,
    period: f64,
    offsets: &[f64],
    mut f: impl FnMut(usize, f64),
) {
    if !(period > 0.0) || !(t1 > t0) || !(t1 > 0.0) || !t0.is_finite() || !t1.is_finite() {
        return;
    }
    let t0 = t0.max(0.0);
    let mut k = (t0 / period).floor();
    while k * period < t1 {
        let base = k * period;
        for (i, &o) in offsets.iter().enumerate() {
            let t = base + o;
            if t >= t0 && t < t1 {
                f(i, t);
            }
        }
        k += 1.0;
    }
}

/// Sample offset of `tick` inside a block starting at tick `t0`:
/// `round((tick - t0) * samples_per_tick)` clamped to `[0, frames-1]`.
pub fn tick_to_offset(tick: f64, t0: f64, samples_per_tick: f64, frames: usize) -> usize {
    let o = ((tick - t0) * samples_per_tick).round();
    if o.is_nan() || o <= 0.0 {
        0
    } else {
        (o as usize).min(frames.saturating_sub(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_wraps_on_the_first_frame_at_loop_end() {
        let mut t = Transport::new();
        t.playing = true;
        t.mode = Mode::Song;
        t.loop_start = 3840.0;
        t.loop_end = 11520.0;
        // 25 samples per tick: tick 11519.5 is frame 0, loop_end is frame 12.5,
        // so frames 0..13 play before the wrap and frame 13 is loop_start.
        assert_eq!(t.split(11519.5, 128, 25.0), (13, 11520.0, true));
        assert_eq!(t.split(11000.0, 128, 25.0), (128, 11000.0 + 128.0 / 25.0, false));
        assert_eq!(t.split(11520.0 - 128.0 / 25.0, 128, 25.0), (128, 11520.0, true), "wrap at the block end");
        assert_eq!(t.split(11520.0 + 1e-10, 128, 25.0), (0, 11520.0, true), "noise past loop_end still wraps");
        assert!(!t.split(11520.5, 128, 25.0).2, "after loop_end plays on");
        assert!(!t.split(0.0, 128, 25.0).2, "before the loop, far from its end");
        t.loop_end = 3840.0; // off
        assert!(!t.split(11519.5, 128, 25.0).2);
        t.loop_end = 11520.0;
        t.mode = Mode::Pattern;
        assert!(!t.split(11519.5, 128, 25.0).2, "Pattern mode never loops");
        t.mode = Mode::Song;
        t.playing = false;
        assert!(!t.split(11519.5, 128, 25.0).2, "stopped");
    }

    #[test]
    fn anchored_playhead_does_not_drift() {
        let mut t = Transport::new();
        let (mut tick, mut frames) = t.anchored(25.0);
        for _ in 0..2250 {
            frames += 128.0;
            t.set_anchored(tick, frames, 25.0);
            (tick, frames) = t.anchored(25.0);
        }
        assert_eq!(t.ticks, 11520.0, "exact after 2250 blocks");
        t.ticks = 3840.0; // a jump re-anchors
        assert_eq!(t.anchored(25.0), (3840.0, 0.0));
        t.set_anchored(3840.0, 128.0, 25.0);
        assert_eq!(t.anchored(20.0), (t.ticks, 0.0), "a tempo change re-anchors");
    }

    #[test]
    fn step_math_120bpm_48k() {
        let mut t = Transport::new();
        t.bpm = 120.0;
        let spt = t.samples_per_tick(48000.0);
        assert!((spt - 25.0).abs() < 1e-9);
        assert!((spt * crate::STEP_TICKS - 6000.0).abs() < 1e-6);
    }

    #[test]
    fn events_wrap_at_period() {
        let mut got = Vec::new();
        events_in_window(3800.0, 3900.0, 3840.0, &[0.0], |i, t| got.push((i, t)));
        assert_eq!(got, vec![(0, 3840.0)]);
    }

    #[test]
    fn events_half_open_and_multiple_offsets() {
        let mut got = Vec::new();
        events_in_window(0.0, 960.0, 3840.0, &[0.0, 960.0, 1920.0], |i, t| got.push((i, t)));
        assert_eq!(got, vec![(0, 0.0)]); // 960 excluded: window is [t0, t1)
        got.clear();
        events_in_window(960.0, 1920.0, 3840.0, &[0.0, 960.0, 1920.0], |i, t| got.push((i, t)));
        assert_eq!(got, vec![(1, 960.0)]);
    }

    #[test]
    fn negative_ticks_never_yield_events() {
        let mut got = Vec::new();
        events_in_window(-3840.0, -1.0, 3840.0, &[0.0, 960.0], |i, t| got.push((i, t)));
        events_in_window(-1.0, 0.0, 3840.0, &[0.0], |i, t| got.push((i, t)));
        assert!(got.is_empty(), "{got:?}");
        events_in_window(-1.0, 1.0, 3840.0, &[0.0, 960.0], |i, t| got.push((i, t)));
        assert_eq!(got, vec![(0, 0.0)]);
    }

    #[test]
    fn tick_offset_rounds_and_clamps() {
        assert_eq!(tick_to_offset(10.0, 0.0, 25.0, 128), 127); // 250 -> clamped
        assert_eq!(tick_to_offset(1.0, 0.0, 25.0, 128), 25);
        assert_eq!(tick_to_offset(-1.0, 0.0, 25.0, 128), 0);
    }
}
