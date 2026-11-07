//! Sample-accurate transport clock. Pure math, allocation-free.
//!
//! Time is measured in ticks (960 per quarter note, see `crate::PPQ`) as `f64`.
//! Tempo changes take effect at the next block boundary and never move the
//! tick position (position is integrated, never recomputed from time).

use crate::PPQ;

/// Tempo, run state and playhead.
pub struct Transport {
    pub bpm: f32,
    pub playing: bool,
    /// Playhead in ticks at the start of the next block to render. Negative
    /// during a count-in (`PLAY` starts at `-count_in`); 0 after Stop.
    pub ticks: f64,
}

impl Transport {
    pub fn new() -> Transport {
        Transport { bpm: 124.0, playing: false, ticks: 0.0 }
    }

    /// `sr * 60 / (bpm * PPQ)`.
    pub fn samples_per_tick(&self, sr: f32) -> f64 {
        sr as f64 * 60.0 / (self.bpm as f64 * PPQ)
    }

    /// `[t0, t1)` tick range covered by the next `frames`-sample block.
    pub fn block_window(&self, frames: usize, sr: f32) -> (f64, f64) {
        (self.ticks, self.ticks + frames as f64 / self.samples_per_tick(sr))
    }

    /// Move the playhead past a rendered block (no-op while stopped).
    pub fn advance(&mut self, frames: usize, sr: f32) {
        if self.playing {
            self.ticks += frames as f64 / self.samples_per_tick(sr);
        }
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
    fn step_math_120bpm_48k() {
        let t = Transport { bpm: 120.0, playing: true, ticks: 0.0 };
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
