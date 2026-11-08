//! Automation lanes through the whole engine (plan 10, Task 1): lanes follow
//! song time per 32-frame sub-block, steps are declicked, jumps chase, a
//! manual move overrides until the next breakpoint, Pattern mode plays the
//! base value, and a lane goes away with its target.
//!
//! The constant input is a synth track whose MIDI In gate (one held live
//! note) feeds its Out at `level`: the track buffer is exactly `level`, so
//! the engine output is `level × fader gain × 0.8` (the legacy master gain;
//! the limiter is transparent below its ceiling). 120 bpm at 48 kHz is 25
//! frames per tick; a bar (3840 ticks) is 96000 frames.

use super::*;
use crate::automation::Target;
use crate::mixer::catalog::{P_EQ_MID_FREQ, P_FADER, P_MUTE, P_PAN, P_SEND_A};
use crate::protocol::*;
use crate::{MAX_AUTO_LANES, MAX_AUTO_POINTS, MIX_REVERB, MAX_SONG_TICKS};

const SR: f32 = 48000.0;
/// Frames per tick at 120 bpm / 48 kHz.
const FPT: f64 = 25.0;
const BLOCK: usize = 128;
/// One sub-block plus the 5 ms gain smoothing, plus a frame of slack.
const SETTLE: usize = 32 + 240 + 1;

// Module kind wire ids and the params used here (rack/catalog.rs).
const K_MIDI_IN: f64 = 0.0;
const K_NOISE: f64 = 2.0;
const K_FILTER: f64 = 3.0;
const K_OUT: f64 = 8.0;
const FILTER_MODE: usize = 0;
const FILTER_CUTOFF: usize = 1;
const OUT_LEVEL: usize = 0;

fn eng() -> Engine {
    let mut e = Engine::with_lookahead(SR, 0.0);
    ok(e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0));
    e
}

fn ok(code: i32) {
    assert_eq!(code, OK);
}

fn cmd(e: &mut Engine, op: u32, a: f64, b: f64, c: f64, d: f64) {
    assert_eq!(e.command(op, a, b, c, d), OK, "op {op} a {a} b {b} c {c} d {d}");
}

fn pk(module: usize, port: usize) -> f64 {
    (module * 16 + port) as f64
}

/// Synth track `slot` whose output is a constant `level` (MIDI In gate ->
/// Out.l, one live note held), settled past the Out level smoothing.
fn constant_track(e: &mut Engine, slot: usize, level: f64) {
    let s = slot as f64;
    cmd(e, OP_ADD_SYNTH_TRACK, s, 0.0, 0.0, 0.0);
    cmd(e, OP_RACK_ADD_MODULE, s, 0.0, K_MIDI_IN, 0.0);
    cmd(e, OP_RACK_ADD_MODULE, s, 1.0, K_OUT, 0.0);
    cmd(e, OP_RACK_CONNECT, s, pk(0, 1), pk(1, 0), 0.0);
    cmd(e, OP_RACK_SET_PARAM, s, 1.0, OUT_LEVEL as f64, level);
    cmd(e, OP_SET_INPUT_TRACK, s, 0.0, 0.0, 0.0);
    cmd(e, OP_NOTE_ON, 60.0, 127.0, 0.0, 0.0);
    render(e, 9600);
}

/// Synth track `slot`: Noise -> Filter (LP24) -> Out.l.
fn noise_track(e: &mut Engine, slot: usize) {
    let s = slot as f64;
    cmd(e, OP_ADD_SYNTH_TRACK, s, 0.0, 0.0, 0.0);
    cmd(e, OP_RACK_ADD_MODULE, s, 0.0, K_NOISE, 0.0);
    cmd(e, OP_RACK_ADD_MODULE, s, 1.0, K_FILTER, 0.0);
    cmd(e, OP_RACK_ADD_MODULE, s, 2.0, K_OUT, 0.0);
    cmd(e, OP_RACK_CONNECT, s, pk(0, 0), pk(1, 0), 0.0);
    cmd(e, OP_RACK_CONNECT, s, pk(1, 0), pk(2, 0), 0.0);
}

fn lane_mix(e: &mut Engine, lane: usize, ch: usize, id: u32) -> i32 {
    e.command(OP_AUTO_LANE_SET, lane as f64, 1.0, ch as f64, id as f64)
}

fn lane_rack(e: &mut Engine, lane: usize, slot: usize, module: usize, param: usize) -> i32 {
    e.command(OP_AUTO_LANE_SET, lane as f64, 2.0, slot as f64, (module * 16 + param) as f64)
}

fn point(e: &mut Engine, lane: usize, idx: usize, tick: f64, value: f64, hold: bool) -> i32 {
    let a = (lane * MAX_AUTO_POINTS + idx) as f64;
    e.command(OP_AUTO_POINT_SET, a, tick, value, if hold { 1.0 } else { 0.0 })
}

fn song(e: &mut Engine, on: bool) {
    cmd(e, OP_SET_MODE, if on { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0);
}

/// Render `frames` (whole 128-frame blocks); returns L.
fn render(e: &mut Engine, frames: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames);
    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    for _ in 0..frames.div_ceil(BLOCK) {
        e.process(&mut l, &mut r);
        out.extend_from_slice(&l);
    }
    out
}

fn ticks(e: &Engine) -> f64 {
    e.telemetry()[TELEMETRY_TICKS]
}

/// The fader gain in dB that output sample `x` shows for a constant track at
/// `level` (`level × g × 0.8`).
fn db(x: f32, level: f64) -> f64 {
    20.0 * (x as f64 / (level * 0.8)).log10()
}

/// Max sample-to-sample step of `xs`, starting from `prev`.
fn max_step(prev: f32, xs: &[f32]) -> f32 {
    let mut last = prev;
    xs.iter().fold(0.0f32, |m, &x| {
        let d = (x - last).abs();
        last = x;
        m.max(d)
    })
}

fn lane_target(e: &Engine, i: usize) -> Target {
    e.automation.lane(i).unwrap().target()
}

fn lane_count(e: &Engine, i: usize) -> usize {
    e.automation.lane(i).unwrap().count()
}

/// Render `blocks` blocks and check that, once `SETTLE` frames have passed
/// since the last jump of song time (a seek, wrap, Play, mode switch: the
/// playhead does not continue from the previous block), every block's first
/// sample is within 0.1 dB of `ideal(tick)`. `since` is how many frames have
/// passed since the last jump before the first block.
fn follow(e: &mut Engine, blocks: usize, level: f64, mut since: usize, ideal: impl Fn(f64) -> f64) {
    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    for b in 0..blocks {
        let t = ticks(e);
        e.process(&mut l, &mut r);
        if since >= SETTLE {
            let got = db(l[0], level);
            let want = ideal(t);
            assert!((got - want).abs() <= 0.1, "block {b} tick {t}: {got:.3} dB, want {want:.3} dB");
        }
        // A wrap inside this block: count from its end (conservative).
        let step = if e.transport.playing { BLOCK as f64 / FPT } else { 0.0 };
        let continuous = (ticks(e) - t - step).abs() < 1e-6;
        since = if continuous { since + BLOCK } else { 0 };
    }
}

#[test]
fn linear_lane_follows_the_line() {
    let mut e = eng();
    constant_track(&mut e, 0, 0.5);
    ok(lane_mix(&mut e, 0, 0, P_FADER));
    ok(point(&mut e, 0, 0, 0.0, -24.0, false));
    ok(point(&mut e, 0, 1, 3840.0, 0.0, false));
    ok(lane_mix(&mut e, 1, 0, P_SEND_A));
    ok(point(&mut e, 1, 0, 0.0, -40.0, false));
    ok(point(&mut e, 1, 1, 3840.0, -4.0, false));
    // The send is measured on its gain; the Reverb return is muted so the
    // output shows the fader alone.
    cmd(&mut e, OP_MIX_SET, MIX_REVERB as f64, P_MUTE as f64, 1.0, 0.0);
    song(&mut e, true);
    render(&mut e, 9600); // parked at tick 0: settles at the lane's start
    let x = render(&mut e, BLOCK)[0];
    assert!((db(x, 0.5) + 24.0).abs() < 0.01, "{x} {}", db(x, 0.5));
    cmd(&mut e, OP_PLAY, 0.0, 0.0, 0.0, 0.0);
    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    let mut out = Vec::new();
    for _ in 0..96000 / BLOCK {
        e.process(&mut l, &mut r);
        out.extend_from_slice(&l);
        // The send gain at the block end sits on the line (linear in dB).
        let t = ticks(&e);
        let want = -40.0 + 36.0 * (t / 3840.0).min(1.0);
        let send = e.mixer().ramps(0)[2] as f64;
        let got = 20.0 * send.log10();
        assert!((got - want).abs() <= 0.1, "send at tick {t}: {got:.3} dB, want {want:.3}");
    }
    // The fader at every sub-block start: within 0.1 dB of the ideal line
    // (the review bound). It is in fact followed, not chased: a 5 ms glide
    // towards each new value would lag by ~0.06 dB here, a line by none
    // (sample f carries the gain of frame f + 1).
    let mut worst = 0.0f64;
    for f in (0..96000).step_by(32) {
        let want = -24.0 + 24.0 * ((f + 1) as f64 / FPT) / 3840.0;
        let got = db(out[f], 0.5);
        assert!((got - want).abs() <= 0.1, "frame {f}: {got:.3} dB, want {want:.3}");
        if f >= 64 {
            // (Play is a jump: its first sub-block holds the start value.)
            worst = worst.max((got - want).abs());
        }
    }
    assert!(worst < 0.005, "lags the line by {worst:.4} dB");
    // No zipper: a linear ride never steps between samples.
    assert!(max_step(out[0], &out) < 1e-4, "step {}", max_step(out[0], &out));
}

fn curve(e: &mut Engine, lane: usize, idx: usize, c: f64) -> i32 {
    e.command(OP_AUTO_POINT_CURVE, (lane * MAX_AUTO_POINTS + idx) as f64, c, 0.0, 0.0)
}

/// Plan 16: a curved segment (AUTO_POINT_CURVE) is followed through the
/// engine like a line, f(x) = x^(2^(-3 curve)) of the way at fraction x;
/// AUTO_POINT_SET resets it to linear.
#[test]
fn curved_lane_follows_the_curve() {
    let mut e = eng();
    constant_track(&mut e, 0, 0.5);
    ok(lane_mix(&mut e, 0, 0, P_FADER));
    ok(point(&mut e, 0, 0, 0.0, -36.0, false));
    ok(point(&mut e, 0, 1, 3840.0, 0.0, false));
    assert_eq!(curve(&mut e, 0, 2, 0.5), ERR_BAD_VALUE, "an inactive point");
    assert_eq!(curve(&mut e, 0, 0, 1.5), ERR_BAD_VALUE, "past +1");
    assert_eq!(curve(&mut e, 5, 0, 0.5), ERR_BAD_VALUE, "a lane without a target");
    ok(curve(&mut e, 0, 0, -0.5)); // slow start: x^2.83
    song(&mut e, true);
    render(&mut e, 9600);
    cmd(&mut e, OP_PLAY, 0.0, 0.0, 0.0, 0.0);
    let ideal = |t: f64| -36.0 + 36.0 * (t / 3840.0).clamp(0.0, 1.0).powf(2f64.powf(1.5));
    follow(&mut e, 96000 / BLOCK, 0.5, 0, ideal);
    // A quarter of the way: far below the straight line's -27 dB.
    cmd(&mut e, OP_SEEK, 960.0, 0.0, 0.0, 0.0);
    follow(&mut e, 8, 0.5, 0, ideal);
    let q = db(render(&mut e, BLOCK)[0], 0.5);
    assert!(q < -35.0, "{q}");
    // SET on the point again: linear.
    ok(point(&mut e, 0, 0, 0.0, -36.0, false));
    cmd(&mut e, OP_SEEK, 960.0, 0.0, 0.0, 0.0);
    follow(&mut e, 8, 0.5, 0, |t| -36.0 + 36.0 * t / 3840.0);
}

#[test]
fn exp_param_interpolates_in_knob_space() {
    let mut e = eng();
    constant_track(&mut e, 0, 0.5);
    ok(lane_mix(&mut e, 0, 0, P_EQ_MID_FREQ));
    ok(point(&mut e, 0, 0, 0.0, 200.0, false));
    ok(point(&mut e, 0, 1, 3840.0, 2000.0, false));
    song(&mut e, true);
    render(&mut e, 1280);
    cmd(&mut e, OP_PLAY, 0.0, 0.0, 0.0, 0.0);
    render(&mut e, 48000); // to tick 1920, half way
    assert!((ticks(&e) - 1920.0).abs() < 1e-6);
    let f = e.mixer().effective(0, P_EQ_MID_FREQ);
    let want = (200.0f32 * 2000.0).sqrt(); // 632.46 Hz: half way in knob space
    assert!((f - want).abs() < 0.5, "mid freq {f} Hz, want {want}");
    // The stored (base) value is untouched.
    assert_eq!(e.mixer().param(0, P_EQ_MID_FREQ), 1000.0);
}

#[test]
fn hold_step_is_declicked() {
    let mut e = eng();
    constant_track(&mut e, 0, 0.5);
    ok(lane_mix(&mut e, 0, 0, P_FADER));
    ok(point(&mut e, 0, 0, 0.0, 0.0, true));
    ok(point(&mut e, 0, 1, 1920.0, -60.0, true)); // frame 48000: −inf
    song(&mut e, true);
    render(&mut e, 1280);
    cmd(&mut e, OP_PLAY, 0.0, 0.0, 0.0, 0.0);
    let out = render(&mut e, 96000);
    assert!((out[47999] - 0.4).abs() < 1e-4, "holds 0 dB up to the point: {}", out[47999]);
    let step = max_step(out[0], &out);
    assert!(step <= 0.02, "step {step}");
    assert!(out[48000 + 120] > 0.15, "the step glides over the 5 ms smoothing: {}", out[48000 + 120]);
    assert!(out[48000 + SETTLE..].iter().all(|&x| x == 0.0), "silent after the step");
}

#[test]
fn lane_chases_on_seek_wrap_and_play() {
    let mut e = eng();
    constant_track(&mut e, 0, 0.5);
    ok(lane_mix(&mut e, 0, 0, P_FADER));
    ok(point(&mut e, 0, 0, 0.0, -40.0, false));
    ok(point(&mut e, 0, 1, 7680.0, 0.0, false));
    let ideal = |t: f64| -40.0 + 40.0 * (t / 7680.0).clamp(0.0, 1.0);
    song(&mut e, true);
    render(&mut e, 1280);
    cmd(&mut e, OP_PLAY, 0.0, 0.0, 0.0, 0.0);
    follow(&mut e, 1125, 0.5, SETTLE, ideal); // to tick 5760
    assert!((ticks(&e) - 5760.0).abs() < 1e-6);

    // Seek back while playing: the fader is at the new position's value one
    // sub-block plus the smoothing later, never sweeping from the old one.
    cmd(&mut e, OP_SEEK, 960.0, 0.0, 0.0, 0.0);
    let out = render(&mut e, 512);
    let got = db(out[SETTLE], 0.5);
    let want = ideal(960.0 + SETTLE as f64 / FPT);
    assert!((got - want).abs() <= 0.1, "after the seek: {got:.3} dB, want {want:.3}");
    let peak = out.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    assert!(db(peak, 0.5) <= ideal(5760.0) + 0.1, "no overshoot past the old value");
    follow(&mut e, 500, 0.5, 512, ideal);

    // A loop wrap mid-block chases the same way.
    cmd(&mut e, OP_SET_LOOP, 0.0, 3840.0, 0.0, 0.0);
    follow(&mut e, 1200, 0.5, SETTLE, ideal);

    // Stop goes home (the loop start); a seek while stopped follows; Play
    // then continues from there without any sweep.
    cmd(&mut e, OP_STOP, 0.0, 0.0, 0.0, 0.0);
    cmd(&mut e, OP_SET_LOOP, 0.0, 0.0, 0.0, 0.0);
    cmd(&mut e, OP_SEEK, 5000.0, 0.0, 0.0, 0.0);
    follow(&mut e, 20, 0.5, 0, ideal);
    cmd(&mut e, OP_PLAY, 0.0, 0.0, 0.0, 0.0);
    follow(&mut e, 200, 0.5, SETTLE, ideal);

    // A mode switch: Pattern mode plays the base (0 dB), back in Song mode
    // the lane chases its value at the song start.
    song(&mut e, false);
    render(&mut e, 1280);
    assert!(db(render(&mut e, BLOCK)[0], 0.5).abs() < 0.01, "pattern mode: base");
    song(&mut e, true);
    follow(&mut e, 200, 0.5, 0, ideal);
}

#[test]
fn stopped_song_mode_follows_parked_position() {
    let mut e = eng();
    constant_track(&mut e, 0, 0.5);
    ok(lane_mix(&mut e, 0, 0, P_FADER));
    ok(point(&mut e, 0, 0, 0.0, -20.0, true));
    ok(point(&mut e, 0, 1, 3840.0, -6.0, true));
    song(&mut e, true);
    let out = render(&mut e, 1280);
    assert!((db(out[1279], 0.5) + 20.0).abs() < 0.01);
    cmd(&mut e, OP_SEEK, 4000.0, 0.0, 0.0, 0.0);
    let out = render(&mut e, 2560);
    assert!(out[SETTLE..].iter().all(|&x| (db(x, 0.5) + 6.0).abs() < 0.01), "follows the parked position");
    assert_eq!(ticks(&e), 4000.0, "stopped: the playhead stays");
    cmd(&mut e, OP_SEEK, 100.0, 0.0, 0.0, 0.0);
    let out = render(&mut e, 1280);
    assert!(out[SETTLE..].iter().all(|&x| (db(x, 0.5) + 20.0).abs() < 0.01));
    assert!(max_step(out[0], &out) < 0.01, "the seek is smoothed");
}

#[test]
fn override_holds_until_next_point() {
    let mut e = eng();
    constant_track(&mut e, 0, 0.5);
    ok(lane_mix(&mut e, 0, 0, P_FADER));
    ok(point(&mut e, 0, 0, 0.0, -20.0, true));
    ok(point(&mut e, 0, 1, 3840.0, -6.0, true)); // frame 96000
    ok(point(&mut e, 0, 2, 7680.0, -12.0, true));
    song(&mut e, true);
    render(&mut e, 1280);
    cmd(&mut e, OP_PLAY, 0.0, 0.0, 0.0, 0.0);
    let before = render(&mut e, 25600); // to tick 1024
    assert!((db(before[25599], 0.5) + 20.0).abs() < 0.01);

    // A manual move: AUTO_OVERRIDE, then the edit's own MIX_SET, heard at once.
    cmd(&mut e, OP_AUTO_OVERRIDE, 0.0, 0.0, 0.0, 0.0);
    cmd(&mut e, OP_MIX_SET, 0.0, P_FADER as f64, -3.0, 0.0);
    let out = render(&mut e, 96000 - 25600 + 1280);
    assert!(out[SETTLE..96000 - 25600].iter().all(|&x| (db(x, 0.5) + 3.0).abs() < 0.01), "held until the point");
    // The lane takes over again exactly at the next point's tick.
    let at = 96000 - 25600;
    assert!(out[at + SETTLE..].iter().all(|&x| (db(x, 0.5) + 6.0).abs() < 0.01), "resumed at the point");
    assert!(max_step(out[0], &out) < 0.01, "both steps are smoothed");
    assert_eq!(e.mixer().param(0, P_FADER), -3.0, "the manual value is the base");
    assert_eq!(e.automation.lane(0).unwrap().base(), -3.0);

    // Override again; a seek ends the suspension at once.
    cmd(&mut e, OP_AUTO_OVERRIDE, 0.0, 0.0, 0.0, 0.0);
    cmd(&mut e, OP_MIX_SET, 0.0, P_FADER as f64, -1.0, 0.0);
    let out = render(&mut e, 1280);
    assert!((db(out[1279], 0.5) + 1.0).abs() < 0.01);
    cmd(&mut e, OP_SEEK, 2000.0, 0.0, 0.0, 0.0);
    let out = render(&mut e, 1280);
    assert!((db(out[SETTLE], 0.5) + 20.0).abs() < 0.01, "a seek resumes the lane");

    // While stopped, a suspension lasts until Play.
    cmd(&mut e, OP_STOP, 0.0, 0.0, 0.0, 0.0);
    render(&mut e, 1280);
    cmd(&mut e, OP_AUTO_OVERRIDE, 0.0, 0.0, 0.0, 0.0);
    cmd(&mut e, OP_MIX_SET, 0.0, P_FADER as f64, -2.0, 0.0);
    let out = render(&mut e, 9600);
    assert!(out[SETTLE..].iter().all(|&x| (db(x, 0.5) + 2.0).abs() < 0.01), "stopped: stays overridden");
    cmd(&mut e, OP_PLAY, 0.0, 0.0, 0.0, 0.0);
    let out = render(&mut e, 1280);
    let t = ticks(&e);
    assert!(t < 3840.0);
    assert!((db(out[SETTLE], 0.5) + 20.0).abs() < 0.01, "Play resumes the lane");
}

#[test]
fn pattern_mode_uses_base_value() {
    let mut e = eng();
    constant_track(&mut e, 0, 0.5);
    cmd(&mut e, OP_MIX_SET, 0.0, P_FADER as f64, -3.0, 0.0);
    ok(lane_mix(&mut e, 0, 0, P_FADER));
    ok(point(&mut e, 0, 0, 0.0, -20.0, false)); // a single point: constant
    ok(lane_rack(&mut e, 1, 0, 1, OUT_LEVEL));
    ok(point(&mut e, 1, 0, 0.0, 0.25, false));
    let rack_level = |e: &mut Engine| e.synths.rack_mut(0).unwrap().param(1, OUT_LEVEL).unwrap();
    assert_eq!(e.automation.lane(1).unwrap().base(), 0.5, "AUTO_LANE_SET captures the base");

    // Pattern mode (the default): the base plays.
    let out = render(&mut e, 1280);
    assert!((db(out[1279], 0.5) + 3.0).abs() < 0.01);
    assert_eq!(rack_level(&mut e), 0.5);
    song(&mut e, true);
    render(&mut e, 1280);
    assert_eq!(rack_level(&mut e), 0.25, "song mode: the lane drives the rack");
    // Out level 0.25 and the fader at −20 dB: 0.25 × 0.1 × 0.8.
    let out = render(&mut e, 9600);
    assert!((out[9599] as f64 - 0.25 * 0.1 * 0.8).abs() < 1e-4, "{}", out[9599]);

    // Edits in Song mode store the base; they are heard only once the lane
    // stops applying.
    cmd(&mut e, OP_MIX_SET, 0.0, P_FADER as f64, -9.0, 0.0);
    cmd(&mut e, OP_RACK_SET_PARAM, 0.0, 1.0, OUT_LEVEL as f64, 0.4);
    let out = render(&mut e, 1280);
    assert!((out[1279] as f64 - 0.02).abs() < 1e-4, "still the lane: {}", out[1279]);
    assert_eq!(e.mixer().param(0, P_FADER), -9.0);
    assert_eq!(rack_level(&mut e), 0.25);
    assert_eq!(e.automation.lane(1).unwrap().base(), 0.4);

    song(&mut e, false);
    let out = render(&mut e, 9600);
    assert!(max_step(out[0], &out) < 0.01, "back to the base smoothly");
    assert!((db(out[9599], 0.4) + 9.0).abs() < 0.01, "pattern mode: the base again");
    assert_eq!(rack_level(&mut e), 0.4);

    // A disabled lane plays the base too.
    song(&mut e, true);
    render(&mut e, 1280);
    assert_eq!(rack_level(&mut e), 0.25);
    cmd(&mut e, OP_AUTO_LANE_ENABLE, 1.0, 0.0, 0.0, 0.0);
    assert_eq!(rack_level(&mut e), 0.4, "disabling re-applies the base at once");
    cmd(&mut e, OP_AUTO_LANE_ENABLE, 1.0, 1.0, 0.0, 0.0);
    render(&mut e, 128);
    assert_eq!(rack_level(&mut e), 0.25);
}

/// Spectral centroid (Hz) of `x` (Hann window, plain DFT).
fn centroid(x: &[f32]) -> f64 {
    let n = x.len();
    let w: Vec<f64> = (0..n)
        .map(|i| x[i] as f64 * (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos()))
        .collect();
    let (mut num, mut den) = (0.0, 0.0);
    for k in 1..n / 2 {
        let (mut re, mut im) = (0.0, 0.0);
        let step = 2.0 * std::f64::consts::PI * k as f64 / n as f64;
        for (i, &v) in w.iter().enumerate() {
            let a = step * i as f64;
            re += v * a.cos();
            im -= v * a.sin();
        }
        let mag = (re * re + im * im).sqrt();
        num += mag * k as f64 * SR as f64 / n as f64;
        den += mag;
    }
    num / den
}

#[test]
fn rack_param_lane_sweeps_filter_cutoff() {
    let mut e = eng();
    noise_track(&mut e, 0);
    ok(lane_rack(&mut e, 0, 0, 1, FILTER_CUTOFF));
    ok(point(&mut e, 0, 0, 0.0, 100.0, false));
    ok(point(&mut e, 0, 1, 3840.0, 8000.0, false));
    song(&mut e, true);
    render(&mut e, 4800);
    cmd(&mut e, OP_PLAY, 0.0, 0.0, 0.0, 0.0);
    let out = render(&mut e, 96000);
    let c: Vec<f64> = [4000usize, 28000, 52000, 76000].iter().map(|&at| centroid(&out[at..at + 1024])).collect();
    assert!(c.windows(2).all(|w| w[1] > w[0] * 1.3), "the centroid rises across the bar: {c:?}");
    // The rack's stored param follows the lane; the base is the default.
    let cutoff = e.synths.rack_mut(0).unwrap().param(1, FILTER_CUTOFF).unwrap();
    // (set at the last sub-block start, a frame tick before the bar end)
    assert!((cutoff - 8000.0).abs() < 40.0, "cutoff {cutoff}");
    assert_eq!(e.automation.lane(0).unwrap().base(), 1200.0);
    song(&mut e, false);
    assert_eq!(e.synths.rack_mut(0).unwrap().param(1, FILTER_CUTOFF), Some(1200.0), "the base again");
}

#[test]
fn removing_the_target_clears_its_lanes() {
    let mut e = eng();
    noise_track(&mut e, 0);
    constant_track(&mut e, 1, 0.5);
    ok(lane_rack(&mut e, 0, 0, 1, FILTER_CUTOFF));
    ok(lane_mix(&mut e, 1, 1, P_FADER));
    ok(lane_mix(&mut e, 2, MIX_MASTER, P_FADER));
    ok(lane_rack(&mut e, 3, 0, 2, OUT_LEVEL));
    ok(lane_mix(&mut e, 4, 0, P_PAN));
    for (lane, v) in [(0, 300.0), (1, -6.0), (2, -1.0), (3, 0.5), (4, 0.3)] {
        ok(point(&mut e, lane, 0, 0.0, v, false));
        ok(point(&mut e, lane, 1, 7680.0, v, false));
    }
    song(&mut e, true);
    cmd(&mut e, OP_PLAY, 0.0, 0.0, 0.0, 0.0);
    render(&mut e, 4800);
    let cleared = |e: &Engine, i: usize| lane_target(e, i) == Target::None && lane_count(e, i) == 0;

    // REMOVE_TRACK clears the lanes of that slot only.
    cmd(&mut e, OP_REMOVE_TRACK, 1.0, 0.0, 0.0, 0.0);
    assert!(cleared(&e, 1));
    assert!((0..5).filter(|&i| i != 1).all(|i| !cleared(&e, i)));

    // RACK_REMOVE_MODULE on a sounding rack is queued behind the fade; the
    // lane goes at once, and a module added there later is not driven.
    assert!(e.synths.rack_mut(0).unwrap().is_sounding());
    cmd(&mut e, OP_RACK_REMOVE_MODULE, 0.0, 1.0, 0.0, 0.0);
    assert_eq!(e.synths.rack_mut(0).unwrap().kind(1), Some(crate::rack::catalog::ModuleKind::Filter), "queued");
    assert!(cleared(&e, 0));
    render(&mut e, 1280);
    cmd(&mut e, OP_RACK_ADD_MODULE, 0.0, 1.0, K_FILTER, 0.0);
    render(&mut e, 1280);
    assert_eq!(e.synths.rack_mut(0).unwrap().param(1, FILTER_CUTOFF), Some(1200.0), "not automated");

    // RACK_CLEAR (a patch load) clears the slot's rack lanes, not its mixer lanes.
    cmd(&mut e, OP_RACK_CLEAR, 0.0, 0.0, 0.0, 0.0);
    assert!(cleared(&e, 3));
    assert!(!cleared(&e, 4));

    // ADD_*_TRACK over the slot clears everything of it.
    cmd(&mut e, OP_ADD_AUDIO_TRACK, 0.0, 0.0, 0.0, 0.0);
    assert!(cleared(&e, 4));
    for add in [OP_ADD_DRUM_TRACK, OP_ADD_SYNTH_TRACK, OP_ADD_AUDIO_TRACK] {
        ok(lane_mix(&mut e, 4, 0, P_FADER));
        ok(point(&mut e, 4, 0, 0.0, -6.0, false));
        cmd(&mut e, add, 0.0, 0.0, 0.0, 0.0);
        assert!(cleared(&e, 4), "op {add}");
    }
    noise_track(&mut e, 5);
    ok(lane_rack(&mut e, 4, 5, 1, FILTER_CUTOFF));
    cmd(&mut e, OP_ADD_SYNTH_TRACK, 5.0, 0.0, 0.0, 0.0);
    assert!(cleared(&e, 4), "a synth track re-added over itself");
    assert!(!cleared(&e, 2), "the master lane stays");

    // RESET_ALL clears every lane.
    cmd(&mut e, OP_STOP, 0.0, 0.0, 0.0, 0.0);
    cmd(&mut e, OP_RESET_ALL, 0.0, 0.0, 0.0, 0.0);
    assert!((0..MAX_AUTO_LANES).all(|i| cleared(&e, i)));
    render(&mut e, 1280);
    assert_eq!(e.mixer().effective(MIX_MASTER, P_FADER), 0.0, "nothing drives the master");
}

#[test]
fn auto_commands_validate() {
    let mut e = eng();
    constant_track(&mut e, 0, 0.5);
    cmd(&mut e, OP_ADD_AUDIO_TRACK, 2.0, 0.0, 0.0, 0.0);
    let set = |e: &mut Engine, a: f64, b: f64, c: f64, d: f64| e.command(OP_AUTO_LANE_SET, a, b, c, d);
    // Lane and slot indices.
    assert_eq!(set(&mut e, MAX_AUTO_LANES as f64, 1.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(set(&mut e, -1.0, 1.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(set(&mut e, 0.0, 1.0, 35.0, 0.0), ERR_BAD_INDEX, "mix channel");
    assert_eq!(set(&mut e, 0.0, 2.0, 32.0, 0.0), ERR_BAD_INDEX, "rack slot");
    // Kinds and targets.
    assert_eq!(set(&mut e, 0.0, 3.0, 0.0, 0.0), ERR_BAD_VALUE, "kind");
    assert_eq!(set(&mut e, 0.0, 1.0, 0.0, 30.0), ERR_BAD_VALUE, "unknown param");
    assert_eq!(set(&mut e, 0.0, 1.0, 0.0, P_MUTE as f64), ERR_BAD_VALUE, "integer param");
    assert_eq!(set(&mut e, 0.0, 1.0, MIX_MASTER as f64, P_PAN as f64), ERR_BAD_VALUE, "not on the master");
    assert_eq!(set(&mut e, 0.0, 1.0, 5.0, P_FADER as f64), ERR_BAD_VALUE, "empty slot");
    assert_eq!(set(&mut e, 0.0, 2.0, 2.0, 0.0), ERR_BAD_VALUE, "rack target on an Audio slot");
    assert_eq!(set(&mut e, 0.0, 2.0, 5.0, 0.0), ERR_BAD_VALUE, "rack target on an empty slot");
    assert_eq!(set(&mut e, 0.0, 2.0, 0.0, (7 * 16) as f64), ERR_BAD_VALUE, "no module 7");
    assert_eq!(set(&mut e, 0.0, 2.0, 0.0, (16 + 1) as f64), ERR_BAD_VALUE, "Out has 1 param"); // module 1, param 1
    assert_eq!(set(&mut e, 0.0, 2.0, 0.0, 0.5), ERR_BAD_VALUE, "fractional");
    assert_eq!(set(&mut e, 0.0, 2.0, 0.0, (32 * 16) as f64), ERR_BAD_VALUE, "module 32");
    noise_track(&mut e, 3);
    assert_eq!(set(&mut e, 0.0, 2.0, 3.0, (16 + FILTER_MODE) as f64), ERR_BAD_VALUE, "integer rack param");
    // Audio slots accept mixer targets; returns and the master always exist.
    ok(set(&mut e, 0.0, 1.0, 2.0, P_FADER as f64));
    ok(set(&mut e, 1.0, 1.0, MIX_REVERB as f64, P_FADER as f64));
    ok(set(&mut e, 2.0, 2.0, 3.0, (16 + FILTER_CUTOFF) as f64));
    // A second lane on the same target; the same lane again is fine.
    assert_eq!(set(&mut e, 3.0, 1.0, 2.0, P_FADER as f64), ERR_BAD_VALUE, "duplicate target");
    ok(set(&mut e, 0.0, 1.0, 2.0, P_FADER as f64));

    // Points.
    let pt = |e: &mut Engine, a: f64, b: f64, c: f64, d: f64| e.command(OP_AUTO_POINT_SET, a, b, c, d);
    let max = (MAX_AUTO_LANES * MAX_AUTO_POINTS) as f64;
    assert_eq!(pt(&mut e, max, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(pt(&mut e, -1.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(pt(&mut e, 0.5, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(pt(&mut e, 0.0, MAX_SONG_TICKS as f64 + 1.0, 0.0, 0.0), ERR_BAD_VALUE, "tick");
    assert_eq!(pt(&mut e, 0.0, 0.5, 0.0, 0.0), ERR_BAD_VALUE, "fractional tick");
    assert_eq!(pt(&mut e, 0.0, 0.0, 6.5, 0.0), ERR_BAD_VALUE, "past the fader max");
    assert_eq!(pt(&mut e, 0.0, 0.0, f64::NAN, 0.0), ERR_BAD_VALUE);
    assert_eq!(pt(&mut e, 0.0, 0.0, 0.0, 2.0), ERR_BAD_VALUE, "shape");
    assert_eq!(pt(&mut e, (5 * MAX_AUTO_POINTS) as f64, 0.0, 0.0, 0.0), ERR_BAD_VALUE, "lane 5 has no target");
    ok(pt(&mut e, 0.0, 100.0, -6.0, 0.0));
    ok(pt(&mut e, 0.0, 100.0, -3.0, 1.0)); // the same point, new value and shape
    assert_eq!(pt(&mut e, 1.0, 100.0, 0.0, 0.0), ERR_BAD_VALUE, "duplicate tick");
    ok(pt(&mut e, 1.0, MAX_SONG_TICKS as f64, -60.0, 0.0));
    // The per-lane cap: idx 0..MAX_AUTO_POINTS (lane 1, the Reverb fader).
    for i in 0..MAX_AUTO_POINTS {
        ok(pt(&mut e, (MAX_AUTO_POINTS + i) as f64, (i * 10) as f64, -6.0, (i % 2) as f64));
    }
    assert_eq!(lane_count(&e, 1), MAX_AUTO_POINTS);
    ok(e.command(OP_AUTO_POINT_REMOVE, (MAX_AUTO_POINTS + 7) as f64, 0.0, 0.0, 0.0));
    ok(e.command(OP_AUTO_POINT_REMOVE, (MAX_AUTO_POINTS + 7) as f64, 0.0, 0.0, 0.0)); // already gone: no-op
    assert_eq!(lane_count(&e, 1), MAX_AUTO_POINTS - 1);
    assert_eq!(e.command(OP_AUTO_POINT_REMOVE, max, 0.0, 0.0, 0.0), ERR_BAD_INDEX);

    // Re-targeting keeps the points, re-validated against the new range.
    assert_eq!(set(&mut e, 0.0, 1.0, 0.0, P_PAN as f64), ERR_BAD_VALUE, "−3 dB is not a pan value");
    assert_eq!(lane_target(&e, 0), Target::Mix { ch: 2, id: P_FADER as u8 }, "unchanged");
    ok(set(&mut e, 0.0, 1.0, 0.0, P_FADER as f64));
    assert_eq!(lane_count(&e, 0), 2);
    ok(set(&mut e, 0.0, 0.0, 0.0, 0.0)); // no target: the points stay
    assert_eq!((lane_target(&e, 0), lane_count(&e, 0)), (Target::None, 2));

    // Clear, enable, override.
    assert_eq!(e.command(OP_AUTO_LANE_CLEAR, MAX_AUTO_LANES as f64, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
    ok(e.command(OP_AUTO_LANE_CLEAR, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(lane_count(&e, 0), 0);
    assert_eq!(e.command(OP_AUTO_LANE_ENABLE, 1.0, 2.0, 0.0, 0.0), ERR_BAD_VALUE);
    assert_eq!(e.command(OP_AUTO_LANE_ENABLE, 64.0, 1.0, 0.0, 0.0), ERR_BAD_INDEX);
    ok(e.command(OP_AUTO_LANE_ENABLE, 1.0, 0.0, 0.0, 0.0));
    assert_eq!(e.command(OP_AUTO_OVERRIDE, 64.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
    ok(e.command(OP_AUTO_OVERRIDE, 9.0, 0.0, 0.0, 0.0)); // an empty lane: nothing to suspend
}
