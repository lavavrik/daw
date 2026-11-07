//! Audio tracks and audio clips (plan 9): chase, declick, staging, sample
//! generations and the sample budget. Exact frames: no limiter lookahead,
//! 120 bpm at 48 kHz (25 samples per tick), and the track's own (pre-fader)
//! buffer is read back after every block.

use super::*;
use crate::protocol::*;

const SR: f32 = 48000.0;
/// Samples per tick at 120 bpm / 48 kHz.
const SPT: f64 = 25.0;
/// The 2 ms declick fade, in frames.
const F: usize = 96;
/// The 5 ms gain ramp, in frames.
const RAMP: usize = 240;
const BLOCK: usize = 128;

fn ok(code: i32) {
    assert_eq!(code, OK);
}

/// A 120 bpm engine in Song mode (no limiter lookahead).
fn song_engine() -> Engine {
    let mut e = Engine::with_lookahead(SR, 0.0);
    ok(e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_SET_MODE, 1.0, 0.0, 0.0, 0.0));
    e
}

/// Load sample `id` (ready): channel `c` frame `i` is `f(c, i)`. Returns the
/// planar data.
fn load(e: &mut Engine, id: u32, frames: usize, channels: usize, f: impl Fn(usize, usize) -> f32) -> Vec<f32> {
    let p = e.sample_alloc(id, frames as u32, channels as u32).unwrap();
    let data = unsafe { std::slice::from_raw_parts_mut(p, frames * channels) };
    for c in 0..channels {
        for i in 0..frames {
            data[c * frames + i] = f(c, i);
        }
    }
    ok(e.sample_ready(id));
    data.to_vec()
}

/// A ramp whose value names its frame: L = (i + 1) µ, R = −L / 2.
fn ramp(c: usize, i: usize) -> f32 {
    let v = (i as f32 + 1.0) * 1e-6;
    if c == 0 {
        v
    } else {
        -v * 0.5
    }
}

fn load_ramp(e: &mut Engine, id: u32, frames: usize, channels: usize) -> Vec<f32> {
    load(e, id, frames, channels, ramp)
}

fn load_const(e: &mut Engine, id: u32, frames: usize, v: f32) {
    load(e, id, frames, 1, |_, _| v);
}

fn add_audio(e: &mut Engine, slot: usize) {
    ok(e.command(OP_ADD_AUDIO_TRACK, slot as f64, 0.0, 0.0, 0.0));
}

/// One clip edit as the UI sends it: SOURCE, GAIN, SET. Returns the first
/// failing code (or OK).
#[allow(clippy::too_many_arguments)]
fn clip(
    e: &mut Engine,
    slot: usize,
    idx: usize,
    sample: f64,
    offset_secs: f64,
    looped: bool,
    gain: f64,
    fades: (u32, u32),
    start: u32,
    len: u32,
) -> i32 {
    let a = (slot * MAX_CLIPS_USIZE + idx) as f64;
    for code in [
        e.command(OP_AUDIO_CLIP_SOURCE, a, sample, offset_secs, if looped { 1.0 } else { 0.0 }),
        e.command(OP_AUDIO_CLIP_GAIN, a, gain, fades.0 as f64, fades.1 as f64),
        e.command(OP_AUDIO_CLIP_SET, a, start as f64, len as f64, 0.0),
    ] {
        if code != OK {
            return code;
        }
    }
    OK
}

const MAX_CLIPS_USIZE: usize = crate::MAX_CLIPS;

fn addr(slot: usize, idx: usize) -> f64 {
    (slot * MAX_CLIPS_USIZE + idx) as f64
}

/// What `frames` (whole blocks) rendered: track `slot`'s raw L/R and the
/// master output L.
struct Rec {
    l: Vec<f32>,
    r: Vec<f32>,
    out: Vec<f32>,
}

fn run(e: &mut Engine, slot: usize, frames: usize) -> Rec {
    let mut rec = Rec { l: Vec::new(), r: Vec::new(), out: Vec::new() };
    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    for _ in 0..frames.div_ceil(BLOCK) {
        e.process(&mut l, &mut r);
        let (tl, tr) = e.tracks.pair(slot, BLOCK).unwrap();
        rec.l.extend_from_slice(tl);
        rec.r.extend_from_slice(tr);
        rec.out.extend_from_slice(&l);
    }
    rec
}

/// Largest sample-to-sample step of `xs`, starting from `prev`.
fn max_step(prev: f32, xs: &[f32]) -> f32 {
    let mut last = prev;
    let mut m = 0.0f32;
    for &x in xs {
        m = m.max((x - last).abs());
        last = x;
    }
    m
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() <= 1e-7
}

#[test]
fn audio_clip_plays_file_at_start() {
    let mut e = song_engine();
    let data = load_ramp(&mut e, 0, 48000, 2);
    let frames = 48000;
    add_audio(&mut e, 2);
    ok(clip(&mut e, 2, 0, 0.0, 0.0, false, 0.5, (0, 0), 3840, 3840));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let at = (3840.0 * SPT) as usize; // 96000: bar 2
    let rec = run(&mut e, 2, at + 1280);
    assert!(rec.l[..at].iter().all(|&x| x == 0.0), "silent before the clip");
    // Unfaded: the first frame is the file's first sample times the gain.
    assert_eq!(rec.l[at], data[0] * 0.5);
    assert_eq!(rec.r[at], data[frames] * 0.5);
    for k in 0..1280 {
        assert_eq!(rec.l[at + k], data[k] * 0.5, "L frame {k}");
        assert_eq!(rec.r[at + k], data[frames + k] * 0.5, "R frame {k}");
    }
    assert!(rec.out[at..].iter().any(|&x| x != 0.0), "audible through its strip");

    // A mono file plays the same signal on L and R.
    let mut e = song_engine();
    let mono = load_ramp(&mut e, 1, 1000, 1);
    add_audio(&mut e, 3);
    ok(clip(&mut e, 3, 0, 1.0, 0.0, false, 1.0, (0, 0), 0, 3840));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 3, 1280);
    assert_eq!(rec.l[0], mono[0]);
    assert_eq!(rec.l, rec.r, "mono: L == R");
}

#[test]
fn audio_clip_chases_after_seek_and_wrap() {
    let mut e = song_engine();
    let data = load_ramp(&mut e, 0, 96000, 1);
    add_audio(&mut e, 0);
    // Offset 0.1 s = 4800 frames; the clip spans bars 2-3.
    ok(clip(&mut e, 0, 0, 0.0, 0.1, false, 1.0, (0, 0), 3840, 7680));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    assert!(rec.l.iter().all(|&x| x == 0.0));
    // Seek into the clip while playing: file frame 4800 + 1000 ticks * 25.
    ok(e.command(OP_SEEK, 4840.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    let p = 4800 + 1000 * 25;
    assert_eq!(rec.l[0], 0.0, "a chased start fades in from 0");
    for k in 0..F {
        assert!(rec.l[k] >= 0.0 && rec.l[k] <= data[p + k], "fade-in frame {k}");
    }
    for k in F..1280 {
        assert_eq!(rec.l[k], data[p + k], "after the fade-in, frame {k}");
    }

    // A loop whose start lies inside the clip: Play mid-clip chases, and
    // every wrap chases again to the loop start's file frame.
    ok(e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_SEEK, 4500.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_SET_LOOP, 5000.0, 6000.0, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let w = (1500.0 * SPT) as usize; // the wrap frame
    let rec = run(&mut e, 0, w + 2560);
    let p0 = 4800 + 660 * 25;
    for k in F..w {
        assert_eq!(rec.l[k], data[p0 + k], "before the wrap, frame {k}");
    }
    let p1 = 4800 + 1160 * 25;
    for k in F..2560 {
        assert_eq!(rec.l[w + k], data[p1 + k], "after the wrap, frame {k}");
    }
    assert!(max_step(rec.l[w - 1], &rec.l[w..w + F]) < 0.001, "the wrap is declicked");
}

#[test]
fn audio_clip_edges_are_declicked() {
    const V: f32 = 0.8;
    let limit = 0.01;
    let setup = || {
        let mut e = song_engine();
        load_const(&mut e, 0, 480000, V);
        add_audio(&mut e, 0);
        ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 3840));
        e
    };
    // The clip end: the fade ends exactly at the end (frame 96000).
    let mut e = setup();
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 96000 + 1280);
    assert_eq!(rec.l[0], V, "a start at file position 0 is unfaded");
    assert!(max_step(rec.l[0], &rec.l[1..]) <= limit, "clip end");
    assert!(rec.l[95999] > 0.0 && rec.l[95999] < limit);
    assert!(rec.l[96000..].iter().all(|&x| x == 0.0));
    assert_eq!(rec.l[96000 - F - 1], V);

    // A chased start (Play mid-clip), then Stop.
    let mut e = setup();
    ok(e.command(OP_SEEK, 1000.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    assert!(max_step(0.0, &rec.l) <= limit, "chased start");
    assert!(rec.l[F..].iter().all(|&x| x == V));
    ok(e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    assert!(max_step(V, &rec.l) <= limit, "Stop");
    assert!(rec.l[0] > V - limit, "Stop holds the last sample, then fades");
    assert!(rec.l[F..].iter().all(|&x| x == 0.0));

    // CLIP_REMOVE while sounding.
    let mut e = setup();
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    run(&mut e, 0, 1280);
    ok(e.command(OP_CLIP_REMOVE, addr(0, 0), 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    assert!(max_step(V, &rec.l) <= limit, "CLIP_REMOVE");
    assert!(rec.l[F..].iter().all(|&x| x == 0.0));

    // A seek inside the clip (cut + chase cross over) and one out of it.
    let mut e = setup();
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    run(&mut e, 0, 1280);
    ok(e.command(OP_SEEK, 2000.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    assert!(max_step(V, &rec.l) <= limit, "seek inside the clip");
    assert!(rec.l.iter().all(|&x| (x - V).abs() < 1e-5), "the cut and the chase cross over");
    ok(e.command(OP_SEEK, 7680.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    assert!(max_step(V, &rec.l) <= limit, "seek out of the clip");
    assert!(rec.l[F..].iter().all(|&x| x == 0.0));
}

#[test]
fn loop_clip_repeats_file() {
    let mut e = song_engine();
    let data = load_ramp(&mut e, 0, 1000, 1);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, true, 1.0, (0, 0), 0, 3840));
    // Offset 500 frames: plays (500 + k) mod 1000.
    add_audio(&mut e, 1);
    ok(clip(&mut e, 1, 0, 0.0, 500.0 / 48000.0, true, 1.0, (0, 0), 0, 3840));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let (mut a, mut b) = (Vec::new(), Vec::new());
    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    for _ in 0..(96000 / BLOCK) {
        e.process(&mut l, &mut r);
        a.extend_from_slice(e.tracks.pair(0, BLOCK).unwrap().0);
        b.extend_from_slice(e.tracks.pair(1, BLOCK).unwrap().0);
    }
    for k in 0..96000 - F {
        assert_eq!(a[k], data[k % 1000], "loop frame {k}: the seam is not faded");
    }
    // The trimmed start is not file position 0: it fades in.
    assert_eq!(b[0], 0.0);
    for k in F..96000 - F {
        assert_eq!(b[k], data[(500 + k) % 1000], "offset loop frame {k}");
    }
}

#[test]
fn non_loop_clip_silent_after_file_end() {
    let mut e = song_engine();
    let data = load_ramp(&mut e, 0, 1000, 1);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 3840));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 96000 + 1280);
    assert_eq!(rec.l[..1000 - F], data[..1000 - F]);
    assert!(rec.l[999] > 0.0 && rec.l[999] < data[999], "the file end is declicked");
    assert!(rec.l[1000..].iter().all(|&x| x == 0.0), "silent after the file end");
}

#[test]
fn tempo_change_mid_clip_does_not_jump() {
    let mut e = song_engine();
    let data = load_ramp(&mut e, 0, 96000, 1);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let mut got = run(&mut e, 0, 1280).l;
    ok(e.command(OP_SET_TEMPO, 97.0, 0.0, 0.0, 0.0));
    got.extend(run(&mut e, 0, 1280).l);
    ok(e.command(OP_SET_TEMPO, 171.0, 0.0, 0.0, 0.0));
    got.extend(run(&mut e, 0, 1280).l);
    for (k, &x) in got.iter().enumerate() {
        assert_eq!(x, data[k], "frame {k}: the voice advances by frames, never by ticks");
    }

    // A file that ended stays ended when a faster tempo maps the song
    // position back inside it (51.2 ticks are file frame 512 at 300 bpm):
    // no re-chase without a jump.
    let mut e = song_engine();
    load_ramp(&mut e, 0, 1000, 1);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    run(&mut e, 0, 1280);
    ok(e.command(OP_SET_TEMPO, 300.0, 0.0, 0.0, 0.0));
    assert!(run(&mut e, 0, 2560).l.iter().all(|&x| x == 0.0));
}

#[test]
fn resize_right_or_gain_change_keeps_voice() {
    let mut e = song_engine();
    let data = load_ramp(&mut e, 0, 96000, 1);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 7680));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    assert_eq!(rec.l[..], data[..1280]);
    let mut at = 1280;
    // Only the length: the voice plays on, unfaded.
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 4840));
    let rec = run(&mut e, 0, 1280);
    assert_eq!(rec.l[..], data[at..at + 1280], "a resize is not a jump");
    at += 1280;
    // Only the gain: it ramps to 0.5 within 5 ms, the voice plays on.
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 0.5, (0, 0), 0, 4840));
    let rec = run(&mut e, 0, 1280);
    let ratio: Vec<f32> = (0..1280).map(|k| rec.l[k] / data[at + k]).collect();
    assert!(ratio[0] > 0.99, "no re-chase: no fade from 0 ({})", ratio[0]);
    assert!(ratio.windows(2).all(|w| w[1] <= w[0] + 1e-6), "monotone ramp");
    assert!(ratio[RAMP - 2] > 0.5 + 1e-4, "a ramp, not a step");
    for (k, &q) in ratio.iter().enumerate().skip(RAMP) {
        assert!((q - 0.5).abs() < 1e-5, "frame {k}: at the target after 5 ms ({q})");
    }
    at += 1280;
    // Only the fades (none reach the playhead): the voice plays on.
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 0.5, (0, 960), 0, 4840));
    let rec = run(&mut e, 0, 1280);
    for k in 0..1280 {
        assert!(close(rec.l[k], data[at + k] * 0.5), "fades only, frame {k}");
    }
    at += 1280;
    // The offset changes what plays: a chase to 0.5 s + elapsed.
    ok(clip(&mut e, 0, 0, 0.0, 0.5, false, 0.5, (0, 960), 0, 4840));
    let rec = run(&mut e, 0, 1280);
    for k in F..1280 {
        assert_eq!(rec.l[k], data[24000 + at + k] * 0.5, "chased to the new offset, frame {k}");
    }

    // Fade handles and the end dragged across the playhead keep the voice
    // and blend the envelope over 5 ms: no step (a constant 0.8 file).
    const V: f32 = 0.8;
    let setup = || {
        let mut e = song_engine();
        load_const(&mut e, 0, 480000, V);
        add_audio(&mut e, 0);
        ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
        ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
        let rec = run(&mut e, 0, 1280); // the playhead is at tick 51.2
        assert!(rec.l.iter().all(|&x| x == V));
        e
    };
    // The end moved to tick 200 with a fade-out from tick 10: the playhead is
    // now 78 % into the fade-out. It blends there, then fades to the end.
    let mut e = setup();
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 190), 0, 200));
    let rec = run(&mut e, 0, 5120);
    assert!(max_step(V, &rec.l) <= 0.01, "fade-out and end moved: {}", max_step(V, &rec.l));
    let end = 200 * 25 - 1280; // frame of the clip end in this run
    assert!(rec.l[RAMP] < V * 0.8, "the new fade-out applies after the blend");
    assert!(rec.l[end..].iter().all(|&x| x == 0.0));
    // A fade-in handle dragged past the playhead, then again mid-blend.
    let mut e = setup();
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (100, 0), 0, 38400));
    let mut got = run(&mut e, 0, 128).l;
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (400, 0), 0, 38400));
    got.extend(run(&mut e, 0, 1280).l);
    assert!(max_step(V, &got) <= 0.01, "fade-in moved twice: {}", max_step(V, &got));
    let k = 128 + RAMP + 10; // after both blends: on the new fade-in line
    let t = 51.2 + k as f64 / SPT;
    assert!((got[k] - V * (t / 400.0) as f32).abs() < 1e-4, "{} vs {}", got[k], V * (t / 400.0) as f32);
    // Back to no fades: blends up again.
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
    let rec = run(&mut e, 0, 1280);
    assert!(max_step(*got.last().unwrap(), &rec.l) <= 0.01);
    assert!(rec.l[RAMP..].iter().all(|&x| x == V));
}

#[test]
fn clip_end_moved_inside_the_declick_fade_cuts_smoothly() {
    const V: f32 = 0.8;
    // A resize that puts the end 1 tick (25 frames < 2 ms) ahead.
    let mut e = song_engine();
    load_const(&mut e, 0, 480000, V);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    run(&mut e, 0, 1280); // tick 51.2
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 52));
    let rec = run(&mut e, 0, 1280);
    assert!(max_step(V, &rec.l) <= 0.01, "resize: {}", max_step(V, &rec.l));
    assert!(rec.l[F..].iter().all(|&x| x == 0.0));
    // A faster tempo that brings the end inside 2 ms: 3 ticks ahead is 75
    // frames at 120 bpm, 30 at 300 bpm. (At tick 51.2 the end at 55 is 95
    // frames ahead: the fade's first frame, not yet begun, at 120 bpm.)
    let mut e = song_engine();
    load_const(&mut e, 0, 480000, V);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 55));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let mut got = run(&mut e, 0, 1280).l;
    ok(e.command(OP_SET_TEMPO, 300.0, 0.0, 0.0, 0.0));
    got.extend(run(&mut e, 0, 1280).l);
    assert_eq!(got[0], V, "a start at file position 0 is unfaded");
    assert!(max_step(V, &got[1..]) <= 0.01, "tempo: {}", max_step(V, &got[1..]));
    assert!(got[1280 + F..].iter().all(|&x| x == 0.0));
    // The end extended while its fade runs (frame 1408 is 17 frames before
    // the end at tick 57): a cut and a re-chase, not a jump back to full.
    let mut e = song_engine();
    load_const(&mut e, 0, 480000, V);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 57));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let before = run(&mut e, 0, 1408).l;
    let last = *before.last().unwrap();
    assert!(last > 0.0 && last < V * 0.25, "inside the end fade ({last})");
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
    let rec = run(&mut e, 0, 1280);
    assert!(max_step(last, &rec.l) <= 0.01, "extended: {}", max_step(last, &rec.l));
    assert!(rec.l[F..].iter().all(|&x| x == V), "chased back in");
}

#[test]
fn finished_one_shot_chases_a_replaced_sample() {
    let mut e = song_engine();
    load_const(&mut e, 0, 1000, 0.8);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 2560);
    assert!(rec.l[1000..].iter().all(|&x| x == 0.0), "the file ended");
    // The same id now holds a longer file: the clip chases into it.
    let data = load_ramp(&mut e, 0, 96000, 1);
    let rec = run(&mut e, 0, 1280);
    assert_eq!(rec.l[0], 0.0);
    for k in F..1280 {
        assert_eq!(rec.l[k], data[2560 + k], "frame {k}");
    }
    // Ended again, then replaced by a sample not ready yet: chases once ready.
    let mut e = song_engine();
    load_const(&mut e, 0, 1000, 0.8);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    run(&mut e, 0, 2560);
    let p = e.sample_alloc(0, 96000, 1).unwrap();
    assert!(run(&mut e, 0, 1280).l.iter().all(|&x| x == 0.0));
    unsafe { std::slice::from_raw_parts_mut(p, 96000) }.fill(0.3);
    ok(e.sample_ready(0));
    let rec = run(&mut e, 0, 1280);
    assert!(rec.l[F..].iter().all(|&x| x == 0.3));
}

#[test]
fn clip_remove_resets_the_staged_edit() {
    let mut e = song_engine();
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 4, 1.0, 0.5, true, 0.25, (10, 20), 0, 3840));
    ok(e.command(OP_CLIP_REMOVE, addr(0, 4), 0.0, 0.0, 0.0));
    // A SET alone now commits the defaults, not the removed clip's edit.
    ok(e.command(OP_AUDIO_CLIP_SET, addr(0, 4), 0.0, 3840.0, 0.0));
    let c = e.audio.clip(0, 4).unwrap();
    assert_eq!(
        (c.active, c.sample, c.offset_frames, c.looped, c.gain, c.fade_in, c.fade_out),
        (true, None, 0, false, 1.0, 0, 0)
    );
}

#[test]
fn audio_clip_survives_sample_replace_and_reset() {
    let mut e = song_engine();
    load_const(&mut e, 0, 480000, 0.8);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    run(&mut e, 0, 1280);
    // Replaced (and ready) between blocks: the old voice holds and fades,
    // a new one chases into the new data.
    load_const(&mut e, 0, 480000, -0.5);
    let rec = run(&mut e, 0, 1280);
    assert!((rec.l[0] - 0.8).abs() < 1e-6, "holds the last sample ({})", rec.l[0]);
    assert!(max_step(0.8, &rec.l) <= 1.3 / F as f32 + 1e-4);
    assert!(rec.l[F..].iter().all(|&x| x == -0.5));
    // Replaced by one not ready yet: fades out, nothing is read.
    let p = e.sample_alloc(0, 480000, 1).unwrap();
    let rec = run(&mut e, 0, 1280);
    assert!(max_step(-0.5, &rec.l) <= 0.5 / F as f32 + 1e-4);
    assert!(rec.l[F..].iter().all(|&x| x == 0.0));
    unsafe { std::slice::from_raw_parts_mut(p, 480000) }.fill(0.25);
    ok(e.sample_ready(0));
    let rec = run(&mut e, 0, 1280);
    assert_eq!(rec.l[0], 0.0);
    assert!(rec.l[F..].iter().all(|&x| x == 0.25), "chases in once ready");

    // Engine reset: every clip and voice is gone; a reloaded project plays
    // its new data (the arena hands out the same slice again).
    ok(e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_RESET_ALL, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(e.kind(0), SlotKind::Empty);
    assert!(!e.audio.clip(0, 0).is_some_and(|c| c.active));
    assert!(run(&mut e, 0, 1280).l.iter().all(|&x| x == 0.0));
    ok(e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_SET_MODE, 1.0, 0.0, 0.0, 0.0));
    load_const(&mut e, 0, 480000, 0.3);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    assert!(rec.l.iter().all(|&x| x == 0.3));
}

#[test]
fn late_sample_chases_in() {
    let mut e = song_engine();
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 3.0, 0.0, false, 1.0, (0, 0), 0, 38400)); // sample 3: not loaded
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    assert!(run(&mut e, 0, 1280).l.iter().all(|&x| x == 0.0));
    // Uploaded while playing (fits the arena), not ready yet: still silent.
    let p = e.sample_alloc(3, 96000, 1).unwrap();
    let data: Vec<f32> = (0..96000).map(|i| ramp(0, i)).collect();
    unsafe { std::slice::from_raw_parts_mut(p, 96000) }.copy_from_slice(&data);
    assert!(run(&mut e, 0, 1280).l.iter().all(|&x| x == 0.0));
    ok(e.sample_ready(3));
    let rec = run(&mut e, 0, 1280);
    assert_eq!(rec.l[0], 0.0, "fades in");
    for k in F..1280 {
        assert_eq!(rec.l[k], data[2560 + k], "chased to the song position, frame {k}");
    }
}

#[test]
fn audio_clip_staging_is_atomic() {
    let mut e = song_engine();
    load_const(&mut e, 0, 480000, 0.8);
    load_const(&mut e, 1, 480000, 0.3);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    run(&mut e, 0, 1280);
    // Staged, not committed: nothing changes (neither this clip nor an
    // unused slot).
    ok(e.command(OP_AUDIO_CLIP_SOURCE, addr(0, 0), 1.0, 0.0, 0.0));
    ok(e.command(OP_AUDIO_CLIP_GAIN, addr(0, 0), 0.25, 0.0, 0.0));
    ok(e.command(OP_AUDIO_CLIP_SOURCE, addr(0, 7), 1.0, 0.0, 0.0));
    ok(e.command(OP_AUDIO_CLIP_GAIN, addr(0, 7), 0.25, 0.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    assert!(rec.l.iter().all(|&x| x == 0.8));
    assert!(!e.audio.clip(0, 7).is_some_and(|c| c.active));
    // SET applies both at once.
    ok(e.command(OP_AUDIO_CLIP_SET, addr(0, 0), 0.0, 38400.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    assert!(rec.l[F..].iter().all(|&x| x == 0.3 * 0.25), "{}", rec.l[F]);
    let c = e.audio.clip(0, 0).unwrap();
    assert_eq!((c.sample, c.gain), (Some(1), 0.25));
}

#[test]
fn pattern_mode_audio_tracks_are_silent() {
    let mut e = song_engine();
    ok(e.command(OP_SET_MODE, 0.0, 0.0, 0.0, 0.0));
    load_const(&mut e, 0, 480000, 0.8);
    add_audio(&mut e, 0);
    ok(clip(&mut e, 0, 0, 0.0, 0.0, false, 1.0, (0, 0), 0, 38400));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    assert!(run(&mut e, 0, 2560).l.iter().all(|&x| x == 0.0));
    ok(e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_SET_MODE, 1.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    assert!(run(&mut e, 0, 1280).l.iter().all(|&x| x == 0.8));
    // Song -> Pattern while playing: a 2 ms fade, then silence.
    ok(e.command(OP_SET_MODE, 0.0, 0.0, 0.0, 0.0));
    let rec = run(&mut e, 0, 1280);
    assert!(max_step(0.8, &rec.l) <= 0.01);
    assert!(rec.l[F..].iter().all(|&x| x == 0.0));
}

#[test]
fn audio_clip_commands_validate() {
    let mut e = song_engine();
    ok(e.command(OP_ADD_DRUM_TRACK, 0.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_ADD_SYNTH_TRACK, 1.0, 0.0, 0.0, 0.0));
    add_audio(&mut e, 2);
    // Audio-clip ops on a non-Audio slot (drum, synth, empty).
    for slot in [0, 1, 3] {
        let a = addr(slot, 0);
        assert_eq!(e.command(OP_AUDIO_CLIP_SOURCE, a, 0.0, 0.0, 0.0), ERR_BAD_INDEX, "slot {slot}");
        assert_eq!(e.command(OP_AUDIO_CLIP_GAIN, a, 1.0, 0.0, 0.0), ERR_BAD_INDEX, "slot {slot}");
        assert_eq!(e.command(OP_AUDIO_CLIP_SET, a, 0.0, 3840.0, 0.0), ERR_BAD_INDEX, "slot {slot}");
    }
    let a = addr(2, 255);
    let song = crate::MAX_SONG_TICKS as f64;
    // Decode-level checks.
    assert_eq!(e.command(OP_AUDIO_CLIP_SOURCE, addr(32, 0), 0.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(e.command(OP_AUDIO_CLIP_SOURCE, a, 256.0, 0.0, 0.0), ERR_BAD_INDEX, "sample id");
    assert_eq!(e.command(OP_AUDIO_CLIP_SOURCE, a, -2.0, 0.0, 0.0), ERR_BAD_INDEX, "sample id");
    for bad in [-0.001, f64::NAN, f64::INFINITY] {
        assert_eq!(e.command(OP_AUDIO_CLIP_SOURCE, a, 0.0, bad, 0.0), ERR_BAD_VALUE, "offset {bad}");
    }
    assert_eq!(e.command(OP_AUDIO_CLIP_SOURCE, a, 0.0, 0.0, 0.5), ERR_BAD_VALUE, "loop flag");
    for bad in [-0.1, 4.01, f64::NAN] {
        assert_eq!(e.command(OP_AUDIO_CLIP_GAIN, a, bad, 0.0, 0.0), ERR_BAD_VALUE, "gain {bad}");
    }
    assert_eq!(e.command(OP_AUDIO_CLIP_GAIN, a, 1.0, -1.0, 0.0), ERR_BAD_VALUE);
    assert_eq!(e.command(OP_AUDIO_CLIP_GAIN, a, 1.0, 0.0, 0.5), ERR_BAD_VALUE);
    assert_eq!(e.command(OP_AUDIO_CLIP_SET, a, song, 1.0, 0.0), ERR_BAD_VALUE, "start at the song end");
    assert_eq!(e.command(OP_AUDIO_CLIP_SET, a, 1.0, song, 0.0), ERR_BAD_VALUE, "past the song end");
    assert_eq!(e.command(OP_AUDIO_CLIP_SET, a, 0.0, 0.0, 0.0), ERR_BAD_VALUE, "length 0");
    // An offset beyond MAX_SAMPLE_FLOATS frames (at the engine's rate).
    let too_far = (crate::MAX_SAMPLE_FLOATS as f64 + 1.0) / SR as f64;
    assert_eq!(e.command(OP_AUDIO_CLIP_SOURCE, a, 0.0, too_far, 0.0), ERR_BAD_VALUE);
    ok(e.command(OP_AUDIO_CLIP_SOURCE, a, -1.0, crate::MAX_SAMPLE_FLOATS as f64 / SR as f64, 1.0));
    // Fades longer than the clip are refused at SET, which changes nothing.
    ok(e.command(OP_AUDIO_CLIP_GAIN, a, 4.0, 2000.0, 1841.0));
    assert_eq!(e.command(OP_AUDIO_CLIP_SET, a, 0.0, 3840.0, 0.0), ERR_BAD_VALUE, "fadeIn + fadeOut > len");
    assert!(!e.audio.clip(2, 255).is_some_and(|c| c.active));
    ok(e.command(OP_AUDIO_CLIP_GAIN, a, 4.0, 2000.0, 1840.0));
    ok(e.command(OP_AUDIO_CLIP_SET, a, 0.0, 3840.0, 0.0));
    assert_eq!(e.command(OP_AUDIO_CLIP_SET, a, song - 1.0, 1.0, 0.0), ERR_BAD_VALUE, "the staged fades > 1 tick");
    ok(e.command(OP_AUDIO_CLIP_SET, a, song - 3840.0, 3840.0, 0.0)); // ends exactly at the song end
    // Drum, rack and pattern commands on an Audio slot.
    assert_eq!(e.command(OP_SET_ROW_SAMPLE, 2.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(e.command(OP_SET_STEP, 2.0, 0.0, 0.0, 100.0), ERR_BAD_INDEX);
    assert_eq!(e.command(OP_SET_SWING, 2.0, 0.5, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(e.command(OP_SET_ROW_MUTE, 2.0, 0.0, 1.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(e.command(OP_RACK_ADD_MODULE, 2.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(e.command(OP_RACK_CLEAR, 2.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(e.command(OP_NOTE_CLEAR, 2.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(e.command(OP_SET_CURRENT_PATTERN, 2.0, 1.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(e.command(OP_COPY_PATTERN, 2.0, 0.0, 1.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(e.command(OP_CLEAR_PATTERN_DATA, 2.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
    assert_eq!(e.command(OP_CLIP_SET, addr(2, 0), 0.0, 0.0, 3840.0), ERR_BAD_INDEX, "a pattern clip");
    // CLIP_REMOVE / CLIP_CLEAR accept Audio slots; the strip and a whole-
    // track key work unchanged.
    ok(e.command(OP_CLIP_REMOVE, a, 0.0, 0.0, 0.0));
    assert!(!e.audio.clip(2, 255).is_some_and(|c| c.active));
    ok(e.command(OP_CLIP_CLEAR, 2.0, 0.0, 0.0, 0.0));
    ok(e.command(OP_MIX_SET_KEY, 1.0, 2.0 * 32.0, 0.0, 0.0));
    assert_eq!(e.command(OP_MIX_SET_KEY, 1.0, 2.0 * 32.0 + 1.0, 0.0, 0.0), ERR_BAD_INDEX, "no rows");
    ok(e.command(OP_MIX_SET, 2.0, crate::mixer::catalog::P_FADER as f64, -6.0, 0.0));
    // Adding any track over an Audio slot clears its clips.
    ok(clip(&mut e, 2, 3, 0.0, 0.0, false, 1.0, (0, 0), 0, 3840));
    ok(e.command(OP_ADD_SYNTH_TRACK, 2.0, 0.0, 0.0, 0.0));
    assert!(!e.audio.clip(2, 3).is_some_and(|c| c.active));
    assert_eq!(e.kind(2), SlotKind::Synth);
    add_audio(&mut e, 2);
    ok(clip(&mut e, 2, 3, 0.0, 0.0, false, 1.0, (0, 0), 0, 3840));
    ok(e.command(OP_REMOVE_TRACK, 2.0, 0.0, 0.0, 0.0));
    assert!(!e.audio.clip(2, 3).is_some_and(|c| c.active));
    assert_eq!(e.kind(2), SlotKind::Empty);
    assert_eq!(e.command(OP_CLIP_REMOVE, addr(2, 0), 0.0, 0.0, 0.0), ERR_BAD_INDEX, "empty slot");
}

#[test]
fn arena_budget_refuses_past_the_limit() {
    let mut e = song_engine();
    e.arena = SampleArena::with_budget(1000, 3000);
    // Stopped: growing is allowed, but never past the budget.
    assert!(e.sample_alloc(0, 1000, 2).is_ok());
    assert_eq!(e.sample_alloc(1, 1001, 1), Err(ERR_OUT_OF_MEMORY));
    assert_eq!(e.telemetry()[TELEMETRY_LAST_ERROR], ERR_OUT_OF_MEMORY as f64);
    assert!(e.sample_alloc(1, 1000, 1).is_ok());
    assert_eq!(e.arena.allocated(), 3000);
    // Playing: over the budget is out of memory, not deferred.
    ok(e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(e.sample_alloc(2, 1, 1), Err(ERR_OUT_OF_MEMORY));
    // A replaced sample's old data still counts (it leaks until a reset).
    ok(e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(e.sample_alloc(0, 1, 1), Err(ERR_OUT_OF_MEMORY));
    ok(e.command(OP_RESET_ALL, 0.0, 0.0, 0.0, 0.0));
    assert_eq!(e.arena.allocated(), 0);
    assert!(e.sample_alloc(0, 1000, 2).is_ok());
    // The real budget: 1 GiB of floats.
    assert_eq!(crate::MAX_ARENA_FLOATS, 256 * 1024 * 1024);
    const { assert!(crate::MAX_ARENA_FLOATS > ARENA_FLOATS) };
}
