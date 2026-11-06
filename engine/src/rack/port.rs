//! Cable buffers: one sub-block of up to `MAX_POLY` channels.

use crate::{MAX_POLY, RACK_BLOCK};

/// The signal on one port for one sub-block (`RACK_BLOCK` frames).
///
/// * `channels == 0` means "unconnected": modules then use their knob or a
///   default (e.g. a VCA with no `cv` behaves as if `cv` were 1).
/// * `channels == 1` is a mono signal; [`PortBuf::get`] broadcasts it to every
///   channel, so a mono LFO can modulate a 16-voice poly signal.
/// * Only rows `0..channels` of `data` are meaningful; rows above may hold
///   stale samples and must not be read directly.
///
/// 2 KiB each, so racks keep them in preallocated heap arrays.
#[derive(Clone)]
pub struct PortBuf {
    pub channels: usize,
    pub data: [[f32; RACK_BLOCK]; MAX_POLY],
}

impl PortBuf {
    /// An unconnected (0-channel), zeroed buffer.
    pub const fn new() -> PortBuf {
        PortBuf { channels: 0, data: [[0.0; RACK_BLOCK]; MAX_POLY] }
    }

    /// Sample `i` of channel `ch`, with mono broadcast. Never panics:
    /// unconnected inputs, channels past `channels` (for poly signals) and
    /// out-of-range indices all read as 0.0.
    #[inline]
    pub fn get(&self, ch: usize, i: usize) -> f32 {
        let row = match self.channels {
            0 => return 0.0,
            1 => 0,
            n if ch < n => ch,
            _ => return 0.0,
        };
        match self.data.get(row) {
            Some(r) => r.get(i).copied().unwrap_or(0.0),
            None => 0.0,
        }
    }

    /// Copy `src`'s channel count and its meaningful rows (allocation-free).
    #[inline]
    pub fn copy_from(&mut self, src: &PortBuf) {
        let n = src.channels.min(MAX_POLY);
        self.channels = n;
        self.data[..n].copy_from_slice(&src.data[..n]);
    }
}

impl Default for PortBuf {
    fn default() -> Self {
        Self::new()
    }
}

/// Output channel count for a module whose channels follow its inputs: the
/// maximum over the connected inputs, at least 1, at most `MAX_POLY`.
pub fn poly(ins: &[PortBuf]) -> usize {
    ins.iter().map(|p| p.channels).max().unwrap_or(0).clamp(1, MAX_POLY)
}
