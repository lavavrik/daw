//! Automation lanes (plan 10; spec addendum §3.4).
//!
//! # Storage
//! [`Automation`] owns `MAX_AUTO_LANES` (64) [`Lane`]s, each with
//! `MAX_AUTO_POINTS` (512) breakpoint slots, all allocated in
//! [`Automation::new`] (in `Engine::new`; about 0.5 MB). A point is
//! addressed as `lane * MAX_AUTO_POINTS + idx`, like note slots: there is no
//! shared pool and nothing is ever compacted or moved. Each lane keeps the
//! indices of its active points in `order`, sorted by tick with an insertion
//! sort in the command phase (at most 512 entries, no allocation). Ticks are
//! unique within a lane: an instant change is a hold point followed by the
//! next point.
//!
//! # Targets
//! A lane targets one continuous mixer param ([`Target::Mix`]: a channel and
//! a catalog id) or one continuous rack param ([`Target::Rack`]: a synth
//! slot, a module index and a param index). Integer, choice and flag params
//! are never automatable. The engine validates that the target exists
//! (`engine.rs`) and refuses a second lane on the same target.
//!
//! # Evaluation
//! [`Lane::value_at`] (and the app's `laneValueAt`, pinned by
//! `tests/fixtures/auto_eval.json`):
//! * before the first point the lane holds the first point's value, after
//!   the last point the last point's value;
//! * a *hold* point keeps its value up to the next point;
//! * a *linear* point interpolates to the next point in **knob space**
//!   ([`Shape`]): plain linear interpolation of the values for a `lin`
//!   param, linear in the knob position for an `exp` one (logarithmic in
//!   the value; an exp param whose minimum is 0 uses the knob's zero zone,
//!   `ZERO_ZONE` / `EXP_FLOOR_RATIO`, exactly as `app/src/ui/rack/knobMath.ts`),
//!   and linear in the fader position for a `fader` one (the fader and the
//!   sends, plan 19: `mixer::catalog::FADER_LAW`, piecewise linear in dB);
//! * its **curve** (plan 16, `AUTO_POINT_CURVE`, −1..1, 0 linear) bends that
//!   segment: at fraction `x` of the way it is `f(x) = x^(2^(−3·curve))` of
//!   the way in the same knob space (curve 1: `x^(1/8)`, fast then slow;
//!   −1: `x^8`, slow then fast). A hold point, and the last point (no
//!   segment after it), ignore their curve. `AUTO_POINT_SET` resets the
//!   point's curve to 0, so a replay sends SET, then CURVE.
//!
//! Each lane keeps a segment cursor (the number of points at or before the
//! last evaluated tick), so steady playback costs O(1) per lane per value;
//! after a jump the cursor re-seeks with a binary search.
//!
//! # The per-block frame
//! [`Automation::frame`] evaluates every applying lane at each 32-frame
//! sub-block start of the block (`RACK_BLOCK`) and at the block end, in song
//! time, across the loop-wrap pieces of the block (the same [`Piece`]s the
//! engine renders, so a wrap re-seeks lanes and audio clips in one place).
//! Each value is flagged:
//! * **line** for sub-block `k` when the lane follows a continuous stretch
//!   from `f_k` to `f_k+1`: the mixer then ramps its gains linearly from
//!   value `k` to value `k + 1` over the sub-block;
//! * otherwise a **step**: a lane starting to apply, a jump of song time
//!   (Play, Stop, seek, loop wrap, mode switch), the end of a hold segment,
//!   or an edit of the lane's points since the last block. The target then
//!   moves with its normal smoothing (5 ms gain ramps, the DSP's glides, the
//!   rack's one-pole for `smooth` params).
//!
//! # When a lane applies
//! In Song mode, playing or stopped (then at the parked position), when it
//! has a target and points and is enabled and not suspended
//! ([`Lane::applies`]). Otherwise its target plays its **base value**: the
//! last value set by hand (`MIX_SET` / `RACK_SET_PARAM` store it here while
//! the lane drives the param). The engine re-applies the base, with the
//! normal smoothing, when a lane that drove its target stops applying
//! ([`Automation::stopped`]).
//!
//! # Override
//! `AUTO_OVERRIDE` suspends a lane until the playhead reaches the lane's
//! next breakpoint after the current tick (checked at sub-block starts), or
//! until a jump ([`Automation::jump`]: Play, Stop, a seek, a loop wrap, a
//! mode switch). While stopped it lasts until the next Play or seek.
//!
//! Everything here is fixed-size: commands and `frame` never allocate,
//! block or panic.

use crate::mixer::catalog::{self as mixcat, Curve, FADER_LAW};
use crate::protocol::ERR_BAD_VALUE;
use crate::rack::catalog::{spec, Curve as RackCurve, ModuleKind};
use crate::transport::Piece;
use crate::{MAX_AUTO_LANES, MAX_AUTO_POINTS, MAX_BLOCK, RACK_BLOCK};

/// Values per block in an [`AutoEntry`]: one per sub-block start, plus the
/// block end.
pub const MAX_SUB: usize = MAX_BLOCK / RACK_BLOCK + 1;
const _: () = assert!(MAX_SUB <= 64, "sub-block flags are u64 bitmasks");
const _: () = assert!(MAX_AUTO_POINTS <= u16::MAX as usize, "order holds u16 indices");

/// Exp params whose minimum is 0 (MIDI In glide): the bottom 2 % of knob
/// travel is exactly 0, the rest logarithmic from `max / EXP_FLOOR_RATIO`
/// (mirrors `app/src/ui/rack/knobMath.ts`).
pub const ZERO_ZONE: f64 = 0.02;
pub const EXP_FLOOR_RATIO: f64 = 1000.0;

/// What a lane drives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    None,
    /// Mixer channel `ch` (0..`MIX_CHANNELS`), catalog param `id`.
    Mix { ch: u8, id: u8 },
    /// Param `param` of module `module` of synth track `slot`'s rack.
    Rack { slot: u8, module: u8, param: u8 },
}

impl Target {
    /// Does this target belong to track slot `slot` (its strip or its rack)?
    pub fn on_slot(self, slot: usize) -> bool {
        match self {
            Target::Mix { ch, .. } => ch as usize == slot && slot < crate::MAX_TRACKS,
            Target::Rack { slot: s, .. } => s as usize == slot,
            Target::None => false,
        }
    }
}

/// One breakpoint slot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub active: bool,
    pub tick: u32,
    pub value: f32,
    /// Hold its value up to the next point (else: linear to it).
    pub hold: bool,
    /// The segment to the next point: −1..1, 0 linear (see the module docs).
    pub curve: f32,
}

impl Point {
    const OFF: Point = Point { active: false, tick: 0, value: 0.0, hold: false, curve: 0.0 };
}

/// The fraction of the way a segment of curve `c` is at fraction `x`
/// (0..1): `x^(2^(−3c))`; `x` itself for 0. The exponent is 1/8..8, always
/// positive, so `0` maps to 0 and `1` to 1, never NaN.
fn bend(x: f64, c: f32) -> f64 {
    if c == 0.0 {
        x
    } else {
        x.powf((-3.0 * c as f64).exp2())
    }
}

/// A param's knob space: its range and curve (catalog `curve`; a rack
/// param's `lin` / `exp` map to the same [`Curve`]s).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shape {
    pub min: f32,
    pub max: f32,
    pub curve: Curve,
}

/// dB -> fader position 0..1 by [`FADER_LAW`] (at or below its bottom: 0).
fn fader_pos(db: f64) -> f64 {
    let (lo, _) = FADER_LAW[0];
    if db <= lo as f64 {
        return 0.0;
    }
    for w in FADER_LAW.windows(2) {
        let ((d0, p0), (d1, p1)) = (w[0], w[1]);
        let (d0, p0, d1, p1) = (d0 as f64, p0 as f64, d1 as f64, p1 as f64);
        if db <= d1 {
            return p0 + (db - d0) / (d1 - d0) * (p1 - p0);
        }
    }
    1.0
}

/// Fader position 0..1 -> dB, the inverse of [`fader_pos`] (continuous: no
/// 0.1 dB snapping, unlike the on-screen fader's drag).
fn fader_db(pos: f64) -> f64 {
    for w in FADER_LAW.windows(2) {
        let ((d0, p0), (d1, p1)) = (w[0], w[1]);
        let (d0, p0, d1, p1) = (d0 as f64, p0 as f64, d1 as f64, p1 as f64);
        if pos <= p1 {
            return d0 + (pos - p0) / (p1 - p0) * (d1 - d0);
        }
    }
    FADER_LAW[FADER_LAW.len() - 1].0 as f64
}

impl Shape {
    const NONE: Shape = Shape { min: 0.0, max: 0.0, curve: Curve::Lin };

    /// Mixer param `id`'s shape, if it is automatable on channel `ch`.
    pub fn mix(ch: usize, id: u32) -> Option<Shape> {
        let p = mixcat::param(id)?;
        (p.accepts(ch) && !p.integer).then_some(Shape { min: p.min, max: p.max, curve: p.curve })
    }

    /// Param `param` of a `kind` module, if it is automatable: not an
    /// integer (choice) param, and not a Scope's (plan 12: they only change
    /// what it draws).
    pub fn rack(kind: ModuleKind, param: usize) -> Option<Shape> {
        let p = spec(kind).params.get(param)?;
        let curve = match p.curve {
            RackCurve::Lin => Curve::Lin,
            RackCurve::Exp => Curve::Exp,
        };
        (!p.integer && kind != ModuleKind::Scope).then_some(Shape { min: p.min, max: p.max, curve })
    }

    /// Is `v` in the range?
    pub fn contains(&self, v: f32) -> bool {
        v >= self.min && v <= self.max
    }

    fn zero_based(&self) -> bool {
        self.curve == Curve::Exp && self.min <= 0.0
    }

    /// Value -> knob position 0..1 (clamped).
    // `!(max > min)` is deliberate: unlike `max <= min` it also rejects a NaN bound.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    pub fn pos(&self, v: f64) -> f64 {
        let (min, max) = (self.min as f64, self.max as f64);
        if !(max > min) || v.is_nan() {
            return 0.0;
        }
        let p = if self.curve == Curve::Lin {
            (v - min) / (max - min)
        } else if self.curve == Curve::Fader {
            // The law is absolute dB; the range only clamps.
            if v <= min {
                0.0
            } else {
                fader_pos(v.min(max))
            }
        } else if self.zero_based() {
            let floor = max / EXP_FLOOR_RATIO;
            if v <= 0.0 {
                0.0
            } else if v <= floor {
                ZERO_ZONE
            } else {
                ZERO_ZONE + (1.0 - ZERO_ZONE) * ((v / floor).ln() / (max / floor).ln())
            }
        } else if v <= min {
            0.0
        } else {
            (v / min).ln() / (max / min).ln()
        };
        p.clamp(0.0, 1.0)
    }

    /// Knob position -> value, clamped to the range.
    pub fn value(&self, pos: f64) -> f64 {
        let (min, max) = (self.min as f64, self.max as f64);
        let p = if pos.is_nan() { 0.0 } else { pos.clamp(0.0, 1.0) };
        let v = if self.curve == Curve::Lin {
            min + p * (max - min)
        } else if self.curve == Curve::Fader {
            fader_db(p)
        } else if self.zero_based() {
            if p < ZERO_ZONE {
                0.0
            } else {
                let floor = max / EXP_FLOOR_RATIO;
                floor * (max / floor).powf((p - ZERO_ZONE) / (1.0 - ZERO_ZONE))
            }
        } else {
            min * (max / min).powf(p)
        };
        v.clamp(min, max)
    }

    /// From `a` to `b` at fraction `f` (0..1) in knob space.
    fn lerp(&self, a: f32, b: f32, f: f64) -> f64 {
        let (a, b) = (a as f64, b as f64);
        if self.curve != Curve::Lin {
            let (pa, pb) = (self.pos(a), self.pos(b));
            self.value(pa + (pb - pa) * f)
        } else {
            a + (b - a) * f
        }
    }
}

/// One automation lane (see the module docs).
pub struct Lane {
    target: Target,
    shape: Shape,
    points: [Point; MAX_AUTO_POINTS],
    /// `order[..count]`: indices of the active points, sorted by tick.
    order: [u16; MAX_AUTO_POINTS],
    count: usize,
    /// Points at or before the last evaluated tick (an index into `order`).
    cursor: usize,
    /// The target's value set by hand: plays whenever the lane does not.
    base: f32,
    enabled: bool,
    /// Suspended by `AUTO_OVERRIDE` until this song tick (`f64::INFINITY`:
    /// until the next jump).
    suspended_until: Option<f64>,
    /// Drove its target at the end of the last block.
    applied: bool,
    /// Points, target or state changed since the last block, or the last
    /// block ended on a step (a hold end or a wrap exactly at its end, which
    /// that block only used as a ramp target): its next value is a step.
    dirty: bool,
}

impl Default for Lane {
    fn default() -> Self {
        Self::new()
    }
}

impl Lane {
    pub fn new() -> Lane {
        Lane {
            target: Target::None,
            shape: Shape::NONE,
            points: [Point::OFF; MAX_AUTO_POINTS],
            order: [0; MAX_AUTO_POINTS],
            count: 0,
            cursor: 0,
            base: 0.0,
            enabled: true,
            suspended_until: None,
            applied: false,
            dirty: true,
        }
    }

    pub fn target(&self) -> Target {
        self.target
    }

    /// Active points.
    pub fn count(&self) -> usize {
        self.count
    }

    pub fn base(&self) -> f32 {
        self.base
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Suspended by an override.
    pub fn suspended(&self) -> bool {
        self.suspended_until.is_some()
    }

    /// Drove its target at the end of the last block.
    pub fn applied(&self) -> bool {
        self.applied
    }

    /// Has a target and points and is enabled (it applies in Song mode
    /// unless suspended).
    fn ready(&self) -> bool {
        self.target != Target::None && self.count > 0 && self.enabled
    }

    /// Does the lane drive its target now (`song`: Song mode)?
    pub fn applies(&self, song: bool) -> bool {
        song && self.ready() && self.suspended_until.is_none()
    }

    /// The knob space values are interpolated in (tests; the engine sets it
    /// with the target).
    #[cfg(test)]
    pub(crate) fn set_shape(&mut self, shape: Shape) {
        self.shape = shape;
    }

    fn tick_of(&self, j: usize) -> u32 {
        let i = self.order.get(j).copied().unwrap_or(0) as usize;
        self.points.get(i).map_or(0, |p| p.tick)
    }

    fn point_at(&self, j: usize) -> Point {
        let i = self.order.get(j).copied().unwrap_or(0) as usize;
        self.points.get(i).copied().unwrap_or(Point::OFF)
    }

    /// First position in `order` whose tick is greater than `t`.
    fn upper_bound(&self, t: f64) -> usize {
        let (mut lo, mut hi) = (0, self.count);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.tick_of(mid) as f64 > t {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        lo
    }

    /// First position in `order` whose tick is at least `tick`.
    fn lower_bound(&self, tick: u32) -> usize {
        let (mut lo, mut hi) = (0, self.count);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.tick_of(mid) >= tick {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        lo
    }

    /// Take point `idx` out of `order` (it must be active).
    fn unlink(&mut self, idx: usize) {
        let tick = self.points.get(idx).map_or(0, |p| p.tick);
        let mut j = self.lower_bound(tick);
        if self.order.get(j).copied() != Some(idx as u16) {
            // Unreachable (ticks are unique); stay total.
            j = (0..self.count).find(|&j| self.order[j] as usize == idx).unwrap_or(self.count);
        }
        if j < self.count {
            self.order.copy_within(j + 1..self.count, j);
            self.count -= 1;
        }
    }

    /// Store point `idx` (validated against the shape; a tick another point
    /// of the lane uses is `ERR_BAD_VALUE`), keeping `order` sorted.
    pub fn set_point(&mut self, idx: usize, tick: u32, value: f32, hold: bool) -> Result<(), i32> {
        if idx >= MAX_AUTO_POINTS || !self.shape.contains(value) {
            return Err(ERR_BAD_VALUE);
        }
        let j = self.lower_bound(tick);
        if j < self.count && self.tick_of(j) == tick && self.order[j] as usize != idx {
            return Err(ERR_BAD_VALUE);
        }
        if self.points[idx].active {
            self.unlink(idx);
        }
        let pos = self.upper_bound(tick as f64);
        if self.count < MAX_AUTO_POINTS && pos <= self.count {
            self.order.copy_within(pos..self.count, pos + 1);
            self.order[pos] = idx as u16;
            self.count += 1;
        }
        self.points[idx] = Point { active: true, tick, value, hold, curve: 0.0 };
        self.dirty = true;
        Ok(())
    }

    /// Set the curve of the segment starting at point `idx` (−1..1). An
    /// inactive point or a curve out of range is `ERR_BAD_VALUE`.
    pub fn set_curve(&mut self, idx: usize, curve: f32) -> Result<(), i32> {
        let Some(p) = self.points.get_mut(idx).filter(|p| p.active) else { return Err(ERR_BAD_VALUE) };
        if !(-1.0..=1.0).contains(&curve) {
            return Err(ERR_BAD_VALUE);
        }
        if p.curve != curve {
            p.curve = curve;
            self.dirty = true;
        }
        Ok(())
    }

    /// Remove point `idx` (a no-op if it is not active).
    pub fn remove_point(&mut self, idx: usize) {
        if self.points.get(idx).is_some_and(|p| p.active) {
            self.unlink(idx);
            self.points[idx] = Point::OFF;
            self.dirty = true;
        }
    }

    /// Points at or before `t`, from the cursor when it (or its successor)
    /// is still right (steady playback), else by binary search.
    fn seek(&mut self, t: f64) -> usize {
        let n = self.count;
        let fits = |l: &Lane, c: usize| (c == 0 || l.tick_of(c - 1) as f64 <= t) && (c == n || l.tick_of(c) as f64 > t);
        let c = self.cursor.min(n);
        let c = if fits(self, c) {
            c
        } else if c < n && fits(self, c + 1) {
            c + 1
        } else {
            self.upper_bound(t)
        };
        self.cursor = c;
        c
    }

    /// The value at `t` given `c` = points at or before `t` (`count > 0`).
    fn eval(&self, t: f64, c: usize) -> f32 {
        let n = self.count;
        let v = if c == 0 {
            self.point_at(0).value as f64
        } else if c >= n {
            self.point_at(n - 1).value as f64
        } else {
            let (a, b) = (self.point_at(c - 1), self.point_at(c));
            if a.hold {
                a.value as f64
            } else {
                let span = b.tick as f64 - a.tick as f64;
                let f = if span > 0.0 { ((t - a.tick as f64) / span).clamp(0.0, 1.0) } else { 1.0 };
                self.shape.lerp(a.value, b.value, bend(f, a.curve))
            }
        };
        (v as f32).clamp(self.shape.min, self.shape.max)
    }

    /// The lane's value at song tick `t` (`None` without points).
    pub fn value_at(&mut self, t: f64) -> Option<f32> {
        if self.count == 0 {
            return None;
        }
        let c = self.seek(t);
        Some(self.eval(t, c))
    }

    /// Back to a new lane: no target, no points, enabled.
    fn clear(&mut self) {
        self.target = Target::None;
        self.shape = Shape::NONE;
        self.points = [Point::OFF; MAX_AUTO_POINTS];
        self.count = 0;
        self.cursor = 0;
        self.base = 0.0;
        self.enabled = true;
        self.suspended_until = None;
        self.applied = false;
        self.dirty = true;
    }
}

/// One applying lane's values for a block (see the module docs).
#[derive(Clone, Copy, Debug)]
pub struct AutoEntry {
    pub target: Target,
    values: [f32; MAX_SUB],
    /// Bit `k`: the lane applies at sub-block start `k` (bit `subs`: the
    /// block end).
    apply: u64,
    /// Bit `k`: sub-block `k` follows a line from value `k` to `k + 1`.
    line: u64,
}

impl AutoEntry {
    const OFF: AutoEntry = AutoEntry { target: Target::None, values: [0.0; MAX_SUB], apply: 0, line: 0 };

    /// Does the lane drive its target at sub-block `k`?
    pub fn applies(&self, k: usize) -> bool {
        k < MAX_SUB && self.apply >> k & 1 != 0
    }

    /// Does sub-block `k` ramp linearly to value `k + 1`?
    pub fn line(&self, k: usize) -> bool {
        k < MAX_SUB && self.line >> k & 1 != 0
    }

    /// The value at sub-block start `k` (`k = subs`: the block end).
    pub fn value(&self, k: usize) -> f32 {
        self.values.get(k).copied().unwrap_or(0.0)
    }
}

/// Every applying lane's values for one block.
pub struct AutoFrame {
    entries: Vec<AutoEntry>,
    len: usize,
    /// Sub-blocks in the block (`ceil(n / RACK_BLOCK)`).
    subs: usize,
    mix: bool,
    /// Bit = a synth slot with a rack entry.
    rack: u32,
}

impl Default for AutoFrame {
    fn default() -> Self {
        Self::new()
    }
}

impl AutoFrame {
    /// An empty frame (allocates: build it once).
    pub fn new() -> AutoFrame {
        AutoFrame { entries: vec![AutoEntry::OFF; MAX_AUTO_LANES], len: 0, subs: 0, mix: false, rack: 0 }
    }

    pub fn entries(&self) -> &[AutoEntry] {
        self.entries.get(..self.len).unwrap_or(&[])
    }

    /// Sub-blocks in the block.
    pub fn subs(&self) -> usize {
        self.subs
    }

    /// Any mixer entry (the mixer then runs in sub-block chunks).
    pub fn has_mix(&self) -> bool {
        self.mix
    }

    /// Any rack entry for synth slot `slot`.
    pub fn has_rack(&self, slot: usize) -> bool {
        slot < 32 && self.rack >> slot & 1 != 0
    }
}

/// Every lane and the current block's frame (see the module docs).
pub struct Automation {
    lanes: Vec<Lane>,
    frame: AutoFrame,
    /// A jump of song time since the last block (its first value is a step).
    jumped: bool,
    /// The song tick at the end of the last block (NaN: none).
    last_end: f64,
}

impl Default for Automation {
    fn default() -> Self {
        Self::new()
    }
}

impl Automation {
    /// All `MAX_AUTO_LANES` lanes and the frame (the only allocating call).
    pub fn new() -> Automation {
        Automation {
            lanes: (0..MAX_AUTO_LANES).map(|_| Lane::new()).collect(),
            frame: AutoFrame::new(),
            jumped: true,
            last_end: f64::NAN,
        }
    }

    pub fn lane(&self, i: usize) -> Option<&Lane> {
        self.lanes.get(i)
    }

    /// The lane driving `target`, if any.
    pub fn find(&self, target: Target) -> Option<usize> {
        if target == Target::None {
            return None;
        }
        self.lanes.iter().position(|l| l.target == target)
    }

    /// Can lane `i` take `target` (no other lane has it, and its points fit
    /// `shape`)? `ERR_BAD_VALUE` otherwise.
    pub fn check_target(&self, i: usize, target: Target, shape: Shape) -> Result<(), i32> {
        let Some(lane) = self.lanes.get(i) else { return Err(ERR_BAD_VALUE) };
        if target == Target::None || lane.target == target {
            return Ok(());
        }
        if self.lanes.iter().enumerate().any(|(j, l)| j != i && l.target == target) {
            return Err(ERR_BAD_VALUE);
        }
        let fits = lane.points.iter().all(|p| !p.active || shape.contains(p.value));
        if fits {
            Ok(())
        } else {
            Err(ERR_BAD_VALUE)
        }
    }

    /// Point lane `i` at `target` with knob space `shape`, its current value
    /// `base` (call `check_target` and `release` first). The same target
    /// again is a no-op.
    pub fn set_target(&mut self, i: usize, target: Target, shape: Shape, base: f32) {
        let Some(lane) = self.lanes.get_mut(i) else { return };
        if lane.target == target {
            return;
        }
        lane.target = target;
        lane.shape = if target == Target::None { Shape::NONE } else { shape };
        lane.base = base;
        lane.applied = false;
        lane.suspended_until = None;
        lane.dirty = true;
    }

    /// Store point `idx` of lane `i` (`ERR_BAD_VALUE` without a target, out
    /// of range, or on a tick another point uses).
    pub fn set_point(&mut self, i: usize, idx: usize, tick: u32, value: f32, hold: bool) -> Result<(), i32> {
        let Some(lane) = self.lanes.get_mut(i) else { return Err(ERR_BAD_VALUE) };
        if lane.target == Target::None {
            return Err(ERR_BAD_VALUE);
        }
        lane.set_point(idx, tick, value, hold)
    }

    pub fn remove_point(&mut self, i: usize, idx: usize) {
        if let Some(lane) = self.lanes.get_mut(i) {
            lane.remove_point(idx);
        }
    }

    /// `AUTO_POINT_CURVE` on point `idx` of lane `i` (`ERR_BAD_VALUE` for an
    /// inactive point, which a lane without a target never has).
    pub fn set_curve(&mut self, i: usize, idx: usize, curve: f32) -> Result<(), i32> {
        self.lanes.get_mut(i).ok_or(ERR_BAD_VALUE)?.set_curve(idx, curve)
    }

    pub fn set_enabled(&mut self, i: usize, on: bool) {
        if let Some(lane) = self.lanes.get_mut(i) {
            if lane.enabled != on {
                lane.enabled = on;
                lane.dirty = true;
            }
        }
    }

    /// A hand-set value of lane `i`'s target (`MIX_SET` / `RACK_SET_PARAM`).
    pub fn set_base(&mut self, i: usize, value: f32) {
        if let Some(lane) = self.lanes.get_mut(i) {
            lane.base = value;
        }
    }

    /// `AUTO_OVERRIDE`: suspend lane `i` until its next breakpoint after
    /// `now` while `playing` (until the next jump if there is none), or
    /// until the next Play / seek while stopped. A lane without points or
    /// target has nothing to suspend.
    pub fn suspend(&mut self, i: usize, now: f64, playing: bool) {
        let Some(lane) = self.lanes.get_mut(i) else { return };
        if !lane.ready() {
            return;
        }
        let until = if playing {
            let j = lane.upper_bound(now);
            if j < lane.count {
                lane.tick_of(j) as f64
            } else {
                f64::INFINITY
            }
        } else {
            f64::INFINITY
        };
        lane.suspended_until = Some(until);
    }

    /// A jump of song time (Play, Stop, seek, mode switch, a loop set behind
    /// the playhead): every suspension ends and the next values are steps.
    pub fn jump(&mut self) {
        for lane in self.lanes.iter_mut() {
            lane.suspended_until = None;
        }
        self.jumped = true;
    }

    /// If lane `i` drove its target, forget that and return the target and
    /// its base (for the engine to re-apply).
    pub fn release(&mut self, i: usize) -> Option<(Target, f32)> {
        let lane = self.lanes.get_mut(i)?;
        if !lane.applied {
            return None;
        }
        lane.applied = false;
        lane.dirty = true;
        Some((lane.target, lane.base))
    }

    /// The next lane that drove its target but no longer applies (`song`:
    /// Song mode), released as in [`release`](Automation::release).
    pub fn stopped(&mut self, song: bool) -> Option<(Target, f32)> {
        let i = self.lanes.iter().position(|l| l.applied && !l.applies(song))?;
        self.release(i)
    }

    /// `AUTO_LANE_CLEAR` (after `release`) and lifecycle clears: no target,
    /// no points. Nothing is re-applied.
    pub fn clear(&mut self, i: usize) {
        if let Some(lane) = self.lanes.get_mut(i) {
            lane.clear();
        }
    }

    /// Clear every lane whose target matches `f` (its target went away).
    pub fn clear_where(&mut self, f: impl Fn(Target) -> bool) {
        for lane in self.lanes.iter_mut() {
            if lane.target != Target::None && f(lane.target) {
                lane.clear();
            }
        }
    }

    /// Engine reset: every lane cleared.
    pub fn reset_all(&mut self) {
        for lane in self.lanes.iter_mut() {
            lane.clear();
        }
        self.frame.len = 0;
        self.jumped = true;
        self.last_end = f64::NAN;
    }

    /// The last frame built.
    pub fn frame_ref(&self) -> &AutoFrame {
        &self.frame
    }

    /// Evaluate every applying lane for a block of `n` frames rendered as
    /// `pieces` (song time; consecutive, covering `0..n`), ending at song
    /// tick `t_end`. Stopped, every value is at the parked position (the
    /// first piece's start). In Pattern mode nothing applies.
    pub fn frame(&mut self, pieces: &[Piece], t_end: f64, song: bool, playing: bool, n: usize) -> &AutoFrame {
        let n = n.min(MAX_BLOCK);
        let subs = n.div_ceil(RACK_BLOCK);
        let Automation { lanes, frame, jumped, last_end } = self;
        frame.len = 0;
        frame.subs = subs;
        frame.mix = false;
        frame.rack = 0;
        if !song {
            for lane in lanes.iter_mut() {
                lane.applied = false;
            }
            *jumped = false;
            *last_end = f64::NAN;
            return &self.frame;
        }
        // Song tick at each sub-block start (and the block end), and the
        // wraps between them (bit k: a wrap at or before f_k, after f_k-1).
        let mut ticks = [0.0f64; MAX_SUB];
        let mut wraps = 0u64;
        let parked = pieces.first().map_or(t_end, |p| p.t0);
        if !playing {
            ticks.fill(parked);
        } else {
            let mut pi = 0;
            for (k, t) in ticks.iter_mut().enumerate().take(subs + 1) {
                let f = (k * RACK_BLOCK).min(n);
                while let Some(p) = pieces.get(pi).filter(|p| p.to <= f) {
                    if p.wraps {
                        wraps |= 1 << k;
                    }
                    pi += 1;
                }
                *t = match pieces.get(pi) {
                    Some(p) if p.spt > 0.0 && p.spt.is_finite() => p.t0 + (f - p.from) as f64 / p.spt,
                    Some(p) => p.t0,
                    None => t_end,
                };
            }
        }
        let block_jump = *jumped || ticks[0] != *last_end;
        for lane in lanes.iter_mut() {
            if !lane.ready() {
                lane.applied = false;
                continue;
            }
            let Some(entry) = frame.entries.get_mut(frame.len) else { break };
            let mut values = [0.0f32; MAX_SUB];
            let (mut apply, mut disc) = (0u64, 0u64);
            let mut prev_on = lane.applied;
            for (k, &t) in ticks.iter().enumerate().take(subs + 1) {
                let wrapped = wraps >> k & 1 != 0;
                if wrapped {
                    lane.suspended_until = None; // a loop wrap ends an override
                }
                if let Some(u) = lane.suspended_until {
                    if playing && t >= u {
                        lane.suspended_until = None;
                    }
                }
                if lane.suspended_until.is_some() {
                    prev_on = false;
                    continue;
                }
                let before = lane.cursor.min(lane.count);
                let c = lane.seek(t);
                let mut step = !prev_on || wrapped || (k == 0 && (block_jump || lane.dirty));
                // The end of a hold segment between the last value and this
                // one: a crossed point (`order[before..c]`, ticks in
                // (last, t]) whose left neighbour holds.
                if !step && c > before {
                    step = (before.max(1)..c).any(|j| lane.point_at(j - 1).hold);
                }
                values[k] = lane.eval(t, c);
                apply |= 1 << k;
                if step {
                    disc |= 1 << k;
                }
                prev_on = true;
            }
            let mut line = 0u64;
            for k in 0..subs {
                let both = apply >> k & 3 == 3;
                if both && disc >> k & 3 == 0 {
                    line |= 1 << k;
                }
            }
            lane.applied = apply >> subs & 1 != 0;
            // A step at the block end is taken at the next block's start.
            lane.dirty = disc >> subs & 1 != 0;
            if apply != 0 {
                *entry = AutoEntry { target: lane.target, values, apply, line };
                frame.len += 1;
                match lane.target {
                    Target::Mix { .. } => frame.mix = true,
                    Target::Rack { slot, .. } if (slot as usize) < 32 => frame.rack |= 1 << slot,
                    _ => {}
                }
            }
        }
        *jumped = false;
        *last_end = ticks[subs];
        &self.frame
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::test_json::value;

    // ---- the fixture ------------------------------------------------------

    /// `(name, (min, max, knob curve), points (tick, value, hold, curve), query ticks)`.
    type Case = (&'static str, (f32, f32, Curve), &'static [(u32, f32, bool, f32)], &'static [f64]);

    const LIN: Curve = Curve::Lin;
    const EXP: Curve = Curve::Exp;
    const FADER: Curve = Curve::Fader;

    fn curve_name(c: Curve) -> &'static str {
        match c {
            Curve::Lin => "lin",
            Curve::Exp => "exp",
            Curve::Fader => "fader",
        }
    }

    /// The cases `auto_eval.json` was generated from (UPDATE_FIXTURE=1).
    const CASES: &[Case] = &[
        (
            "linear fader ride (dB)",
            (-60.0, 6.0, LIN),
            &[(0, -24.0, false, 0.0), (3840, 0.0, false, 0.0), (7680, -6.0, false, 0.0)],
            &[0.0, 480.0, 1920.0, 1920.5, 3839.999, 3840.0, 5000.25, 7680.0, 9000.0],
        ),
        (
            "hold steps, before the first point and after the last",
            (-60.0, 6.0, LIN),
            &[(960, -10.0, true, 0.0), (1920, -30.0, true, 0.0), (2880, 0.0, false, 0.0), (3840, 6.0, false, 0.0)],
            &[0.0, 959.9, 960.0, 1500.0, 1919.5, 1920.0, 2400.0, 2880.0, 3360.0, 3840.0, 4000.0],
        ),
        (
            "exponential mid frequency (halfway is the geometric mean)",
            (200.0, 8000.0, EXP),
            &[(0, 200.0, false, 0.0), (3840, 2000.0, false, 0.0)],
            &[0.0, 960.0, 1920.0, 2880.0, 3840.0],
        ),
        (
            "exponential cutoff with a hold",
            (20.0, 20000.0, EXP),
            &[(0, 20000.0, false, 0.0), (1920, 100.0, true, 0.0), (3840, 5000.0, false, 0.0), (5760, 20.0, false, 0.0)],
            &[0.0, 960.0, 1919.0, 1920.0, 3000.0, 3840.0, 4800.0, 5760.0, 6000.0],
        ),
        (
            "exponential from zero (the knob's zero zone)",
            (0.0, 2.0, EXP),
            &[(0, 0.0, false, 0.0), (1000, 2.0, false, 0.0), (2000, 0.001, false, 0.0)],
            &[0.0, 10.0, 15.0, 100.0, 500.0, 900.0, 1000.0, 1500.0, 1999.0, 2000.0],
        ),
        ("a single point", (0.0, 1.0, LIN), &[(1000, 0.3, false, 0.0)], &[0.0, 1000.0, 999999.0]),
        (
            "points sent out of order",
            (-1.0, 1.0, LIN),
            &[(3840, 1.0, false, 0.0), (0, -1.0, true, 0.0), (1920, 0.5, false, 0.0), (960, 0.0, false, 0.0)],
            &[0.0, 500.0, 960.0, 1440.0, 1920.0, 2880.0, 3840.0, 5000.0],
        ),
        (
            "curved segments (plan 16): rising, falling, an S of two curves",
            (-60.0, 6.0, LIN),
            &[(0, -60.0, false, 1.0), (1000, 6.0, false, -1.0), (2000, -60.0, false, 0.5), (3000, 0.0, false, -0.5), (4000, -30.0, false, 0.25)],
            &[0.0, 250.0, 500.0, 750.0, 1000.0, 1250.0, 1500.0, 1750.0, 2250.0, 2500.0, 2750.0, 3250.0, 3500.0, 3750.0, 4000.0, 5000.0],
        ),
        (
            "a curved exponential cutoff (the curve shapes the knob position)",
            (20.0, 20000.0, EXP),
            &[(0, 20.0, false, 0.75), (3840, 20000.0, false, -0.375), (7680, 200.0, false, 0.0)],
            &[0.0, 480.0, 960.0, 1920.0, 2880.0, 3840.0, 4800.0, 5760.0, 7680.0],
        ),
        (
            "curves on a hold point and on the last point are ignored",
            (0.0, 1.0, LIN),
            &[(0, 0.2, true, 1.0), (1000, 0.8, false, 0.0), (2000, 0.4, false, -1.0)],
            &[0.0, 500.0, 999.0, 1000.0, 1500.0, 2000.0, 3000.0],
        ),
        (
            "fader taper (plan 19): a volume fade from 0 dB to -inf, then up to +6 across every breakpoint",
            (-60.0, 6.0, FADER),
            &[(0, 0.0, false, 0.0), (3840, -60.0, false, 0.0), (7680, 6.0, false, 0.0)],
            &[0.0, 480.0, 960.0, 1440.0, 1920.0, 2400.0, 2880.0, 3360.0, 3839.5, 3840.0, 4000.0, 4800.0, 5760.0, 6720.0, 7600.0, 7680.0, 9000.0],
        ),
        (
            "fader taper with curves and a hold (a send build-up)",
            (-60.0, 6.0, FADER),
            &[(0, -60.0, false, 0.5), (1920, -10.0, true, 0.0), (2880, -20.0, false, -0.5), (3840, -3.5, false, 0.0), (4800, -45.0, false, 0.0)],
            &[0.0, 240.0, 480.0, 960.0, 1440.0, 1919.0, 1920.0, 2400.0, 2880.0, 3120.0, 3360.0, 3600.0, 3840.0, 4320.0, 4800.0, 6000.0],
        ),
    ];

    /// Reference evaluation, written independently of the cursor code: sort
    /// the points, find the segment by a linear scan, interpolate the knob
    /// positions.
    fn reference(points: &[(u32, f32, bool, f32)], t: f64, shape: Shape) -> f64 {
        let mut p = points.to_vec();
        p.sort_by_key(|x| x.0);
        let (first, last) = (p[0], p[p.len() - 1]);
        if t < first.0 as f64 {
            return first.1 as f64;
        }
        if t >= last.0 as f64 {
            return last.1 as f64;
        }
        let i = (0..p.len() - 1).find(|&i| p[i].0 as f64 <= t && t < p[i + 1].0 as f64).unwrap();
        let (a, b) = (p[i], p[i + 1]);
        if a.2 {
            return a.1 as f64;
        }
        let x = (t - a.0 as f64) / (b.0 as f64 - a.0 as f64);
        // The segment's curve: f(x) = x^(2^(-3 curve)), written out here.
        let f = x.powf(2f64.powf(-3.0 * a.3 as f64));
        if shape.curve != Curve::Lin {
            let (pa, pb) = (shape.pos(a.1 as f64), shape.pos(b.1 as f64));
            shape.value(pa + (pb - pa) * f)
        } else {
            a.1 as f64 + (b.1 as f64 - a.1 as f64) * f
        }
    }

    fn fixture_json() -> String {
        let mut o = String::from(
            "{\n  \"version\": 1,\n  \"about\": \"Automation lane evaluation (engine/src/automation.rs, Lane::value_at; app laneValueAt). Points are [tick, value, hold 0/1, curve (optional, default 0: f(x) = x^(2^(-3 curve)))] in the order they are sent; queries are [tick, expected value]. Compare in knob space (the param's min/max/curve) to 1e-6.\",\n  \"cases\": [",
        );
        for (i, (name, (min, max, curve), points, queries)) in CASES.iter().enumerate() {
            let shape = Shape { min: *min, max: *max, curve: *curve };
            // `[tick, value, hold]`, and the curve as a 4th element when it is not 0 (as saved).
            let pts: Vec<String> = points
                .iter()
                .map(|(t, v, h, c)| {
                    if *c == 0.0 {
                        format!("[{t}, {}, {}]", *v as f64, *h as u8)
                    } else {
                        format!("[{t}, {}, {}, {}]", *v as f64, *h as u8, *c as f64)
                    }
                })
                .collect();
            let qs: Vec<String> = queries.iter().map(|&t| format!("[{t}, {}]", reference(points, t, shape))).collect();
            o.push_str(if i == 0 { "\n    {" } else { ",\n    {" });
            o.push_str(&format!(
                "\n      \"name\": \"{name}\",\n      \"param\": {{\"min\": {}, \"max\": {}, \"curve\": \"{}\"}},\n      \"points\": [{}],\n      \"queries\": [{}]\n    }}",
                *min as f64,
                *max as f64,
                curve_name(*curve),
                pts.join(", "),
                qs.join(", ")
            ));
        }
        o.push_str("\n  ]\n}\n");
        o
    }

    #[test]
    fn scope_params_are_not_automatable() {
        // A Scope's params only change what it draws (plan 12): no lanes.
        for p in 0..spec(ModuleKind::Scope).params.len() {
            assert!(Shape::rack(ModuleKind::Scope, p).is_none(), "scope param {p}");
        }
        assert!(Shape::rack(ModuleKind::Osc, 3).is_some(), "osc fine still is");
    }

    /// `reference` shares `Shape` with the code under test, so pin the curve
    /// with numbers worked out by hand.
    #[test]
    fn exp_curves_match_hand_computed_values() {
        let at = |shape: Shape, a: f32, b: f32| {
            let mut lane = Lane::new();
            lane.set_shape(shape);
            assert_eq!(lane.set_point(0, 0, a, false), Ok(()));
            assert_eq!(lane.set_point(1, 1000, b, false), Ok(()));
            lane.value_at(500.0).unwrap() as f64
        };
        // Zero zone (min 0): the half-way knob position of 0 -> 2 is 0.058941.
        let z = at(Shape { min: 0.0, max: 2.0, curve: EXP }, 0.0, 2.0);
        assert!((z - 0.058941).abs() < 1e-5, "{z}");
        // Plain exponential: half-way from 200 to 2000 is the geometric mean, sqrt(200 * 2000).
        let e = at(Shape { min: 20.0, max: 20000.0, curve: EXP }, 200.0, 2000.0);
        assert!((e - 632.456).abs() < 1e-2, "{e}");
    }

    /// The curve's formula, worked by hand: f(x) = x^(2^(-3 curve)) on the
    /// segment's fraction, in knob space (plan 16; the app's laneValueAt
    /// test checks the same numbers).
    #[test]
    fn curves_match_the_formula() {
        let f = |x: f64, c: f64| x.powf(2f64.powf(-3.0 * c));
        // Hand values: curve 1 is x^(1/8), -1 is x^8, 0.5 is x^(1/2^1.5), -0.5 is x^(2^1.5).
        assert!((f(0.5, 1.0) - 0.917004).abs() < 1e-6);
        assert!((f(0.5, -1.0) - 0.00390625).abs() < 1e-9);
        let lin = Shape { min: 0.0, max: 1.0, curve: LIN };
        let exp = Shape { min: 20.0, max: 20000.0, curve: EXP };
        for c in [-1.0f32, -0.5, 0.5, 1.0] {
            for (shape, a, b) in [(lin, 0.0f32, 1.0f32), (lin, 1.0, 0.0), (exp, 20.0, 20000.0), (exp, 20000.0, 20.0)] {
                let mut lane = Lane::new();
                lane.set_shape(shape);
                assert_eq!(lane.set_point(0, 0, a, false), Ok(()));
                assert_eq!(lane.set_point(1, 1000, b, false), Ok(()));
                assert_eq!(lane.set_curve(0, c), Ok(()));
                for x in [0.25, 0.5, 0.75] {
                    let got = shape.pos(lane.value_at(1000.0 * x).unwrap() as f64);
                    let (pa, pb) = (shape.pos(a as f64), shape.pos(b as f64));
                    let want = pa + (pb - pa) * f(x, c as f64);
                    assert!((got - want).abs() < 1e-5, "curve {c} {a}->{b} at {x}: pos {got}, want {want}");
                }
            }
        }
    }

    /// Plan 19: a volume lane fading 0 dB -> -inf moves like the fader, so
    /// halfway in time is halfway in fader travel (0.75 -> 0: 0.375), which
    /// the law puts between (-30 dB, 0.25) and (-20 dB, 0.38):
    /// -30 + 10 * 0.125 / 0.13 = -20.3846 dB, not the -30 dB of a linear-dB fade.
    #[test]
    fn fader_lane_midpoint() {
        for (ch, id) in [(0, mixcat::P_FADER), (crate::MIX_MASTER, mixcat::P_FADER), (3, mixcat::P_SEND_A), (3, mixcat::P_SEND_B)] {
            let shape = Shape::mix(ch, id).unwrap();
            assert_eq!(shape.curve, Curve::Fader, "{ch}/{id}");
            let mut lane = Lane::new();
            lane.set_shape(shape);
            assert_eq!(lane.set_point(0, 0, 0.0, false), Ok(()));
            assert_eq!(lane.set_point(1, 1000, -60.0, false), Ok(()));
            let mid = lane.value_at(500.0).unwrap() as f64;
            assert!((mid - (-30.0 + 10.0 * 0.125 / 0.13)).abs() < 1e-4, "{ch}/{id}: {mid}");
            assert!((mid + 20.384615).abs() < 1e-4, "{mid}");
            // The ends are the points' own values.
            assert_eq!(lane.value_at(0.0), Some(0.0));
            assert_eq!(lane.value_at(1000.0), Some(-60.0));
        }
        // Other mixer params keep their curves: pan is still linear.
        assert_eq!(Shape::mix(0, mixcat::P_PAN).unwrap().curve, Curve::Lin);
        assert_eq!(Shape::mix(0, mixcat::P_EQ_MID_FREQ).unwrap().curve, Curve::Exp);
    }

    /// Plan 19: the law both ways, worked by hand at and between its
    /// breakpoints; at or below the minimum is position 0.
    #[test]
    fn fader_shape_follows_the_law() {
        let s = Shape { min: -60.0, max: 6.0, curve: Curve::Fader };
        for (db, pos) in mixcat::FADER_LAW {
            assert!((s.pos(db as f64) - pos as f64).abs() < 1e-7, "{db}");
            assert!((s.value(pos as f64) - db as f64).abs() < 1e-5, "{pos}");
        }
        assert!((s.pos(-50.0) - 0.07).abs() < 1e-7);
        assert!((s.pos(-3.0) - 0.69).abs() < 1e-7);
        assert!((s.value(0.875) - 3.0).abs() < 1e-5);
        assert_eq!(s.pos(-60.0), 0.0);
        assert_eq!(s.pos(-100.0), 0.0);
        assert_eq!(s.pos(f64::NEG_INFINITY), 0.0);
        assert_eq!(s.pos(f64::NAN), 0.0);
        assert_eq!(s.pos(99.0), 1.0);
        assert_eq!(s.value(-1.0), -60.0);
        assert_eq!(s.value(2.0), 6.0);
        // Continuous: no 0.1 dB snapping.
        let v = s.value(0.5);
        assert!((v - (-20.0 + 10.0 * 0.12 / 0.17)).abs() < 1e-5, "{v}");
    }

    /// Plan 19: a segment's curve bends it in fader space: at fraction `x` of
    /// the way it is `f(x)` of the fader travel, not of the dB range.
    #[test]
    fn fader_curve_segment() {
        let shape = Shape::mix(0, mixcat::P_SEND_A).unwrap();
        let mut lane = Lane::new();
        lane.set_shape(shape);
        assert_eq!(lane.set_point(0, 0, -60.0, false), Ok(()));
        assert_eq!(lane.set_point(1, 1000, 6.0, false), Ok(()));
        assert_eq!(lane.set_curve(0, 0.5), Ok(()));
        // f(0.5) = 0.5^(2^-1.5) = 0.782654: past 0 dB (0.75), so
        // 6 * (0.782654 - 0.75) / 0.25 = +0.783 dB.
        let f = 0.5f64.powf(2f64.powf(-1.5));
        assert!((f - 0.782654).abs() < 1e-6);
        let v = lane.value_at(500.0).unwrap() as f64;
        assert!((v - 6.0 * (f - 0.75) / 0.25).abs() < 1e-4, "{v}");
        for x in [0.25, 0.75] {
            let pos = shape.pos(lane.value_at(1000.0 * x).unwrap() as f64);
            assert!((pos - x.powf(2f64.powf(-1.5))).abs() < 1e-6, "{x}: {pos}");
        }
    }

    #[test]
    fn curve_edge_cases() {
        let shape = Shape { min: 0.0, max: 1.0, curve: LIN };
        let mut lane = Lane::new();
        lane.set_shape(shape);
        // A curve on an inactive point, or out of range: refused.
        assert_eq!(lane.set_curve(0, 0.5), Err(ERR_BAD_VALUE));
        assert_eq!(lane.set_point(0, 0, 0.2, true), Ok(()));
        assert_eq!(lane.set_point(1, 1000, 0.8, false), Ok(()));
        for bad in [1.01f32, -1.01, f32::NAN, f32::INFINITY] {
            assert_eq!(lane.set_curve(0, bad), Err(ERR_BAD_VALUE), "{bad}");
        }
        assert_eq!(lane.set_curve(MAX_AUTO_POINTS, 0.5), Err(ERR_BAD_VALUE));
        // On a hold point the hold wins.
        assert_eq!(lane.set_curve(0, 1.0), Ok(()));
        assert_eq!(lane.value_at(500.0), Some(0.2));
        // On the last point (no segment after it): ignored, no NaN.
        assert_eq!(lane.set_curve(1, -1.0), Ok(()));
        for t in [999.0, 1000.0, 1500.0, 1e9] {
            let v = lane.value_at(t).unwrap();
            assert!(v.is_finite(), "{t}");
            if t >= 1000.0 {
                assert_eq!(v, 0.8, "{t}");
            }
        }
        // Made linear again by AUTO_POINT_SET, which resets the point's curve
        // to 0 (so replays send SET, then CURVE): a straight line.
        assert_eq!(lane.set_point(0, 0, 0.2, false), Ok(()));
        assert!((lane.value_at(500.0).unwrap() - 0.5).abs() < 1e-6);
        assert_eq!(lane.set_curve(0, 1.0), Ok(()));
        let want = 0.2 + 0.6 * 0.5f64.powf(0.125);
        assert!((lane.value_at(500.0).unwrap() as f64 - want).abs() < 1e-6);
        // A removed point forgets its curve too.
        lane.remove_point(0);
        assert_eq!(lane.set_point(0, 0, 0.2, false), Ok(()));
        assert!((lane.value_at(500.0).unwrap() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn lane_eval_matches_fixture() {
        if std::env::var("UPDATE_FIXTURE").as_deref() == Ok("1") {
            let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/auto_eval.json");
            std::fs::write(path, fixture_json()).expect("write auto_eval.json");
        }
        let src = include_str!("../tests/fixtures/auto_eval.json");
        let doc = value(src.as_bytes(), &mut 0);
        let cases = doc.get("cases").arr();
        assert_eq!(cases.len(), CASES.len());
        for case in cases {
            let name = case.get("name").str();
            let param = case.get("param");
            let curve = [LIN, EXP, FADER].into_iter().find(|&c| curve_name(c) == param.get("curve").str()).expect("a known curve");
            let shape = Shape { min: param.get("min").num() as f32, max: param.get("max").num() as f32, curve };
            let mut lane = Lane::new();
            lane.set_shape(shape);
            for (idx, p) in case.get("points").arr().iter().enumerate() {
                let p = p.arr();
                let (t, v, h) = (p[0].num() as u32, p[1].num() as f32, p[2].num() == 1.0);
                assert_eq!(lane.set_point(idx, t, v, h), Ok(()), "{name}: point {idx}");
                if let Some(c) = p.get(3) {
                    assert_eq!(lane.set_curve(idx, c.num() as f32), Ok(()), "{name}: curve {idx}");
                }
            }
            let queries = case.get("queries").arr();
            // Forwards (the cursor walks) and backwards (it re-seeks).
            for q in queries.iter().chain(queries.iter().rev()) {
                let (t, want) = (q.arr()[0].num(), q.arr()[1].num());
                let got = lane.value_at(t).expect("a lane with points has a value") as f64;
                let (pg, pw) = (shape.pos(got), shape.pos(want));
                assert!((pg - pw).abs() <= 1e-6, "{name}: tick {t}: {got} (pos {pg}), want {want} (pos {pw})");
            }
        }
    }
}
