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
//! no zero-in-degree candidate, so when Kahn stalls the lowest-index remaining
//! module is taken next (cycles are broken in index order) and Kahn resumes,
//! so modules downstream of a loop still run after it.
//!
//! Before a module runs, each connected input is copied from its source's
//! output buffer into per-rack scratch. A source earlier in the order has
//! already written this sub-block; a source later in the order (a feedback
//! cable) still holds the previous sub-block. So loops are allowed and cost
//! exactly one sub-block of delay.
//!
//! # Declicking
//! * Params: modules smooth `smooth` params per sample (5 ms one-pole), so
//!   `set_param` applies immediately.
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

pub mod catalog;
pub mod modules;
pub mod port;

use crate::protocol::{ERR_BAD_INDEX, ERR_BAD_VALUE, OK};
use crate::{MAX_MODULES, MAX_PARAMS, MAX_PORTS, RACK_BLOCK};
use catalog::{spec, ModuleKind};
use modules::{Ctx, Module, NoteEvent};
use port::PortBuf;

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
    Add(u8, ModuleKind),
    Remove(u8),
    Connect { from: (u8, u8), to: (u8, u8) },
    Disconnect((u8, u8)),
    SetParam(u8, u8, f32),
    Clear,
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
        }
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
    /// queued are dropped: the clear supersedes them.
    pub fn clear(&mut self) {
        self.pending = [None; MAX_MODULES];
        if self.queued > 0 || self.is_sounding() {
            self.queue[0] = Edit::Clear;
            self.queued = 1;
        } else {
            self.apply(Edit::Clear);
            self.rebuild_order();
        }
    }

    /// Add a module of `kind` at slot `idx` with default params and no cables.
    /// `ERR_BAD_INDEX` if `idx >= MAX_MODULES`; `ERR_BAD_VALUE` if occupied.
    pub fn add_module(&mut self, idx: usize, kind: ModuleKind) -> i32 {
        let Some(slot) = self.pending.get_mut(idx) else { return ERR_BAD_INDEX };
        if slot.is_some() {
            return ERR_BAD_VALUE;
        }
        *slot = Some(kind);
        self.submit(Edit::Add(idx as u8, kind), true);
        OK
    }

    /// Remove module `idx` and every cable into or out of it.
    /// `ERR_BAD_INDEX` if there is no module there.
    pub fn remove_module(&mut self, idx: usize) -> i32 {
        match self.pending.get_mut(idx) {
            Some(slot @ Some(_)) => *slot = None,
            _ => return ERR_BAD_INDEX,
        }
        self.submit(Edit::Remove(idx as u8), true);
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
        self.submit(e, true);
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
        self.submit(Edit::Disconnect((to.0 as u8, to.1 as u8)), true);
        OK
    }

    /// Set param `param` of module `idx` (its smoothing, if any, is done by the
    /// module). `ERR_BAD_INDEX` for a missing module or param; `ERR_BAD_VALUE`
    /// for NaN/Inf, values outside the spec's `min..=max`, or a fractional
    /// value for an integer (incl. choice) param.
    pub fn set_param(&mut self, idx: usize, param: usize, value: f32) -> i32 {
        let Some(Some(kind)) = self.pending.get(idx).copied() else { return ERR_BAD_INDEX };
        let Some(p) = spec(kind).params.get(param) else { return ERR_BAD_INDEX };
        if !(value >= p.min && value <= p.max) || (p.integer && value.fract() != 0.0) {
            return ERR_BAD_VALUE;
        }
        self.submit(Edit::SetParam(idx as u8, param as u8, value), false);
        OK
    }

    /// Forward a note event to every MIDI In module (other modules ignore it).
    pub fn note(&mut self, ev: NoteEvent) {
        for slot in self.slots.iter_mut() {
            if let Some(m) = slot.module.as_mut() {
                m.note(ev);
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
    /// Structural edits queue while sounding; anything queues while the queue
    /// is non-empty (to keep edits in order). On overflow everything applies.
    fn submit(&mut self, e: Edit, structural: bool) {
        let defer = self.queued > 0 || (structural && self.is_sounding());
        if !defer {
            self.apply(e);
            if structural {
                self.rebuild_order();
            }
        } else if self.queued < EDIT_QUEUE_LEN {
            self.queue[self.queued] = e;
            self.queued += 1;
        } else {
            self.apply_queue();
            self.apply(e);
            self.rebuild_order();
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
            Edit::Add(i, kind) => {
                let i = i as usize;
                if let Some(slot) = self.slots.get_mut(i) {
                    slot.module = Some(Module::new(kind, self.sr));
                    slot.params = [0.0; MAX_PARAMS];
                    for (dst, p) in slot.params.iter_mut().zip(spec(kind).params) {
                        *dst = p.default;
                    }
                    slot.cables = [None; MAX_PORTS];
                }
                self.silence_outputs(i);
            }
            Edit::Remove(i) => {
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

    /// Kahn's algorithm over the running graph (fixed arrays, no allocation).
    /// Ready modules are taken lowest index first; when none is ready (only
    /// cycles remain) the lowest-index remaining module is taken.
    fn rebuild_order(&mut self) {
        let mut present = [false; MAX_MODULES];
        let mut indeg = [0u8; MAX_MODULES];
        for (m, slot) in self.slots.iter().enumerate().take(MAX_MODULES) {
            present[m] = slot.module.is_some();
        }
        let mut remaining = 0;
        for m in 0..MAX_MODULES {
            if !present[m] {
                continue;
            }
            remaining += 1;
            for (src, _) in self.slots[m].cables.iter().flatten() {
                if present.get(*src as usize).copied().unwrap_or(false) {
                    indeg[m] += 1;
                }
            }
        }
        let mut done = [false; MAX_MODULES];
        self.order_len = 0;
        while remaining > 0 {
            let ready = (0..MAX_MODULES).find(|&m| present[m] && !done[m] && indeg[m] == 0);
            let Some(pick) = ready.or_else(|| (0..MAX_MODULES).find(|&m| present[m] && !done[m])) else {
                break;
            };
            done[pick] = true;
            remaining -= 1;
            self.order[self.order_len] = pick as u8;
            self.order_len += 1;
            for m in 0..MAX_MODULES {
                if present[m] && !done[m] {
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
    /// `ctx.ticks` advanced to that sub-block's start while playing.
    pub fn render_add(&mut self, ctx: &Ctx, left: &mut [f32], right: &mut [f32]) {
        let n = left.len().min(right.len());
        let mut done = 0;
        while done < n {
            if self.blk_pos >= RACK_BLOCK {
                let mut sub = *ctx;
                if ctx.playing {
                    sub.ticks = ctx.ticks + done as f64 * ctx.ticks_per_frame;
                }
                self.render_sub(&sub);
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
    }

    /// Run every module once (in order), mix the Out modules into
    /// `blk_l`/`blk_r`, apply the declick gain, and apply queued edits once
    /// the fade-out has reached 0.
    fn render_sub(&mut self, ctx: &Ctx) {
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
                module.process(ctx, &slot.params, &self.ins[..n_in], outs);
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
            r.render_add(&ctx(), &mut l, &mut rr);
            out.extend_from_slice(&l);
        }
        out
    }

    /// LFO `lfo` -> VCA `vca`.in -> Out `out`.l
    fn chain(r: &mut Rack, lfo: usize, vca: usize, out: usize) {
        assert_eq!(r.add_module(lfo, ModuleKind::Lfo), OK);
        assert_eq!(r.add_module(vca, ModuleKind::Vca), OK);
        assert_eq!(r.add_module(out, ModuleKind::Out), OK);
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
        assert_eq!(r.add_module(0, ModuleKind::Out), OK);
        assert_eq!(r.add_module(5, ModuleKind::Vca), OK);
        assert_eq!(r.add_module(9, ModuleKind::Lfo), OK);
        assert_eq!(r.connect((9, 0), (5, 0)), OK);
        assert_eq!(r.connect((5, 0), (0, 0)), OK);
        assert_eq!(r.order(), &[9, 5, 0]);
    }

    #[test]
    fn feedback_loop_uses_previous_subblock() {
        let mut r = Rack::new(SR);
        assert_eq!(r.add_module(0, ModuleKind::Lfo), OK);
        assert_eq!(r.add_module(1, ModuleKind::Vca), OK);
        assert_eq!(r.add_module(2, ModuleKind::Vca), OK);
        assert_eq!(r.add_module(3, ModuleKind::Out), OK);
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
        assert_eq!(r.add_module(0, ModuleKind::Lfo), OK);
        assert_eq!(r.add_module(1, ModuleKind::Lfo), OK);
        assert_eq!(r.add_module(2, ModuleKind::Vca), OK);
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
        assert_eq!(r.add_module(3, ModuleKind::Lfo), OK);
        assert_eq!(r.connect((3, 0), (1, 1)), OK);
        assert_eq!(r.remove_module(1), OK);
        assert_eq!(r.kind(1), None);
        assert_eq!(r.cable((2, 0)), None, "cable from the removed module");
        assert_eq!(r.order(), &[0, 2, 3]);
        // Re-adding at the same index starts with no cables.
        assert_eq!(r.add_module(1, ModuleKind::Vca), OK);
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
        assert_eq!(r.add_module(MAX_MODULES, ModuleKind::Vca), ERR_BAD_INDEX);
        assert_eq!(r.add_module(0, ModuleKind::Vca), OK);
        assert_eq!(r.add_module(0, ModuleKind::Lfo), ERR_BAD_VALUE, "occupied");
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
        assert_eq!(r.add_module(1, ModuleKind::Lfo), OK);
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
        vca.process(&ctx(), &params, &ins, &mut outs);
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
        // Module 5 does not exist in the running graph yet, but is queued.
        assert_eq!(r.add_module(5, ModuleKind::Lfo), OK);
        assert_eq!(r.add_module(5, ModuleKind::Lfo), ERR_BAD_VALUE, "occupied once queued");
        assert_eq!(r.connect((5, 0), (1, 1)), OK);
        assert_eq!(r.set_param(5, LFO_RATE, 3.0), OK);
        assert_eq!(r.kind(5), None, "not applied before the fade-out");
        let out = render(&mut r, 960);
        assert!(max_jump(0.8, &out) <= 0.05);
        assert_eq!(r.kind(5), Some(ModuleKind::Lfo));
        assert_eq!(r.cable((1, 1)), Some((5, 0)));
        assert_eq!(r.param(5, LFO_RATE), Some(3.0));
    }

    #[test]
    fn queue_overflow_applies_in_order() {
        let mut r = sounding_square();
        assert_eq!(r.add_module(3, ModuleKind::Lfo), OK);
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

    #[test]
    fn odd_block_sizes_render_continuously() {
        let mut r = Rack::new(SR);
        chain(&mut r, 0, 1, 2);
        assert_eq!(r.set_param(0, LFO_RATE, 50.0), OK);
        let mut out = Vec::new();
        for n in [1usize, 31, 100, 7, 128, 33, 200] {
            let (mut l, mut rr) = (vec![0.0f32; n], vec![0.0f32; n]);
            r.render_add(&ctx(), &mut l, &mut rr);
            assert_eq!(l, rr, "l feeds both sides when r is unconnected");
            out.extend_from_slice(&l);
        }
        // A 50 Hz sine at 0.8 moves at most 2*pi*50*0.8/48000 per sample.
        let j = max_jump(0.0, &out);
        assert!(j < 0.006, "discontinuity {j}");
    }
}
