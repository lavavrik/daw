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
//! * Delay, Reverb and Chorus hold an FX-pool slot index (`fx_pool.rs`), not
//!   memory: `process` gets the shared [`FxPool`] and borrows the slot's
//!   memory from it for the call. Other modules ignore the pool.

pub mod adsr;
pub mod attenuator;
pub mod chorus;
pub mod compressor;
pub mod delay;
pub mod eq;
pub mod filter;
pub mod lfo;
pub mod midi_in;
pub mod mixer;
pub mod noise;
pub mod osc;
pub mod out;
pub mod reverb;
pub mod saturator;
pub mod vca;

use super::catalog::{spec, ModuleKind};
use super::fx_pool::{FxKind, FxPool, NO_SLOT};
use super::port::PortBuf;
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
            ModuleKind::MidiIn => Module::MidiIn(midi_in::MidiIn::new(sr)),
            ModuleKind::Osc => Module::Osc(osc::Osc::new(sr)),
            ModuleKind::Noise => Module::Noise(noise::Noise::new(sr)),
            ModuleKind::Filter => Module::Filter(filter::Filter::new(sr)),
            ModuleKind::Mixer => Module::Mixer(mixer::Mixer::new(sr)),
            ModuleKind::Adsr => Module::Adsr(adsr::Adsr::new(sr)),
            ModuleKind::Vca => Module::Vca(vca::Vca::new(sr)),
            ModuleKind::Lfo => Module::Lfo(lfo::Lfo::new(sr)),
            ModuleKind::Out => Module::Out(out::Out::new(sr)),
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
        }
    }

    /// The FX-pool slot this module holds (pooled kinds with a slot only).
    pub fn fx_slot(&self) -> Option<(FxKind, u8)> {
        let (kind, slot) = match self {
            Module::Delay(m) => (FxKind::Delay, m.slot()),
            Module::Reverb(m) => (FxKind::Reverb, m.slot()),
            Module::Chorus(m) => (FxKind::Chorus, m.slot()),
            _ => return None,
        };
        (slot != NO_SLOT).then_some((kind, slot))
    }

    /// Render one sub-block (see the module contract above).
    pub fn process(&mut self, ctx: &Ctx, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf], fx: &mut FxPool) {
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
        }
    }

    /// Deliver a note event (with the module's current param values, which
    /// MIDI In needs for `voices`/`mode`). A no-op for everything except
    /// MIDI In.
    pub fn note(&mut self, ev: NoteEvent, params: &[f32]) {
        if let Module::MidiIn(m) = self {
            m.note(ev, params);
        }
    }

    /// Clear DSP state (phases, filter memories, held notes) without changing
    /// params. (A pooled module's ring is the pool's: it is zeroed when the
    /// slot is reused, not here.)
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

/// Smoothing time constant for `smooth` params.
pub const SMOOTH_SECONDS: f32 = 0.005;

/// Per-sample one-pole smoother (time constant `SMOOTH_SECONDS`) for a
/// `smooth` param. Starts at the param's default, so a fresh module does not
/// glide in from 0.
#[derive(Clone, Copy, Debug)]
pub struct Smooth {
    value: f32,
    coef: f32,
}

impl Smooth {
    pub fn new(sr: f32, initial: f32) -> Smooth {
        Smooth::with_time(sr, SMOOTH_SECONDS, initial)
    }

    /// A smoother with time constant `seconds` (e.g. the LFO's output slew).
    pub fn with_time(sr: f32, seconds: f32, initial: f32) -> Smooth {
        let sr = if sr.is_finite() && sr > 0.0 { sr } else { 48000.0 };
        Smooth { value: initial, coef: 1.0 - (-1.0 / (seconds.max(1e-6) * sr)).exp() }
    }

    /// Advance one sample toward `target` and return the smoothed value.
    /// Snaps once within 1e-6 of the target (also the denormal guard).
    #[inline]
    pub fn next(&mut self, target: f32) -> f32 {
        let d = target - self.value;
        if d.abs() < 1e-6 || !d.is_finite() {
            self.value = if target.is_finite() { target } else { self.value };
        } else {
            self.value += d * self.coef;
        }
        self.value
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
