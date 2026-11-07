//! CPU budget for synth tracks (native, release mode). Ignored by default:
//!
//! ```text
//! cargo test --release -p daw-engine --test perf -- --ignored --nocapture
//! ```
//!
//! Four synth tracks, each a 13-module, 8-voice patch with 8 notes held and a
//! 16-note pattern playing (1 bar of 16ths, so every block has a fair chance
//! of a note event and the racks render in split segments), render 10 s of
//! audio; the elapsed time must stay under 25% of real time.
//!
//! The tracks are driven through [`Synths`] (the engine's synth-track
//! storage) rather than engine commands: through commands, `SET_INPUT_TRACK`
//! releases the previous input track's notes, so notes could not be held on
//! all four tracks at once (the worst case measured here).
//!
//! The brief lists 11 modules for "the 13-module patch"; two more plausible
//! ones (a second pw LFO for Osc B and a sub oscillator into Mixer in4) make
//! it 13, which only makes the budget stricter.
//!
//! The Song-mode variant drives the whole [`Engine`] through commands: the
//! same four synth tracks (8 notes held live on one of them) plus two 8-row
//! drum tracks, each track with 32 two-bar clips starting every bar (so two
//! clips of different patterns always overlap: twice the note events), a
//! 4-bar loop (one wrap in the 10 s) and the metronome on.

use daw_engine::arrangement::Timeline;
use daw_engine::protocol::*;
use daw_engine::Engine;
use daw_engine::rack::catalog::ModuleKind as K;
use daw_engine::rack::modules::{Ctx, NoteEvent};
use daw_engine::sequencer::SeqNote;
use daw_engine::synth::Synths;
use std::time::Instant;

const SR: f32 = 48000.0;
const SECONDS: usize = 10;
const BLOCK: usize = 128;
const TRACKS: usize = 4;

/// The 13-module patch: modules (by slot) and cables `((from module, port),
/// (to module, port))`.
const MODULES: [K; 13] = [
        K::MidiIn, // 0 (8 voices by default)
        K::Osc,    // 1 osc A: square, unison 2, pw <- LFO 8
        K::Osc,    // 2 osc B: saw, unison 2, pw <- LFO 11
        K::Mixer,  // 3
        K::Filter, // 4 LP24 <- ADSR 5 (cv_amt 3)
        K::Adsr,   // 5 filter env
        K::Adsr,   // 6 amp env
        K::Vca,    // 7 <- ADSR 6
        K::Lfo,    // 8 -> osc A pw
        K::Noise,  // 9 -> mixer in3
        K::Out,    // 10
        K::Lfo,    // 11 -> osc B pw
        K::Osc,    // 12 sub osc (octave -1) -> mixer in4
];
const CABLES: [((usize, usize), (usize, usize)); 17] = [
        ((0, 0), (1, 0)),
        ((0, 0), (2, 0)),
        ((0, 0), (12, 0)),
        ((1, 0), (3, 0)),
        ((2, 0), (3, 1)),
        ((9, 0), (3, 2)),
        ((12, 0), (3, 3)),
        ((3, 0), (4, 0)),
        ((0, 1), (5, 0)),
        ((0, 1), (6, 0)),
        ((5, 0), (4, 1)),
        ((4, 0), (7, 0)),
        ((6, 0), (7, 1)),
        ((8, 0), (1, 2)),
        ((11, 0), (2, 2)),
        ((7, 0), (10, 0)),
        ((7, 0), (10, 1)),
];
/// `(module, param, value)`: osc A square, unison 2 on both oscs, osc B a
/// fifth up, sub octave, filter cv_amt 3 and reso 0.5, a slower second LFO.
const PARAMS: [(usize, usize, f32); 8] =
    [(1, 0, 1.0), (1, 6, 2.0), (2, 6, 2.0), (2, 2, 7.0), (12, 1, -1.0), (4, 3, 3.0), (4, 2, 0.5), (11, 1, 0.3)];

/// Build the 13-module patch on track `slot` and hold 8 notes.
fn build(s: &mut Synths, slot: usize) {
    s.add_track(slot);
    let r = s.rack_mut(slot).expect("active synth track");
    let ok = |code: i32| assert_eq!(code, OK);
    for (m, &kind) in MODULES.iter().enumerate() {
        ok(r.add_module(m, kind));
    }
    for (from, to) in CABLES {
        ok(r.connect(from, to));
    }
    for (m, p, v) in PARAMS {
        ok(r.set_param(m, p, v));
    }
    for (i, n) in [48u8, 52, 55, 59, 62, 65, 69, 72].into_iter().enumerate() {
        r.note(NoteEvent::On { note: n + slot as u8, vel: 90 + i as u8 });
    }
    // 16-note pattern: one bar of 16ths (half a step long), an arpeggio.
    assert!(s.set_pattern_bars(slot, 1, &[]));
    for i in 0..16u32 {
        let note = SeqNote { active: true, pitch: 60 + (i * 5 % 24) as u8, vel: 100, start: i * 240, len: 120 };
        assert!(s.set_note(slot, i as usize, note, &[]));
    }
}

#[test]
#[ignore = "perf: run in release with --ignored --nocapture"]
fn four_synth_tracks_render_under_budget() {
    let mut s = Synths::new(SR);
    for slot in 0..TRACKS {
        build(&mut s, slot);
    }
    let bpm = 124.0f32;
    let tpf = bpm as f64 * 960.0 / 60.0 / SR as f64;
    let mut ctx = Ctx { sr: SR, bpm, playing: true, ticks: 0.0, ticks_per_frame: tpf };
    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    let blocks = SECONDS * SR as usize / BLOCK;

    // Warm up (caches, branch predictors), then measure.
    for _ in 0..100 {
        l.fill(0.0);
        r.fill(0.0);
        render(&mut s, &mut ctx, tpf, &mut l, &mut r);
    }
    let mut peak = 0.0f32;
    let t0 = Instant::now();
    for _ in 0..blocks {
        l.fill(0.0);
        r.fill(0.0);
        render(&mut s, &mut ctx, tpf, &mut l, &mut r);
        peak = peak.max(l[0].abs());
    }
    let elapsed = t0.elapsed().as_secs_f64();
    let audio = (blocks * BLOCK) as f64 / SR as f64;
    let ratio = elapsed / audio;
    println!(
        "perf: {TRACKS} tracks x 13 modules x 8 voices + 16-note patterns: {elapsed:.3} s for {audio:.1} s of audio = {:.1}% of real time",
        ratio * 100.0
    );
    assert!(peak > 0.0 && peak.is_finite(), "patch must sound (peak {peak})");
    assert!(ratio < 0.25, "over budget: {:.1}% of real time", ratio * 100.0);
}

/// One playing block: patterns get the transport window, then the playhead
/// advances by exactly the window.
fn render(s: &mut Synths, ctx: &mut Ctx, tpf: f64, l: &mut [f32], r: &mut [f32]) {
    let t1 = ctx.ticks + BLOCK as f64 * tpf;
    s.render_add(ctx, Some((ctx.ticks, t1, 1.0 / tpf)), Timeline::Pattern, l, r);
    ctx.ticks = t1;
}

/// The 16-note arpeggio of `build`, as `(pitch, start)` (length 120).
fn arp(i: u32, transpose: u32) -> (f64, f64) {
    ((60 + (i * 5 + transpose) % 24) as f64, (i * 240) as f64)
}

#[test]
#[ignore = "perf: run in release with --ignored --nocapture"]
fn song_mode_renders_under_budget() {
    let mut e = Engine::new(SR);
    let ok = |code: i32| assert_eq!(code, OK);
    let max_notes = daw_engine::MAX_NOTES as f64;
    let max_clips = daw_engine::MAX_CLIPS as f64;
    // Drum sample: 0.1 s of a decaying sine.
    let p = e.sample_alloc(0, 4800, 1).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 4800) }
        .iter_mut()
        .enumerate()
        .for_each(|(i, x)| *x = ((i as f32) * 0.05).sin() * (1.0 - i as f32 / 4800.0));
    ok(e.sample_ready(0));
    for slot in 0..TRACKS {
        let s = slot as f64;
        ok(e.command(OP_ADD_SYNTH_TRACK, s, 0., 0., 0.));
        for (m, &kind) in MODULES.iter().enumerate() {
            ok(e.command(OP_RACK_ADD_MODULE, s, m as f64, kind as u32 as f64, 0.));
        }
        for ((fm, fp), (tm, tp)) in CABLES {
            ok(e.command(OP_RACK_CONNECT, s, (fm * 16 + fp) as f64, (tm * 16 + tp) as f64, 0.));
        }
        for (m, p, v) in PARAMS {
            ok(e.command(OP_RACK_SET_PARAM, s, m as f64, p as f64, v as f64));
        }
        // Patterns 0 and 1: 1-bar arpeggios (16 notes each).
        for pat in 0..2u32 {
            ok(e.command(OP_SET_CURRENT_PATTERN, s, pat as f64, 0., 0.));
            ok(e.command(OP_SET_PATTERN_BARS, s, 1., 0., 0.));
            for i in 0..16u32 {
                let (pitch, start) = arp(i, slot as u32 + 7 * pat);
                ok(e.command(OP_NOTE_SET, s * max_notes + i as f64, pitch * 128. + 100., start, 120.));
            }
        }
    }
    for slot in TRACKS..TRACKS + 2 {
        let s = slot as f64;
        ok(e.command(OP_ADD_DRUM_TRACK, s, 0., 0., 0.));
        for row in 0..8u32 {
            ok(e.command(OP_SET_ROW_SAMPLE, s, row as f64, 0., 0.));
            for pat in 0..2u32 {
                ok(e.command(OP_SET_CURRENT_PATTERN, s, pat as f64, 0., 0.));
                for step in (row % 2 + pat..16).step_by(2 + row as usize % 3) {
                    ok(e.command(OP_SET_STEP, s, row as f64, step as f64, 100.));
                }
            }
        }
        ok(e.command(OP_SET_SWING, s, 0.4, 0., 0.));
    }
    // 32 two-bar clips per track, one starting every bar, alternating
    // patterns and offsets: two clips always overlap.
    for slot in 0..TRACKS + 2 {
        for i in 0..32u32 {
            let (pat, offset) = ((i % 2) as f64, ((i % 4) * 480) as f64);
            let a = slot as f64 * max_clips + i as f64;
            ok(e.command(OP_CLIP_SET, a, offset * 16. + pat, i as f64 * 3840., 7680.));
        }
    }
    ok(e.command(OP_SET_INPUT_TRACK, 0., 0., 0., 0.));
    for n in [48., 52., 55., 59., 62., 65., 69., 72.] {
        ok(e.command(OP_NOTE_ON, n, 100., 0., 0.));
    }
    ok(e.command(OP_SET_TEMPO, 124., 0., 0., 0.));
    ok(e.command(OP_SET_METRONOME, 1., 0., 0., 0.));
    ok(e.command(OP_SET_LOOP, 0., 4. * 3840., 0., 0.)); // 10 s at 124 bpm is ~5.2 bars
    ok(e.command(OP_SET_MODE, 1., 0., 0., 0.));
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));

    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    let blocks = SECONDS * SR as usize / BLOCK;
    for _ in 0..100 {
        e.process(&mut l, &mut r);
    }
    let mut peak = 0.0f64;
    let mut wrapped = false;
    let mut last = e.telemetry()[2];
    let t0 = Instant::now();
    for _ in 0..blocks {
        e.process(&mut l, &mut r);
        peak = peak.max(e.telemetry()[5]);
        wrapped |= e.telemetry()[2] < last;
        last = e.telemetry()[2];
    }
    let elapsed = t0.elapsed().as_secs_f64();
    let audio = (blocks * BLOCK) as f64 / SR as f64;
    let ratio = elapsed / audio;
    println!(
        "perf (song): {TRACKS} synth + 2 drum tracks x 32 clips (2 overlapping), loop, metronome: {elapsed:.3} s for {audio:.1} s of audio = {:.1}% of real time",
        ratio * 100.0
    );
    assert!(wrapped, "the loop must wrap during the run");
    assert!(peak > 0.0 && peak.is_finite(), "song must sound (peak {peak})");
    assert!(ratio < 0.25, "over budget: {:.1}% of real time", ratio * 100.0);
}
