//! Native reference render for the WAV export (docs/architecture/export.md).
//!
//! The export Worker (`app/src/export/render.ts`) instantiates the same
//! engine compiled to WASM and renders a song through the C ABI. This test
//! renders the fixed job in `fixtures/export_render.txt` through the same C
//! ABI natively, with the identical block schedule, and checks the result
//! against the golden hash in `fixtures/export_render.hash`; the vitest
//! `render matches native` (app/src/export/render.test.ts) renders the same
//! job through `engine.wasm` and checks it against the same file. The audio
//! clip job `fixtures/export_audio.txt` (plan 9) is pinned the same way by
//! `export_audio.hash` and `audio render matches native`.
//!
//! Job (both sides): `engine_new(sample_rate)`; every `sample` line is
//! allocated, filled (planar) and marked ready; every `cmd` line is sent in
//! order; then `frames + engine_latency()` frames are rendered in
//! `engine_process` calls of `QUANTUM` = 128 frames (the AudioWorklet render
//! quantum the live worklet calls with; the last call shorter -- the Worker
//! groups them into 1024-frame blocks for progress, which is the same call
//! sequence because 1024 is a multiple of 128) and the first
//! `engine_latency()` frames (the limiter lookahead) are dropped. The hash is 32-bit FNV-1a
//! over the little-endian bytes of all left samples, then all right samples.
//!
//! Sample data is generated, not stored: an LCG (`x = x * 1664525 +
//! 1013904223 mod 2^32`, starting at the seed) per value, `v = ((x >> 16) -
//! 32768) * (frames - i) / (32768 * frames)` computed in f64 (exact integer
//! product, one correctly rounded division) and rounded to f32; channel 0's
//! frames first, then channel 1's, from one continuous LCG stream.
//!
//! Same math: on `wasm32-unknown-unknown`, `f32::sin`, `powf`, `exp2` etc.
//! are calls into compiler-builtins' copy of the pure-Rust `libm` crate;
//! natively they call the platform libm (Apple's here), whose results differ
//! in the last bit for some inputs (measured: ~3% of samples off by <= 2e-7,
//! from the first synth note on). So this test binary defines those C
//! symbols itself (`mod same_math_as_wasm`), forwarding to the same `libm`
//! version the toolchain's wasm std uses; the executable's own definitions
//! win at link time, so the engine code linked into this test computes
//! exactly what engine.wasm computes. With that the native and the WASM
//! render are bit-identical, and the golden hash is shared.
//!
//! After an intended change to the engine's output, regenerate with
//! `UPDATE_GOLDEN=1 cargo test -p daw-engine --test export_render`. If only
//! the WASM side disagrees after a Rust toolchain upgrade, the toolchain's
//! libm moved: set the `libm` dev-dependency in engine/Cargo.toml to the
//! version in `$(rustc --print sysroot)/lib/rustlib/src/rust/library/
//! compiler-builtins/libm/Cargo.toml`.

use daw_engine::ffi::*;

/// `ENGINE_QUANTUM` in app/src/export/render.ts.
const QUANTUM: usize = 128;
use std::path::PathBuf;

struct Job {
    sample_rate: f32,
    frames: usize,
    samples: Vec<(u32, u32, u32, u32)>, // id, frames, channels, seed
    commands: Vec<(u32, [f64; 4])>,
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn parse(text: &str) -> Job {
    let mut job = Job { sample_rate: 0.0, frames: 0, samples: Vec::new(), commands: Vec::new() };
    for line in text.lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        if w.is_empty() || w[0].starts_with('#') {
            continue;
        }
        let num = |i: usize| -> f64 { w[i].parse().unwrap_or_else(|_| panic!("bad number in {line:?}")) };
        match w[0] {
            "sample_rate" => job.sample_rate = num(1) as f32,
            "frames" => job.frames = num(1) as usize,
            "sample" => job.samples.push((num(1) as u32, num(2) as u32, num(3) as u32, num(4) as u32)),
            "cmd" => job.commands.push((num(1) as u32, [num(2), num(3), num(4), num(5)])),
            other => panic!("unknown fixture line {other:?}"),
        }
    }
    job
}

/// The generated sample data (see the module doc), planar.
pub fn sample_data(frames: u32, channels: u32, seed: u32) -> Vec<f32> {
    let mut x = seed;
    let mut out = Vec::with_capacity((frames * channels) as usize);
    for _ in 0..channels {
        for i in 0..frames {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            let v = ((x >> 16) as f64 - 32768.0) * (frames - i) as f64 / (32768.0 * frames as f64);
            out.push(v as f32);
        }
    }
    out
}

fn fnv1a(h: u32, bytes: &[u8]) -> u32 {
    bytes.iter().fold(h, |h, &b| (h ^ b as u32).wrapping_mul(16777619))
}

fn render(job: &Job, call: usize) -> (Vec<f32>, Vec<f32>) {
    let e = engine_new(job.sample_rate);
    for &(id, frames, channels, seed) in &job.samples {
        let data = sample_data(frames, channels, seed);
        let ptr = engine_sample_alloc(e, id, frames, channels);
        assert!(!ptr.is_null(), "sample {id} alloc");
        // SAFETY: the engine allocated frames * channels floats at `ptr`.
        unsafe { core::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len()) };
        assert_eq!(engine_sample_ready(e, id), 0, "sample {id} ready");
    }
    for (i, &(op, [a, b, c, d])) in job.commands.iter().enumerate() {
        // Like the live worklet, a refused command is not fatal; the fixture
        // should have none, though, so a refusal here means it went stale.
        assert_eq!(engine_command(e, op, a, b, c, d), 0, "command #{i} op {op} [{a} {b} {c} {d}]");
    }
    let latency = engine_latency(e) as usize;
    let total = job.frames + latency;
    let (mut left, mut right) = (Vec::with_capacity(total), Vec::with_capacity(total));
    let mut done = 0;
    while done < total {
        let n = (total - done).min(call);
        engine_process(e, n as u32);
        // SAFETY: the out buffers hold MAX_BLOCK (>= call) floats each.
        let (l, r) = unsafe {
            (core::slice::from_raw_parts(engine_out_left(e), n), core::slice::from_raw_parts(engine_out_right(e), n))
        };
        left.extend_from_slice(l);
        right.extend_from_slice(r);
        done += n;
    }
    drop(unsafe { Box::from_raw(e) });
    (left.split_off(latency), right.split_off(latency))
}

fn hash(left: &[f32], right: &[f32]) -> u32 {
    let mut h = 2166136261u32;
    for s in left.iter().chain(right) {
        h = fnv1a(h, &s.to_le_bytes());
    }
    h
}

/// Render `fixtures/<name>.txt` natively and check it against
/// `fixtures/<name>.hash` (`UPDATE_GOLDEN=1` writes the hash).
fn matches_golden(name: &str) {
    let job = parse(&std::fs::read_to_string(fixture(&format!("{name}.txt"))).expect("fixture"));
    assert!(job.frames > 0 && !job.commands.is_empty());
    let (l, r) = render(&job, QUANTUM);
    assert_eq!(l.len(), job.frames);
    let peak = l.iter().chain(&r).fold(0.0f32, |p, x| p.max(x.abs()));
    assert!(peak > 0.01, "the reference render is not silent (peak {peak})");
    assert!(l.iter().chain(&r).all(|x| x.is_finite()));

    let got = format!("{:08x}", hash(&l, &r));
    let golden = fixture(&format!("{name}.hash"));
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(&golden, format!("{got}\n")).expect("write golden");
    }
    let want = std::fs::read_to_string(&golden).expect("golden hash (UPDATE_GOLDEN=1 writes it)");
    assert_eq!(got, want.trim(), "native render of {name} differs from the golden hash (UPDATE_GOLDEN=1 after an intended engine change)");
}

#[test]
fn export_render_matches_golden_hash() {
    matches_golden("export_render");
}

/// Plan 9: the export command list of a project with 2 Audio tracks (a loop
/// clip, a missing-sample clip, a trimmed and faded clip on a sidechained
/// strip), frozen by app/src/export/render.test.ts from `exportCommands`;
/// its own golden hash, asserted by the wasm side too (`audio render
/// matches native`).
#[test]
fn export_audio_render_matches_golden() {
    matches_golden("export_audio");
}

#[test]
fn export_render_is_deterministic() {
    let job = parse(&std::fs::read_to_string(fixture("export_render.txt")).expect("fixture"));
    let (l1, r1) = render(&job, QUANTUM);
    let (l2, r2) = render(&job, QUANTUM);
    assert_eq!(hash(&l1, &r1), hash(&l2, &r2));
}

#[test]
fn export_render_is_call_size_independent() {
    // Since `Mixer::slot_added` (a track added to an empty slot takes its
    // strip settings from its first sample), the export job renders
    // bit-identically in 128- and 1024-frame calls. The export still calls
    // with 128 (the live quantum) to stay on the live schedule.
    let job = parse(&std::fs::read_to_string(fixture("export_render.txt")).expect("fixture"));
    let (l1, r1) = render(&job, QUANTUM);
    let (l2, r2) = render(&job, daw_engine::MAX_BLOCK);
    assert_eq!(hash(&l1, &r1), hash(&l2, &r2));
}

/// The C math symbols the engine may call, forwarded to the `libm` crate (see
/// the module doc). Only this test binary has them; unused ones are harmless.
mod same_math_as_wasm {
    macro_rules! forward {
        ($($name:ident($($a:ident: $t:ty),+) -> $r:ty;)+) => {
            $(#[no_mangle] pub extern "C" fn $name($($a: $t),+) -> $r { libm::$name($($a),+) })+
        };
    }
    forward! {
        sinf(x: f32) -> f32; cosf(x: f32) -> f32; tanf(x: f32) -> f32;
        asinf(x: f32) -> f32; acosf(x: f32) -> f32; atanf(x: f32) -> f32; atan2f(y: f32, x: f32) -> f32;
        sinhf(x: f32) -> f32; coshf(x: f32) -> f32; tanhf(x: f32) -> f32;
        expf(x: f32) -> f32; exp2f(x: f32) -> f32; expm1f(x: f32) -> f32;
        logf(x: f32) -> f32; log2f(x: f32) -> f32; log10f(x: f32) -> f32; log1pf(x: f32) -> f32;
        powf(x: f32, y: f32) -> f32; fmodf(x: f32, y: f32) -> f32; cbrtf(x: f32) -> f32; hypotf(x: f32, y: f32) -> f32;
        sin(x: f64) -> f64; cos(x: f64) -> f64; tan(x: f64) -> f64;
        asin(x: f64) -> f64; acos(x: f64) -> f64; atan(x: f64) -> f64; atan2(y: f64, x: f64) -> f64;
        sinh(x: f64) -> f64; cosh(x: f64) -> f64; tanh(x: f64) -> f64;
        exp(x: f64) -> f64; exp2(x: f64) -> f64; expm1(x: f64) -> f64;
        log(x: f64) -> f64; log2(x: f64) -> f64; log10(x: f64) -> f64; log1p(x: f64) -> f64;
        pow(x: f64, y: f64) -> f64; fmod(x: f64, y: f64) -> f64; cbrt(x: f64) -> f64; hypot(x: f64, y: f64) -> f64;
    }
}
