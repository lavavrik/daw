//! Steady-state playback must never touch the heap. A counting global
//! allocator (armed and counted per thread, so tests running in parallel and
//! the harness's own threads don't pollute each other's counts) wraps the
//! system allocator.

mod common;

use daw_engine::protocol::*;
use daw_engine::Engine;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
    static ALLOCS: Cell<usize> = const { Cell::new(0) };
}

struct Counting;
fn note() {
    if ARMED.with(|a| a.get()) {
        ALLOCS.with(|n| n.set(n.get() + 1));
    }
}

/// Start counting this thread's allocations from 0.
fn arm() {
    ALLOCS.with(|n| n.set(0));
    ARMED.with(|a| a.set(true));
}

/// Stop counting; returns this thread's allocations since `arm`.
fn disarm() -> usize {
    ARMED.with(|a| a.set(false));
    ALLOCS.with(|n| n.get())
}
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        note();
        System.alloc(l)
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        note();
        System.alloc_zeroed(l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        note();
        System.realloc(p, l, n)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l)
    }
}
#[global_allocator]
static A: Counting = Counting;

#[test]
fn playback_does_not_allocate() {
    let mut e = Engine::new(48000.0);
    // Load a short mono sample (outside the counted region).
    let p = e.sample_alloc(0, 4800, 1).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 4800) }
        .iter_mut()
        .enumerate()
        .for_each(|(i, x)| *x = ((i as f32) * 0.05).sin());
    assert_eq!(e.sample_ready(0), 0);

    arm();

    for slot in 0..2u32 {
        assert_eq!(e.command(OP_ADD_DRUM_TRACK, slot as f64, 0., 0., 0.), 0);
        for row in 0..8u32 {
            e.command(OP_SET_ROW_SAMPLE, slot as f64, row as f64, 0.0, 0.0);
            e.command(OP_SET_ROW_PAN, slot as f64, row as f64, (row as f64 - 4.0) / 4.0, 0.0);
            for step in (0..16u32).step_by(2 + row as usize % 3) {
                e.command(OP_SET_STEP, slot as f64, row as f64, step as f64, 100.0);
            }
        }
    }
    e.command(OP_SET_METRONOME, 1., 0., 0., 0.);
    e.command(OP_PLAY, 0., 0., 0., 0.);

    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    for b in 0..500u32 {
        match b {
            50 => { assert_eq!(e.command(OP_SET_STEP, 0., 3., 5., 90.), 0) }
            100 => { assert_eq!(e.command(OP_SET_TEMPO, 170., 0., 0., 0.), 0) }
            150 => { assert_eq!(e.command(OP_SET_SWING, 1., 0.6, 0., 0.), 0) }
            200 => { assert_eq!(e.command(OP_SET_STEP_COUNT, 0., 32., 0., 0.), 0) }
            250 => { assert_eq!(e.command(OP_SET_ROW_MUTE, 1., 2., 1., 0.), 0) }
            300 => { assert_eq!(e.command(OP_SET_STEP_COUNT, 0., 16., 0., 0.), 0) }
            // Plan 21: deleting and restoring a drum row (rows, every pattern's
            // steps, voices and keys shift in place) while it sounds.
            320 => { assert_eq!(e.command(OP_MIX_SET_KEY, 0., 32. + 4., 0., 0.), 0) } // key: track 1 row 3
            330 => { assert_eq!(e.command(OP_REMOVE_ROW, 1., 1., 0., 0.), 0) }
            340 => { assert_eq!(e.command(OP_INSERT_ROW, 1., 1., 0., 0.), 0) }
            400 => { assert_eq!(e.command(OP_STOP, 0., 0., 0., 0.), 0) }
            420 => { assert_eq!(e.command(OP_PLAY, 0., 0., 0., 0.), 0) }
            _ => {}
        }
        e.process(&mut l, &mut r);
    }

    assert_eq!(disarm(), 0, "audio path allocated");
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));

    // Prove the drums actually sounded: drop the metronome, let its click
    // finish, then watch the peak with only drums playing.
    e.command(OP_SET_METRONOME, 0., 0., 0., 0.);
    for _ in 0..100 {
        e.process(&mut l, &mut r);
    }
    let mut peak = 0.0f64;
    for _ in 0..200 {
        e.process(&mut l, &mut r);
        peak = peak.max(e.telemetry()[5]);
    }
    assert!(peak > 0.05, "drums should be audible, peak {peak}");
}

// Module kind wire ids (rack/catalog.rs).
const MIDI_IN: f64 = 0.0;
const OSC: f64 = 1.0;
const FILTER: f64 = 3.0;
const ADSR: f64 = 4.0;
const VCA: f64 = 5.0;
const LFO: f64 = 6.0;
const MIXER: f64 = 7.0;
const OUT: f64 = 8.0;

/// Packed port argument: `module * 16 + port`.
fn pk(module: u32, port: u32) -> f64 {
    (module * 16 + port) as f64
}

/// Synth tracks: adding a track, building a 10-module patch (structural
/// edits on the audio thread), live notes, controllers, params, cable edits,
/// clear, kind swaps and removal, all with the counter ARMED.
#[test]
fn synth_tracks_and_rack_commands_do_not_allocate() {
    let mut e = Engine::new(48000.0);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let s = 2.0; // slot
    let ok = |code: i32| assert_eq!(code, OK);

    arm();

    ok(e.command(OP_ADD_SYNTH_TRACK, s, 0., 0., 0.));
    let modules = [MIDI_IN, OSC, OSC, MIXER, FILTER, ADSR, ADSR, VCA, LFO, OUT];
    for (m, kind) in modules.iter().enumerate() {
        ok(e.command(OP_RACK_ADD_MODULE, s, m as f64, *kind, 0.));
    }
    let cables = [
        ((0, 0), (1, 0)), // pitch -> osc A pitch
        ((0, 0), (2, 0)), // pitch -> osc B pitch
        ((1, 0), (3, 0)), // osc A -> mixer in1
        ((2, 0), (3, 1)), // osc B -> mixer in2
        ((3, 0), (4, 0)), // mixer -> filter in
        ((0, 1), (5, 0)), // gate -> filter env
        ((0, 1), (6, 0)), // gate -> amp env
        ((5, 0), (4, 1)), // filter env -> filter cv
        ((4, 0), (7, 0)), // filter -> vca in
        ((6, 0), (7, 1)), // amp env -> vca cv
        ((8, 0), (1, 2)), // lfo -> osc A pw
        ((7, 0), (9, 0)), // vca -> out l
        ((7, 0), (9, 1)), // vca -> out r
    ];
    for ((fm, fp), (tm, tp)) in cables {
        ok(e.command(OP_RACK_CONNECT, s, pk(fm, fp), pk(tm, tp), 0.));
    }
    ok(e.command(OP_RACK_SET_PARAM, s, 2., 6., 2.)); // osc B unison 2
    ok(e.command(OP_RACK_SET_PARAM, s, 4., 3., 3.)); // filter cv_amt
    ok(e.command(OP_SET_INPUT_TRACK, s, 0., 0., 0.));
    for n in [48.0, 52.0, 55.0, 59.0, 60.0, 64.0, 67.0, 71.0] {
        ok(e.command(OP_NOTE_ON, n, 100., 0., 0.));
    }
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));

    let mut peak = 0.0f64;
    for b in 0..400u32 {
        match b {
            20 => ok(e.command(OP_RACK_SET_PARAM, s, 4., 1., 400.)), // cutoff
            30 => ok(e.command(OP_PITCH_BEND, 0.5, 0., 0., 0.)),
            40 => ok(e.command(OP_MOD_WHEEL, 0.7, 0., 0., 0.)),
            50 => ok(e.command(OP_SUSTAIN, 1., 0., 0., 0.)),
            60 => ok(e.command(OP_NOTE_OFF, 48., 0., 0., 0.)),
            70 => ok(e.command(OP_SUSTAIN, 0., 0., 0., 0.)),
            80 => ok(e.command(OP_RACK_SET_PARAM, s, 1., 0., 1.)), // osc A square
            100 => ok(e.command(OP_RACK_DISCONNECT, s, pk(3, 1), 0., 0.)), // sounding: queued
            110 => ok(e.command(OP_RACK_CONNECT, s, pk(2, 0), pk(3, 1), 0.)),
            120 => ok(e.command(OP_RACK_REMOVE_MODULE, s, 8., 0., 0.)),
            130 => ok(e.command(OP_RACK_ADD_MODULE, s, 8., LFO, 0.)),
            140 => ok(e.command(OP_RACK_CONNECT, s, pk(8, 0), pk(1, 2), 0.)),
            200 => ok(e.command(OP_STOP, 0., 0., 0., 0.)), // racks keep rendering
            250 => ok(e.command(OP_RACK_CLEAR, s, 0., 0., 0.)),
            260 => ok(e.command(OP_ADD_DRUM_TRACK, s, 0., 0., 0.)), // kind swap
            270 => ok(e.command(OP_ADD_SYNTH_TRACK, s, 0., 0., 0.)),
            280 => ok(e.command(OP_RACK_ADD_MODULE, s, 0., LFO, 0.)),
            281 => ok(e.command(OP_RACK_ADD_MODULE, s, 1., OUT, 0.)),
            282 => ok(e.command(OP_RACK_CONNECT, s, pk(0, 0), pk(1, 0), 0.)),
            300 => ok(e.command(OP_SET_INPUT_TRACK, -1., 0., 0., 0.)),
            350 => ok(e.command(OP_REMOVE_TRACK, s, 0., 0., 0.)),
            _ => {}
        }
        e.process(&mut l, &mut r);
        if b < 100 {
            peak = peak.max(e.telemetry()[5]);
        }
    }

    assert_eq!(disarm(), 0, "synth path allocated");
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    assert!(peak > 0.05, "synth should be audible, peak {peak}");
}

/// Note patterns: 200 notes on a synth track, playback across loop ends at a
/// 2-bar length, editing / removing / moving notes while they sound, length
/// changes, clear, Stop (sequenced releases) and Play with a count-in, all with
/// the counter ARMED.
#[test]
fn note_patterns_and_count_in_do_not_allocate() {
    let mut e = Engine::new(48000.0);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let s = 1.0; // slot
    let ok = |code: i32| assert_eq!(code, OK);
    let max_notes = daw_engine::MAX_NOTES as f64;
    let addr = |idx: f64| s * max_notes + idx;
    let pv = |pitch: f64, vel: f64| pitch * 128.0 + vel;

    arm();

    ok(e.command(OP_ADD_SYNTH_TRACK, s, 0., 0., 0.));
    for (m, kind) in [MIDI_IN, OSC, ADSR, VCA, OUT].iter().enumerate() {
        ok(e.command(OP_RACK_ADD_MODULE, s, m as f64, *kind, 0.));
    }
    for ((fm, fp), (tm, tp)) in [((0, 0), (1, 0)), ((0, 1), (2, 0)), ((1, 0), (3, 0)), ((2, 0), (3, 1)), ((3, 0), (4, 0))] {
        ok(e.command(OP_RACK_CONNECT, s, pk(fm, fp), pk(tm, tp), 0.));
    }
    ok(e.command(OP_SET_PATTERN_BARS, s, 2., 0., 0.));
    // 200 notes over 2 bars (7680 ticks): every 38.4 ticks, some crossing
    // the loop end, some longer than the pattern.
    for i in 0..200u32 {
        let start = (i * 7680 / 200) as f64;
        let len = [120.0, 480.0, 2000.0, 9000.0][i as usize % 4];
        ok(e.command(OP_NOTE_SET, addr(i as f64), pv(36.0 + (i % 48) as f64, 100.0), start, len));
    }
    ok(e.command(OP_SET_TEMPO, 170., 0., 0., 0.));
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));

    // 170 bpm at 48 kHz: a bar is ~67765 samples (~530 blocks); 4 bars ~2120.
    let mut peak = 0.0f64;
    for b in 0..2600u32 {
        match b {
            100 => ok(e.command(OP_NOTE_SET, addr(3.), pv(70., 90.), 115., 9000.)), // edit a sounding note
            110 => ok(e.command(OP_NOTE_REMOVE, addr(2.), 0., 0., 0.)), // remove a sounding note
            120 => ok(e.command(OP_NOTE_SET, addr(7.), pv(43., 100.), 5000., 2000.)), // move
            130 => ok(e.command(OP_NOTE_SET, addr(500.), pv(80., 64.), 3000., 100.)), // new high slot
            1500 => ok(e.command(OP_SET_PATTERN_BARS, s, 1., 0., 0.)),
            1600 => ok(e.command(OP_SET_PATTERN_BARS, s, 16., 0., 0.)),
            1700 => ok(e.command(OP_SET_PATTERN_BARS, s, 2., 0., 0.)),
            2200 => ok(e.command(OP_STOP, 0., 0., 0., 0.)),
            2210 => ok(e.command(OP_PLAY, 3840., 0., 0., 0.)), // count-in
            2400 => ok(e.command(OP_NOTE_CLEAR, s, 0., 0., 0.)),
            2410 => ok(e.command(OP_NOTE_SET, addr(0.), pv(60., 100.), 0., 240.)),
            _ => {}
        }
        e.process(&mut l, &mut r);
        if b < 1500 {
            peak = peak.max(e.telemetry()[5]);
        }
    }

    assert_eq!(disarm(), 0, "pattern path allocated");
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    assert!(peak > 0.05, "pattern should be audible, peak {peak}");
}

/// Multiple patterns per track: switching the current pattern (drums and a
/// synth with sounding notes), copying into the playing pattern, clearing,
/// editing the current pattern and re-adding tracks, all while playing with
/// the counter ARMED.
#[test]
fn pattern_switches_and_copies_do_not_allocate() {
    let mut e = Engine::new(48000.0);
    let p = e.sample_alloc(0, 4800, 1).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 4800) }
        .iter_mut()
        .enumerate()
        .for_each(|(i, x)| *x = ((i as f32) * 0.05).sin());
    assert_eq!(e.sample_ready(0), 0);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let (d, s) = (0.0, 1.0); // drum slot, synth slot
    let ok = |code: i32| assert_eq!(code, OK);
    let max_notes = daw_engine::MAX_NOTES as f64;
    let addr = |idx: f64| s * max_notes + idx;
    let pv = |pitch: f64, vel: f64| pitch * 128.0 + vel;

    arm();

    ok(e.command(OP_ADD_DRUM_TRACK, d, 0., 0., 0.));
    ok(e.command(OP_ADD_SYNTH_TRACK, s, 0., 0., 0.));
    for row in 0..4u32 {
        ok(e.command(OP_SET_ROW_SAMPLE, d, row as f64, 0., 0.));
    }
    for (m, kind) in [MIDI_IN, OSC, ADSR, VCA, OUT].iter().enumerate() {
        ok(e.command(OP_RACK_ADD_MODULE, s, m as f64, *kind, 0.));
    }
    for ((fm, fp), (tm, tp)) in [((0, 0), (1, 0)), ((0, 1), (2, 0)), ((1, 0), (3, 0)), ((2, 0), (3, 1)), ((3, 0), (4, 0))] {
        ok(e.command(OP_RACK_CONNECT, s, pk(fm, fp), pk(tm, tp), 0.));
    }
    // Patterns 0..4 with different contents and lengths.
    for pat in 0..4u32 {
        ok(e.command(OP_SET_CURRENT_PATTERN, d, pat as f64, 0., 0.));
        ok(e.command(OP_SET_CURRENT_PATTERN, s, pat as f64, 0., 0.));
        ok(e.command(OP_SET_STEP_COUNT, d, [16., 32., 64., 16.][pat as usize], 0., 0.));
        ok(e.command(OP_SET_SWING, d, 0.2 * pat as f64, 0., 0.));
        for step in (pat..32).step_by(3) {
            ok(e.command(OP_SET_STEP, d, (step % 4) as f64, step as f64, 100.));
        }
        ok(e.command(OP_SET_PATTERN_BARS, s, (pat + 1) as f64, 0., 0.));
        for i in 0..64u32 {
            let start = (i * 240 * (pat + 1)) as f64;
            ok(e.command(OP_NOTE_SET, addr(i as f64), pv(40.0 + ((i + pat) % 36) as f64, 100.), start, 900.));
        }
    }
    ok(e.command(OP_SET_TEMPO, 170., 0., 0., 0.));
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));

    let mut peak = 0.0f64;
    for b in 0..1200u32 {
        match b {
            40 => ok(e.command(OP_SET_CURRENT_PATTERN, s, 1., 0., 0.)),
            41 => ok(e.command(OP_SET_CURRENT_PATTERN, d, 1., 0., 0.)),
            90 => ok(e.command(OP_SET_SWING, d, 0.7, 0., 0.)), // latches on the playing pattern
            100 => ok(e.command(OP_COPY_PATTERN, s, 2., 1., 0.)), // into the sounding pattern
            101 => ok(e.command(OP_COPY_PATTERN, d, 2., 1., 0.)),
            150 => ok(e.command(OP_SET_CURRENT_PATTERN, s, 3., 0., 0.)),
            151 => ok(e.command(OP_SET_CURRENT_PATTERN, d, 2., 0., 0.)),
            152 => ok(e.command(OP_SET_CURRENT_PATTERN, d, 2., 0., 0.)), // same: no-op
            200 => ok(e.command(OP_COPY_PATTERN, s, 3., 9., 0.)),
            201 => ok(e.command(OP_COPY_PATTERN, d, 0., 15., 0.)),
            202 => ok(e.command(OP_COPY_PATTERN, d, 15., 15., 0.)),
            250 => ok(e.command(OP_NOTE_SET, addr(5.), pv(70., 90.), 100., 2000.)),
            260 => ok(e.command(OP_SET_STEP, d, 0., 3., 127.)),
            300 => ok(e.command(OP_CLEAR_PATTERN_DATA, s, 3., 0., 0.)), // the playing one
            301 => ok(e.command(OP_CLEAR_PATTERN_DATA, d, 2., 0., 0.)),
            302 => ok(e.command(OP_CLEAR_PATTERN_DATA, s, 0., 0., 0.)),
            350 => ok(e.command(OP_SET_CURRENT_PATTERN, s, 9., 0., 0.)),
            351 => ok(e.command(OP_SET_CURRENT_PATTERN, d, 15., 0., 0.)),
            600 => ok(e.command(OP_STOP, 0., 0., 0., 0.)),
            610 => ok(e.command(OP_SET_CURRENT_PATTERN, s, 1., 0., 0.)),
            611 => ok(e.command(OP_PLAY, 3840., 0., 0., 0.)),
            900 => ok(e.command(OP_ADD_SYNTH_TRACK, s, 0., 0., 0.)), // resets all 16 patterns
            901 => ok(e.command(OP_ADD_DRUM_TRACK, d, 0., 0., 0.)),
            _ => {}
        }
        e.process(&mut l, &mut r);
        if b < 600 {
            peak = peak.max(e.telemetry()[5]);
        }
    }

    assert_eq!(disarm(), 0, "pattern switching / copying allocated");
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    assert!(peak > 0.05, "patterns should be audible, peak {peak}");
}

/// Song mode: clips (overlapping, offset, many per track) on a drum and a
/// synth track, loop wraps (including a tiny loop that wraps several times
/// per block), seeks, clip edits / removals / clears while their notes sound,
/// edits of clip-owned notes, mode switches, Stop / Play and track re-adds,
/// all with the counter ARMED.
#[test]
fn song_mode_loops_and_clip_edits_do_not_allocate() {
    let mut e = Engine::new(48000.0);
    let p = e.sample_alloc(0, 4800, 1).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 4800) }
        .iter_mut()
        .enumerate()
        .for_each(|(i, x)| *x = ((i as f32) * 0.05).sin());
    assert_eq!(e.sample_ready(0), 0);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let (d, s) = (0.0, 1.0); // drum slot, synth slot
    let ok = |code: i32| assert_eq!(code, OK);
    let max_notes = daw_engine::MAX_NOTES as f64;
    let max_clips = daw_engine::MAX_CLIPS as f64;
    let addr = |idx: f64| s * max_notes + idx;
    let pv = |pitch: f64, vel: f64| pitch * 128.0 + vel;
    let clip = |slot: f64, idx: f64| slot * max_clips + idx;
    let po = |pattern: f64, offset: f64| offset * 16.0 + pattern;

    arm();

    ok(e.command(OP_ADD_DRUM_TRACK, d, 0., 0., 0.));
    ok(e.command(OP_ADD_SYNTH_TRACK, s, 0., 0., 0.));
    for row in 0..4u32 {
        ok(e.command(OP_SET_ROW_SAMPLE, d, row as f64, 0., 0.));
    }
    for (m, kind) in [MIDI_IN, OSC, ADSR, VCA, LFO, OUT].iter().enumerate() {
        ok(e.command(OP_RACK_ADD_MODULE, s, m as f64, *kind, 0.));
    }
    for ((fm, fp), (tm, tp)) in [((0, 0), (1, 0)), ((0, 1), (2, 0)), ((1, 0), (3, 0)), ((2, 0), (3, 1)), ((3, 0), (5, 0))] {
        ok(e.command(OP_RACK_CONNECT, s, pk(fm, fp), pk(tm, tp), 0.));
    }
    ok(e.command(OP_RACK_SET_PARAM, s, 4., 2., 1.)); // synced LFO (not wired: still runs)
    for pat in 0..3u32 {
        ok(e.command(OP_SET_CURRENT_PATTERN, d, pat as f64, 0., 0.));
        ok(e.command(OP_SET_CURRENT_PATTERN, s, pat as f64, 0., 0.));
        ok(e.command(OP_SET_SWING, d, 0.3 * pat as f64, 0., 0.));
        for step in (pat..16).step_by(2) {
            ok(e.command(OP_SET_STEP, d, (step % 4) as f64, step as f64, 100.));
        }
        ok(e.command(OP_SET_PATTERN_BARS, s, (pat + 1) as f64, 0., 0.));
        for i in 0..48u32 {
            let start = (i * 320 * (pat + 1)) as f64;
            ok(e.command(OP_NOTE_SET, addr(i as f64), pv(40.0 + ((i + pat) % 36) as f64, 100.), start, 2000.));
        }
    }
    // 40 clips per track over 20 bars: 2-bar clips every half bar (four
    // overlap at any time), cycling patterns and offsets.
    for i in 0..40u32 {
        let (start, pat, off) = (i as f64 * 1920.0, (i % 3) as f64, (i % 5) as f64 * 480.0);
        ok(e.command(OP_CLIP_SET, clip(d, i as f64), po(pat, off), start, 7680.));
        ok(e.command(OP_CLIP_SET, clip(s, i as f64), po(pat, off), start, 7680.));
    }
    ok(e.command(OP_SET_TEMPO, 170., 0., 0., 0.));
    ok(e.command(OP_SET_LOOP, 3840., 11520., 0., 0.)); // 2 bars: ~1060 blocks a pass
    ok(e.command(OP_SET_MODE, 1., 0., 0., 0.));
    ok(e.command(OP_SEEK, 1920., 0., 0., 0.));
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));

    let mut peak = 0.0f64;
    for b in 0..4000u32 {
        match b {
            100 => ok(e.command(OP_CLIP_SET, clip(s, 2.), po(1., 0.), 3840., 3840.)), // edit a playing clip
            105 => ok(e.command(OP_CLIP_SET, clip(s, 2.), po(1., 0.), 3840., 7680.)), // lengthen it in place
            110 => ok(e.command(OP_CLIP_SET, clip(d, 2.), po(1., 0.), 3840., 3840.)),
            120 => ok(e.command(OP_CLIP_REMOVE, clip(s, 3.), 0., 0., 0.)),
            130 => ok(e.command(OP_NOTE_SET, addr(5.), pv(70., 90.), 100., 2000.)), // clip-owned notes
            140 => ok(e.command(OP_NOTE_REMOVE, addr(6.), 0., 0., 0.)),
            150 => ok(e.command(OP_SET_SWING, d, 0.8, 0., 0.)),
            160 => ok(e.command(OP_COPY_PATTERN, s, 1., 2., 0.)),
            170 => ok(e.command(OP_SET_PATTERN_BARS, s, 4., 0., 0.)),
            1500 => ok(e.command(OP_SEEK, 9000., 0., 0., 0.)),
            1700 => ok(e.command(OP_SET_MODE, 0., 0., 0., 0.)), // pattern mode, playing
            1720 => ok(e.command(OP_SET_PATTERN_FOCUS, s, 0., 0., 0.)), // only the synth
            1740 => ok(e.command(OP_SET_PATTERN_FOCUS, d, 0., 0., 0.)), // releases its notes
            1760 => ok(e.command(OP_SET_PATTERN_FOCUS, 255., 0., 0., 0.)), // every track again
            1800 => ok(e.command(OP_SET_MODE, 1., 0., 0., 0.)),
            2000 => ok(e.command(OP_SET_LOOP, 4000., 4001., 0., 0.)), // 1 tick: wraps every ~18 frames
            2100 => ok(e.command(OP_SET_LOOP, 0., 3840., 0., 0.)), // behind the playhead: jumps
            2200 => ok(e.command(OP_SET_TEMPO, 97., 0., 0., 0.)),
            2600 => ok(e.command(OP_STOP, 0., 0., 0., 0.)),
            2610 => ok(e.command(OP_CLIP_CLEAR, d, 0., 0., 0.)),
            2620 => ok(e.command(OP_PLAY, 3840., 0., 0., 0.)),
            3000 => ok(e.command(OP_CLIP_CLEAR, s, 0., 0., 0.)), // while sounding
            3100 => ok(e.command(OP_CLIP_SET, clip(s, 255.), po(0., 61439.), 0., 3840.)),
            3500 => ok(e.command(OP_ADD_SYNTH_TRACK, s, 0., 0., 0.)), // clears its clips
            3501 => ok(e.command(OP_ADD_DRUM_TRACK, d, 0., 0., 0.)),
            _ => {}
        }
        e.process(&mut l, &mut r);
        if b < 1500 {
            peak = peak.max(e.telemetry()[5]);
        }
    }

    assert_eq!(disarm(), 0, "song mode allocated");
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    assert!(peak > 0.05, "song should be audible, peak {peak}");
}

/// The mixer: every `OP_MIX_SET` param on every channel it applies to (min,
/// max and default), key changes (rows and tracks, up to all `MAX_KEYS`
/// row slots), solo/mute toggles, channel resets, a key source removed and
/// re-added, all while playing (Pattern and Song mode), with the counter
/// ARMED.
#[test]
fn mixer_commands_do_not_allocate() {
    use daw_engine::mixer::catalog::{PARAMS, P_SOLO, P_SEND_A, P_SEND_B, P_COMP_ON, P_EQ_ON, P_MUTE};
    use daw_engine::{MIX_CHANNELS, MAX_KEYS};
    let mut e = Engine::new(48000.0);
    let p = e.sample_alloc(0, 4800, 1).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 4800) }
        .iter_mut()
        .enumerate()
        .for_each(|(i, x)| *x = ((i as f32) * 0.05).sin() * (1.0 - i as f32 / 4800.0));
    assert_eq!(e.sample_ready(0), 0);
    let ok = |code: i32| assert_eq!(code, OK);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);

    arm();

    // Two drum tracks (8 rows each) and a synth pad with a held note.
    for d in [0.0, 1.0] {
        ok(e.command(OP_ADD_DRUM_TRACK, d, 0., 0., 0.));
        for row in 0..8u32 {
            ok(e.command(OP_SET_ROW_SAMPLE, d, row as f64, 0., 0.));
            for step in (row % 4..16).step_by(4) {
                ok(e.command(OP_SET_STEP, d, row as f64, step as f64, 100.));
            }
        }
    }
    let s = 2.0;
    ok(e.command(OP_ADD_SYNTH_TRACK, s, 0., 0., 0.));
    for (m, kind) in [MIDI_IN, OSC, ADSR, VCA, OUT].iter().enumerate() {
        ok(e.command(OP_RACK_ADD_MODULE, s, m as f64, *kind, 0.));
    }
    for ((fm, fp), (tm, tp)) in [((0, 0), (1, 0)), ((0, 1), (2, 0)), ((1, 0), (3, 0)), ((2, 0), (3, 1)), ((3, 0), (4, 0))] {
        ok(e.command(OP_RACK_CONNECT, s, pk(fm, fp), pk(tm, tp), 0.));
    }
    ok(e.command(OP_SET_INPUT_TRACK, s, 0., 0., 0.));
    ok(e.command(OP_NOTE_ON, 48., 100., 0., 0.));
    for ch in 0..3 {
        ok(e.command(OP_MIX_SET, ch as f64, P_SEND_A as f64, 0., 0.));
        ok(e.command(OP_MIX_SET, ch as f64, P_SEND_B as f64, -6., 0.));
        ok(e.command(OP_MIX_SET, ch as f64, P_EQ_ON as f64, 1., 0.));
        ok(e.command(OP_MIX_SET, ch as f64, P_COMP_ON as f64, 1., 0.));
    }
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));

    // Every param on every channel it applies to: min, max, then default,
    // one channel per block.
    let mut b = 0u32;
    for ch in 0..MIX_CHANNELS {
        for p in PARAMS.iter().filter(|p| p.accepts(ch)) {
            for v in [p.min, p.max, p.default] {
                if p.id == P_MUTE && ch < 3 && v == 1.0 {
                    continue; // keep the sounding tracks audible
                }
                assert_eq!(e.command(OP_MIX_SET, ch as f64, p.id as f64, v as f64, 0.), OK, "ch {ch} {} = {v}", p.name);
            }
        }
        e.process(&mut l, &mut r);
        b += 1;
    }
    for blk in 0..1200u32 {
        match blk {
            // Keys: every row of track 0 keys a strip (all 8 key slots), the
            // pad is keyed by track 1, then by a keyed row.
            10 => {
                for row in 0..MAX_KEYS {
                    ok(e.command(OP_MIX_SET_KEY, (3 + row) as f64, row as f64 + 1.0, 0., 0.));
                }
                ok(e.command(OP_MIX_SET_KEY, s, 32., 0., 0.));
            }
            50 => {
                // A 9th distinct row is refused; a row already keyed shares.
                assert_eq!(e.command(OP_MIX_SET_KEY, s, 32. + 3., 0., 0.), ERR_BAD_VALUE);
                ok(e.command(OP_MIX_SET_KEY, s, 4., 0., 0.));
            }
            60 => ok(e.command(OP_MIX_SET, s, P_SOLO as f64, 1., 0.)),
            90 => ok(e.command(OP_MIX_SET, 0., P_SOLO as f64, 1., 0.)),
            120 => ok(e.command(OP_MIX_SET, s, P_SOLO as f64, 0., 0.)),
            130 => ok(e.command(OP_MIX_SET, 0., P_SOLO as f64, 0., 0.)),
            140 => ok(e.command(OP_MIX_SET, 1., P_MUTE as f64, 1., 0.)),
            150 => ok(e.command(OP_MIX_SET, 1., P_MUTE as f64, 0., 0.)),
            200 => ok(e.command(OP_REMOVE_TRACK, 0., 0., 0., 0.)), // 8 keys fall back
            210 => ok(e.command(OP_ADD_DRUM_TRACK, 0., 0., 0., 0.)),
            220 => ok(e.command(OP_SET_ROW_SAMPLE, 0., 0., 0., 0.)),
            221 => ok(e.command(OP_SET_STEP, 0., 0., 0., 120.)),
            230 => ok(e.command(OP_MIX_SET_KEY, s, 1., 0., 0.)),
            300 => ok(e.command(OP_ADD_SYNTH_TRACK, 1., 0., 0., 0.)), // retype a key source
            400 => ok(e.command(OP_SET_MASTER_GAIN, 1.5, 0., 0., 0.)),
            450 => {
                for ch in 0..MIX_CHANNELS {
                    ok(e.command(OP_MIX_RESET, ch as f64, 0., 0., 0.));
                }
            }
            500 => ok(e.command(OP_SET_MODE, 1., 0., 0., 0.)), // Song mode, no clips: tails only
            600 => ok(e.command(OP_STOP, 0., 0., 0., 0.)),
            700 => ok(e.command(OP_PLAY, 0., 0., 0., 0.)),
            800 => ok(e.command(OP_SET_TEMPO, 77., 0., 0., 0.)),
            _ => {}
        }
        e.process(&mut l, &mut r);
        b += 1;
    }

    assert_eq!(disarm(), 0, "mixer path allocated ({b} blocks)");
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    assert!(e.meters().iter().all(|x| x.is_finite()));
}

/// `OP_RETURN_KIND` (plan 29) allocates nothing: slots 2..7 are added,
/// retyped (Reverb <-> Delay, including mid-fade) and deleted (Off) while a
/// held synth note feeds all 8 sends, so the 5 ms fades, the sleeping and
/// the `reset_dsp` memsets at fade end all run with the counter ARMED.
#[test]
fn return_kind_does_not_allocate() {
    use daw_engine::mixer::catalog::{send_id, P_FADER};
    const MIDI_IN: f64 = 0.0;
    const OSC: f64 = 1.0;
    const ADSR: f64 = 4.0;
    const VCA: f64 = 5.0;
    const OUT: f64 = 8.0;
    let mut e = Engine::new(48000.0);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let ok = |code: i32| assert_eq!(code, OK);

    arm();

    ok(e.command(OP_ADD_SYNTH_TRACK, 0., 0., 0., 0.));
    for (m, kind) in [MIDI_IN, OSC, ADSR, VCA, OUT].iter().enumerate() {
        ok(e.command(OP_RACK_ADD_MODULE, 0., m as f64, *kind, 0.));
    }
    for ((fm, fp), (tm, tp)) in [((0, 0), (1, 0)), ((0, 1), (2, 0)), ((1, 0), (3, 0)), ((2, 0), (3, 1)), ((3, 0), (4, 0))] {
        ok(e.command(OP_RACK_CONNECT, 0., pk(fm, fp), pk(tm, tp), 0.));
    }
    ok(e.command(OP_SET_INPUT_TRACK, 0., 0., 0., 0.));
    ok(e.command(OP_MIX_SET, 0., P_FADER as f64, -6., 0.));
    for slot in 0..8 {
        ok(e.command(OP_MIX_SET, 0., send_id(slot) as f64, -6., 0.));
    }
    ok(e.command(OP_NOTE_ON, 48., 100., 0., 0.));
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));
    let mut peak = 0.0f64;
    let mut run = |e: &mut Engine, n: usize| {
        for _ in 0..n {
            e.process(&mut l, &mut r);
            peak = peak.max(e.telemetry()[5]);
        }
    };
    run(&mut e, 50);
    // Add slots 2..7 (Reverb on even slots, Delay on odd), let them ring.
    for slot in 2..8 {
        ok(e.command(OP_RETURN_KIND, slot as f64, if slot % 2 == 0 { 1. } else { 2. }, 0., 0.));
    }
    run(&mut e, 100);
    // Retype all of them (the fade starts, then ends in `reset_dsp`), and
    // once more mid-fade (one block in, i.e. inside the 5 ms).
    for slot in 2..8 {
        ok(e.command(OP_RETURN_KIND, slot as f64, if slot % 2 == 0 { 2. } else { 1. }, 0., 0.));
    }
    run(&mut e, 1);
    for slot in 2..8 {
        ok(e.command(OP_RETURN_KIND, slot as f64, if slot % 2 == 0 { 1. } else { 2. }, 0., 0.));
    }
    run(&mut e, 100);
    // Delete them (Off) while they ring, and re-add one on a silent slot.
    for slot in 2..8 {
        ok(e.command(OP_RETURN_KIND, slot as f64, 0., 0., 0.));
    }
    run(&mut e, 100);
    ok(e.command(OP_RETURN_KIND, 5., 1., 0., 0.));
    ok(e.command(OP_NOTE_OFF, 48., 0., 0., 0.));
    run(&mut e, 400);
    // Slots 0 and 1 too, then back to the default layout.
    ok(e.command(OP_RETURN_KIND, 0., 2., 0., 0.));
    ok(e.command(OP_RETURN_KIND, 1., 1., 0., 0.));
    run(&mut e, 100);

    assert_eq!(disarm(), 0, "RETURN_KIND allocated");
    assert!(peak > 0.0 && peak.is_finite(), "must have sounded (peak {peak})");
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
}

/// `OP_RESET_ALL` (project load) on a busy engine allocates nothing: tracks,
/// racks with pooled effects and a Sample Player, a grown sample arena (the
/// reset only frees its extra chunk), the mixer and the output fade. A
/// Sample Player playing a sample also renders allocation-free, looping
/// (loopStart partway, so the seam crossfade and the wrap run while armed)
/// and through its release window after the note-off.
#[test]
fn reset_all_does_not_allocate() {
    const SAMPLE_PLAYER: f64 = 16.0;
    const DELAY: f64 = 9.0;
    const REVERB: f64 = 10.0;
    let mut e = Engine::new(48000.0);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let ok = |code: i32| assert_eq!(code, OK);
    // Outside the counted region: a sample, and one more that grows the arena.
    let p = e.sample_alloc(0, 48000, 1).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 48000) }.fill(0.5);
    ok(e.sample_ready(0));
    ok(e.sample_alloc(1, 20_000_000, 2).map(|_| OK).unwrap_or_else(|c| c));
    ok(e.sample_ready(1));

    arm();

    ok(e.command(OP_ADD_DRUM_TRACK, 0., 0., 0., 0.));
    ok(e.command(OP_SET_ROW_SAMPLE, 0., 0., 0., 0.));
    ok(e.command(OP_SET_STEP, 0., 0., 0., 127.));
    ok(e.command(OP_ADD_SYNTH_TRACK, 1., 0., 0., 0.));
    for (m, kind) in [MIDI_IN, SAMPLE_PLAYER, DELAY, REVERB, OUT].iter().enumerate() {
        ok(e.command(OP_RACK_ADD_MODULE, 1., m as f64, *kind, 0.));
    }
    ok(e.command(OP_RACK_SET_PARAM, 1., 1., 0., 0.)); // sample 0
    // Loop [0.1, 0.2) of the 1 s sample: the seam (at 0.2 s minus 10 ms)
    // first runs after ~9100 frames, inside the 100 blocks below.
    ok(e.command(OP_RACK_SET_PARAM, 1., 1., 5., 0.2)); // end
    ok(e.command(OP_RACK_SET_PARAM, 1., 1., 6., 1.)); // loop on
    ok(e.command(OP_RACK_SET_PARAM, 1., 1., 7., 0.1)); // loopStart
    for ((fm, fp), (tm, tp)) in [((0, 0), (1, 0)), ((0, 1), (1, 1)), ((1, 0), (2, 0)), ((2, 0), (3, 0)), ((3, 0), (4, 0))] {
        ok(e.command(OP_RACK_CONNECT, 1., pk(fm, fp), pk(tm, tp), 0.));
    }
    ok(e.command(OP_SET_INPUT_TRACK, 1., 0., 0., 0.));
    ok(e.command(OP_NOTE_ON, 60., 100., 0., 0.));
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));
    let mut peak = 0.0f64;
    for b in 0..160 {
        if b == 100 {
            ok(e.command(OP_NOTE_OFF, 60., 0., 0., 0.)); // the release window: still looping
        }
        e.process(&mut l, &mut r);
        peak = peak.max(e.telemetry()[5]);
    }
    ok(e.command(OP_STOP, 0., 0., 0., 0.));
    ok(e.command(OP_RESET_ALL, 0., 0., 0., 0.));
    for _ in 0..50 {
        e.process(&mut l, &mut r);
    }

    assert_eq!(disarm(), 0, "reset allocated");
    assert!(peak > 0.05, "sounded before the reset, peak {peak}");
    assert!(l.iter().chain(r.iter()).all(|&x| x == 0.0), "silent after the reset");
}

/// Live drum hits (plan 15): MIDI notes on a drum input track queue row hits
/// into a fixed per-track buffer and trigger through the step-hit path, while
/// stopped and while playing, across input switches, mutes and track
/// removal, all with the counter ARMED.
#[test]
fn live_drum_no_alloc() {
    let mut e = Engine::new(48000.0);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let ok = |code: i32| assert_eq!(code, OK);
    let p = e.sample_alloc(0, 4800, 1).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 4800) }.fill(0.5);
    ok(e.sample_ready(0));

    arm();

    ok(e.command(OP_ADD_DRUM_TRACK, 2., 0., 0., 0.));
    for row in 0..16u32 {
        ok(e.command(OP_SET_ROW_SAMPLE, 2., row as f64, 0., 0.));
    }
    ok(e.command(OP_SET_STEP, 2., 0., 0., 100.));
    ok(e.command(OP_SET_INPUT_TRACK, 2., 0., 0., 0.));
    let mut peak = 0.0f64;
    for b in 0..400u32 {
        match b {
            100 => ok(e.command(OP_PLAY, 0., 0., 0., 0.)),
            150 => ok(e.command(OP_SET_ROW_MUTE, 2., 3., 1., 0.)),
            200 => ok(e.command(OP_SET_INPUT_TRACK, -1., 0., 0., 0.)),
            210 => ok(e.command(OP_SET_INPUT_TRACK, 2., 0., 0., 0.)),
            300 => ok(e.command(OP_STOP, 0., 0., 0., 0.)),
            380 => ok(e.command(OP_REMOVE_TRACK, 2., 0., 0., 0.)),
            _ => {}
        }
        // Every block: a hit on one row, plus several on one block to fill
        // the queue (every row, twice) every 25th block.
        ok(e.command(OP_NOTE_ON, 36. + (b % 20) as f64, 100., 0., 0.));
        ok(e.command(OP_NOTE_OFF, 36. + (b % 20) as f64, 0., 0., 0.));
        if b % 25 == 0 {
            for n in 0..40u32 {
                ok(e.command(OP_NOTE_ON, 36. + (n % 16) as f64, 127., 0., 0.));
            }
        }
        e.process(&mut l, &mut r);
        if b < 100 {
            peak = peak.max(e.telemetry()[5]);
        }
    }

    assert_eq!(disarm(), 0, "live drum hits allocated");
    assert!(peak > 0.05, "live hits sounded while stopped, peak {peak}");
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
}

/// Audio tracks (plan 9): every new op (`ADD_AUDIO_TRACK`, the staged
/// `AUDIO_CLIP_SOURCE` / `AUDIO_CLIP_GAIN` and the committing
/// `AUDIO_CLIP_SET`), playback of loop and one-shot clips (mono and stereo),
/// chases (Play, seek, loop wraps, mode switches, a source edit, a sample
/// replaced in place and readied late), gain ramps, resizes, removal,
/// `CLIP_CLEAR`, kind swaps over an Audio slot and Stop, all with the
/// counter ARMED.
#[test]
fn audio_tracks_and_clip_edits_do_not_allocate() {
    let mut e = Engine::new(48000.0);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let ok = |code: i32| assert_eq!(code, OK);
    let max_clips = daw_engine::MAX_CLIPS as f64;
    let a = |slot: f64, idx: f64| slot * max_clips + idx;
    // Outside the counted region: a stereo and a mono sample.
    let p = e.sample_alloc(0, 96000, 2).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 192000) }
        .iter_mut()
        .enumerate()
        .for_each(|(i, x)| *x = ((i as f32) * 0.01).sin() * 0.5);
    ok(e.sample_ready(0));
    let p = e.sample_alloc(1, 4800, 1).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 4800) }.fill(0.3);
    ok(e.sample_ready(1));

    arm();

    let clip = |e: &mut Engine, slot: f64, idx: f64, sample: f64, off: f64, lp: f64, gain: f64, start: f64, len: f64| {
        ok(e.command(OP_AUDIO_CLIP_SOURCE, a(slot, idx), sample, off, lp));
        ok(e.command(OP_AUDIO_CLIP_GAIN, a(slot, idx), gain, 480., 480.));
        ok(e.command(OP_AUDIO_CLIP_SET, a(slot, idx), start, len, 0.));
    };
    ok(e.command(OP_ADD_AUDIO_TRACK, 0., 0., 0., 0.));
    ok(e.command(OP_ADD_AUDIO_TRACK, 1., 0., 0., 0.));
    // 40 overlapping clips per track over 20 bars, loop and one-shot.
    for i in 0..40u32 {
        let (start, lp) = (i as f64 * 1920.0, (i % 2) as f64);
        clip(&mut e, 0., i as f64, 0., (i % 3) as f64 * 0.1, lp, 0.8, start, 7680.);
        clip(&mut e, 1., i as f64, 1., 0., lp, 1.5, start, 7680.);
    }
    clip(&mut e, 1., 255., 7., 0., 0., 1., 0., 3840. * 20.); // sample 7: loaded late
    ok(e.command(OP_MIX_SET_KEY, 0., 32., 0., 0.)); // track 0 keyed by audio track 1
    ok(e.command(OP_SET_TEMPO, 170., 0., 0., 0.));
    ok(e.command(OP_SET_LOOP, 3840., 11520., 0., 0.));
    ok(e.command(OP_SET_MODE, 1., 0., 0., 0.));
    ok(e.command(OP_SEEK, 1920., 0., 0., 0.));
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));

    let mut peak = 0.0f64;
    for b in 0..4000u32 {
        match b {
            100 => clip(&mut e, 0., 2., 0., 0., 0., 0.4, 3840., 3840.), // gain + length
            105 => clip(&mut e, 0., 2., 0., 0., 0., 0.4, 3840., 7680.), // lengthen in place
            110 => clip(&mut e, 0., 3., 0., 0.25, 1., 0.8, 3840., 7680.), // new offset: chase
            120 => ok(e.command(OP_CLIP_REMOVE, a(0., 4.), 0., 0., 0.)),
            130 => {
                // Replace sample 1 in place (fits the arena) and ready it later.
                e.sample_alloc(1, 4800, 1).unwrap();
            }
            140 => ok(e.sample_ready(1)),
            150 => {
                let p = e.sample_alloc(7, 48000, 2).unwrap();
                unsafe { std::slice::from_raw_parts_mut(p, 96000) }.fill(0.1);
                ok(e.sample_ready(7));
            }
            1500 => ok(e.command(OP_SEEK, 9000., 0., 0., 0.)),
            1700 => ok(e.command(OP_SET_MODE, 0., 0., 0., 0.)),
            1800 => ok(e.command(OP_SET_MODE, 1., 0., 0., 0.)),
            2000 => ok(e.command(OP_SET_LOOP, 4000., 4001., 0., 0.)), // wraps every ~18 frames
            2100 => ok(e.command(OP_SET_LOOP, 0., 3840., 0., 0.)), // behind the playhead
            2200 => ok(e.command(OP_SET_TEMPO, 97., 0., 0., 0.)),
            2600 => ok(e.command(OP_STOP, 0., 0., 0., 0.)),
            2610 => ok(e.command(OP_CLIP_CLEAR, 0., 0., 0., 0.)),
            2620 => ok(e.command(OP_PLAY, 0., 0., 0., 0.)),
            3000 => ok(e.command(OP_CLIP_CLEAR, 1., 0., 0., 0.)), // while sounding
            3100 => clip(&mut e, 0., 255., 0., 1.9, 1., 4., 0., 3840.),
            3500 => ok(e.command(OP_ADD_DRUM_TRACK, 0., 0., 0., 0.)), // over an Audio slot
            3501 => ok(e.command(OP_ADD_AUDIO_TRACK, 0., 0., 0., 0.)), // back again
            3600 => ok(e.command(OP_REMOVE_TRACK, 1., 0., 0., 0.)),
            _ => {}
        }
        e.process(&mut l, &mut r);
        if b < 1500 {
            peak = peak.max(e.telemetry()[5]);
        }
    }

    assert_eq!(disarm(), 0, "audio tracks allocated");
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    assert!(peak > 0.05, "audio clips should be audible, peak {peak}");
}

/// Every automation op at the caps (64 lanes x 512 points), with playback,
/// overrides, point edits under the playhead, loop wraps (a 1-tick loop
/// too), seeks, mode switches, re-targeting and every target removal, next
/// to Audio, drum and synth tracks.
#[test]
fn automation_does_not_allocate() {
    use daw_engine::mixer::catalog::{param, P_EQ_MID_FREQ, P_FADER, P_LIMITER_CEILING, P_PAN, P_REV_DECAY, P_SEND_A, P_SEND_B};
    use daw_engine::rack::catalog::{spec, ModuleKind as K};
    let mut e = Engine::new(48000.0);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let ok = |code: i32| assert_eq!(code, OK);
    let (lanes, pts) = (daw_engine::MAX_AUTO_LANES, daw_engine::MAX_AUTO_POINTS);
    let max_clips = daw_engine::MAX_CLIPS as f64;
    // Outside the counted region: a stereo sample for the Audio and drum tracks.
    let p = e.sample_alloc(0, 96000, 2).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 192000) }
        .iter_mut()
        .enumerate()
        .for_each(|(i, x)| *x = ((i as f32) * 0.01).sin() * 0.5);
    ok(e.sample_ready(0));

    arm();

    // Synth tracks 0 and 1: Noise -> Filter -> VCA (<- ADSR) -> Out, plus an
    // Osc and an LFO, so 16 non-integer params each are automatable.
    const RACK: [K; 7] = [K::Noise, K::Filter, K::Osc, K::Adsr, K::Lfo, K::Vca, K::Out];
    for slot in 0..2 {
        let s = slot as f64;
        ok(e.command(OP_ADD_SYNTH_TRACK, s, 0., 0., 0.));
        for (m, &kind) in RACK.iter().enumerate() {
            ok(e.command(OP_RACK_ADD_MODULE, s, m as f64, kind as u32 as f64, 0.));
        }
        for (from, to) in [(pk(0, 0), pk(1, 0)), (pk(1, 0), pk(5, 0)), (pk(5, 0), pk(6, 0)), (pk(2, 0), pk(6, 1))] {
            ok(e.command(OP_RACK_CONNECT, s, from, to, 0.));
        }
    }
    // Audio tracks 2 and 3, drum tracks 4 and 5.
    for slot in 2..4 {
        let a = slot as f64 * max_clips;
        ok(e.command(OP_ADD_AUDIO_TRACK, slot as f64, 0., 0., 0.));
        ok(e.command(OP_AUDIO_CLIP_SOURCE, a, 0., 0.1, 1.));
        ok(e.command(OP_AUDIO_CLIP_GAIN, a, 0.8, 240., 240.));
        ok(e.command(OP_AUDIO_CLIP_SET, a, 0., 3840. * 8., 0.));
    }
    for slot in 4..6 {
        let s = slot as f64;
        ok(e.command(OP_ADD_DRUM_TRACK, s, 0., 0., 0.));
        ok(e.command(OP_SET_ROW_SAMPLE, s, 0., 0., 0.));
        for step in (0..16).step_by(4) {
            ok(e.command(OP_SET_STEP, s, 0., step as f64, 100.));
        }
    }

    // 64 targets (kind, c, d, min, max) in a fixed array: 32 mixer params
    // (6 channels x 5, the Reverb decay, the master ceiling), then 16 rack
    // params on each synth track.
    let mut targets = [(0.0f64, 0.0f64, 0.0f64, 0.0f32, 0.0f32); 64];
    let mut n = 0;
    for ch in 0..6usize {
        for id in [P_FADER, P_PAN, P_SEND_A, P_SEND_B, P_EQ_MID_FREQ] {
            let p = param(id).unwrap();
            targets[n] = (1.0, ch as f64, id as f64, p.min, p.max);
            n += 1;
        }
    }
    for (ch, id) in [(daw_engine::MIX_RETURN0, P_REV_DECAY), (daw_engine::MIX_MASTER, P_LIMITER_CEILING)] {
        let p = param(id).unwrap();
        targets[n] = (1.0, ch as f64, id as f64, p.min, p.max);
        n += 1;
    }
    for slot in 0..2 {
        let mut per = 0;
        for (m, &kind) in RACK.iter().enumerate() {
            for (pi, p) in spec(kind).params.iter().enumerate() {
                if !p.integer && per < 16 {
                    targets[n] = (2.0, slot as f64, (m * 16 + pi) as f64, p.min, p.max);
                    n += 1;
                    per += 1;
                }
            }
        }
    }
    assert_eq!(n, lanes);
    let fill = |e: &mut Engine, lane: usize| {
        let (kind, c, d, min, max) = targets[lane];
        ok(e.command(OP_AUTO_LANE_SET, lane as f64, kind, c, d));
        for i in 0..pts {
            let v = min + (max - min) * (i % 7) as f32 / 6.0;
            let a = (lane * pts + i) as f64;
            ok(e.command(OP_AUTO_POINT_SET, a, (i * 16) as f64, v as f64, (i % 3 == 0) as u8 as f64));
        }
    };
    for lane in 0..lanes {
        fill(&mut e, lane);
    }
    ok(e.command(OP_SET_INPUT_TRACK, 0., 0., 0., 0.));
    ok(e.command(OP_SET_LOOP, 0., 7680., 0., 0.));
    ok(e.command(OP_SET_MODE, 1., 0., 0., 0.));
    for _ in 0..20 {
        e.process(&mut l, &mut r); // stopped: lanes follow the parked position
    }
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));

    let mut peak = 0.0f64;
    for b in 0..1700u32 {
        match b {
            100 => ok(e.command(OP_SEEK, 3000., 0., 0., 0.)),
            200 => {
                for lane in 0..8 {
                    ok(e.command(OP_AUTO_OVERRIDE, lane as f64, 0., 0., 0.));
                }
                ok(e.command(OP_MIX_SET, 0., P_FADER as f64, -3., 0.));
                ok(e.command(OP_RACK_SET_PARAM, 0., 1., 1., 500.));
            }
            300 => {
                ok(e.command(OP_AUTO_POINT_SET, (pts + 5) as f64, 80., 0.5, 0.)); // lane 1 (pan), point 5
                ok(e.command(OP_AUTO_POINT_REMOVE, (2 * pts + 100) as f64, 0., 0., 0.));
                ok(e.command(OP_AUTO_POINT_SET, (2 * pts + 100) as f64, 1601., -20., 1.));
                for i in 0..pts {
                    ok(e.command(OP_AUTO_POINT_CURVE, (3 * pts + i) as f64, (i % 9) as f64 / 4.0 - 1.0, 0., 0.)); // lane 3, every point
                }
            }
            400 => {
                for lane in 10..20 {
                    ok(e.command(OP_AUTO_LANE_ENABLE, lane as f64, 0., 0., 0.));
                }
            }
            450 => {
                for lane in 10..20 {
                    ok(e.command(OP_AUTO_LANE_ENABLE, lane as f64, 1., 0., 0.));
                }
            }
            500 => ok(e.command(OP_SET_MODE, 0., 0., 0., 0.)),
            550 => ok(e.command(OP_SET_MODE, 1., 0., 0., 0.)),
            600 => ok(e.command(OP_AUTO_LANE_CLEAR, 3., 0., 0., 0.)),
            610 => fill(&mut e, 3),
            700 => ok(e.command(OP_AUTO_LANE_SET, 4., 0., 0., 0.)), // no target
            710 => ok(e.command(OP_AUTO_LANE_SET, 4., 1., 0., P_EQ_MID_FREQ as f64)), // back
            800 => ok(e.command(OP_SET_LOOP, 4000., 4001., 0., 0.)), // wraps every ~20 frames
            900 => ok(e.command(OP_SET_LOOP, 0., 7680., 0., 0.)),
            1000 => ok(e.command(OP_RACK_REMOVE_MODULE, 0., 1., 0., 0.)), // queued behind the fade
            1100 => ok(e.command(OP_RACK_CLEAR, 1., 0., 0., 0.)),
            1200 => ok(e.command(OP_REMOVE_TRACK, 2., 0., 0., 0.)),
            1300 => ok(e.command(OP_ADD_AUDIO_TRACK, 0., 0., 0., 0.)),
            1400 => ok(e.command(OP_STOP, 0., 0., 0., 0.)),
            1410 => ok(e.command(OP_SEEK, 5000., 0., 0., 0.)),
            1420 => ok(e.command(OP_AUTO_OVERRIDE, 30., 0., 0., 0.)),
            1430 => ok(e.command(OP_PLAY, 0., 0., 0., 0.)),
            1600 => {
                ok(e.command(OP_STOP, 0., 0., 0., 0.));
                ok(e.command(OP_RESET_ALL, 0., 0., 0., 0.));
            }
            _ => {}
        }
        e.process(&mut l, &mut r);
        if b < 500 {
            peak = peak.max(e.telemetry()[5]);
        }
    }

    assert_eq!(disarm(), 0, "automation allocated");
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
    assert!(peak > 0.01, "the tracks should be audible, peak {peak}");
}

/// The House patches (plan 11): every patch's load replayed over the previous
/// one on a sounding track, its phrase played and released, all ARMED. Two
/// passes, so every patch (even a single one) also replaces itself.
#[test]
fn house_patches_do_not_allocate() {
    let patches = common::house_patches(); // parsed before arming
    assert!(!patches.is_empty());
    let mut e = Engine::new(48000.0);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let ok = |code: i32, what: &str| assert_eq!(code, OK, "{what}");
    let mut render = |e: &mut Engine, blocks: usize| {
        let mut peak = 0.0f32;
        for _ in 0..blocks {
            e.process(&mut l, &mut r);
            peak = l.iter().chain(r.iter()).fold(peak, |m, x| m.max(x.abs()));
        }
        assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
        peak
    };

    let mut queued_loads = 0;
    arm();

    for p in patches.iter().chain(patches.iter()) {
        // A note from the previous patch is sounding while this one loads.
        ok(e.command(OP_NOTE_ON, 67., 100., 0., 0.), "held note");
        render(&mut e, 20);
        for c in &p.cmds {
            ok(e.command(c[0] as u32, c[1], c[2], c[3], c[4]), &p.name);
        }
        // The load was queued behind the sounding note's declick fade
        // (2 ms, under one block): one block applies it, which the queue
        // check confirms. A note sent before then would reach the old rack
        // and be lost with it, so "audible" below would measure the previous
        // patch's tail (plan 28: Formant Pad after Warm Pad, both slow
        // swells, read 0.006 that way).
        queued_loads += usize::from(e.rack_edits_queued(0) > 0);
        render(&mut e, 1);
        assert_eq!(e.rack_edits_queued(0), 0, "{}: the load is still queued after a block", p.name);
        ok(e.command(OP_NOTE_OFF, 67., 0., 0., 0.), "held note off");
        let mut peak = 0.0f32;
        for notes in p.phrase.steps() {
            for &n in *notes {
                ok(e.command(OP_NOTE_ON, n as f64, 100., 0., 0.), &p.name);
            }
            peak = peak.max(render(&mut e, 100));
            for &n in *notes {
                ok(e.command(OP_NOTE_OFF, n as f64, 0., 0., 0.), &p.name);
            }
        }
        render(&mut e, 100); // the release
        assert!(peak > 0.01, "{} should be audible, peak {peak}", p.name);
    }

    assert_eq!(disarm(), 0, "house patch loads and playback allocated");
    // The loads really were made while sounding (queued behind the fade).
    assert!(queued_loads > 0, "no load was queued: the declick path was not exercised");
}

/// Plan 12: the visual data path. The strip tap switched across track,
/// return and off while playing, and voice activity through a chord on a
/// poly patch and its release, all with the counter ARMED.
#[test]
fn vis_path_does_not_allocate() {
    let mut e = Engine::new(48000.0);
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let ok = |code: i32| assert_eq!(code, OK);
    let s = 1.0;
    ok(e.command(OP_ADD_SYNTH_TRACK, s, 0., 0., 0.));
    for (m, kind) in [MIDI_IN, OSC, ADSR, VCA, OUT].iter().enumerate() {
        ok(e.command(OP_RACK_ADD_MODULE, s, m as f64, *kind, 0.));
    }
    for ((fm, fp), (tm, tp)) in [((0, 0), (1, 0)), ((0, 1), (2, 0)), ((1, 0), (3, 0)), ((2, 0), (3, 1)), ((3, 0), (4, 0))] {
        ok(e.command(OP_RACK_CONNECT, s, pk(fm, fp), pk(tm, tp), 0.));
    }
    ok(e.command(OP_SET_INPUT_TRACK, s, 0., 0., 0.));
    for _ in 0..4 {
        e.process(&mut l, &mut r); // warm up outside the counted region
    }

    arm();
    ok(e.command(OP_PLAY, 0., 0., 0., 0.));
    for b in 0..300u32 {
        match b {
            10 => ok(e.command(OP_VIS_TAP, s, 0., 0., 0.)),
            20 => {
                for n in [60.0, 64.0, 67.0, 71.0] {
                    ok(e.command(OP_NOTE_ON, n, 100., 0., 0.));
                }
            }
            60 => ok(e.command(OP_VIS_TAP, 32., 0., 0., 0.)),
            100 => {
                for n in [60.0, 64.0, 67.0, 71.0] {
                    ok(e.command(OP_NOTE_OFF, n, 0., 0., 0.));
                }
            }
            120 => ok(e.command(OP_VIS_TAP, -1., 0., 0., 0.)),
            150 => ok(e.command(OP_VIS_TAP, 0., 0., 0., 0.)),
            200 => ok(e.command(OP_STOP, 0., 0., 0., 0.)),
            _ => {}
        }
        e.process(&mut l, &mut r);
    }
    assert_eq!(disarm(), 0, "vis path allocated");
    assert!(e.vis().voices.iter().all(|x| x.is_finite()));
}
