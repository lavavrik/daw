//! Rack edits and rendering must never touch the heap after `Rack::new`
//! (structural edits happen on the audio thread). Same counting-allocator
//! pattern as `no_alloc.rs`, armed per-thread.

use daw_engine::protocol::OK;
use daw_engine::rack::catalog::ModuleKind;
use daw_engine::rack::modules::{Ctx, NoteEvent};
use daw_engine::rack::fx_pool::{FxKind, FxPool};
use daw_engine::rack::Rack;
use daw_engine::samples::SampleView;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
    /// Per-thread count, so tests running in parallel never mask each other.
    static COUNT: Cell<usize> = const { Cell::new(0) };
}

struct Counting;
fn note() {
    if ARMED.with(|a| a.get()) {
        COUNT.with(|c| c.set(c.get() + 1));
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
    let mut fx = FxPool::new(48000.0);
    let (mut l, mut rr) = ([0.0f32; 128], [0.0f32; 128]);
    let mut ctx = Ctx { sr: 48000.0, bpm: 124.0, playing: true, ticks: 0.0, ticks_per_frame: 124.0 * 960.0 / 60.0 / 48000.0 };

    ARMED.with(|a| a.set(true));
    COUNT.with(|c| c.set(0));

    // Immediate edits (silent rack).
    assert_eq!(r.add_module(0, ModuleKind::Lfo, &mut fx), OK);
    assert_eq!(r.add_module(1, ModuleKind::Vca, &mut fx), OK);
    assert_eq!(r.add_module(2, ModuleKind::Out, &mut fx), OK);
    assert_eq!(r.add_module(3, ModuleKind::Lfo, &mut fx), OK);
    assert_eq!(r.connect((0, 0), (1, 0)), OK);
    assert_eq!(r.connect((1, 0), (2, 0)), OK);
    assert_eq!(r.set_param(0, 1, 7.0), OK);
    assert_eq!(r.set_param(3, 2, 1.0), OK); // synced
    let mut render = |r: &mut Rack, fx: &mut FxPool, blocks: usize, ctx: &mut Ctx| {
        for _ in 0..blocks {
            r.render_add(ctx, fx, SampleView::NONE, &mut l, &mut rr);
            ctx.ticks += 128.0 * ctx.ticks_per_frame;
        }
    };
    render(&mut r, &mut fx, 20, &mut ctx);
    assert!(r.is_sounding());

    // Queued (declicked) edits, a feedback loop, params, notes.
    assert_eq!(r.connect((3, 0), (1, 1)), OK);
    assert_eq!(r.connect((1, 0), (1, 1)), OK);
    assert_eq!(r.set_param(1, 0, 0.5), OK);
    r.note(NoteEvent::On { note: 60, vel: 100 });
    render(&mut r, &mut fx, 10, &mut ctx);
    assert_eq!(r.disconnect((1, 1)), OK);
    assert_eq!(r.remove_module(3), OK);
    assert_eq!(r.add_module(3, ModuleKind::Vca, &mut fx), OK);
    render(&mut r, &mut fx, 10, &mut ctx);
    // Overflow the 64-entry queue.
    for i in 0..80 {
        let code = if i % 2 == 0 { r.connect((0, 0), (3, 0)) } else { r.disconnect((3, 0)) };
        assert_eq!(code, OK);
    }
    render(&mut r, &mut fx, 10, &mut ctx);
    r.clear();
    render(&mut r, &mut fx, 30, &mut ctx);
    assert!(!r.is_sounding());

    // Immediate path on a silent rack: add, connect (+ no-op re-connect),
    // no-op disconnect, real disconnect, remove, clear.
    assert_eq!(r.add_module(4, ModuleKind::Lfo, &mut fx), OK);
    assert_eq!(r.add_module(5, ModuleKind::Vca, &mut fx), OK);
    assert_eq!(r.add_module(6, ModuleKind::Out, &mut fx), OK);
    assert_eq!(r.connect((4, 0), (5, 0)), OK);
    assert_eq!(r.connect((4, 0), (5, 0)), OK); // no-op
    assert_eq!(r.disconnect((5, 1)), OK); // no-op (unconnected)
    assert_eq!(r.connect((5, 0), (6, 0)), OK);
    assert_eq!(r.disconnect((6, 0)), OK);
    assert_eq!(r.remove_module(5), OK);
    assert_eq!(r.set_param(4, 0, 2.0), OK);
    render(&mut r, &mut fx, 5, &mut ctx);
    assert!(!r.is_sounding());
    r.clear();
    render(&mut r, &mut fx, 5, &mut ctx);

    // MIDI In + ADSR: note-on/off, steal, sustain, mode/voices switches.
    assert_eq!(r.add_module(7, ModuleKind::MidiIn, &mut fx), OK);
    assert_eq!(r.add_module(8, ModuleKind::Adsr, &mut fx), OK);
    assert_eq!(r.add_module(9, ModuleKind::Vca, &mut fx), OK);
    assert_eq!(r.add_module(10, ModuleKind::Out, &mut fx), OK);
    assert_eq!(r.connect((7, 1), (8, 0)), OK);
    assert_eq!(r.connect((8, 0), (9, 1)), OK);
    assert_eq!(r.connect((9, 0), (10, 0)), OK);
    assert_eq!(r.set_param(7, 0, 2.0), OK); // 2 voices: easy to steal
    render(&mut r, &mut fx, 5, &mut ctx);
    for (n, v) in [(60u8, 100u8), (64, 90), (67, 80)] {
        r.note(NoteEvent::On { note: n, vel: v }); // third note steals
        render(&mut r, &mut fx, 3, &mut ctx);
    }
    r.note(NoteEvent::On { note: 64, vel: 90 }); // re-press
    r.note(NoteEvent::Bend(0.5));
    r.note(NoteEvent::Mod(0.7));
    render(&mut r, &mut fx, 3, &mut ctx);
    r.note(NoteEvent::Sustain(true));
    r.note(NoteEvent::Off { note: 64 });
    render(&mut r, &mut fx, 3, &mut ctx);
    r.note(NoteEvent::Sustain(false));
    r.note(NoteEvent::Off { note: 67 });
    render(&mut r, &mut fx, 3, &mut ctx);
    assert_eq!(r.set_param(7, 1, 1.0), OK); // mono + glide
    assert_eq!(r.set_param(7, 2, 0.1), OK);
    r.note(NoteEvent::On { note: 48, vel: 100 });
    r.note(NoteEvent::On { note: 55, vel: 100 });
    render(&mut r, &mut fx, 5, &mut ctx);
    r.note(NoteEvent::Off { note: 55 });
    r.note(NoteEvent::AllOff);
    assert_eq!(r.set_param(7, 0, 16.0), OK);
    assert_eq!(r.set_param(8, 3, 0.05), OK);
    render(&mut r, &mut fx, 5, &mut ctx);

    // Oscillator (poly, unison, FM from a noise source, every wave) + Noise.
    r.clear();
    render(&mut r, &mut fx, 5, &mut ctx);
    assert_eq!(r.add_module(11, ModuleKind::MidiIn, &mut fx), OK);
    assert_eq!(r.add_module(12, ModuleKind::Osc, &mut fx), OK);
    assert_eq!(r.add_module(13, ModuleKind::Noise, &mut fx), OK);
    assert_eq!(r.add_module(14, ModuleKind::Out, &mut fx), OK);
    assert_eq!(r.connect((11, 0), (12, 0)), OK); // pitch
    assert_eq!(r.connect((13, 0), (12, 1)), OK); // noise -> fm
    assert_eq!(r.connect((12, 0), (14, 0)), OK);
    assert_eq!(r.set_param(12, 6, 4.0), OK); // unison 4
    assert_eq!(r.set_param(12, 5, 0.5), OK); // fm
    r.note(NoteEvent::On { note: 48, vel: 100 });
    r.note(NoteEvent::On { note: 55, vel: 100 });
    // Wave/unison/mode are stepped params: while sounding they go through
    // the declick queue (rack/mod.rs), which must stay allocation-free too.
    for wave in 0..4 {
        assert_eq!(r.set_param(12, 0, wave as f32), OK);
        assert_eq!(r.set_param(12, 4, 0.2 + 0.2 * wave as f32), OK);
        assert_eq!(r.set_param(13, 0, 0.3), OK);
        render(&mut r, &mut fx, 5, &mut ctx);
    }
    assert_eq!(r.set_param(12, 0, 3.0), OK); // no-op re-send of a stepped param
    render(&mut r, &mut fx, 2, &mut ctx);

    // Filter (every mode, cv from a poly ADSR, drive) + Mixer (mono + poly in).
    r.clear();
    render(&mut r, &mut fx, 5, &mut ctx);
    assert_eq!(r.add_module(15, ModuleKind::MidiIn, &mut fx), OK);
    assert_eq!(r.add_module(16, ModuleKind::Osc, &mut fx), OK);
    assert_eq!(r.add_module(17, ModuleKind::Adsr, &mut fx), OK);
    assert_eq!(r.add_module(18, ModuleKind::Filter, &mut fx), OK);
    assert_eq!(r.add_module(19, ModuleKind::Noise, &mut fx), OK);
    assert_eq!(r.add_module(20, ModuleKind::Mixer, &mut fx), OK);
    assert_eq!(r.add_module(21, ModuleKind::Out, &mut fx), OK);
    assert_eq!(r.connect((15, 0), (16, 0)), OK); // pitch -> osc
    assert_eq!(r.connect((15, 1), (17, 0)), OK); // gate -> adsr
    assert_eq!(r.connect((16, 0), (18, 0)), OK); // osc -> filter in
    assert_eq!(r.connect((17, 0), (18, 1)), OK); // env -> filter cv
    assert_eq!(r.connect((18, 0), (20, 0)), OK); // filter -> mixer in1
    assert_eq!(r.connect((19, 0), (20, 1)), OK); // noise -> mixer in2
    assert_eq!(r.connect((20, 0), (21, 0)), OK);
    assert_eq!(r.set_param(18, 3, 4.0), OK); // cv_amt
    assert_eq!(r.set_param(18, 2, 1.0), OK); // reso
    assert_eq!(r.set_param(18, 4, 1.0), OK); // drive
    assert_eq!(r.set_param(20, 1, 0.1), OK); // lvl2
    r.note(NoteEvent::On { note: 36, vel: 100 });
    r.note(NoteEvent::On { note: 43, vel: 100 });
    for mode in [0, 2, 1, 3, 4, 0] {
        assert_eq!(r.set_param(18, 0, mode as f32), OK);
        assert_eq!(r.set_param(18, 1, 200.0 + 3000.0 * mode as f32), OK); // cutoff
        render(&mut r, &mut fx, 5, &mut ctx);
    }
    r.note(NoteEvent::AllOff);
    assert_eq!(r.disconnect((18, 1)), OK);
    render(&mut r, &mut fx, 5, &mut ctx);

    // Effects (plan 6): all 8 pooled delays added and removed while playing
    // (declicked, slots freed after the fade and zeroed in bounded chunks
    // on reuse), the 9th refused, plus every other effect kind.
    r.clear();
    render(&mut r, &mut fx, 5, &mut ctx);
    assert_eq!(r.add_module(22, ModuleKind::Osc, &mut fx), OK);
    assert_eq!(r.add_module(23, ModuleKind::Out, &mut fx), OK);
    assert_eq!(r.connect((22, 0), (23, 0)), OK);
    render(&mut r, &mut fx, 10, &mut ctx);
    assert!(r.is_sounding());
    for round in 0..3 {
        for m in 0..8 {
            assert_eq!(r.add_module(m, ModuleKind::Delay, &mut fx), OK, "round {round} delay {m}");
            // Chain them: osc -> d0 -> d1 -> ... -> d7 -> out.
            let src = if m == 0 { (22, 0) } else { (m - 1, 0) };
            assert_eq!(r.connect(src, (m, 0)), OK);
            assert_eq!(r.set_param(m, 1, 0.8), OK); // feedback
        }
        assert_eq!(r.add_module(8, ModuleKind::Delay, &mut fx), daw_engine::protocol::ERR_OUT_OF_MEMORY);
        assert_eq!(r.connect((7, 0), (23, 0)), OK);
        assert_eq!(r.connect((7, 1), (23, 1)), OK);
        render(&mut r, &mut fx, 40, &mut ctx);
        for m in 0..8 {
            assert_eq!(r.remove_module(m), OK);
        }
        assert_eq!(r.connect((22, 0), (23, 0)), OK);
        render(&mut r, &mut fx, 10, &mut ctx);
        assert_eq!(fx.in_use(FxKind::Delay), 0, "round {round}: slots freed");
    }
    let kinds = [
        ModuleKind::Reverb,
        ModuleKind::Chorus,
        ModuleKind::Eq,
        ModuleKind::Compressor,
        ModuleKind::Saturator,
        ModuleKind::Attenuator,
        ModuleKind::Delay,
    ];
    let mut src = (22usize, 0usize);
    for (i, &k) in kinds.iter().enumerate() {
        let m = 10 + i;
        assert_eq!(r.add_module(m, k, &mut fx), OK);
        assert_eq!(r.connect(src, (m, 0)), OK);
        src = (m, 0);
    }
    assert_eq!(r.connect((15, 0), (13, 2)), OK); // attenuator -> compressor sc (a loop)
    assert_eq!(r.connect(src, (23, 0)), OK);
    for blk in 0..20 {
        assert_eq!(r.set_param(10, 1, 0.5 + blk as f32 * 0.3), OK); // reverb decay
        assert_eq!(r.set_param(11, 0, 0.1 + blk as f32 * 0.2), OK); // chorus rate
        assert_eq!(r.set_param(12, 2, 300.0 + blk as f32 * 100.0), OK); // eq mid freq
        assert_eq!(r.set_param(16, 0, (blk % 12) as f32), OK); // delay division
        render(&mut r, &mut fx, 2, &mut ctx);
    }
    r.clear();
    render(&mut r, &mut fx, 10, &mut ctx);
    assert_eq!((fx.in_use(FxKind::Delay), fx.in_use(FxKind::Reverb), fx.in_use(FxKind::Chorus)), (0, 0, 0));

    ARMED.with(|a| a.set(false));
    assert_eq!(COUNT.with(|c| c.get()), 0, "rack allocated");
    assert!(l.iter().chain(rr.iter()).all(|x| x.is_finite()));
}

/// Plan 11: a Formant and an ADSR with `vel` cabled (delay, velocity), MIDI
/// In legato glide, param moves (smooth, stepped `glide_mode`, `delay`),
/// and removal while sounding.
#[test]
fn formant_and_adsr_do_not_allocate() {
    // MIDI In 0: pitch 0, gate 1, vel 2, mod 3. Osc 1: pitch 0. Adsr 2:
    // gate 0, vel 1; params delay 4, vel_amt 5. Formant 3: in 0, pitch 1,
    // cv 2; params f1 0, q 3, shift 6, track 7, cv_amt 8, mix 9.
    let mut r = Rack::new(48000.0);
    let mut fx = FxPool::new(48000.0);
    let (mut l, mut rr) = ([0.0f32; 128], [0.0f32; 128]);
    let mut ctx = Ctx { sr: 48000.0, bpm: 124.0, playing: true, ticks: 0.0, ticks_per_frame: 124.0 * 960.0 / 60.0 / 48000.0 };
    let mut render = |r: &mut Rack, fx: &mut FxPool, blocks: usize, ctx: &mut Ctx| {
        for _ in 0..blocks {
            r.render_add(ctx, fx, SampleView::NONE, &mut l, &mut rr);
            ctx.ticks += 128.0 * ctx.ticks_per_frame;
        }
    };

    ARMED.with(|a| a.set(true));
    COUNT.with(|c| c.set(0));

    assert_eq!(r.add_module(0, ModuleKind::MidiIn, &mut fx), OK);
    assert_eq!(r.add_module(1, ModuleKind::Osc, &mut fx), OK);
    assert_eq!(r.add_module(2, ModuleKind::Adsr, &mut fx), OK);
    assert_eq!(r.add_module(3, ModuleKind::Formant, &mut fx), OK);
    assert_eq!(r.add_module(4, ModuleKind::Vca, &mut fx), OK);
    assert_eq!(r.add_module(5, ModuleKind::Out, &mut fx), OK);
    assert_eq!(r.connect((0, 0), (1, 0)), OK); // pitch -> osc
    assert_eq!(r.connect((0, 1), (2, 0)), OK); // gate -> adsr
    assert_eq!(r.connect((0, 2), (2, 1)), OK); // vel -> adsr vel
    assert_eq!(r.connect((1, 0), (3, 0)), OK); // osc -> formant in
    assert_eq!(r.connect((0, 0), (3, 1)), OK); // pitch -> formant pitch (poly)
    assert_eq!(r.connect((0, 3), (3, 2)), OK); // mod -> formant cv
    assert_eq!(r.connect((3, 0), (4, 0)), OK);
    assert_eq!(r.connect((2, 0), (4, 1)), OK); // env -> vca cv
    assert_eq!(r.connect((4, 0), (5, 0)), OK);
    assert_eq!(r.set_param(2, 4, 0.05), OK); // delay
    assert_eq!(r.set_param(2, 5, 0.8), OK); // vel_amt
    assert_eq!(r.set_param(3, 3, 20.0), OK); // q
    assert_eq!(r.set_param(3, 7, 1.0), OK); // track
    assert_eq!(r.set_param(3, 8, -2.0), OK); // cv_amt
    for (n, v) in [(48u8, 100u8), (55, 40), (60, 127), (64, 1)] {
        r.note(NoteEvent::On { note: n, vel: v });
        r.note(NoteEvent::Mod(v as f32 / 127.0));
        render(&mut r, &mut fx, 4, &mut ctx);
    }
    for blk in 0..20 {
        assert_eq!(r.set_param(3, 0, 200.0 + 60.0 * blk as f32), OK); // f1
        assert_eq!(r.set_param(3, 6, -2.0 + 0.2 * blk as f32), OK); // shift
        assert_eq!(r.set_param(3, 9, (blk % 3) as f32 * 0.5), OK); // mix
        assert_eq!(r.set_param(2, 4, 0.01 * blk as f32), OK); // delay
        r.automate(3, 1, 600.0 + 100.0 * blk as f32); // f2, automated
        r.automate(2, 5, (blk % 5) as f32 * 0.25); // vel_amt, automated
        render(&mut r, &mut fx, 2, &mut ctx);
    }
    // Mono with legato glide; glide_mode is stepped (declick queue).
    assert_eq!(r.set_param(0, 1, 1.0), OK);
    assert_eq!(r.set_param(0, 2, 0.1), OK);
    assert_eq!(r.set_param(0, 4, 1.0), OK); // glide_mode Legato
    render(&mut r, &mut fx, 5, &mut ctx);
    r.note(NoteEvent::On { note: 48, vel: 90 });
    render(&mut r, &mut fx, 3, &mut ctx);
    r.note(NoteEvent::On { note: 55, vel: 30 }); // legato: glides
    render(&mut r, &mut fx, 5, &mut ctx);
    assert_eq!(r.set_param(0, 4, 0.0), OK); // back to Always
    r.note(NoteEvent::Off { note: 55 });
    render(&mut r, &mut fx, 5, &mut ctx);
    assert!(r.is_sounding());
    // Remove the Formant and the ADSR while sounding (declicked).
    assert_eq!(r.remove_module(3), OK);
    assert_eq!(r.remove_module(2), OK);
    render(&mut r, &mut fx, 10, &mut ctx);
    r.note(NoteEvent::AllOff);
    r.clear();
    render(&mut r, &mut fx, 10, &mut ctx);

    ARMED.with(|a| a.set(false));
    assert_eq!(COUNT.with(|c| c.get()), 0, "rack allocated");
    assert!(l.iter().chain(rr.iter()).all(|x| x.is_finite()));
}
