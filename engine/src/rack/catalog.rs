//! The module catalog: every module kind's ports and params, as static tables.
//!
//! This is the single source of truth for module definitions. The rack uses it
//! to validate edits (port counts, param ranges), and `catalog_json()` exports
//! it to `engine/catalog.json`, which the UI imports (it never hand-copies a
//! module, port or param definition). The golden test `catalog_matches_golden`
//! fails when the file is stale; regenerate it with
//! `UPDATE_CATALOG=1 cargo test -p daw-engine catalog`.
//!
//! Param and port *indices* are positions in these tables, so the order of
//! entries is part of the engine <-> UI protocol: append, never reorder.

use super::fx_pool::{FxKind, CHORUS_SLOTS, DELAY_SLOTS, REVERB_SLOTS};
use crate::mixer::catalog::{DELAY_DEFAULT_DIVISION, DELAY_DIVISIONS};
use crate::{MAX_MODULES, MAX_POLY, RACK_BLOCK, VIS_SCOPES};

/// Module kinds. The discriminants are **fixed wire ids** (commands and saved
/// projects use them), so they never change: MidiIn=0, Osc=1, Noise=2,
/// Filter=3, Adsr=4, Vca=5, Lfo=6, Mixer=7, Out=8, Delay=9, Reverb=10,
/// Chorus=11, Eq=12, Compressor=13, Saturator=14, Attenuator=15,
/// SamplePlayer=16, Formant=17, Scope=18, Accent=19.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModuleKind {
    MidiIn = 0,
    Osc = 1,
    Noise = 2,
    Filter = 3,
    Adsr = 4,
    Vca = 5,
    Lfo = 6,
    Mixer = 7,
    Out = 8,
    Delay = 9,
    Reverb = 10,
    Chorus = 11,
    Eq = 12,
    Compressor = 13,
    Saturator = 14,
    Attenuator = 15,
    SamplePlayer = 16,
    Formant = 17,
    Scope = 18,
    Accent = 19,
}

impl ModuleKind {
    /// Every kind, ordered by id (the catalog order).
    pub const ALL: &'static [ModuleKind] = &[
        ModuleKind::MidiIn,
        ModuleKind::Osc,
        ModuleKind::Noise,
        ModuleKind::Filter,
        ModuleKind::Adsr,
        ModuleKind::Vca,
        ModuleKind::Lfo,
        ModuleKind::Mixer,
        ModuleKind::Out,
        ModuleKind::Delay,
        ModuleKind::Reverb,
        ModuleKind::Chorus,
        ModuleKind::Eq,
        ModuleKind::Compressor,
        ModuleKind::Saturator,
        ModuleKind::Attenuator,
        ModuleKind::SamplePlayer,
        ModuleKind::Formant,
        ModuleKind::Scope,
        ModuleKind::Accent,
    ];

    /// Decode a wire id; unknown (or not yet implemented) ids give `None`.
    pub fn from_id(id: u32) -> Option<ModuleKind> {
        ModuleKind::ALL.iter().copied().find(|&k| k as u32 == id)
    }

    /// The FX-pool bank a module of this kind needs a slot in (Delay, Reverb,
    /// Chorus, Scope), or `None` for inline modules (see `rack/fx_pool.rs`).
    pub fn fx_kind(self) -> Option<FxKind> {
        match self {
            ModuleKind::Delay => Some(FxKind::Delay),
            ModuleKind::Reverb => Some(FxKind::Reverb),
            ModuleKind::Chorus => Some(FxKind::Chorus),
            ModuleKind::Scope => Some(FxKind::Scope),
            _ => None,
        }
    }
}

/// What a port carries (see the signal conventions in the plan):
/// audio ±1 nominal; pitch in V/oct with 0.0 = C4; gate 0/1; CV 0..1 or ±1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Audio,
    Pitch,
    Gate,
    Cv,
}

impl Signal {
    fn as_str(self) -> &'static str {
        match self {
            Signal::Audio => "audio",
            Signal::Pitch => "pitch",
            Signal::Gate => "gate",
            Signal::Cv => "cv",
        }
    }
}

/// Knob mapping hint for the UI. The engine only range-checks values; `Exp`
/// tells the UI to map knob travel exponentially (frequencies, times).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Curve {
    Lin,
    Exp,
}

#[derive(Debug)]
pub struct PortSpec {
    pub name: &'static str,
    pub signal: Signal,
}

/// One param. Values outside `min..=max` (and NaN/Inf) are rejected with
/// `ERR_BAD_VALUE`, as are non-integral values when `integer` is set.
/// Choice params (non-empty `choices`) are integer params `0..=choices.len()-1`.
/// `smooth` params are smoothed per sample by the module (5 ms one-pole), so
/// moving them never clicks.
#[derive(Debug)]
pub struct ParamSpec {
    /// Stable machine name (also the UI key).
    pub name: &'static str,
    /// Human label shown on the knob.
    pub label: &'static str,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub integer: bool,
    pub curve: Curve,
    /// Display unit ("Hz", "s", ...), or "".
    pub unit: &'static str,
    pub choices: &'static [&'static str],
    pub smooth: bool,
}

#[derive(Debug)]
pub struct ModuleSpec {
    pub kind: ModuleKind,
    /// Stable machine name ("vca").
    pub id: &'static str,
    /// Display name ("VCA").
    pub name: &'static str,
    /// "source" | "shaping" | "effect" | "utility" (UI grouping).
    pub category: &'static str,
    pub inputs: &'static [PortSpec],
    pub outputs: &'static [PortSpec],
    pub params: &'static [ParamSpec],
}

const fn port(name: &'static str, signal: Signal) -> PortSpec {
    PortSpec { name, signal }
}

/// A continuous linear param.
const fn lin(name: &'static str, label: &'static str, min: f32, max: f32, default: f32, smooth: bool) -> ParamSpec {
    ParamSpec { name, label, min, max, default, integer: false, curve: Curve::Lin, unit: "", choices: &[], smooth }
}

/// A continuous exponential-knob param (times); `min > 0` unless noted.
const fn exp(name: &'static str, label: &'static str, min: f32, max: f32, default: f32, unit: &'static str) -> ParamSpec {
    ParamSpec { name, label, min, max, default, integer: false, curve: Curve::Exp, unit, choices: &[], smooth: false }
}

/// A continuous param with a unit and curve (`smooth`: the module glides it).
#[allow(clippy::too_many_arguments)]
const fn cont(
    name: &'static str,
    label: &'static str,
    min: f32,
    max: f32,
    default: f32,
    curve: Curve,
    unit: &'static str,
    smooth: bool,
) -> ParamSpec {
    ParamSpec { name, label, min, max, default, integer: false, curve, unit, choices: &[], smooth }
}

/// An integer param `min..=max`.
const fn int(name: &'static str, label: &'static str, min: f32, max: f32, default: f32, unit: &'static str) -> ParamSpec {
    ParamSpec { name, label, min, max, default, integer: true, curve: Curve::Lin, unit, choices: &[], smooth: false }
}

/// A choice param: integer `0..=choices.len()-1`.
const fn choice(name: &'static str, label: &'static str, choices: &'static [&'static str], default: f32) -> ParamSpec {
    ParamSpec {
        name,
        label,
        min: 0.0,
        max: (choices.len() - 1) as f32,
        default,
        integer: true,
        curve: Curve::Lin,
        unit: "",
        choices,
        smooth: false,
    }
}

static MIDI_IN: ModuleSpec = ModuleSpec {
    kind: ModuleKind::MidiIn,
    id: "midi_in",
    name: "MIDI In",
    category: "source",
    inputs: &[],
    // pitch/gate/vel carry `voices` channels (1 in Mono); mod is 1 channel.
    outputs: &[port("pitch", Signal::Pitch), port("gate", Signal::Gate), port("vel", Signal::Cv), port("mod", Signal::Cv)],
    params: &[
        int("voices", "Voices", 1.0, 16.0, 8.0, ""),
        choice("mode", "Mode", &["Poly", "Mono"], 0.0),
        // Exp knob that starts at 0 (= off): the UI maps 0 -> min exactly.
        exp("glide", "Glide", 0.0, 2.0, 0.0, "s"),
        int("bend", "Bend range", 0.0, 12.0, 2.0, "st"),
        // Mono only (plan 11): Always glides every note; Legato glides only a
        // note pressed while another is held (a note from silence jumps).
        choice("glide_mode", "Glide mode", &["Always", "Legato"], 0.0),
    ],
};

static OSC: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Osc,
    id: "osc",
    name: "Oscillator",
    category: "source",
    // Channels follow the connected inputs (pitch normally); unconnected pitch = C4.
    inputs: &[port("pitch", Signal::Pitch), port("fm", Signal::Audio), port("pw", Signal::Cv)],
    outputs: &[port("out", Signal::Audio)],
    params: &[
        choice("wave", "Wave", &["Saw", "Square", "Tri", "Sine"], 0.0),
        int("octave", "Octave", -3.0, 3.0, 0.0, "oct"),
        ParamSpec {
            name: "tune",
            label: "Tune",
            min: -12.0,
            max: 12.0,
            default: 0.0,
            integer: false,
            curve: Curve::Lin,
            unit: "st",
            choices: &[],
            smooth: false,
        },
        ParamSpec {
            name: "fine",
            label: "Fine",
            min: -100.0,
            max: 100.0,
            default: 0.0,
            integer: false,
            curve: Curve::Lin,
            unit: "ct",
            choices: &[],
            smooth: false,
        },
        lin("pw", "Pulse width", 0.05, 0.95, 0.5, true),
        lin("fm", "FM", 0.0, 1.0, 0.0, true),
        int("unison", "Unison", 1.0, 4.0, 1.0, ""),
        ParamSpec {
            name: "detune",
            label: "Detune",
            min: 0.0,
            max: 100.0,
            default: 15.0,
            integer: false,
            curve: Curve::Lin,
            unit: "ct",
            choices: &[],
            smooth: true,
        },
    ],
};

static NOISE: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Noise,
    id: "noise",
    name: "Noise",
    category: "source",
    inputs: &[],
    outputs: &[port("out", Signal::Audio)],
    // `color` appended in plan 16 (Pink: Paul Kellet's −3 dB/oct filter,
    // RMS-matched to White; see `modules::noise`).
    params: &[lin("level", "Level", 0.0, 1.0, 1.0, true), choice("color", "Color", NOISE_COLORS, 0.0)],
};

/// Noise `color` choices (ids 0..1; see `modules::noise`).
pub const NOISE_COLORS: &[&str] = &["White", "Pink"];

/// Filter `mode` choices (ids 0..5; see `modules::filter`). "Diode" (5) was
/// appended in plan 17: never reorder, saved projects store the id.
pub const FILTER_MODES: &[&str] = &["LP24", "LP12", "HP", "BP", "Notch", "Diode"];

static FILTER: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Filter,
    id: "filter",
    name: "Filter",
    category: "shaping",
    // `cv` is V/oct: effective cutoff = cutoff × 2^(cv × cv_amt).
    inputs: &[port("in", Signal::Audio), port("cv", Signal::Cv)],
    outputs: &[port("out", Signal::Audio)],
    params: &[
        choice("mode", "Mode", FILTER_MODES, 0.0),
        ParamSpec {
            name: "cutoff",
            label: "Cutoff",
            min: 20.0,
            max: 20000.0,
            default: 1200.0,
            integer: false,
            curve: Curve::Exp,
            unit: "Hz",
            choices: &[],
            smooth: true,
        },
        lin("reso", "Resonance", 0.0, 1.0, 0.2, true),
        ParamSpec {
            name: "cv_amt",
            label: "CV amount",
            min: -8.0,
            max: 8.0,
            default: 0.0,
            integer: false,
            curve: Curve::Lin,
            unit: "oct",
            choices: &[],
            smooth: true,
        },
        lin("drive", "Drive", 0.0, 1.0, 0.0, true),
    ],
};

static ADSR: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Adsr,
    id: "adsr",
    name: "ADSR",
    category: "shaping",
    // `vel` (plan 11): per-voice velocity 0..1, latched at the rising gate;
    // unconnected reads as 1. Channels still follow `gate` only.
    inputs: &[port("gate", Signal::Gate), port("vel", Signal::Cv)],
    outputs: &[port("env", Signal::Cv)],
    params: &[
        exp("attack", "Attack", 0.001, 10.0, 0.005, "s"),
        exp("decay", "Decay", 0.001, 10.0, 0.2, "s"),
        lin("sustain", "Sustain", 0.0, 1.0, 0.7, true),
        exp("release", "Release", 0.001, 10.0, 0.3, "s"),
        // Appended in plan 11 (indices 4, 5). Exp knob from 0 (= off), like glide.
        exp("delay", "Delay", 0.0, 4.0, 0.0, "s"),
        // env = level × (1 − vel_amt + vel_amt × vel).
        lin("vel_amt", "Velocity", 0.0, 1.0, 0.0, true),
    ],
};

static VCA: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Vca,
    id: "vca",
    name: "VCA",
    category: "shaping",
    inputs: &[port("in", Signal::Audio), port("cv", Signal::Cv)],
    outputs: &[port("out", Signal::Audio)],
    params: &[lin("level", "Level", 0.0, 1.0, 1.0, true)],
};

/// LFO `division` choices; their lengths in ticks are `LFO_DIVISION_TICKS`.
pub const LFO_DIVISIONS: &[&str] = &["1/16", "1/8", "1/8.", "1/4", "1/2", "1 bar", "2 bars", "4 bars"];
/// Ticks per LFO cycle for each `LFO_DIVISIONS` entry (960 PPQ, 4/4 bars).
pub const LFO_DIVISION_TICKS: [f64; 8] = [240.0, 480.0, 720.0, 960.0, 1920.0, 3840.0, 7680.0, 15360.0];

static LFO: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Lfo,
    id: "lfo",
    name: "LFO",
    category: "source",
    inputs: &[],
    outputs: &[port("out", Signal::Cv)],
    params: &[
        choice("wave", "Wave", &["Sine", "Tri", "Saw", "Square"], 0.0),
        ParamSpec {
            name: "rate",
            label: "Rate",
            min: 0.01,
            max: 50.0,
            default: 2.0,
            integer: false,
            curve: Curve::Exp,
            unit: "Hz",
            choices: &[],
            smooth: false,
        },
        choice("sync", "Sync", &["Free", "Sync"], 0.0),
        choice("division", "Division", LFO_DIVISIONS, 3.0),
        lin("depth", "Depth", 0.0, 1.0, 1.0, true),
    ],
};

static MIXER: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Mixer,
    id: "mixer",
    name: "Mixer",
    category: "utility",
    inputs: &[port("in1", Signal::Audio), port("in2", Signal::Audio), port("in3", Signal::Audio), port("in4", Signal::Audio)],
    outputs: &[port("out", Signal::Audio)],
    params: &[
        lin("lvl1", "Level 1", 0.0, 1.0, 0.8, true),
        lin("lvl2", "Level 2", 0.0, 1.0, 0.8, true),
        lin("lvl3", "Level 3", 0.0, 1.0, 0.8, true),
        lin("lvl4", "Level 4", 0.0, 1.0, 0.8, true),
    ],
};

static OUT: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Out,
    id: "out",
    name: "Out",
    category: "utility",
    inputs: &[port("l", Signal::Audio), port("r", Signal::Audio)],
    outputs: &[],
    params: &[lin("level", "Level", 0.0, 1.0, 0.8, true)],
};

// ---- effects (plan 6) -------------------------------------------------------
//
// The stereo effects (Delay, Reverb, Chorus, Eq, Compressor) take `l` and `r`
// (`r` falls back to `l` when unconnected) and output `l` and `r` of exactly
// **1 channel** each: poly inputs are summed first, so one reverb serves a
// whole 16-voice patch. Their DSP is the mixer's (`engine/src/dsp/`), with
// the mixer's defaults where they overlap. Saturator and Attenuator are
// per-channel (poly). Delay, Reverb and Chorus borrow memory from the shared
// FX pool (`fx_pool.rs`); adding one when its bank is full returns
// `ERR_OUT_OF_MEMORY`.

const STEREO_IN: &[PortSpec] = &[port("l", Signal::Audio), port("r", Signal::Audio)];
const STEREO_OUT: &[PortSpec] = &[port("l", Signal::Audio), port("r", Signal::Audio)];

static DELAY: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Delay,
    id: "delay",
    name: "Delay",
    category: "effect",
    inputs: STEREO_IN,
    outputs: STEREO_OUT,
    params: &[
        // The mixer delay's table (one table for both); synced to the
        // transport tempo, clamped to 2 s ("(max 2 s)" in the UI).
        choice("division", "Division", DELAY_DIVISIONS, DELAY_DEFAULT_DIVISION as f32),
        lin("feedback", "Feedback", 0.0, 0.95, 0.35, true),
        lin("mix", "Mix", 0.0, 1.0, 0.3, true),
        choice("pingpong", "Ping-pong", &["Off", "On"], 1.0),
        cont("hicut", "High cut", 1000.0, 20000.0, 6000.0, Curve::Exp, "Hz", true),
    ],
};

static REVERB: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Reverb,
    id: "reverb",
    name: "Reverb",
    category: "effect",
    inputs: STEREO_IN,
    outputs: STEREO_OUT,
    params: &[
        lin("size", "Size", 0.0, 1.0, 0.6, true),
        cont("decay", "Decay", 0.2, 20.0, 2.2, Curve::Exp, "s", true),
        lin("damping", "Damping", 0.0, 1.0, 0.5, true),
        cont("predelay", "Predelay", 0.0, 200.0, 20.0, Curve::Lin, "ms", true),
        lin("mix", "Mix", 0.0, 1.0, 0.3, true),
    ],
};

static CHORUS: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Chorus,
    id: "chorus",
    name: "Chorus",
    category: "effect",
    inputs: STEREO_IN,
    outputs: STEREO_OUT,
    params: &[
        cont("rate", "Rate", 0.05, 5.0, 0.6, Curve::Exp, "Hz", false),
        lin("depth", "Depth", 0.0, 1.0, 0.4, true),
        lin("mix", "Mix", 0.0, 1.0, 0.5, true),
    ],
};

static EQ: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Eq,
    id: "eq",
    name: "EQ",
    category: "effect",
    inputs: STEREO_IN,
    outputs: STEREO_OUT,
    params: &[
        // 20 Hz (the minimum) is "off" (see dsp/eq.rs).
        cont("hp", "High-pass", 20.0, 1000.0, 20.0, Curve::Exp, "Hz", true),
        cont("low", "Low", -15.0, 15.0, 0.0, Curve::Lin, "dB", true),
        cont("midf", "Mid freq", 200.0, 8000.0, 1000.0, Curve::Exp, "Hz", true),
        cont("mid", "Mid", -15.0, 15.0, 0.0, Curve::Lin, "dB", true),
        cont("midq", "Mid Q", 0.3, 4.0, 0.7, Curve::Lin, "", true),
        cont("high", "High", -15.0, 15.0, 0.0, Curve::Lin, "dB", true),
    ],
};

static COMPRESSOR: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Compressor,
    id: "compressor",
    name: "Compressor",
    category: "effect",
    // `sc` is the key (summed to mono); unconnected, it keys on l/r itself.
    inputs: &[port("l", Signal::Audio), port("r", Signal::Audio), port("sc", Signal::Audio)],
    outputs: STEREO_OUT,
    params: &[
        cont("threshold", "Threshold", -60.0, 0.0, -18.0, Curve::Lin, "dB", true),
        cont("ratio", "Ratio", 1.0, 20.0, 4.0, Curve::Lin, "", true),
        cont("attack", "Attack", 0.1, 100.0, 5.0, Curve::Exp, "ms", false),
        cont("release", "Release", 10.0, 1000.0, 120.0, Curve::Exp, "ms", false),
        cont("makeup", "Makeup", 0.0, 24.0, 0.0, Curve::Lin, "dB", true),
    ],
};

static SATURATOR: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Saturator,
    id: "saturator",
    name: "Saturator",
    category: "shaping",
    inputs: &[port("in", Signal::Audio)],
    outputs: &[port("out", Signal::Audio)],
    params: &[
        lin("drive", "Drive", 0.0, 1.0, 0.3, true),
        lin("mix", "Mix", 0.0, 1.0, 1.0, true),
        lin("tone", "Tone", 0.0, 1.0, 0.5, true),
    ],
};

static ATTENUATOR: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Attenuator,
    id: "attenuator",
    name: "Attenuator",
    category: "utility",
    // out = in × amount + offset (in unconnected: the offset alone).
    inputs: &[port("in", Signal::Cv)],
    outputs: &[port("out", Signal::Cv)],
    params: &[lin("amount", "Amount", -1.0, 1.0, 1.0, true), lin("offset", "Offset", -1.0, 1.0, 0.0, true)],
};

static SAMPLE_PLAYER: ModuleSpec = ModuleSpec {
    kind: ModuleKind::SamplePlayer,
    id: "sample_player",
    name: "Sample Player",
    category: "source",
    // One voice per `gate` channel (poly), mono out per voice; see
    // `modules::sample_player`. `pitch` only matters with `pitchTrack` on.
    inputs: &[port("pitch", Signal::Pitch), port("gate", Signal::Gate)],
    outputs: &[port("out", Signal::Audio)],
    params: &[
        // A sample-pool id (the project's samples); -1 = none.
        int("sample", "Sample", -1.0, 255.0, -1.0, ""),
        lin("gain", "Gain", 0.0, 2.0, 1.0, true),
        // Where a voice starts, as a fraction of the sample (read at trigger).
        lin("start", "Start", 0.0, 1.0, 0.0, false),
        choice("pitchTrack", "Pitch track", &["Off", "On"], 1.0),
        // The MIDI note at which the sample plays at its own speed.
        int("root", "Root", 0.0, 127.0, 60.0, ""),
        // Appended in plan 15 (never reorder the five above). `end`, `loop`
        // and `loopStart` are read live, once per rack sub-block; `start` at
        // trigger. Playback stops (2 ms fade) at `end`, unless `loop` repeats
        // [loopStart, end) (10 ms equal-power crossfade at the seam) while
        // the gate is high and for a 10 s release window after it falls.
        lin("end", "End", 0.0, 1.0, 1.0, false),
        choice("loop", "Loop", &["Off", "On"], 0.0),
        lin("loopStart", "Loop start", 0.0, 1.0, 0.0, false),
        // Cents on top of the pitch (applies with pitchTrack off too).
        cont("fine", "Fine", -100.0, 100.0, 0.0, Curve::Lin, "ct", false),
    ],
};

static FORMANT: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Formant,
    id: "formant",
    name: "Formant",
    category: "shaping",
    // Three resonant band-pass peaks (see `modules::formant`). Peak i sits at
    // f_i × 2^(shift + track × pitch + cv_amt × cv); pitch/cv read 0 when
    // unconnected. The defaults are an alto-sax body.
    inputs: &[port("in", Signal::Audio), port("pitch", Signal::Pitch), port("cv", Signal::Cv)],
    outputs: &[port("out", Signal::Audio)],
    params: &[
        cont("f1", "Formant 1", 150.0, 1500.0, 500.0, Curve::Exp, "Hz", true),
        cont("f2", "Formant 2", 500.0, 4000.0, 1500.0, Curve::Exp, "Hz", true),
        cont("f3", "Formant 3", 1200.0, 8000.0, 2600.0, Curve::Exp, "Hz", true),
        cont("q", "Q", 1.0, 20.0, 6.0, Curve::Exp, "", true),
        lin("g2", "Gain 2", 0.0, 1.0, 0.7, true),
        lin("g3", "Gain 3", 0.0, 1.0, 0.5, true),
        cont("shift", "Shift", -2.0, 2.0, 0.0, Curve::Lin, "oct", true),
        lin("track", "Pitch track", 0.0, 1.0, 0.0, true),
        cont("cv_amt", "CV amount", -4.0, 4.0, 0.0, Curve::Lin, "oct", true),
        lin("mix", "Mix", 0.0, 1.0, 1.0, true),
    ],
};

// ---- visualisation (plan 12) ---------------------------------------------------

static SCOPE: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Scope,
    id: "scope",
    name: "Scope",
    category: "utility",
    // A sink (see `modules::scope`): no outputs, so it can never change the
    // sound; each input's channels are summed (as Out sums voices).
    inputs: &[port("a", Signal::Audio), port("b", Signal::Audio)],
    outputs: &[],
    params: &[
        // Free window = 10 divisions.
        exp("time", "Time/div", 0.1, 100.0, 5.0, "ms"),
        choice("sync", "Sync", &["Free", "Sync"], 0.0),
        // Sync window = one division at the current tempo (the LFO's table).
        choice("division", "Division", LFO_DIVISIONS, 3.0),
        // Display only (the UI scales the trace; the engine ignores them).
        exp("gain_a", "Gain A", 0.1, 10.0, 1.0, ""),
        exp("gain_b", "Gain B", 0.1, 10.0, 1.0, ""),
        choice("mode", "Mode", &["A+B", "XY"], 0.0),
        choice("trig", "Trigger", &["Auto", "Free"], 0.0),
    ],
};

// ---- acid (plan 17) -----------------------------------------------------------

static ACCENT: ModuleSpec = ModuleSpec {
    kind: ModuleKind::Accent,
    id: "accent",
    name: "Accent",
    category: "shaping",
    // See `modules::accent`: a rising gate with vel >= threshold adds 0.6 to
    // a store (max 1) that decays with time constant `decay`; cv = amount ×
    // the store. One store per gate channel; `vel` unconnected reads 1.
    inputs: &[port("gate", Signal::Gate), port("vel", Signal::Cv)],
    outputs: &[port("cv", Signal::Cv)],
    params: &[
        // 100/127: MIDI velocity 100 and up is an accent (the step editor
        // writes 120 for an accent, 80 for a plain note).
        lin("threshold", "Threshold", 0.0, 1.0, 100.0 / 127.0, false),
        lin("amount", "Amount", 0.0, 1.0, 1.0, true),
        exp("decay", "Decay", 0.05, 2.0, 0.25, "s"),
    ],
};

/// The static spec of `kind`.
pub fn spec(kind: ModuleKind) -> &'static ModuleSpec {
    match kind {
        ModuleKind::MidiIn => &MIDI_IN,
        ModuleKind::Osc => &OSC,
        ModuleKind::Noise => &NOISE,
        ModuleKind::Filter => &FILTER,
        ModuleKind::Adsr => &ADSR,
        ModuleKind::Vca => &VCA,
        ModuleKind::Lfo => &LFO,
        ModuleKind::Mixer => &MIXER,
        ModuleKind::Out => &OUT,
        ModuleKind::Delay => &DELAY,
        ModuleKind::Reverb => &REVERB,
        ModuleKind::Chorus => &CHORUS,
        ModuleKind::Eq => &EQ,
        ModuleKind::Compressor => &COMPRESSOR,
        ModuleKind::Saturator => &SATURATOR,
        ModuleKind::Attenuator => &ATTENUATOR,
        ModuleKind::SamplePlayer => &SAMPLE_PLAYER,
        ModuleKind::Formant => &FORMANT,
        ModuleKind::Scope => &SCOPE,
        ModuleKind::Accent => &ACCENT,
    }
}

/// JSON number: integers without a fraction, others in Rust's shortest
/// round-trip `f32` form (0.8 -> "0.8"), which JS parses to the same value.
fn num(v: f32) -> String {
    if v.fract() == 0.0 && v.abs() < 1e9 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// JSON string literal (catalog strings are plain ASCII, but escape anyway).
fn string(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn ports(ps: &[PortSpec]) -> String {
    let items: Vec<String> =
        ps.iter().map(|p| format!("{{\"name\":{},\"signal\":{}}}", string(p.name), string(p.signal.as_str()))).collect();
    format!("[{}]", items.join(","))
}

fn param(p: &ParamSpec) -> String {
    let choices: Vec<String> = p.choices.iter().map(|c| string(c)).collect();
    format!(
        "{{\"name\":{},\"label\":{},\"min\":{},\"max\":{},\"default\":{},\"integer\":{},\"curve\":{},\"unit\":{},\"choices\":[{}],\"smooth\":{}}}",
        string(p.name),
        string(p.label),
        num(p.min),
        num(p.max),
        num(p.default),
        p.integer,
        string(match p.curve {
            Curve::Lin => "lin",
            Curve::Exp => "exp",
        }),
        string(p.unit),
        choices.join(","),
        p.smooth
    )
}

/// The whole catalog as JSON (the contents of `engine/catalog.json`):
/// `{"version":1,"rackBlock":32,"maxModules":32,"maxPoly":16,
/// "fxPool":{"delay":8,"reverb":8,"chorus":16,"scope":8},"modules":[...]}`
/// with modules ordered by kind id, one module (and one param) per line so the
/// golden file diffs readably. Test/tool-only: it allocates.
pub fn catalog_json() -> String {
    let mut o = format!(
        "{{\n  \"version\": 1,\n  \"rackBlock\": {RACK_BLOCK},\n  \"maxModules\": {MAX_MODULES},\n  \"maxPoly\": {MAX_POLY},\n  \"fxPool\": {{\"delay\": {DELAY_SLOTS}, \"reverb\": {REVERB_SLOTS}, \"chorus\": {CHORUS_SLOTS}, \"scope\": {VIS_SCOPES}}},\n  \"modules\": ["
    );
    for (i, &k) in ModuleKind::ALL.iter().enumerate() {
        let s = spec(k);
        let params: Vec<String> = s.params.iter().map(|p| format!("\n        {}", param(p))).collect();
        o.push_str(if i == 0 { "\n" } else { ",\n" });
        o.push_str(&format!(
            "    {{\"kind\":{},\"id\":{},\"name\":{},\"category\":{},\n      \"inputs\":{},\n      \"outputs\":{},\n      \"params\":[{}{}]}}",
            k as u8,
            string(s.id),
            string(s.name),
            string(s.category),
            ports(s.inputs),
            ports(s.outputs),
            params.join(","),
            if params.is_empty() { "" } else { "\n      " }
        ));
    }
    o.push_str("\n  ]\n}\n");
    o
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MAX_PARAMS, MAX_PORTS};

    #[test]
    fn every_default_within_range() {
        for &k in ModuleKind::ALL {
            let s = spec(k);
            assert_eq!(s.kind, k);
            assert!(s.inputs.len() <= MAX_PORTS && s.outputs.len() <= MAX_PORTS, "{}", s.id);
            assert!(s.params.len() <= MAX_PARAMS, "{}", s.id);
            for p in s.params {
                let at = format!("{}.{}", s.id, p.name);
                assert!(p.min < p.max, "{at}");
                assert!(p.default >= p.min && p.default <= p.max, "{at}");
                if p.integer {
                    assert!(p.min.fract() == 0.0 && p.max.fract() == 0.0 && p.default.fract() == 0.0, "{at}");
                }
                if !p.choices.is_empty() {
                    assert!(p.integer, "{at}: choice params are integer");
                    assert_eq!(p.min, 0.0, "{at}");
                    assert_eq!(p.max, (p.choices.len() - 1) as f32, "{at}");
                }
                if p.curve == Curve::Exp {
                    // min == 0 is allowed for "zero-based" exp knobs (glide: 0 = off).
                    assert!(p.min >= 0.0, "{at}: exp curve needs min >= 0");
                }
            }
        }
    }

    #[test]
    fn ids_are_unique_and_stable() {
        assert_eq!(ModuleKind::MidiIn as u8, 0);
        assert_eq!(ModuleKind::Osc as u8, 1);
        assert_eq!(ModuleKind::Noise as u8, 2);
        assert_eq!(ModuleKind::Filter as u8, 3);
        assert_eq!(ModuleKind::Adsr as u8, 4);
        assert_eq!(ModuleKind::Vca as u8, 5);
        assert_eq!(ModuleKind::Lfo as u8, 6);
        assert_eq!(ModuleKind::Mixer as u8, 7);
        assert_eq!(ModuleKind::Out as u8, 8);
        let mut last = -1i32;
        for (i, &k) in ModuleKind::ALL.iter().enumerate() {
            assert!(k as i32 > last, "ALL is ordered by id");
            last = k as i32;
            assert_eq!(ModuleKind::from_id(k as u32), Some(k));
            for &other in &ModuleKind::ALL[..i] {
                assert_ne!(spec(k).id, spec(other).id);
            }
        }
        assert_eq!(ModuleKind::from_id(99), None);
    }

    #[test]
    fn noise_color_is_appended() {
        let s = spec(ModuleKind::Noise);
        let ps: Vec<_> = s.params.iter().map(|p| (p.name, p.label, p.min, p.max, p.default, p.integer, p.smooth)).collect();
        // `color` appended in plan 16 (never reordered: `level` stays index 0).
        assert_eq!(ps, [("level", "Level", 0.0, 1.0, 1.0, false, true), ("color", "Color", 0.0, 1.0, 0.0, true, false)]);
        assert_eq!(s.params[1].choices, ["White", "Pink"]);
    }

    #[test]
    fn catalog_id_16() {
        let k = ModuleKind::SamplePlayer;
        assert_eq!(k as u8, 16);
        assert_eq!(ModuleKind::from_id(16), Some(k));
        assert_eq!(k.fx_kind(), None, "inline: reads the sample pool, owns no ring");
        let s = spec(k);
        assert_eq!((s.id, s.name, s.category), ("sample_player", "Sample Player", "source"));
        let names = |ps: &[PortSpec]| ps.iter().map(|p| (p.name, p.signal)).collect::<Vec<_>>();
        assert_eq!(names(s.inputs), [("pitch", Signal::Pitch), ("gate", Signal::Gate)]);
        assert_eq!(names(s.outputs), [("out", Signal::Audio)]);
        let ps: Vec<_> = s.params.iter().map(|p| (p.name, p.min, p.max, p.default, p.integer)).collect();
        assert_eq!(
            ps,
            [
                ("sample", -1.0, 255.0, -1.0, true),
                ("gain", 0.0, 2.0, 1.0, false),
                ("start", 0.0, 1.0, 0.0, false),
                ("pitchTrack", 0.0, 1.0, 1.0, true),
                ("root", 0.0, 127.0, 60.0, true),
                // Appended in plan 15.
                ("end", 0.0, 1.0, 1.0, false),
                ("loop", 0.0, 1.0, 0.0, true),
                ("loopStart", 0.0, 1.0, 0.0, false),
                ("fine", -100.0, 100.0, 0.0, false),
            ]
        );
        let labels: Vec<_> = s.params[5..].iter().map(|p| p.label).collect();
        assert_eq!(labels, ["End", "Loop", "Loop start", "Fine"]);
        assert_eq!(s.params[6].choices, ["Off", "On"]);
        assert_eq!(s.params[8].unit, "ct");
        assert!(s.params[1].smooth, "gain is smoothed");
    }

    #[test]
    fn catalog_id_17() {
        let k = ModuleKind::Formant;
        assert_eq!(k as u8, 17);
        assert_eq!(ModuleKind::from_id(17), Some(k));
        assert_eq!(k.fx_kind(), None, "inline: no FX pool");
        let s = spec(k);
        assert_eq!((s.id, s.name, s.category), ("formant", "Formant", "shaping"));
        let names = |ps: &[PortSpec]| ps.iter().map(|p| (p.name, p.signal)).collect::<Vec<_>>();
        assert_eq!(names(s.inputs), [("in", Signal::Audio), ("pitch", Signal::Pitch), ("cv", Signal::Cv)]);
        assert_eq!(names(s.outputs), [("out", Signal::Audio)]);
        let ps: Vec<_> = s.params.iter().map(|p| (p.name, p.min, p.max, p.default, p.curve)).collect();
        assert_eq!(
            ps,
            [
                ("f1", 150.0, 1500.0, 500.0, Curve::Exp),
                ("f2", 500.0, 4000.0, 1500.0, Curve::Exp),
                ("f3", 1200.0, 8000.0, 2600.0, Curve::Exp),
                ("q", 1.0, 20.0, 6.0, Curve::Exp),
                ("g2", 0.0, 1.0, 0.7, Curve::Lin),
                ("g3", 0.0, 1.0, 0.5, Curve::Lin),
                ("shift", -2.0, 2.0, 0.0, Curve::Lin),
                ("track", 0.0, 1.0, 0.0, Curve::Lin),
                ("cv_amt", -4.0, 4.0, 0.0, Curve::Lin),
                ("mix", 0.0, 1.0, 1.0, Curve::Lin),
            ]
        );
        assert!(s.params.iter().all(|p| p.smooth && !p.integer), "every Formant param is smooth");
        assert!(s.params.len() <= crate::MAX_PARAMS);
    }

    #[test]
    fn catalog_id_18() {
        let k = ModuleKind::Scope;
        assert_eq!(k as u8, 18);
        assert_eq!(ModuleKind::from_id(18), Some(k));
        assert_eq!(k.fx_kind(), Some(FxKind::Scope), "its rings live in the FX pool's scope bank");
        let s = spec(k);
        assert_eq!((s.id, s.name, s.category), ("scope", "Scope", "utility"));
        let names = |ps: &[PortSpec]| ps.iter().map(|p| (p.name, p.signal)).collect::<Vec<_>>();
        assert_eq!(names(s.inputs), [("a", Signal::Audio), ("b", Signal::Audio)]);
        assert!(s.outputs.is_empty(), "a sink: no outputs, so it can never change the sound");
        let ps: Vec<_> = s.params.iter().map(|p| (p.name, p.label, p.min, p.max, p.default, p.integer, p.curve)).collect();
        assert_eq!(
            ps,
            [
                ("time", "Time/div", 0.1, 100.0, 5.0, false, Curve::Exp),
                ("sync", "Sync", 0.0, 1.0, 0.0, true, Curve::Lin),
                ("division", "Division", 0.0, 7.0, 3.0, true, Curve::Lin),
                ("gain_a", "Gain A", 0.1, 10.0, 1.0, false, Curve::Exp),
                ("gain_b", "Gain B", 0.1, 10.0, 1.0, false, Curve::Exp),
                ("mode", "Mode", 0.0, 1.0, 0.0, true, Curve::Lin),
                ("trig", "Trigger", 0.0, 1.0, 0.0, true, Curve::Lin),
            ]
        );
        assert_eq!(s.params[0].unit, "ms");
        assert_eq!(s.params[1].choices, &["Free", "Sync"]);
        assert_eq!(s.params[2].choices, LFO_DIVISIONS, "the LFO's 8 divisions");
        assert_eq!(s.params[5].choices, &["A+B", "XY"]);
        assert_eq!(s.params[6].choices, &["Auto", "Free"]);
        assert!(s.params.iter().all(|p| !p.smooth));
        assert!(catalog_json().contains("\"fxPool\": {\"delay\": 8, \"reverb\": 8, \"chorus\": 16, \"scope\": 8}"));
    }

    #[test]
    fn catalog_id_19() {
        let k = ModuleKind::Accent;
        assert_eq!(k as u8, 19);
        assert_eq!(ModuleKind::from_id(19), Some(k));
        assert_eq!(ModuleKind::from_id(20), None);
        assert_eq!(k.fx_kind(), None, "inline: no FX pool");
        let s = spec(k);
        assert_eq!((s.id, s.name, s.category), ("accent", "Accent", "shaping"));
        let names = |ps: &[PortSpec]| ps.iter().map(|p| (p.name, p.signal)).collect::<Vec<_>>();
        assert_eq!(names(s.inputs), [("gate", Signal::Gate), ("vel", Signal::Cv)]);
        assert_eq!(names(s.outputs), [("cv", Signal::Cv)]);
        let ps: Vec<_> = s.params.iter().map(|p| (p.name, p.label, p.min, p.max, p.default, p.curve, p.unit, p.smooth)).collect();
        assert_eq!(
            ps,
            [
                ("threshold", "Threshold", 0.0, 1.0, 100.0 / 127.0, Curve::Lin, "", false),
                ("amount", "Amount", 0.0, 1.0, 1.0, Curve::Lin, "", true),
                ("decay", "Decay", 0.05, 2.0, 0.25, Curve::Exp, "s", false),
            ]
        );
        assert!(s.params.iter().all(|p| !p.integer));
    }

    #[test]
    fn filter_diode_mode_is_appended() {
        let mode = &spec(ModuleKind::Filter).params[0];
        assert_eq!(mode.name, "mode");
        // The first five ids never move; Diode is id 5.
        assert_eq!(mode.choices, ["LP24", "LP12", "HP", "BP", "Notch", "Diode"]);
        assert_eq!((mode.min, mode.max, mode.default), (0.0, 5.0, 0.0));
    }

    #[test]
    fn appended_ports_and_params_keep_indices() {
        let at = |ps: &[ParamSpec], n: &str| ps.iter().position(|p| p.name == n);
        let port_at = |ps: &[PortSpec], n: &str| ps.iter().position(|p| p.name == n);
        let adsr = spec(ModuleKind::Adsr);
        assert_eq!(port_at(adsr.inputs, "gate"), Some(0));
        assert_eq!(port_at(adsr.inputs, "vel"), Some(1));
        assert_eq!(adsr.inputs[1].signal, Signal::Cv);
        for (n, i) in [("attack", 0), ("decay", 1), ("sustain", 2), ("release", 3), ("delay", 4), ("vel_amt", 5)] {
            assert_eq!(at(adsr.params, n), Some(i), "adsr.{n}");
        }
        let d = &adsr.params[4];
        assert_eq!((d.label, d.min, d.max, d.default, d.curve, d.unit, d.smooth), ("Delay", 0.0, 4.0, 0.0, Curve::Exp, "s", false));
        let v = &adsr.params[5];
        assert_eq!((v.label, v.min, v.max, v.default, v.curve, v.smooth, v.integer), ("Velocity", 0.0, 1.0, 0.0, Curve::Lin, true, false));
        let midi = spec(ModuleKind::MidiIn);
        for (n, i) in [("voices", 0), ("mode", 1), ("glide", 2), ("bend", 3), ("glide_mode", 4)] {
            assert_eq!(at(midi.params, n), Some(i), "midi_in.{n}");
        }
        let g = &midi.params[4];
        assert_eq!((g.label, g.choices, g.default), ("Glide mode", &["Always", "Legato"][..], 0.0));
    }

    #[test]
    fn lfo_divisions_have_tick_lengths() {
        assert_eq!(LFO_DIVISIONS.len(), LFO_DIVISION_TICKS.len());
    }

    #[test]
    fn catalog_matches_golden() {
        let json = catalog_json();
        if std::env::var("UPDATE_CATALOG").as_deref() == Ok("1") {
            let path = concat!(env!("CARGO_MANIFEST_DIR"), "/catalog.json");
            std::fs::write(path, &json).expect("write catalog.json");
            return;
        }
        assert_eq!(
            json,
            include_str!("../../catalog.json"),
            "engine/catalog.json is stale: run UPDATE_CATALOG=1 cargo test -p daw-engine catalog"
        );
    }
}
