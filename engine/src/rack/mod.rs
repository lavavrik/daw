//! The modular rack: a patch of up to `MAX_MODULES` modules joined by cables,
//! rendered in sub-blocks of `RACK_BLOCK` frames.
//!
//! # Real-time rules
//! `Rack::new` is the only place that allocates: module slots, every output
//! port buffer (`MAX_MODULES × MAX_PORTS` × 2 KiB) and the input scratch live
//! in heap arrays sized up front. Every edit (add/remove module, connect,
//! disconnect, set param, clear) and every render is allocation-free and
//! never panics (all indexing is validated or `get`-guarded).
//!
//! # Graph and order
//! Each input holds at most one cable (connecting to an occupied input
//! replaces it); outputs fan out freely. After every structural edit the
//! processing order is rebuilt with Kahn's algorithm. Modules in cycles have
//! no zero-in-degree candidate, so when Kahn stalls, the lowest-index
//! remaining module that is actually *on* a cycle (reachable from itself
//! through the remaining modules) is taken next, which breaks that cycle in
//! index order, and Kahn resumes. Modules merely downstream of a loop (e.g. the
//! Out it feeds) are never picked this way, so they still run after it.
//!
//! Before a module runs, each connected input is copied from its source's
//! output buffer into per-rack scratch. A source earlier in the order has
//! already written this sub-block; a source later in the order (a feedback
//! cable) still holds the previous sub-block. So loops are allowed and cost
//! exactly one sub-block of delay.
//!
//! # Declicking
//! * Params: modules smooth `smooth` params per sample (5 ms one-pole), so
//!   `set_param` applies immediately. Continuous params that are not
//!   `smooth` (tune, ADSR times, glide, LFO rate) also apply immediately:
//!   they never click (phase and envelope levels stay continuous) and must
//!   not dip the output on every step of a knob drag.
//! * *Stepped* params (`integer`, which includes every choice param: wave,
//!   filter mode, unison, octave, MIDI In voices/mode, ...) switch the signal
//!   discontinuously, so they are declicked like structural edits: queued
//!   behind the 2 ms fade-out while sounding, applied, faded back in. On a
//!   silent rack they apply at once and the output fades in. Re-sending the
//!   current value (nothing queued) is a no-op and never dips the output.
//! * Structural edits on a silent rack apply at once, but the output gain
//!   restarts from 0 and ramps up over round(0.002·sr) samples, so whatever
//!   the edit switched on (e.g. the last cable from a free-running LFO to Out)
//!   fades in instead of starting at full level.
//! * Adding a module never changes the sound (it has no cables yet), so it
//!   applies at once without a fade, even while sounding, unless edits are
//!   already queued (then it queues, to keep edits in order).
//! * Structural edits while [`Rack::is_sounding`]: the edit is validated now
//!   (the caller gets its `ERR_*`/`OK` code immediately) and queued in a fixed
//!   64-entry queue. The rack output then fades to 0 over round(0.002·sr)
//!   samples, the queue is applied at the next sub-block boundary, and the
//!   output fades back in over the same length. While the queue is non-empty,
//!   further edits (params included) queue behind it so they apply in order.
//!   On overflow, the whole queue plus the new edit apply at once (in order).
//! * Validation runs against the *pending* structure (`pending` kinds: the
//!   running graph plus queued edits), so e.g. a connect to a module whose add
//!   is still queued is accepted. Accessors (`kind`, `cable`, `param`,
//!   `order`) report the *running* graph.
//!
//! # FX pool
//! Delay, Reverb and Chorus need a slot of the engine-wide [`FxPool`]
//! (`fx_pool.rs`, shared by every track's rack). `add_module` claims it at
//! validation time, so a queued add holds its slot and a full bank is
//! reported at once as `ERR_OUT_OF_MEMORY` (nothing is added). A slot is
//! given back only when its module is really gone: when a `Remove`/`Clear`
//! *applies* (after the declick fade, so the effect is never cut while
//! audible), or when a clear drops a still-queued add. Applying an edit
//! only records the slot in `released`; [`Rack::reclaim`] hands those back
//! to the pool, which `render_add` and `add_module` do on every call (and
//! the synth tracks after edits that may apply at once).
//!
//! **Handover on replace.** Because a slot stays held through its module's
//! removal fade, "remove (or clear) then add" in one batch on a sounding rack
//! would find a full bank even though the UI counts the slot as free. So when
//! `claim` fails, `add_module` takes over a slot that a *queued* `Remove` or
//! `Clear` of this rack is about to give up: the queue applies in order, so
//! the old module is gone before the new one first runs. The slot is marked
//! in `handed` (the old module's release is then absorbed instead of freeing
//! the slot under its new owner), and the new module is `reset` when its add
//! applies, which restarts the slot's zeroing (`FxPool::reassign`): it starts
//! silent and never replays the old ring. Each handover adds one owner and
//! absorbs exactly one release, whichever of the two owners goes first.
//!
//! # Automation
//! An automation lane on a rack param (`automation.rs`) drives it through
//! [`Rack::automate`] at sub-block boundaries ([`Rack::render_add_auto`]):
//! the value is written straight into the running module's param, the
//! module's normal path (a `smooth` param glides over its 5 ms one-pole,
//! the others apply at the sub-block; a silent rack snaps its smoothers
//! instead, so a song starts at its automated values), and it never queues behind a
//! structural fade, so only non-integer params are automatable. A module
//! whose add or removal is still queued is not driven. The hand-set value
//! (the base) is kept by the lane; the engine re-applies it with
//! [`Rack::set_param`] when the lane stops applying.
//!
//! **Engine reset.** [`Rack::reset_hard`] drops everything at once (no
//! fade) and forgets pending releases and handovers, so the engine can then
//! free the whole pool (`FxPool::release_all`) without a stale release ever
//! freeing a slot claimed afterwards.
//!
//! # Voice activity (plan 12)
//! Each sub-block the rack keeps, per voice `k`, the max of its Outs' peaks
//! (`Out::peak`) since the last [`Rack::take_voices`], and the gate of its
//! first MIDI In (lowest module index; channel `k`, last frame of the
//! sub-block; 0 past its channels, all 0 without one). The engine takes them
//! once per block (`Synths::write_voices`) for the UI's voice LEDs. Reading
//! only: nothing here touches the rendered output.

pub mod catalog;
pub mod fx_pool;
#[cfg(test)]
mod fx_tests;
pub mod modules;
pub mod port;

use crate::protocol::{ERR_BAD_INDEX, ERR_BAD_VALUE, ERR_OUT_OF_MEMORY, OK};
use crate::{MAX_MODULES, MAX_PARAMS, MAX_POLY, MAX_PORTS, RACK_BLOCK};
use catalog::{spec, ModuleKind};
use fx_pool::{FxKind, FxPool, NO_SLOT};
use modules::{Ctx, Module, NoteEvent};
use port::PortBuf;

use crate::automation::{AutoFrame, Target};
use crate::samples::SampleView;

/// Capacity of the declick edit queue.
pub const EDIT_QUEUE_LEN: usize = 64;
/// Length of the declick fade-out and fade-in, in seconds (rounded to samples).
pub const DECLICK_SECONDS: f32 = 0.002;
/// How long after the last non-silent Out sample the rack counts as sounding.
pub const SOUNDING_SECONDS: f32 = 0.05;
/// Out samples at or below this magnitude (-120 dBFS) count as silence.
const SILENCE: f32 = 1e-6;

/// A validated edit, as stored in the declick queue (indices fit in u8).
#[derive(Clone, Copy, Debug)]
enum Edit {
    /// Module index, kind, FX-pool slot (`NO_SLOT` for inline kinds), and
    /// whether that slot was handed over from a queued Remove/Clear (the
    /// module is then reset on apply, which re-zeroes the slot).
    Add(u8, ModuleKind, u8, bool),
    Remove(u8),
    Connect { from: (u8, u8), to: (u8, u8) },
    Disconnect((u8, u8)),
    SetParam(u8, u8, f32),
    Clear,
}

/// How an edit interacts with the declick machinery (see `Rack::submit`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum EditClass {
    /// Continuous param (smoothed by the module, or click-free): never faded.
    Param,
    /// Integer/choice param: faded like `Structural`, but no order rebuild.
    Stepped,
    /// A new, cable-less module: cannot change the sound, never faded.
    Add,
    /// Cables, removal, clear: faded (queued while sounding).
    Structural,
}

/// One module slot of the running graph.
#[derive(Clone)]
struct Slot {
    module: Option<Module>,
    /// Param targets in catalog order (defaults on add).
    params: [f32; MAX_PARAMS],
    /// Source `(module, output port)` feeding each input port.
    cables: [Option<(u8, u8)>; MAX_PORTS],
}

impl Slot {
    const EMPTY: Slot = Slot { module: None, params: [0.0; MAX_PARAMS], cables: [None; MAX_PORTS] };
}

/// A modular patch. See the module docs for the real-time, ordering and
/// declick rules.
pub struct Rack {
    sr: f32,
    slots: Vec<Slot>,
    /// Output buffers: module `m`'s port `p` is `outs[m * MAX_PORTS + p]`.
    outs: Vec<PortBuf>,
    /// Input scratch for the module currently processing (`MAX_PORTS`).
    ins: Vec<PortBuf>,
    order: [u8; MAX_MODULES],
    order_len: usize,
    /// Module kinds once every queued edit has applied (validation view).
    pending: [Option<ModuleKind>; MAX_MODULES],
    queue: [Edit; EDIT_QUEUE_LEN],
    queued: usize,
    /// Declick gain applied to the rack output, 0..1.
    gain: f32,
    fade_step: f32,
    /// Frames since an Out module last produced a non-silent sample.
    silent_frames: usize,
    sounding_frames: usize,
    /// The current sub-block's stereo output, and how much of it has been
    /// handed out (`RACK_BLOCK` = consumed), so hosts may render any length.
    blk_l: [f32; RACK_BLOCK],
    blk_r: [f32; RACK_BLOCK],
    blk_pos: usize,
    /// FX-pool slots of removed modules not yet handed back (bit = slot, one
    /// mask per `FxKind`); see [`Rack::reclaim`].
    released: [u32; 3],
    /// Slots taken over by a queued add from a queued Remove/Clear (see the
    /// module docs): the next release of each is absorbed, not recorded.
    handed: [u32; 3],
    /// Voice activity since the last `take_voices` (see the module docs):
    /// the max Out peak per voice, the MIDI In gates, and whether a
    /// sub-block rendered at all.
    vis_level: [f32; MAX_POLY],
    vis_gate: [f32; MAX_POLY],
    vis_rendered: bool,
}

/// Is module `m` reachable from itself through modules in `within`?
/// Bitmask BFS: at most `MAX_MODULES` rounds of `MAX_MODULES` ORs.
fn on_cycle(succ: &[u32; MAX_MODULES], within: u32, m: usize) -> bool {
    let mut reach = succ[m] & within;
    let mut frontier = reach;
    while frontier != 0 {
        let mut next = 0u32;
        let mut f = frontier;
        while f != 0 {
            let y = f.trailing_zeros() as usize;
            f &= f - 1;
            next |= succ[y] & within;
        }
        frontier = next & !reach;
        reach |= next;
    }
    reach & (1 << m) != 0
}

impl Rack {
    /// An empty rack with all storage preallocated. The only allocating call.
    pub fn new(sr: f32) -> Rack {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        let fade = (DECLICK_SECONDS * sr).round().max(1.0);
        let sounding_frames = (SOUNDING_SECONDS * sr).round() as usize;
        Rack {
            sr,
            slots: vec![Slot::EMPTY; MAX_MODULES],
            outs: vec![PortBuf::new(); MAX_MODULES * MAX_PORTS],
            ins: vec![PortBuf::new(); MAX_PORTS],
            order: [0; MAX_MODULES],
            order_len: 0,
            pending: [None; MAX_MODULES],
            queue: [Edit::Clear; EDIT_QUEUE_LEN],
            queued: 0,
            gain: 1.0,
            fade_step: 1.0 / fade,
            silent_frames: sounding_frames,
            sounding_frames,
            blk_l: [0.0; RACK_BLOCK],
            blk_r: [0.0; RACK_BLOCK],
            blk_pos: RACK_BLOCK,
            released: [0; 3],
            handed: [0; 3],
            vis_level: [0.0; MAX_POLY],
            vis_gate: [0.0; MAX_POLY],
            vis_rendered: false,
        }
    }

    /// Drop every module, cable and queued edit at once, without a fade, and
    /// forget pending FX-pool releases and handovers (engine reset: the
    /// engine fades its master output and then frees the whole pool). The
    /// rack is left as `new` made it. Allocation-free.
    pub fn reset_hard(&mut self) {
        for slot in self.slots.iter_mut() {
            *slot = Slot::EMPTY;
        }
        for o in self.outs.iter_mut() {
            o.channels = 0;
        }
        self.order_len = 0;
        self.pending = [None; MAX_MODULES];
        self.queued = 0;
        self.gain = 1.0;
        self.silent_frames = self.sounding_frames;
        self.blk_l = [0.0; RACK_BLOCK];
        self.blk_r = [0.0; RACK_BLOCK];
        self.blk_pos = RACK_BLOCK;
        self.released = [0; 3];
        self.handed = [0; 3];
        self.vis_level = [0.0; MAX_POLY];
        self.vis_gate = [0.0; MAX_POLY];
        self.vis_rendered = false;
    }

    /// Write the voice activity since the last call into `out` (`2 *
    /// MAX_POLY` floats: level, gate per voice; levels below `floor` read
    /// 0) and start over. A rack that rendered no sub-block meanwhile
    /// writes zeros.
    pub fn take_voices(&mut self, out: &mut [f32], floor: f32) {
        for (k, pair) in out.chunks_exact_mut(2).take(MAX_POLY).enumerate() {
            let (level, gate) = if self.vis_rendered { (self.vis_level[k], self.vis_gate[k]) } else { (0.0, 0.0) };
            pair[0] = if level >= floor { level } else { 0.0 };
            pair[1] = gate;
        }
        self.vis_level = [0.0; MAX_POLY];
        self.vis_rendered = false;
    }

    /// No module, running or queued, and nothing queued.
    pub fn is_empty(&self) -> bool {
        self.queued == 0 && self.pending.iter().all(Option::is_none) && self.slots.iter().all(|s| s.module.is_none())
    }

    // ---- state -------------------------------------------------------------

    /// True while any Out module has produced a non-silent sample within the
    /// last 50 ms. Structural edits made while sounding are declicked.
    pub fn is_sounding(&self) -> bool {
        self.silent_frames < self.sounding_frames
    }

    /// Processing order of the running graph (module indices).
    pub fn order(&self) -> &[u8] {
        &self.order[..self.order_len]
    }

    /// Kind of the running module at `idx` (queued adds not yet included).
    pub fn kind(&self, idx: usize) -> Option<ModuleKind> {
        self.slots.get(idx)?.module.as_ref().map(Module::kind)
    }

    /// Source `(module, output port)` of the cable into input `to`, if any.
    pub fn cable(&self, to: (usize, usize)) -> Option<(usize, usize)> {
        let (m, p) = self.slots.get(to.0)?.cables.get(to.1).copied()??;
        Some((m as usize, p as usize))
    }

    /// The FX-pool slot held by the running module at `idx`, if it holds one.
    pub fn fx_slot(&self, idx: usize) -> Option<(FxKind, u8)> {
        self.slots.get(idx)?.module.as_ref()?.fx_slot()
    }

    /// Kind of module `idx` once every queued edit has applied.
    pub fn pending_kind(&self, idx: usize) -> Option<ModuleKind> {
        self.pending.get(idx).copied().flatten()
    }

    /// Param `param` of module `idx` once every queued edit has applied
    /// (the running value, then the queue in order: an add resets it to its
    /// default, a param edit sets it). `None` if there will be no module.
    pub fn pending_param(&self, idx: usize, param: usize) -> Option<f32> {
        let kind = self.pending_kind(idx)?;
        let default = spec(kind).params.get(param)?.default;
        let slot = self.slots.get(idx)?;
        let mut v = match slot.module.as_ref() {
            Some(m) if m.kind() == kind => slot.params.get(param).copied().unwrap_or(default),
            _ => default,
        };
        for e in &self.queue[..self.queued.min(EDIT_QUEUE_LEN)] {
            match *e {
                Edit::Add(i, k, ..) if i as usize == idx => {
                    v = spec(k).params.get(param).map_or(default, |p| p.default);
                }
                Edit::SetParam(i, p, x) if i as usize == idx && p as usize == param => v = x,
                _ => {}
            }
        }
        Some(v)
    }

    /// The checks of [`set_param`](Rack::set_param) without the edit:
    /// `OK`, `ERR_BAD_INDEX` or `ERR_BAD_VALUE`.
    pub fn check_param(&self, idx: usize, param: usize, value: f32) -> i32 {
        let Some(Some(kind)) = self.pending.get(idx).copied() else { return ERR_BAD_INDEX };
        let Some(p) = spec(kind).params.get(param) else { return ERR_BAD_INDEX };
        if !(value >= p.min && value <= p.max) || (p.integer && value.fract() != 0.0) {
            return ERR_BAD_VALUE;
        }
        OK
    }

    /// Automation: drive non-integer param `param` of module `idx` to
    /// `value` (clamped to its range) through the module's normal path,
    /// without queueing. Ignored for a missing module, one whose add or
    /// removal is still queued, an integer param or a non-finite value.
    pub fn automate(&mut self, idx: usize, param: usize, value: f32) {
        let pending = self.pending_kind(idx);
        let sounding = self.is_sounding();
        let Some(slot) = self.slots.get_mut(idx) else { return };
        let Some(kind) = slot.module.as_ref().map(Module::kind) else { return };
        if pending != Some(kind) || !value.is_finite() {
            return;
        }
        let Some(p) = spec(kind).params.get(param) else { return };
        if p.integer {
            return;
        }
        if let Some(x) = slot.params.get_mut(param) {
            *x = value.clamp(p.min, p.max);
        }
        // A silent rack (a replayed or exported song's first block, or after
        // a rest) has nothing to glide from: take the value at once.
        if !sounding {
            if let Some(m) = slot.module.as_mut() {
                m.snap();
            }
        }
    }

    /// Current target value of param `param` of running module `idx`.
    pub fn param(&self, idx: usize, param: usize) -> Option<f32> {
        let slot = self.slots.get(idx)?;
        let n = spec(slot.module.as_ref()?.kind()).params.len();
        if param < n {
            slot.params.get(param).copied()
        } else {
            None
        }
    }

    // ---- edits -------------------------------------------------------------

    /// Remove every module and cable (declicked while sounding). Edits still
    /// queued are dropped: the clear supersedes them (a dropped add gives its
    /// FX-pool slot back at the next [`reclaim`](Rack::reclaim)).
    pub fn clear(&mut self) {
        self.pending = [None; MAX_MODULES];
        for k in 0..self.queued.min(EDIT_QUEUE_LEN) {
            if let Edit::Add(_, kind, slot, _) = self.queue[k] {
                self.release(kind.fx_kind(), slot);
            }
        }
        if self.queued > 0 || self.is_sounding() {
            self.queue[0] = Edit::Clear;
            self.queued = 1;
        } else {
            self.submit(Edit::Clear, EditClass::Structural);
        }
    }

    /// Add a module of `kind` at slot `idx` with default params and no cables.
    /// `ERR_BAD_INDEX` if `idx >= MAX_MODULES`; `ERR_BAD_VALUE` if occupied;
    /// `ERR_OUT_OF_MEMORY` if `kind` needs an FX-pool slot and `fx` has none
    /// free and no queued Remove/Clear of this rack gives one up (then
    /// nothing is added; see "Handover on replace" in the module docs).
    pub fn add_module(&mut self, idx: usize, kind: ModuleKind, fx: &mut FxPool) -> i32 {
        self.reclaim(fx);
        match self.pending.get(idx) {
            None => return ERR_BAD_INDEX,
            Some(Some(_)) => return ERR_BAD_VALUE,
            Some(None) => {}
        }
        let (fx_slot, handed) = match kind.fx_kind() {
            Some(k) => match fx.claim(k).map(|s| (s, false)).or_else(|| self.take_over(k).map(|s| (s, true))) {
                Some(s) => s,
                None => return ERR_OUT_OF_MEMORY,
            },
            None => (NO_SLOT, false),
        };
        self.pending[idx] = Some(kind);
        self.submit(Edit::Add(idx as u8, kind, fx_slot, handed), EditClass::Add);
        OK
    }

    /// A `kind` slot that a queued `Remove`/`Clear` gives up and that is not
    /// already handed over, now marked handed; `None` if there is none.
    /// Walks the queue tracking which slot each module index holds at that
    /// point (the running graph first, then queued adds).
    fn take_over(&mut self, kind: FxKind) -> Option<u8> {
        let mut held = [NO_SLOT; MAX_MODULES];
        for (h, slot) in held.iter_mut().zip(self.slots.iter()) {
            if let Some((k, s)) = slot.module.as_ref().and_then(Module::fx_slot) {
                if k == kind {
                    *h = s;
                }
            }
        }
        let mut gives_up = 0u32;
        let mut give_up = |h: &mut u8| {
            if (*h as u32) < 32 {
                gives_up |= 1 << *h;
            }
            *h = NO_SLOT;
        };
        for e in &self.queue[..self.queued.min(EDIT_QUEUE_LEN)] {
            match *e {
                Edit::Add(i, k, s, _) if k.fx_kind() == Some(kind) => {
                    if let Some(h) = held.get_mut(i as usize) {
                        *h = s;
                    }
                }
                Edit::Remove(i) => {
                    if let Some(h) = held.get_mut(i as usize) {
                        give_up(h);
                    }
                }
                Edit::Clear => held.iter_mut().for_each(&mut give_up),
                _ => {}
            }
        }
        let free = gives_up & !self.handed[kind as usize];
        if free == 0 {
            return None;
        }
        let s = free.trailing_zeros();
        self.handed[kind as usize] |= 1 << s;
        Some(s as u8)
    }

    /// Hand the FX-pool slots of modules that are gone back to `fx`.
    pub fn reclaim(&mut self, fx: &mut FxPool) {
        for k in FxKind::ALL {
            let mut m = std::mem::take(&mut self.released[k as usize]);
            while m != 0 {
                let s = m.trailing_zeros();
                m &= m - 1;
                fx.release(k, s as u8);
            }
        }
    }

    /// Record `slot` of `kind` (if any) for the next `reclaim`, unless it
    /// was handed over: then this release is absorbed (the slot has another
    /// owner) and the handover is done.
    fn release(&mut self, kind: Option<FxKind>, slot: u8) {
        if let Some(k) = kind {
            if (slot as u32) < 32 {
                let bit = 1u32 << slot;
                if self.handed[k as usize] & bit != 0 {
                    self.handed[k as usize] &= !bit;
                } else {
                    self.released[k as usize] |= bit;
                }
            }
        }
    }

    /// Record the FX slot of the running module at `i` (if any).
    fn release_module(&mut self, i: usize) {
        if let Some((k, s)) = self.slots.get(i).and_then(|sl| sl.module.as_ref()).and_then(Module::fx_slot) {
            self.release(Some(k), s);
        }
    }

    /// Remove module `idx` and every cable into or out of it.
    /// `ERR_BAD_INDEX` if there is no module there.
    pub fn remove_module(&mut self, idx: usize) -> i32 {
        match self.pending.get_mut(idx) {
            Some(slot @ Some(_)) => *slot = None,
            _ => return ERR_BAD_INDEX,
        }
        self.submit(Edit::Remove(idx as u8), EditClass::Structural);
        OK
    }

    /// Cable output `from = (module, port)` to input `to = (module, port)`,
    /// replacing any cable already on that input. Self-loops and feedback are
    /// allowed. `ERR_BAD_INDEX` for a missing module or out-of-spec port.
    pub fn connect(&mut self, from: (usize, usize), to: (usize, usize)) -> i32 {
        if !self.port_exists(from, true) || !self.port_exists(to, false) {
            return ERR_BAD_INDEX;
        }
        if self.queued == 0 && self.cable(to) == Some(from) {
            return OK; // no-op: don't dip the output for a re-sent edit
        }
        let e = Edit::Connect { from: (from.0 as u8, from.1 as u8), to: (to.0 as u8, to.1 as u8) };
        self.submit(e, EditClass::Structural);
        OK
    }

    /// Remove the cable into input `to` (OK if there is none).
    /// `ERR_BAD_INDEX` for a missing module or out-of-spec port.
    pub fn disconnect(&mut self, to: (usize, usize)) -> i32 {
        if !self.port_exists(to, false) {
            return ERR_BAD_INDEX;
        }
        if self.queued == 0 && self.cable(to).is_none() {
            return OK; // no-op: don't dip the output
        }
        self.submit(Edit::Disconnect((to.0 as u8, to.1 as u8)), EditClass::Structural);
        OK
    }

    /// Set param `param` of module `idx` (its smoothing, if any, is done by the
    /// module; integer/choice params are declicked by the rack, see module
    /// docs). `ERR_BAD_INDEX` for a missing module or param; `ERR_BAD_VALUE`
    /// for NaN/Inf, values outside the spec's `min..=max`, or a fractional
    /// value for an integer (incl. choice) param.
    pub fn set_param(&mut self, idx: usize, param: usize, value: f32) -> i32 {
        let Some(Some(kind)) = self.pending.get(idx).copied() else { return ERR_BAD_INDEX };
        let Some(p) = spec(kind).params.get(param) else { return ERR_BAD_INDEX };
        if !(value >= p.min && value <= p.max) || (p.integer && value.fract() != 0.0) {
            return ERR_BAD_VALUE;
        }
        let class = if p.integer { EditClass::Stepped } else { EditClass::Param };
        if class == EditClass::Stepped && self.queued == 0 && self.param(idx, param) == Some(value) {
            return OK; // no-op: don't dip the output for a re-sent value
        }
        self.submit(Edit::SetParam(idx as u8, param as u8, value), class);
        OK
    }

    /// Forward a note event to every MIDI In module (other modules ignore it).
    pub fn note(&mut self, ev: NoteEvent) {
        for slot in self.slots.iter_mut() {
            if let Some(m) = slot.module.as_mut() {
                m.note(ev, &slot.params);
            }
        }
    }

    /// Does `(module, port)` exist in the pending structure?
    fn port_exists(&self, (m, p): (usize, usize), output: bool) -> bool {
        match self.pending.get(m).copied().flatten() {
            Some(kind) => {
                let s = spec(kind);
                p < if output { s.outputs.len() } else { s.inputs.len() }
            }
            None => false,
        }
    }

    /// Apply a validated edit now, or queue it behind a declick fade.
    /// Structural and stepped-param edits queue while sounding; anything
    /// queues while the queue is non-empty (to keep edits in order). On
    /// overflow everything applies at once. A structural or stepped edit
    /// applied at once (silent rack, or overflow) restarts the output gain
    /// from 0 so the result fades in.
    fn submit(&mut self, e: Edit, class: EditClass) {
        let faded = matches!(class, EditClass::Structural | EditClass::Stepped);
        let defer = self.queued > 0 || (faded && self.is_sounding());
        if !defer {
            self.apply(e);
            match class {
                EditClass::Param => {}
                EditClass::Stepped => self.gain = 0.0,
                EditClass::Add => self.rebuild_order(),
                EditClass::Structural => {
                    self.rebuild_order();
                    self.gain = 0.0;
                }
            }
        } else if self.queued < EDIT_QUEUE_LEN {
            self.queue[self.queued] = e;
            self.queued += 1;
        } else {
            self.apply_queue();
            self.apply(e);
            self.rebuild_order();
            self.gain = 0.0;
        }
    }

    fn apply_queue(&mut self) {
        for k in 0..self.queued.min(EDIT_QUEUE_LEN) {
            let e = self.queue[k];
            self.apply(e);
        }
        self.queued = 0;
        self.rebuild_order();
    }

    /// Mutate the running graph. Never panics, even on inconsistent input
    /// (everything is `get`-guarded), though validation makes that moot.
    fn apply(&mut self, e: Edit) {
        match e {
            Edit::Add(i, kind, fx_slot, handed) => {
                let i = i as usize;
                // Validation keeps an occupied index from being added to; if
                // it ever were, the old module's slot must not leak.
                self.release_module(i);
                if let Some(slot) = self.slots.get_mut(i) {
                    let mut m = Module::with_fx_slot(kind, self.sr, fx_slot);
                    if handed {
                        m.reset(); // re-zero the slot it took over
                    }
                    slot.module = Some(m);
                    slot.params = [0.0; MAX_PARAMS];
                    for (dst, p) in slot.params.iter_mut().zip(spec(kind).params) {
                        *dst = p.default;
                    }
                    slot.cables = [None; MAX_PORTS];
                }
                self.silence_outputs(i);
            }
            Edit::Remove(i) => {
                self.release_module(i as usize);
                if let Some(slot) = self.slots.get_mut(i as usize) {
                    *slot = Slot::EMPTY;
                }
                for slot in self.slots.iter_mut() {
                    for c in slot.cables.iter_mut() {
                        if matches!(c, Some((src, _)) if *src == i) {
                            *c = None;
                        }
                    }
                }
                self.silence_outputs(i as usize);
            }
            Edit::Connect { from, to } => {
                if let Some(c) = self.slots.get_mut(to.0 as usize).and_then(|s| s.cables.get_mut(to.1 as usize)) {
                    *c = Some(from);
                }
            }
            Edit::Disconnect(to) => {
                if let Some(c) = self.slots.get_mut(to.0 as usize).and_then(|s| s.cables.get_mut(to.1 as usize)) {
                    *c = None;
                }
            }
            Edit::SetParam(i, p, v) => {
                if let Some(x) = self.slots.get_mut(i as usize).and_then(|s| s.params.get_mut(p as usize)) {
                    *x = v;
                }
            }
            Edit::Clear => {
                for i in 0..self.slots.len() {
                    self.release_module(i);
                }
                for slot in self.slots.iter_mut() {
                    *slot = Slot::EMPTY;
                }
                for o in self.outs.iter_mut() {
                    o.channels = 0;
                }
            }
        }
    }

    /// Mark module `m`'s output buffers unconnected (no stale signal).
    fn silence_outputs(&mut self, m: usize) {
        let base = m * MAX_PORTS;
        if let Some(outs) = self.outs.get_mut(base..base + MAX_PORTS) {
            for o in outs {
                o.channels = 0;
            }
        }
    }

    /// Kahn's algorithm over the running graph (fixed arrays and bitmasks, no
    /// allocation). Ready modules are taken lowest index first. When none is
    /// ready (only cycles and their downstream remain), the lowest-index
    /// remaining module that lies on a cycle is taken.
    #[allow(clippy::needless_range_loop)] // `m` is also a bit index
    fn rebuild_order(&mut self) {
        const _: () = assert!(MAX_MODULES <= 32, "module sets are u32 bitmasks");
        // succ[x]: modules with a cable from x. indeg[m]: cables into m from
        // present modules (one per cable, so parallel cables count twice and
        // are decremented twice).
        let mut succ = [0u32; MAX_MODULES];
        let mut indeg = [0u8; MAX_MODULES];
        let mut remaining = 0u32;
        for (m, slot) in self.slots.iter().enumerate().take(MAX_MODULES) {
            if slot.module.is_some() {
                remaining |= 1 << m;
            }
        }
        for m in 0..MAX_MODULES {
            if remaining & (1 << m) == 0 {
                continue;
            }
            for (src, _) in self.slots[m].cables.iter().flatten() {
                let src = *src as usize;
                if src < MAX_MODULES && remaining & (1 << src) != 0 {
                    indeg[m] += 1;
                    succ[src] |= 1 << m;
                }
            }
        }
        self.order_len = 0;
        while remaining != 0 {
            let ready = (0..MAX_MODULES).find(|&m| remaining & (1 << m) != 0 && indeg[m] == 0);
            let pick = match ready {
                Some(m) => m,
                None => (0..MAX_MODULES)
                    .find(|&m| remaining & (1 << m) != 0 && on_cycle(&succ, remaining, m))
                    // Unreachable (a stall implies a cycle); keep it total.
                    .unwrap_or(remaining.trailing_zeros() as usize),
            };
            remaining &= !(1 << pick);
            self.order[self.order_len] = pick as u8;
            self.order_len += 1;
            for m in 0..MAX_MODULES {
                if remaining & (1 << m) != 0 {
                    for (src, _) in self.slots[m].cables.iter().flatten() {
                        if *src as usize == pick {
                            indeg[m] = indeg[m].saturating_sub(1);
                        }
                    }
                }
            }
        }
    }

    // ---- rendering ---------------------------------------------------------

    /// Render `min(left.len(), right.len())` frames and **add** them into
    /// `left`/`right`. Internally renders whole `RACK_BLOCK` sub-blocks (any
    /// leftover frames are handed out on the next call), each with
    /// `ctx.ticks` advanced to that sub-block's start while playing. Pooled
    /// effects borrow their memory from `fx`; slots of modules removed
    /// meanwhile are handed back to it at the end. Sample Players read `smp`.
    pub fn render_add(&mut self, ctx: &Ctx, fx: &mut FxPool, smp: SampleView, left: &mut [f32], right: &mut [f32]) {
        self.render_add_auto(ctx, fx, smp, left, right, None);
    }

    /// [`render_add`](Rack::render_add), applying automation at each
    /// sub-block start: `auto` is the block's frame, this rack's synth slot
    /// and the block frame of `left[0]`. Each rack entry for the slot that
    /// applies at the sub-block (`frame / RACK_BLOCK`) sets its value there.
    pub fn render_add_auto(
        &mut self,
        ctx: &Ctx,
        fx: &mut FxPool,
        smp: SampleView,
        left: &mut [f32],
        right: &mut [f32],
        auto: Option<(&AutoFrame, usize, usize)>,
    ) {
        let n = left.len().min(right.len());
        let mut done = 0;
        while done < n {
            if self.blk_pos >= RACK_BLOCK {
                if let Some((frame, slot, at)) = auto {
                    let k = (at + done) / RACK_BLOCK;
                    for e in frame.entries() {
                        if let (Target::Rack { slot: s, module, param }, true) = (e.target, e.applies(k)) {
                            if s as usize == slot {
                                self.automate(module as usize, param as usize, e.value(k));
                            }
                        }
                    }
                }
                let mut sub = *ctx;
                if ctx.playing {
                    sub.ticks = ctx.ticks + done as f64 * ctx.ticks_per_frame;
                }
                self.render_sub(&sub, fx, smp);
                self.blk_pos = 0;
            }
            let take = (RACK_BLOCK - self.blk_pos).min(n - done);
            let src = self.blk_pos..self.blk_pos + take;
            for (d, s) in left[done..done + take].iter_mut().zip(&self.blk_l[src.clone()]) {
                *d += *s;
            }
            for (d, s) in right[done..done + take].iter_mut().zip(&self.blk_r[src]) {
                *d += *s;
            }
            self.blk_pos += take;
            done += take;
        }
        self.reclaim(fx);
    }

    /// Run every module once (in order), mix the Out modules into
    /// `blk_l`/`blk_r`, apply the declick gain, and apply queued edits once
    /// the fade-out has reached 0.
    fn render_sub(&mut self, ctx: &Ctx, fx: &mut FxPool, smp: SampleView) {
        for k in 0..self.order_len {
            let m = self.order[k] as usize;
            let Some(slot) = self.slots.get_mut(m) else { continue };
            let Some(module) = slot.module.as_mut() else { continue };
            let s = spec(module.kind());
            let (n_in, n_out) = (s.inputs.len().min(MAX_PORTS), s.outputs.len().min(MAX_PORTS));
            for p in 0..n_in {
                let src = slot.cables[p].and_then(|(sm, sp)| self.outs.get(sm as usize * MAX_PORTS + sp as usize));
                match src {
                    Some(src) => self.ins[p].copy_from(src),
                    None => self.ins[p].channels = 0,
                }
            }
            let base = m * MAX_PORTS;
            if let Some(outs) = self.outs.get_mut(base..base + n_out) {
                module.process(ctx, &slot.params, &self.ins[..n_in], outs, fx, smp);
            }
        }

        self.blk_l = [0.0; RACK_BLOCK];
        self.blk_r = [0.0; RACK_BLOCK];
        for k in 0..self.order_len {
            if let Some(Some(Module::Out(o))) = self.slots.get(self.order[k] as usize).map(|s| &s.module) {
                for i in 0..RACK_BLOCK {
                    self.blk_l[i] += o.l[i];
                    self.blk_r[i] += o.r[i];
                }
                // Voice activity (module docs): reads only.
                for (v, &p) in self.vis_level.iter_mut().zip(&o.peak) {
                    if p > *v {
                        *v = p;
                    }
                }
            }
        }
        self.vis_rendered = true;
        self.vis_gate = [0.0; MAX_POLY];
        if let Some(m) = self.slots.iter().position(|s| matches!(s.module, Some(Module::MidiIn(_)))) {
            // MIDI In's port 1 is `gate`.
            if let Some(g) = self.outs.get(m * MAX_PORTS + 1) {
                for (k, v) in self.vis_gate.iter_mut().enumerate().take(g.channels.min(MAX_POLY)) {
                    *v = g.data[k][RACK_BLOCK - 1];
                }
            }
        }

        let loud = self.blk_l.iter().chain(&self.blk_r).any(|x| x.abs() > SILENCE);
        self.silent_frames = if loud { 0 } else { self.silent_frames.saturating_add(RACK_BLOCK) };

        for i in 0..RACK_BLOCK {
            self.gain = if self.queued > 0 {
                (self.gain - self.fade_step).max(0.0)
            } else {
                (self.gain + self.fade_step).min(1.0)
            };
            let (l, r) = (self.blk_l[i] * self.gain, self.blk_r[i] * self.gain);
            self.blk_l[i] = if l.is_finite() { l } else { 0.0 };
            self.blk_r[i] = if r.is_finite() { r } else { 0.0 };
        }
        if self.queued > 0 && self.gain <= 0.0 {
            self.apply_queue();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::catalog::ModuleKind;
    use super::modules::{Ctx, Module};
    use super::port::PortBuf;
    use super::*;
    use crate::protocol::{ERR_BAD_INDEX, ERR_BAD_VALUE, OK};
    use fx_pool::FxPool;
    use crate::{MAX_MODULES, MAX_PARAMS, MAX_POLY, RACK_BLOCK};

    const SR: f32 = 48000.0;
    // Param indices (catalog order).
    const VCA_LEVEL: usize = 0;
    const LFO_WAVE: usize = 0;
    const LFO_RATE: usize = 1;
    const LFO_DEPTH: usize = 4;
    const SQUARE: f32 = 3.0;

    fn ctx() -> Ctx {
        Ctx { sr: SR, bpm: 120.0, playing: false, ticks: 0.0, ticks_per_frame: 0.0 }
    }

    /// Render `frames` (rounded up to whole 128-frame blocks); returns L.
    fn render(r: &mut Rack, frames: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let (mut l, mut rr) = ([0.0f32; 128], [0.0f32; 128]);
        for _ in 0..frames.div_ceil(128) {
            l.fill(0.0);
            rr.fill(0.0);
            r.render_add(&ctx(), &mut FxPool::empty(), SampleView::NONE, &mut l, &mut rr);
            out.extend_from_slice(&l);
        }
        out
    }

    /// LFO `lfo` -> VCA `vca`.in -> Out `out`.l
    fn chain(r: &mut Rack, lfo: usize, vca: usize, out: usize) {
        assert_eq!(r.add_module(lfo, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(vca, ModuleKind::Vca, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(out, ModuleKind::Out, &mut FxPool::empty()), OK);
        assert_eq!(r.connect((lfo, 0), (vca, 0)), OK);
        assert_eq!(r.connect((vca, 0), (out, 0)), OK);
    }

    fn max_jump(prev: f32, xs: &[f32]) -> f32 {
        let mut last = prev;
        let mut m = 0.0f32;
        for &x in xs {
            m = m.max((x - last).abs());
            last = x;
        }
        m
    }

    /// Plan 11 review: mono MIDI In `vel` feeds an ADSR `vel`, which latches
    /// it on the gate's rising sample. A note from silence must deliver its
    /// own velocity at once (not glide in from the previous note's); a
    /// legato note keeps the ADSR's latched velocity while MIDI `vel` glides.
    #[test]
    fn mono_velocity_reaches_adsr_on_fresh_notes() {
        use super::modules::NoteEvent;
        let fx = &mut FxPool::empty();
        let mut r = Rack::new(SR);
        assert_eq!(r.add_module(0, ModuleKind::MidiIn, fx), OK);
        assert_eq!(r.add_module(1, ModuleKind::Adsr, fx), OK);
        assert_eq!(r.add_module(2, ModuleKind::Out, fx), OK);
        assert_eq!(r.set_param(0, 1, 1.0), OK); // mono
        assert_eq!(r.set_param(1, 0, 0.001), OK); // attack
        assert_eq!(r.set_param(1, 2, 1.0), OK); // sustain
        assert_eq!(r.set_param(1, 3, 0.005), OK); // release
        assert_eq!(r.set_param(1, 5, 1.0), OK); // vel_amt
        assert_eq!(r.set_param(2, 0, 1.0), OK); // Out level
        assert_eq!(r.connect((0, 1), (1, 0)), OK); // gate
        assert_eq!(r.connect((0, 2), (1, 1)), OK); // vel -> adsr vel
        assert_eq!(r.connect((1, 0), (2, 0)), OK); // env -> l
        assert_eq!(r.connect((0, 2), (2, 1)), OK); // MIDI vel -> r
        let mut block = |r: &mut Rack, n: usize| {
            let (mut l, mut rr) = (Vec::new(), Vec::new());
            for _ in 0..n {
                let (mut bl, mut br) = ([0.0f32; 128], [0.0f32; 128]);
                r.render_add(&ctx(), fx, SampleView::NONE, &mut bl, &mut br);
                l.extend_from_slice(&bl);
                rr.extend_from_slice(&br);
            }
            (l, rr)
        };
        block(&mut r, 10);
        for vel in [127u8, 40, 100, 1] {
            r.note(NoteEvent::On { note: 60, vel });
            let (l, _) = block(&mut r, 20);
            let want = vel as f32 / 127.0;
            assert!((l.last().unwrap() - want).abs() < 1e-4, "vel {vel}: env {} want {want}", l.last().unwrap());
            r.note(NoteEvent::Off { note: 60 });
            block(&mut r, 20);
        }
        // Legato: 62 (vel 127) over a held 60 (vel 40): no new edge, so the
        // ADSR keeps 40; MIDI vel itself glides (not a step) to 127.
        r.note(NoteEvent::On { note: 60, vel: 40 });
        let (_, before) = block(&mut r, 20);
        r.note(NoteEvent::On { note: 62, vel: 127 });
        let (l, rr) = block(&mut r, 20);
        assert!(l.iter().all(|&e| (e - 40.0 / 127.0).abs() < 1e-4), "legato keeps the first velocity");
        assert!(rr[0] - before.last().unwrap() < 0.1, "MIDI vel glides on legato: {}", rr[0]);
        assert!((rr.last().unwrap() - 1.0).abs() < 1e-4);
    }

    #[test]
    fn lfo_through_vca_to_out_renders() {
        let mut r = Rack::new(SR);
        chain(&mut r, 0, 1, 2);
        assert_eq!(r.set_param(0, LFO_RATE, 10.0), OK);
        let out = render(&mut r, SR as usize);
        let peak = out.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(peak > 0.5, "peak {peak}");
        // Rising zero crossings -> frequency.
        let ups: Vec<usize> = (1..out.len()).filter(|&i| out[i - 1] < 0.0 && out[i] >= 0.0).collect();
        assert!(ups.len() >= 5, "crossings {}", ups.len());
        let span = (ups[ups.len() - 1] - ups[0]) as f32 / SR;
        let hz = (ups.len() - 1) as f32 / span;
        assert!((hz - 10.0).abs() <= 0.5, "measured {hz} Hz");
    }

    #[test]
    fn topo_order_respects_cables() {
        let mut r = Rack::new(SR);
        assert_eq!(r.add_module(0, ModuleKind::Out, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(5, ModuleKind::Vca, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(9, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        assert_eq!(r.connect((9, 0), (5, 0)), OK);
        assert_eq!(r.connect((5, 0), (0, 0)), OK);
        assert_eq!(r.order(), &[9, 5, 0]);
    }

    #[test]
    fn feedback_loop_uses_previous_subblock() {
        let mut r = Rack::new(SR);
        assert_eq!(r.add_module(0, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(1, ModuleKind::Vca, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(2, ModuleKind::Vca, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(3, ModuleKind::Out, &mut FxPool::empty()), OK);
        assert_eq!(r.connect((0, 0), (1, 0)), OK);
        assert_eq!(r.connect((1, 0), (2, 0)), OK);
        assert_eq!(r.connect((2, 0), (1, 1)), OK); // the loop
        assert_eq!(r.connect((2, 0), (3, 0)), OK);
        let out = render(&mut r, 100 * 128);
        assert!(out.iter().all(|x| x.is_finite()));
        let mut seen = [0u32; MAX_MODULES];
        for &m in r.order() {
            seen[m as usize] += 1;
        }
        assert_eq!(r.order().len(), 4);
        assert!(seen[..4].iter().all(|&n| n == 1), "{:?}", r.order());
        // LFO has no inputs so it must come first; Out (fed only by the loop) last.
        assert_eq!(r.order()[0], 0);
        assert_eq!(r.order()[3], 3);
    }

    #[test]
    fn connect_replaces_existing_cable() {
        let mut r = Rack::new(SR);
        assert_eq!(r.add_module(0, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(1, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(2, ModuleKind::Vca, &mut FxPool::empty()), OK);
        assert_eq!(r.connect((0, 0), (2, 0)), OK);
        assert_eq!(r.cable((2, 0)), Some((0, 0)));
        assert_eq!(r.connect((1, 0), (2, 0)), OK);
        assert_eq!(r.cable((2, 0)), Some((1, 0)));
        assert_eq!(r.disconnect((2, 0)), OK);
        assert_eq!(r.cable((2, 0)), None);
    }

    #[test]
    fn remove_module_drops_its_cables() {
        let mut r = Rack::new(SR);
        chain(&mut r, 0, 1, 2);
        assert_eq!(r.add_module(3, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        assert_eq!(r.connect((3, 0), (1, 1)), OK);
        assert_eq!(r.remove_module(1), OK);
        assert_eq!(r.kind(1), None);
        assert_eq!(r.cable((2, 0)), None, "cable from the removed module");
        assert_eq!(r.order(), &[0, 2, 3]);
        // Re-adding at the same index starts with no cables.
        assert_eq!(r.add_module(1, ModuleKind::Vca, &mut FxPool::empty()), OK);
        assert_eq!(r.cable((1, 0)), None);
        assert_eq!(r.cable((1, 1)), None);
    }

    #[test]
    fn bad_args_return_codes() {
        let mut r = Rack::new(SR);
        // Bad kind: ids that are not (yet) modules decode to None, which the
        // engine reports as ERR_BAD_INDEX.
        assert_eq!(ModuleKind::from_id(99), None);
        assert_eq!(ModuleKind::from_id(u32::MAX), None);
        assert_eq!(r.add_module(MAX_MODULES, ModuleKind::Vca, &mut FxPool::empty()), ERR_BAD_INDEX);
        assert_eq!(r.add_module(0, ModuleKind::Vca, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(0, ModuleKind::Lfo, &mut FxPool::empty()), ERR_BAD_VALUE, "occupied");
        assert_eq!(r.kind(0), Some(ModuleKind::Vca));
        assert_eq!(r.remove_module(5), ERR_BAD_INDEX, "empty slot");
        assert_eq!(r.remove_module(usize::MAX), ERR_BAD_INDEX);
        // connect: bad modules / ports
        assert_eq!(r.connect((5, 0), (0, 0)), ERR_BAD_INDEX, "empty source");
        assert_eq!(r.connect((0, 1), (0, 0)), ERR_BAD_INDEX, "VCA has 1 output");
        assert_eq!(r.connect((0, 0), (0, 2)), ERR_BAD_INDEX, "VCA has 2 inputs");
        assert_eq!(r.connect((0, 0), (40, 0)), ERR_BAD_INDEX);
        assert_eq!(r.disconnect((0, 5)), ERR_BAD_INDEX);
        assert_eq!(r.disconnect((7, 0)), ERR_BAD_INDEX);
        assert_eq!(r.disconnect((0, 0)), OK, "unconnected input is fine");
        // set_param
        assert_eq!(r.set_param(0, VCA_LEVEL, 1.5), ERR_BAD_VALUE);
        assert_eq!(r.set_param(0, VCA_LEVEL, -0.1), ERR_BAD_VALUE);
        assert_eq!(r.set_param(0, VCA_LEVEL, f32::NAN), ERR_BAD_VALUE);
        assert_eq!(r.set_param(0, 1, 0.5), ERR_BAD_INDEX, "VCA has 1 param");
        assert_eq!(r.set_param(0, MAX_PARAMS + 3, 0.5), ERR_BAD_INDEX);
        assert_eq!(r.set_param(9, 0, 0.5), ERR_BAD_INDEX, "empty slot");
        assert_eq!(r.set_param(0, VCA_LEVEL, 0.5), OK);
        assert_eq!(r.add_module(1, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        assert_eq!(r.set_param(1, LFO_WAVE, 1.5), ERR_BAD_VALUE, "fractional choice");
        assert_eq!(r.set_param(1, LFO_WAVE, 4.0), ERR_BAD_VALUE, "past last choice");
        assert_eq!(r.set_param(1, LFO_WAVE, 3.0), OK);
        assert_eq!(r.set_param(1, LFO_RATE, f32::INFINITY), ERR_BAD_VALUE);
        assert_eq!(r.set_param(1, LFO_RATE, 0.001), ERR_BAD_VALUE);
    }

    #[test]
    fn mono_input_broadcasts_to_poly() {
        let mut p = PortBuf::new();
        assert_eq!(p.channels, 0);
        assert_eq!(p.get(0, 0), 0.0, "unconnected reads 0");
        p.channels = 1;
        p.data[0][3] = 0.5;
        for ch in 0..MAX_POLY {
            assert_eq!(p.get(ch, 3), 0.5, "broadcast to ch {ch}");
        }
        p.channels = 4;
        p.data[2][3] = 0.25;
        assert_eq!(p.get(2, 3), 0.25);
        assert_eq!(p.get(7, 3), 0.0, "past the last channel");
        assert_eq!(p.get(MAX_POLY + 5, RACK_BLOCK + 5), 0.0, "out of range never panics");

        // A VCA with 4-channel `in` and 1-channel `cv`: cv is broadcast.
        let mut vca = Module::new(ModuleKind::Vca, SR);
        let mut ins = [PortBuf::new(), PortBuf::new()];
        ins[0].channels = 4;
        for ch in 0..4 {
            for i in 0..RACK_BLOCK {
                ins[0].data[ch][i] = (ch as f32 + 1.0) * 0.1 + i as f32 * 0.001;
            }
        }
        ins[1].channels = 1;
        for i in 0..RACK_BLOCK {
            ins[1].data[0][i] = 0.5 + i as f32 * 0.01;
        }
        let mut outs = [PortBuf::new()];
        let params = [1.0f32; MAX_PARAMS];
        vca.process(&ctx(), &params, &ins, &mut outs, &mut FxPool::empty(), SampleView::NONE);
        assert_eq!(outs[0].channels, 4);
        for ch in 0..4 {
            for i in 0..RACK_BLOCK {
                let want = ins[0].data[ch][i] * ins[1].data[0][i];
                assert!((outs[0].data[ch][i] - want).abs() < 1e-6, "ch {ch} i {i}");
            }
        }
    }

    /// Square LFO at 1 Hz (high for the first 0.5 s) -> VCA -> Out: the Out
    /// sits at +0.8 (Out level default) while we edit.
    fn sounding_square() -> Rack {
        let mut r = Rack::new(SR);
        chain(&mut r, 0, 1, 2);
        assert_eq!(r.set_param(0, LFO_WAVE, SQUARE), OK);
        assert_eq!(r.set_param(0, LFO_RATE, 1.0), OK);
        assert_eq!(r.set_param(0, LFO_DEPTH, 1.0), OK);
        let out = render(&mut r, 4800);
        assert!((out[out.len() - 1] - 0.8).abs() < 1e-3, "{}", out[out.len() - 1]);
        assert!(r.is_sounding());
        r
    }

    #[test]
    fn structural_edit_is_declicked() {
        let mut r = sounding_square();
        // Returns immediately, before any audio is rendered.
        assert_eq!(r.disconnect((2, 0)), OK);
        let out = render(&mut r, 480);
        let j = max_jump(0.8, &out);
        assert!(j <= 0.05, "jump {j}");
        let four_ms = (0.004 * SR) as usize;
        assert!(out[four_ms..].iter().all(|&x| x == 0.0), "not silent after 4 ms");
        assert_eq!(r.cable((2, 0)), None, "edit applied after the fade");
        // Silence for 50 ms -> no longer sounding; edits then apply at once.
        render(&mut r, 2400);
        assert!(!r.is_sounding());
        assert_eq!(r.connect((1, 0), (2, 0)), OK);
        assert_eq!(r.cable((2, 0)), Some((1, 0)));
    }

    #[test]
    fn noop_edits_do_not_dip_the_output() {
        let mut r = sounding_square();
        assert_eq!(r.disconnect((1, 1)), OK, "cv already unconnected");
        assert_eq!(r.connect((0, 0), (1, 0)), OK, "cable already there");
        let out = render(&mut r, 480);
        assert!(out.iter().all(|&x| (x - 0.8).abs() < 1e-3), "output dipped");
    }

    #[test]
    fn queued_edits_validate_against_pending_state() {
        let mut r = sounding_square();
        // A cable-less add applies at once, even while sounding.
        assert_eq!(r.add_module(3, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        assert_eq!(r.kind(3), Some(ModuleKind::Lfo));
        assert_eq!(r.connect((3, 0), (1, 1)), OK); // queued (sounding)
        assert_eq!(r.cable((1, 1)), None);
        // With the queue non-empty, adds queue too (ordering).
        assert_eq!(r.add_module(5, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(5, ModuleKind::Lfo, &mut FxPool::empty()), ERR_BAD_VALUE, "occupied once queued");
        assert_eq!(r.kind(5), None, "not applied before the fade-out");
        // Module 5 is not in the running graph yet, but validates.
        assert_eq!(r.connect((5, 0), (1, 1)), OK);
        assert_eq!(r.set_param(5, LFO_RATE, 3.0), OK);
        let out = render(&mut r, 960);
        assert!(max_jump(0.8, &out) <= 0.05);
        assert_eq!(r.kind(5), Some(ModuleKind::Lfo));
        assert_eq!(r.cable((1, 1)), Some((5, 0)));
        assert_eq!(r.param(5, LFO_RATE), Some(3.0));
    }

    #[test]
    fn add_while_sounding_does_not_dip() {
        let mut r = sounding_square();
        assert_eq!(r.add_module(7, ModuleKind::Vca, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(8, ModuleKind::Out, &mut FxPool::empty()), OK);
        assert_eq!(r.kind(8), Some(ModuleKind::Out));
        let out = render(&mut r, 480);
        assert!(out.iter().all(|&x| (x - 0.8).abs() < 1e-3), "output dipped");
    }

    #[test]
    fn edit_on_silent_rack_fades_in() {
        let mut r = Rack::new(SR);
        assert_eq!(r.add_module(0, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(1, ModuleKind::Vca, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(2, ModuleKind::Out, &mut FxPool::empty()), OK);
        assert_eq!(r.set_param(0, LFO_WAVE, SQUARE), OK);
        assert_eq!(r.set_param(0, LFO_RATE, 1.0), OK);
        assert_eq!(r.connect((0, 0), (1, 0)), OK);
        // The LFO free-runs (at +1) while nothing reaches Out.
        let silent = render(&mut r, 1280);
        assert!(silent.iter().all(|&x| x == 0.0));
        assert!(!r.is_sounding());
        // The last cable applies at once, but the output fades in.
        assert_eq!(r.connect((1, 0), (2, 0)), OK);
        assert_eq!(r.cable((2, 0)), Some((1, 0)));
        let out = render(&mut r, 960);
        let j = max_jump(0.0, &out);
        assert!(j <= 0.05, "jump {j}");
        assert!((out[out.len() - 1] - 0.8).abs() < 1e-3);
    }

    #[test]
    fn cycle_breaking_keeps_downstream_last() {
        // Out@0 is fed by the loop 1 <-> 2 but is not on it.
        let mut r = Rack::new(SR);
        assert_eq!(r.add_module(0, ModuleKind::Out, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(1, ModuleKind::Vca, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(2, ModuleKind::Vca, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(3, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        assert_eq!(r.connect((3, 0), (1, 0)), OK);
        assert_eq!(r.connect((1, 0), (2, 0)), OK);
        assert_eq!(r.connect((2, 0), (1, 1)), OK);
        assert_eq!(r.connect((2, 0), (0, 0)), OK);
        assert_eq!(r.order(), &[3, 1, 2, 0]);
    }

    #[test]
    fn queue_overflow_applies_in_order() {
        let mut r = sounding_square();
        assert_eq!(r.add_module(3, ModuleKind::Lfo, &mut FxPool::empty()), OK);
        // 101 edits: overflows the 64-entry queue; ends connected.
        for i in 0..100 {
            let code = if i % 2 == 0 { r.connect((3, 0), (1, 1)) } else { r.disconnect((1, 1)) };
            assert_eq!(code, OK);
        }
        assert_eq!(r.connect((3, 0), (1, 1)), OK);
        let out = render(&mut r, 960);
        assert!(out.iter().all(|x| x.is_finite()));
        assert_eq!(r.cable((1, 1)), Some((3, 0)));
        assert_eq!(r.kind(3), Some(ModuleKind::Lfo));
    }

    #[test]
    fn clear_while_sounding_fades() {
        let mut r = sounding_square();
        r.clear();
        let out = render(&mut r, 480);
        assert!(max_jump(0.8, &out) <= 0.05);
        assert!(out[(0.004 * SR) as usize..].iter().all(|&x| x == 0.0));
        assert!(r.order().is_empty());
        assert!((0..MAX_MODULES).all(|i| r.kind(i).is_none()));
    }

    #[test]
    fn automation_on_a_silent_rack_takes_its_value_at_once() {
        // A replayed song's first block: no glide from the base to the lane.
        let mut r = Rack::new(SR);
        chain(&mut r, 0, 1, 2);
        assert_eq!(r.set_param(0, LFO_WAVE, SQUARE), OK);
        assert_eq!(r.set_param(0, LFO_RATE, 0.5), OK);
        assert_eq!(r.set_param(0, LFO_DEPTH, 1.0), OK);
        assert!(!r.is_sounding());
        r.automate(1, VCA_LEVEL, 0.5); // base is 1.0
        let out = render(&mut r, 4800);
        let settled = out[out.len() - 1];
        assert!((settled - 0.4).abs() < 1e-3, "{settled}");
        // Past the 2 ms fade-in and the LFO's slew, a glide from 1.0 would
        // still be near 0.5-0.9 here.
        let early = &out[(0.008 * SR) as usize..(0.012 * SR) as usize];
        assert!(early.iter().all(|&x| (x - 0.4).abs() < 0.02), "glided from the base: {:?}", &early[..4]);
    }

    #[test]
    fn param_change_is_smoothed() {
        let mut r = sounding_square();
        assert_eq!(r.set_param(0, LFO_RATE, 0.01), OK); // stays high
        let before = render(&mut r, 128);
        assert_eq!(r.set_param(1, VCA_LEVEL, 0.0), OK);
        let out = render(&mut r, 4800);
        let j = max_jump(before[before.len() - 1], &out);
        assert!(j <= 0.05, "jump {j}");
        assert!(out[out.len() - 1].abs() < 1e-3, "reaches 0: {}", out[out.len() - 1]);
    }

    // Osc param indices / wave choices (catalog order).
    const OSC_WAVE: usize = 0;
    const OSC_OCTAVE: usize = 1;
    const OSC_TUNE: usize = 2;
    const SAW: f32 = 0.0;
    const OSC_SQUARE: f32 = 1.0;
    const TRI: f32 = 2.0;
    const SINE: f32 = 3.0;

    /// Free-running Osc (C4, no pitch input) at `wave` -> Out.l, rendered
    /// past the fade-in so it is sounding.
    fn sounding_osc(wave: f32, frames: usize) -> (Rack, f32) {
        let mut r = Rack::new(SR);
        assert_eq!(r.add_module(0, ModuleKind::Osc, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(1, ModuleKind::Out, &mut FxPool::empty()), OK);
        assert_eq!(r.set_param(0, OSC_WAVE, wave), OK);
        assert_eq!(r.connect((0, 0), (1, 0)), OK);
        let out = render(&mut r, frames);
        assert!(r.is_sounding());
        (r, out[out.len() - 1])
    }

    #[test]
    fn choice_param_switch_while_sounding_is_declicked() {
        // Sine and triangle are both smooth at C4 (<= 0.03 per sample at 0.8),
        // but differ by up to ~0.17 at the same phase: an instant switch would
        // jump. Try several switch points so one lands mid-cycle.
        for k in 0..8 {
            let (mut r, last) = sounding_osc(SINE, 1280 + k * 128 + 37 * k);
            assert_eq!(r.set_param(0, OSC_WAVE, TRI), OK);
            let out = render(&mut r, 960);
            let j = max_jump(last, &out);
            assert!(j <= 0.05, "switch point {k}: jump {j}");
            assert_eq!(r.param(0, OSC_WAVE), Some(TRI), "applied after the fade");
        }
    }

    #[test]
    fn saw_to_square_while_sounding_fades_through_zero() {
        // Saw and square both have edges of their own, so instead of a jump
        // bound check that the switch is deferred behind the 2 ms fade-out
        // (output reaches 0 before the new wave starts) and fades back in.
        let (mut r, _) = sounding_osc(SAW, 1280);
        assert_eq!(r.set_param(0, OSC_WAVE, OSC_SQUARE), OK);
        assert_eq!(r.param(0, OSC_WAVE), Some(SAW), "queued while sounding");
        let out = render(&mut r, 480);
        let fade = (DECLICK_SECONDS * SR) as usize;
        let zero = out.iter().position(|&x| x == 0.0).expect("output reaches 0");
        assert!(zero <= fade + 1, "reaches 0 at {zero}");
        // Within the fade the gain ramps linearly, so |x| <= 0.8 * (1 - i/fade).
        for (i, &x) in out[..fade].iter().enumerate() {
            assert!(x.abs() <= 0.8 * (1.0 - i as f32 / fade as f32) + 0.02, "sample {i}: {x}");
        }
        assert_eq!(r.param(0, OSC_WAVE), Some(OSC_SQUARE));
        assert!(out[out.len() - 1].abs() > 0.5, "square back at level");
    }

    #[test]
    fn continuous_unsmoothed_params_still_apply_at_once() {
        // Tune / ADSR times / LFO rate are not `smooth` but never click
        // (phase and envelope stay continuous); they must not dip the output
        // on every knob step while dragging.
        let (mut r, _) = sounding_square_osc();
        assert_eq!(r.set_param(0, OSC_TUNE, 3.0), OK);
        assert_eq!(r.param(0, OSC_TUNE), Some(3.0), "applied at once");
        let out = render(&mut r, 480);
        assert!(!dipped(&out), "output dipped");
    }

    /// A declick dip holds the output under 0.5 for ~100+ samples; a square
    /// edge (PolyBLEP) only for a couple.
    fn dipped(out: &[f32]) -> bool {
        out.iter().filter(|x| x.abs() < 0.5).count() > 8
    }

    /// Square osc at C1: long flat stretches at +-0.8.
    fn sounding_square_osc() -> (Rack, f32) {
        let mut r = Rack::new(SR);
        assert_eq!(r.add_module(0, ModuleKind::Osc, &mut FxPool::empty()), OK);
        assert_eq!(r.add_module(1, ModuleKind::Out, &mut FxPool::empty()), OK);
        assert_eq!(r.set_param(0, OSC_WAVE, OSC_SQUARE), OK);
        assert_eq!(r.set_param(0, OSC_OCTAVE, -3.0), OK);
        assert_eq!(r.connect((0, 0), (1, 0)), OK);
        let out = render(&mut r, 1280);
        (r, out[out.len() - 1])
    }

    #[test]
    fn resending_the_same_choice_does_not_dip() {
        let (mut r, _) = sounding_square_osc();
        assert_eq!(r.set_param(0, OSC_WAVE, OSC_SQUARE), OK);
        assert_eq!(r.set_param(0, OSC_OCTAVE, -3.0), OK);
        let out = render(&mut r, 480);
        assert!(!dipped(&out), "output dipped");
    }

    #[test]
    fn odd_block_sizes_render_continuously() {
        let mut r = Rack::new(SR);
        chain(&mut r, 0, 1, 2);
        assert_eq!(r.set_param(0, LFO_RATE, 50.0), OK);
        // Warm up past the 2 ms fade-in that follows the (silent-rack) edits.
        let warm = render(&mut r, 1280);
        let mut out = vec![warm[warm.len() - 1]];
        for n in [1usize, 31, 100, 7, 128, 33, 200] {
            let (mut l, mut rr) = (vec![0.0f32; n], vec![0.0f32; n]);
            r.render_add(&ctx(), &mut FxPool::empty(), SampleView::NONE, &mut l, &mut rr);
            assert_eq!(l, rr, "l feeds both sides when r is unconnected");
            out.extend_from_slice(&l);
        }
        // A 50 Hz sine at 0.8 moves at most 2*pi*50*0.8/48000 per sample.
        let j = max_jump(out[0], &out);
        assert!(j < 0.006, "discontinuity {j}");
    }
}
