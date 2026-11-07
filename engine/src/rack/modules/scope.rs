//! Scope (plan 12): a patchable two-input oscilloscope. The engine only
//! records; triggering, XY, gain and freezing are drawn by the UI
//! (`app/src/ui/vis/scopeMath.ts`, `ScopeView.svelte`).
//!
//! * **A sink.** Inputs `a` and `b`, **no outputs**: nothing can be cabled
//!   from it, so it can never change the sound. The rack applies every
//!   Scope edit (add, remove, connect into it, disconnect, any param) at
//!   once without a declick fade (`rack/mod.rs`, `EditClass::Sink`).
//! * **Sum.** Each input's channels are summed **unnormalised**, as Out sums
//!   voices, so the trace shows what an Out fed the same cable would get
//!   (Gain A/B compensate on screen). Non-finite samples count as 0; an
//!   unconnected input reads 0 (B's flag bit is then clear).
//! * **Decimation.** The window is `10 × time` ms in Free, one `division`
//!   at the current tempo in Sync, in frames; `decim = max(1, ceil(window /
//!   VIS_SCOPE_WINDOW))`. Each ring entry is the min and max of A and of B
//!   over `decim` frames (4 f32: A min, A max, B min, B max), so a long
//!   timebase draws an honest envelope instead of an aliased line. A
//!   `decim` change starts a fresh entry and moves `epoch` to the head:
//!   readers never mix two timebases.
//! * **Ring and header.** The ring is this module's FX-pool scope slot
//!   (`fx_pool.rs`; `VIS_SCOPE_RING` entries, entry `h` at `h mod RING`);
//!   the header fields are `HDR_*` below. `head` counts entries written,
//!   as a wrapping i32, and keeps counting across owners (it lives in the
//!   pool's header, not here).
//! * **Grid marks** (Sync while playing): `grid_last` is the head (the
//!   entry being filled) at the frame where the latest division line
//!   falls, from `ctx.ticks` and `ctx.ticks_per_frame`, so it is exact to
//!   the entry; `grid_prev` the one before. A stop, a ticks jump (seek,
//!   loop wrap, count-in end), a division or `decim` change clear *grid
//!   valid* until two new lines have passed; a line exactly at the first
//!   frame after a restart counts (playing from a bar start shows the first
//!   division as soon as it is complete).
//! * It runs only while its rack renders (the track is active or still
//!   sounding), like every module; the UI shows the last frame dimmed as
//!   *idle* when the head stops moving.

use super::{mono_sum, param, PoolSlot};
use crate::rack::catalog::{ModuleKind, LFO_DIVISION_TICKS};
use crate::rack::fx_pool::{FxKind, FxPool};
use crate::rack::modules::Ctx;
use crate::rack::port::PortBuf;
use crate::{PPQ, RACK_BLOCK, VIS_SCOPE_RING, VIS_SCOPE_WINDOW};

// Header fields (i32, `VIS_SCOPE_HDR` per slot; mirrored in visLayout.ts
// `SCOPE_HDR`).
/// Track slot of the owner, −1 = free.
pub const HDR_OWNER_TRACK: usize = 0;
/// Module idx of the owner, −1 = free.
pub const HDR_OWNER_MODULE: usize = 1;
/// Entries written (wrapping i32).
pub const HDR_HEAD: usize = 2;
/// Frames per entry.
pub const HDR_DECIM: usize = 3;
/// The head at the claim and at every `decim` change: never read before it.
pub const HDR_EPOCH: usize = 4;
/// The head at the second-to-last division line.
pub const HDR_GRID_PREV: usize = 5;
/// The head at the last division line.
pub const HDR_GRID_LAST: usize = 6;
/// `FLAG_*` bits.
pub const HDR_FLAGS: usize = 7;
/// Flag: input B is connected.
pub const FLAG_B: i32 = 1;
/// Flag: `grid_prev`/`grid_last` are two consecutive division lines.
pub const FLAG_GRID: i32 = 2;
/// Flag: the `sync` param is on.
pub const FLAG_SYNC: i32 = 4;

const K: ModuleKind = ModuleKind::Scope;
const TIME: usize = 0;
const SYNC: usize = 1;
const DIVISION: usize = 2;

/// A division line within this many ticks counts as reached (float slack
/// in `ticks + i × ticks_per_frame`; a tick is ~25 frames at 120 BPM).
const LINE_EPS: f64 = 1e-6;
/// A sub-block starting further than this from where the last one ended
/// (in ticks) is a jump: seek, loop wrap, a tempo change straddling a
/// sub-block (harmless: Sync's `decim` changes then anyway).
const JUMP_TICKS: f64 = 0.5;

/// Ring position of entry `h`: `h & MASK` (the ring size divides 2^32, so
/// positions stay continuous when the i32 head wraps).
const MASK: usize = VIS_SCOPE_RING - 1;
const _: () = assert!(VIS_SCOPE_RING.is_power_of_two());

/// See the module docs.
#[derive(Clone)]
pub struct Scope {
    pool: PoolSlot,
    sr: f32,
    /// Frames per entry; 0 = not started (the first sub-block sets the epoch).
    decim: u32,
    /// Frames in the entry being filled, and its extremes so far.
    count: u32,
    acc: [f32; 4],
    /// Grid tracking (see the module docs).
    tracking: bool,
    div: usize,
    next_line: f64,
    expect: f64,
    lines: u32,
    grid_prev: i32,
    grid_last: i32,
}

impl Scope {
    /// A scope on FX-pool scope slot `slot`.
    pub fn new(sr: f32, slot: u8) -> Scope {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        Scope {
            pool: PoolSlot::new(FxKind::Scope, slot),
            sr,
            decim: 0,
            count: 0,
            acc: [0.0; 4],
            tracking: false,
            div: 0,
            next_line: 0.0,
            expect: 0.0,
            lines: 0,
            grid_prev: 0,
            grid_last: 0,
        }
    }

    pub fn slot(&self) -> u8 {
        self.pool.slot()
    }

    /// Start over: the ring is re-zeroed (one chunk, next `process`) and the
    /// next sub-block moves `epoch` to the head.
    pub fn reset(&mut self) {
        self.pool.rezero();
        self.decim = 0;
        self.count = 0;
        self.tracking = false;
        self.lines = 0;
    }

    /// Frames per entry for `params` at `ctx` (see the module docs).
    fn decim_for(&self, ctx: &Ctx, params: &[f32]) -> (u32, bool, usize) {
        let sync = param(params, K, SYNC) >= 0.5;
        let div = (param(params, K, DIVISION).max(0.0) as usize).min(LFO_DIVISION_TICKS.len() - 1);
        let sr = self.sr as f64;
        let window = if sync {
            let bpm = if ctx.bpm.is_finite() && ctx.bpm > 0.0 { ctx.bpm as f64 } else { 120.0 };
            LFO_DIVISION_TICKS[div] * 60.0 * sr / (bpm * PPQ)
        } else {
            10.0 * param(params, K, TIME) as f64 * sr / 1000.0
        };
        let d = (window / VIS_SCOPE_WINDOW as f64).ceil();
        // `!(d >= 1)` also catches NaN; the cap keeps the cast sane.
        let d = if d >= 1.0 { d.min(1e9) as u32 } else { 1 };
        (d, sync, div)
    }

    /// Not inlined into `Module::process`: inlining it there measurably
    /// slowed every other module's dispatch (release perf, spec 6: 8.9 % ->
    /// 9.4 % of real time without a single Scope).
    #[inline(never)]
    pub fn process(&mut self, ctx: &Ctx, params: &[f32], ins: &[PortBuf], fx: &mut FxPool) {
        let (decim, sync, div) = self.decim_for(ctx, params);
        let Some((ring, hdr)) = self.pool.scope(fx) else { return };
        let mut head = hdr[HDR_HEAD];
        if decim != self.decim {
            self.decim = decim;
            self.count = 0;
            self.tracking = false;
            hdr[HDR_EPOCH] = head;
            hdr[HDR_DECIM] = decim as i32;
        }

        let (mut a, mut b) = ([0.0; RACK_BLOCK], [0.0; RACK_BLOCK]);
        if let Some(p) = ins.first() {
            mono_sum(p, &mut a);
        }
        let b_on = ins.get(1).is_some_and(|p| p.channels > 0);
        if let Some(p) = ins.get(1) {
            mono_sum(p, &mut b);
        }

        // Grid: lines at whole multiples of the division, while playing.
        let tpf = ctx.ticks_per_frame;
        let grid = sync && ctx.playing && tpf > 0.0 && tpf.is_finite() && ctx.ticks.is_finite();
        let d = LFO_DIVISION_TICKS[div];
        if !grid {
            self.tracking = false;
        } else if !self.tracking || div != self.div || (ctx.ticks - self.expect).abs() > JUMP_TICKS {
            self.tracking = true;
            self.div = div;
            self.lines = 0;
            self.next_line = ((ctx.ticks - LINE_EPS) / d).ceil() * d;
        }

        for i in 0..RACK_BLOCK {
            if self.tracking && ctx.ticks + i as f64 * tpf >= self.next_line - LINE_EPS {
                self.grid_prev = self.grid_last;
                self.grid_last = head; // the entry this frame goes into
                self.lines = self.lines.saturating_add(1);
                self.next_line += d;
            }
            let (x, y) = (a[i], b[i]);
            if self.count == 0 {
                self.acc = [x, x, y, y];
            } else {
                self.acc[0] = self.acc[0].min(x);
                self.acc[1] = self.acc[1].max(x);
                self.acc[2] = self.acc[2].min(y);
                self.acc[3] = self.acc[3].max(y);
            }
            self.count += 1;
            if self.count >= self.decim {
                let at = (head as u32 as usize & MASK) * 4;
                if let Some(e) = ring.get_mut(at..at + 4) {
                    e.copy_from_slice(&self.acc);
                }
                head = head.wrapping_add(1);
                self.count = 0;
            }
        }
        if self.tracking {
            self.expect = ctx.ticks + RACK_BLOCK as f64 * tpf;
        } else {
            self.lines = 0;
        }

        hdr[HDR_HEAD] = head;
        hdr[HDR_GRID_PREV] = self.grid_prev;
        hdr[HDR_GRID_LAST] = self.grid_last;
        let valid = self.tracking && self.lines >= 2;
        hdr[HDR_FLAGS] = if b_on { FLAG_B } else { 0 } | if valid { FLAG_GRID } else { 0 } | if sync { FLAG_SYNC } else { 0 };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rack::catalog::spec;
    use crate::{MAX_PARAMS, VIS_SCOPE_HDR};

    const SR: f32 = 48000.0;

    /// One Scope on a claimed slot (owner: track 3, module 7) of a pool.
    struct Rig {
        m: Scope,
        fx: FxPool,
        slot: u8,
        params: [f32; MAX_PARAMS],
        ins: [PortBuf; 2],
        /// Frames rendered (ticks follow them while `playing`).
        frame: usize,
        bpm: f32,
        playing: bool,
        /// Added to the ticks (a seek).
        offset: f64,
    }

    impl Rig {
        fn new() -> Rig {
            let mut fx = FxPool::with_slots(SR, 0, 0, 0);
            let slot = fx.claim(FxKind::Scope).expect("a scope slot");
            fx.stamp_scope(slot, 3, 7);
            let mut params = [0.0; MAX_PARAMS];
            for (p, d) in params.iter_mut().zip(spec(K).params) {
                *p = d.default;
            }
            Rig {
                m: Scope::new(SR, slot),
                fx,
                slot,
                params,
                ins: [PortBuf::new(), PortBuf::new()],
                frame: 0,
                bpm: 120.0,
                playing: false,
                offset: 0.0,
            }
        }

        fn set(&mut self, name: &str, v: f32) {
            let i = spec(K).params.iter().position(|p| p.name == name).expect("param");
            self.params[i] = v;
        }

        fn tpf(&self) -> f64 {
            self.bpm as f64 * PPQ / (60.0 * SR as f64)
        }

        /// Render `frames` (whole sub-blocks); `feed(ins, frame)` fills the
        /// inputs for the sub-block starting at `frame`; `after` sees the
        /// header after each sub-block.
        fn run(&mut self, frames: usize, mut feed: impl FnMut(&mut [PortBuf; 2], usize), mut after: impl FnMut(&[i32], usize)) {
            let end = self.frame + frames;
            while self.frame < end {
                feed(&mut self.ins, self.frame);
                let tpf = self.tpf();
                let ctx = Ctx {
                    sr: SR,
                    bpm: self.bpm,
                    playing: self.playing,
                    ticks: self.offset + self.frame as f64 * tpf,
                    ticks_per_frame: if self.playing { tpf } else { 0.0 },
                };
                self.m.process(&ctx, &self.params, &self.ins, &mut self.fx);
                self.frame += RACK_BLOCK;
                after(&self.hdr(), self.frame);
            }
        }

        fn idle(&mut self, frames: usize) {
            self.run(frames, |_, _| {}, |_, _| {});
        }

        fn hdr(&self) -> Vec<i32> {
            let at = self.slot as usize * VIS_SCOPE_HDR;
            self.fx.scope_hdrs()[at..at + VIS_SCOPE_HDR].to_vec()
        }

        /// Entry `e` (a head value): A min, A max, B min, B max.
        fn entry(&self, e: i32) -> [f32; 4] {
            let at = self.slot as usize * VIS_SCOPE_RING * 4 + (e as u32 as usize & MASK) * 4;
            let r = &self.fx.scope_rings()[at..at + 4];
            [r[0], r[1], r[2], r[3]]
        }
    }

    /// Fill `p` as a mono signal `f(frame)` for the sub-block at `at`.
    fn mono(p: &mut PortBuf, at: usize, f: impl Fn(usize) -> f32) {
        p.channels = 1;
        for i in 0..RACK_BLOCK {
            p.data[0][i] = f(at + i);
        }
    }

    fn sine_1k(i: usize) -> f32 {
        (std::f32::consts::TAU * 1000.0 * i as f32 / SR).sin()
    }

    #[test]
    fn scope_writes_min_max_entries() {
        // decim 1: 2 ms/div -> a 960-frame window.
        let mut r = Rig::new();
        r.set("time", 2.0);
        let a = |i: usize| (i as f32 * 0.37).sin();
        let b = |i: usize| (i as f32 * 0.11).cos() * 0.5;
        r.run(320, |ins, at| {
            mono(&mut ins[0], at, a);
            mono(&mut ins[1], at, b);
        }, |_, _| {});
        let h = r.hdr();
        assert_eq!(h[HDR_DECIM], 1);
        assert_eq!((h[HDR_OWNER_TRACK], h[HDR_OWNER_MODULE]), (3, 7), "the claim's stamp");
        assert_eq!(h[HDR_HEAD].wrapping_sub(h[HDR_EPOCH]), 320);
        for k in 0..320 {
            let e = r.entry(h[HDR_EPOCH].wrapping_add(k as i32));
            assert_eq!(e, [a(k), a(k), b(k), b(k)], "entry {k}");
        }

        // A 1 kHz sine at decim 12 (24 ms/div -> 11520 frames): entries are
        // the brute-force min/max of each 12 frames, exactly.
        let mut r = Rig::new();
        r.set("time", 24.0);
        r.run(12 * 32 * 10, |ins, at| mono(&mut ins[0], at, sine_1k), |_, _| {});
        let h = r.hdr();
        assert_eq!(h[HDR_DECIM], 12);
        let n = h[HDR_HEAD].wrapping_sub(h[HDR_EPOCH]);
        assert_eq!(n, 320);
        for k in 0..n as usize {
            let frames: Vec<f32> = (k * 12..k * 12 + 12).map(sine_1k).collect();
            let lo = frames.iter().copied().fold(f32::INFINITY, f32::min);
            let hi = frames.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            assert_eq!(r.entry(h[HDR_EPOCH].wrapping_add(k as i32)), [lo, hi, 0.0, 0.0], "entry {k}");
        }
    }

    #[test]
    fn scope_decimation_follows_time() {
        let mut r = Rig::new();
        // Free: 5 ms/div -> 10 divisions = 2400 frames -> decim 3.
        r.idle(640);
        assert_eq!(r.hdr()[HDR_DECIM], 3);
        let check = |r: &mut Rig, want: i32| {
            let before = r.hdr()[HDR_HEAD];
            r.idle(RACK_BLOCK);
            let h = r.hdr();
            assert_eq!(h[HDR_DECIM], want);
            assert_eq!(h[HDR_EPOCH], before, "a decim change moves the epoch to the head");
        };
        // 100 ms/div -> 48000 frames -> 47.
        r.set("time", 100.0);
        check(&mut r, 47);
        r.idle(48000);
        // Sync, 1 bar at 120 BPM -> 96000 frames -> 94.
        r.set("sync", 1.0);
        r.set("division", 5.0);
        check(&mut r, 94);
        assert_ne!(r.hdr()[HDR_FLAGS] & FLAG_SYNC, 0);
        r.idle(96000);
        // Back to Free 5 ms: 3 again, a fresh epoch.
        r.set("sync", 0.0);
        r.set("time", 5.0);
        check(&mut r, 3);
        // The same decim again: the epoch stays.
        let e = r.hdr()[HDR_EPOCH];
        r.set("time", 5.1); // 2448 frames -> still 3
        r.idle(RACK_BLOCK * 4);
        assert_eq!((r.hdr()[HDR_DECIM], r.hdr()[HDR_EPOCH]), (3, e));
    }

    #[test]
    fn scope_sums_poly() {
        let mut r = Rig::new();
        r.set("time", 2.0);
        r.run(64, |ins, _| {
            let p = &mut ins[0];
            p.channels = 3;
            for (ch, v) in [0.1f32, 0.2, 0.3].into_iter().enumerate() {
                p.data[ch] = [v; RACK_BLOCK];
            }
        }, |_, _| {});
        let h = r.hdr();
        let e = r.entry(h[HDR_HEAD].wrapping_sub(1));
        assert!((e[0] - 0.6).abs() < 1e-6 && (e[1] - 0.6).abs() < 1e-6, "{e:?}");
        assert_eq!(e[0], 0.1f32 + 0.2 + 0.3, "summed unnormalised, like Out");
    }

    #[test]
    fn scope_grid_marks_one_division() {
        // Sync 1/4 at 120 BPM: a beat is 24000 frames -> decim 24, 1000 entries.
        let mut r = Rig::new();
        r.set("sync", 1.0);
        r.set("division", 3.0);
        r.playing = true;
        let mut first_valid = None;
        r.run(4 * 24000, |_, _| {}, |h, frame| {
            if first_valid.is_none() && h[HDR_FLAGS] & FLAG_GRID != 0 {
                first_valid = Some(frame);
            }
        });
        let h = r.hdr();
        assert_eq!(h[HDR_DECIM], 24);
        assert_ne!(h[HDR_FLAGS] & FLAG_GRID, 0, "valid while playing");
        assert_eq!(first_valid, Some(24000 + RACK_BLOCK), "valid once the lines at 0 and 24000 have passed");
        let span = h[HDR_GRID_LAST].wrapping_sub(h[HDR_GRID_PREV]);
        assert!((span - 1000).abs() <= 1, "one division: {span} entries");
        // Exact to the entry: the beats at frames 48000 and 72000 are in
        // entries epoch + 2000 and epoch + 3000 (decim 24 from frame 0).
        assert_eq!(h[HDR_GRID_PREV], h[HDR_EPOCH].wrapping_add(2000));
        assert_eq!(h[HDR_GRID_LAST], h[HDR_EPOCH].wrapping_add(3000));

        // Stop clears it.
        r.playing = false;
        r.idle(RACK_BLOCK);
        assert_eq!(r.hdr()[HDR_FLAGS] & FLAG_GRID, 0, "stopped");

        // Play again from a seek (mid-beat): invalid until two new lines.
        r.playing = true;
        r.offset = 123.0;
        r.idle(RACK_BLOCK);
        assert_eq!(r.hdr()[HDR_FLAGS] & FLAG_GRID, 0);
        let mut lines = Vec::new();
        let mut last = r.hdr()[HDR_GRID_LAST];
        r.run(2 * 24000 + 2000, |_, _| {}, |h, frame| {
            if h[HDR_GRID_LAST] != last {
                last = h[HDR_GRID_LAST];
                lines.push((frame, h[HDR_FLAGS] & FLAG_GRID != 0));
            }
        });
        assert!(lines.len() >= 2, "{lines:?}");
        assert!(!lines[0].1 && lines[1].1, "the first new line alone is not enough: {lines:?}");
        assert_ne!(r.hdr()[HDR_FLAGS] & FLAG_GRID, 0);

        // A ticks jump while playing (loop wrap) clears it too.
        r.offset -= 960.0 * 8.0;
        r.idle(RACK_BLOCK);
        assert_eq!(r.hdr()[HDR_FLAGS] & FLAG_GRID, 0, "jump");
    }

    #[test]
    fn scope_unconnected_b_clears_its_flag() {
        let mut r = Rig::new();
        r.set("time", 2.0);
        r.run(64, |ins, at| {
            mono(&mut ins[0], at, |_| 0.25);
            mono(&mut ins[1], at, |_| -0.5);
        }, |_, _| {});
        let h = r.hdr();
        assert_ne!(h[HDR_FLAGS] & FLAG_B, 0);
        assert_eq!(r.entry(h[HDR_HEAD].wrapping_sub(1)), [0.25, 0.25, -0.5, -0.5]);
        r.ins[1].channels = 0;
        r.idle(64);
        let h = r.hdr();
        assert_eq!(h[HDR_FLAGS] & FLAG_B, 0, "B unconnected");
        assert_eq!(r.entry(h[HDR_HEAD].wrapping_sub(1)), [0.25, 0.25, 0.0, 0.0], "B writes 0");
        // A unconnected writes 0 as well.
        r.ins[0].channels = 0;
        r.idle(64);
        assert_eq!(r.entry(r.hdr()[HDR_HEAD].wrapping_sub(1)), [0.0; 4]);
    }

    #[test]
    fn scope_head_wraps_and_survives_a_reset() {
        let mut r = Rig::new();
        r.set("time", 2.0);
        // Near the i32 wrap: entries keep their ring positions.
        if let Some((_, h)) = r.fx.scope(r.slot) {
            h[HDR_HEAD] = i32::MAX - 10;
        }
        r.run(64, |ins, at| mono(&mut ins[0], at, |i| i as f32), |_, _| {});
        let h = r.hdr();
        assert_eq!(h[HDR_EPOCH], i32::MAX - 10);
        assert_eq!(h[HDR_HEAD], (i32::MAX - 10).wrapping_add(64));
        for k in 0..64 {
            assert_eq!(r.entry(h[HDR_EPOCH].wrapping_add(k))[0], k as f32);
        }
        // A reset re-zeroes the ring at once and starts a new epoch at the
        // head, which keeps counting.
        r.m.reset();
        r.idle(RACK_BLOCK);
        let h2 = r.hdr();
        assert_eq!(h2[HDR_EPOCH], h[HDR_HEAD]);
        assert_eq!(h2[HDR_HEAD], h[HDR_HEAD].wrapping_add(RACK_BLOCK as i32));
        assert_eq!(r.entry(h[HDR_EPOCH])[0], 0.0, "old entries zeroed");
    }
}
