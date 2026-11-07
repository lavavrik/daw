//! VCA: `out = in × level × cv` (cv taken as 1 when unconnected).
//!
//! Channels follow the inputs (max of `in` and `cv`, min 1), with mono
//! broadcast: a 1-channel `cv` (e.g. an LFO) scales every voice of a poly `in`.

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::{poly, PortBuf};
use crate::RACK_BLOCK;

const LEVEL: usize = 0;

#[derive(Clone)]
pub struct Vca {
    level: Smooth,
}

impl Vca {
    /// Automation: the next sub-block takes its `smooth` params at once.
    pub fn snap(&mut self) {
        self.level.snap();
    }

    pub fn new(sr: f32) -> Vca {
        Vca { level: Smooth::new(sr, default(ModuleKind::Vca, LEVEL)) }
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let (Some(inp), Some(cv), Some(out)) = (ins.first(), ins.get(1), outs.first_mut()) else {
            return;
        };
        let target = param(params, ModuleKind::Vca, LEVEL);
        let channels = poly(&ins[..2]);
        out.channels = channels;
        let cv_connected = cv.channels > 0;
        for i in 0..RACK_BLOCK {
            let level = self.level.next(target);
            for (ch, row) in out.data.iter_mut().take(channels).enumerate() {
                let c = if cv_connected { cv.get(ch, i) } else { 1.0 };
                row[i] = inp.get(ch, i) * level * c;
            }
        }
    }
}
