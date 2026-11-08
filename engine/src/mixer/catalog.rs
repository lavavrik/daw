//! The mixer param catalog: every channel-strip, return and master param, as
//! one static table.
//!
//! It is the single source of truth for mixer params, like the rack catalog
//! (`rack/catalog.rs`): `decode` validates `OP_MIX_SET` against it (id,
//! channel kind, range, integer/flag), the [`Mixer`](super::Mixer) applies
//! the values, and `mixer_catalog_json()` exports it to
//! `engine/mixer_catalog.json`, which the UI imports to build its controls.
//! The golden test `mixer_catalog_matches_golden` fails when the file is
//! stale; regenerate it with `UPDATE_CATALOG=1 cargo test -p daw-engine catalog`.
//!
//! Param **ids are stable wire ids** (commands and saved projects use them):
//! append new params, never renumber or reuse one.
//!
//! * `applies_to` says which channel kinds accept the param (`Track` =
//!   channels 0..31, `Return` = 32/33, `Master` = 34). The `reverb` group
//!   applies to the Reverb return only and the `delay` group to the Delay
//!   return only (see [`MixParam::accepts`]).
//! * Flags are integer params 0..1; choice params (`choices` non-empty) are
//!   integers `0..=choices.len()-1`.
//! * `min_label` names the minimum when it means something special: the
//!   fader and sends at their −60 dB minimum are silent ("-inf" / "Off"), and
//!   the EQ high-pass at its 20 Hz minimum is off (the DSP parks it at 5 Hz,
//!   see `dsp/eq.rs`). The UI shows that label instead of the number.
//! * `curve` is the param's knob space: `lin`, `exp`, or `fader` (the fader
//!   and both sends, plan 19), the mixer's [`FADER_LAW`], which is exported
//!   as `"faderLaw"` alongside the params.

use crate::{MAX_TRACKS, MIX_DELAY, MIX_MASTER, MIX_REVERB};
#[cfg(test)]
use crate::MIX_CHANNELS;

/// Channel kinds a param can apply to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelKind {
    Track,
    Return,
    Master,
}

impl ChannelKind {
    /// Kind of mixer channel `ch` (`None` past `MIX_CHANNELS`).
    pub fn of(ch: usize) -> Option<ChannelKind> {
        match ch {
            c if c < MAX_TRACKS => Some(ChannelKind::Track),
            MIX_REVERB | MIX_DELAY => Some(ChannelKind::Return),
            MIX_MASTER => Some(ChannelKind::Master),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            ChannelKind::Track => "track",
            ChannelKind::Return => "return",
            ChannelKind::Master => "master",
        }
    }
}

/// UI grouping (and, for `Reverb`/`Delay`, which return a param belongs to).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Fader,
    Eq,
    Comp,
    Send,
    Reverb,
    Delay,
    Limiter,
}

impl Group {
    fn as_str(self) -> &'static str {
        match self {
            Group::Fader => "fader",
            Group::Eq => "eq",
            Group::Comp => "comp",
            Group::Send => "send",
            Group::Reverb => "reverb",
            Group::Delay => "delay",
            Group::Limiter => "limiter",
        }
    }
}

/// Knob mapping ("knob space"): how a value maps to a control's travel and
/// how an automation lane interpolates it (`automation::Shape`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Curve {
    /// Linear in the value.
    Lin,
    /// Logarithmic in the value (frequencies, times, ratios).
    Exp,
    /// The mixer fader's taper, [`FADER_LAW`] (plan 19): the fader and both
    /// sends, so a knob, a lane and MIDI-learn move like the fader does.
    Fader,
}

/// One mixer param (see the module docs).
#[derive(Debug)]
pub struct MixParam {
    /// Stable wire id (`OP_MIX_SET` b).
    pub id: u32,
    /// Stable machine name (also the UI key).
    pub name: &'static str,
    /// Human label shown on the control.
    pub label: &'static str,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    /// Display unit ("dB", "Hz", "ms", ...), or "".
    pub unit: &'static str,
    pub curve: Curve,
    pub integer: bool,
    pub applies_to: &'static [ChannelKind],
    pub group: Group,
    /// Choice labels (integer `0..=len-1`), or empty.
    pub choices: &'static [&'static str],
    /// Label for the minimum when it is special ("Off", "-inf"), or "".
    pub min_label: &'static str,
}

impl MixParam {
    /// Does channel `ch` accept this param?
    pub fn accepts(&self, ch: usize) -> bool {
        let Some(kind) = ChannelKind::of(ch) else { return false };
        match self.group {
            Group::Reverb => ch == MIX_REVERB,
            Group::Delay => ch == MIX_DELAY,
            _ => self.applies_to.contains(&kind),
        }
    }

    /// Is `v` a valid value (finite, in range, integral if `integer`)? The
    /// range check is in `f32` (the catalog's type), so a UI echoing the
    /// catalog's own `max` (e.g. 0.95, not exactly representable) is valid.
    pub fn valid(&self, v: f64) -> bool {
        let x = v as f32;
        v.is_finite() && x >= self.min && x <= self.max && (!self.integer || v.fract() == 0.0)
    }
}

use ChannelKind::{Master as M, Return as R, Track as T};

const ALL: &[ChannelKind] = &[T, R, M];
const TRACK_RETURN: &[ChannelKind] = &[T, R];
const TRACK: &[ChannelKind] = &[T];
const RETURN: &[ChannelKind] = &[R];
const MASTER: &[ChannelKind] = &[M];

/// Fader / send minimum (dB): at it the gain is exactly 0 (−inf).
pub const FADER_MIN_DB: f32 = -60.0;
/// Fader / send maximum (dB).
pub const FADER_MAX_DB: f32 = 6.0;

/// The fader law (plan 19; was app/src/ui/mixer/mixMath.ts' own table):
/// `(dB, position)` breakpoints, piecewise linear in dB between them. Position
/// 0..1 is the fader's travel. 0 dB sits at 3/4 of the travel, the top
/// quarter is +6 dB of boost, the range near unity (where mixing happens) is
/// spread out, and the bottom 14 % covers −40 dB down to the −60 dB minimum
/// (silent). Exported as `"faderLaw"`; the UI draws its fader, meter scale,
/// send knobs and volume / send lanes with it, and automation interpolates
/// [`Curve::Fader`] params in this position space.
pub const FADER_LAW: [(f32, f32); 7] =
    [(FADER_MIN_DB, 0.0), (-40.0, 0.14), (-30.0, 0.25), (-20.0, 0.38), (-10.0, 0.55), (0.0, 0.75), (FADER_MAX_DB, 1.0)];

/// Delay time choices (note lengths) and their length in quarter-note beats.
pub const DELAY_DIVISIONS: &[&str] =
    &["1/32", "1/16T", "1/16", "1/16.", "1/8T", "1/8", "3/16", "1/4T", "1/4", "1/4.", "1/2", "1 bar"];
pub const DELAY_DIVISION_BEATS: [f32; 12] =
    [0.125, 1.0 / 6.0, 0.25, 0.375, 1.0 / 3.0, 0.5, 0.75, 2.0 / 3.0, 1.0, 1.5, 2.0, 4.0];
/// Default delay time: 3/16 (a dotted eighth).
pub const DELAY_DEFAULT_DIVISION: usize = 6;

// Param ids (stable; append only).
pub const P_FADER: u32 = 0;
pub const P_PAN: u32 = 1;
pub const P_MUTE: u32 = 2;
pub const P_SOLO: u32 = 3;
pub const P_EQ_ON: u32 = 4;
pub const P_EQ_HP: u32 = 5;
pub const P_EQ_LOW: u32 = 6;
pub const P_EQ_MID_FREQ: u32 = 7;
pub const P_EQ_MID_GAIN: u32 = 8;
pub const P_EQ_MID_Q: u32 = 9;
pub const P_EQ_HIGH: u32 = 10;
pub const P_COMP_ON: u32 = 11;
pub const P_COMP_THRESHOLD: u32 = 12;
pub const P_COMP_RATIO: u32 = 13;
pub const P_COMP_ATTACK: u32 = 14;
pub const P_COMP_RELEASE: u32 = 15;
pub const P_COMP_MAKEUP: u32 = 16;
pub const P_SEND_A: u32 = 17;
pub const P_SEND_A_PRE: u32 = 18;
pub const P_SEND_B: u32 = 19;
pub const P_SEND_B_PRE: u32 = 20;
pub const P_REV_SIZE: u32 = 21;
pub const P_REV_DECAY: u32 = 22;
pub const P_REV_DAMPING: u32 = 23;
pub const P_REV_PREDELAY: u32 = 24;
pub const P_DELAY_TIME: u32 = 25;
pub const P_DELAY_FEEDBACK: u32 = 26;
pub const P_DELAY_PING_PONG: u32 = 27;
pub const P_DELAY_HIGH_CUT: u32 = 28;
pub const P_LIMITER_CEILING: u32 = 29;
/// Number of params (ids are `0..MIX_PARAMS`).
pub const MIX_PARAMS: usize = 30;

#[allow(clippy::too_many_arguments)]
const fn p(
    id: u32,
    name: &'static str,
    label: &'static str,
    min: f32,
    max: f32,
    default: f32,
    unit: &'static str,
    curve: Curve,
    applies_to: &'static [ChannelKind],
    group: Group,
) -> MixParam {
    MixParam { id, name, label, min, max, default, unit, curve, integer: false, applies_to, group, choices: &[], min_label: "" }
}

/// A 0/1 flag.
const fn flag(id: u32, name: &'static str, label: &'static str, default: f32, applies_to: &'static [ChannelKind], group: Group) -> MixParam {
    MixParam {
        id,
        name,
        label,
        min: 0.0,
        max: 1.0,
        default,
        unit: "",
        curve: Curve::Lin,
        integer: true,
        applies_to,
        group,
        choices: &[],
        min_label: "",
    }
}

/// `p` with a special label for the minimum.
const fn with_min_label(mut m: MixParam, label: &'static str) -> MixParam {
    m.min_label = label;
    m
}

const L: Curve = Curve::Lin;
const E: Curve = Curve::Exp;
const F: Curve = Curve::Fader;

/// Every param, indexed by id (`PARAMS[id].id == id`).
pub static PARAMS: [MixParam; MIX_PARAMS] = [
    with_min_label(p(P_FADER, "fader", "Volume", FADER_MIN_DB, FADER_MAX_DB, 0.0, "dB", F, ALL, Group::Fader), "-inf"),
    p(P_PAN, "pan", "Pan", -1.0, 1.0, 0.0, "", L, TRACK_RETURN, Group::Fader),
    flag(P_MUTE, "mute", "Mute", 0.0, TRACK_RETURN, Group::Fader),
    flag(P_SOLO, "solo", "Solo", 0.0, TRACK, Group::Fader),
    flag(P_EQ_ON, "eq_on", "EQ", 0.0, ALL, Group::Eq),
    with_min_label(p(P_EQ_HP, "eq_hp", "Low cut", 20.0, 1000.0, 20.0, "Hz", E, ALL, Group::Eq), "Off"),
    p(P_EQ_LOW, "eq_low", "Low", -15.0, 15.0, 0.0, "dB", L, ALL, Group::Eq),
    p(P_EQ_MID_FREQ, "eq_mid_freq", "Mid freq", 200.0, 8000.0, 1000.0, "Hz", E, ALL, Group::Eq),
    p(P_EQ_MID_GAIN, "eq_mid_gain", "Mid", -15.0, 15.0, 0.0, "dB", L, ALL, Group::Eq),
    p(P_EQ_MID_Q, "eq_mid_q", "Mid Q", 0.3, 4.0, 0.7, "", E, ALL, Group::Eq),
    p(P_EQ_HIGH, "eq_high", "High", -15.0, 15.0, 0.0, "dB", L, ALL, Group::Eq),
    flag(P_COMP_ON, "comp_on", "Comp", 0.0, TRACK, Group::Comp),
    p(P_COMP_THRESHOLD, "comp_threshold", "Threshold", -60.0, 0.0, -18.0, "dB", L, TRACK, Group::Comp),
    p(P_COMP_RATIO, "comp_ratio", "Ratio", 1.0, 20.0, 4.0, ":1", E, TRACK, Group::Comp),
    p(P_COMP_ATTACK, "comp_attack", "Attack", 0.1, 100.0, 5.0, "ms", E, TRACK, Group::Comp),
    p(P_COMP_RELEASE, "comp_release", "Release", 10.0, 1000.0, 120.0, "ms", E, TRACK, Group::Comp),
    p(P_COMP_MAKEUP, "comp_makeup", "Makeup", 0.0, 24.0, 0.0, "dB", L, TRACK, Group::Comp),
    with_min_label(p(P_SEND_A, "send_a", "Reverb", FADER_MIN_DB, FADER_MAX_DB, FADER_MIN_DB, "dB", F, TRACK, Group::Send), "Off"),
    flag(P_SEND_A_PRE, "send_a_pre", "Reverb pre", 0.0, TRACK, Group::Send),
    with_min_label(p(P_SEND_B, "send_b", "Delay", FADER_MIN_DB, FADER_MAX_DB, FADER_MIN_DB, "dB", F, TRACK, Group::Send), "Off"),
    flag(P_SEND_B_PRE, "send_b_pre", "Delay pre", 0.0, TRACK, Group::Send),
    p(P_REV_SIZE, "rev_size", "Size", 0.0, 1.0, 0.6, "", L, RETURN, Group::Reverb),
    p(P_REV_DECAY, "rev_decay", "Decay", 0.2, 20.0, 2.2, "s", E, RETURN, Group::Reverb),
    p(P_REV_DAMPING, "rev_damping", "Damping", 0.0, 1.0, 0.5, "", L, RETURN, Group::Reverb),
    p(P_REV_PREDELAY, "rev_predelay", "Predelay", 0.0, 200.0, 20.0, "ms", L, RETURN, Group::Reverb),
    MixParam {
        id: P_DELAY_TIME,
        name: "delay_time",
        label: "Time",
        min: 0.0,
        max: (DELAY_DIVISIONS.len() - 1) as f32,
        default: DELAY_DEFAULT_DIVISION as f32,
        unit: "",
        curve: Curve::Lin,
        integer: true,
        applies_to: RETURN,
        group: Group::Delay,
        choices: DELAY_DIVISIONS,
        min_label: "",
    },
    p(P_DELAY_FEEDBACK, "delay_feedback", "Feedback", 0.0, 0.95, 0.35, "", L, RETURN, Group::Delay),
    flag(P_DELAY_PING_PONG, "delay_ping_pong", "Ping-pong", 1.0, RETURN, Group::Delay),
    p(P_DELAY_HIGH_CUT, "delay_high_cut", "High cut", 1000.0, 20000.0, 6000.0, "Hz", E, RETURN, Group::Delay),
    p(P_LIMITER_CEILING, "limiter_ceiling", "Ceiling", -6.0, 0.0, -0.3, "dB", L, MASTER, Group::Limiter),
];

/// The param with wire id `id`, if any.
pub fn param(id: u32) -> Option<&'static MixParam> {
    PARAMS.get(id as usize).filter(|p| p.id == id)
}

/// JSON number (same form as the rack catalog: integers without a fraction,
/// others in Rust's shortest round-trip `f32` form).
fn num(v: f32) -> String {
    if v.fract() == 0.0 && v.abs() < 1e9 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// JSON string literal (catalog strings are plain ASCII).
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

fn param_json(p: &MixParam) -> String {
    let applies: Vec<String> = p.applies_to.iter().map(|k| string(k.as_str())).collect();
    let choices: Vec<String> = p.choices.iter().map(|c| string(c)).collect();
    format!(
        "{{\"id\":{},\"name\":{},\"label\":{},\"min\":{},\"max\":{},\"default\":{},\"unit\":{},\"curve\":{},\"integer\":{},\"appliesTo\":[{}],\"group\":{},\"choices\":[{}],\"minLabel\":{}}}",
        p.id,
        string(p.name),
        string(p.label),
        num(p.min),
        num(p.max),
        num(p.default),
        string(p.unit),
        string(match p.curve {
            Curve::Lin => "lin",
            Curve::Exp => "exp",
            Curve::Fader => "fader",
        }),
        p.integer,
        applies.join(","),
        string(p.group.as_str()),
        choices.join(","),
        string(p.min_label),
    )
}

/// The whole catalog as JSON (the contents of `engine/mixer_catalog.json`),
/// one param per line so the golden diffs readably. Test/tool-only: it
/// allocates.
pub fn mixer_catalog_json() -> String {
    let mut o = format!(
        "{{\n  \"version\": 1,\n  \"channels\": {{\"tracks\": {MAX_TRACKS}, \"reverb\": {MIX_REVERB}, \"delay\": {MIX_DELAY}, \"master\": {MIX_MASTER}}},\n  \"params\": ["
    );
    for (i, p) in PARAMS.iter().enumerate() {
        o.push_str(if i == 0 { "\n    " } else { ",\n    " });
        o.push_str(&param_json(p));
    }
    let law: Vec<String> = FADER_LAW.iter().map(|&(db, pos)| format!("[{},{}]", num(db), num(pos))).collect();
    o.push_str(&format!("\n  ],\n  \"faderLaw\": [{}],", law.join(",")));
    o.push_str("\n  \"delay\": {\"divisionBeats\": [");
    let beats: Vec<String> = DELAY_DIVISION_BEATS.iter().map(|&b| num(b)).collect();
    o.push_str(&beats.join(","));
    // The engine clamps a synced time to this (dsp::delay::MAX_SECONDS); the
    // UI shows "(max 2 s)" when a division is longer at the current tempo.
    o.push_str(&format!("], \"maxSeconds\": {}}}\n}}\n", num(crate::dsp::delay::MAX_SECONDS)));
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_positions_and_names_unique() {
        for (i, p) in PARAMS.iter().enumerate() {
            assert_eq!(p.id as usize, i, "{}", p.name);
            assert_eq!(param(p.id).map(|q| q.name), Some(p.name));
            for q in &PARAMS[..i] {
                assert_ne!(p.name, q.name);
            }
        }
        assert!(param(MIX_PARAMS as u32).is_none());
        // Spot-check that ids never move (wire ids).
        assert_eq!(PARAMS[0].name, "fader");
        assert_eq!(PARAMS[17].name, "send_a");
        assert_eq!(PARAMS[29].name, "limiter_ceiling");
    }

    #[test]
    fn defaults_and_ranges_are_sane() {
        for p in &PARAMS {
            assert!(p.min < p.max, "{}", p.name);
            assert!(p.valid(p.default as f64), "{} default", p.name);
            if p.integer {
                assert!(p.min.fract() == 0.0 && p.max.fract() == 0.0, "{}", p.name);
            }
            if !p.choices.is_empty() {
                assert!(p.integer && p.min == 0.0 && p.max == (p.choices.len() - 1) as f32, "{}", p.name);
            }
            if p.curve == Curve::Exp {
                assert!(p.min > 0.0, "{}: exp needs min > 0", p.name);
            }
            if p.curve == Curve::Fader {
                assert!(p.min == FADER_LAW[0].0 && p.max == FADER_LAW[FADER_LAW.len() - 1].0, "{}: fader needs the law's range", p.name);
            }
            assert!(!p.applies_to.is_empty(), "{}", p.name);
        }
        assert_eq!(DELAY_DIVISIONS.len(), DELAY_DIVISION_BEATS.len());
        assert_eq!(DELAY_DIVISION_BEATS[DELAY_DEFAULT_DIVISION], 0.75, "3/16");
    }

    #[test]
    fn accepts_follows_channel_kind_and_return_group() {
        let fader = param(P_FADER).unwrap();
        assert!(fader.accepts(0) && fader.accepts(31) && fader.accepts(MIX_REVERB) && fader.accepts(MIX_MASTER));
        assert!(!fader.accepts(MIX_CHANNELS));
        assert!(param(P_SOLO).unwrap().accepts(5) && !param(P_SOLO).unwrap().accepts(MIX_DELAY));
        assert!(!param(P_COMP_ON).unwrap().accepts(MIX_MASTER));
        assert!(param(P_REV_SIZE).unwrap().accepts(MIX_REVERB) && !param(P_REV_SIZE).unwrap().accepts(MIX_DELAY));
        assert!(param(P_DELAY_TIME).unwrap().accepts(MIX_DELAY) && !param(P_DELAY_TIME).unwrap().accepts(MIX_REVERB));
        assert!(param(P_LIMITER_CEILING).unwrap().accepts(MIX_MASTER) && !param(P_LIMITER_CEILING).unwrap().accepts(0));
        assert!(!param(P_PAN).unwrap().accepts(MIX_MASTER));
    }

    #[test]
    fn valid_checks_range_and_integers() {
        let mute = param(P_MUTE).unwrap();
        assert!(mute.valid(0.0) && mute.valid(1.0) && !mute.valid(0.5) && !mute.valid(2.0));
        let fader = param(P_FADER).unwrap();
        assert!(fader.valid(-60.0) && fader.valid(6.0) && fader.valid(-3.5));
        assert!(!fader.valid(6.01) && !fader.valid(f64::NAN) && !fader.valid(f64::NEG_INFINITY));
        assert!(!fader.valid(1e300) && !fader.valid(-1e300));
        assert!(param(P_DELAY_FEEDBACK).unwrap().valid(0.95), "the f64 of the catalog max");
    }

    /// Plan 19: the fader law is pinned here (it was `FADER_LAW` in
    /// app/src/ui/mixer/mixMath.ts), exported verbatim as `"faderLaw"`, and
    /// the fader and both sends use it as their curve.
    #[test]
    fn fader_law_matches_catalog_export() {
        let want: [(f32, f32); 7] = [(-60.0, 0.0), (-40.0, 0.14), (-30.0, 0.25), (-20.0, 0.38), (-10.0, 0.55), (0.0, 0.75), (6.0, 1.0)];
        assert_eq!(FADER_LAW, want);
        let json = mixer_catalog_json();
        assert!(
            json.contains("\"faderLaw\": [[-60,0],[-40,0.14],[-30,0.25],[-20,0.38],[-10,0.55],[0,0.75],[6,1]]"),
            "faderLaw export: {json}"
        );
        for p in &PARAMS {
            let fader = matches!(p.name, "fader" | "send_a" | "send_b");
            assert_eq!(p.curve == Curve::Fader, fader, "{}", p.name);
            if fader {
                assert_eq!((p.min, p.max), (FADER_LAW[0].0, FADER_LAW[6].0), "{}: the law spans the range", p.name);
                assert!(json.contains(&format!("\"name\":\"{}\",", p.name)));
            }
        }
        assert_eq!(json.matches("\"curve\":\"fader\"").count(), 3);
    }

    #[test]
    fn mixer_catalog_matches_golden() {
        let json = mixer_catalog_json();
        if std::env::var("UPDATE_CATALOG").as_deref() == Ok("1") {
            let path = concat!(env!("CARGO_MANIFEST_DIR"), "/mixer_catalog.json");
            std::fs::write(path, &json).expect("write mixer_catalog.json");
            return;
        }
        assert_eq!(
            json,
            include_str!("../../mixer_catalog.json"),
            "engine/mixer_catalog.json is stale: run UPDATE_CATALOG=1 cargo test -p daw-engine catalog"
        );
    }
}
