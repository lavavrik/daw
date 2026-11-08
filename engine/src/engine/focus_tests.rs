//! `OP_SET_PATTERN_FOCUS` (plan 20 task 12): the pattern transport plays only
//! the track shown in the bottom panel. Each test reads the per-track meters
//! (`Engine::meters`, post-fader peaks per block) to tell which slots sound.

use super::*;
use crate::protocol::*;
use crate::rack::catalog::ModuleKind;
use crate::{MAX_NOTES, MIX_METER_STRIDE};

const SR: f32 = 48000.0;

fn ok(code: i32) {
    assert_eq!(code, OK);
}

fn eng() -> Engine {
    let mut e = Engine::with_lookahead(SR, 0.0);
    ok(e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0));
    // Sample 0: a long constant, so a drum hit is easy to see on a meter.
    let p = e.sample_alloc(0, 4800, 1).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 4800) }.fill(0.5);
    ok(e.sample_ready(0));
    e
}

/// Drum track `slot`: sample 0 on row 0, a hit on every beat.
fn drums(e: &mut Engine, slot: usize) {
    let s = slot as f64;
    ok(e.command(OP_ADD_DRUM_TRACK, s, 0.0, 0.0, 0.0));
    ok(e.command(OP_SET_ROW_SAMPLE, s, 0.0, 0.0, 0.0));
    for step in [0.0, 4.0, 8.0, 12.0] {
        ok(e.command(OP_SET_STEP, s, 0.0, step, 127.0));
    }
}

/// Synth track `slot`: MIDI In gate -> Out.l, one note held for the whole
/// 1-bar pattern minus a tick (so it is sounding most of the time).
fn synth(e: &mut Engine, slot: usize) {
    let s = slot as f64;
    let id = |k: ModuleKind| k as u32 as f64;
    ok(e.command(OP_ADD_SYNTH_TRACK, s, 0.0, 0.0, 0.0));
    ok(e.command(OP_RACK_ADD_MODULE, s, 0.0, id(ModuleKind::MidiIn), 0.0));
    ok(e.command(OP_RACK_ADD_MODULE, s, 1.0, id(ModuleKind::Out), 0.0));
    ok(e.command(OP_RACK_CONNECT, s, 1.0, 16.0, 0.0)); // gate -> Out.l
    ok(e.command(OP_SET_PATTERN_BARS, s, 1.0, 0.0, 0.0));
    let a = (slot * MAX_NOTES) as f64;
    ok(e.command(OP_NOTE_SET, a, (60 * 128 + 100) as f64, 0.0, 3839.0));
}

fn focus(e: &mut Engine, slot: f64) -> i32 {
    e.command(OP_SET_PATTERN_FOCUS, slot, 0.0, 0.0, 0.0)
}

/// Render `frames` (128-frame blocks); the loudest meter peak of each slot.
fn loudness(e: &mut Engine, frames: usize) -> [f32; MAX_TRACKS] {
    let mut peak = [0.0f32; MAX_TRACKS];
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    for _ in 0..frames.div_ceil(128) {
        e.process(&mut l, &mut r);
        for (slot, p) in peak.iter_mut().enumerate() {
            let m = &e.meters()[slot * MIX_METER_STRIDE..];
            *p = p.max(m[0]).max(m[1]);
        }
    }
    peak
}

/// One bar at 120 bpm / 48 kHz.
const BAR: usize = 96000;

#[test]
fn engine_default_is_no_focus_every_track_plays() {
    let mut e = eng();
    drums(&mut e, 0);
    synth(&mut e, 2);
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let m = loudness(&mut e, BAR);
    assert!(m[0] > 0.1 && m[2] > 0.1, "both play: {} {}", m[0], m[2]);
}

#[test]
fn focused_slot_plays_others_are_silent() {
    for f in [0usize, 2] {
        let mut e = eng();
        drums(&mut e, 0);
        drums(&mut e, 1);
        synth(&mut e, 2);
        ok(focus(&mut e, f as f64));
        ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
        let m = loudness(&mut e, BAR);
        for (slot, &peak) in m.iter().enumerate().take(3) {
            if slot == f {
                assert!(peak > 0.1, "focus {f}: slot {slot} plays ({peak})");
            } else {
                assert_eq!(peak, 0.0, "focus {f}: slot {slot} is silent");
            }
        }
    }
}

#[test]
fn no_focus_255_plays_every_track() {
    let mut e = eng();
    drums(&mut e, 0);
    synth(&mut e, 2);
    ok(focus(&mut e, 0.0));
    ok(focus(&mut e, 255.0)); // back to all tracks
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let m = loudness(&mut e, BAR);
    assert!(m[0] > 0.1 && m[2] > 0.1, "both play: {} {}", m[0], m[2]);
}

#[test]
fn moving_the_focus_releases_the_old_tracks_notes() {
    // The synth on slot 2 holds its note when the focus moves to the drums:
    // the note is released at once (no stuck note), the drums start.
    let mut e = eng();
    drums(&mut e, 0);
    synth(&mut e, 2);
    ok(focus(&mut e, 2.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    loudness(&mut e, BAR / 4);
    assert_ne!(e.synths.sequenced_sounding(2), 0, "the note is held");
    ok(focus(&mut e, 0.0));
    assert_eq!(e.synths.sequenced_sounding(2), 0, "released by the focus change");
    loudness(&mut e, 256); // the release reaches the rack
    let m = loudness(&mut e, 2 * BAR);
    assert_eq!(m[2], 0.0, "the synth stays silent");
    assert!(m[0] > 0.1, "the drums play");
    // And back: the synth plays again from its next note on.
    ok(focus(&mut e, 2.0));
    let m = loudness(&mut e, 2 * BAR);
    assert!(m[2] > 0.1, "the synth plays again");
}

#[test]
fn moving_the_focus_fades_the_old_drum_tracks_ringing_hit() {
    // Slot 1's beat-1 hit (a 100 ms sample) is still ringing when the focus
    // moves to slot 0: it fades out (2 ms) instead of ringing on.
    let mut e = eng();
    drums(&mut e, 0);
    drums(&mut e, 1);
    ok(focus(&mut e, 1.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let m = loudness(&mut e, 1024); // ~21 ms: the hit rings for 100 ms
    assert!(m[1] > 0.1, "slot 1 rings ({})", m[1]);
    ok(focus(&mut e, 0.0));
    loudness(&mut e, 256); // the 2 ms (96-sample) fade
    let m = loudness(&mut e, 1024);
    assert_eq!(m[1], 0.0, "slot 1's hit faded with the focus change");
    // Slot 0 has no hit before beat 2: nothing of it was faded or started.
    assert_eq!(m[0], 0.0);
}

#[test]
fn the_same_focus_again_keeps_the_ringing_hit() {
    let mut e = eng();
    drums(&mut e, 1);
    ok(focus(&mut e, 1.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    loudness(&mut e, 1024);
    ok(focus(&mut e, 1.0));
    let m = loudness(&mut e, 1024);
    assert!(m[1] > 0.1, "re-sending the focus leaves the hit ringing ({})", m[1]);
}

#[test]
fn the_same_focus_again_keeps_the_held_note() {
    let mut e = eng();
    synth(&mut e, 2);
    ok(focus(&mut e, 2.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    loudness(&mut e, BAR / 4);
    let held = e.synths.sequenced_sounding(2);
    assert_ne!(held, 0);
    ok(focus(&mut e, 2.0));
    assert_eq!(e.synths.sequenced_sounding(2), held, "re-sending the focus changes nothing");
}

#[test]
fn song_mode_ignores_the_focus() {
    // Clips on both tracks; with the focus on slot 0, Song mode plays both.
    let mut e = eng();
    drums(&mut e, 0);
    synth(&mut e, 2);
    for slot in [0usize, 2] {
        let a = (slot * crate::MAX_CLIPS) as f64;
        ok(e.command(OP_CLIP_SET, a, 0.0, 0.0, 3840.0));
    }
    ok(focus(&mut e, 0.0));
    ok(e.command(OP_SET_MODE, 1.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let m = loudness(&mut e, BAR);
    assert!(m[0] > 0.1 && m[2] > 0.1, "both play in Song mode: {} {}", m[0], m[2]);
}

#[test]
fn live_input_ignores_the_focus() {
    // The focus is on the drums; live notes on the synth (the input track)
    // still sound.
    let mut e = eng();
    drums(&mut e, 0);
    synth(&mut e, 2);
    ok(e.command(OP_NOTE_CLEAR, 2.0, 0.0, 0.0, 0.0));
    ok(focus(&mut e, 0.0));
    ok(e.command(OP_SET_INPUT_TRACK, 2.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_NOTE_ON, 64.0, 100.0, 0.0, 0.0));
    let m = loudness(&mut e, BAR / 4);
    assert!(m[2] > 0.1, "the live note sounds ({})", m[2]);
}

#[test]
fn reset_all_clears_the_focus() {
    let mut e = eng();
    ok(focus(&mut e, 5.0));
    ok(e.command(OP_RESET_ALL, 0.0, 0.0, 0.0, 0.0));
    let p = e.sample_alloc(0, 4800, 1).unwrap();
    unsafe { std::slice::from_raw_parts_mut(p, 4800) }.fill(0.5);
    ok(e.sample_ready(0));
    ok(e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0));
    drums(&mut e, 0);
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let m = loudness(&mut e, BAR);
    assert!(m[0] > 0.1, "slot 0 plays: the focus went back to none");
}

#[test]
fn bad_focus_is_rejected() {
    let mut e = eng();
    assert_eq!(focus(&mut e, MAX_TRACKS as f64), ERR_BAD_INDEX);
    assert_eq!(focus(&mut e, -1.0), ERR_BAD_INDEX);
    assert_eq!(focus(&mut e, 0.5), ERR_BAD_INDEX);
    assert_eq!(focus(&mut e, f64::NAN), ERR_BAD_INDEX);
}
