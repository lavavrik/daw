//! Mixer: channel strips, sends, returns, the master bus and its limiter,
//! and the meters.
//!
//! # Channels (`MIX_CHANNELS = 41`)
//! 0..31 are the track strips (one per slot), 32..39 the return slots (slot
//! 0 = Reverb, slot 1 = Delay until plan 29 task 2 makes them configurable)
//! and 40 the master. Every param lives in
//! [`catalog::PARAMS`] (ids, ranges, defaults, which channels accept it).
//!
//! # Signal flow (once per whole block, after every Song-mode piece rendered)
//! * **Track strip:** the slot's track buffer (rendered by `Drums`/`Synths`,
//!   pre-fader, never modified here) is copied into a work buffer, then
//!   EQ (if on) → compressor (if on; keyed by the key source's *raw* track
//!   buffer, a drum row's key buffer, or itself) → fader·pan → mute/solo
//!   gate → master bus. Send A (Reverb) and B (Delay) tap post-fader (after
//!   fader and pan) or, with their "pre" flag, pre-fader (after EQ and
//!   compressor). The gate applies to the sends too, so a muted (or
//!   solo-muted) track feeds no new signal into the returns; the return tails
//!   ring on.
//! * **Return:** its send bus → Reverb / Delay (100% wet) → EQ → fader·pan →
//!   mute gate → master bus. Solo never mutes a return.
//! * **Master:** bus × the legacy master gain (`SET_MASTER_GAIN`, default
//!   0.8) → EQ → fader → [`Limiter`] (lookahead 1.5 ms, release 50 ms,
//!   ceiling −0.3 dBFS by default) → output. The engine adds the metronome
//!   after this through [`ClickClip`]: only while a click plays (and 5 ms
//!   after) is the sum shaped by [`soft_clip`] (never above the ceiling);
//!   otherwise the limiter output passes bit for bit. A NaN-safe ±1 clamp is
//!   the last backstop.
//!
//! # Smoothing (no clicks)
//! * Fader, pan, sends and the legacy master gain move linearly over 5 ms
//!   ([`Ramp`]); the fader's −60 dB minimum is exactly silent (−inf).
//! * Pan is equal-power and normalised so the centre is unity (the default
//!   mix is bit-exact unity): `gL = √2·cos θ`, `gR = √2·sin θ`, θ =
//!   (pan+1)·π/4. Hard left is +3 dB on L and silence on R.
//! * Mute and solo gates ramp over 2 ms. If any *track* strip is soloed,
//!   every unsoloed track strip is muted (ramped); returns are unaffected.
//! * EQ and compressor on/off crossfade the processed and the dry signal over
//!   5 ms. Once fully off, the processor's state is reset, so it starts clean
//!   when switched on again (and a reused slot has no stale state).
//! * EQ, compressor, reverb, delay and limiter params glide inside the DSP
//!   (`dsp/`).
//!
//! # Sidechain keys
//! A track strip's key is [`Key::None`] (the compressor hears its own input),
//! [`Key::Track`] (that track's raw buffer) or [`Key::Row`] (only that drum
//! row's voices). Up to `MAX_KEYS` distinct drum rows can be keys at once;
//! each gets a key slot, and the drums render that row into the slot's key
//! buffer as well ([`Mixer::row_keys`]). A track keyed by itself is `None`.
//! Keys are pre-fader source signals, never a strip's output, so there are
//! no cycles. When a key's source slot is removed or retyped
//! ([`Mixer::slot_removed`]) the key reverts to `None` and the compressor's
//! reduction ramps to unity over 2 ms (no snap).
//!
//! # Lifecycle
//! `ADD_*_TRACK` / `REMOVE_TRACK` reset the slot's strip to the defaults
//! through the same smoothing (so a removed track's 2 ms fade-out still
//! reaches the master without a gain jump). Nothing else resets state: Stop,
//! seeks and loop wraps never touch effect tails, compressor or limiter.
//!
//! # Which strips run
//! The engine passes a mask of slots that hold a track or rendered audio
//! this block; a strip keeps running for [`TAIL_SECONDS`] after that (EQ
//! ringing, gate ramps), then idles at zero cost. Returns and master always
//! run (their tails never stop abruptly).
//!
//! # Automation
//! A lane on a mixer param (`automation.rs`) drives it through
//! [`Mixer::automate`], never through `set`: the strip keeps the hand-set
//! value (the *base*: what `set` stores, what [`Mixer::param`] reports and
//! what is saved) and holds the automated one in an overlay (`auto_mask`,
//! `auto_vals`) that every gain and DSP update reads first. A `MIX_SET` on
//! an automated param therefore only stores the base, and
//! [`Mixer::release_auto`] re-applies it with the normal smoothing when the
//! lane stops applying.
//!
//! With no mixer lane applying, `process` runs the whole block as one chunk,
//! exactly as before automation existed (the golden export hashes pin this).
//! Otherwise it runs the strips, returns and master in `RACK_BLOCK` (32-frame)
//! chunks, and before each chunk applies every mixer entry of the block's
//! [`AutoFrame`]: on a *line* the gain ramps (fader, pan, sends) move
//! linearly to the next sub-block value over the chunk ([`Ramp::line`]);
//! on a *step* they glide over the usual 5 ms; other params set their DSP
//! target once per chunk and the DSP glides it. A strip that has just got
//! its track (`fresh`), and the returns and master before their first block
//! after a reset, take a step at once, so a replayed project starts at its
//! automated values.
//!
//! # Strip tap (plan 12)
//! `OP_VIS_TAP` picks one channel ([`Mixer::set_tap`]: a track strip or a
//! return, or −1 = off). While on, `process` zeroes the engine's tap buffer
//! (`vis::VisBlock`) at block start and `mix_out` writes the tapped strip's
//! post-fader `l`/`r` into it: the very values it adds to the master bus,
//! computed once, so the mix is unchanged bit for bit. A strip that does not
//! run this block leaves zeros. Turning the tap off zeroes the buffer once
//! more; after that an untapped mixer does not touch it. The tap is view
//! state, not part of the session: the engine reset keeps it.
//!
//! Everything is allocated in [`Mixer::new`]; `process` and the setters
//! never allocate, block or panic.

pub mod catalog;
#[cfg(test)]
mod tests;

use crate::automation::{AutoFrame, Target};
use crate::dsp::{db_to_lin, Compressor, Delay, Eq3, Limiter, Reverb};
use crate::protocol::{ERR_BAD_INDEX, ERR_BAD_VALUE};
use crate::{MAX_BLOCK, MAX_KEYS, RACK_BLOCK, MAX_ROWS, MAX_TRACKS, MIX_CHANNELS, MIX_MASTER, MIX_METER_STRIDE, MIX_RETURN0};
use catalog::*;

/// A strip keeps running this long after its slot last held a track or
/// rendered audio.
pub const TAIL_SECONDS: f32 = 0.25;
/// Fader / pan / send / master-gain ramp time.
const GAIN_SECONDS: f32 = 0.005;
/// The legacy master gain's default: fixed headroom (−1.9 dB) before the
/// limiter, restored by the engine reset.
pub const MASTER_GAIN: f32 = 0.8;
/// Mute / solo gate and sidechain-fallback ramp time.
const GATE_SECONDS: f32 = 0.002;
/// "No key slot" in [`Mixer::row_keys`].
pub const NO_KEY: u8 = u8::MAX;

/// A strip's sidechain key source (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    /// The strip's own (post-EQ) signal.
    None,
    /// Track `slot`'s raw (pre-fader) buffer.
    Track(usize),
    /// Drum row `row` of drum track `slot` (its voices only).
    Row(usize, usize),
}

impl Key {
    /// Wire code: −1, `slot * 32`, or `slot * 32 + row + 1`.
    pub fn code(self) -> i32 {
        match self {
            Key::None => -1,
            Key::Track(s) => (s * 32) as i32,
            Key::Row(s, r) => (s * 32 + r + 1) as i32,
        }
    }

    /// Does this key listen to slot `slot`?
    pub fn source(self) -> Option<usize> {
        match self {
            Key::None => None,
            Key::Track(s) | Key::Row(s, _) => Some(s),
        }
    }
}

/// `count` planar stereo buffers of `MAX_BLOCK` frames each, in one
/// preallocated heap block (`[pair][channel][frame]`).
pub struct StereoBufs {
    data: Vec<f32>,
    count: usize,
}

impl StereoBufs {
    pub fn new(count: usize) -> StereoBufs {
        StereoBufs { data: vec![0.0; count * 2 * MAX_BLOCK], count }
    }

    /// Zero frames `0..n` of every pair.
    pub fn clear(&mut self, n: usize) {
        let n = n.min(MAX_BLOCK);
        for ch in self.data.chunks_exact_mut(MAX_BLOCK) {
            ch[..n].fill(0.0);
        }
    }

    /// Frames `from..to` of pair `i`, mutably (`None` if out of range).
    pub fn pair_mut(&mut self, i: usize, from: usize, to: usize) -> Option<(&mut [f32], &mut [f32])> {
        if i >= self.count || from > to || to > MAX_BLOCK {
            return None;
        }
        let base = i * 2 * MAX_BLOCK;
        let (l, r) = self.data.get_mut(base..base + 2 * MAX_BLOCK)?.split_at_mut(MAX_BLOCK);
        Some((&mut l[from..to], &mut r[from..to]))
    }

    /// Frames `0..n` of pair `i` (`None` if out of range).
    pub fn pair(&self, i: usize, n: usize) -> Option<(&[f32], &[f32])> {
        if i >= self.count || n > MAX_BLOCK {
            return None;
        }
        let base = i * 2 * MAX_BLOCK;
        let (l, r) = self.data.get(base..base + 2 * MAX_BLOCK)?.split_at(MAX_BLOCK);
        Some((&l[..n], &r[..n]))
    }

    /// Frames `from..to` of pair `i` (`None` if out of range).
    pub fn span(&self, i: usize, from: usize, to: usize) -> Option<(&[f32], &[f32])> {
        let (l, r) = self.pair(i, to)?;
        Some((l.get(from..)?, r.get(from..)?))
    }
}

/// A linear ramp: `set` starts a move to a new target over the ramp length;
/// `next` advances one sample and lands exactly on the target.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Ramp {
    value: f32,
    target: f32,
    step: f32,
    left: u32,
    len: u32,
}

impl Ramp {
    fn new(value: f32, len: u32) -> Ramp {
        Ramp { value, target: value, step: 0.0, left: 0, len: len.max(1) }
    }

    fn set(&mut self, target: f32) {
        if target != self.target {
            self.target = target;
            self.left = self.len;
            self.step = (target - self.value) / self.len as f32;
        }
    }

    #[inline]
    fn next(&mut self) -> f32 {
        if self.left > 0 {
            self.left -= 1;
            self.value = if self.left == 0 { self.target } else { self.value + self.step };
        }
        self.value
    }

    /// Move linearly to `target`, landing in `frames` samples, or at the end
    /// of a glide still running if that is later (automation: a line
    /// segment per sub-block; a step's 5 ms glide is never cut short, it
    /// just aims at the moving target).
    fn line(&mut self, target: f32, frames: u32) {
        let left = self.left.max(frames).max(1);
        self.target = target;
        self.left = left;
        self.step = (target - self.value) / left as f32;
    }

    /// Jump to `target` at once (no ramp).
    fn snap(&mut self, target: f32) {
        self.value = target;
        self.target = target;
        self.left = 0;
        self.step = 0.0;
    }

    /// At rest at exactly `v`.
    fn rests_at(&self, v: f32) -> bool {
        self.left == 0 && self.value == v
    }
}

/// Fader (dB) and pan → per-side linear gains (see the module docs).
fn pan_gains(fader_db: f32, pan: f32) -> (f32, f32) {
    if fader_db <= FADER_MIN_DB {
        return (0.0, 0.0);
    }
    let g = if fader_db == 0.0 { 1.0 } else { db_to_lin(fader_db) };
    if pan == 0.0 {
        return (g, g);
    }
    let theta = (pan.clamp(-1.0, 1.0) as f64 + 1.0) * std::f64::consts::FRAC_PI_4;
    let s = std::f64::consts::SQRT_2;
    (g * (s * theta.cos()) as f32, g * (s * theta.sin()) as f32)
}

/// Send level (dB) → linear (the minimum is off).
fn send_gain(db: f32) -> f32 {
    if db <= FADER_MIN_DB {
        0.0
    } else {
        db_to_lin(db)
    }
}

/// An insert (EQ or compressor) with its 5 ms on/off crossfade.
#[derive(Clone, Copy, Debug)]
struct Insert {
    /// Wet amount, 0 (bypassed) ..1 (fully on).
    mix: Ramp,
    /// Fully off and its DSP state already reset.
    idle: bool,
}

impl Insert {
    fn new(len: u32) -> Insert {
        Insert { mix: Ramp::new(0.0, len), idle: true }
    }

    fn set(&mut self, on: bool) {
        self.mix.set(if on { 1.0 } else { 0.0 });
        if on {
            self.idle = false;
        }
    }

    /// Fully on / off at once. Switched off, `reset` clears the DSP now (it
    /// would otherwise wait for `run_insert` to see the mix at rest at 0, and
    /// a snap back on before that would start from stale state).
    fn snap<D>(&mut self, on: bool, dsp: &mut D, reset: fn(&mut D)) {
        self.mix.snap(if on { 1.0 } else { 0.0 });
        if on {
            self.idle = false;
        } else if !self.idle {
            self.idle = true;
            reset(dsp);
        }
    }
}

/// One channel strip (tracks, returns and the master share the type; each
/// kind only uses its own parts, see the module docs).
pub(crate) struct Strip {
    /// Current param values, indexed by catalog id (defaults on reset).
    values: [f32; MIX_PARAMS],
    key: Key,
    eq: Eq3,
    eq_ins: Insert,
    comp: Compressor,
    comp_ins: Insert,
    gl: Ramp,
    gr: Ramp,
    gate: Ramp,
    send_a: Ramp,
    send_b: Ramp,
    /// Samples this strip keeps running after its slot went quiet.
    tail: usize,
    /// Samples the gains, gate and inserts keep their old targets after the
    /// slot was removed (the old track's 2 ms fade-out passes through the
    /// strip it was mixed with), before gliding to the reset values.
    hold: usize,
    /// The strip's slot got a new track while nothing sounded through it
    /// (`Mixer::slot_added`), and no block has run through it since: its
    /// gains, gate and inserts jump to new settings instead of ramping (the
    /// ramps exist to avoid clicks, and there is nothing to click yet). So a
    /// project replay (load, export) mixes from its first sample with the
    /// project's settings, whatever the engine's call size.
    fresh: bool,
    /// Bit `id`: param `id` is driven by an automation lane; its effective
    /// value is `auto_vals[id]` (the base stays in `values`).
    auto_mask: u64,
    auto_vals: [f32; MIX_PARAMS],
}

impl Strip {
    fn new(sr: f32, gain_len: u32, gate_len: u32) -> Strip {
        let mut s = Strip {
            values: [0.0; MIX_PARAMS],
            key: Key::None,
            eq: Eq3::new(sr),
            eq_ins: Insert::new(gain_len),
            comp: Compressor::new(sr),
            comp_ins: Insert::new(gain_len),
            gl: Ramp::new(1.0, gain_len),
            gr: Ramp::new(1.0, gain_len),
            gate: Ramp::new(1.0, gate_len),
            send_a: Ramp::new(0.0, gain_len),
            send_b: Ramp::new(0.0, gain_len),
            tail: 0,
            hold: 0,
            fresh: false,
            auto_mask: 0,
            auto_vals: [0.0; MIX_PARAMS],
        };
        for p in &PARAMS {
            s.values[p.id as usize] = p.default;
        }
        s
    }

    fn v(&self, id: u32) -> f32 {
        self.values.get(id as usize).copied().unwrap_or(0.0)
    }

    fn flag(&self, id: u32) -> bool {
        self.v(id) != 0.0
    }

    /// Is param `id` driven by an automation lane?
    fn masked(&self, id: u32) -> bool {
        id < 64 && self.auto_mask >> id & 1 != 0
    }

    /// Effective value of param `id`: the automated one while a lane drives
    /// it, else the stored (base) value.
    fn ev(&self, id: u32) -> f32 {
        if self.masked(id) {
            self.auto_vals.get(id as usize).copied().unwrap_or(0.0)
        } else {
            self.v(id)
        }
    }

    /// Store `value` for param `id` and push it into the DSP and (unless
    /// held) the ramp targets. Strip-local params only; the returns'
    /// reverb/delay params are applied by the mixer. An automated param
    /// only stores its base (the DSP and ramps keep the automated value).
    fn apply(&mut self, id: u32, value: f32) {
        if let Some(slot) = self.values.get_mut(id as usize) {
            *slot = value;
        }
        if self.hold == 0 {
            self.retarget();
        }
        if !self.masked(id) {
            self.push(id);
        }
    }

    /// Push param `id`'s effective value into the strip's DSP (EQ and
    /// compressor; gains and inserts go through `retarget`, mute / solo
    /// through the per-block gate, the sends' pre flags are read where used).
    fn push(&mut self, id: u32) {
        match id {
            P_EQ_HP => self.eq.set_hp(self.ev(P_EQ_HP)),
            P_EQ_LOW => self.eq.set_low(self.ev(P_EQ_LOW)),
            P_EQ_MID_FREQ | P_EQ_MID_GAIN | P_EQ_MID_Q => {
                self.eq.set_mid(self.ev(P_EQ_MID_FREQ), self.ev(P_EQ_MID_GAIN), self.ev(P_EQ_MID_Q))
            }
            P_EQ_HIGH => self.eq.set_high(self.ev(P_EQ_HIGH)),
            P_COMP_THRESHOLD => self.comp.set_threshold_db(self.ev(P_COMP_THRESHOLD)),
            P_COMP_RATIO => self.comp.set_ratio(self.ev(P_COMP_RATIO)),
            P_COMP_ATTACK => self.comp.set_attack_ms(self.ev(P_COMP_ATTACK)),
            P_COMP_RELEASE => self.comp.set_release_ms(self.ev(P_COMP_RELEASE)),
            P_COMP_MAKEUP => self.comp.set_makeup_db(self.ev(P_COMP_MAKEUP)),
            _ => {}
        }
    }

    /// Automation: move the gain ramps a fader, pan or send drives to their
    /// effective targets: at once (`snap`), linearly over `ramp` frames, or
    /// (`ramp == 0`) with the usual 5 ms glide.
    fn drive(&mut self, id: u32, ramp: u32, snap: bool) {
        let go = |r: &mut Ramp, target: f32| {
            if snap {
                r.snap(target)
            } else if ramp > 0 {
                r.line(target, ramp)
            } else {
                r.set(target)
            }
        };
        match id {
            P_FADER | P_PAN => {
                let (l, r) = pan_gains(self.ev(P_FADER), self.ev(P_PAN));
                go(&mut self.gl, l);
                go(&mut self.gr, r);
            }
            P_SEND_A => {
                let g = send_gain(self.ev(P_SEND_A));
                go(&mut self.send_a, g);
            }
            P_SEND_B => {
                let g = send_gain(self.ev(P_SEND_B));
                go(&mut self.send_b, g);
            }
            _ => {}
        }
    }

    /// Point the gain ramps and the insert crossfades at the current values
    /// (`Ramp::set` ignores an unchanged target).
    fn retarget(&mut self) {
        let (l, r) = pan_gains(self.ev(P_FADER), self.ev(P_PAN));
        if self.fresh {
            self.gl.snap(l);
            self.gr.snap(r);
            self.send_a.snap(send_gain(self.ev(P_SEND_A)));
            self.send_b.snap(send_gain(self.ev(P_SEND_B)));
            self.eq_ins.snap(self.flag(P_EQ_ON), &mut self.eq, Eq3::reset);
            self.comp_ins.snap(self.flag(P_COMP_ON), &mut self.comp, Compressor::reset);
            return;
        }
        self.gl.set(l);
        self.gr.set(r);
        self.send_a.set(send_gain(self.ev(P_SEND_A)));
        self.send_b.set(send_gain(self.ev(P_SEND_B)));
        self.eq_ins.set(self.flag(P_EQ_ON));
        self.comp_ins.set(self.flag(P_COMP_ON));
    }

    /// Count `n` processed samples off the hold; at its end, glide to the
    /// current values.
    fn count_hold(&mut self, n: usize) {
        if self.hold > 0 {
            self.hold = self.hold.saturating_sub(n);
            if self.hold == 0 {
                self.retarget();
            }
        }
    }
}


/// Run `ins` over `work` (in place) with its dry/wet crossfade; `dry` is
/// scratch. `process` runs `dsp`; once the insert is fully off, `reset`
/// clears `dsp`'s state (once), so it starts clean when switched on again.
fn run_insert<D>(
    ins: &mut Insert,
    dsp: &mut D,
    work: (&mut [f32], &mut [f32]),
    dry: (&mut [f32], &mut [f32]),
    process: impl FnOnce(&mut D, &mut [f32], &mut [f32]),
    reset: fn(&mut D),
) {
    if ins.mix.rests_at(0.0) {
        if !ins.idle {
            ins.idle = true;
            reset(dsp);
        }
        return;
    }
    let (wl, wr) = work;
    if ins.mix.rests_at(1.0) {
        process(dsp, wl, wr);
        return;
    }
    let (dl, dr) = dry;
    let n = wl.len().min(wr.len()).min(dl.len()).min(dr.len());
    dl[..n].copy_from_slice(&wl[..n]);
    dr[..n].copy_from_slice(&wr[..n]);
    process(dsp, wl, wr);
    for i in 0..n {
        let x = ins.mix.next();
        wl[i] = dl[i] + (wl[i] - dl[i]) * x;
        wr[i] = dr[i] + (wr[i] - dr[i]) * x;
    }
}

/// Mixer buses and scratch, each one stereo `MAX_BLOCK` pair.
struct Buses {
    master: StereoBufs,
    send_a: StereoBufs,
    send_b: StereoBufs,
    /// Where a strip is processed (a copy of its input).
    work: StereoBufs,
    /// The dry copy during an insert crossfade.
    dry: StereoBufs,
}

/// The mixer (see the module docs).
pub struct Mixer {
    sr: f32,
    /// `MIX_CHANNELS` strips (tracks, Reverb return, Delay return, master).
    strips: Vec<Strip>,
    reverb: Reverb,
    delay: Delay,
    limiter: Limiter,
    /// Legacy `SET_MASTER_GAIN`, applied at the master bus input.
    master_gain: Ramp,
    /// Key slot (`< MAX_KEYS`) of each drum row, or `NO_KEY`.
    row_keys: Vec<[u8; MAX_ROWS]>,
    buses: Buses,
    /// `[MIX_CHANNELS × (peakL, peakR, gr_db)]`.
    meters: Vec<f32>,
    gate_len: usize,
    tail_len: usize,
    /// No block has run since `new` / `reset_all`: an automation step on a
    /// return or the master lands at once (track strips use `fresh`).
    auto_fresh: bool,
    /// The tapped channel (`0..MIX_MASTER`), or −1 (off); see "Strip tap".
    tap_ch: i32,
    /// The tap buffer may hold data from an earlier block (zero it once).
    tap_dirty: bool,
}

impl Mixer {
    /// All allocation happens here. `lookahead` is the limiter's lookahead
    /// in seconds (the engine uses `dsp::limiter::LOOKAHEAD_SECONDS`).
    pub fn new(sample_rate: f32, lookahead: f32) -> Mixer {
        let sr = if sample_rate.is_finite() && sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let gain_len = (GAIN_SECONDS * sr).round().max(1.0) as u32;
        let gate_len = (GATE_SECONDS * sr).round().max(1.0) as u32;
        let mut m = Mixer {
            sr,
            strips: (0..MIX_CHANNELS).map(|_| Strip::new(sr, gain_len, gate_len)).collect(),
            reverb: Reverb::new(sr),
            delay: Delay::new(sr),
            limiter: Limiter::with_lookahead(sr, lookahead),
            master_gain: Ramp::new(MASTER_GAIN, gain_len),
            row_keys: vec![[NO_KEY; MAX_ROWS]; MAX_TRACKS],
            buses: Buses {
                master: StereoBufs::new(1),
                send_a: StereoBufs::new(1),
                send_b: StereoBufs::new(1),
                work: StereoBufs::new(1),
                dry: StereoBufs::new(1),
            },
            meters: vec![0.0; MIX_CHANNELS * MIX_METER_STRIDE],
            gate_len: gate_len as usize,
            tail_len: (TAIL_SECONDS * sr) as usize,
            auto_fresh: true,
            tap_ch: -1,
            tap_dirty: false,
        };
        m.apply_defaults();
        m
    }

    /// Every channel's params at their defaults and keys none, applied at
    /// once (the gain ramps rest on their targets: nothing to glide from).
    fn apply_defaults(&mut self) {
        for ch in 0..MIX_CHANNELS {
            self.reset_channel(ch);
        }
        for s in self.strips.iter_mut() {
            for r in [&mut s.gl, &mut s.gr, &mut s.gate, &mut s.send_a, &mut s.send_b] {
                *r = Ramp::new(r.target, r.len);
            }
        }
    }

    /// Engine reset (`OP_RESET_ALL`): back to exactly a new mixer's state,
    /// without allocating. Strips (params, keys, EQ/compressor state, insert
    /// crossfades, tails and holds), the reverb and delay returns (their
    /// tails are zeroed), the limiter (delay line and envelope), the legacy
    /// master gain ([`MASTER_GAIN`], not ramped) and the meters. Nothing glides: the
    /// engine fades its master output over the reset instead.
    pub fn reset_all(&mut self) {
        let gain_len = self.master_gain.len;
        let gate_len = self.gate_len as u32;
        for s in self.strips.iter_mut() {
            *s = Strip::new(self.sr, gain_len, gate_len);
        }
        self.master_gain = Ramp::new(MASTER_GAIN, gain_len);
        self.apply_defaults();
        // After the defaults: the DSP jumps to its (default) targets.
        self.reverb.reset();
        self.delay.reset();
        self.limiter.reset();
        self.meters.fill(0.0);
        self.auto_fresh = true;
    }

    /// The strip tap: `ch` in `0..MIX_MASTER`, or −1 (off). Anything else
    /// (the master included) turns it off; `protocol::decode` refuses those.
    pub fn set_tap(&mut self, ch: i32) {
        self.tap_ch = if (0..MIX_MASTER as i32).contains(&ch) { ch } else { -1 };
    }

    /// The tapped channel, or −1.
    pub fn tap(&self) -> i32 {
        self.tap_ch
    }

    /// Latency of the master (the limiter lookahead), in samples.
    pub fn latency(&self) -> usize {
        self.limiter.latency()
    }

    /// Legacy master gain (`SET_MASTER_GAIN`, 0..2), ramped over 5 ms.
    pub fn set_master_gain(&mut self, gain: f32) {
        if gain.is_finite() {
            self.master_gain.set(gain.clamp(0.0, 2.0));
        }
    }

    /// The master limiter's ceiling target (linear; automated or not).
    pub fn ceiling(&self) -> f32 {
        self.strips.get(MIX_MASTER).map_or(1.0, |s| db_to_lin(s.ev(P_LIMITER_CEILING)))
    }

    /// The legacy master gain's current (ramped) value.
    pub fn master_gain(&self) -> f32 {
        self.master_gain.value
    }

    /// Set param `id` of channel `ch` (`decode` validated it; anything
    /// invalid is ignored rather than trusted).
    pub fn set(&mut self, ch: usize, id: u32, value: f32) {
        let Some(p) = param(id) else { return };
        if !p.accepts(ch) || !p.valid(value as f64) {
            return;
        }
        let Some(s) = self.strips.get_mut(ch) else { return };
        s.apply(id, value);
        if !s.masked(id) {
            self.push_global(id, value);
        }
    }

    /// Push a return / master param into its DSP (reverb, delay, limiter).
    fn push_global(&mut self, id: u32, value: f32) {
        match id {
            P_REV_SIZE => self.reverb.set_size(value),
            P_REV_DECAY => self.reverb.set_decay(value),
            P_REV_DAMPING => self.reverb.set_damping(value),
            P_REV_PREDELAY => self.reverb.set_predelay_ms(value),
            P_DELAY_TIME => {
                let beats = DELAY_DIVISION_BEATS.get(value as usize).copied().unwrap_or(0.75);
                self.delay.set_time_beats(beats);
            }
            P_DELAY_FEEDBACK => self.delay.set_feedback(value),
            P_DELAY_PING_PONG => self.delay.set_ping_pong(value != 0.0),
            P_DELAY_HIGH_CUT => self.delay.set_high_cut(value),
            P_LIMITER_CEILING => self.limiter.set_ceiling(db_to_lin(value)),
            _ => {}
        }
    }

    /// Param `id` of channel `ch` (its catalog default if it does not
    /// apply): the stored value, i.e. the base of an automated param.
    pub fn param(&self, ch: usize, id: u32) -> f32 {
        self.strips.get(ch).map_or(0.0, |s| s.v(id))
    }

    /// Param `id` of channel `ch` as heard: the automated value while a lane
    /// drives it, else [`param`](Mixer::param).
    pub fn effective(&self, ch: usize, id: u32) -> f32 {
        self.strips.get(ch).map_or(0.0, |s| s.ev(id))
    }

    /// Current gains of channel `ch`: `[left, right, send A, send B]`
    /// (tests).
    #[doc(hidden)]
    pub fn ramps(&self, ch: usize) -> [f32; 4] {
        self.strips.get(ch).map_or([0.0; 4], |s| [s.gl.value, s.gr.value, s.send_a.value, s.send_b.value])
    }

    /// Automation: drive continuous param `id` of channel `ch` to `value`.
    /// `ramp > 0`: the gains move linearly to it over `ramp` frames (a line
    /// segment); `ramp == 0`: a step with the usual smoothing (at once on a
    /// fresh strip). Other params set their DSP target. The stored base is
    /// never touched. Anything invalid is ignored.
    pub fn automate(&mut self, ch: usize, id: u32, value: f32, ramp: u32) {
        let Some(p) = param(id) else { return };
        if !p.accepts(ch) || p.integer || !value.is_finite() || id >= 64 {
            return;
        }
        let v = value.clamp(p.min, p.max);
        let fresh_bus = self.auto_fresh && ch >= MAX_TRACKS;
        let Some(s) = self.strips.get_mut(ch) else { return };
        s.auto_mask |= 1u64 << id;
        if let Some(x) = s.auto_vals.get_mut(id as usize) {
            *x = v;
        }
        match id {
            P_FADER | P_PAN | P_SEND_A | P_SEND_B => {
                if s.hold == 0 {
                    let snap = ramp == 0 && (s.fresh || fresh_bus);
                    s.drive(id, ramp, snap);
                }
            }
            _ => {
                s.push(id);
                self.push_global(id, v);
            }
        }
    }

    /// Automation of param `id` of channel `ch` stopped: its base (the
    /// stored value) plays again, with the normal smoothing.
    pub fn release_auto(&mut self, ch: usize, id: u32) {
        let Some(s) = self.strips.get_mut(ch) else { return };
        if !s.masked(id) {
            return;
        }
        s.auto_mask &= !(1u64 << id);
        let base = s.v(id);
        self.set(ch, id, base);
    }

    /// Every param channel `ch` accepts back to its default (through the
    /// usual smoothing), and its key to none.
    pub fn reset_channel(&mut self, ch: usize) {
        for p in &PARAMS {
            if p.accepts(ch) {
                self.set(ch, p.id, p.default);
            }
        }
        if let Some(s) = self.strips.get_mut(ch) {
            s.key = Key::None;
        }
        self.rebuild_keys();
    }

    /// Track channel `ch`'s sidechain key.
    pub fn key(&self, ch: usize) -> Key {
        self.strips.get(ch).map_or(Key::None, |s| s.key)
    }

    /// Set track channel `ch`'s key (the engine has checked that the source
    /// exists and has the right kind). A track keyed by itself gets `None`.
    /// `ERR_BAD_VALUE` if the key needs a new drum-row key slot and all
    /// `MAX_KEYS` are taken by other strips' rows.
    pub fn set_key(&mut self, ch: usize, key: Key) -> Result<(), i32> {
        if ch >= MAX_TRACKS {
            return Err(ERR_BAD_INDEX);
        }
        let key = if key == Key::Track(ch) { Key::None } else { key };
        if let Key::Row(s, r) = key {
            // Distinct rows keyed by the *other* strips.
            let mut rows = [(usize::MAX, usize::MAX); MAX_KEYS];
            let mut used = 0;
            for (i, st) in self.strips.iter().take(MAX_TRACKS).enumerate() {
                if let (true, Key::Row(a, b)) = (i != ch, st.key) {
                    if !rows[..used].contains(&(a, b)) && used < MAX_KEYS {
                        rows[used] = (a, b);
                        used += 1;
                    }
                }
            }
            if used >= MAX_KEYS && !rows.contains(&(s, r)) {
                return Err(ERR_BAD_VALUE);
            }
        }
        if let Some(st) = self.strips.get_mut(ch) {
            st.key = key;
        }
        self.rebuild_keys();
        Ok(())
    }

    /// Slot `slot` was removed or replaced (`ADD_*_TRACK` / `REMOVE_TRACK`):
    /// every key listening to it reverts to none (that compressor's
    /// reduction ramps to unity over 2 ms), and the slot's own strip resets
    /// to the defaults (smoothed).
    pub fn slot_removed(&mut self, slot: usize) {
        let fade = self.gate_len;
        for s in self.strips.iter_mut().take(MAX_TRACKS) {
            if s.key.source() == Some(slot) {
                s.key = Key::None;
                s.comp.release_to_unity(fade);
            }
        }
        // The old track fades out over 2 ms through the strip it was mixed
        // with (a muted track stays muted, a quiet one quiet), then the
        // strip glides to its defaults.
        // The fade is 2 ms of voice ramps, rendered in rack sub-blocks: hold
        // one sub-block longer so its tail is covered too.
        if let Some(s) = self.strips.get_mut(slot).filter(|_| slot < MAX_TRACKS) {
            s.hold = fade + RACK_BLOCK;
            s.auto_mask = 0; // its lanes were cleared with the slot
        }
        self.reset_channel(slot);
    }

    /// Slot `slot` gets a new track (`ADD_*_TRACK`); `was_empty`: it held
    /// none. If nothing sounds through its strip (an empty slot whose strip
    /// has no removal hold or tail left: a fresh engine, a load after
    /// `RESET_ALL`, a slot long unused), the strip resets to the defaults at
    /// once and stays `fresh` until its first block, so the track's mixer
    /// settings apply from its first sample. Otherwise (replacing a track,
    /// or a removed one still fading) it is a removal: `slot_removed`.
    pub fn slot_added(&mut self, slot: usize, was_empty: bool) {
        let quiet = self.strips.get(slot).is_some_and(|s| slot < MAX_TRACKS && s.hold == 0 && s.tail == 0);
        if !(was_empty && quiet) {
            self.slot_removed(slot);
            return;
        }
        let fade = self.gate_len;
        for s in self.strips.iter_mut().take(MAX_TRACKS) {
            if s.key.source() == Some(slot) {
                s.key = Key::None;
                s.comp.release_to_unity(fade);
            }
        }
        if let Some(s) = self.strips.get_mut(slot) {
            s.fresh = true;
            s.gate.snap(1.0);
            s.auto_mask = 0;
        }
        self.reset_channel(slot);
    }

    /// Drum row `row` of track `slot` was removed (`OP_REMOVE_ROW`): keys
    /// listening to it revert to none (that compressor ramps to unity over
    /// 2 ms, like a removed track), keys on a later row of that track follow
    /// it up one. The number of distinct keyed rows can only shrink, so
    /// `MAX_KEYS` still holds. Allocation-free.
    pub fn row_removed(&mut self, slot: usize, row: usize) {
        let fade = self.gate_len;
        for s in self.strips.iter_mut().take(MAX_TRACKS) {
            if let Key::Row(ks, kr) = s.key {
                if ks == slot && kr == row {
                    s.key = Key::None;
                    s.comp.release_to_unity(fade);
                } else if ks == slot && kr > row {
                    s.key = Key::Row(ks, kr - 1);
                }
            }
        }
        self.rebuild_keys();
    }

    /// An empty drum row was inserted at `row` of track `slot`
    /// (`OP_INSERT_ROW`): keys on that row or a later one follow it down
    /// one (a key on the last row, which is dropped, reverts to none).
    pub fn row_inserted(&mut self, slot: usize, row: usize) {
        let fade = self.gate_len;
        for s in self.strips.iter_mut().take(MAX_TRACKS) {
            if let Key::Row(ks, kr) = s.key {
                if ks == slot && kr + 1 >= MAX_ROWS {
                    s.key = Key::None;
                    s.comp.release_to_unity(fade);
                } else if ks == slot && kr >= row {
                    s.key = Key::Row(ks, kr + 1);
                }
            }
        }
        self.rebuild_keys();
    }

    /// Reassign the key slots: one per distinct keyed drum row.
    fn rebuild_keys(&mut self) {
        for rk in self.row_keys.iter_mut() {
            rk.fill(NO_KEY);
        }
        let mut next = 0u8;
        for s in self.strips.iter().take(MAX_TRACKS) {
            if let Key::Row(slot, row) = s.key {
                if let Some(k) = self.row_keys.get_mut(slot).and_then(|rk| rk.get_mut(row)) {
                    if *k == NO_KEY && (next as usize) < MAX_KEYS {
                        *k = next;
                        next += 1;
                    }
                }
            }
        }
    }

    /// Key slot of each drum row, per track (`NO_KEY` = not a key): the
    /// drums also render a keyed row into that key buffer.
    pub fn row_keys(&self) -> &[[u8; MAX_ROWS]] {
        &self.row_keys
    }

    /// `[MIX_CHANNELS × (peakL, peakR, gr_db)]` of the last block. Track and
    /// return peaks are post-fader; the master's peaks are the engine's
    /// final output (it writes them), its gr the limiter's.
    pub fn meters(&self) -> &[f32] {
        &self.meters
    }

    /// Mutable meters (the engine writes the master's final peaks).
    pub fn meters_mut(&mut self) -> &mut [f32] {
        &mut self.meters
    }

    /// Mix one block of `n` frames. `tracks` holds every slot's raw buffer,
    /// `keys` the key-slot buffers, and bit `s` of `active` is set for each
    /// slot that holds a track or rendered audio this block. `auto` holds
    /// the block's automation values (see "Automation" in the module docs).
    /// Writes the limited master to `out_l` / `out_r` (`n` frames, delayed
    /// by [`latency`](Mixer::latency)) and, while the strip tap is on, the
    /// tapped strip's post-fader output to `tap` (see "Strip tap").
    #[allow(clippy::too_many_arguments)]
    pub fn process(
        &mut self,
        n: usize,
        tracks: &StereoBufs,
        keys: &StereoBufs,
        active: u32,
        bpm: f32,
        out_l: &mut [f32],
        out_r: &mut [f32],
        auto: &AutoFrame,
        tap: (&mut [f32], &mut [f32]),
    ) {
        let n = n.min(MAX_BLOCK).min(out_l.len()).min(out_r.len());
        let (tap_l, tap_r) = tap;
        if self.tap_ch >= 0 || self.tap_dirty {
            tap_l.fill(0.0);
            tap_r.fill(0.0);
            self.tap_dirty = self.tap_ch >= 0;
        }
        // An empty tap when off: `chunk` then never writes it.
        let tap_n = if self.tap_ch >= 0 { n.min(tap_l.len()).min(tap_r.len()) } else { 0 };
        let mut tap = Tap { ch: self.tap_ch, l: &mut tap_l[..tap_n], r: &mut tap_r[..tap_n] };
        self.buses.master.clear(n);
        self.buses.send_a.clear(n);
        self.buses.send_b.clear(n);
        self.meters.fill(0.0);
        let solo = self.strips.iter().take(MAX_TRACKS).any(|s| s.flag(P_SOLO));
        // Which track strips run this block: those whose slot holds a track
        // or rendered audio, and those still in their tail.
        let tail_len = self.tail_len;
        let mut runs = 0u32;
        for (ch, st) in self.strips.iter_mut().enumerate().take(MAX_TRACKS) {
            if active & (1u32 << ch) != 0 {
                st.tail = tail_len;
                runs |= 1 << ch;
            } else if st.tail > 0 {
                st.tail = st.tail.saturating_sub(n);
                runs |= 1 << ch;
            }
        }
        self.delay.set_tempo(bpm);
        let blk = Block { tracks, keys, runs, solo };
        if !auto.has_mix() {
            // The whole block at once: exactly the mix without automation.
            self.chunk(&blk, 0, n, out_l, out_r, &mut tap);
        } else {
            let mut from = 0;
            for k in 0..auto.subs() {
                let to = ((k + 1) * RACK_BLOCK).min(n);
                if to <= from {
                    break;
                }
                let len = (to - from) as u32;
                for e in auto.entries() {
                    if let (Target::Mix { ch, id }, true) = (e.target, e.applies(k)) {
                        if e.line(k) {
                            self.automate(ch as usize, id as u32, e.value(k + 1), len);
                        } else {
                            self.automate(ch as usize, id as u32, e.value(k), 0);
                        }
                    }
                }
                self.chunk(&blk, from, to, out_l, out_r, &mut tap);
                from = to;
            }
            if from < n {
                self.chunk(&blk, from, n, out_l, out_r, &mut tap);
            }
        }
        self.auto_fresh = false;
    }

    /// Mix frames `from..to` of the block: strips, returns, master, limiter.
    fn chunk(&mut self, blk: &Block, from: usize, to: usize, out_l: &mut [f32], out_r: &mut [f32], tap: &mut Tap) {
        let Block { tracks, keys, runs, solo } = *blk;
        let len = to - from;
        let Mixer { strips, reverb, delay, limiter, master_gain, row_keys, buses, meters, .. } = self;

        // Track strips: raw buffer -> work copy -> EQ -> comp -> fader/pan/gate.
        for (ch, st) in strips.iter_mut().enumerate().take(MAX_TRACKS) {
            if runs & (1u32 << ch) == 0 {
                st.count_hold(len);
                continue;
            }
            let Some(src) = tracks.span(ch, from, to) else { continue };
            if !buses.load(src, from, to) {
                continue;
            }
            let muted = st.flag(P_MUTE) || (solo && !st.flag(P_SOLO));
            if st.fresh {
                st.gate.snap(if muted { 0.0 } else { 1.0 });
            } else if st.hold == 0 {
                st.gate.set(if muted { 0.0 } else { 1.0 });
            }
            buses.eq(st, from, to);
            let key = match st.key {
                Key::None => None,
                Key::Track(s) => Some(tracks.span(s, from, to)),
                Key::Row(s, r) => {
                    let k = row_keys.get(s).and_then(|rk| rk.get(r)).copied().unwrap_or(NO_KEY);
                    Some(if k == NO_KEY { None } else { keys.span(k as usize, from, to) })
                }
            };
            buses.comp(st, key, from, to);
            let (pl, pr) = buses.mix_out(st, from, to, true, tap.span(ch, from, to));
            let gr = if st.comp_ins.idle { 0.0 } else { st.comp.gain_reduction_db() };
            write_meter(meters, ch, pl, pr, gr);
            st.count_hold(len);
            st.fresh = false;
        }

        // Returns: send bus -> effect (100% wet) -> EQ -> fader/pan/mute.
        for ch in [MIX_RETURN0, MIX_RETURN0 + 1] {
            let Some(st) = strips.get_mut(ch) else { continue };
            let bus = if ch == MIX_RETURN0 { &buses.send_a } else { &buses.send_b };
            let (Some((wl, wr)), Some((bl, br))) = (buses.work.pair_mut(0, from, to), bus.span(0, from, to)) else {
                continue;
            };
            wl.copy_from_slice(bl);
            wr.copy_from_slice(br);
            if ch == MIX_RETURN0 {
                reverb.process(wl, wr);
            } else {
                delay.process(wl, wr);
            }
            st.gate.set(if st.flag(P_MUTE) { 0.0 } else { 1.0 });
            buses.eq(st, from, to);
            let (pl, pr) = buses.mix_out(st, from, to, false, tap.span(ch, from, to));
            write_meter(meters, ch, pl, pr, 0.0);
        }

        // Master: bus x legacy gain -> EQ -> fader -> limiter -> out.
        let Some(st) = strips.get_mut(MIX_MASTER) else { return };
        if let (Some((wl, wr)), Some((bl, br))) = (buses.work.pair_mut(0, from, to), buses.master.span(0, from, to)) {
            for i in 0..len {
                let g = master_gain.next();
                wl[i] = bl[i] * g;
                wr[i] = br[i] * g;
            }
        }
        buses.eq(st, from, to);
        let (Some(ol), Some(or)) = (out_l.get_mut(from..to), out_r.get_mut(from..to)) else { return };
        if let Some((wl, wr)) = buses.work.span(0, from, to) {
            for i in 0..len {
                // The master has no pan: gl and gr carry the same fader gain.
                let g = st.gl.next();
                st.gr.next();
                ol[i] = wl[i] * g;
                or[i] = wr[i] * g;
            }
        }
        limiter.process(ol, or);
        write_meter(meters, MIX_MASTER, 0.0, 0.0, limiter.gain_reduction_db());
    }
}

/// The strip tap for one block: the tapped channel and its buffers (empty
/// while off, so nothing is ever written then).
struct Tap<'a> {
    ch: i32,
    l: &'a mut [f32],
    r: &'a mut [f32],
}

impl Tap<'_> {
    /// Frames `from..to` of the tap if `ch` is the tapped channel.
    fn span(&mut self, ch: usize, from: usize, to: usize) -> Option<(&mut [f32], &mut [f32])> {
        if self.ch != ch as i32 {
            return None;
        }
        Some((self.l.get_mut(from..to)?, self.r.get_mut(from..to)?))
    }
}

/// What every chunk of one block shares (see `Mixer::process`).
struct Block<'a> {
    tracks: &'a StereoBufs,
    keys: &'a StereoBufs,
    /// Bit = a track strip that runs this block.
    runs: u32,
    solo: bool,
}

/// Where [`soft_clip`] leaves linear (as a fraction of the ceiling).
pub const SOFT_KNEE: f32 = 0.9;

/// The click's safety shaper (used by [`ClickClip`] only around clicks):
/// bit-transparent while `|x| ≤ SOFT_KNEE·ceiling`, above that a tanh knee
/// with slope 1 at the knee (continuous value and slope, so no corner) that
/// approaches but never exceeds `ceiling`. Monotonic, odd. A non-finite input
/// (NaN, and also +-inf) is returned unchanged rather than turned into a
/// full-scale +-ceiling sample; the engine's is_finite backstop then zeroes it.
#[inline]
pub fn soft_clip(x: f32, ceiling: f32) -> f32 {
    if !x.is_finite() {
        return x;
    }
    let k = SOFT_KNEE * ceiling;
    let a = x.abs();
    if a <= k {
        return x;
    }
    let room = ceiling - k;
    let y = k + room * ((a - k) / room).tanh();
    // tanh rounds to 1.0 for large inputs: keep strictly within the ceiling.
    y.min(ceiling).copysign(x)
}

/// How long [`ClickClip`] keeps shaping after the click ends (seconds).
pub const CLICK_CLIP_RELEASE_SECONDS: f32 = 0.005;

/// The post-limiter stage that adds the (latency-delayed) click to the
/// limited mix: `out = mix + w·(soft_clip(mix + click) − mix)`, where `w` is
/// a click-activity envelope. `w` rises linearly over the limiter latency
/// while the *incoming* (undelayed) click plays, so it reaches 1 as the
/// delayed click arrives (the ring is a lookahead: no step at the onset),
/// holds at 1 while the delayed click is non-zero, then falls linearly to
/// exactly 0 over [`CLICK_CLIP_RELEASE_SECONDS`]. With `w == 0` (metronome
/// off, or between clicks) the limiter output passes bit for bit, so a
/// limited mix reaches the ceiling and is never coloured by the tanh knee.
/// Both outputs are convex blends of values within ±ceiling (the limited mix
/// and the soft clip), so the result stays under the ceiling.
pub struct ClickClip {
    w: f32,
    attack: f32,
    release: f32,
}

impl ClickClip {
    /// `latency`: the limiter lookahead in samples (the click's delay).
    pub fn new(sr: f32, latency: usize) -> ClickClip {
        let release = (CLICK_CLIP_RELEASE_SECONDS * sr).max(1.0);
        ClickClip { w: 0.0, attack: 1.0 / latency.max(1) as f32, release: 1.0 / release }
    }

    /// One stereo frame: the limited mix `(l, r)`, the delayed click
    /// `(cl, cr)` (already at its gain), whether the incoming click is
    /// sounding, and the limiter ceiling.
    #[inline]
    pub fn next(&mut self, l: f32, r: f32, cl: f32, cr: f32, incoming: bool, ceiling: f32) -> (f32, f32) {
        if cl != 0.0 || cr != 0.0 {
            self.w = 1.0;
        } else if incoming {
            self.w = (self.w + self.attack).min(1.0);
        } else {
            self.w = (self.w - self.release).max(0.0);
        }
        let w = self.w;
        if w == 0.0 {
            return (l, r);
        }
        let (sl, sr) = (soft_clip(l + cl, ceiling), soft_clip(r + cr, ceiling));
        if w >= 1.0 {
            return (sl, sr);
        }
        // Rounding of the blend could step an ulp past ±ceiling: clamp.
        let blend = |x: f32, s: f32| (x + w * (s - x)).clamp(-ceiling, ceiling);
        (blend(l, sl), blend(r, sr))
    }
}

/// A chunk's peaks into the block's meters (`process` zeroes them first;
/// peaks are >= 0, so a whole-block chunk writes them unchanged), and its
/// gain reduction (the block's last chunk wins).
fn write_meter(meters: &mut [f32], ch: usize, pl: f32, pr: f32, gr: f32) {
    if let Some(m) = meters.get_mut(ch * MIX_METER_STRIDE..(ch + 1) * MIX_METER_STRIDE) {
        m[0] = m[0].max(pl);
        m[1] = m[1].max(pr);
        m[2] = gr;
    }
}

impl Buses {
    /// Copy `src` (frames `from..to`) into the work buffer.
    fn load(&mut self, src: (&[f32], &[f32]), from: usize, to: usize) -> bool {
        let Some((wl, wr)) = self.work.pair_mut(0, from, to) else { return false };
        wl.copy_from_slice(src.0);
        wr.copy_from_slice(src.1);
        true
    }

    /// The strip's EQ insert on the work buffer.
    fn eq(&mut self, st: &mut Strip, from: usize, to: usize) {
        let (Some(work), Some(dry)) = (self.work.pair_mut(0, from, to), self.dry.pair_mut(0, from, to)) else { return };
        run_insert(&mut st.eq_ins, &mut st.eq, work, dry, |eq, l, r| eq.process(l, r), Eq3::reset);
    }

    /// The strip's compressor insert on the work buffer. `key` is `None`
    /// for a self-keyed strip and `Some(source)` for an external key, whose
    /// buffer is always there in practice (a missing one keys from silence,
    /// never from the strip itself).
    #[allow(clippy::option_option)]
    fn comp(&mut self, st: &mut Strip, key: Option<Option<(&[f32], &[f32])>>, from: usize, to: usize) {
        let (Some(work), Some(dry)) = (self.work.pair_mut(0, from, to), self.dry.pair_mut(0, from, to)) else { return };
        run_insert(
            &mut st.comp_ins,
            &mut st.comp,
            work,
            dry,
            |c, l, r| match key {
                None => c.process_self(l, r),
                Some(Some((kl, kr))) => c.process(l, r, kl, kr),
                Some(None) => c.process(l, r, &[], &[]),
            },
            Compressor::reset,
        );
    }

    /// Fader·pan and gate on the work buffer into the master bus, plus (for
    /// tracks) the sends, and into `tap` (the strip tap) when given. Returns
    /// the post-fader peaks.
    fn mix_out(
        &mut self,
        st: &mut Strip,
        from: usize,
        to: usize,
        sends: bool,
        mut tap: Option<(&mut [f32], &mut [f32])>,
    ) -> (f32, f32) {
        let pre_a = st.flag(P_SEND_A_PRE);
        let pre_b = st.flag(P_SEND_B_PRE);
        let Buses { master, send_a, send_b, work, .. } = self;
        let (Some((wl, wr)), Some((ml, mr)), Some((al, ar)), Some((bl, br))) = (
            work.span(0, from, to),
            master.pair_mut(0, from, to),
            send_a.pair_mut(0, from, to),
            send_b.pair_mut(0, from, to),
        ) else {
            return (0.0, 0.0);
        };
        let n = to - from;
        let use_a = sends && !st.send_a.rests_at(0.0);
        let use_b = sends && !st.send_b.rests_at(0.0);
        let (mut pl, mut pr) = (0.0f32, 0.0f32);
        for i in 0..n {
            let (x, y) = (wl[i], wr[i]);
            let g = st.gate.next();
            let l = x * st.gl.next() * g;
            let r = y * st.gr.next() * g;
            pl = pl.max(l.abs());
            pr = pr.max(r.abs());
            ml[i] += l;
            mr[i] += r;
            // The strip tap reads the values the master bus just got.
            if let Some((tl, tr)) = &mut tap {
                if let (Some(a), Some(b)) = (tl.get_mut(i), tr.get_mut(i)) {
                    (*a, *b) = (l, r);
                }
            }
            // Post-fader taps `l`/`r`, which already carry the gate; a
            // pre-fader tap applies the gate itself (once either way).
            if use_a {
                let s = st.send_a.next();
                let (u, v) = if pre_a { (x * g, y * g) } else { (l, r) };
                al[i] += u * s;
                ar[i] += v * s;
            }
            if use_b {
                let s = st.send_b.next();
                let (u, v) = if pre_b { (x * g, y * g) } else { (l, r) };
                bl[i] += u * s;
                br[i] += v * s;
            }
        }
        (pl, pr)
    }
}
