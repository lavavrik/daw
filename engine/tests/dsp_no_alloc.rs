//! The DSP library must never touch the heap after `new()`: processing,
//! every setter and `reset()` run on the audio thread. Same counting-allocator
//! pattern as `no_alloc.rs`, armed per-thread.

use daw_engine::dsp::{Biquad, ChorusCore, Compressor, Delay, Eq3, Limiter, Reverb};
use daw_engine::dsp::biquad::Coefs;
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
fn dsp_processing_and_setters_do_not_allocate() {
    let sr = 48000.0;
    let mut eq = Eq3::new(sr);
    let mut comp = Compressor::new(sr);
    let mut rev = Reverb::new(sr);
    let mut del = Delay::new(sr);
    let mut lim = Limiter::new(sr);
    let mut bq = Biquad::new(Coefs::low_pass(sr, 1000.0, 0.7));
    let mut cho = ChorusCore::new(sr);
    let mut cho_buf = vec![0.0f32; ChorusCore::buffer_len(sr)];
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let (mut kl, mut kr) = ([0.0f32; 128], [0.0f32; 128]);
    let mut seed = 1u32;
    let mut fill = |l: &mut [f32; 128], r: &mut [f32; 128], amp: f32| {
        for i in 0..128 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            l[i] = amp * ((seed as f32 / u32::MAX as f32) * 2.0 - 1.0);
            r[i] = -l[i];
        }
    };

    ARMED.with(|a| a.set(true));
    ALLOCS.store(0, Ordering::SeqCst);

    for blk in 0..400 {
        // Setters every few blocks, sweeping their full ranges.
        if blk % 7 == 0 {
            let t = (blk % 50) as f32 / 49.0;
            eq.set_hp(20.0 + 980.0 * t);
            eq.set_low(-15.0 + 30.0 * t);
            eq.set_mid(200.0 + 7800.0 * t, 15.0 - 30.0 * t, 0.3 + 3.7 * t);
            eq.set_high(15.0 * t);
            comp.set_threshold_db(-60.0 * t);
            comp.set_ratio(1.0 + 19.0 * t);
            comp.set_attack_ms(0.1 + 99.9 * t);
            comp.set_release_ms(10.0 + 990.0 * t);
            comp.set_makeup_db(24.0 * t);
            rev.set_size(t);
            rev.set_decay(0.2 + 19.8 * t);
            rev.set_damping(1.0 - t);
            rev.set_predelay_ms(200.0 * t);
            del.set_time_beats(0.25 + 3.0 * t);
            del.set_tempo(60.0 + 120.0 * t);
            del.set_feedback(0.95 * t);
            del.set_ping_pong(blk % 2 == 0);
            del.set_high_cut(1000.0 + 19000.0 * t);
            lim.set_ceiling(0.5 + 0.5 * t);
            lim.set_release_ms(10.0 + 490.0 * t);
            bq.set(Coefs::peaking(sr, 200.0 + 5000.0 * t, 6.0, 1.0));
            cho.set_rate(0.05 + 4.95 * t);
            cho.set_depth(t);
            cho.set_mix(1.0 - t);
        }
        fill(&mut l, &mut r, 1.5);
        fill(&mut kl, &mut kr, 0.8);
        eq.process(&mut l, &mut r);
        cho.process(&mut cho_buf, &mut l, &mut r);
        comp.process(&mut l, &mut r, &kl, &kr);
        comp.process_self(&mut l, &mut r);
        let (mut sl, mut sr_) = (l, r);
        rev.process(&mut sl, &mut sr_);
        let (mut dl, mut dr) = (l, r);
        del.process(&mut dl, &mut dr);
        for i in 0..128 {
            l[i] += 0.3 * (sl[i] + dl[i]);
            r[i] += 0.3 * (sr_[i] + dr[i]);
            l[i] = bq.tick(l[i]);
        }
        bq.flush();
        lim.process(&mut l, &mut r);
        assert!(l.iter().chain(r.iter()).all(|v| v.is_finite()));
        let _ = (comp.gain_reduction_db(), lim.gain_reduction_db(), lim.latency());
        if blk == 200 {
            eq.reset();
            comp.reset();
            rev.reset();
            del.reset();
            lim.reset();
            bq.reset();
            cho.reset();
        }
    }

    ARMED.with(|a| a.set(false));
    assert_eq!(ALLOCS.load(Ordering::SeqCst), 0, "DSP allocated on the audio path");
}
