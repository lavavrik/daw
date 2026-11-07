//! Attenuator: `out = in × amount + offset`, per channel (poly).
//!
//! An attenuverter with offset for CV (and audio): amount −1..1 scales and
//! inverts, offset −1..1 shifts. Channels follow `in`; with `in` unconnected
//! the output is the offset alone on 1 channel (a constant CV source). Both
//! params are smoothed per sample.

use super::{default, param, Smooth};
use crate::rack::catalog::ModuleKind;
use crate::rack::port::{poly, PortBuf};
use crate::RACK_BLOCK;

const K: ModuleKind = ModuleKind::Attenuator;
const AMOUNT: usize = 0;
const OFFSET: usize = 1;

#[derive(Clone)]
pub struct Attenuator {
    amount: Smooth,
    offset: Smooth,
}

impl Attenuator {
    /// Automation: the next sub-block takes its `smooth` params at once.
    pub fn snap(&mut self) {
        self.amount.snap();
        self.offset.snap();
    }

    pub fn new(sr: f32) -> Attenuator {
        Attenuator { amount: Smooth::new(sr, default(K, AMOUNT)), offset: Smooth::new(sr, default(K, OFFSET)) }
    }

    pub fn process(&mut self, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
        let (Some(inp), Some(out)) = (ins.first(), outs.first_mut()) else { return };
        let channels = poly(&ins[..1]);
        out.channels = channels;
        let (at, ot) = (param(params, K, AMOUNT), param(params, K, OFFSET));
        for i in 0..RACK_BLOCK {
            let (amount, offset) = (self.amount.next(at), self.offset.next(ot));
            for (ch, row) in out.data.iter_mut().take(channels).enumerate() {
                let x = inp.get(ch, i);
                let y = if x.is_finite() { x } else { 0.0 } * amount + offset;
                row[i] = if y.is_finite() { y } else { 0.0 };
            }
        }
    }
}
