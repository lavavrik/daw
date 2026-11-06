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

use crate::{MAX_MODULES, MAX_POLY, RACK_BLOCK};

/// Module kinds. The discriminants are **fixed wire ids** (commands and saved
/// projects use them), so they never change: MidiIn=0, Osc=1, Noise=2,
/// Filter=3, Adsr=4, Vca=5, Lfo=6, Mixer=7, Out=8.
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
    ];

    /// Decode a wire id; unknown (or not yet implemented) ids give `None`.
    pub fn from_id(id: u32) -> Option<ModuleKind> {
        ModuleKind::ALL.iter().copied().find(|&k| k as u32 == id)
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
    params: &[lin("level", "Level", 0.0, 1.0, 1.0, true)],
};

/// Filter `mode` choices (ids 0..4; see `modules::filter`).
pub const FILTER_MODES: &[&str] = &["LP24", "LP12", "HP", "BP", "Notch"];

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
    inputs: &[port("gate", Signal::Gate)],
    outputs: &[port("env", Signal::Cv)],
    params: &[
        exp("attack", "Attack", 0.001, 10.0, 0.005, "s"),
        exp("decay", "Decay", 0.001, 10.0, 0.2, "s"),
        lin("sustain", "Sustain", 0.0, 1.0, 0.7, true),
        exp("release", "Release", 0.001, 10.0, 0.3, "s"),
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
/// `{"version":1,"rackBlock":32,"maxModules":32,"maxPoly":16,"modules":[...]}`
/// with modules ordered by kind id, one module (and one param) per line so the
/// golden file diffs readably. Test/tool-only: it allocates.
pub fn catalog_json() -> String {
    let mut o = format!(
        "{{\n  \"version\": 1,\n  \"rackBlock\": {RACK_BLOCK},\n  \"maxModules\": {MAX_MODULES},\n  \"maxPoly\": {MAX_POLY},\n  \"modules\": ["
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
