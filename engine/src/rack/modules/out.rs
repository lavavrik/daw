//! Out: the rack's stereo output.
//!
//! Sums every channel of `l` and of `r` (a poly voice signal mixes down here),
//! times `level`. If `r` is unconnected, `l` feeds both sides. The result for
//! the current sub-block is left in `l`/`r`, which the rack adds to the track
//! output (several Out modules sum). Non-finite samples are replaced by 0.

use super::{param, Smooth};
use crate::rack::port::PortBuf;
use crate::{MAX_POLY, RACK_BLOCK};

const LEVEL: usize = 0;

#[derive(Clone)]
pub struct Out {
    level: Smooth,
    /// This sub-block's stereo output.
    pub l: [f32; RACK_BLOCK],
    pub r: [f32; RACK_BLOCK],
}

impl Out {
    pub fn new(sr: f32) -> Out {
        Out { level: Smooth::new(sr, 0.8), l: [0.0; RACK_BLOCK], r: [0.0; RACK_BLOCK] }
    }

    pub fn reset(&mut self) {
        self.l = [0.0; RACK_BLOCK];
        self.r = [0.0; RACK_BLOCK];
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf]) {
        let (Some(l), Some(r)) = (ins.first(), ins.get(1)) else {
            self.reset();
            return;
        };
        let r = if r.channels == 0 { l } else { r };
        let target = param(params, LEVEL, 0.8);
        for i in 0..RACK_BLOCK {
            let level = self.level.next(target);
            let sl: f32 = (0..l.channels.min(MAX_POLY)).map(|ch| l.get(ch, i)).sum();
            let sr: f32 = (0..r.channels.min(MAX_POLY)).map(|ch| r.get(ch, i)).sum();
            let (ol, or) = (sl * level, sr * level);
            self.l[i] = if ol.is_finite() { ol } else { 0.0 };
            self.r[i] = if or.is_finite() { or } else { 0.0 };
        }
    }
}
