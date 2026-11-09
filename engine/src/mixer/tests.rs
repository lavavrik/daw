//! Mixer behaviour through the engine's command interface (what the UI
//! drives): strips, sends and returns, solo, sidechain keys, the master
//! limiter, slot reuse, validation and the click/latency alignment.

use super::catalog::*;
use super::Key;
use crate::protocol::*;
use crate::{Engine, MIX_MASTER, MIX_RETURN0};

const SR: f32 = 48000.0;
const BLOCK: usize = 128;

// Rack module kind wire ids (rack/catalog.rs).
const K_MIDI_IN: f64 = 0.0;
const K_OSC: f64 = 1.0;
const K_ADSR: f64 = 4.0;
const K_VCA: f64 = 5.0;
const K_OUT: f64 = 8.0;

fn ok(code: i32) {
    assert_eq!(code, OK);
}

fn mix(e: &mut Engine, ch: usize, id: u32, v: f64) {
    assert_eq!(e.command(OP_MIX_SET, ch as f64, id as f64, v, 0.0), OK, "ch {ch} param {id} = {v}");
}

fn pk(module: usize, port: usize) -> f64 {
    (module * 16 + port) as f64
}

/// Synth track `slot`: MIDI In gate -> Out (L, and R = L) at `level`: a DC
/// level while a note is held, exactly 0 otherwise.
fn gate_patch(e: &mut Engine, slot: usize, level: f64) {
    let s = slot as f64;
    ok(e.command(OP_ADD_SYNTH_TRACK, s, 0.0, 0.0, 0.0));
    ok(e.command(OP_RACK_ADD_MODULE, s, 0.0, K_MIDI_IN, 0.0));
    ok(e.command(OP_RACK_ADD_MODULE, s, 1.0, K_OUT, 0.0));
    ok(e.command(OP_RACK_CONNECT, s, pk(0, 1), pk(1, 0), 0.0));
    ok(e.command(OP_RACK_SET_PARAM, s, 1.0, 0.0, level));
}

/// Synth track `slot`: MIDI In -> sine Osc -> VCA <- ADSR (sustain 1) ->
/// Out at `level`: a steady sine of amplitude `level` while a note is held.
fn sine_patch(e: &mut Engine, slot: usize, level: f64) {
    let s = slot as f64;
    ok(e.command(OP_ADD_SYNTH_TRACK, s, 0.0, 0.0, 0.0));
    for (m, kind) in [(0.0, K_MIDI_IN), (1.0, K_OSC), (2.0, K_ADSR), (3.0, K_VCA), (4.0, K_OUT)] {
        ok(e.command(OP_RACK_ADD_MODULE, s, m, kind, 0.0));
    }
    for (from, to) in [((0, 0), (1, 0)), ((0, 1), (2, 0)), ((1, 0), (3, 0)), ((2, 0), (3, 1)), ((3, 0), (4, 0))] {
        ok(e.command(OP_RACK_CONNECT, s, pk(from.0, from.1), pk(to.0, to.1), 0.0));
    }
    ok(e.command(OP_RACK_SET_PARAM, s, 1.0, 0.0, 3.0)); // sine
    ok(e.command(OP_RACK_SET_PARAM, s, 2.0, 2.0, 1.0)); // sustain 1
    ok(e.command(OP_RACK_SET_PARAM, s, 4.0, 0.0, level));
}

/// Hold `note` live on synth track `slot` (it becomes the input track).
fn hold(e: &mut Engine, slot: usize, note: f64) {
    ok(e.command(OP_SET_INPUT_TRACK, slot as f64, 0.0, 0.0, 0.0));
    ok(e.command(OP_NOTE_ON, note, 100.0, 0.0, 0.0));
}

/// Load sample `id`: mono, `frames` long, `f(i)` per frame (ready).
fn load(e: &mut Engine, id: u32, frames: u32, f: impl Fn(usize) -> f32) {
    let p = e.sample_alloc(id, frames, 1).unwrap();
    let data = unsafe { std::slice::from_raw_parts_mut(p, frames as usize) };
    for (i, x) in data.iter_mut().enumerate() {
        *x = f(i);
    }
    ok(e.sample_ready(id));
}

/// A new drum track `slot` playing sample `sample` on row `row` at `steps`.
fn drums(e: &mut Engine, slot: usize, row: usize, sample: u32, steps: &[u32]) {
    let s = slot as f64;
    ok(e.command(OP_ADD_DRUM_TRACK, s, 0.0, 0.0, 0.0));
    ok(e.command(OP_SET_ROW_SAMPLE, s, row as f64, sample as f64, 0.0));
    for &st in steps {
        ok(e.command(OP_SET_STEP, s, row as f64, st as f64, 127.0));
    }
}

fn render(e: &mut Engine, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let (mut ol, mut or) = (Vec::new(), Vec::new());
    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    for _ in 0..frames.div_ceil(BLOCK) {
        e.process(&mut l, &mut r);
        ol.extend_from_slice(&l);
        or.extend_from_slice(&r);
    }
    (ol, or)
}

/// `(peakL, peakR, gr_db)` of channel `ch` for the last block.
fn meter(e: &Engine, ch: usize) -> (f32, f32, f32) {
    let m = e.meters();
    (m[ch * 3], m[ch * 3 + 1], m[ch * 3 + 2])
}

fn peak(s: &[f32]) -> f32 {
    s.iter().fold(0.0f32, |m, x| m.max(x.abs()))
}

fn max_step(s: &[f32]) -> f32 {
    s.windows(2).fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()))
}

fn db(x: f32) -> f32 {
    20.0 * x.max(1e-12).log10()
}

#[test]
fn default_mix_is_unity_after_the_limiter_latency() {
    // A drum hit through the default mix: the old level exactly (row
    // equal-power centre 0.707 x master 0.8), just delayed by the lookahead.
    let mut e = Engine::new(SR);
    assert_eq!(e.latency(), 72);
    load(&mut e, 0, 1000, |_| 1.0);
    drums(&mut e, 0, 0, 0, &[0]);
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let (l, r) = render(&mut e, 2048);
    assert!(l[..72].iter().all(|&x| x == 0.0));
    let want = 0.5f32.sqrt() * 0.8;
    assert!((l[72] - want).abs() < 1e-6 && (r[500] - want).abs() < 1e-6, "{} {}", l[72], r[500]);
    assert!(l[1072..].iter().all(|&x| x == 0.0));
}

#[test]
fn click_stays_on_the_beat_with_the_limiter_latency() {
    // The metronome is added after the limiter but delayed by its latency,
    // so a hit on beat 1 and the click start on the same sample.
    let mut e = Engine::new(SR);
    load(&mut e, 0, 48000, |_| 0.25);
    drums(&mut e, 0, 0, 0, &[0]);
    ok(e.command(OP_SET_METRONOME, 1.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let (l, _) = render(&mut e, 1024);
    let first = l.iter().position(|&x| x != 0.0).unwrap();
    assert_eq!(first, 72);
    // The click (a 1.5 kHz sine from phase 0) rides on the drum's DC level.
    let dc = 0.25 * 0.5f32.sqrt() * 0.8;
    assert!((l[72] - dc).abs() < 1e-6);
    assert!((l[80] - dc).abs() > 0.01, "click under way 8 samples in");
}

#[test]
fn fader_and_pan_apply() {
    let mut e = Engine::new(SR);
    gate_patch(&mut e, 0, 0.5);
    hold(&mut e, 0, 60.0);
    let (l, r) = render(&mut e, 4800);
    let base = 0.5 * 0.8; // Out level x legacy master gain
    // (The rack's Out level glide settles to within ~1e-5.)
    assert!((l[4799] - base).abs() < 1e-4 && (r[4799] - base).abs() < 1e-4);
    // -6 dB, hard left: L = base * 10^(-6/20) * sqrt(2), R = 0.
    mix(&mut e, 0, P_FADER, -6.0);
    mix(&mut e, 0, P_PAN, -1.0);
    let (l, r) = render(&mut e, 4800);
    let want = base * 10f32.powf(-6.0 / 20.0) * std::f32::consts::SQRT_2;
    assert!((l[4799] - want).abs() < 1e-5, "{} vs {want}", l[4799]);
    assert!(r[4799].abs() < 1e-7, "{}", r[4799]);
    // Linear 5 ms ramps (240 samples), not steps; done after 5 ms + latency.
    let ramp = (base - want).abs().max(base) / 240.0;
    assert!(max_step(&l) <= ramp * 1.01 && max_step(&r) <= ramp * 1.01, "{} {}", max_step(&l), max_step(&r));
    assert!((l[240 + 72 + 1] - want).abs() < 1e-5);
    // Meters: post-fader.
    let (ml, mr, gr) = meter(&e, 0);
    assert!((ml - want / 0.8).abs() < 1e-5 && mr < 1e-7 && gr == 0.0, "{ml} {mr} {gr}");
    // The fader minimum is silence (-inf).
    mix(&mut e, 0, P_FADER, -60.0);
    let (l, _) = render(&mut e, 4800);
    assert!(l[1000..].iter().all(|&x| x == 0.0));
}

#[test]
fn mute_ramps_no_click() {
    let mut e = Engine::new(SR);
    sine_patch(&mut e, 0, 0.5);
    hold(&mut e, 0, 48.0); // C3, 131 Hz: slope <= 0.5 * 0.8 * 2pi * 131 / 48000 = 0.007
    render(&mut e, 9600);
    mix(&mut e, 0, P_MUTE, 1.0);
    let (l, _) = render(&mut e, 4800);
    assert!(max_step(&l) < 0.012, "mute step {}", max_step(&l));
    let off = 72 + 96 + 1; // latency + 2 ms
    assert!(l[off..].iter().all(|&x| x == 0.0), "silent after the 2 ms ramp");
    assert!(peak(&l[..72]) > 0.3, "the ramp starts after the latency");
    assert_eq!(meter(&e, 0).0, 0.0);
    mix(&mut e, 0, P_MUTE, 0.0);
    let (l, _) = render(&mut e, 4800);
    assert!(max_step(&l) < 0.012, "unmute step {}", max_step(&l));
    assert!(peak(&l[off..]) > 0.3);
    // Control: without the ramp, a mute at the sine's peak would step ~0.4.
}

#[test]
fn solo_mutes_others_keeps_returns() {
    let mut e = Engine::new(SR);
    // Track 0: a sine sending to the Reverb; track 1: a long drum hit.
    sine_patch(&mut e, 0, 0.5);
    hold(&mut e, 0, 48.0);
    mix(&mut e, 0, P_SEND_A, 0.0);
    load(&mut e, 0, 96000, |_| 0.4);
    drums(&mut e, 1, 0, 0, &[0]);
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    render(&mut e, 24000);
    assert!(meter(&e, 0).0 > 0.3 && meter(&e, 1).0 > 0.2 && meter(&e, MIX_RETURN0).0 > 0.001);
    let rev_before = meter(&e, MIX_RETURN0).0;

    mix(&mut e, 1, P_SOLO, 1.0);
    let (l, _) = render(&mut e, 1280);
    assert!(max_step(&l) < 0.02, "solo fade step {}", max_step(&l));
    assert_eq!(meter(&e, 0).0, 0.0, "unsoloed track muted");
    assert!(meter(&e, 1).0 > 0.2, "soloed track plays");
    let rev = meter(&e, MIX_RETURN0).0;
    assert!(rev > 0.1 * rev_before, "the return keeps its tail: {rev} vs {rev_before}");
    // The muted track feeds the Reverb no more: its tail decays.
    render(&mut e, 48000);
    assert!(meter(&e, MIX_RETURN0).0 < 0.5 * rev, "tail decays without new input");

    mix(&mut e, 1, P_SOLO, 0.0);
    let (l, _) = render(&mut e, 1280);
    assert!(max_step(&l) < 0.02, "unsolo step {}", max_step(&l));
    assert!(meter(&e, 0).0 > 0.3, "un-solo restores the track");
    render(&mut e, 4800);
    assert!(meter(&e, MIX_RETURN0).0 > 0.001, "and its send");
}

#[test]
fn send_to_reverb_produces_tail_after_source_stops() {
    let run = |send: bool| {
        let mut e = Engine::new(SR);
        // A 50 ms 1 kHz burst on beat 1 (the next hit is a bar later).
        load(&mut e, 0, 2400, |i| 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / SR).sin());
        drums(&mut e, 0, 0, 0, &[0]);
        if send {
            mix(&mut e, 0, P_SEND_A, 0.0);
        }
        ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
        let (l, _) = render(&mut e, 48000);
        (l, meter(&e, 0).0, meter(&e, MIX_RETURN0).0)
    };
    let (dry, ..) = run(false);
    let end = 2400 + 72 + 1;
    assert!(dry[end..].iter().all(|&x| x == 0.0), "no send: silence after the hit");
    let (wet, track, rev) = run(true);
    assert_eq!(track, 0.0, "the source has stopped");
    assert!(rev > 1e-3, "the Reverb return still rings: {rev}");
    assert!(peak(&wet[4800..24000]) > 0.01, "tail 0.1..0.5 s: {}", peak(&wet[4800..24000]));
    assert!(peak(&wet[40000..]) > 1e-4, "still ringing at 0.8 s");
    assert!(wet.iter().all(|x| x.is_finite()));
}

/// Kick on drum track 0 row 0 (0.1 s at 0.9, every beat at 120 bpm) and a
/// steady sine pad (`level`) on synth track 1 with its compressor on.
fn pump(level: f64, key: f64) -> Engine {
    let mut e = Engine::new(SR);
    load(&mut e, 0, 4800, |_| 0.9);
    drums(&mut e, 0, 0, 0, &[0, 4, 8, 12]);
    sine_patch(&mut e, 1, level);
    hold(&mut e, 1, 48.0);
    mix(&mut e, 1, P_COMP_ON, 1.0);
    ok(e.command(OP_MIX_SET_KEY, 1.0, key, 0.0, 0.0));
    ok(e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    e
}

/// Per-block meters of `ch` over `blocks` blocks: (peak L, gr).
fn meter_run(e: &mut Engine, ch: usize, blocks: usize) -> Vec<(f32, f32)> {
    (0..blocks)
        .map(|_| {
            render(e, BLOCK);
            let (l, _, gr) = meter(e, ch);
            (l, gr)
        })
        .collect()
}

#[test]
fn sidechain_kick_ducks_pad() {
    for (what, key) in [("kick row", 1.0), ("whole drum track", 0.0)] {
        let mut e = pump(0.5, key);
        assert_eq!(e.mixer().key(1), if key == 1.0 { Key::Row(0, 0) } else { Key::Track(0) });
        // 2 s: kicks at 0, 0.5, 1.0, 1.5 s = blocks 0, 187.5, 375, 562.5.
        // Per block: (pad peak, pad gr, kick-strip peak).
        let m: Vec<(f32, f32, f32)> = (0..750)
            .map(|_| {
                render(&mut e, BLOCK);
                (meter(&e, 1).0, meter(&e, 1).2, meter(&e, 0).0)
            })
            .collect();
        for kick in 1..4usize {
            let at = kick * 24000 / BLOCK;
            let before = m[at - 4].0; // ~11 ms before the kick: recovered
            let during = m[at + 8].0; // ~20 ms into the kick: ducked
            let dip = db(before) - db(during);
            assert!(dip >= 6.0, "{what}: kick {kick} dips {dip} dB ({before} -> {during})");
            assert!(m[at + 8].1 >= 6.0, "{what}: gr meter {}", m[at + 8].1);
            // The kick strip itself is not ducked: inside the kick it reads
            // the row's full level (0.9 x equal-power centre).
            assert!((m[at + 8].2 - 0.9 * 0.5f32.sqrt()).abs() < 1e-5, "{what}: kick strip {}", m[at + 8].2);
        }
    }
}

#[test]
fn sidechain_source_removed_falls_back() {
    // A quiet pad (-26 dBFS, under the threshold) keyed by the kick row.
    let mut e = pump(0.05, 1.0);
    let m = meter_run(&mut e, 1, 24000 / BLOCK + 8); // into the second kick
    assert!(m.last().unwrap().1 > 6.0, "ducking hard: {}", m.last().unwrap().1);
    // Silence the kick strip (the key is pre-fader, so ducking continues),
    // so the master carries the pad alone.
    mix(&mut e, 0, P_MUTE, 1.0);
    let m = meter_run(&mut e, 1, 2);
    assert!(m[1].1 > 6.0);
    let (before, _) = render(&mut e, BLOCK);
    let last = *before.last().unwrap();
    ok(e.command(OP_REMOVE_TRACK, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(e.mixer().key(1), Key::None, "the key reverts to none");
    let (after, _) = render(&mut e, 16 * BLOCK);
    // The reduction ramps to unity over 2 ms (+ the latency): no snap.
    let mut s = vec![last];
    s.extend_from_slice(&after);
    let step = max_step(&s);
    // The pad's own slope is 0.05 * 0.8 * 2pi * 131 / 48000 = 7e-4; an
    // instant 6+ dB release at its peak would step ~0.02.
    assert!(step < 0.002, "release step {step}");
    assert!(meter(&e, 1).2 < 0.01, "self-keyed below threshold: no reduction ({})", meter(&e, 1).2);
    assert!(peak(&after[400..]) > 0.035, "the pad is back at full level: {}", peak(&after[400..]));
    // The source is gone: keying from it again is a bad index.
    assert_eq!(e.command(OP_MIX_SET_KEY, 1.0, 1.0, 0.0, 0.0), ERR_BAD_INDEX);
}

/// Plan 21: REMOVE_ROW / INSERT_ROW carry the drum-row keys with the rows.
#[test]
fn row_keys_follow_removed_and_inserted_rows() {
    let mut e = Engine::new(SR);
    ok(e.command(OP_ADD_DRUM_TRACK, 1.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_ADD_DRUM_TRACK, 5.0, 0.0, 0.0, 0.0));
    let key = |e: &mut Engine, ch: f64, slot: f64, row: f64| ok(e.command(OP_MIX_SET_KEY, ch, slot * 32.0 + row + 1.0, 0.0, 0.0));
    key(&mut e, 2.0, 1.0, 0.0);
    key(&mut e, 3.0, 1.0, 2.0);
    key(&mut e, 4.0, 1.0, 1.0);
    key(&mut e, 6.0, 5.0, 2.0); // another track's row 2: untouched
    ok(e.command(OP_REMOVE_ROW, 1.0, 1.0, 0.0, 0.0));
    assert_eq!(e.mixer().key(2), Key::Row(1, 0), "an earlier row stays");
    assert_eq!(e.mixer().key(3), Key::Row(1, 1), "a later row follows it up");
    assert_eq!(e.mixer().key(4), Key::None, "the removed row's key reverts to none");
    assert_eq!(e.mixer().key(6), Key::Row(5, 2));
    let slots = |e: &Engine| e.mixer().row_keys()[1].iter().filter(|&&k| k != super::NO_KEY).count();
    assert_eq!(slots(&e), 2, "key slots rebuilt for rows 0 and 1");
    assert_ne!(e.mixer().row_keys()[1][1], super::NO_KEY);

    ok(e.command(OP_INSERT_ROW, 1.0, 1.0, 0.0, 0.0));
    assert_eq!(e.mixer().key(2), Key::Row(1, 0));
    assert_eq!(e.mixer().key(3), Key::Row(1, 2), "back down");
    assert_eq!(e.mixer().row_keys()[1][1], super::NO_KEY);
    assert_ne!(e.mixer().row_keys()[1][2], super::NO_KEY);
    // A key on the last row is dropped by an insert (the app never inserts then).
    key(&mut e, 4.0, 1.0, 15.0);
    ok(e.command(OP_INSERT_ROW, 1.0, 0.0, 0.0, 0.0));
    assert_eq!(e.mixer().key(4), Key::None);
    assert_eq!(e.mixer().key(2), Key::Row(1, 1));
    assert!(render(&mut e, 1280).0.iter().all(|x| x.is_finite()));
}

#[test]
fn retyping_a_key_source_also_falls_back() {
    let mut e = pump(0.05, 1.0);
    render(&mut e, 4800);
    ok(e.command(OP_ADD_SYNTH_TRACK, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(e.mixer().key(1), Key::None);
    let mut e = pump(0.05, 0.0);
    ok(e.command(OP_ADD_DRUM_TRACK, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(e.mixer().key(1), Key::None, "re-adding the source track resets it too");
}

#[test]
fn hot_mix_stays_under_ceiling() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, 9600, |i| if i % 200 < 100 { 1.0 } else { -1.0 });
    for slot in 0..32usize {
        drums(&mut e, slot, 0, 0, &[0, 2, 4, 6, 8, 10, 12, 14]);
        ok(e.command(OP_SET_ROW_PAN, slot as f64, 0.0, (slot as f64 - 16.0) / 16.0, 0.0));
        mix(&mut e, slot, P_FADER, 6.0);
        mix(&mut e, slot, P_SEND_A, 6.0);
        mix(&mut e, slot, P_SEND_B, 6.0);
    }
    mix(&mut e, MIX_RETURN0, P_REV_DECAY, 20.0);
    mix(&mut e, MIX_RETURN0, P_FADER, 6.0);
    mix(&mut e, MIX_RETURN0 + 1, P_DELAY_FEEDBACK, 0.95);
    mix(&mut e, MIX_RETURN0 + 1, P_FADER, 6.0);
    mix(&mut e, MIX_MASTER, P_FADER, 6.0);
    ok(e.command(OP_SET_MASTER_GAIN, 2.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let ceiling = 10f32.powf(-0.3 / 20.0);
    let (l, r) = render(&mut e, 3 * 48000);
    let p = peak(&l).max(peak(&r));
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    assert!(p <= ceiling, "peak {p} > ceiling {ceiling}");
    assert!(p > 0.95 * ceiling, "limited, not muted: {p}");
    assert!(e.telemetry()[5] <= ceiling as f64);
    assert!(meter(&e, MIX_MASTER).2 > 6.0, "limiter gain reduction shows: {}", meter(&e, MIX_MASTER).2);
    // A lower ceiling holds too.
    mix(&mut e, MIX_MASTER, P_LIMITER_CEILING, -6.0);
    render(&mut e, 4800);
    let (l, _) = render(&mut e, 48000);
    assert!(peak(&l) <= 10f32.powf(-6.0 / 20.0) + 1e-6, "{}", peak(&l));
}

#[test]
fn slot_reuse_resets_channel() {
    // Engine A: track 3 with every strip setting moved, keyed by track 0.
    let mut a = Engine::new(SR);
    load(&mut a, 0, 4800, |_| 0.9);
    drums(&mut a, 0, 0, 0, &[0, 4, 8, 12]);
    sine_patch(&mut a, 3, 0.5);
    hold(&mut a, 3, 48.0);
    for (id, v) in [
        (P_FADER, -20.0),
        (P_PAN, 0.5),
        (P_EQ_ON, 1.0),
        (P_EQ_MID_GAIN, 15.0),
        (P_EQ_MID_FREQ, 200.0),
        (P_EQ_HP, 300.0),
        (P_COMP_ON, 1.0),
        (P_COMP_RATIO, 20.0),
        (P_COMP_THRESHOLD, -40.0),
        (P_SEND_B, 0.0),
        (P_SEND_B_PRE, 1.0),
        (P_SOLO, 1.0),
    ] {
        mix(&mut a, 3, id, v);
    }
    ok(a.command(OP_MIX_SET_KEY, 3.0, 0.0, 0.0, 0.0));
    ok(a.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    render(&mut a, 24000);
    ok(a.command(OP_REMOVE_TRACK, 3.0, 0.0, 0.0, 0.0));
    render(&mut a, 2400); // the old track fades out; its strip has reset
    for p in PARAMS.iter().filter(|p| p.accepts(3)) {
        assert_eq!(a.mixer().param(3, p.id), p.default, "{} reset", p.name);
    }
    assert_eq!(a.mixer().key(3), Key::None);
    ok(a.command(OP_REMOVE_TRACK, 0.0, 0.0, 0.0, 0.0)); // no drums: compare the pad alone
    // The Delay still echoes the old send (a tail is never cut): end it
    // quickly, then restore the return's defaults (its lines are silent).
    mix(&mut a, MIX_RETURN0 + 1, P_DELAY_FEEDBACK, 0.0);
    render(&mut a, 48000);
    ok(a.command(OP_MIX_RESET, (MIX_RETURN0 + 1) as f64, 0.0, 0.0, 0.0));
    render(&mut a, 4800);

    // Reuse: a fresh pad on slot 3 in A, and the same in a fresh engine B.
    let mut b = Engine::new(SR);
    for e in [&mut a, &mut b] {
        sine_patch(e, 3, 0.5);
        hold(e, 3, 48.0);
    }
    let compare = |a: &mut Engine, b: &mut Engine, what: &str| {
        for blk in 0..100 {
            let (la, ra) = render(a, BLOCK);
            let (lb, rb) = render(b, BLOCK);
            for i in 0..BLOCK {
                let d = (la[i] - lb[i]).abs().max((ra[i] - rb[i]).abs());
                assert!(d < 1e-5, "{what}: block {blk} sample {i}: {} vs {}", la[i], lb[i]);
            }
            let (ma, mb) = (meter(a, 3), meter(b, 3));
            assert!((ma.0 - mb.0).abs() < 1e-5 && (ma.2 - mb.2).abs() < 1e-4, "{what}: meters {ma:?} vs {mb:?}");
        }
    };
    compare(&mut a, &mut b, "defaults");
    // Switching EQ and compressor on again starts from clean state and the
    // default params in both.
    for e in [&mut a, &mut b] {
        mix(e, 3, P_EQ_ON, 1.0);
        mix(e, 3, P_COMP_ON, 1.0);
    }
    compare(&mut a, &mut b, "EQ + comp on");
}

#[test]
fn mix_commands_validate() {
    let mut e = Engine::new(SR);
    gate_patch(&mut e, 0, 0.5);
    load(&mut e, 0, 100, |_| 0.5);
    drums(&mut e, 1, 0, 0, &[0]);
    let set = |e: &mut Engine, a: f64, b: f64, c: f64| e.command(OP_MIX_SET, a, b, c, 0.0);
    assert_eq!(set(&mut e, 41.0, 0.0, 0.0), ERR_BAD_INDEX, "channel");
    assert_eq!(set(&mut e, 0.0, 42.0, 0.0), ERR_BAD_INDEX, "param id");
    assert_eq!(set(&mut e, MIX_MASTER as f64, P_SOLO as f64, 1.0), ERR_BAD_INDEX, "master has no solo");
    assert_eq!(set(&mut e, 0.0, P_REV_SIZE as f64, 0.5), ERR_BAD_INDEX, "reverb param on a track");
    assert_eq!(set(&mut e, 0.0, P_FADER as f64, 7.0), ERR_BAD_VALUE);
    assert_eq!(set(&mut e, 0.0, P_MUTE as f64, 0.5), ERR_BAD_VALUE);
    assert_eq!(set(&mut e, 0.0, P_PAN as f64, f64::NAN), ERR_BAD_VALUE);
    assert_eq!(e.telemetry()[7], ERR_BAD_VALUE as f64);
    // Rejected values change nothing.
    assert_eq!(e.mixer().param(0, P_FADER), 0.0);
    // A valid set reads back; MIX_RESET restores the default.
    assert_eq!(set(&mut e, 0.0, P_FADER as f64, -12.5), OK);
    assert_eq!(e.mixer().param(0, P_FADER), -12.5);
    assert_eq!(set(&mut e, MIX_RETURN0 as f64, P_REV_DECAY as f64, 8.0), OK);
    assert_eq!(e.command(OP_MIX_RESET, 0.0, 0.0, 0.0, 0.0), OK);
    assert_eq!(e.command(OP_MIX_RESET, MIX_RETURN0 as f64, 0.0, 0.0, 0.0), OK);
    assert_eq!(e.mixer().param(0, P_FADER), 0.0);
    assert_eq!(e.mixer().param(MIX_RETURN0, P_REV_DECAY), 2.2);
    assert_eq!(e.command(OP_MIX_RESET, 41.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);

    // Keys: the source must exist (a track) or be a drum track (a row).
    let key = |e: &mut Engine, ch: f64, code: f64| e.command(OP_MIX_SET_KEY, ch, code, 0.0, 0.0);
    assert_eq!(key(&mut e, 0.0, 5.0 * 32.0), ERR_BAD_INDEX, "empty source slot");
    assert_eq!(key(&mut e, 1.0, 0.0 * 32.0 + 1.0), ERR_BAD_INDEX, "row of a synth track");
    assert_eq!(key(&mut e, 0.0, 1.0 * 32.0 + 17.0), ERR_BAD_VALUE, "row 16");
    assert_eq!(key(&mut e, 32.0, -1.0), ERR_BAD_INDEX, "returns have no compressor");
    assert_eq!(key(&mut e, 0.0, 0.0), OK, "keyed by itself...");
    assert_eq!(e.mixer().key(0), Key::None, "...is none");
    assert_eq!(key(&mut e, 0.0, 32.0 + 1.0), OK);
    assert_eq!(e.mixer().key(0), Key::Row(1, 0));
    assert_eq!(key(&mut e, 2.0, 32.0 + 1.0), OK, "a strip on an empty slot may hold a key");
    assert_eq!(key(&mut e, 0.0, -1.0), OK);
    assert_eq!(e.mixer().key(0), Key::None);
    // MAX_KEYS (8) distinct rows; the same row again shares its key slot.
    for ch in 0..8usize {
        assert_eq!(key(&mut e, (ch + 2) as f64, 32.0 + ch as f64 + 1.0), OK, "row {ch}");
    }
    assert_eq!(key(&mut e, 20.0, 32.0 + 9.0), ERR_BAD_VALUE, "a 9th distinct row");
    assert_eq!(key(&mut e, 20.0, 32.0 + 3.0), OK, "a row already keyed shares its slot");
    assert_eq!(key(&mut e, 2.0, 32.0 + 9.0), OK, "replacing a strip's own row frees its slot");
    let rows = e.mixer().row_keys();
    let used: Vec<u8> = rows[1].iter().copied().filter(|&k| k != super::NO_KEY).collect();
    assert_eq!(used.len(), 8);
    // Every op still renders fine.
    assert!(render(&mut e, 1280).0.iter().all(|x| x.is_finite()));
}

#[test]
fn stop_and_loop_wrap_keep_effect_tails() {
    // Song mode, a 1-bar loop with a short hit on beat 1 sent to the Delay:
    // the wrap and Stop release notes only, the echoes keep going.
    let mut e = Engine::new(SR);
    load(&mut e, 0, 480, |_| 0.5);
    drums(&mut e, 0, 0, 0, &[0]);
    mix(&mut e, 0, P_SEND_B, 0.0);
    ok(e.command(OP_CLIP_SET, 0.0, 0.0, 0.0, 3840.0));
    ok(e.command(OP_SET_LOOP, 0.0, 3840.0, 0.0, 0.0));
    ok(e.command(OP_SET_MODE, 1.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    // 3/16 at 120 bpm = 0.375 s: echoes at 18000, 36000, ...; the bar is 96000.
    let (l, r) = render(&mut e, 96000 + 9000);
    let echo = |s: &[f32], at: usize| peak(&s[at + 72..at + 72 + 480]);
    assert!(echo(&l, 18000).max(echo(&r, 18000)) > 0.01);
    // Just after the wrap (96000) the echo of the previous bar continues.
    let late = 4 * 18000; // 72000: 4th echo
    assert!(echo(&l, late).max(echo(&r, late)) > 1e-4, "echoes ring up to the wrap");
    ok(e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0));
    let (l, r) = render(&mut e, 48000);
    assert!(peak(&l).max(peak(&r)) > 1e-4, "Stop keeps the delay tail");
    assert!(meter(&e, MIX_RETURN0 + 1).0 > 0.0 || peak(&l[40000..]).max(peak(&r[40000..])) > 0.0);
}

#[test]
fn removed_track_fades_out_through_its_old_strip() {
    // A DC level at -12 dB on its fader: removing the track resets the
    // strip (params read back as defaults at once) but the 2 ms fade-out
    // still passes through the old -12 dB, so there is no jump up to the
    // unity default on the way out.
    let mut e = Engine::new(SR);
    gate_patch(&mut e, 0, 0.5);
    hold(&mut e, 0, 60.0);
    mix(&mut e, 0, P_FADER, -12.0);
    let (l, _) = render(&mut e, 4800);
    let level = *l.last().unwrap();
    assert!((level - 0.4 * 10f32.powf(-12.0 / 20.0)).abs() < 1e-4, "{level}");
    ok(e.command(OP_REMOVE_TRACK, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(e.mixer().param(0, P_FADER), 0.0, "reset");
    let (l, _) = render(&mut e, 1280);
    assert!(l[..72].iter().all(|&x| (x - level).abs() < 1e-6), "the latency still plays the old level");
    assert!(l.iter().all(|&x| x <= level + 1e-6), "never above the old level");
    assert!(l[72 + 96 + 32..].iter().all(|&x| x == 0.0), "faded out (2 ms + a rack sub-block)");
    assert!(max_step(&l) < level / 40.0, "a ramp, not a cut: {}", max_step(&l));
}

#[test]
fn soft_clip_is_transparent_below_the_knee_and_never_exceeds_the_ceiling() {
    use super::{soft_clip, SOFT_KNEE};
    let c = 10f32.powf(-0.3 / 20.0);
    let k = SOFT_KNEE * c;
    for i in 0..=1000 {
        let x = k * i as f32 / 1000.0;
        assert_eq!(soft_clip(x, c).to_bits(), x.to_bits(), "bit-exact at {x}");
        assert_eq!(soft_clip(-x, c).to_bits(), (-x).to_bits());
    }
    let (mut px, mut prev) = (k, soft_clip(k, c));
    for i in 1..=100_000 {
        let x = k + i as f32 * 1e-4; // up to ~10.9
        let y = soft_clip(x, c);
        assert!(y <= c && y >= prev, "monotonic, under the ceiling at {x}: {y}");
        assert!(y - prev <= (x - px) * 1.0001 + 1e-7, "slope <= 1 (no corner) at {x}");
        assert_eq!(soft_clip(-x, c), -y);
        (px, prev) = (x, y);
    }
    assert!(soft_clip(f32::MAX, c) <= c);
    // Non-finite passes through (the engine backstop zeroes it) instead of
    // becoming a full-scale sample.
    assert!(soft_clip(f32::NAN, c).is_nan());
    assert_eq!(soft_clip(f32::INFINITY, c), f32::INFINITY);
    assert_eq!(soft_clip(f32::NEG_INFINITY, c), f32::NEG_INFINITY);
}

#[test]
fn click_on_a_limited_mix_stays_under_the_ceiling() {
    // A DC mix far over the ceiling (limited to it) plus the metronome on
    // top (added after the limiter): the soft clip keeps every sample under
    // the ceiling, smoothly (the click's own slope is ~0.05 per sample).
    let mut e = Engine::new(SR);
    gate_patch(&mut e, 0, 1.0);
    hold(&mut e, 0, 60.0);
    mix(&mut e, 0, P_FADER, 6.0);
    ok(e.command(OP_SET_METRONOME, 1.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let ceiling = 10f32.powf(-0.3 / 20.0);
    let (l, r) = render(&mut e, 2 * 48000);
    for s in [&l, &r] {
        assert!(peak(&s[4800..]) <= ceiling, "peak {} > ceiling {ceiling}", peak(&s[4800..]));
        assert!(max_step(&s[4800..]) < 0.06, "step {}", max_step(&s[4800..]));
    }
    // The click is audible on top of the limited mix (not flattened away).
    let lo = l[4800..].iter().fold(f32::MAX, |m, &x| m.min(x));
    assert!(peak(&l[4800..]) - lo > 0.1, "click swing {}", peak(&l[4800..]) - lo);
}

#[test]
fn click_clip_is_bit_exact_without_a_click() {
    // The safety stage only shapes while a click plays (and for its 5 ms
    // release); otherwise every limiter sample passes bit for bit, even in
    // the old soft-clip knee (0.9..1 × ceiling) and at the ceiling itself.
    use super::ClickClip;
    let c = 10f32.powf(-0.3 / 20.0);
    let mut cc = ClickClip::new(SR, 72);
    let xs = [0.0, 0.5, 0.9 * c, 0.95 * c, 0.999 * c, c, -0.97 * c, -c];
    for _ in 0..3 {
        for &x in &xs {
            let (l, r) = cc.next(x, -x, 0.0, 0.0, false, c);
            assert_eq!((l.to_bits(), r.to_bits()), (x.to_bits(), (-x).to_bits()), "at {x}");
        }
    }
    // A click shapes its sum under the ceiling ...
    let (l, _) = cc.next(c, c, 0.2, 0.2, true, c);
    assert!(l <= c && l < c + 0.2);
    // ... and 5 ms (240 samples at 48 kHz) after it ends, bit-exact again.
    for _ in 0..240 {
        cc.next(c, c, 0.0, 0.0, false, c);
    }
    let (l, _) = cc.next(0.95 * c, 0.95 * c, 0.0, 0.0, false, c);
    assert_eq!(l.to_bits(), (0.95 * c).to_bits());
}

#[test]
fn limited_mix_without_the_metronome_reaches_the_ceiling() {
    // A DC mix limited by ~6 dB, metronome off: the output is the limiter's,
    // flat at the ceiling (no soft-clip knee pulling it down).
    let mut e = Engine::new(SR);
    gate_patch(&mut e, 0, 1.0);
    hold(&mut e, 0, 60.0);
    mix(&mut e, 0, P_FADER, 6.0);
    mix(&mut e, MIX_MASTER, P_FADER, 2.0);
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let ceiling = 10f32.powf(-0.3 / 20.0);
    let (l, r) = render(&mut e, 48000);
    assert!(meter(&e, MIX_MASTER).2 > 6.0, "limited by 6 dB: {}", meter(&e, MIX_MASTER).2);
    for s in [&l, &r] {
        assert!(peak(s) <= ceiling + 1e-6, "peak {} > ceiling", peak(s));
        assert!(s[9600..].iter().all(|&x| (x - ceiling).abs() < 1e-4), "at the ceiling: {}", s[9600]);
    }
}

#[test]
fn metronome_leaves_the_mix_bit_exact_between_clicks() {
    // Same limited mix with and without the metronome: outside each click
    // (lookahead + 20 ms click + 5 ms release) the outputs are identical.
    let run = |click: bool| {
        let mut e = Engine::new(SR);
        gate_patch(&mut e, 0, 1.0);
        hold(&mut e, 0, 60.0);
        mix(&mut e, 0, P_FADER, 6.0);
        ok(e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0));
        ok(e.command(OP_SET_METRONOME, if click { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0));
        ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
        render(&mut e, 2 * 48000).0
    };
    let (on, off) = (run(true), run(false));
    let mut differs = 0;
    for (i, (a, b)) in on.iter().zip(&off).enumerate() {
        if i % 24000 >= 1500 {
            assert_eq!(a.to_bits(), b.to_bits(), "sample {i}");
        } else if a != b {
            differs += 1;
        }
    }
    assert!(differs > 500, "the clicks are there: {differs}");
}

#[test]
fn post_fader_send_applies_the_gate_once() {
    // DC through a post-fader send into the Delay (feedback 0): muting ramps
    // the dry track linearly over 2 ms, and the echo of that ramp must be
    // the same linear ramp (a gate applied twice would make it quadratic).
    let mut e = Engine::new(SR);
    gate_patch(&mut e, 0, 0.5);
    hold(&mut e, 0, 60.0);
    mix(&mut e, 0, P_SEND_B, 0.0);
    mix(&mut e, MIX_RETURN0 + 1, P_DELAY_FEEDBACK, 0.0);
    mix(&mut e, MIX_RETURN0 + 1, P_DELAY_PING_PONG, 0.0);
    ok(e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0));
    render(&mut e, 48000); // echoes settle to a steady DC
    let (l, _) = render(&mut e, BLOCK);
    let full = *l.last().unwrap(); // dry + echo
    mix(&mut e, 0, P_MUTE, 1.0);
    // 3/16 at 120 bpm = 18000 samples: the echo of the ramp starts 18000
    // after the dry ramp (both behind the same latency).
    let (l, _) = render(&mut e, 18000 + 1280);
    let echo = full - l[72 + 200]; // dry gone: only the echo plays
    assert!(echo > 0.1, "echo level {echo}");
    let start = 72 + 18000;
    let mid = l[start + 48]; // halfway through the 96-sample ramp
    assert!((mid / echo - 0.5).abs() < 0.03, "linear ramp: mid {} of {echo}", mid / echo);
}

#[test]
fn removing_a_muted_track_never_leaks_its_fade() {
    // The strip holds its old (muted) gate until the removal fade is over,
    // including the rack's last sub-block, so nothing of it is heard.
    for (drum, sr) in [(false, SR), (true, SR), (false, 44100.0), (true, 44100.0)] {
        let mut e = Engine::new(sr);
        if drum {
            load(&mut e, 0, 48000, |_| 0.9);
            drums(&mut e, 0, 0, 0, &[0]);
            ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
        } else {
            sine_patch(&mut e, 0, 0.8);
            hold(&mut e, 0, 48.0);
        }
        render(&mut e, 4800);
        mix(&mut e, 0, P_MUTE, 1.0);
        let (l, _) = render(&mut e, 1280);
        assert!(l[400..].iter().all(|&x| x == 0.0), "muted");
        // Off the rack's 32-frame sub-block grid: the rack first plays out
        // the rest of an already rendered sub-block, so its fade can end up
        // to a sub-block after 2 ms.
        e.process(&mut [0.0; 16], &mut [0.0; 16]);
        ok(e.command(OP_REMOVE_TRACK, 0.0, 0.0, 0.0, 0.0));
        // Small (16-frame) blocks: the hold is counted in processed frames,
        // so it must cover the whole fade, not just "the next block".
        let (mut l, mut r) = ([0.0f32; 16], [0.0f32; 16]);
        for b in 0..300 {
            e.process(&mut l, &mut r);
            assert!(l.iter().chain(r.iter()).all(|&x| x == 0.0), "drum {drum} @ {sr}: the muted fade leaked in block {b}: {l:?}");
        }
    }
}

/// FNV-1a over the bit patterns of `xs` (a bit-exact fingerprint).
fn fingerprint(xs: &[f32]) -> u64 {
    xs.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, x| {
        x.to_bits().to_le_bytes().iter().fold(h, |h, &b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
    })
}

#[test]
fn mixer_delay_reverb_unchanged() {
    // Plan 6 moved the Delay/Reverb rings behind a borrowed-buffer split so
    // rack FX modules can use pooled memory (rack/fx_pool.rs). The mixer's
    // own returns must sound bit-identical: a sine held into both returns
    // (pre-fader sends, track fader off, so only the returns are heard),
    // with return params moved mid-tail. The fingerprints were recorded on
    // the pre-refactor code.
    let mut e = Engine::new(SR);
    sine_patch(&mut e, 0, 0.8);
    mix(&mut e, 0, P_FADER, -60.0);
    mix(&mut e, 0, P_SEND_A, 0.0);
    mix(&mut e, 0, P_SEND_B, 0.0);
    mix(&mut e, 0, P_SEND_A_PRE, 1.0);
    mix(&mut e, 0, P_SEND_B_PRE, 1.0);
    mix(&mut e, MIX_RETURN0 + 1, P_DELAY_FEEDBACK, 0.7);
    hold(&mut e, 0, 57.0);
    let (mut l, mut r) = render(&mut e, 24000);
    ok(e.command(OP_NOTE_OFF, 57.0, 0.0, 0.0, 0.0));
    mix(&mut e, MIX_RETURN0, P_REV_SIZE, 1.0);
    mix(&mut e, MIX_RETURN0, P_REV_DECAY, 6.0);
    mix(&mut e, MIX_RETURN0 + 1, P_DELAY_TIME, 8.0);
    let (l2, r2) = render(&mut e, 72000);
    l.extend_from_slice(&l2);
    r.extend_from_slice(&r2);
    assert!(l.iter().chain(&r).all(|x| x.is_finite()));
    assert!(l[48000..].iter().any(|x| x.abs() > 0.01), "the returns are heard");
    // Re-recorded in plan 7 (export fix): a new track's strip now takes its
    // settings from the first sample (`Mixer::slot_added`), so the sends no
    // longer glide up from off over the first block. With the old
    // ADD-as-removal path forced, this still gives the plan-6 values
    // (260100827811768916, 5996882931469960278): the returns are unchanged.
    assert_eq!((fingerprint(&l), fingerprint(&r)), (17261538962147757256, 7669865106360089702));
}

/// Render `frames` in `engine.process` calls of `call` frames.
fn render_calls(e: &mut Engine, frames: usize, call: usize) -> (Vec<f32>, Vec<f32>) {
    let (mut ol, mut or) = (Vec::new(), Vec::new());
    let (mut l, mut r) = ([0.0f32; crate::MAX_BLOCK], [0.0f32; crate::MAX_BLOCK]);
    let mut done = 0;
    while done < frames {
        let n = call.min(frames - done);
        e.process(&mut l[..n], &mut r[..n]);
        ol.extend_from_slice(&l[..n]);
        or.extend_from_slice(&r[..n]);
        done += n;
    }
    (ol, or)
}

#[test]
fn add_track_then_mix_set_applies_immediately() {
    // A project load / the export: ADD_*_TRACK on an empty slot, then its
    // mixer settings, then PLAY with a hit on frame 0. Nothing sounded
    // through the strip, so there is no removal hold and no glide from the
    // defaults: the settings hold from the very first sample.
    for call in [16, 128, 1024] {
        // Muted: silent from sample 0.
        let mut e = Engine::new(SR);
        load(&mut e, 0, 4800, |_| 0.9);
        drums(&mut e, 0, 0, 0, &[0]);
        mix(&mut e, 0, P_MUTE, 1.0);
        ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
        let (l, r) = render_calls(&mut e, 4800, call);
        assert!(l.iter().chain(&r).all(|&x| x == 0.0), "call {call}: a muted track sounded: peak {}", peak(&l));

        // Fader at its minimum (off): silent from sample 0 too.
        let mut e = Engine::new(SR);
        load(&mut e, 0, 4800, |_| 0.9);
        drums(&mut e, 0, 0, 0, &[0]);
        mix(&mut e, 0, P_FADER, -60.0);
        ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
        let (l, r) = render_calls(&mut e, 4800, call);
        assert!(l.iter().chain(&r).all(|&x| x == 0.0), "call {call}: fader off sounded: peak {}", peak(&l));

        // Fader -40 dB, panned hard left: -40 dB (x sqrt 2 for the pan law)
        // of the unity mix, from the first sample (after the limiter
        // latency), nothing right.
        let mut e = Engine::new(SR);
        load(&mut e, 0, 4800, |_| 0.9);
        drums(&mut e, 0, 0, 0, &[0]);
        ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
        let (unity, _) = render_calls(&mut e, 4800, call);
        let mut e = Engine::new(SR);
        load(&mut e, 0, 4800, |_| 0.9);
        drums(&mut e, 0, 0, 0, &[0]);
        mix(&mut e, 0, P_FADER, -40.0);
        mix(&mut e, 0, P_PAN, -1.0);
        ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
        let (l, r) = render_calls(&mut e, 4800, call);
        let lat = e.latency();
        assert!(peak(&r) == 0.0, "call {call}: hard left leaked right: {}", peak(&r));
        let want = peak(&unity) * std::f32::consts::SQRT_2 * 0.01;
        assert!((peak(&l) - want).abs() < want * 1e-3, "call {call}: -40 dB from the start: {} vs {want}", peak(&l));
        assert!((l[lat].abs() - want).abs() < want * 1e-3, "call {call}: at -40 dB on frame 0 (after the latency): {}", l[lat]);
    }
}

#[test]
fn replacing_a_sounding_slot_still_holds_its_strip() {
    // Live behaviour unchanged: ADD over a track that is sounding (or a
    // removed one still fading) keeps the old strip settings until its fade
    // is over, so a muted track's fade never leaks.
    let mut e = Engine::new(SR);
    sine_patch(&mut e, 0, 0.8);
    hold(&mut e, 0, 48.0);
    render(&mut e, 4800);
    mix(&mut e, 0, P_MUTE, 1.0);
    let (l, _) = render(&mut e, 1280);
    assert!(l[400..].iter().all(|&x| x == 0.0), "muted");
    ok(e.command(OP_ADD_SYNTH_TRACK, 0.0, 0.0, 0.0, 0.0)); // replaces the sounding synth
    let (l, r) = render(&mut e, 4800);
    assert!(l.iter().chain(&r).all(|&x| x == 0.0), "the muted fade leaked: {}", peak(&l));
}

#[test]
fn render_is_call_size_independent() {
    // A drum track and a synth (EQ, comp, sends, mute toggled by a later
    // command at a frame both call sizes share), rendered in 128- and
    // 1024-frame calls: bit-identical.
    let build = || {
        let mut e = Engine::new(SR);
        load(&mut e, 0, 4800, |i| ((i as f32) * 0.05).sin() * 0.9 * (1.0 - i as f32 / 4800.0));
        drums(&mut e, 0, 0, 0, &[0, 4, 8, 12]);
        mix(&mut e, 0, P_FADER, -6.0);
        mix(&mut e, 0, P_SEND_A, -10.0);
        mix(&mut e, 0, P_EQ_ON, 1.0);
        mix(&mut e, 0, P_EQ_LOW, 6.0);
        sine_patch(&mut e, 1, 0.5);
        mix(&mut e, 1, P_COMP_ON, 1.0);
        mix(&mut e, 1, P_COMP_THRESHOLD, -30.0);
        mix(&mut e, 1, P_PAN, 0.4);
        mix(&mut e, 1, P_SEND_B, -6.0);
        ok(e.command(OP_MIX_SET_KEY, 1.0, 1.0, 0.0, 0.0)); // ducked by drum row 0
        hold(&mut e, 1, 45.0);
        ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
        e
    };
    let mut a = build();
    let mut b = build();
    let (la, ra) = render_calls(&mut a, 48 * 1024, 128);
    let (lb, rb) = render_calls(&mut b, 48 * 1024, 1024);
    let first = la.iter().zip(&lb).chain(ra.iter().zip(&rb)).position(|(x, y)| x.to_bits() != y.to_bits());
    assert_eq!(first, None, "128- vs 1024-frame calls differ");
    assert!(peak(&la) > 0.05);
}
