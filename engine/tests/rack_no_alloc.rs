//! Rack edits and rendering must never touch the heap after `Rack::new`
//! (structural edits happen on the audio thread). Same counting-allocator
//! pattern as `no_alloc.rs`, armed per-thread.

use daw_engine::protocol::OK;
use daw_engine::rack::catalog::ModuleKind;
use daw_engine::rack::modules::{Ctx, NoteEvent};
use daw_engine::rack::Rack;
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
fn rack_edits_and_render_do_not_allocate() {
    let mut r = Rack::new(48000.0);
    let (mut l, mut rr) = ([0.0f32; 128], [0.0f32; 128]);
    let mut ctx = Ctx { sr: 48000.0, bpm: 124.0, playing: true, ticks: 0.0, ticks_per_frame: 124.0 * 960.0 / 60.0 / 48000.0 };

    ARMED.with(|a| a.set(true));
    ALLOCS.store(0, Ordering::SeqCst);

    // Immediate edits (silent rack).
    assert_eq!(r.add_module(0, ModuleKind::Lfo), OK);
    assert_eq!(r.add_module(1, ModuleKind::Vca), OK);
    assert_eq!(r.add_module(2, ModuleKind::Out), OK);
    assert_eq!(r.add_module(3, ModuleKind::Lfo), OK);
    assert_eq!(r.connect((0, 0), (1, 0)), OK);
    assert_eq!(r.connect((1, 0), (2, 0)), OK);
    assert_eq!(r.set_param(0, 1, 7.0), OK);
    assert_eq!(r.set_param(3, 2, 1.0), OK); // synced
    let mut render = |r: &mut Rack, blocks: usize, ctx: &mut Ctx| {
        for _ in 0..blocks {
            r.render_add(ctx, &mut l, &mut rr);
            ctx.ticks += 128.0 * ctx.ticks_per_frame;
        }
    };
    render(&mut r, 20, &mut ctx);
    assert!(r.is_sounding());

    // Queued (declicked) edits, a feedback loop, params, notes.
    assert_eq!(r.connect((3, 0), (1, 1)), OK);
    assert_eq!(r.connect((1, 0), (1, 1)), OK);
    assert_eq!(r.set_param(1, 0, 0.5), OK);
    r.note(NoteEvent::On { note: 60, vel: 100 });
    render(&mut r, 10, &mut ctx);
    assert_eq!(r.disconnect((1, 1)), OK);
    assert_eq!(r.remove_module(3), OK);
    assert_eq!(r.add_module(3, ModuleKind::Vca), OK);
    render(&mut r, 10, &mut ctx);
    // Overflow the 64-entry queue.
    for i in 0..80 {
        let code = if i % 2 == 0 { r.connect((0, 0), (3, 0)) } else { r.disconnect((3, 0)) };
        assert_eq!(code, OK);
    }
    render(&mut r, 10, &mut ctx);
    r.clear();
    render(&mut r, 30, &mut ctx);
    assert!(!r.is_sounding());

    // Immediate path on a silent rack: add, connect (+ no-op re-connect),
    // no-op disconnect, real disconnect, remove, clear.
    assert_eq!(r.add_module(4, ModuleKind::Lfo), OK);
    assert_eq!(r.add_module(5, ModuleKind::Vca), OK);
    assert_eq!(r.add_module(6, ModuleKind::Out), OK);
    assert_eq!(r.connect((4, 0), (5, 0)), OK);
    assert_eq!(r.connect((4, 0), (5, 0)), OK); // no-op
    assert_eq!(r.disconnect((5, 1)), OK); // no-op (unconnected)
    assert_eq!(r.connect((5, 0), (6, 0)), OK);
    assert_eq!(r.disconnect((6, 0)), OK);
    assert_eq!(r.remove_module(5), OK);
    assert_eq!(r.set_param(4, 0, 2.0), OK);
    render(&mut r, 5, &mut ctx);
    assert!(!r.is_sounding());
    r.clear();
    render(&mut r, 5, &mut ctx);

    // MIDI In + ADSR: note-on/off, steal, sustain, mode/voices switches.
    assert_eq!(r.add_module(7, ModuleKind::MidiIn), OK);
    assert_eq!(r.add_module(8, ModuleKind::Adsr), OK);
    assert_eq!(r.add_module(9, ModuleKind::Vca), OK);
    assert_eq!(r.add_module(10, ModuleKind::Out), OK);
    assert_eq!(r.connect((7, 1), (8, 0)), OK);
    assert_eq!(r.connect((8, 0), (9, 1)), OK);
    assert_eq!(r.connect((9, 0), (10, 0)), OK);
    assert_eq!(r.set_param(7, 0, 2.0), OK); // 2 voices: easy to steal
    render(&mut r, 5, &mut ctx);
    for (n, v) in [(60u8, 100u8), (64, 90), (67, 80)] {
        r.note(NoteEvent::On { note: n, vel: v }); // third note steals
        render(&mut r, 3, &mut ctx);
    }
    r.note(NoteEvent::On { note: 64, vel: 90 }); // re-press
    r.note(NoteEvent::Bend(0.5));
    r.note(NoteEvent::Mod(0.7));
    render(&mut r, 3, &mut ctx);
    r.note(NoteEvent::Sustain(true));
    r.note(NoteEvent::Off { note: 64 });
    render(&mut r, 3, &mut ctx);
    r.note(NoteEvent::Sustain(false));
    r.note(NoteEvent::Off { note: 67 });
    render(&mut r, 3, &mut ctx);
    assert_eq!(r.set_param(7, 1, 1.0), OK); // mono + glide
    assert_eq!(r.set_param(7, 2, 0.1), OK);
    r.note(NoteEvent::On { note: 48, vel: 100 });
    r.note(NoteEvent::On { note: 55, vel: 100 });
    render(&mut r, 5, &mut ctx);
    r.note(NoteEvent::Off { note: 55 });
    r.note(NoteEvent::AllOff);
    assert_eq!(r.set_param(7, 0, 16.0), OK);
    assert_eq!(r.set_param(8, 3, 0.05), OK);
    render(&mut r, 5, &mut ctx);

    ARMED.with(|a| a.set(false));
    assert_eq!(ALLOCS.load(Ordering::SeqCst), 0, "rack allocated");
    assert!(l.iter().chain(rr.iter()).all(|x| x.is_finite()));
}
