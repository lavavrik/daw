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
