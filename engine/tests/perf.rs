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

use daw_engine::protocol::OK;
use daw_engine::rack::catalog::ModuleKind as K;
use daw_engine::rack::modules::{Ctx, NoteEvent};
use daw_engine::sequencer::SeqNote;
use daw_engine::synth::Synths;
use std::time::Instant;

const SR: f32 = 48000.0;
const SECONDS: usize = 10;
const BLOCK: usize = 128;
const TRACKS: usize = 4;

/// Build the 13-module patch on track `slot` and hold 8 notes.
fn build(s: &mut Synths, slot: usize) {
    s.add_track(slot);
    let r = s.rack_mut(slot).expect("active synth track");
    let ok = |code: i32| assert_eq!(code, OK);
    let modules = [
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
    for (m, &kind) in modules.iter().enumerate() {
        ok(r.add_module(m, kind));
    }
    for (from, to) in [
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
    ] {
        ok(r.connect(from, to));
    }
    ok(r.set_param(1, 0, 1.0)); // osc A square
    ok(r.set_param(1, 6, 2.0)); // unison 2
    ok(r.set_param(2, 6, 2.0));
    ok(r.set_param(2, 2, 7.0)); // osc B a fifth up
    ok(r.set_param(12, 1, -1.0)); // sub octave
    ok(r.set_param(4, 3, 3.0)); // filter cv_amt
    ok(r.set_param(4, 2, 0.5)); // reso
    ok(r.set_param(11, 1, 0.3)); // slower second LFO
    for (i, n) in [48u8, 52, 55, 59, 62, 65, 69, 72].into_iter().enumerate() {
        r.note(NoteEvent::On { note: n + slot as u8, vel: 90 + i as u8 });
    }
    // 16-note pattern: one bar of 16ths (half a step long), an arpeggio.
    assert!(s.set_pattern_bars(slot, 1));
    for i in 0..16u32 {
        let note = SeqNote { active: true, pitch: 60 + (i * 5 % 24) as u8, vel: 100, start: i * 240, len: 120 };
        assert!(s.set_note(slot, i as usize, note));
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
/// advances by exactly the window (as `Transport` does).
fn render(s: &mut Synths, ctx: &mut Ctx, tpf: f64, l: &mut [f32], r: &mut [f32]) {
    let t1 = ctx.ticks + BLOCK as f64 * tpf;
    s.render_add(ctx, Some((ctx.ticks, t1, 1.0 / tpf)), l, r);
    ctx.ticks = t1;
}
