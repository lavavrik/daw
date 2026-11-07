//! FxPool: the engine-owned memory behind the rack's Delay, Reverb and
//! Chorus modules.
//!
//! # Why a pool
//! A rack [`Module`](super::modules::Module) is an inline, fixed-size enum,
//! so adding one never allocates. Delay (a 2 s stereo ring, ~1 MiB at
//! 48 kHz), Reverb (~256 KiB of FDN lines and predelay) and Chorus (a
//! ≤ 50 ms ring) need far more than that. They never own a `Vec`: each holds
//! a `u8` slot index into this pool and borrows the slot's memory at
//! `process` time through the dsp `*Core::process(buf, l, r)` split.
//!
//! # Layout and sizes
//! One bank per kind, allocated once (in `Synths::new`, i.e. `Engine::new`)
//! for the context sample rate and shared by every track: [`DELAY_SLOTS`]
//! delay, [`REVERB_SLOTS`] reverb and [`CHORUS_SLOTS`] chorus slots. At
//! 48 kHz that is 8 × 1 MiB + 8 × 256 KiB + 16 × 32 KiB = 10.5 MiB (21 MiB
//! at 96 kHz; the rings are power-of-two rounded).
//!
//! # Lifecycle (all allocation-free)
//! * [`claim`](FxPool::claim) (on `Rack::add_module`) takes the lowest free
//!   slot of its kind, preferring a clean one; none free → `None`, which the
//!   rack reports as `ERR_OUT_OF_MEMORY` (and adds nothing).
//! * [`reassign`](FxPool::reassign) restarts the zeroing of a slot that
//!   stays claimed but changes owner (handover on replace) or whose module
//!   was reset.
//! * [`release`](FxPool::release) returns it. The rack releases a module's
//!   slot only once the module is really gone: after its declick fade
//!   (`Remove`/`Clear` applied), and for an add still queued when a clear
//!   supersedes it.
//! * **Zeroed before reuse, in bounded steps.** A slot that has been handed
//!   out is *dirty* once released. A dirty slot handed to a new module is
//!   not given back to it until it is zero: each [`buffer`](FxPool::buffer)
//!   call (once per module per 32-frame sub-block) zeroes at most
//!   [`CLEAR_CHUNK`] floats and returns `None` until the slot is clean;
//!   meanwhile the module's wet signal is silent (its dry part still
//!   passes). A reused delay is thus mute for ~11 ms (1 MiB / 64 KiB per
//!   sub-block) and never replays the previous owner's echo. Never-used
//!   slots are clean from the start. The work per module per sub-block is
//!   bounded by the chunk, so nothing ever zeroes a whole ring at once on
//!   the audio thread.

/// Pooled module kinds (one bank each).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FxKind {
    Delay = 0,
    Reverb = 1,
    Chorus = 2,
}

impl FxKind {
    /// Every kind, in bank order.
    pub const ALL: [FxKind; 3] = [FxKind::Delay, FxKind::Reverb, FxKind::Chorus];

    /// Floats one slot of this kind needs at `sr`.
    pub fn slot_len(self, sr: f32) -> usize {
        match self {
            FxKind::Delay => crate::dsp::DelayCore::buffer_len(sr),
            FxKind::Reverb => crate::dsp::ReverbCore::buffer_len(sr),
            FxKind::Chorus => crate::dsp::ChorusCore::buffer_len(sr),
        }
    }
}

/// Delay slots shared by all tracks.
pub const DELAY_SLOTS: usize = 8;
/// Reverb slots shared by all tracks.
pub const REVERB_SLOTS: usize = 8;
/// Chorus slots shared by all tracks.
pub const CHORUS_SLOTS: usize = 16;
/// Most slots a bank can have (slot sets are `u32` bitmasks).
pub const MAX_BANK_SLOTS: usize = 32;
/// Floats zeroed per [`FxPool::buffer`] call while a reused slot is dirty
/// (64 KiB: a few µs of memset per module per sub-block).
pub const CLEAR_CHUNK: usize = 16384;
/// "No slot" (a pooled module built without one outputs silence).
pub const NO_SLOT: u8 = u8::MAX;

/// The slots of one kind.
struct Bank {
    /// Floats per slot.
    len: usize,
    slots: usize,
    /// `slots × len` floats, slot `i` at `i*len..(i+1)*len`.
    mem: Vec<f32>,
    /// Claimed slots (bit = slot).
    used: u32,
    /// Slots whose memory may be non-zero (handed out since last zeroed).
    dirty: u32,
    /// Per dirty slot: floats already zeroed from the start.
    cleared: [usize; MAX_BANK_SLOTS],
}

impl Bank {
    fn new(len: usize, slots: usize) -> Bank {
        let slots = slots.min(MAX_BANK_SLOTS);
        Bank { len, slots, mem: vec![0.0; len * slots], used: 0, dirty: 0, cleared: [0; MAX_BANK_SLOTS] }
    }

    fn empty() -> Bank {
        Bank { len: 0, slots: 0, mem: Vec::new(), used: 0, dirty: 0, cleared: [0; MAX_BANK_SLOTS] }
    }

    fn all(&self) -> u32 {
        if self.slots >= 32 {
            u32::MAX
        } else {
            (1u32 << self.slots) - 1
        }
    }

    fn claim(&mut self) -> Option<u8> {
        let free = self.all() & !self.used;
        // Prefer a clean slot (no clearing gap), else the lowest free one.
        let pick = if free & !self.dirty != 0 { free & !self.dirty } else { free };
        if pick == 0 {
            return None;
        }
        let i = pick.trailing_zeros();
        self.used |= 1 << i;
        if self.dirty & (1 << i) != 0 {
            self.cleared[i as usize] = 0;
        }
        Some(i as u8)
    }

    fn reassign(&mut self, i: u8) {
        let i = i as usize;
        if i < self.slots && self.used & (1 << i) != 0 {
            self.dirty |= 1 << i;
            self.cleared[i] = 0;
        }
    }

    fn release(&mut self, i: u8) {
        if (i as usize) < self.slots {
            self.used &= !(1u32 << i);
        }
    }

    fn buffer(&mut self, i: u8) -> Option<&mut [f32]> {
        let i = i as usize;
        let bit = 1u32 << (i % 32);
        if i >= self.slots || self.used & bit == 0 {
            return None;
        }
        let slot = self.mem.get_mut(i * self.len..(i + 1) * self.len)?;
        if self.dirty & bit != 0 {
            let from = self.cleared[i].min(self.len);
            let to = (from + CLEAR_CHUNK).min(self.len);
            slot[from..to].fill(0.0);
            self.cleared[i] = to;
            if to < self.len {
                return None;
            }
        }
        // Handed out: the module may write it from now on.
        self.dirty |= bit;
        self.cleared[i] = self.len;
        Some(slot)
    }
}

/// The shared FX memory (see the module docs).
pub struct FxPool {
    banks: [Bank; 3],
}

impl FxPool {
    /// The full pool for sample rate `sr` (8 delay, 8 reverb, 16 chorus
    /// slots). Allocates; call once, off the audio path.
    pub fn new(sr: f32) -> FxPool {
        FxPool::with_slots(sr, DELAY_SLOTS, REVERB_SLOTS, CHORUS_SLOTS)
    }

    /// A pool with the given slot counts (each at most [`MAX_BANK_SLOTS`]).
    pub fn with_slots(sr: f32, delay: usize, reverb: usize, chorus: usize) -> FxPool {
        let bank = |k: FxKind, n: usize| Bank::new(k.slot_len(sr), n);
        FxPool { banks: [bank(FxKind::Delay, delay), bank(FxKind::Reverb, reverb), bank(FxKind::Chorus, chorus)] }
    }

    /// A pool with no slots (no allocation): every claim fails. For racks
    /// that only use inline modules (tests, tools).
    pub fn empty() -> FxPool {
        FxPool { banks: [Bank::empty(), Bank::empty(), Bank::empty()] }
    }

    /// Take a free slot of `kind`, or `None` when all are in use.
    pub fn claim(&mut self, kind: FxKind) -> Option<u8> {
        self.banks[kind as usize].claim()
    }

    /// Return slot `slot` of `kind` (ignored if out of range). Its memory is
    /// zeroed before its next owner gets it.
    pub fn release(&mut self, kind: FxKind, slot: u8) {
        self.banks[kind as usize].release(slot);
    }

    /// Restart the zeroing of claimed slot `slot` of `kind` (ignored if it is
    /// not claimed): it is handed out again only once clean, as after a
    /// claim of a dirty slot. For a slot that changes owner without being
    /// released (the rack's handover on replace, see `Rack::add_module`) and
    /// for a pooled module's `reset`, so neither ever replays an old ring.
    pub fn reassign(&mut self, kind: FxKind, slot: u8) {
        self.banks[kind as usize].reassign(slot);
    }

    /// The memory of claimed slot `slot` of `kind`, or `None` if it is not
    /// claimed or still being zeroed (each call zeroes one more chunk).
    pub fn buffer(&mut self, kind: FxKind, slot: u8) -> Option<&mut [f32]> {
        self.banks[kind as usize].buffer(slot)
    }

    /// Slots of `kind` in use.
    pub fn in_use(&self, kind: FxKind) -> usize {
        self.banks[kind as usize].used.count_ones() as usize
    }

    /// Slots of `kind` in all.
    pub fn capacity(&self, kind: FxKind) -> usize {
        self.banks[kind as usize].slots
    }

    /// Release every slot (engine reset). Their memory is zeroed before reuse.
    /// Only sound once nothing holds a slot any more: the engine hard-clears
    /// every rack (`Rack::reset_hard`, which also forgets pending releases)
    /// first, else a stale release could later free a re-claimed slot.
    pub fn release_all(&mut self) {
        for b in &mut self.banks {
            b.used = 0;
        }
    }

    /// Total memory held, in bytes.
    pub fn bytes(&self) -> usize {
        self.banks.iter().map(|b| b.mem.len() * std::mem::size_of::<f32>()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_sizes_at_48k() {
        let p = FxPool::new(48000.0);
        assert_eq!(FxKind::Delay.slot_len(48000.0), 2 * 131072);
        assert_eq!(FxKind::Reverb.slot_len(48000.0), 8 * 4096 + 2 * 16384);
        assert_eq!(FxKind::Chorus.slot_len(48000.0), 2 * 4096);
        assert_eq!(p.bytes(), (8 * 262144 + 8 * 65536 + 16 * 8192) * 4); // 10.5 MiB
        assert_eq!((p.capacity(FxKind::Delay), p.capacity(FxKind::Reverb), p.capacity(FxKind::Chorus)), (8, 8, 16));
        assert_eq!(FxPool::empty().bytes(), 0);
    }

    #[test]
    fn claim_release_and_clearing() {
        let mut p = FxPool::with_slots(48000.0, 2, 0, 0);
        let len = FxKind::Delay.slot_len(48000.0);
        assert_eq!(p.claim(FxKind::Reverb), None);
        let a = p.claim(FxKind::Delay).unwrap();
        let b = p.claim(FxKind::Delay).unwrap();
        assert_eq!((a, b), (0, 1));
        assert_eq!(p.claim(FxKind::Delay), None);
        // Fresh slots are clean: handed out at once.
        p.buffer(FxKind::Delay, a).unwrap().fill(1.0);
        p.release(FxKind::Delay, a);
        assert!(p.buffer(FxKind::Delay, a).is_none(), "released");
        // Reclaimed dirty: zeroed CLEAR_CHUNK at a time before it is handed out.
        assert_eq!(p.claim(FxKind::Delay), Some(a));
        let calls = len.div_ceil(CLEAR_CHUNK);
        for _ in 0..calls - 1 {
            assert!(p.buffer(FxKind::Delay, a).is_none());
        }
        let buf = p.buffer(FxKind::Delay, a).expect("clean now");
        assert!(buf.iter().all(|&x| x == 0.0));
        // A clean free slot is preferred over a dirty one.
        p.release(FxKind::Delay, a);
        p.release(FxKind::Delay, b);
        assert_eq!(p.claim(FxKind::Delay), Some(b), "b was never handed out");
        // Reassigning a claimed clean slot makes it zero again before reuse.
        p.buffer(FxKind::Delay, b).unwrap().fill(2.0);
        p.reassign(FxKind::Delay, b);
        for _ in 0..calls - 1 {
            assert!(p.buffer(FxKind::Delay, b).is_none());
        }
        assert!(p.buffer(FxKind::Delay, b).unwrap().iter().all(|&x| x == 0.0));
        p.reassign(FxKind::Delay, a); // not claimed: ignored
        p.reassign(FxKind::Delay, 200);
        p.release_all();
        assert_eq!(p.in_use(FxKind::Delay), 0);
        // Out-of-range indices never panic.
        p.release(FxKind::Delay, 200);
        assert!(p.buffer(FxKind::Delay, NO_SLOT).is_none());
    }
}
