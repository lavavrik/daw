//! Rack modules: the DSP behind each `ModuleKind`.
//!
//! Contract for every module (the audio thread must never allocate, block or
//! panic):
//! * `process` renders exactly one sub-block (`RACK_BLOCK` frames). `ins` holds
//!   one `PortBuf` per catalog input (an unconnected input has
//!   `channels == 0`), `outs` one per catalog output, and `params` the target
//!   values in catalog order (already validated by the rack). Modules must
//!   tolerate shorter slices than expected (they then output nothing) and
//!   never index out of bounds.
//! * Each output's `channels` must be set every call (the poly rule: the
//!   maximum over the connected inputs, minimum 1; see `port::poly`).
//! * Params marked `smooth` in the catalog are smoothed per sample with
//!   [`Smooth`] (5 ms one-pole), so knob moves never click.
//! * Outputs must be finite; DSP state below 1e-20 is flushed to 0.
//! * Delay, Reverb, Chorus and Scope hold an FX-pool slot index
//!   (`fx_pool.rs`), not memory: `process` gets the shared [`FxPool`] and
//!   borrows the slot's memory from it for the call. Other modules ignore
//!   the pool.
//! * The Sample Player reads the engine's sample pool through the
//!   [`SampleView`] `process` also gets (read-only; others ignore it).

pub mod accent;
pub mod adsr;
pub mod arp;
pub mod attenuator;
pub mod chord;
pub mod chorus;
pub mod compressor;
pub mod delay;
pub mod eq;
pub mod filter;
pub mod formant;
pub mod lfo;
pub mod midi_in;
pub mod mixer;
pub mod noise;
pub mod osc;
pub mod out;
pub mod reverb;
pub mod sample_player;
pub mod saturator;
pub mod scope;
pub mod theory;
pub mod vca;

use super::catalog::{spec, ModuleKind};
use super::fx_pool::{FxKind, FxPool, NO_SLOT};
use super::port::PortBuf;
use crate::samples::SampleView;
use crate::RACK_BLOCK;

/// Timing context for one sub-block.
#[derive(Clone, Copy, Debug)]
pub struct Ctx {
    pub sr: f32,
    pub bpm: f32,
    pub playing: bool,
    /// Transport position (ticks) at the start of this sub-block.
    pub ticks: f64,
    /// Ticks advanced per frame while playing (`bpm * PPQ / (60 * sr)`).
    pub ticks_per_frame: f64,
}

/// Note/controller events delivered to MIDI In modules.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NoteEvent {
    On { note: u8, vel: u8 },
    Off { note: u8 },
    /// Pitch bend, -1..1 (scaled by the module's bend range).
    Bend(f32),
    /// Mod wheel, 0..1.
    Mod(f32),
    Sustain(bool),
    AllOff,
}

/// Capacity of a [`NoteBuf`]. The worst cases: one event through the Chord
/// makes at most 10 (the old chord's 5 Offs, the new one's 5 Ons) and the Arp
/// passes each on as at most one, plus one Off of its sounding note; an Arp
/// tick makes at most 2 per loop pass (8 passes). A Chord's flush on removal
/// (up to 128 Offs) goes out in chunks of `chord::FLUSH_CHUNK` (24), which fit
/// through the Arp.
pub const NOTE_BUF: usize = 48;

/// A fixed buffer of note events: what a note module (Chord, Arp) hands to
/// the next stage of the rack's note path (`Rack::note`). Allocation-free;
/// every producer stays within `NOTE_BUF` (see there), so `push` past the
/// capacity, which would drop the event, never happens.
#[derive(Clone, Copy)]
pub struct NoteBuf {
    evs: [NoteEvent; NOTE_BUF],
    n: usize,
}

impl Default for NoteBuf {
    fn default() -> Self {
        Self::new()
    }
}

impl NoteBuf {
    pub const fn new() -> NoteBuf {
        NoteBuf { evs: [NoteEvent::AllOff; NOTE_BUF], n: 0 }
    }

    pub fn push(&mut self, ev: NoteEvent) {
        if let Some(e) = self.evs.get_mut(self.n) {
            *e = ev;
            self.n += 1;
        }
    }

    pub fn as_slice(&self) -> &[NoteEvent] {
        &self.evs[..self.n]
    }
}

/// A module instance. Fixed-size (no heap), so racks store them inline in
/// preallocated slots and adding a module never allocates. Variants differ in
/// size by design: boxing the big ones would allocate on `add_module`. The
/// effects with big rings (Delay, Reverb, Chorus) keep them in the FX pool.
#[allow(clippy::large_enum_variant)]
#[derive(Clone)]
pub enum Module {
    MidiIn(midi_in::MidiIn),
    Osc(osc::Osc),
    Noise(noise::Noise),
    Filter(filter::Filter),
    Adsr(adsr::Adsr),
    Vca(vca::Vca),
    Lfo(lfo::Lfo),
    Mixer(mixer::Mixer),
    Out(out::Out),
    Delay(delay::Delay),
    Reverb(reverb::Reverb),
    Chorus(chorus::Chorus),
    Eq(eq::Eq),
    Compressor(compressor::Compressor),
    Saturator(saturator::Saturator),
    Attenuator(attenuator::Attenuator),
    SamplePlayer(sample_player::SamplePlayer),
    Formant(formant::Formant),
    Scope(scope::Scope),
    Accent(accent::Accent),
    /// Note modules (plan 26): no jacks, no audio; the rack routes the note
    /// stream through them (`Rack::note`, `Rack::render_sub`).
    Chord(chord::Chord),
    Arp(arp::Arp),
}

impl Module {
    /// A fresh module with its params' smoothers at the catalog defaults.
    /// Pooled kinds (Delay, Reverb, Chorus) get no slot and render only
    /// their dry signal; the rack uses [`with_fx_slot`](Module::with_fx_slot).
    pub fn new(kind: ModuleKind, sr: f32) -> Module {
        Module::with_fx_slot(kind, sr, NO_SLOT)
    }

    /// [`new`](Module::new), with FX-pool slot `slot` (of
    /// `kind.fx_kind()`) for the pooled kinds; ignored by the others.
    pub fn with_fx_slot(kind: ModuleKind, sr: f32, slot: u8) -> Module {
        match kind {
            ModuleKind::Delay => Module::Delay(delay::Delay::new(sr, slot)),
            ModuleKind::Reverb => Module::Reverb(reverb::Reverb::new(sr, slot)),
            ModuleKind::Chorus => Module::Chorus(chorus::Chorus::new(sr, slot)),
            ModuleKind::Eq => Module::Eq(eq::Eq::new(sr)),
            ModuleKind::Compressor => Module::Compressor(compressor::Compressor::new(sr)),
            ModuleKind::Saturator => Module::Saturator(saturator::Saturator::new(sr)),
            ModuleKind::Attenuator => Module::Attenuator(attenuator::Attenuator::new(sr)),
            ModuleKind::SamplePlayer => Module::SamplePlayer(sample_player::SamplePlayer::new(sr)),
            ModuleKind::Formant => Module::Formant(formant::Formant::new(sr)),
            ModuleKind::MidiIn => Module::MidiIn(midi_in::MidiIn::new(sr)),
            ModuleKind::Osc => Module::Osc(osc::Osc::new(sr)),
            ModuleKind::Noise => Module::Noise(noise::Noise::new(sr)),
            ModuleKind::Filter => Module::Filter(filter::Filter::new(sr)),
            ModuleKind::Mixer => Module::Mixer(mixer::Mixer::new(sr)),
            ModuleKind::Adsr => Module::Adsr(adsr::Adsr::new(sr)),
            ModuleKind::Vca => Module::Vca(vca::Vca::new(sr)),
            ModuleKind::Lfo => Module::Lfo(lfo::Lfo::new(sr)),
            ModuleKind::Out => Module::Out(out::Out::new(sr)),
            ModuleKind::Scope => Module::Scope(scope::Scope::new(sr, slot)),
            ModuleKind::Accent => Module::Accent(accent::Accent::new(sr)),
            ModuleKind::Chord => Module::Chord(chord::Chord::new()),
            ModuleKind::Arp => Module::Arp(arp::Arp::new()),
        }
    }

    /// Make the next sub-block take every `smooth` param at its target at
    /// once (automation on a silent rack; see `Rack::automate`).
    pub fn snap(&mut self) {
        match self {
            Module::MidiIn(_)
            | Module::Chorus(_)
            | Module::Eq(_)
            | Module::Compressor(_)
            | Module::Scope(_)
            | Module::Chord(_)
            | Module::Arp(_) => {}
            Module::Osc(m) => m.snap(),
            Module::Noise(m) => m.snap(),
            Module::Filter(m) => m.snap(),
            Module::Mixer(m) => m.snap(),
            Module::Adsr(m) => m.snap(),
            Module::Vca(m) => m.snap(),
            Module::Lfo(m) => m.snap(),
            Module::Out(m) => m.snap(),
            Module::Delay(m) => m.snap(),
            Module::Reverb(m) => m.snap(),
            Module::Saturator(m) => m.snap(),
            Module::Attenuator(m) => m.snap(),
            Module::SamplePlayer(m) => m.snap(),
            Module::Formant(m) => m.snap(),
            Module::Accent(m) => m.snap(),
        }
    }

    pub fn kind(&self) -> ModuleKind {
        match self {
            Module::MidiIn(_) => ModuleKind::MidiIn,
            Module::Osc(_) => ModuleKind::Osc,
            Module::Noise(_) => ModuleKind::Noise,
            Module::Filter(_) => ModuleKind::Filter,
            Module::Mixer(_) => ModuleKind::Mixer,
            Module::Adsr(_) => ModuleKind::Adsr,
            Module::Vca(_) => ModuleKind::Vca,
            Module::Lfo(_) => ModuleKind::Lfo,
            Module::Out(_) => ModuleKind::Out,
            Module::Delay(_) => ModuleKind::Delay,
            Module::Reverb(_) => ModuleKind::Reverb,
            Module::Chorus(_) => ModuleKind::Chorus,
            Module::Eq(_) => ModuleKind::Eq,
            Module::Compressor(_) => ModuleKind::Compressor,
            Module::Saturator(_) => ModuleKind::Saturator,
            Module::Attenuator(_) => ModuleKind::Attenuator,
            Module::SamplePlayer(_) => ModuleKind::SamplePlayer,
            Module::Formant(_) => ModuleKind::Formant,
            Module::Scope(_) => ModuleKind::Scope,
            Module::Accent(_) => ModuleKind::Accent,
            Module::Chord(_) => ModuleKind::Chord,
            Module::Arp(_) => ModuleKind::Arp,
        }
    }

    /// The FX-pool slot this module holds (pooled kinds with a slot only).
    pub fn fx_slot(&self) -> Option<(FxKind, u8)> {
        let (kind, slot) = match self {
            Module::Delay(m) => (FxKind::Delay, m.slot()),
            Module::Reverb(m) => (FxKind::Reverb, m.slot()),
            Module::Chorus(m) => (FxKind::Chorus, m.slot()),
            Module::Scope(m) => (FxKind::Scope, m.slot()),
            _ => return None,
        };
        (slot != NO_SLOT).then_some((kind, slot))
    }

    /// Render one sub-block (see the module contract above).
    pub fn process(
        &mut self,
        ctx: &Ctx,
        params: &[f32],
        ins: &[PortBuf],
        outs: &mut [PortBuf],
        fx: &mut FxPool,
        smp: SampleView,
    ) {
        match self {
            Module::MidiIn(m) => m.process(params, outs),
            Module::Osc(m) => m.process(params, ins, outs),
            Module::Noise(m) => m.process(params, outs),
            Module::Filter(m) => m.process(params, ins, outs),
            Module::Mixer(m) => m.process(params, ins, outs),
            Module::Adsr(m) => m.process(params, ins, outs),
            Module::Vca(m) => m.process(params, ins, outs),
            Module::Lfo(m) => m.process(ctx, params, outs),
            Module::Out(m) => m.process(params, ins),
            Module::Delay(m) => m.process(ctx, params, ins, outs, fx),
            Module::Reverb(m) => m.process(params, ins, outs, fx),
            Module::Chorus(m) => m.process(params, ins, outs, fx),
            Module::Eq(m) => m.process(params, ins, outs),
            Module::Compressor(m) => m.process(params, ins, outs),
            Module::Saturator(m) => m.process(params, ins, outs),
            Module::Attenuator(m) => m.process(params, ins, outs),
            Module::SamplePlayer(m) => m.process(params, ins, outs, smp),
            Module::Formant(m) => m.process(params, ins, outs),
            Module::Scope(m) => m.process(ctx, params, ins, fx),
            Module::Accent(m) => m.process(params, ins, outs),
            // No outputs: their work is in the rack's note path.
            Module::Chord(_) | Module::Arp(_) => {}
        }
    }

    /// Deliver a note event (with the module's current param values, which
    /// MIDI In needs for `voices`/`mode`). A no-op for everything except
    /// MIDI In (Chord and Arp get theirs from `Rack::note`, before this).
    pub fn note(&mut self, ev: NoteEvent, params: &[f32]) {
        if let Module::MidiIn(m) = self {
            m.note(ev, params);
        }
    }

    /// Clear DSP state (phases, filter memories, held notes, sample voices)
    /// without changing params. A pooled module (Delay, Reverb, Chorus) cannot
    /// zero its ring here (the memory is the pool's): it marks it, and its
    /// next `process` restarts the slot's zeroing (`FxPool::reassign`), so its
    /// wet signal is silent until the ring is clean and the old tail never
    /// plays again. The rack resets a module that takes over a slot on
    /// replace (`Rack::add_module`).
    pub fn reset(&mut self) {
        match self {
            Module::MidiIn(m) => m.reset(),
            Module::Osc(m) => m.reset(),
            Module::Noise(m) => m.reset(),
            Module::Filter(m) => m.reset(),
            Module::Mixer(_) => {}
            Module::Adsr(m) => m.reset(),
            Module::Vca(_) => {}
            Module::Lfo(m) => m.reset(),
            Module::Out(m) => m.reset(),
            Module::Delay(m) => m.reset(),
            Module::Reverb(m) => m.reset(),
            Module::Chorus(m) => m.reset(),
            Module::Eq(m) => m.reset(),
            Module::Compressor(m) => m.reset(),
            Module::Saturator(m) => m.reset(),
            Module::Attenuator(_) => {}
            Module::SamplePlayer(m) => m.reset(),
            Module::Formant(m) => m.reset(),
            Module::Scope(m) => m.reset(),
            Module::Accent(m) => m.reset(),
            Module::Chord(m) => m.reset(),
            Module::Arp(m) => m.reset(),
        }
    }
}

/// Sum every channel of `p` into `out` (an unconnected port gives 0s).
/// Non-finite samples count as 0.
pub(crate) fn mono_sum(p: &PortBuf, out: &mut [f32; RACK_BLOCK]) {
    *out = [0.0; RACK_BLOCK];
    for row in p.data.iter().take(p.channels) {
        for (o, &x) in out.iter_mut().zip(row) {
            if x.is_finite() {
                *o += x;
            }
        }
    }
}

/// The stereo effects' input rule: `ins[0]` (`l`) and `ins[1]` (`r`), each
/// summed to one channel; `r` falls back to `l` when unconnected.
pub(crate) fn stereo_in(ins: &[PortBuf]) -> ([f32; RACK_BLOCK], [f32; RACK_BLOCK]) {
    let mut l = [0.0; RACK_BLOCK];
    if let Some(p) = ins.first() {
        mono_sum(p, &mut l);
    }
    let r = match ins.get(1).filter(|p| p.channels > 0) {
        Some(p) => {
            let mut r = [0.0; RACK_BLOCK];
            mono_sum(p, &mut r);
            r
        }
        None => l,
    };
    (l, r)
}

/// Write 1-channel `l`/`r` into `outs[0]`/`outs[1]` (whichever exist).
pub(crate) fn write_stereo(outs: &mut [PortBuf], l: &[f32; RACK_BLOCK], r: &[f32; RACK_BLOCK]) {
    for (o, src) in outs.iter_mut().zip([l, r]) {
        o.channels = 1;
        o.data[0] = *src;
    }
}

/// An FX-pool slot as a pooled module (Delay, Reverb, Chorus) holds it: the
/// slot index, and whether the slot must be re-zeroed before its next use
/// (the module was reset, so stale ring content must never play).
#[derive(Clone, Copy)]
pub(crate) struct PoolSlot {
    kind: FxKind,
    slot: u8,
    rezero: bool,
}

impl PoolSlot {
    pub(crate) fn new(kind: FxKind, slot: u8) -> PoolSlot {
        PoolSlot { kind, slot, rezero: false }
    }

    pub(crate) fn slot(&self) -> u8 {
        self.slot
    }

    /// The next [`buffer`](PoolSlot::buffer) restarts the slot's zeroing
    /// (`FxPool::reassign`, in bounded steps; silent wet signal meanwhile).
    pub(crate) fn rezero(&mut self) {
        self.rezero = true;
    }

    /// Borrow the slot's memory for this sub-block; `None` while the pool is
    /// still zeroing it (or without a slot).
    pub(crate) fn buffer<'a>(&mut self, fx: &'a mut FxPool) -> Option<&'a mut [f32]> {
        if std::mem::take(&mut self.rezero) {
            fx.reassign(self.kind, self.slot);
        }
        fx.buffer(self.kind, self.slot)
    }

    /// [`buffer`](PoolSlot::buffer) for a scope slot: its ring and header.
    pub(crate) fn scope<'a>(&mut self, fx: &'a mut FxPool) -> Option<(&'a mut [f32], &'a mut [i32])> {
        if std::mem::take(&mut self.rezero) {
            fx.reassign(self.kind, self.slot);
        }
        fx.scope(self.slot)
    }
}

/// A wet-only DSP core whose memory is an FX-pool slot (the mixer's
/// [`DelayCore`](crate::dsp::DelayCore) and [`ReverbCore`](crate::dsp::ReverbCore)).
pub(crate) trait PooledCore {
    /// Replace `l`/`r` (the dry input) by the wet signal, with `buf` as memory.
    fn wet(&mut self, buf: &mut [f32], l: &mut [f32], r: &mut [f32]);
    /// Clear the DSP state (not the memory).
    fn clear(&mut self);
}

impl PooledCore for crate::dsp::DelayCore {
    fn wet(&mut self, buf: &mut [f32], l: &mut [f32], r: &mut [f32]) {
        self.process(buf, l, r);
    }
    fn clear(&mut self) {
        self.reset();
    }
}

impl PooledCore for crate::dsp::ReverbCore {
    fn wet(&mut self, buf: &mut [f32], l: &mut [f32], r: &mut [f32]) {
        self.process(buf, l, r);
    }
    fn clear(&mut self) {
        self.reset();
    }
}

/// The body shared by the Delay and Reverb modules (their params already set
/// on `core`): the stereo input (`stereo_in`), the wet signal from `core` on
/// the slot's memory (silent, with the core cleared, while the slot is being
/// zeroed or missing), then `out = dry + mix·(wet − dry)` with `mix` smoothed
/// per sample toward `mix_target`, written as 1-channel `l`/`r`.
pub(crate) fn pooled_dry_wet(
    core: &mut impl PooledCore,
    pool: &mut PoolSlot,
    fx: &mut FxPool,
    mix: &mut Smooth,
    mix_target: f32,
    ins: &[PortBuf],
    outs: &mut [PortBuf],
) {
    let (dry_l, dry_r) = stereo_in(ins);
    let (mut wl, mut wr) = (dry_l, dry_r);
    match pool.buffer(fx) {
        Some(buf) => core.wet(buf, &mut wl, &mut wr),
        None => {
            (wl, wr) = ([0.0; RACK_BLOCK], [0.0; RACK_BLOCK]);
            core.clear();
        }
    }
    for i in 0..RACK_BLOCK {
        let m = mix.next(mix_target);
        wl[i] = dry_l[i] + m * (wl[i] - dry_l[i]);
        wr[i] = dry_r[i] + m * (wr[i] - dry_r[i]);
    }
    write_stereo(outs, &wl, &wr);
}

/// Smoothing time constant for `smooth` params.
pub const SMOOTH_SECONDS: f32 = 0.005;

/// Per-sample one-pole smoother (time constant `SMOOTH_SECONDS`) for a
/// `smooth` param. Starts at the param's default, so a fresh module does not
/// glide in from 0.
#[derive(Clone, Copy, Debug)]
pub struct Smooth {
    value: f32,
    coef: f32,
    /// The next `next` jumps to its target instead of gliding.
    snap: bool,
}

impl Smooth {
    pub fn new(sr: f32, initial: f32) -> Smooth {
        Smooth::with_time(sr, SMOOTH_SECONDS, initial)
    }

    /// A smoother with time constant `seconds` (e.g. the LFO's output slew).
    pub fn with_time(sr: f32, seconds: f32, initial: f32) -> Smooth {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        Smooth { value: initial, coef: 1.0 - (-1.0 / (seconds.max(1e-6) * sr)).exp(), snap: false }
    }

    /// Advance one sample toward `target` and return the smoothed value.
    /// Snaps once within 1e-6 of the target (also the denormal guard).
    #[inline]
    pub fn next(&mut self, target: f32) -> f32 {
        if self.snap {
            self.snap = false;
            if target.is_finite() {
                self.value = target;
                return target;
            }
        }
        let d = target - self.value;
        if d.abs() < 1e-6 || !d.is_finite() {
            self.value = if target.is_finite() { target } else { self.value };
        } else {
            self.value += d * self.coef;
        }
        self.value
    }

    /// Skip the glide: the next `next(target)` returns `target`.
    pub fn snap(&mut self) {
        self.snap = true;
    }

    pub fn value(&self) -> f32 {
        self.value
    }
}

/// Catalog default of `kind`'s param `i` (0.0 if there is no such param).
/// Modules read defaults from here instead of repeating the catalog's numbers.
pub(crate) fn default(kind: ModuleKind, i: usize) -> f32 {
    spec(kind).params.get(i).map_or(0.0, |p| p.default)
}

/// Param `i` from the rack's slice, or its catalog default if the slice is
/// short.
#[inline]
pub(crate) fn param(params: &[f32], kind: ModuleKind, i: usize) -> f32 {
    params.get(i).copied().unwrap_or_else(|| default(kind, i))
}
