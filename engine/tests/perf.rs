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
//! The spec §6 pair ([`spec6`]) drives the whole [`Engine`] through
//! commands with the plan-5 mix: 4 synth tracks (all 8 voices held, plus
//! arpeggios), 4 drum tracks, EQ on every strip, sends to both returns, 2
//! sidechained compressors and the limiter, under 40% of real time. The
//! Song-mode variant plays the same tracks through overlapping clips with a
//! loop wrap, so it is at least as heavy as the Pattern-mode one.
//!
//! ```text
//! cargo test --release -p daw-engine --test perf -- --ignored --nocapture
//! ```
//!
//! The plan-9 variant ([`spec6_with`]) adds 4 Audio tracks to the Song-mode
//! mix, each playing its own 3-minute stereo file (276 MB of samples, so the
//! arena grows past its reserve) through one long clip with gain and fades;
//! every loop pass chases all four. Same 40% budget.
//!
//! The plan-10 variant ([`spec6_auto`]) runs that same mix (Song mode, 4
//! Audio tracks) with all 64 automation lanes defined, 512 breakpoints
//! each, of which 32 apply (16 mixer: faders and sends of the 8 note
//! tracks, so the mixer runs in sub-block chunks; 16 rack: filter cutoff
//! and resonance, osc fine tune and detune on the 4 synth tracks) and 32
//! are disabled. Same 40% budget.
//!
//! The rack-effects case ([`fx_chain_track_renders_under_budget`], plan 6)
//! is one synth track running MIDI In → Osc → Filter → Chorus → Delay →
//! Reverb → Out with 8 voices held: the per-voice part (Osc, Filter) runs 8
//! channels, the effects run once on the summed stereo signal.
//!
//! The Diode case ([`four_diode_synth_tracks_render_under_budget`], plan 17)
//! is the four-track case with every filter switched to the Diode ladder
//! (mode 5, drive 0.35 as in Acid Line): 4 × 8 voices through it, same 25%
//! budget.
//!
//! The House patches ([`house_patches_render_under_budget`], plan 11) each
//! run alone through the whole [`Engine`] (commands replayed from
//! `fixtures/house_patches.txt`): poly patches with an 8-note chord held, mono
//! ones with one note, 5 s each, under one track's 6.25 % share.

mod common;

use daw_engine::arrangement::Timeline;
use daw_engine::automation::AutoFrame;
use daw_engine::protocol::*;
use daw_engine::mixer::catalog::{
    P_COMP_ON, P_COMP_RATIO, P_COMP_THRESHOLD, P_EQ_HIGH, P_EQ_HP, P_EQ_LOW, P_EQ_MID_GAIN, P_EQ_ON, P_FADER, P_SEND_A, P_SEND_B,
};
use daw_engine::mixer::StereoBufs;
use daw_engine::Engine;
use daw_engine::rack::catalog::ModuleKind as K;
use daw_engine::rack::modules::{Ctx, NoteEvent};
use daw_engine::sequencer::SeqNote;
use daw_engine::samples::SampleView;
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

/// Filter (module 4) mode Diode with some drive, as Acid Line uses it.
const DIODE: [(usize, usize, f32); 2] = [(4, 0, 5.0), (4, 4, 0.35)];

/// Build the 13-module patch on track `slot` (then `extra` params on top)
/// and hold 8 notes.
fn build(s: &mut Synths, slot: usize, extra: &[(usize, usize, f32)]) {
    s.add_track(slot);
    let ok = |code: i32| assert_eq!(code, OK);
    for (m, &kind) in MODULES.iter().enumerate() {
        ok(s.add_module(slot, m, kind).expect("active synth track"));
    }
    let r = s.rack_mut(slot).expect("active synth track");
    for (from, to) in CABLES {
        ok(r.connect(from, to));
    }
    for &(m, p, v) in PARAMS.iter().chain(extra) {
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
    let ratio = four_tracks(&[]);
    println!(
        "perf: {TRACKS} tracks x 13 modules x 8 voices + 16-note patterns: {:.1}% of real time",
        ratio * 100.0
    );
    assert!(ratio < 0.25, "over budget: {:.1}% of real time", ratio * 100.0);
}

#[test]
#[ignore = "perf: run in release with --ignored --nocapture"]
fn four_diode_synth_tracks_render_under_budget() {
    let ratio = four_tracks(&DIODE);
    println!(
        "perf (Diode): {TRACKS} tracks x 13 modules x 8 voices through the Diode filter + 16-note patterns: {:.1}% of real time",
        ratio * 100.0
    );
    assert!(ratio < 0.25, "over budget: {:.1}% of real time", ratio * 100.0);
}

/// Renders the four-track case (each track's patch with `extra` params) for
/// [`SECONDS`] after a warm-up; the elapsed share of real time.
fn four_tracks(extra: &[(usize, usize, f32)]) -> f64 {
    let mut s = Synths::new(SR);
    for slot in 0..TRACKS {
        build(&mut s, slot, extra);
    }
    let bpm = 124.0f32;
    let tpf = bpm as f64 * 960.0 / 60.0 / SR as f64;
    let mut ctx = Ctx { sr: SR, bpm, playing: true, ticks: 0.0, ticks_per_frame: tpf };
    let mut bufs = StereoBufs::new(daw_engine::MAX_TRACKS);
    let auto = AutoFrame::new();
    let blocks = SECONDS * SR as usize / BLOCK;

    // Warm up (caches, branch predictors), then measure.
    for _ in 0..100 {
        render(&mut s, &mut ctx, tpf, &mut bufs, &auto);
    }
    let mut peak = 0.0f32;
    let t0 = Instant::now();
    for _ in 0..blocks {
        render(&mut s, &mut ctx, tpf, &mut bufs, &auto);
        peak = peak.max(bufs.pair(0, BLOCK).map_or(0.0, |(l, _)| l[0].abs()));
    }
    let elapsed = t0.elapsed().as_secs_f64();
    let audio = (blocks * BLOCK) as f64 / SR as f64;
    assert!(peak > 0.0 && peak.is_finite(), "patch must sound (peak {peak})");
    elapsed / audio
}

/// One playing block: patterns get the transport window, then the playhead
/// advances by exactly the window.
fn render(s: &mut Synths, ctx: &mut Ctx, tpf: f64, bufs: &mut StereoBufs, auto: &AutoFrame) {
    let t1 = ctx.ticks + BLOCK as f64 * tpf;
    bufs.clear(BLOCK);
    s.render_add(ctx, SampleView::NONE, Some((ctx.ticks, t1, 1.0 / tpf)), Timeline::Pattern { focus: None }, bufs, (0, BLOCK), auto);
    ctx.ticks = t1;
}

/// The 16-note arpeggio of `build`, as `(pitch, start)` (length 120).
fn arp(i: u32, transpose: u32) -> (f64, f64) {
    ((60 + (i * 5 + transpose) % 24) as f64, (i * 240) as f64)
}

/// Synth tracks are slots `0..TRACKS`, drum tracks `TRACKS..2*TRACKS`.
const DRUMS: usize = 4;

/// The spec §6 scenario through engine commands: 4 synth tracks (the
/// 13-module, 8-voice patch; patterns 0 and 1 each hold an 8-note chord
/// for the whole bar, so all 8 voices are busy, plus the 16-note arpeggio
/// stealing voices), 4 drum tracks (8 rows, swing), EQ on every strip, sends
/// to both returns from every track, 2 sidechained compressors (synth 0
/// keyed by the kick row of drum track 0, synth 1 by the whole drum track
/// 1), the limiter, and the metronome. `song`: the tracks play through 32
/// overlapping 2-bar clips each (two clips of different patterns always
/// sound: twice the note events) with a 4-bar loop; otherwise pattern 0
/// loops.
fn spec6(song: bool) -> Engine {
    spec6_with(song, false)
}

/// Audio tracks of the plan-9 variant: slots after the drum tracks.
const AUDIO: usize = 4;
/// Length of each audio track's file (seconds): a 3-minute stereo stem.
const AUDIO_SECONDS: usize = 180;

/// [`spec6`], plus (with `audio`) [`AUDIO`] Audio tracks, each playing its
/// own 3-minute stereo file (four distinct samples, 276 MB: the arena grows
/// past its 128 MB reserve) through one long clip with gain and fades.
fn spec6_with(song: bool, audio: bool) -> Engine {
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
        // Patterns 0 and 1: an 8-note chord held all bar + a 1-bar arpeggio.
        for pat in 0..2u32 {
            ok(e.command(OP_SET_CURRENT_PATTERN, s, pat as f64, 0., 0.));
            ok(e.command(OP_SET_PATTERN_BARS, s, 1., 0., 0.));
            for (i, n) in [36u32, 40, 43, 47, 50, 53, 57, 60].into_iter().enumerate() {
                let a = s * max_notes + 16.0 + i as f64;
                ok(e.command(OP_NOTE_SET, a, ((n + slot as u32 + pat) * 128 + 90) as f64, 0., 3840.));
            }
            for i in 0..16u32 {
                let (pitch, start) = arp(i, slot as u32 + 7 * pat);
                ok(e.command(OP_NOTE_SET, s * max_notes + i as f64, pitch * 128. + 100., start, 120.));
            }
        }
        ok(e.command(OP_SET_CURRENT_PATTERN, s, 0., 0., 0.));
    }
    for slot in TRACKS..TRACKS + DRUMS {
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
        ok(e.command(OP_SET_CURRENT_PATTERN, s, 0., 0., 0.));
        ok(e.command(OP_SET_SWING, s, 0.4, 0., 0.));
    }
    // The mix: EQ on every strip, sends to both returns, two keyed comps.
    let mix = |e: &mut Engine, ch: usize, id: u32, v: f64| ok(e.command(OP_MIX_SET, ch as f64, id as f64, v, 0.));
    for ch in 0..TRACKS + DRUMS {
        mix(&mut e, ch, P_EQ_ON, 1.);
        mix(&mut e, ch, P_EQ_HP, 80.);
        mix(&mut e, ch, P_EQ_LOW, 2.);
        mix(&mut e, ch, P_EQ_MID_GAIN, -3.);
        mix(&mut e, ch, P_EQ_HIGH, 1.5);
        mix(&mut e, ch, P_SEND_A, -12.);
        mix(&mut e, ch, P_SEND_B, -18.);
        mix(&mut e, ch, P_FADER, -6.);
    }
    for ch in [daw_engine::MIX_RETURN0, (daw_engine::MIX_RETURN0 + 1), daw_engine::MIX_MASTER] {
        mix(&mut e, ch, P_EQ_ON, 1.);
        mix(&mut e, ch, P_EQ_MID_GAIN, 2.);
    }
    for (ch, key) in [(0usize, TRACKS * 32 + 1), (1, (TRACKS + 1) * 32)] {
        mix(&mut e, ch, P_COMP_ON, 1.);
        mix(&mut e, ch, P_COMP_THRESHOLD, -30.);
        mix(&mut e, ch, P_COMP_RATIO, 8.);
        ok(e.command(OP_MIX_SET_KEY, ch as f64, key as f64, 0., 0.));
    }
    if song {
        // 32 two-bar clips per track, one starting every bar, alternating
        // patterns and offsets: two clips always overlap.
        for slot in 0..TRACKS + DRUMS {
            for i in 0..32u32 {
                let (pat, offset) = ((i % 2) as f64, ((i % 4) * 480) as f64);
                let a = slot as f64 * max_clips + i as f64;
                ok(e.command(OP_CLIP_SET, a, offset * 16. + pat, i as f64 * 3840., 7680.));
            }
        }
        ok(e.command(OP_SET_LOOP, 0., 4. * 3840., 0., 0.)); // 10 s at 124 bpm is ~5.2 bars
        ok(e.command(OP_SET_MODE, 1., 0., 0., 0.));
    }
    if audio {
        let frames = AUDIO_SECONDS * SR as usize;
        for k in 0..AUDIO {
            let (slot, id) = (TRACKS + DRUMS + k, 1 + k as u32);
            let p = e.sample_alloc(id, frames as u32, 2).expect("grows while stopped");
            // A cheap, non-repeating signal (an LCG), so reads are not cached.
            let mut x = 0x9e37_79b9u32.wrapping_mul(id);
            for v in unsafe { std::slice::from_raw_parts_mut(p, frames * 2) } {
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *v = (x >> 9) as f32 / (1u32 << 23) as f32 * 0.2 - 0.1;
            }
            ok(e.sample_ready(id));
            ok(e.command(OP_ADD_AUDIO_TRACK, slot as f64, 0., 0., 0.));
            let a = (slot * daw_engine::MAX_CLIPS) as f64;
            // Starts 0.25 s into the file (every loop pass chases with a fade).
            ok(e.command(OP_AUDIO_CLIP_SOURCE, a, id as f64, 0.25, 0.));
            ok(e.command(OP_AUDIO_CLIP_GAIN, a, 0.7, 240., 240.));
            ok(e.command(OP_AUDIO_CLIP_SET, a, 0., 90. * 3840., 0.)); // ~3 min at 124 bpm
            mix(&mut e, slot, P_EQ_ON, 1.);
            mix(&mut e, slot, P_SEND_A, -12.);
            mix(&mut e, slot, P_FADER, -6.);
        }
    }
    ok(e.command(OP_SET_TEMPO, 124., 0., 0., 0.));
    ok(e.command(OP_SET_METRONOME, 1., 0., 0., 0.));
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));
    e
}

/// Render 10 s of `e` (after a warm-up); returns (share of real time, peak,
/// wrapped, min ducking seen on channel 0 in dB).
fn run(e: &mut Engine) -> (f64, f64, bool, f32) {
    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    let blocks = SECONDS * SR as usize / BLOCK;
    for _ in 0..100 {
        e.process(&mut l, &mut r);
    }
    let mut peak = 0.0f64;
    let mut wrapped = false;
    let mut gr = 0.0f32;
    let mut last = e.telemetry()[2];
    let t0 = Instant::now();
    for _ in 0..blocks {
        e.process(&mut l, &mut r);
        peak = peak.max(e.telemetry()[5]);
        wrapped |= e.telemetry()[2] < last;
        last = e.telemetry()[2];
        gr = gr.max(e.meters()[2]);
    }
    let elapsed = t0.elapsed().as_secs_f64();
    let audio = (blocks * BLOCK) as f64 / SR as f64;
    (elapsed / audio, peak, wrapped, gr)
}

#[test]
#[ignore = "perf: run in release with --ignored --nocapture"]
fn spec6_mix_renders_under_budget() {
    let mut e = spec6(false);
    let (ratio, peak, _, gr) = run(&mut e);
    println!(
        "perf (spec 6, pattern): {TRACKS} synth x 13 modules x 8 voices (held chords + arps) + {DRUMS} drum tracks, EQ on all, 2 sidechained comps, reverb + delay sends, limiter, metronome: {:.1}% of real time",
        ratio * 100.0
    );
    assert!(peak > 0.0 && peak.is_finite(), "must sound (peak {peak})");
    assert!(gr > 1.0, "the sidechain ducks (gr {gr} dB)");
    assert!(ratio < 0.40, "over budget: {:.1}% of real time", ratio * 100.0);
}

#[test]
#[ignore = "perf: run in release with --ignored --nocapture"]
fn spec6_mix_song_mode_renders_under_budget() {
    let mut e = spec6(true);
    let (ratio, peak, wrapped, gr) = run(&mut e);
    println!(
        "perf (spec 6, song): the same mix, every track through 32 overlapping 2-bar clips, 4-bar loop: {:.1}% of real time",
        ratio * 100.0
    );
    assert!(wrapped, "the loop must wrap during the run");
    assert!(peak > 0.0 && peak.is_finite(), "song must sound (peak {peak})");
    assert!(gr > 1.0, "the sidechain ducks (gr {gr} dB)");
    assert!(ratio < 0.40, "over budget: {:.1}% of real time", ratio * 100.0);
}

#[test]
#[ignore = "perf: run in release with --ignored --nocapture"]
fn spec6_mix_with_audio_tracks_renders_under_budget() {
    let mut e = spec6_with(true, true);
    let (ratio, peak, wrapped, gr) = run(&mut e);
    println!(
        "perf (spec 6, song + {AUDIO} audio tracks): the song-mode mix plus {AUDIO} Audio tracks, each a {AUDIO_SECONDS} s stereo clip: {:.1}% of real time",
        ratio * 100.0
    );
    assert!(wrapped, "the loop must wrap during the run");
    assert!(peak > 0.0 && peak.is_finite(), "must sound (peak {peak})");
    assert!(gr > 1.0, "the sidechain ducks (gr {gr} dB)");
    for k in 0..AUDIO {
        let m = e.meters()[(TRACKS + DRUMS + k) * daw_engine::MIX_METER_STRIDE];
        assert!(m > 0.0 && m.is_finite(), "audio track {k} sounds (meter {m})");
    }
    assert!(ratio < 0.40, "over budget: {:.1}% of real time", ratio * 100.0);
}

/// [`spec6_with`] (Song mode, Audio tracks) plus every automation lane: 64
/// lanes of 512 breakpoints over the 4-bar loop, 32 applying (16 mixer, 16
/// rack) and 32 disabled.
fn spec6_auto() -> Engine {
    use daw_engine::mixer::catalog::{param, P_PAN, P_SEND_B};
    use daw_engine::rack::catalog::spec;
    let mut e = spec6_with(true, true);
    let ok = |code: i32| assert_eq!(code, OK);
    let pts = daw_engine::MAX_AUTO_POINTS;
    // (kind, c, d, lo, hi, enabled)
    let mut lanes: Vec<(f64, f64, f64, f32, f32, bool)> = Vec::new();
    for ch in 0..TRACKS + DRUMS {
        lanes.push((1.0, ch as f64, P_FADER as f64, -12.0, 0.0, true));
        lanes.push((1.0, ch as f64, P_SEND_A as f64, -30.0, -6.0, true));
    }
    for ch in TRACKS + DRUMS..TRACKS + DRUMS + AUDIO {
        for id in [P_FADER, P_PAN, P_SEND_A, P_SEND_B] {
            let p = param(id).unwrap();
            lanes.push((1.0, ch as f64, id as f64, p.min, p.max, false));
        }
    }
    // Rack: filter (module 4) cutoff and resonance, osc A (1) fine, osc B (2)
    // detune apply; ADSR 5 decay, ADSR 6 release, LFO 8 rate, LFO 11 depth
    // are disabled.
    for slot in 0..TRACKS {
        for (m, p, lo, hi, on) in [
            (4usize, 1usize, 200.0f32, 8000.0f32, true),
            (4, 2, 0.0, 0.6, true),
            (1, 3, -20.0, 20.0, true),
            (2, 7, 5.0, 40.0, true),
            (5, 1, 0.05, 1.0, false),
            (6, 3, 0.05, 1.0, false),
            (8, 1, 0.1, 10.0, false),
            (11, 4, 0.0, 1.0, false),
        ] {
            assert!(!spec(MODULES[m]).params[p].integer);
            lanes.push((2.0, slot as f64, (m * 16 + p) as f64, lo, hi, on));
        }
    }
    assert_eq!(lanes.len(), daw_engine::MAX_AUTO_LANES);
    assert_eq!(lanes.iter().filter(|l| l.5).count(), 32);
    for (lane, &(kind, c, d, lo, hi, on)) in lanes.iter().enumerate() {
        ok(e.command(OP_AUTO_LANE_SET, lane as f64, kind, c, d));
        for i in 0..pts {
            // Ramps between the ends every breakpoint, 30 ticks apart (the
            // 4-bar loop holds them all), a hold every fourth one.
            let v = if i % 2 == 0 { lo } else { hi };
            let a = (lane * pts + i) as f64;
            ok(e.command(OP_AUTO_POINT_SET, a, (i * 30) as f64, v as f64, (i % 4 == 3) as u8 as f64));
        }
        if !on {
            ok(e.command(OP_AUTO_LANE_ENABLE, lane as f64, 0., 0., 0.));
        }
    }
    e
}

#[test]
#[ignore = "perf: run in release with --ignored --nocapture"]
fn spec6_mix_with_audio_and_automation_renders_under_budget() {
    let mut e = spec6_auto();
    let (ratio, peak, wrapped, gr) = run(&mut e);
    println!(
        "perf (spec 6, song + {AUDIO} audio tracks + 64 automation lanes, 32 applying): {:.1}% of real time",
        ratio * 100.0
    );
    assert!(wrapped, "the loop must wrap during the run");
    assert!(peak > 0.0 && peak.is_finite(), "must sound (peak {peak})");
    assert!(gr > 1.0, "the sidechain ducks (gr {gr} dB)");
    assert!(ratio < 0.40, "over budget: {:.1}% of real time", ratio * 100.0);
}

#[test]
#[ignore = "perf: run in release with --ignored --nocapture"]
fn fx_chain_track_renders_under_budget() {
    let mut s = Synths::new(SR);
    s.add_track(0);
    let ok = |code: i32| assert_eq!(code, OK);
    // MIDI In, Osc, Filter, Chorus, Delay, Reverb, Out.
    let kinds = [K::MidiIn, K::Osc, K::Filter, K::Chorus, K::Delay, K::Reverb, K::Out];
    for (m, &kind) in kinds.iter().enumerate() {
        ok(s.add_module(0, m, kind).expect("active synth track"));
    }
    let r = s.rack_mut(0).expect("active synth track");
    // pitch -> osc -> filter -> chorus l -> delay l/r -> reverb l/r -> out l/r.
    for (from, to) in [
        ((0, 0), (1, 0)),
        ((1, 0), (2, 0)),
        ((2, 0), (3, 0)),
        ((3, 0), (4, 0)),
        ((3, 1), (4, 1)),
        ((4, 0), (5, 0)),
        ((4, 1), (5, 1)),
        ((5, 0), (6, 0)),
        ((5, 1), (6, 1)),
    ] {
        ok(r.connect(from, to));
    }
    ok(r.set_param(5, 4, 0.4)); // reverb mix
    ok(r.set_param(6, 0, 0.1)); // out level: 8 summed voices
    for (i, n) in [48u8, 52, 55, 59, 62, 65, 69, 72].into_iter().enumerate() {
        r.note(NoteEvent::On { note: n, vel: 90 + i as u8 });
    }
    let bpm = 124.0f32;
    let tpf = bpm as f64 * 960.0 / 60.0 / SR as f64;
    let mut ctx = Ctx { sr: SR, bpm, playing: true, ticks: 0.0, ticks_per_frame: tpf };
    let mut bufs = StereoBufs::new(daw_engine::MAX_TRACKS);
    let auto = AutoFrame::new();
    let blocks = SECONDS * SR as usize / BLOCK;
    for _ in 0..100 {
        render(&mut s, &mut ctx, tpf, &mut bufs, &auto);
    }
    let mut peak = 0.0f32;
    let t0 = Instant::now();
    for _ in 0..blocks {
        render(&mut s, &mut ctx, tpf, &mut bufs, &auto);
        peak = peak.max(bufs.pair(0, BLOCK).map_or(0.0, |(l, _)| l[0].abs()));
    }
    let elapsed = t0.elapsed().as_secs_f64();
    let audio = (blocks * BLOCK) as f64 / SR as f64;
    let ratio = elapsed / audio;
    println!(
        "perf (rack fx): 1 track, MIDI In -> Osc -> Filter (8 voices) -> Chorus -> Delay -> Reverb -> Out: {elapsed:.3} s for {audio:.1} s of audio = {:.2}% of real time",
        ratio * 100.0
    );
    assert!(peak > 0.0 && peak.is_finite(), "patch must sound (peak {peak})");
    // One track's share of the 25% four-track budget.
    assert!(ratio < 0.0625, "over budget: {:.2}% of real time", ratio * 100.0);
}

#[test]
#[ignore = "perf: run in release with --ignored --nocapture"]
fn house_patches_render_under_budget() {
    let patches = common::house_patches();
    assert_eq!(patches.len(), 21, "the whole House set (plan 28: 19 house + 2 transition patches)");
    let mut over = Vec::new();
    for p in &patches {
        let mut e = Engine::new(SR);
        for c in &p.cmds {
            assert_eq!(e.command(c[0] as u32, c[1], c[2], c[3], c[4]), OK, "{}: {c:?}", p.name);
        }
        let notes: &[u8] = if p.phrase.mono() { &[60] } else { &[48, 52, 55, 59, 62, 65, 69, 72] };
        for &n in notes {
            assert_eq!(e.command(OP_NOTE_ON, n as f64, 100., 0., 0.), OK);
        }
        let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
        for _ in 0..100 {
            e.process(&mut l, &mut r);
        }
        let blocks = 5 * SR as usize / BLOCK;
        let mut peak = 0.0f32;
        let t0 = Instant::now();
        for _ in 0..blocks {
            e.process(&mut l, &mut r);
            peak = peak.max(l[0].abs());
        }
        let ratio = t0.elapsed().as_secs_f64() / ((blocks * BLOCK) as f64 / SR as f64);
        println!("perf (house): {} ({} voices held): {:.2}% of real time", p.name, notes.len(), ratio * 100.0);
        assert!(peak > 0.0 && peak.is_finite(), "{} must sound (peak {peak})", p.name);
        if ratio >= 0.0625 {
            over.push(format!("{} {:.2}%", p.name, ratio * 100.0));
        }
    }
    // One track's share of the 25% four-track budget.
    assert!(over.is_empty(), "over budget: {over:?}");
}
