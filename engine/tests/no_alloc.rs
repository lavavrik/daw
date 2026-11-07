//! Steady-state playback must never touch the heap. A counting global
//! allocator (armed and counted per thread, so tests running in parallel and
//! the harness's own threads don't pollute each other's counts) wraps the
//! system allocator.

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
                if p.id == P_MUTE as u32 && ch < 3 && v == 1.0 {
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
