//! `OP_RESET_ALL`: the engine back to a blank session (project load).

use super::*;
use crate::mixer::catalog::{
    MIX_PARAMS, P_COMP_ON, P_DELAY_FEEDBACK, P_FADER, P_LIMITER_CEILING, P_REV_DECAY, P_REV_SIZE, P_SEND_A, P_SEND_B,
};
use crate::protocol::*;
use crate::rack::catalog::ModuleKind;
use crate::rack::fx_pool::FxKind;
use crate::{MIX_CHANNELS, MIX_DELAY, MIX_MASTER, MIX_REVERB};

const SR: f32 = 48000.0;

fn kind(k: ModuleKind) -> f64 {
    k as u32 as f64
}

/// Packed port argument: `module * 16 + port`.
fn pk(module: usize, port: usize) -> f64 {
    (module * 16 + port) as f64
}

fn ok(code: i32) {
    assert_eq!(code, OK);
}

/// Render `frames` (128-frame blocks); returns (L, R).
fn render(e: &mut Engine, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let (mut ol, mut or) = (Vec::new(), Vec::new());
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    for _ in 0..frames.div_ceil(128) {
        e.process(&mut l, &mut r);
        ol.extend_from_slice(&l);
        or.extend_from_slice(&r);
    }
    (ol, or)
}

fn max_jump(prev: f32, xs: &[f32]) -> f32 {
    let mut last = prev;
    xs.iter().fold(0.0f32, |m, &x| {
        let d = (x - last).abs();
        last = x;
        m.max(d)
    })
}

fn load_const(e: &mut Engine, id: u32, frames: u32, v: f32) {
    let p = e.sample_alloc(id, frames, 1).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, frames as usize) }.fill(v);
    ok(e.sample_ready(id));
}

/// Synth track `slot`: MIDI In -> Osc (sine) -> VCA (gated) -> Out.l, MIDI In
/// -> Sample Player (sample 0) -> Out.r, and an unconnected Delay, Reverb and
/// Chorus.
fn busy_synth(e: &mut Engine, slot: f64) {
    ok(e.command(OP_ADD_SYNTH_TRACK, slot, 0.0, 0.0, 0.0));
    for (m, k) in [
        (0, ModuleKind::MidiIn),
        (1, ModuleKind::Osc),
        (2, ModuleKind::Out),
        (3, ModuleKind::SamplePlayer),
        (4, ModuleKind::Delay),
        (5, ModuleKind::Reverb),
        (6, ModuleKind::Chorus),
        (7, ModuleKind::Vca),
    ] {
        ok(e.command(OP_RACK_ADD_MODULE, slot, m as f64, kind(k), 0.0));
    }
    ok(e.command(OP_RACK_SET_PARAM, slot, 1.0, 0.0, 3.0)); // sine
    ok(e.command(OP_RACK_SET_PARAM, slot, 3.0, 0.0, 0.0)); // sample 0
    for (from, to) in [
        ((0, 0), (1, 0)), // pitch -> osc
        ((1, 0), (7, 0)), // osc -> vca
        ((0, 1), (7, 1)), // gate -> vca cv
        ((7, 0), (2, 0)), // vca -> out l
        ((0, 0), (3, 0)), // pitch -> sample player
        ((0, 1), (3, 1)), // gate -> sample player
        ((3, 0), (2, 1)), // sample player -> out r
    ] {
        ok(e.command(OP_RACK_CONNECT, slot, pk(from.0, from.1), pk(to.0, to.1), 0.0));
    }
}

#[test]
fn reset_all_rejected_while_playing() {
    let mut e = Engine::new(SR);
    ok(e.command(OP_ADD_DRUM_TRACK, 0.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(e.command(OP_RESET_ALL, 0.0, 0.0, 0.0, 0.0), ERR_BAD_VALUE);
    assert_eq!(e.telemetry()[crate::TELEMETRY_LAST_ERROR], ERR_BAD_VALUE as f64);
    assert_eq!(e.kind(0), SlotKind::Drum, "nothing was reset");
    assert!(e.transport.playing);
    // Stop first (the UI does): then it is accepted, even in the same batch.
    ok(e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_RESET_ALL, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(e.kind(0), SlotKind::Empty);
    // A blank session carries no error over from the previous one.
    assert_eq!(e.telemetry()[crate::TELEMETRY_LAST_ERROR], 0.0, "last error cleared");
}

#[test]
fn reset_all_releases_everything() {
    let mut e = Engine::new(SR);
    load_const(&mut e, 0, 48000, 0.5);
    load_const(&mut e, 1, 48000, 0.25);
    // A drum track hitting sample 1, a synth track holding a sustained live
    // note through the Osc and the Sample Player, clips, keys and mix moves.
    ok(e.command(OP_ADD_DRUM_TRACK, 0.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_SET_ROW_SAMPLE, 0.0, 0.0, 1.0, 0.0));
    ok(e.command(OP_SET_STEP, 0.0, 0.0, 0.0, 127.0));
    busy_synth(&mut e, 1.0);
    ok(e.command(OP_SET_INPUT_TRACK, 1.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_SUSTAIN, 1.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_NOTE_ON, 60.0, 100.0, 0.0, 0.0));
    ok(e.command(OP_NOTE_OFF, 60.0, 0.0, 0.0, 0.0)); // held by the pedal
    ok(e.command(OP_NOTE_ON, 64.0, 100.0, 0.0, 0.0)); // key still down
    ok(e.command(OP_CLIP_SET, 0.0, 0.0, 0.0, 3840.0));
    ok(e.command(OP_MIX_SET_KEY, 1.0, 0.0, 0.0, 0.0)); // track 1 keyed by track 0
    ok(e.command(OP_MIX_SET, 1.0, P_COMP_ON as f64, 1.0, 0.0));
    ok(e.command(OP_MIX_SET, 1.0, P_SEND_A as f64, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let (l, _) = render(&mut e, 9600);
    assert!(l[9000..].iter().any(|&x| x.abs() > 0.05), "sounding before the reset");
    assert_eq!(e.synths.fx_pool().in_use(FxKind::Delay), 1);

    ok(e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_RESET_ALL, 0.0, 0.0, 0.0, 0.0));

    // Every track gone (hard: no fade still holding anything) ...
    for slot in 0..MAX_TRACKS {
        assert_eq!(e.kind(slot), SlotKind::Empty);
        assert!(!e.synths.is_active(slot));
        assert!(!e.drums.tracks[slot].active);
        assert!(e.drums.tracks[slot].voices.iter().all(|v| !v.active.live_for_test() && !v.fading.live_for_test()));
        assert!(e.arrangements[slot].clips().iter().all(|c| !c.active));
    }
    // ... every rack empty and every FX-pool slot free ...
    for kind in FxKind::ALL {
        assert_eq!(e.synths.fx_pool().in_use(kind), 0, "{kind:?}");
    }
    assert!(e.synths.racks_empty());
    // ... the input track and live-note state cleared ...
    assert_eq!(e.input, None);
    assert_eq!((e.live_down, e.live_sustained, e.sustain), (0, 0, false));
    // ... the samples gone and the arena rewound (its first chunk free).
    for id in 0..MAX_SAMPLES {
        assert!(e.samples.get(id).is_none());
    }
    assert!(e.arena.alloc(ARENA_FLOATS, false).is_some(), "whole first chunk free again");
    // ... and the mixer back to defaults.
    assert_eq!(e.mixer.key(1), Key::None);
    assert_eq!(e.mixer.param(1, P_COMP_ON), 0.0);

    // Within 6 ms the output is silent, and stays so: nothing is stuck.
    let (l, r) = render(&mut e, SR as usize);
    let six_ms = (0.006 * SR) as usize;
    assert!(l[six_ms..].iter().chain(&r[six_ms..]).all(|&x| x == 0.0), "something still sounds");

    // The blank engine works: a new synth track on the old input slot plays
    // only what it is sent (the pedal-held note does not come back).
    busy_synth(&mut e, 1.0);
    ok(e.command(OP_SET_INPUT_TRACK, 1.0, 0.0, 0.0, 0.0));
    let (l, _) = render(&mut e, 4800);
    assert!(l.iter().all(|&x| x == 0.0), "a note survived the reset");
    ok(e.command(OP_NOTE_ON, 69.0, 100.0, 0.0, 0.0));
    let (l, _) = render(&mut e, 4800);
    assert!(l.iter().any(|&x| x.abs() > 0.05));
}

#[test]
fn reset_all_frees_fx_slots_of_fading_racks() {
    // Eight delays (the whole bank) on a sounding track that is being removed:
    // the slots are still held through the removal fade (and would be handed
    // back by `reclaim` later). RESET_ALL must drop them for good first, so
    // eight new delays each get a distinct slot and no stale release ever
    // frees one of them.
    let mut e = Engine::new(SR);
    ok(e.command(OP_ADD_SYNTH_TRACK, 0.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_RACK_ADD_MODULE, 0.0, 0.0, kind(ModuleKind::Osc), 0.0));
    ok(e.command(OP_RACK_ADD_MODULE, 0.0, 9.0, kind(ModuleKind::Out), 0.0));
    for m in 1..=8 {
        ok(e.command(OP_RACK_ADD_MODULE, 0.0, m as f64, kind(ModuleKind::Delay), 0.0));
        ok(e.command(OP_RACK_CONNECT, 0.0, pk(m - 1, 0), pk(m, 0), 0.0));
    }
    ok(e.command(OP_RACK_CONNECT, 0.0, pk(8, 0), pk(9, 0), 0.0));
    render(&mut e, 4800);
    assert_eq!(e.synths.fx_pool().in_use(FxKind::Delay), 8);
    ok(e.command(OP_REMOVE_TRACK, 0.0, 0.0, 0.0, 0.0)); // fading: slots still held
    assert_eq!(e.synths.fx_pool().in_use(FxKind::Delay), 8);
    ok(e.command(OP_RESET_ALL, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(e.synths.fx_pool().in_use(FxKind::Delay), 0);
    // Eight new delays over two tracks.
    for t in 0..2 {
        ok(e.command(OP_ADD_SYNTH_TRACK, t as f64, 0.0, 0.0, 0.0));
        for m in 0..4 {
            ok(e.command(OP_RACK_ADD_MODULE, t as f64, m as f64, kind(ModuleKind::Delay), 0.0));
        }
    }
    assert_eq!(e.command(OP_RACK_ADD_MODULE, 0.0, 4.0, kind(ModuleKind::Delay), 0.0), ERR_OUT_OF_MEMORY);
    for _ in 0..8 {
        render(&mut e, 1280);
        let mut seen = 0u32;
        for t in 0..2 {
            for m in 0..4 {
                let rack = e.synths.rack_mut(t).unwrap();
                let (k, s) = rack.fx_slot(m).expect("holds a slot");
                assert_eq!(k, FxKind::Delay);
                assert_eq!(seen & (1 << s), 0, "slot {s} shared");
                seen |= 1 << s;
            }
        }
        assert_eq!(e.synths.fx_pool().in_use(FxKind::Delay), 8, "a stale release freed a slot");
    }
}

#[test]
fn reset_all_clears_mixer_tails_and_master() {
    // A loud synth through a long reverb and delay return, a pushed master
    // and limiter: then the source is removed and the reverb tail rings.
    let setup = |e: &mut Engine| {
        ok(e.command(OP_ADD_SYNTH_TRACK, 0.0, 0.0, 0.0, 0.0));
        ok(e.command(OP_RACK_ADD_MODULE, 0.0, 0.0, kind(ModuleKind::Osc), 0.0));
        ok(e.command(OP_RACK_ADD_MODULE, 0.0, 1.0, kind(ModuleKind::Out), 0.0));
        ok(e.command(OP_RACK_CONNECT, 0.0, pk(0, 0), pk(1, 0), 0.0));
        ok(e.command(OP_RACK_SET_PARAM, 0.0, 1.0, 0.0, 1.0)); // Out level 1
        ok(e.command(OP_MIX_SET, 0.0, P_SEND_A as f64, 0.0, 0.0));
        ok(e.command(OP_MIX_SET, 0.0, P_SEND_B as f64, 0.0, 0.0));
    };
    let mut e = Engine::new(SR);
    setup(&mut e);
    ok(e.command(OP_MIX_SET, MIX_REVERB as f64, P_REV_DECAY as f64, 20.0, 0.0));
    ok(e.command(OP_MIX_SET, MIX_REVERB as f64, P_REV_SIZE as f64, 1.0, 0.0));
    ok(e.command(OP_MIX_SET, MIX_DELAY as f64, P_DELAY_FEEDBACK as f64, 0.9, 0.0));
    ok(e.command(OP_MIX_SET, MIX_MASTER as f64, P_FADER as f64, 6.0, 0.0));
    ok(e.command(OP_MIX_SET, MIX_MASTER as f64, P_LIMITER_CEILING as f64, -3.0, 0.0));
    ok(e.command(OP_SET_MASTER_GAIN, 2.0, 0.0, 0.0, 0.0));
    render(&mut e, SR as usize);
    ok(e.command(OP_REMOVE_TRACK, 0.0, 0.0, 0.0, 0.0));
    let (l, r) = render(&mut e, 4800);
    let (pl, pr) = (l[l.len() - 1], r[r.len() - 1]);
    assert!(pl.abs() > 0.05 || pr.abs() > 0.05, "the tail rings: {pl} {pr}");
    assert!(e.meters()[MIX_MASTER * crate::MIX_METER_STRIDE + 2] > 0.0, "the limiter is working");

    ok(e.command(OP_RESET_ALL, 0.0, 0.0, 0.0, 0.0));
    let (l, r) = render(&mut e, SR as usize);
    // A fade, not a cut: no step > 0.05 from the last sample before the reset.
    assert!(max_jump(pl, &l) <= 0.05 && max_jump(pr, &r) <= 0.05, "steps {} {}", max_jump(pl, &l), max_jump(pr, &r));
    let six_ms = (0.006 * SR) as usize;
    assert!(l[six_ms..].iter().chain(&r[six_ms..]).all(|&x| x == 0.0), "the tail survived the reset");

    // The mixer is a fresh engine's: every param, key and the master gain ...
    let fresh = Engine::new(SR);
    for ch in 0..MIX_CHANNELS {
        for id in 0..MIX_PARAMS as u32 {
            assert_eq!(e.mixer.param(ch, id), fresh.mixer.param(ch, id), "channel {ch} param {id}");
        }
        assert_eq!(e.mixer.key(ch), Key::None);
    }
    assert_eq!(e.mixer.master_gain(), 0.8);
    assert_eq!(e.mixer.master_gain(), fresh.mixer.master_gain());
    assert!(e.meters().iter().all(|&m| m == 0.0), "meters (incl. limiter GR) at rest");
    // ... and its state too (reverb, delay, limiter, smoothing): the same
    // session from here renders bit for bit what a fresh engine renders.
    let mut fresh = fresh;
    setup(&mut e);
    setup(&mut fresh);
    assert_eq!(render(&mut e, SR as usize), render(&mut fresh, SR as usize));
}
