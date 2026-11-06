//! Metronome click: exponentially decaying sine, rendered sample-accurately.
//! A click that starts late in a block keeps sounding in the next block.

use core::f32::consts::TAU;

const TAU_SECS: f32 = 0.005;
const LEN_SECS: f32 = 0.020;
const AMP: f32 = 0.3;
pub const ACCENT_HZ: f32 = 1500.0;
pub const BEAT_HZ: f32 = 1000.0;

pub struct Metronome {
    pub on: bool,
    sr: f32,
    len: usize,
    /// Samples already rendered of the current click; `>= len` means idle.
    pos: usize,
    freq: f32,
}

impl Metronome {
    pub fn new(sr: f32) -> Metronome {
        let len = (LEN_SECS * sr) as usize;
        Metronome { on: false, sr, len, pos: len, freq: BEAT_HZ }
    }

    /// Start a click now (retriggers any click in progress).
    pub fn trigger(&mut self, accent: bool) {
        self.freq = if accent { ACCENT_HZ } else { BEAT_HZ };
        self.pos = 0;
    }

    /// Add the click (if sounding) to both channels, starting at index 0.
    pub fn render_add(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len().min(right.len());
        for i in 0..n {
            if self.pos >= self.len {
                break;
            }
            let t = self.pos as f32 / self.sr;
            let v = AMP * (-t / TAU_SECS).exp() * (TAU * self.freq * t).sin();
            left[i] += v;
            right[i] += v;
            self.pos += 1;
        }
    }
}
