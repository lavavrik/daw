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

pub mod adsr;
pub mod filter;
pub mod lfo;
pub mod midi_in;
pub mod mixer;
pub mod noise;
pub mod osc;
pub mod out;
pub mod vca;

use super::catalog::{spec, ModuleKind};
use super::port::PortBuf;

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
/// size by design: boxing the big ones would allocate on `add_module`.
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
}

impl Module {
    /// A fresh module with its params' smoothers at the catalog defaults.
    pub fn new(kind: ModuleKind, sr: f32) -> Module {
        match kind {
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
        }
    }

    /// Render one sub-block (see the module contract above).
    pub fn process(&mut self, ctx: &Ctx, params: &[f32], ins: &[PortBuf], outs: &mut [PortBuf]) {
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
    /// params.
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
        }
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
