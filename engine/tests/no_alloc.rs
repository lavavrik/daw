//! Steady-state playback must never touch the heap. A counting global
//! allocator (armed per-thread, so the test harness's own threads don't
//! pollute the count) wraps the system allocator.

use daw_engine::protocol::*;
use daw_engine::Engine;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};

static ALLOCS: AtomicUsize = AtomicUsize::new(0);
thread_local! { static ARMED: Cell<bool> = const { Cell::new(false) }; }

struct Counting;
fn note() {
    if ARMED.with(|a| a.get()) {
        ALLOCS.fetch_add(1, Ordering::SeqCst);
    }
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

    ARMED.with(|a| a.set(true));
    ALLOCS.store(0, Ordering::SeqCst);

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
    for n in [60.0, 64.0, 67.0, 71.0] {
        e.command(OP_NOTE_ON, n, 100., 0., 0.);
    }
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

    ARMED.with(|a| a.set(false));
    assert_eq!(ALLOCS.load(Ordering::SeqCst), 0, "audio path allocated");
    assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()));
}
