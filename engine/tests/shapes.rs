//! Shape fixtures for the UI's ADSR and LFO previews (plan 12 Task 5;
//! `app/src/ui/vis/shapes.ts`, tested by `shapes.test.ts`).
//!
//! This renders the REAL modules (`rack::modules::{adsr::Adsr, lfo::Lfo}`)
//! and samples 64 points of each shape into `fixtures/shapes.json`; the
//! vitest checks that the preview's drawn polyline passes within 0.01 of
//! every point (mapped through the preview's time axis). With
//! `UPDATE_FIXTURES=1` the test (re)writes the file, otherwise it compares
//! (numbers within 1e-5, everything else exact).
//!
//! **ADSR** (three param sets, one with `delay`): a mono gate rises at sample
//! 0 and falls at `gate_off` = delay + attack + 2 × decay (the preview's
//! plateau stands for one more decay time, by which the decay has settled to
//! within 1e-4 of `sustain`); `vel` unconnected (full velocity). A point is
//! `[t, value]` where `t = (n + 1) / sr` for output sample `n` (the level
//! after n + 1 samples: the attack's first sample already moved by one
//! step). Points are spread evenly inside each segment (delay, attack,
//! decay, plateau, release; 64 in all), at segment fractions `(j + ½) / m`
//! so no point sits on a corner.
//!
//! **LFO** (Sine, Tri, Saw, Square; free and synced): a point is
//! `[phase, value]` for one cycle, at phases `(k + ½) / 64` of the SECOND
//! cycle (after the 1 ms output slew and the depth smoother settled; the
//! half-step keeps every point ≥ 1/128 cycle from the square's and saw's
//! jumps, which at these rates is ≥ 9 ms, i.e. ≥ 9 slew time constants).
//! Free: phase = `n × rate / sr` mod 1. Synced (transport playing from tick
//! 0): phase = `ticks(n) / division_ticks` mod 1.
use daw_engine::rack::catalog::LFO_DIVISION_TICKS;
use daw_engine::rack::modules::adsr::Adsr;
use daw_engine::rack::modules::lfo::Lfo;
use daw_engine::rack::modules::Ctx;
use daw_engine::rack::port::PortBuf;
use daw_engine::{MAX_PARAMS, PPQ, RACK_BLOCK};
use std::fmt::Write as _;

const SR: f32 = 48000.0;
const POINTS: usize = 64;

/// (name, attack, decay, sustain, release, delay) in seconds / 0..1.
const ADSR_CASES: &[(&str, f32, f32, f32, f32, f32)] = &[
    ("default", 0.005, 0.2, 0.7, 0.3, 0.0),
    ("pluck", 0.001, 0.15, 0.0, 0.08, 0.0),
    ("delayed pad", 0.8, 1.5, 0.6, 2.5, 0.25),
];

/// (name, wave, rate Hz, depth, sync, division index, bpm). Rates are slow
/// enough that the 1 ms slew is invisible at the sampled phases (see top).
const LFO_CASES: &[(&str, u32, f32, f32, bool, usize, f32)] = &[
    ("sine free", 0, 0.5, 1.0, false, 3, 120.0),
    ("tri free", 1, 0.8, 0.6, false, 3, 120.0),
    ("saw free", 2, 0.4, 0.8, false, 3, 120.0),
    ("square free", 3, 0.5, 0.5, false, 3, 120.0),
    ("sine 1 bar", 0, 2.0, 0.7, true, 5, 120.0),
    ("tri 1/2", 1, 2.0, 1.0, true, 4, 100.0),
    ("saw 2 bars", 2, 2.0, 0.9, true, 6, 124.0),
    ("square 1/2", 3, 2.0, 0.4, true, 4, 90.0),
];

/// Every output sample of the ADSR for `total` samples, gate high below `off`.
fn render_adsr(p: &[f32], off: usize, total: usize) -> Vec<f32> {
    let mut env = Adsr::new(SR);
    env.snap(); // sustain / vel_amt start at their params, not the defaults
    let mut ins = [PortBuf::new(), PortBuf::new()];
    ins[0].channels = 1;
    let mut outs = [PortBuf::new()];
    let mut all = Vec::with_capacity(total + RACK_BLOCK);
    let mut n = 0;
    while n < total {
        for i in 0..RACK_BLOCK {
            ins[0].data[0][i] = if n + i < off { 1.0 } else { 0.0 };
        }
        env.process(p, &ins, &mut outs);
        all.extend_from_slice(&outs[0].data[0]);
        n += RACK_BLOCK;
    }
    all
}

/// Every output sample of the LFO for `total` samples.
fn render_lfo(p: &[f32], sync: bool, bpm: f32, total: usize) -> Vec<f32> {
    let mut lfo = Lfo::new(SR);
    let tpf = bpm as f64 * PPQ / (60.0 * SR as f64);
    let mut outs = [PortBuf::new()];
    let mut all = Vec::with_capacity(total + RACK_BLOCK);
    let mut n = 0;
    while n < total {
        let ctx = Ctx { sr: SR, bpm, playing: sync, ticks: n as f64 * tpf, ticks_per_frame: if sync { tpf } else { 0.0 } };
        lfo.process(&ctx, p, &mut outs);
        all.extend_from_slice(&outs[0].data[0]);
        n += RACK_BLOCK;
    }
    all
}

fn num(x: f64) -> String {
    let s = format!("{x:.6}");
    if s == "-0.000000" { "0.000000".into() } else { s }
}

fn points_json(pts: &[(f64, f64)]) -> String {
    let v: Vec<String> = pts.iter().map(|(a, b)| format!("[{}, {}]", num(*a), num(*b))).collect();
    format!("[{}]", v.join(", "))
}

fn adsr_json() -> String {
    let mut out = Vec::new();
    for &(name, a, d, s, r, dl) in ADSR_CASES {
        let mut p = [0.0f32; MAX_PARAMS];
        p[..6].copy_from_slice(&[a, d, s, r, dl, 0.0]);
        let off = ((dl + a + 2.0 * d) * SR).round() as usize;
        let total = off + (r * SR).ceil() as usize + 1;
        let y = render_adsr(&p, off, total);
        // Segment bounds in seconds (the delay segment only if delay > 0).
        let t_off = off as f64 / SR as f64;
        let mut bounds = vec![0.0f64];
        if dl > 0.0 {
            bounds.push(dl as f64);
        }
        for t in [dl + a, dl + a + d] {
            bounds.push(t as f64);
        }
        bounds.push(t_off);
        bounds.push(t_off + r as f64);
        let segs = bounds.len() - 1;
        let mut pts = Vec::with_capacity(POINTS);
        for sgi in 0..segs {
            let m = POINTS / segs + usize::from(sgi < POINTS % segs);
            let (t0, t1) = (bounds[sgi], bounds[sgi + 1]);
            for j in 0..m {
                let t = t0 + (t1 - t0) * (j as f64 + 0.5) / m as f64;
                // Output sample n holds the level at t = (n + 1) / sr.
                let n = ((t * SR as f64).round() as usize).max(1) - 1;
                pts.push(((n + 1) as f64 / SR as f64, y[n] as f64));
            }
        }
        assert_eq!(pts.len(), POINTS);
        out.push(format!(
            "    {{\"name\": \"{name}\", \"attack\": {a}, \"decay\": {d}, \"sustain\": {s}, \"release\": {r}, \"delay\": {dl}, \"gateOff\": {}, \"points\": {}}}",
            num(t_off),
            points_json(&pts)
        ));
    }
    out.join(",\n")
}

fn lfo_json() -> String {
    let mut out = Vec::new();
    for &(name, wave, rate, depth, sync, div, bpm) in LFO_CASES {
        let mut p = [0.0f32; MAX_PARAMS];
        p[..5].copy_from_slice(&[wave as f32, rate, if sync { 1.0 } else { 0.0 }, div as f32, depth]);
        let div_ticks = LFO_DIVISION_TICKS[div];
        let tpf = bpm as f64 * PPQ / (60.0 * SR as f64);
        // Frames per cycle, and each frame's phase (as the engine computes it).
        let (cycle, phase_of): (f64, Box<dyn Fn(usize) -> f64>) = if sync {
            (div_ticks / tpf, Box::new(move |n| (n as f64 * tpf / div_ticks).rem_euclid(1.0)))
        } else {
            let inc = rate as f64 / SR as f64;
            (1.0 / inc, Box::new(move |n| (n as f64 * inc).rem_euclid(1.0)))
        };
        let total = (cycle * 2.0).ceil() as usize + RACK_BLOCK;
        let y = render_lfo(&p, sync, bpm, total);
        let pts: Vec<(f64, f64)> = (0..POINTS)
            .map(|k| {
                let n = (cycle * (1.0 + (k as f64 + 0.5) / POINTS as f64)).round() as usize;
                (phase_of(n), y[n] as f64)
            })
            .collect();
        out.push(format!(
            "    {{\"name\": \"{name}\", \"wave\": {wave}, \"rate\": {rate}, \"depth\": {depth}, \"sync\": {}, \"division\": {div}, \"bpm\": {bpm}, \"points\": {}}}",
            u8::from(sync),
            points_json(&pts)
        ));
    }
    out.join(",\n")
}

fn fixture() -> String {
    let mut s = String::new();
    writeln!(s, "{{").unwrap();
    writeln!(s, "  \"generatedBy\": \"engine/tests/shapes.rs (UPDATE_FIXTURES=1 cargo test -p daw-engine --test shapes)\",").unwrap();
    writeln!(s, "  \"sr\": {SR},").unwrap();
    writeln!(s, "  \"adsr\": [\n{}\n  ],", adsr_json()).unwrap();
    writeln!(s, "  \"lfo\": [\n{}\n  ]", lfo_json()).unwrap();
    writeln!(s, "}}").unwrap();
    s
}

/// Splits `s` into its non-numeric skeleton and its numbers.
fn split_numbers(s: &str) -> (String, Vec<f64>) {
    let mut skel = String::new();
    let mut nums = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let starts = c.is_ascii_digit() || (c == b'-' && b.get(i + 1).is_some_and(u8::is_ascii_digit));
        // Digits inside a name ("1/4", "2 bars") are text: numbers follow ": " or "[" / ", ".
        let prev = if i > 0 { b[i - 1] } else { b' ' };
        if starts && matches!(prev, b' ' | b'[') {
            let st = i;
            i += 1;
            while i < b.len() && matches!(b[i], b'0'..=b'9' | b'.' | b'e' | b'E' | b'-' | b'+') {
                i += 1;
            }
            nums.push(s[st..i].parse().unwrap());
            skel.push('#');
        } else {
            skel.push(c as char);
            i += 1;
        }
    }
    (skel, nums)
}

#[test]
fn shape_fixtures_are_current() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/shapes.json");
    let now = fixture();
    if std::env::var("UPDATE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::write(path, &now).expect("write shapes.json");
        return;
    }
    let saved = std::fs::read_to_string(path).expect("tests/fixtures/shapes.json (run with UPDATE_FIXTURES=1)");
    let (ks, ns) = split_numbers(&saved);
    let (kn, nn) = split_numbers(&now);
    assert_eq!(ks, kn, "shapes.json is stale: regenerate with UPDATE_FIXTURES=1");
    assert_eq!(ns.len(), nn.len());
    for (i, (a, b)) in ns.iter().zip(&nn).enumerate() {
        assert!((a - b).abs() <= 1e-5, "number {i}: saved {a}, engine {b} (UPDATE_FIXTURES=1 to regenerate)");
    }
}
