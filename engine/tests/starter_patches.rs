//! No starter patch may hard-clip the master bus with one track playing
//! (plan-2 final review I2).
//!
//! The patches live in TS (`app/src/state/patches.ts`). Rather than parse
//! them here (that would need serde or a hand-rolled TS/JSON parser), the
//! vitest `app/src/state/patches.fixture.test.ts` records the exact command
//! list the UI sends for each patch (`addSynthTrack` on a fresh project) into
//! `tests/fixtures/starter_patches.txt` ("op a b c d" per line) and fails if
//! the fixture is stale. This test replays that list through
//! `Engine::command`, which is the real UI-to-engine path.
//!
//! Measuring the pre-clamp peak: the master stage is
//! `clamp(sum × master_gain, -1, 1)` with `master_gain` 0.8 by default. The
//! test sets master gain to 0.1 instead, so the output is exactly 1/8 of the
//! default pre-clamp signal and stays far from the clamp (it is unclipped for
//! any pre-clamp peak below 8); `8 × output peak` is the pre-clamp peak at the
//! default gain. It must stay below 0.9.
//!
//! Notes: poly patches get several 4-note chords (Pad, with its long release
//! that overlaps chord changes, gets 5 notes); mono patches get 1 note
//! (a chord on a mono patch just plays its last note).

use daw_engine::engine::Engine;
use daw_engine::protocol::{OP_NOTE_OFF, OP_NOTE_ON, OP_SET_MASTER_GAIN, OK};

const SR: f32 = 48000.0;
const BLOCK: usize = 128;
const FIXTURE: &str = include_str!("fixtures/starter_patches.txt");
/// Allowed pre-clamp peak at the default master gain (0.8).
const LIMIT: f32 = 0.9;

/// (patch name, command list) per `patch` block of the fixture.
fn patches() -> Vec<(String, Vec<[f64; 5]>)> {
    let mut out: Vec<(String, Vec<[f64; 5]>)> = Vec::new();
    for line in FIXTURE.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix("patch ") {
            out.push((name.to_string(), Vec::new()));
            continue;
        }
        let nums: Vec<f64> = line.split_whitespace().map(|x| x.parse().expect("number")).collect();
        assert_eq!(nums.len(), 5, "bad fixture line {line:?}");
        out.last_mut().expect("command before first patch").1.push([nums[0], nums[1], nums[2], nums[3], nums[4]]);
    }
    out
}

/// Render `frames` and return the output peak (both channels).
fn render(e: &mut Engine, frames: usize) -> f32 {
    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    let mut peak = 0.0f32;
    for _ in 0..frames.div_ceil(BLOCK) {
        e.process(&mut l, &mut r);
        peak = l.iter().chain(&r).fold(peak, |m, x| m.max(x.abs()));
    }
    peak
}

/// Pre-clamp peak (at master 0.8) of `notes` held on `cmds`' patch for
/// `hold` seconds, then released for 1 s.
fn peak(cmds: &[[f64; 5]], notes: &[u8], hold: f32) -> f32 {
    let mut e = Engine::new(SR);
    for c in cmds {
        assert_eq!(e.command(c[0] as u32, c[1], c[2], c[3], c[4]), OK, "{c:?}");
    }
    assert_eq!(e.command(OP_SET_MASTER_GAIN, 0.1, 0., 0., 0.), OK);
    render(&mut e, BLOCK * 8); // let the load's declick fade-in finish
    for &n in notes {
        assert_eq!(e.command(OP_NOTE_ON, n as f64, 127., 0., 0.), OK);
    }
    let mut p = render(&mut e, (hold * SR) as usize);
    for &n in notes {
        assert_eq!(e.command(OP_NOTE_OFF, n as f64, 0., 0., 0.), OK);
    }
    p = p.max(render(&mut e, SR as usize));
    assert!(p < 0.99, "output {p} reached the clamp: can't measure");
    8.0 * p
}

#[test]
fn starter_patches_do_not_clip() {
    let all = patches();
    assert_eq!(all.len(), 5, "fixture has every starter patch");
    let chords4: [&[u8]; 4] = [
        &[48, 52, 55, 59], // Cmaj7, low
        &[60, 64, 67, 71], // Cmaj7, middle
        &[36, 48, 55, 60], // open fifths/octaves (most coherent)
        &[57, 60, 64, 69], // Am
    ];
    let chords5: [&[u8]; 3] = [&[48, 52, 55, 59, 62], &[36, 48, 55, 60, 64], &[57, 60, 64, 67, 72]];
    let mut failed = Vec::new();
    for (name, cmds) in &all {
        let (chords, hold): (&[&[u8]], f32) = match name.as_str() {
            "Pad" => (&chords5, 2.0),
            "Chord Stab" | "Pluck" => (&chords4, 1.0),
            "Deep Bass" | "Lead" => (&[&[36], &[48], &[60], &[72]], 1.0),
            other => panic!("unknown starter patch {other:?}: add it here"),
        };
        let worst = chords.iter().map(|c| peak(cmds, c, hold)).fold(0.0f32, f32::max);
        eprintln!("{name}: pre-clamp peak {worst:.3}");
        assert!(worst > 0.1, "{name} is (nearly) silent: {worst}");
        if worst >= LIMIT {
            failed.push(format!("{name} {worst:.3}"));
        }
    }
    assert!(failed.is_empty(), "pre-clamp peak >= {LIMIT}: {failed:?}");
}
