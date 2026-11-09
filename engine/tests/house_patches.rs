//! The House patch set (plan 11): levels, clipping and release for every
//! patch, the Sax's measured acceptance numbers, and one character check for
//! each other patch (Task 4, at the end).
//!
//! The patches live in TS (`app/src/state/housePatches.ts`). As with
//! `starter_patches.rs`, the vitest `patches.fixture.test.ts` records the
//! exact command list the UI sends for each one into
//! `tests/fixtures/house_patches.txt` (see `common/mod.rs`), and these tests
//! replay it through `Engine::command`, the real UI-to-engine path.
//!
//! # Measuring (shared by every test here)
//! * **Pre-limiter at the default master gain.** The tests set master gain
//!   0.1 instead of the default 0.8, so the output is exactly 1/8 of the
//!   default pre-limiter signal and stays far below the limiter; every
//!   [`Render`] is that output × 8.
//! * **Timing.** The engine output is delayed by the limiter lookahead
//!   ([`Engine::latency`]); [`run`] drops it, so sample 0 of a render is the
//!   first note-on. Events land on 128-frame block starts (2.7 ms).
//! * **Momentary loudness** ([`momentary_db`]): the maximum RMS of
//!   `(L+R)/2` over 400 ms windows (100 ms hop), unweighted, in dBFS.
//! * **Spectra**: Hann windows; [`harmonics`] evaluates single DFT bins
//!   (Goertzel-equivalent) at k·f0, [`spectrum`] is a Welch average of
//!   4096-point FFT frames (hop 1024). [`centroid`] is magnitude-weighted
//!   (the usual definition), over 50 Hz–10 kHz.
//! * **f0** ([`f0_track`]): normalised autocorrelation over 40 ms frames
//!   (10 ms hop), the first peak within 0.9 of the best one (no octave
//!   errors on a strong 2nd harmonic), refined by a parabola.

mod common;

use common::{house_patches, Example, HousePatch, Phrase};
use daw_engine::engine::Engine;
use daw_engine::protocol::{
    OK, OP_MOD_WHEEL, OP_NOTE_OFF, OP_NOTE_ON, OP_PLAY, OP_RACK_ADD_MODULE, OP_RACK_CONNECT, OP_RACK_DISCONNECT, OP_RACK_REMOVE_MODULE,
    OP_RACK_SET_PARAM, OP_SET_MASTER_GAIN, OP_SET_TEMPO,
};
use daw_engine::rack::catalog::{spec, ModuleKind};

/// The test sample rate: 48 kHz, or `HOUSE_SR` at build time to check every
/// measurement at another rate, e.g.
/// `HOUSE_SR=44100 cargo test -p daw-engine --test house_patches`
/// (cargo rebuilds when it changes).
const SR: f32 = match option_env!("HOUSE_SR") {
    Some(s) => parse_hz(s),
    None => 48000.0,
};

const fn parse_hz(s: &str) -> f32 {
    let b = s.as_bytes();
    let (mut i, mut n) = (0, 0u32);
    while i < b.len() {
        assert!(b[i].is_ascii_digit(), "HOUSE_SR: a whole number of Hz");
        n = n * 10 + (b[i] - b'0') as u32;
        i += 1;
    }
    n as f32
}
const BLOCK: usize = 128;
/// Master gain 0.1 instead of 0.8: output × 8 is the pre-limiter signal.
const PRE: f32 = 8.0;

// ---- harness ------------------------------------------------------------------

/// A mono render: `m` is `(L+R)/2` pre-limiter, `peak` the largest |L| or |R|
/// pre-limiter. Sample 0 is the first event.
struct Render {
    m: Vec<f32>,
    peak: f32,
    /// FNV-1a over every raw output sample's bits, L then R per block
    /// (bit-identical renders compare equal; plan 12 scopes).
    bits: u64,
}

impl Render {
    fn at(&self, sec: f32) -> usize {
        ((sec * SR) as usize).min(self.m.len())
    }
    /// Samples between `a` and `b` seconds.
    fn span(&self, a: f32, b: f32) -> &[f32] {
        &self.m[self.at(a)..self.at(b)]
    }
}

fn patch(name: &str) -> HousePatch {
    house_patches().into_iter().find(|p| p.name == name).unwrap_or_else(|| panic!("no house patch {name:?} in the fixture"))
}

/// A fresh engine with `cmds` replayed (a synth track in slot 0, selected as
/// the input track), master gain 0.1, and 50 ms of silence rendered so the
/// load's declick fade-in and every smoothed param have settled.
fn load_cmds(cmds: &[[f64; 5]]) -> Engine {
    let mut e = Engine::new(SR);
    for c in cmds {
        assert_eq!(e.command(c[0] as u32, c[1], c[2], c[3], c[4]), OK, "{c:?}");
    }
    assert_eq!(e.command(OP_SET_MASTER_GAIN, 0.1, 0., 0., 0.), OK);
    settle(&mut e);
    e
}

fn settle(e: &mut Engine) {
    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    for _ in 0..(0.05 * SR) as usize / BLOCK {
        e.process(&mut l, &mut r);
    }
}

/// [`load_cmds`] by patch name.
fn load(name: &str) -> Engine {
    load_cmds(&patch(name).cmds)
}

#[derive(Clone, Copy, Debug)]
enum Ev {
    On(u8, u8),
    Off(u8),
    Mod(f32),
}

/// Render `dur` seconds, applying each `(time s, event)` at the first block
/// start at or after its time (events in list order within a block).
fn run(e: &mut Engine, events: &[(f32, Ev)], dur: f32) -> Render {
    run_with(e, events, dur, &mut |_, _| {})
}

/// [`run`], calling `hook(engine, frame)` before every block (after its
/// events), `frame` counted from the first block.
fn run_with(e: &mut Engine, events: &[(f32, Ev)], dur: f32, hook: &mut dyn FnMut(&mut Engine, usize)) -> Render {
    let lat = e.latency();
    let frames = (dur * SR) as usize + lat;
    let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    let mut m = Vec::with_capacity(frames + BLOCK);
    let mut peak = 0.0f32;
    let mut bits = 0xcbf2_9ce4_8422_2325u64;
    let mut next = 0;
    let mut t = 0usize;
    while t < frames {
        while next < events.len() && (events[next].0 * SR) as usize <= t {
            let code = match events[next].1 {
                Ev::On(n, v) => e.command(OP_NOTE_ON, n as f64, v as f64, 0., 0.),
                Ev::Off(n) => e.command(OP_NOTE_OFF, n as f64, 0., 0., 0.),
                Ev::Mod(x) => e.command(OP_MOD_WHEEL, x as f64, 0., 0., 0.),
            };
            assert_eq!(code, OK, "{:?}", events[next]);
            next += 1;
        }
        hook(e, t);
        e.process(&mut l, &mut r);
        for x in l.iter().chain(&r) {
            bits = (bits ^ x.to_bits() as u64).wrapping_mul(0x0100_0000_01b3);
        }
        for i in 0..BLOCK {
            let (a, b) = (l[i] * PRE, r[i] * PRE);
            assert!(a.is_finite() && b.is_finite(), "non-finite output");
            assert!(l[i].abs() < 0.99 && r[i].abs() < 0.99, "output reached the clamp: can't measure");
            if t + i >= lat {
                peak = peak.max(a.abs()).max(b.abs());
                m.push(0.5 * (a + b));
            }
        }
        t += BLOCK;
    }
    m.truncate(frames - lat);
    Render { m, peak, bits }
}

/// When an event at `t` s takes effect in a [`run`] render: the first block
/// start at or after it.
fn onset(t: f32) -> f32 {
    ((t * SR) as usize).div_ceil(BLOCK) as f32 * BLOCK as f32 / SR
}

/// Press `notes` at velocity `vel` at 0, release them after `hold` s, and
/// render `release` s more.
fn play(e: &mut Engine, notes: &[u8], vel: u8, hold: f32, release: f32) -> Render {
    let mut ev: Vec<(f32, Ev)> = notes.iter().map(|&n| (0.0, Ev::On(n, vel))).collect();
    ev.extend(notes.iter().map(|&n| (hold, Ev::Off(n))));
    run(e, &ev, hold + release)
}

/// A patch's phrase at `vel`: each step held `step` s (the next step starts as
/// the previous one is released), then `release` s more.
fn play_phrase(e: &mut Engine, phrase: Phrase, vel: u8, step: f32, release: f32) -> Render {
    play_phrase_with(e, phrase, vel, step, release, &mut |_, _| {})
}

/// [`play_phrase`] with a [`run_with`] hook.
fn play_phrase_with(
    e: &mut Engine,
    phrase: Phrase,
    vel: u8,
    step: f32,
    release: f32,
    hook: &mut dyn FnMut(&mut Engine, usize),
) -> Render {
    let mut ev = Vec::new();
    for (i, notes) in phrase.steps().iter().enumerate() {
        let t = i as f32 * step;
        ev.extend(notes.iter().map(|&n| (t, Ev::On(n, vel))));
        ev.extend(notes.iter().map(|&n| (t + step, Ev::Off(n))));
    }
    ev.sort_by(|a, b| a.0.total_cmp(&b.0)); // stable: offs stay before ons at a step change
    run_with(e, &ev, phrase.steps().len() as f32 * step + release, hook)
}

/// A phrase with its own step (an arp), transposed by `tr` semitones, at
/// `vel`, plus 1 s of release.
fn play_arp(e: &mut Engine, phrase: Phrase, tr: i32, vel: u8) -> Render {
    let step = phrase.step().expect("a phrase with its own step");
    let mut ev = Vec::new();
    for (i, notes) in phrase.steps().iter().enumerate() {
        let t = i as f32 * step;
        ev.extend(notes.iter().map(|&n| (t, Ev::On((n as i32 + tr) as u8, vel))));
        ev.extend(notes.iter().map(|&n| (t + step, Ev::Off((n as i32 + tr) as u8))));
    }
    ev.sort_by(|a, b| a.0.total_cmp(&b.0));
    run(e, &ev, phrase.steps().len() as f32 * step + 1.0)
}

/// Seconds per tick at the default 124 BPM (960 PPQ): example rolls are
/// played at the tempo they were written for.
const TICK_124: f32 = 60.0 / 124.0 / 960.0;

/// An example roll's length (s) at 124 BPM.
fn roll_secs(ex: &Example) -> f32 {
    (ex.bars * 4 * 960) as f32 * TICK_124
}

/// Play an example roll once from 0 at 124 BPM (each note's On and Off at
/// its ticks; an Off sorts before an On at the same instant, as the
/// sequencer sends them), then `tail` s more.
fn play_example(e: &mut Engine, ex: &Example, tail: f32) -> Render {
    let mut ev: Vec<(f32, u8, Ev)> = Vec::new();
    for n in &ex.notes {
        ev.push((n.start as f32 * TICK_124, 1, Ev::On(n.pitch, n.vel)));
        ev.push(((n.start + n.len) as f32 * TICK_124, 0, Ev::Off(n.pitch)));
    }
    ev.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let ev: Vec<(f32, Ev)> = ev.into_iter().map(|x| (x.0, x.2)).collect();
    run(e, &ev, roll_secs(ex) + tail)
}

/// A patch's example-roll level (plan 28 *levels match on the example
/// roll*): the RMS (dBFS, pre-limiter at the default master gain) of the
/// roll's own span, played once at vel as written, and the render's peak.
fn example_level(p: &HousePatch) -> Option<(f32, f32)> {
    let ex = p.example.as_ref()?;
    let r = play_example(&mut load_cmds(&p.cmds), ex, 0.5);
    Some((db(rms(r.span(0.0, roll_secs(ex)))), r.peak))
}

/// A `RACK_SET_PARAM` on slot 0 by catalog param name (for A/B renders, e.g.
/// vibrato or breath off). `module` is the patch's module idx and its kind.
fn set(e: &mut Engine, module: (usize, ModuleKind), param: &str, value: f32) {
    let s = spec(module.1);
    let p = s.params.iter().position(|p| p.name == param).unwrap_or_else(|| panic!("{} has no param {param:?}", s.id));
    assert_eq!(e.command(OP_RACK_SET_PARAM, 0., module.0 as f64, p as f64, value as f64), OK);
    settle(e);
}

fn db(x: f32) -> f32 {
    20.0 * x.max(1e-12).log10()
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| (v * v) as f64).sum::<f64>() / x.len().max(1) as f64).sqrt() as f32
}

/// Momentary loudness (dBFS): the max RMS over 400 ms windows, 100 ms hop.
fn momentary_db(r: &Render) -> f32 {
    let (w, hop) = ((0.4 * SR) as usize, (0.1 * SR) as usize);
    if r.m.len() <= w {
        return db(rms(&r.m));
    }
    (0..=(r.m.len() - w) / hop).map(|i| rms(&r.m[i * hop..i * hop + w])).fold(0.0, f32::max).log10() * 20.0
}

fn peak_pre_limiter(r: &Render) -> f32 {
    r.peak
}

fn hann(n: usize) -> Vec<f64> {
    (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos()).collect()
}

/// Amplitudes of harmonics 1, 2, … (index 0 = h1) of `f0` below 0.45 × SR,
/// over a Hann `window` (samples) starting at `at` s. A full-scale sine at k·f0
/// reads 1.
fn harmonics(r: &Render, f0: f32, at: f32, window: usize) -> Vec<f32> {
    let x = &r.m[r.at(at)..r.at(at) + window];
    let w = hann(window);
    let wsum: f64 = w.iter().sum();
    let mut out = Vec::new();
    let mut k = 1;
    while (k as f32 * f0) < 0.45 * SR {
        let om = 2.0 * std::f64::consts::PI * (k as f64 * f0 as f64) / SR as f64;
        // Goertzel.
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        let c = 2.0 * om.cos();
        for (xi, wi) in x.iter().zip(&w) {
            let s0 = *xi as f64 * wi + c * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        let re = s1 - s2 * om.cos();
        let im = s2 * om.sin();
        out.push((2.0 * (re * re + im * im).sqrt() / wsum) as f32);
        k += 1;
    }
    out
}

/// Mean power (A²) of harmonics 1, 2, … of `f0` over Hann windows of 4096
/// samples (hop 1024) between `a` and `b` s. Average over at least one beat
/// of any detuned layer (the Sax's +5 ct square beats at 0.76 Hz at C4), so a
/// harmonic's value does not depend on where one window happens to fall.
fn harmonic_power(r: &Render, f0: f32, a: f32, b: f32) -> Vec<f32> {
    let (start, end) = (r.at(a), r.at(b));
    let mut acc: Vec<f64> = Vec::new();
    let mut n = 0;
    let mut s = start;
    while s + FFT_N <= end {
        let h = harmonics(r, f0, s as f32 / SR, FFT_N);
        if acc.is_empty() {
            acc = vec![0.0; h.len()];
        }
        acc.iter_mut().zip(&h).for_each(|(x, y)| *x += (*y as f64).powi(2));
        n += 1;
        s += 1024;
    }
    assert!(n > 0, "span too short");
    acc.iter().map(|x| (x / n as f64) as f32).collect()
}

/// Harmonic-only spectral centroid (Hz) between `a` and `b` s: each harmonic
/// k·f0 (50 Hz–10 kHz) weighted by its magnitude, `√` of the Welch power
/// within ±f0/4 of it (so vibrato stays inside its band and inharmonic
/// breath noise between the harmonics does not count).
fn harmonic_centroid(r: &Render, f0: f32, a: f32, b: f32) -> f32 {
    let p = spectrum(r, a, b);
    let (mut num, mut den) = (0.0f64, 0.0f64);
    let mut k = 1;
    while k as f32 * f0 <= 10000.0 {
        let fk = k as f32 * f0;
        if fk >= 50.0 {
            let mag = p
                .iter()
                .enumerate()
                .filter(|(i, _)| (*i as f32 * BIN_HZ - fk).abs() <= 0.25 * f0)
                .map(|x| *x.1)
                .sum::<f64>()
                .sqrt();
            num += fk as f64 * mag;
            den += mag;
        }
        k += 1;
    }
    (num / den) as f32
}

/// In-place radix-2 FFT.
fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f64::consts::PI / len as f64;
        for start in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (wr, wi) = ((ang * k as f64).cos(), (ang * k as f64).sin());
                let (a, b) = (start + k, start + k + len / 2);
                let (xr, xi) = (re[b] * wr - im[b] * wi, re[b] * wi + im[b] * wr);
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
        }
        len <<= 1;
    }
}

const FFT_N: usize = 4096;
const BIN_HZ: f32 = SR / FFT_N as f32;

/// Welch power spectrum between `a` and `b` s: the mean of |FFT|² over
/// Hann frames of 4096 (hop 1024). Bin i is at `i × BIN_HZ`.
fn spectrum(r: &Render, a: f32, b: f32) -> Vec<f64> {
    welch(r, a, b, FFT_N)
}

/// [`spectrum`] with Hann frames of `n` (a power of two, hop n/4). Bin i is
/// at `i × SR / n`.
fn welch(r: &Render, a: f32, b: f32, n: usize) -> Vec<f64> {
    let x = r.span(a, b);
    assert!(x.len() >= n, "span too short for a spectrum");
    let w = hann(n);
    let mut acc = vec![0.0f64; n / 2];
    let mut frames = 0;
    let mut s = 0;
    while s + n <= x.len() {
        let mut re: Vec<f64> = (0..n).map(|i| x[s + i] as f64 * w[i]).collect();
        let mut im = vec![0.0f64; n];
        fft(&mut re, &mut im);
        for i in 0..n / 2 {
            acc[i] += re[i] * re[i] + im[i] * im[i];
        }
        frames += 1;
        s += n / 4;
    }
    acc.iter_mut().for_each(|v| *v /= frames as f64);
    acc
}

/// Magnitude-weighted spectral centroid (Hz) over 50 Hz–10 kHz, between `a`
/// and `b` s. (The Sax uses [`harmonic_centroid`]: its breath noise would
/// dominate this one.)
#[allow(dead_code)] // used by the Task 4 character checks
fn centroid(r: &Render, a: f32, b: f32) -> f32 {
    let p = spectrum(r, a, b);
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for (i, pw) in p.iter().enumerate() {
        let f = i as f32 * BIN_HZ;
        if (50.0..=10000.0).contains(&f) {
            num += f as f64 * pw.sqrt();
            den += pw.sqrt();
        }
    }
    (num / den) as f32
}

/// RMS over consecutive 5 ms frames.
fn rms_env_5ms(r: &Render) -> Vec<f32> {
    r.m.chunks_exact((0.005 * SR) as usize).map(rms).collect()
}

/// RMS over sliding `win` s windows every 5 ms (entry i starts at i × 5 ms).
/// For level comparisons: a 5 ms frame holds only ~1.3 periods of C4, so its
/// RMS alone jitters by about ±1 dB with the waveform's phase.
fn rms_env_sliding(r: &Render, win: f32) -> Vec<f32> {
    let (w, hop) = ((win * SR) as usize, (0.005 * SR) as usize);
    (0..).map(|i| i * hop).take_while(|s| s + w <= r.m.len()).map(|s| rms(&r.m[s..s + w])).collect()
}

/// f0 (Hz) per 40 ms frame (10 ms hop) lying fully between `a` and `b` s, as
/// `(frame centre s, f0)`, searching `fmin..fmax`. Keep the range within an
/// octave around the expected note: a formant-boosted 2nd harmonic can
/// otherwise win at half the period.
fn f0_track(r: &Render, a: f32, b: f32, fmin: f32, fmax: f32) -> Vec<(f32, f32)> {
    let (frame, hop) = ((0.04 * SR) as usize, (0.01 * SR) as usize);
    let (lo, hi) = ((SR / fmax).floor() as usize, (SR / fmin).ceil() as usize);
    let mut out = Vec::new();
    let mut s = r.at(a);
    while s + frame <= r.at(b) {
        let x = &r.m[s..s + frame];
        // Normalised autocorrelation of the frame with itself shifted by `lag`.
        let nac = |lag: usize| -> f64 {
            let (mut xy, mut xx, mut yy) = (0.0f64, 0.0f64, 0.0f64);
            for i in 0..frame - lag {
                let (p, q) = (x[i] as f64, x[i + lag] as f64);
                xy += p * q;
                xx += p * p;
                yy += q * q;
            }
            xy / (xx * yy).sqrt().max(1e-30)
        };
        let c: Vec<f64> = (lo - 1..=hi + 1).map(nac).collect(); // c[j] is lag lo - 1 + j
        let best = c[1..c.len() - 1].iter().cloned().fold(f64::MIN, f64::max);
        let j = (1..c.len() - 1).find(|&j| c[j] >= c[j - 1] && c[j] >= c[j + 1] && c[j] >= 0.9 * best).expect("a peak");
        let d = c[j - 1] - 2.0 * c[j] + c[j + 1];
        let off = if d.abs() > 1e-12 { 0.5 * (c[j - 1] - c[j + 1]) / d } else { 0.0 };
        let lag = (lo - 1 + j) as f64 + off;
        out.push(((s + frame / 2) as f32 / SR, (SR as f64 / lag) as f32));
        s += hop;
    }
    out
}

fn cents(f: f32, f_ref: f32) -> f32 {
    1200.0 * (f / f_ref).log2()
}

fn hz(note: u8) -> f32 {
    440.0 * 2f32.powf((note as f32 - 69.0) / 12.0)
}

/// The kind of module `idx` in a patch's fixture (from its RACK_ADD_MODULE).
fn kind_at(p: &HousePatch, idx: usize) -> Option<ModuleKind> {
    p.cmds
        .iter()
        .find(|c| c[0] as u32 == OP_RACK_ADD_MODULE && c[2] as usize == idx)
        .and_then(|c| ModuleKind::from_id(c[3] as u32))
}

/// The longest ADSR `release` in a patch (catalog default where unset).
fn longest_release(p: &HousePatch) -> f32 {
    let rel = spec(ModuleKind::Adsr).params.iter().position(|q| q.name == "release").unwrap();
    let default = spec(ModuleKind::Adsr).params[rel].default;
    (0..32)
        .filter(|&i| kind_at(p, i) == Some(ModuleKind::Adsr))
        .map(|i| {
            p.cmds
                .iter()
                .rev()
                .find(|c| c[0] as u32 == OP_RACK_SET_PARAM && c[2] as usize == i && c[3] as usize == rel)
                .map_or(default, |c| c[4] as f32)
        })
        .fold(0.0, f32::max)
}

// ---- every house patch --------------------------------------------------------

/// Loudness window (plan 11 *Levels*): −15 dBFS ± 3 dB momentary at vel 100.
const LOUDNESS_DB: f32 = -15.0;
const LOUDNESS_TOL: f32 = 3.0;
/// Allowed pre-limiter peak at velocity 127.
const PEAK_LIMIT: f32 = 0.9;

#[test]
fn house_patches_sit_at_similar_levels() {
    let all = house_patches();
    assert_eq!(all.len(), 21, "the whole House set (plan 11's 12, plan 28's 7 + 2 transition patches)");
    let mut failed = Vec::new();
    for p in all.iter().filter(|p| p.phrase != Phrase::Fx) {
        let mut e = load_cmds(&p.cmds);
        let r = play_phrase(&mut e, p.phrase, 100, p.phrase.step().unwrap_or(1.5), 0.5);
        let m = momentary_db(&r);
        eprintln!("{}: momentary {m:.1} dBFS ({:?})", p.name, p.phrase);
        if (m - LOUDNESS_DB).abs() > LOUDNESS_TOL {
            failed.push(format!("{} {m:.1}", p.name));
        }
    }
    assert!(failed.is_empty(), "outside {LOUDNESS_DB} ± {LOUDNESS_TOL} dBFS: {failed:?}");
}

/// A patch's worst pre-limiter peak at velocity 127 over the chords or notes
/// its phrase stands for (starter_patches.rs's sets per voice type), held
/// and released; an arp patch plays its arp phrase at four octaves instead.
/// None for a transition patch (measured by its own tests).
fn worst_peak(p: &HousePatch) -> Option<f32> {
    let chords4: [&[u8]; 4] = [&[48, 52, 55, 59], &[60, 64, 67, 71], &[36, 48, 55, 60], &[57, 60, 64, 69]];
    let chords5: [&[u8]; 3] = [&[48, 52, 55, 59, 62], &[36, 48, 55, 60, 64], &[57, 60, 64, 67, 72]];
    let notes: [&[u8]; 4] = [&[36], &[48], &[60], &[72]];
    let (set, hold): (&[&[u8]], f32) = match p.phrase {
        Phrase::Chord4 => (&chords4, 1.0),
        Phrase::Chord5 => (&chords5, 2.0),
        Phrase::Bass | Phrase::Lead => (&notes, 1.0),
        // The arp phrase itself, transposed −2…+1 octaves (C2…C5 roots).
        Phrase::Arp => (&[], 0.0),
        Phrase::Fx => return None,
    };
    let arp = (p.phrase == Phrase::Arp).then(|| {
        [-24i32, -12, 0, 12]
            .iter()
            .map(|&tr| peak_pre_limiter(&play_arp(&mut load_cmds(&p.cmds), p.phrase, tr, 127)))
            .fold(0.0f32, f32::max)
    });
    Some(
        set.iter()
            .map(|c| {
                let mut e = load_cmds(&p.cmds);
                peak_pre_limiter(&play(&mut e, c, 127, hold, 1.0))
            })
            .fold(arp.unwrap_or(0.0), f32::max),
    )
}

#[test]
fn house_patches_do_not_clip() {
    let mut failed = Vec::new();
    for p in &house_patches() {
        // Transition patches: noise_sweep_* and impact_* below.
        let Some(worst) = worst_peak(p) else { continue };
        eprintln!("{}: pre-limiter peak {worst:.3} at vel 127", p.name);
        assert!(worst > 0.05, "{} is (nearly) silent: {worst}", p.name);
        if worst >= PEAK_LIMIT {
            failed.push(format!("{} {worst:.3}", p.name));
        }
    }
    assert!(failed.is_empty(), "pre-limiter peak >= {PEAK_LIMIT}: {failed:?}");
}

#[test]
fn house_patches_release_to_silence() {
    let mut failed = Vec::new();
    // Transition patches have their own release checks (noise_sweep_*, impact_*).
    for p in house_patches().iter().filter(|p| p.phrase != Phrase::Fx) {
        let rel = longest_release(p);
        let mut e = load_cmds(&p.cmds);
        let hold = p.phrase.step().unwrap_or(1.0);
        let r = play_phrase(&mut e, p.phrase, 100, hold, rel + 1.2);
        let end = p.phrase.steps().len() as f32 * hold;
        // From release + 1 s after the last note-off, the 100 ms RMS is < −60 dBFS.
        let tail = db(rms(r.span(end + rel + 1.0, end + rel + 1.1)));
        eprintln!("{}: {tail:.1} dBFS at release ({rel:.2} s) + 1 s", p.name);
        if tail >= -60.0 {
            failed.push(format!("{} {tail:.1}", p.name));
        }
    }
    assert!(failed.is_empty(), "not silent (−60 dBFS) at release + 1 s: {failed:?}");
}

// ---- Sax acceptance (plan 11 *Sax recipe*; C4, vel 100 unless stated) ------------

/// Sax module indices (`housePatches.ts`); [`sax`] checks them against the fixture.
const SAX_MIDI: (usize, ModuleKind) = (0, ModuleKind::MidiIn);
const SAX_FORMANT: (usize, ModuleKind) = (4, ModuleKind::Formant);
const SAX_BREATH_VCA: (usize, ModuleKind) = (12, ModuleKind::Vca);
const SAX_VIB_VCA: (usize, ModuleKind) = (15, ModuleKind::Vca);

/// The Sax loaded, its module map checked; optionally vibrato and/or breath off.
fn sax(vibrato: bool, breath: bool) -> Engine {
    let p = patch("Sax");
    for m in [SAX_MIDI, SAX_FORMANT, SAX_BREATH_VCA, SAX_VIB_VCA] {
        assert_eq!(kind_at(&p, m.0), Some(m.1), "Sax module {} is not {:?}: update the indices here", m.0, m.1);
    }
    let mut e = load("Sax");
    // Always the same commands and settle time, so oscillator and LFO phases
    // match between A/B renders (the tone is then identical sample for sample).
    set(&mut e, SAX_VIB_VCA, "level", if vibrato { 1.0 } else { 0.0 });
    set(&mut e, SAX_BREATH_VCA, "level", if breath { 1.0 } else { 0.0 });
    e
}

/// A Formant param of the Sax as set in the fixture (catalog default if unset).
fn sax_formant(param: &str) -> f32 {
    let p = patch("Sax");
    let s = spec(ModuleKind::Formant);
    let i = s.params.iter().position(|q| q.name == param).unwrap();
    p.cmds
        .iter()
        .rev()
        .find(|c| c[0] as u32 == OP_RACK_SET_PARAM && c[2] as usize == SAX_FORMANT.0 && c[3] as usize == i)
        .map_or(s.params[i].default, |c| c[4] as f32)
}

#[test]
fn sax_formant_peaks() {
    let (f1, f2, f3) = (sax_formant("f1"), sax_formant("f2"), sax_formant("f3"));
    for note in [60u8, 55] {
        let f0 = hz(note);
        // Held 2.6 s; harmonic power averaged over 0.4–2.4 s (more than one
        // beat of the +5 ct square: 1.3 s at C4, 1.75 s at G3).
        let r = play(&mut sax(false, true), &[note], 100, 2.6, 0.0);
        let pw = harmonic_power(&r, f0, 0.4, 2.4);
        // Saw-normalised envelope E_k = 20·log10(A_k·k): a saw's harmonics fall as 1/k, so it is flat for a raw saw.
        let e: Vec<(f32, f32)> =
            pw.iter().enumerate().map(|(i, &x)| ((i + 1) as f32 * f0, 10.0 * x.max(1e-24).log10() + db((i + 1) as f32))).collect();
        let max_in = |lo: f32, hi: f32| e.iter().filter(|(f, _)| (lo..=hi).contains(f)).map(|x| x.1).fold(f32::MIN, f32::max);
        // The trough level: the median E over the harmonics in both trough
        // bands (not the min, which a single oscillator null can set).
        let mut tr: Vec<f32> =
            e.iter().filter(|(f, _)| (700.0..=1150.0).contains(f) || (1900.0..=2200.0).contains(f)).map(|x| x.1).collect();
        tr.sort_by(f32::total_cmp);
        assert!(!tr.is_empty(), "no harmonic in the trough bands");
        let trough = if tr.len() % 2 == 1 { tr[tr.len() / 2] } else { 0.5 * (tr[tr.len() / 2 - 1] + tr[tr.len() / 2]) };
        let peaks = [f1, f2, f3].map(|f| max_in(0.8 * f, 1.2 * f));
        eprintln!(
            "Sax note {note}: E_k {:?}",
            e.iter().take(16).map(|(f, d)| format!("{f:.0}:{d:.1}")).collect::<Vec<_>>()
        );
        eprintln!("Sax note {note}: peaks {peaks:?} dB vs trough median {trough:.1} dB (sr {SR})");
        for (i, pk) in peaks.iter().enumerate() {
            assert!(pk - trough >= 3.0, "note {note}: peak f{} {pk:.1} dB is not 3 dB above the trough {trough:.1} dB", i + 1);
        }
    }
}

#[test]
fn sax_brightness_tracks_velocity() {
    let c = |vel: u8| {
        let r = play(&mut sax(true, true), &[60], vel, 1.0, 0.0);
        eprintln!("Sax vel {vel}: momentary {:.1} dBFS", momentary_db(&r));
        harmonic_centroid(&r, hz(60), 0.5, 1.0)
    };
    let (c40, c100, c127) = (c(40), c(100), c(127));
    eprintln!("Sax harmonic centroid: vel 40 {c40:.0} Hz, vel 100 {c100:.0} Hz, vel 127 {c127:.0} Hz");
    assert!((900.0..=1800.0).contains(&c100), "vel 100 centroid {c100:.0} Hz outside 0.9–1.8 kHz");
    assert!(c127 >= 1.2 * c40, "vel 127 centroid {c127:.0} is not 1.2 × vel 40's {c40:.0}");
}

#[test]
fn sax_attack_time() {
    let r = play(&mut sax(true, true), &[60], 100, 1.0, 0.0);
    let env = rms_env_5ms(&r);
    let steady = env[100..200].iter().sum::<f32>() / 100.0; // 0.5–1.0 s
    let first = |frac: f32| env.iter().position(|&x| x >= frac * steady).expect("reaches the level") as f32 * 0.005;
    let (t10, t90) = (first(0.1), first(0.9));
    let rise = t90 - t10;
    eprintln!("Sax attack: 10 % at {:.0} ms, 90 % at {:.0} ms, rise {:.0} ms", t10 * 1e3, t90 * 1e3, rise * 1e3);
    assert!((0.025..=0.090).contains(&rise), "10→90 % rise {:.0} ms outside 25–90 ms", rise * 1e3);
}

#[test]
fn sax_vibrato_is_delayed() {
    let r = play(&mut sax(true, true), &[60], 100, 1.7, 0.0);
    let f0 = hz(60);
    let early: Vec<f32> = f0_track(&r, 0.0, 0.2, 0.7 * f0, 1.4 * f0).iter().map(|x| cents(x.1, f0)).collect();
    let pp = |v: &[f32]| v.iter().cloned().fold(f32::MIN, f32::max) - v.iter().cloned().fold(f32::MAX, f32::min);
    let early_pp = pp(&early);
    let late_track = f0_track(&r, 0.8, 1.6, 0.7 * f0, 1.4 * f0);
    let late: Vec<f32> = late_track.iter().map(|x| cents(x.1, f0)).collect();
    let late_pp = pp(&late);
    // Rate: zero crossings of the linearly detrended deviation.
    let n = late.len() as f32;
    let tm = late_track.iter().map(|x| x.0).sum::<f32>() / n;
    let vm = late.iter().sum::<f32>() / n;
    let slope = late_track.iter().zip(&late).map(|(t, v)| (t.0 - tm) * (v - vm)).sum::<f32>()
        / late_track.iter().map(|t| (t.0 - tm).powi(2)).sum::<f32>();
    let d: Vec<f32> = late_track.iter().zip(&late).map(|(t, v)| v - vm - slope * (t.0 - tm)).collect();
    // Crossing times, linearly interpolated between frames; the rate is the
    // half-cycles between the first and last crossing over their distance.
    let xs: Vec<f32> = (1..d.len())
        .filter(|&i| (d[i - 1] < 0.0) != (d[i] < 0.0))
        .map(|i| {
            let (t0, t1) = (late_track[i - 1].0, late_track[i].0);
            t0 + (t1 - t0) * d[i - 1] / (d[i - 1] - d[i])
        })
        .collect();
    assert!(xs.len() >= 3, "too few vibrato crossings: {}", xs.len());
    let rate = (xs.len() - 1) as f32 / (2.0 * (xs[xs.len() - 1] - xs[0]));
    eprintln!("Sax vibrato: 0–0.2 s {early_pp:.1} ct p-p; 0.8–1.6 s {late_pp:.1} ct p-p at {rate:.2} Hz");
    assert!(early_pp < 6.0, "vibrato before 0.2 s: {early_pp:.1} cents p-p");
    assert!((20.0..=50.0).contains(&late_pp), "vibrato depth {late_pp:.1} cents p-p outside 20–50");
    assert!((4.5..=6.0).contains(&rate), "vibrato rate {rate:.2} Hz outside 4.5–6");
}

#[test]
fn sax_has_breath() {
    // Vibrato off in both renders: it would smear the harmonics into the
    // "inharmonic" bins, which is not breath.
    let (a, b) = (0.3, 1.0);
    let with = play(&mut sax(false, true), &[60], 100, 1.0, 0.0);
    let without = play(&mut sax(false, false), &[60], 100, 1.0, 0.0);
    let f0 = hz(60);
    let inharmonic = |r: &Render| -> f64 {
        spectrum(r, a, b)
            .iter()
            .enumerate()
            .filter(|(i, _)| {
                let f = *i as f32 * BIN_HZ;
                (4000.0..=8000.0).contains(&f) && (f - (f / f0).round() * f0).abs() > 40.0
            })
            .map(|x| *x.1)
            .sum()
    };
    let gain = 10.0 * (inharmonic(&with) / inharmonic(&without).max(1e-30)).log10();
    // The tone is the same in both renders (the breath joins after the
    // saturator, in the output mixer), so the difference is the breath alone.
    let breath: Vec<f32> = with.m.iter().zip(&without.m).map(|(x, y)| x - y).collect();
    let below = db(rms(&with.m[..with.at(1.0)])) - db(rms(&breath[..with.at(1.0)]));
    eprintln!("Sax breath: +{gain:.1} dB inharmonic 4–8 kHz; breath {below:.1} dB below the total");
    assert!(gain >= 6.0, "breath adds only {gain:.1} dB of inharmonic 4–8 kHz energy");
    assert!(below >= 20.0, "breath only {below:.1} dB below the total (not subtle)");
}

#[test]
fn sax_legato_glides() {
    let (c4, d4) = (hz(60), hz(62));
    // Overlapped: 62 pressed at 0.5 s while 60 is held until 0.6 s.
    let t = 0.5f32;
    let ev = [(0.0, Ev::On(60, 100)), (t, Ev::On(62, 100)), (t + 0.1, Ev::Off(60)), (1.2, Ev::Off(62))];
    let r = run(&mut sax(false, true), &ev, 1.2);
    // 20 ms windows (≥ 5 periods) every 5 ms; entry i covers i·5 ms .. i·5 + 20 ms.
    let env = rms_env_sliding(&r, 0.02);
    let mean = |a: f32, b: f32| db(env[(a / 0.005) as usize..(b / 0.005) as usize].iter().sum::<f32>() / ((b - a) / 0.005));
    let reference = mean(t - 0.1, t).min(mean(t + 0.15, t + 0.25));
    let dip = env[(t / 0.005) as usize..((t + 0.15) / 0.005) as usize].iter().map(|&x| db(x)).fold(f32::MAX, f32::min);
    eprintln!("Sax legato: level {reference:.1} dB, lowest at the change {dip:.1} dB");
    assert!(reference - dip <= 1.5, "amplitude dips {:.1} dB at the legato change", reference - dip);
    let track = f0_track(&r, t - 0.1, t + 0.3, 0.7 * c4, 1.4 * d4);
    let after: Vec<(f32, f32)> = track.iter().filter(|x| x.0 >= t).map(|x| (x.0 - t, cents(x.1, d4))).collect();
    let arrive = after.iter().position(|x| x.1.abs() <= 5.0).expect("reaches D4");
    let arrive_t = after[arrive].0;
    eprintln!(
        "Sax legato: f0 {:?}; at D4 ± 5 ct after {:.0} ms",
        after.iter().take(14).map(|x| format!("{:.0}ms:{:.1}", x.0 * 1e3, x.1)).collect::<Vec<_>>(),
        arrive_t * 1e3
    );
    assert!((0.020..=0.120).contains(&arrive_t), "glide reaches D4 after {:.0} ms, not 20–120", arrive_t * 1e3);
    // Monotonic (0.5 cent tolerance for estimator noise), from C4 up, and it stays.
    let before = track.iter().filter(|x| x.0 < t - 0.02).map(|x| cents(x.1, c4)).fold(0.0f32, |m, v| if v.abs() > m.abs() { v } else { m });
    assert!(before.abs() <= 5.0, "C4 before the change: {before:.1} ct");
    for w in after[..=arrive].windows(2) {
        assert!(w[1].1 >= w[0].1 - 0.5, "glide is not monotonic: {:?}", after);
    }
    assert!(after[arrive..].iter().all(|x| x.1.abs() <= 5.0), "leaves D4 after arriving: {after:?}");

    // Separated by 50 ms of silence: a jump. The one 40 ms frame starting at
    // the onset (centred at +20 ms) must already be D4 in Legato; the same
    // notes with glide_mode Always (A/B) glide through it, so this can fail.
    let t2 = 0.35f32;
    let on = onset(t2);
    let ev = [(0.0, Ev::On(60, 100)), (0.3, Ev::Off(60)), (t2, Ev::On(62, 100)), (0.8, Ev::Off(62))];
    let separated = |always: bool| {
        let mut e = sax(false, true);
        set(&mut e, SAX_MIDI, "glide_mode", if always { 0.0 } else { 1.0 });
        let r = run(&mut e, &ev, 0.8);
        let fr = f0_track(&r, on, on + 0.04, 0.7 * c4, 1.4 * d4);
        assert_eq!(fr.len(), 1);
        (fr[0].0 - on, cents(fr[0].1, d4))
    };
    let ((centre, legato), (_, always)) = (separated(false), separated(true));
    eprintln!("Sax separated: frame centred {:.0} ms after the onset: Legato {legato:.1} ct, Always {always:.1} ct from D4", centre * 1e3);
    assert!(legato.abs() <= 5.0, "a separated note glides in Legato: {legato:.1} cents from D4 at +20 ms");
    assert!(always.abs() > 5.0, "the check can't tell Legato from Always ({always:.1} cents with Always)");
}

#[test]
fn sax_mod_wheel_brightens() {
    // The mod wheel stands in for a breath controller (Formant cv: up to +0.5 oct).
    let r0 = play(&mut sax(false, true), &[60], 100, 1.0, 0.0);
    let r1 = run(&mut sax(false, true), &[(0.0, Ev::Mod(1.0)), (0.0, Ev::On(60, 100)), (1.0, Ev::Off(60))], 1.0);
    let (c0, c1) = (harmonic_centroid(&r0, hz(60), 0.5, 1.0), harmonic_centroid(&r1, hz(60), 0.5, 1.0));
    eprintln!("Sax mod wheel: harmonic centroid {c0:.0} Hz → {c1:.0} Hz");
    assert!(c1 > 1.05 * c0, "mod wheel does not brighten: {c0:.0} → {c1:.0} Hz");
}

// ---- the rest of the House set: one character check each (plan 11 Task 4) ----
//
// Each check names the one thing that makes the patch what it is. Windows and
// definitions are documented per test; levels are 20 ms RMS frames in dB.

/// RMS over consecutive frames of `frame` s, in dB.
fn rms_env_db(r: &Render, frame: f32) -> Vec<f32> {
    r.m.chunks_exact((frame * SR) as usize).map(|c| db(rms(c))).collect()
}

/// Magnitude-weighted centroid (50 Hz–10 kHz) of ONE Hann frame over `a..b`
/// s, zero-padded to a power of two ≥ 4096 points. For short spans (an
/// onset, or one frame centred on an instant); the span may start before 0
/// (zeros there).
fn centroid_short(r: &Render, a: f32, b: f32) -> f32 {
    let (ia, ib) = ((a * SR).round() as isize, (b * SR).round() as isize);
    assert!(ib > ia, "empty span");
    let n = (ib - ia) as usize;
    let nfft = n.next_power_of_two().max(FFT_N);
    let w = hann(n);
    let mut re = vec![0.0f64; nfft];
    let mut im = vec![0.0f64; nfft];
    for i in 0..n {
        let t = ia + i as isize;
        if t >= 0 && (t as usize) < r.m.len() {
            re[i] = r.m[t as usize] as f64 * w[i];
        }
    }
    fft(&mut re, &mut im);
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for i in 0..nfft / 2 {
        let f = i as f32 * SR / nfft as f32;
        if (50.0..=10000.0).contains(&f) {
            let mag = (re[i] * re[i] + im[i] * im[i]).sqrt();
            num += f as f64 * mag;
            den += mag;
        }
    }
    (num / den) as f32
}

const CHORD4: [u8; 4] = [60, 64, 67, 71];
/// Acid Line's MIDI In (`housePatches.ts`).
const ACID_MIDI: (usize, ModuleKind) = (0, ModuleKind::MidiIn);
const CHORD5: [u8; 5] = [48, 55, 60, 64, 71];

#[test]
fn house_set_is_complete() {
    assert_eq!(patch("Arp Pluck").phrase, Phrase::Arp, "Arp Pluck is levelled as it is played: a 1/16 arp");
    let names: Vec<String> = house_patches().into_iter().map(|p| p.name).collect();
    assert_eq!(names.len(), 21, "{names:?}");
    for n in PLAN11_SET.iter().chain(&PLAN28_SET).chain(&["Noise Sweep", "Impact"]) {
        assert!(names.iter().any(|x| x == n), "{n} missing from {names:?}");
    }
    // Plan 28: the new patches have example rolls; the transition patches
    // have none and are phrase `fx` (outside the shared level loops).
    for p in house_patches() {
        let fx = p.name == "Noise Sweep" || p.name == "Impact";
        assert_eq!(p.phrase == Phrase::Fx, fx, "{}: phrase {:?}", p.name, p.phrase);
        assert_eq!(p.example.is_none(), fx, "{}: example roll", p.name);
    }
}

#[test]
fn organ_bass_has_its_octave() {
    // C2, 0.3–0.5 s (past the click), single DFT bins at f0 and 2·f0.
    let f0 = hz(36);
    let r = play(&mut load("Organ Bass"), &[36], 100, 1.0, 0.0);
    let h = harmonics(&r, f0, 0.3, 9600);
    let (h1, h2) = (db(h[0]), db(h[1]));
    eprintln!("Organ Bass C2: h1 {h1:.1} dB, h2 {h2:.1} dB, h3 {:.1}, h4 {:.1}", db(h[2]), db(h[3]));
    assert!((h2 - h1).abs() <= 6.0, "2·f0 is {:.1} dB from f0 (not within 6 dB)", h2 - h1);
}

#[test]
fn reese_mod_wheel_opens() {
    // C2, centroid 0.5–1.0 s with the mod wheel at 0 and at 1 (set before the note).
    let r0 = run(&mut load("Reese Bass"), &[(0.0, Ev::Mod(0.0)), (0.0, Ev::On(36, 100)), (1.0, Ev::Off(36))], 1.0);
    let r1 = run(&mut load("Reese Bass"), &[(0.0, Ev::Mod(1.0)), (0.0, Ev::On(36, 100)), (1.0, Ev::Off(36))], 1.0);
    let (c0, c1) = (centroid(&r0, 0.5, 1.0), centroid(&r1, 0.5, 1.0));
    eprintln!("Reese mod wheel: centroid {c0:.0} Hz → {c1:.0} Hz ({:.2}×); momentary {:.1} → {:.1} dBFS", c1 / c0, momentary_db(&r0), momentary_db(&r1));
    assert!(c1 >= 1.5 * c0, "mod wheel 1 raises the centroid only {:.2}× ({c0:.0} → {c1:.0} Hz)", c1 / c0);
}

#[test]
fn acid_accent_and_slide() {
    assert_eq!(kind_at(&patch("Acid Line"), ACID_MIDI.0), Some(ACID_MIDI.1), "Acid Line's MIDI In moved");
    // Accent: the centroid over the first 150 ms of C2 at vel 127 vs vel 64.
    let c = |vel: u8| centroid(&play(&mut load("Acid Line"), &[36], vel, 0.5, 0.0), 0.0, 0.15);
    let (c64, c127) = (c(64), c(127));
    eprintln!("Acid accent: centroid 0–150 ms vel 64 {c64:.0} Hz, vel 127 {c127:.0} Hz ({:.2}×)", c127 / c64);
    assert!(c127 >= 1.4 * c64, "vel 127 centroid {c127:.0} is not 1.4 × vel 64's {c64:.0}");

    // Slide (C3 → D3), as sax_legato_glides: overlapped notes glide.
    let (c3, d3) = (hz(48), hz(50));
    let t = 0.5f32;
    let ev = [(0.0, Ev::On(48, 100)), (t, Ev::On(50, 100)), (t + 0.1, Ev::Off(48)), (1.0, Ev::Off(50))];
    let r = run(&mut load("Acid Line"), &ev, 1.0);
    let track = f0_track(&r, t - 0.1, t + 0.35, 0.7 * c3, 1.4 * d3);
    let before = track.iter().filter(|x| x.0 < t - 0.02).map(|x| cents(x.1, c3)).fold(0.0f32, |m, v| if v.abs() > m.abs() { v } else { m });
    let after: Vec<(f32, f32)> = track.iter().filter(|x| x.0 >= t).map(|x| (x.0 - t, cents(x.1, d3))).collect();
    eprintln!("Acid slide: f0 {:?}", after.iter().take(16).map(|x| format!("{:.0}ms:{:.1}", x.0 * 1e3, x.1)).collect::<Vec<_>>());
    assert!(before.abs() <= 5.0, "C3 before the slide: {before:.1} ct");
    let arrive = after.iter().position(|x| x.1.abs() <= 5.0).expect("reaches D3");
    let arrive_t = after[arrive].0;
    assert!((0.020..=0.150).contains(&arrive_t), "slide reaches D3 after {:.0} ms, not 20–150", arrive_t * 1e3);
    for w in after[..=arrive].windows(2) {
        assert!(w[1].1 >= w[0].1 - 0.5, "slide is not monotonic: {after:?}");
    }
    assert!(after[arrive..].iter().all(|x| x.1.abs() <= 5.0), "leaves D3 after arriving: {after:?}");

    // Separated by 50 ms of silence: a jump. The resonant filter sweep of a
    // fresh note biases the f0 estimate for ~150 ms (a lone D3 reads ≈ −25
    // to −40 ct there too), so the note is compared with a lone D3 at the
    // same onset: the one 40 ms frame starting at the onset (centred at
    // +20 ms) must match it within 5 ct in Legato, and must not with
    // glide_mode Always (A/B), so the check can fail.
    let t2 = 0.35f32;
    let on = onset(t2);
    let frame = |ev: &[(f32, Ev)], always: bool| {
        let mut e = load("Acid Line");
        set(&mut e, ACID_MIDI, "glide_mode", if always { 0.0 } else { 1.0 });
        let r = run(&mut e, ev, 0.8);
        let fr = f0_track(&r, on, on + 0.04, 0.7 * c3, 1.4 * d3);
        assert_eq!(fr.len(), 1);
        cents(fr[0].1, d3)
    };
    let sep = [(0.0, Ev::On(48, 100)), (0.3, Ev::Off(48)), (t2, Ev::On(50, 100)), (0.8, Ev::Off(50))];
    let lone = frame(&[(t2, Ev::On(50, 100)), (0.8, Ev::Off(50))], false);
    let (legato, always) = (frame(&sep, false), frame(&sep, true));
    eprintln!("Acid separated, frame at +20 ms: lone D3 {lone:.1} ct, Legato {legato:.1} ct, Always {always:.1} ct");
    assert!((legato - lone).abs() <= 5.0, "a separated note slides in Legato: {legato:.1} vs a lone D3's {lone:.1} cents");
    assert!((always - lone).abs() > 5.0, "the check can't tell Legato from Always ({always:.1} vs {lone:.1} cents)");
}

#[test]
fn acid_line_accents_open_the_filter() {
    // Two C2s, 1 s apart (the accent store has fully decayed between them):
    // vel 80 (a plain step), then vel 120 (an accent). Same note, same
    // window (first 200 ms): the accent must carry >= 3 dB more energy
    // above 1 kHz (the Accent cv opens the Diode filter further).
    let hi = |vel_a: u8, vel_b: u8| {
        let ev = [(0.0, Ev::On(36, vel_a)), (0.25, Ev::Off(36)), (1.0, Ev::On(36, vel_b)), (1.25, Ev::Off(36))];
        let r = run(&mut load("Acid Line"), &ev, 1.6);
        let above = |t0: f32| -> f64 {
            let p = spectrum(&r, onset(t0), onset(t0) + 0.2);
            p.iter().enumerate().filter(|(i, _)| *i as f32 * BIN_HZ >= 1000.0).map(|x| *x.1).sum()
        };
        10.0 * (above(1.0) / above(0.0)).log10() as f32
    };
    let gain = hi(80, 120);
    eprintln!("Acid accent: energy above 1 kHz, vel 120 vs vel 80: {gain:+.1} dB");
    assert!(gain >= 3.0, "accent only {gain:.1} dB brighter above 1 kHz");
    // Control: two plain notes match, so the gain above comes from the accent.
    let flat = hi(80, 80);
    assert!(flat.abs() <= 1.0, "two plain notes differ by {flat:.1} dB");
}

/// Acid Line, C2 notes at (start s, vel), each held 0.2 s: the energy above
/// `min_hz` (power, summed) and the RMS over the first 200 ms from each onset.
fn acid_notes(notes: &[(f32, u8)], min_hz: f32) -> Vec<(f64, f32)> {
    let mut ev = Vec::new();
    for &(t, v) in notes {
        ev.push((t, Ev::On(36, v)));
        ev.push((t + 0.2, Ev::Off(36)));
    }
    let end = notes.last().unwrap().0 + 0.6;
    let r = run(&mut load("Acid Line"), &ev, end);
    notes
        .iter()
        .map(|&(t, _)| {
            let (a, b) = (onset(t), onset(t) + 0.2);
            let hi = spectrum(&r, a, b).iter().enumerate().filter(|(i, _)| *i as f32 * BIN_HZ >= min_hz).map(|x| *x.1).sum();
            (hi, rms(&r.m[(a * SR) as usize..(b * SR) as usize]))
        })
        .collect()
}

#[test]
fn acid_line_accent_threshold_step() {
    // vel 109 vs 110, 1 s apart (the accent store is empty by then). Velocity
    // alone (the envelopes' vel_amt) moves 1/127 of its range; only the
    // Accent module (threshold 110/127) makes this a step.
    let step = |a: u8, b: u8| {
        let n = acid_notes(&[(0.0, a), (1.0, b)], 1000.0);
        (10.0 * (n[1].0 / n[0].0).log10() as f32, db(n[1].1 / n[0].1))
    };
    let (hi, loud) = step(109, 110);
    let (hi_ref, loud_ref) = step(108, 109); // below the threshold: velocity only
    eprintln!("Acid threshold 109->110: >1 kHz {hi:+.1} dB, RMS {loud:+.1} dB; 108->109 (no accent): {hi_ref:+.2} dB, {loud_ref:+.2} dB");
    assert!(hi_ref.abs() <= 0.5, "velocity alone moves 108->109 by {hi_ref:.2} dB");
    assert!(hi >= 2.5, "vel 110 only {hi:.1} dB brighter than 109");
    assert!(loud >= 0.5, "vel 110 only {loud:.2} dB louder (RMS) than 109");
}

#[test]
fn acid_line_accent_run_opens_further() {
    // Two accents 0.25 s apart: the store is still charged, so the second
    // opens the filter further than the first. Measured above 3 kHz: the
    // 1 kHz band is already full at the first accent.
    let n = acid_notes(&[(0.0, 120), (0.25, 120)], 3000.0);
    let gain = 10.0 * (n[1].0 / n[0].0).log10() as f32;
    eprintln!("Acid accent run: second vs first >3 kHz {gain:+.1} dB");
    assert!(gain >= 1.0, "second accent only {gain:.1} dB brighter than the first");
}

#[test]
fn acid_line_accent_release_matches_plain() {
    // The accent's amp boost must not outlast the note: after note-off
    // (amp release 60 ms) an accented note's tail is as short as a plain one's.
    let tail = |vel: u8| {
        let r = run(&mut load("Acid Line"), &[(0.0, Ev::On(36, vel)), (0.5, Ev::Off(36))], 1.0);
        db(rms(r.span(0.6, 0.65)))
    };
    let (plain, accent) = (tail(80), tail(120));
    eprintln!("Acid tail 100-150 ms after note-off: plain {plain:.1} dBFS, accent {accent:.1} dBFS");
    // Both tails are inaudible (about -90 dBFS: the 1 dB comparison is of
    // noise-floor residue), so anything under -80 dBFS passes too; the old
    // raw-cv boost left -48.7 dBFS here.
    assert!(accent <= (plain + 1.0).max(-80.0), "accented tail {accent:.1} dBFS vs plain {plain:.1}");
}

#[test]
fn sub_bass_is_sub() {
    // C2, 0.2–1.0 s: the power below 200 Hz over the total.
    let r = play(&mut load("Sub Bass"), &[36], 100, 1.0, 0.0);
    let p = spectrum(&r, 0.2, 1.0);
    let total: f64 = p.iter().sum();
    let low: f64 = p.iter().enumerate().filter(|(i, _)| (*i as f32 * BIN_HZ) < 200.0).map(|x| *x.1).sum();
    eprintln!("Sub Bass C2: {:.1} % of the energy below 200 Hz", 100.0 * low / total);
    assert!(low >= 0.85 * total, "only {:.1} % below 200 Hz", 100.0 * low / total);
    // ... but not a bare sine: harmonics 2–5 (what a small speaker plays of
    // it) carry ≥ −35 dB of h1's power together.
    let h = harmonic_power(&r, hz(36), 0.2, 1.0);
    let upper = 10.0 * (h[1..5].iter().sum::<f32>() / h[0]).log10();
    eprintln!("Sub Bass C2: h2–h5 {upper:.1} dB re h1 ({:?} dB)", h[1..5].iter().map(|x| (10.0 * (x / h[0]).log10()).round()).collect::<Vec<_>>());
    assert!(upper >= -35.0, "h2–h5 only {upper:.1} dB re h1: inaudible on small speakers");
}

/// Strings' amp ADSR (`housePatches.ts`), checked against the fixture.
const STRINGS_AMP: (usize, ModuleKind) = (6, ModuleKind::Adsr);

/// A param of module `m` as set in a patch's fixture (catalog default if unset).
fn fixture_param(p: &HousePatch, m: (usize, ModuleKind), param: &str) -> f32 {
    assert_eq!(kind_at(p, m.0), Some(m.1), "{} module {} is not {:?}: update the index", p.name, m.0, m.1);
    let s = spec(m.1);
    let i = s.params.iter().position(|q| q.name == param).unwrap();
    p.cmds
        .iter()
        .rev()
        .find(|c| c[0] as u32 == OP_RACK_SET_PARAM && c[2] as usize == m.0 && c[3] as usize == i)
        .map_or(s.params[i].default, |c| c[4] as f32)
}

#[test]
fn strings_swell() {
    // chord5 held. The detuned section and chorus beat by ±2–5 dB, which
    // would decide where a raw level crosses 90 %, so the swell is measured
    // as an A/B: the patch as is over the same render with a 1 ms amp attack
    // (same commands and settle time, so the tone is identical sample for
    // sample). Their 5 ms RMS ratio is the swell alone; its 10 → 90 % rise
    // (of its mean over 0.8–1.5 s) must take 0.2–0.6 s.
    let attack = fixture_param(&patch("Strings"), STRINGS_AMP, "attack");
    let render = |a: f32| {
        let mut e = load("Strings");
        set(&mut e, STRINGS_AMP, "attack", a);
        rms_env_5ms(&play(&mut e, &CHORD5, 100, 1.5, 0.0))
    };
    let (swell, flat) = (render(attack), render(0.001));
    let ratio: Vec<f32> = swell.iter().zip(&flat).map(|(s, f)| s / f.max(1e-9)).collect();
    let steady = ratio[160..300].iter().sum::<f32>() / 140.0;
    let first = |frac: f32| ratio.iter().position(|&x| x >= frac * steady).expect("reaches the level") as f32 * 0.005;
    let (t10, t90) = (first(0.1), first(0.9));
    eprintln!("Strings swell (attack {attack} s): 10 % at {:.0} ms, 90 % at {:.0} ms, rise {:.0} ms", t10 * 1e3, t90 * 1e3, (t90 - t10) * 1e3);
    assert!((0.2..=0.6).contains(&(t90 - t10)), "10→90 % rise {:.0} ms outside 200–600 ms", (t90 - t10) * 1e3);
}

#[test]
fn piano_stab_decays() {
    // chord4 held 2 s. Level: 20 ms RMS frames; the first frame after the
    // peak 20 dB below it. Brightness: one 85 ms Hann frame centred at 30 ms
    // (zeros before the onset) vs one centred at 0.5 s.
    let r = play(&mut load("Piano Stab"), &CHORD4, 100, 2.0, 0.0);
    let env = rms_env_db(&r, 0.02);
    let (pk_i, pk) = env.iter().enumerate().fold((0, f32::MIN), |m, (i, &v)| if v > m.1 { (i, v) } else { m });
    let t20 = env.iter().skip(pk_i).position(|&v| v <= pk - 20.0).map(|i| (i + pk_i) as f32 * 0.02);
    let (c30, c500) = (centroid_short(&r, 0.03 - 0.0425, 0.03 + 0.0425), centroid_short(&r, 0.5 - 0.0425, 0.5 + 0.0425));
    eprintln!("Piano Stab: −20 dB at {t20:?} s; centroid 30 ms {c30:.0} Hz, 0.5 s {c500:.0} Hz ({:.2}×)", c500 / c30);
    let t20 = t20.expect("falls 20 dB while held");
    assert!((0.4..=1.5).contains(&t20), "falls 20 dB after {t20:.2} s, not 0.4–1.5 s");
    assert!(c500 < 0.7 * c30, "centroid at 0.5 s {c500:.0} Hz is not < 0.7 × that at 30 ms {c30:.0} Hz");
}

#[test]
fn tine_keys_bell_follows_velocity() {
    // C4, one Hann window of 4096 from 10 ms: Σ A_k² (k ≥ 5) over A_1², in dB.
    let bell = |vel: u8| {
        let r = play(&mut load("Tine Keys"), &[60], vel, 0.5, 0.0);
        let h = harmonics(&r, hz(60), 0.01, 4096);
        let hi: f32 = h[4..].iter().map(|a| a * a).sum();
        10.0 * (hi / (h[0] * h[0])).log10()
    };
    let (b40, b127) = (bell(40), bell(127));
    eprintln!("Tine Keys bell (h≥5 re h1): vel 40 {b40:.1} dB, vel 127 {b127:.1} dB");
    assert!(b127 - b40 >= 6.0, "vel 127 rings the bell only {:.1} dB more than vel 40", b127 - b40);
}

/// Tine Keys module indices (`housePatches.ts`), checked against the fixture.
const TINE_MIDI: (usize, ModuleKind) = (0, ModuleKind::MidiIn);
const TINE_BODY_VCA: (usize, ModuleKind) = (5, ModuleKind::Vca);

/// Tine Keys with only its tine sounding (the body's amp VCA at 0).
fn tine_only() -> Engine {
    let p = patch("Tine Keys");
    for m in [TINE_MIDI, TINE_BODY_VCA] {
        assert_eq!(kind_at(&p, m.0), Some(m.1), "Tine Keys module {} is not {:?}: update the index", m.0, m.1);
    }
    let mut e = load("Tine Keys");
    set(&mut e, TINE_BODY_VCA, "level", 0.0);
    e
}

#[test]
fn tine_keys_top_octave_fades() {
    // The tine is 14× the note; the Osc caps at 0.45 × SR, so in the top
    // octave it would pin there as an inharmonic whistle. Key scaling fades
    // it to nothing by D#6 (14 × 1245 Hz = 17.4 kHz < 0.4 × 44.1 kHz).
    // Tine-only renders at vel 127, 0–150 ms: the power within ±300 Hz of
    // where the tine would sound, re the h1 power of the same render with the
    // body on.
    let tine_db = |note: u8| {
        let ft = (14.0 * hz(note)).min(0.45 * SR);
        let r = play(&mut tine_only(), &[note], 127, 0.15, 0.0);
        let full = play(&mut load("Tine Keys"), &[note], 127, 0.15, 0.0);
        let band = |r: &Render, f: f32, w: f32| -> f64 {
            spectrum(r, 0.0, 0.15).iter().enumerate().filter(|(i, _)| (*i as f32 * BIN_HZ - f).abs() <= w).map(|x| *x.1).sum()
        };
        10.0 * (band(&r, ft, 300.0) / band(&full, hz(note), 0.25 * hz(note))).log10()
    };
    let low = tine_db(72);
    eprintln!("Tine Keys tine re h1 at vel 127: C5 {low:.1} dB");
    assert!(low >= -30.0, "the bell is gone at C5 already ({low:.1} dB)");
    for note in [87u8, 92, 96] {
        let d = tine_db(note);
        eprintln!("Tine Keys tine re h1 at vel 127: note {note} {d:.1} dB");
        assert!(d <= -60.0, "note {note}: the tine is still {d:.1} dB re h1");
    }
}

/// Tine Keys, tine only, one voice, with a DC probe: the tine osc (7) → tine
/// VCA (8) cable is replaced by an Attenuator (amount 0, offset 1: a constant
/// 1), so the output is the tine envelope itself (× a fixed gain), free of the
/// 14× sine's beating. With `raw_vel` the pre-fix wiring is rebuilt: the live
/// velocity² steps the level instead of gliding in the envelope's `vel`.
fn tine_probe(raw_vel: bool) -> Engine {
    let mut e = tine_only();
    set(&mut e, TINE_MIDI, "voices", 1.0);
    // Packed port = module × 16 + port.
    let probe = (17usize, ModuleKind::Attenuator);
    assert_eq!(e.command(OP_RACK_ADD_MODULE, 0., probe.0 as f64, probe.1 as u32 as f64, 0.), OK);
    set(&mut e, probe, "amount", 0.0);
    set(&mut e, probe, "offset", 1.0);
    assert_eq!(e.command(OP_RACK_DISCONNECT, 0., 128., 0., 0.), OK); // osc 7 → VCA 8 `in`
    assert_eq!(e.command(OP_RACK_CONNECT, 0., (17 * 16) as f64, 128., 0.), OK);
    if raw_vel {
        // The pre-fix wiring: the envelope's `vel` unpatched and the live
        // velocity² (VCA 10) multiplying the tine after its VCA.
        let raw = (18usize, ModuleKind::Vca);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 0., raw.0 as f64, raw.1 as u32 as f64, 0.), OK);
        assert_eq!(e.command(OP_RACK_DISCONNECT, 0., 145., 0., 0.), OK); // VCA 16 → ADSR 9 `vel`
        assert_eq!(e.command(OP_RACK_DISCONNECT, 0., 177., 0., 0.), OK); // VCA 8 → mixer 11 `in2`
        assert_eq!(e.command(OP_RACK_CONNECT, 0., 128., (18 * 16) as f64, 0.), OK); // VCA 8 → raw `in`
        assert_eq!(e.command(OP_RACK_CONNECT, 0., 160., (18 * 16 + 1) as f64, 0.), OK); // VCA 10 (vel²) → raw `cv`
        assert_eq!(e.command(OP_RACK_CONNECT, 0., (18 * 16) as f64, 177., 0.), OK); // raw → mixer 11 `in2`
    }
    settle(&mut e);
    e
}

/// C4 at vel 127, stolen by D4 at vel 20 10 ms later (the C4 tine still rings
/// near full level, so the restarted attack can't hide a step). Returns the
/// largest one-sample drop of the tine envelope around the steal, and the
/// bound for a glide: the new velocity² (Δ ≤ 1) reached through the ADSR's
/// latched 5 ms one-pole, ×3 for margin, in the same units (the tine
/// envelope's full-scale peak, measured from a lone C4 at vel 127).
fn tine_steal_drop(raw_vel: bool) -> (f32, f32) {
    let peak = play(&mut tine_probe(raw_vel), &[60], 127, 0.05, 0.0).m.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    let t = 0.01;
    let ev = [(0.0, Ev::On(60, 127)), (t, Ev::On(62, 20)), (0.2, Ev::Off(60)), (0.2, Ev::Off(62))];
    let r = run(&mut tine_probe(raw_vel), &ev, 0.2);
    let on = (onset(t) * SR) as usize;
    let worst = (on - 8..on + (0.03 * SR) as usize).map(|i| r.m[i - 1] - r.m[i]).fold(f32::MIN, f32::max) / peak;
    let bound = 3.0 * (1.0 - (-1.0 / (0.005 * SR)).exp());
    eprintln!("Tine Keys steal (raw vel {raw_vel}): largest one-sample drop {worst:.4} of full scale; glide bound {bound:.4}");
    (worst, bound)
}

#[test]
fn tine_keys_steal_does_not_step() {
    // The tine's level must glide to the new velocity (the ADSR's latched 5 ms
    // glide), not jump with the raw `vel`. Measured on a DC probe so it is
    // deterministic; the same measurement of the old raw-vel wiring must fail
    // the bound (≈0.97 in one sample), proving the probe can tell them apart.
    let (worst, bound) = tine_steal_drop(false);
    assert!(worst <= bound, "the tine steps {worst:.4} (> {bound:.4}) in one sample at the steal");
    let (raw, bound) = tine_steal_drop(true);
    assert!(raw > 10.0 * bound, "the probe can't see the old step: raw vel drops only {raw:.4} (bound {bound:.4})");
}

#[test]
fn brass_stab_blooms() {
    // chord4: centroid of one Hann frame over 30–60 ms vs over 0–10 ms.
    let r = play(&mut load("Brass Stab"), &CHORD4, 100, 0.5, 0.0);
    let (c0, c1) = (centroid_short(&r, 0.0, 0.01), centroid_short(&r, 0.03, 0.06));
    eprintln!("Brass Stab: centroid 0–10 ms {c0:.0} Hz, 30–60 ms {c1:.0} Hz ({:.2}×)", c1 / c0);
    assert!(c1 > 1.15 * c0, "no bloom: {c0:.0} → {c1:.0} Hz");
}

#[test]
fn arp_pluck_is_short() {
    // chord4 held 1 s: 20 dB below the peak (20 ms RMS) within 250 ms of the
    // onset even when held (no sustain), so a held arp note is gone by the
    // second 1/16 after the next (121 ms each at 124 BPM).
    let r = play(&mut load("Arp Pluck"), &CHORD4, 100, 1.0, 0.0);
    let env = rms_env_db(&r, 0.02);
    let (pk_i, pk) = env.iter().enumerate().fold((0, f32::MIN), |m, (i, &v)| if v > m.1 { (i, v) } else { m });
    let t20 = env.iter().skip(pk_i).position(|&v| v <= pk - 20.0).map(|i| (i + pk_i) as f32 * 0.02);
    eprintln!("Arp Pluck: −20 dB at {t20:?} s");
    let t20 = t20.expect("falls 20 dB while held");
    assert!(t20 <= 0.25, "falls 20 dB only after {t20:.2} s");
}

#[test]
fn garage_organ_is_percussive() {
    // chord4 held 1 s: the 20 ms RMS frame at 300 ms vs the loudest frame.
    let r = play(&mut load("Garage Organ"), &CHORD4, 100, 1.0, 0.0);
    let env = rms_env_db(&r, 0.02);
    let pk = env.iter().cloned().fold(f32::MIN, f32::max);
    let at = env[(0.3 / 0.02) as usize];
    eprintln!("Garage Organ: peak {pk:.1} dB, at 300 ms {at:.1} dB ({:.1} dB)", at - pk);
    assert!(at - pk <= -6.0, "only {:.1} dB down at 300 ms", at - pk);
}

#[test]
fn garage_organ_release_is_longer() {
    // Plan 13 Task 4 (the user: "probably needs a bit longer release"). chord4
    // held 0.2 s at vel 100. Levels are 20 ms RMS windows: the one ending at
    // the note-off vs the one centred 250 ms after it; then a 100 ms window
    // from note-off + 1.5 s, absolute.
    let r = play(&mut load("Garage Organ"), &CHORD4, 100, 0.2, 1.7);
    let off = onset(0.2);
    let at_off = db(rms(r.span(off - 0.02, off)));
    let later = db(rms(r.span(off + 0.24, off + 0.26)));
    let tail = db(rms(r.span(off + 1.5, off + 1.6)));
    eprintln!("Garage Organ: at note-off {at_off:.1} dB, +250 ms {later:.1} dB ({:.1} dB), +1.5 s {tail:.1} dBFS", later - at_off);
    assert!(later - at_off >= -30.0, "250 ms after the note-off only {:.1} dB (want ≥ −30) below the level at it", later - at_off);
    assert!(tail < -60.0, "still {tail:.1} dBFS 1.5 s after the note-off");
}

/// Piano Stab's low share before plan 13 Task 4: [`low_share_db`] of its
/// chord4 phrase was −10.4 dB at 48 kHz, −10.1 at 44.1 kHz and −10.3 at 96 kHz;
/// the highest (44.1 kHz) is kept, so the +3 dB holds at every rate. Only the
/// saw's C4 fundamental (262 Hz) lay below 300 Hz.
const PIANO_STAB_LOW_SHARE_BEFORE: f32 = -10.1;

/// Power below 300 Hz over the total (dB), Welch spectrum of the whole render.
fn low_share_db(r: &Render) -> f32 {
    let p = spectrum(r, 0.0, r.m.len() as f32 / SR);
    let low: f64 = p.iter().enumerate().filter(|(i, _)| (*i as f32) * BIN_HZ < 300.0).map(|x| *x.1).sum();
    let total: f64 = p.iter().sum();
    (10.0 * (low / total).log10()) as f32
}

/// Power below `hz` over the total (dB), Welch spectrum of the whole render
/// with frames scaled to the rate (4096 at 44.1/48 kHz, 8192 at 96 kHz), so
/// the bins stay ~11 Hz wide and a 131 Hz partial's Hann main lobe (±2 bins)
/// stays above a 120 Hz edge at every rate.
fn share_below_db(r: &Render, hz: f32) -> f32 {
    let n = ((FFT_N as f32 * SR / 48000.0).round() as usize).next_power_of_two();
    let p = welch(r, 0.0, r.m.len() as f32 / SR, n);
    let bin = SR / n as f32;
    let low: f64 = p.iter().enumerate().filter(|(i, _)| (*i as f32) * bin < hz).map(|x| *x.1).sum();
    let total: f64 = p.iter().sum();
    (10.0 * (low / total).log10()) as f32
}

#[test]
fn piano_stab_has_body() {
    // Plan 13 Task 4 (the user: "good, but missing some depth"; depth =
    // low-mid body, not reverb). The chord4 phrase as the level test plays
    // it (vel 100, held 1.5 s, 0.5 s release): its share of power below
    // 300 Hz is ≥ 3 dB above the old patch's.
    let r = play_phrase(&mut load("Piano Stab"), Phrase::Chord4, 100, 1.5, 0.5);
    let s = low_share_db(&r);
    eprintln!("Piano Stab: below 300 Hz {s:.1} dB of the total (before: {PIANO_STAB_LOW_SHARE_BEFORE} dB)");
    assert!(s >= PIANO_STAB_LOW_SHARE_BEFORE + 3.0, "low share {s:.1} dB, want ≥ {:.1}", PIANO_STAB_LOW_SHARE_BEFORE + 3.0);
}

/// Organ Bass's share of power below 120 Hz before plan 16 Task 1
/// ([`organ_bass_depth`]): −4.49 dB at 48 kHz, −4.47 at 44.1 kHz, −4.50 at
/// 96 kHz; the highest (44.1 kHz) is kept, so the +0.5 dB holds at every rate.
/// Only C2's 65 Hz fundamental lay below 120 Hz. (Sub Bass: −1.8 dB.)
const ORGAN_BASS_DEEP_SHARE_BEFORE: f32 = -4.47;

/// A patch's bass phrase as the level test plays it (C2 then C3, vel 100,
/// each held 1.5 s, 0.5 s release): its share of power below 120 Hz (dB).
/// Below 120 Hz is the sub/fundamental region: C2's 65 Hz fundamental, and
/// (with Organ Bass's sub sine) C1's 33 Hz and C3's sub at 65 Hz.
fn organ_bass_depth(name: &str) -> f32 {
    let r = play_phrase(&mut load(name), Phrase::Bass, 100, 1.5, 0.5);
    share_below_db(&r, 120.0)
}

#[test]
fn organ_bass_has_a_little_more_depth() {
    // Plan 16 Task 1 (the owner: "good, missing some depth, but it probably
    // shouldn't be too deep"): a little more of the power below 120 Hz than
    // before (≥ +0.5 dB), but still clearly less than the Sub Bass (≥ 1 dB
    // under it).
    let (organ, sub) = (organ_bass_depth("Organ Bass"), organ_bass_depth("Sub Bass"));
    eprintln!("below 120 Hz: Organ Bass {organ:.2} dB (before: {ORGAN_BASS_DEEP_SHARE_BEFORE} dB), Sub Bass {sub:.2} dB");
    assert!(organ >= ORGAN_BASS_DEEP_SHARE_BEFORE + 0.5, "Organ Bass below 120 Hz {organ:.2} dB, want ≥ {:.2}", ORGAN_BASS_DEEP_SHARE_BEFORE + 0.5);
    assert!(organ <= sub - 1.0, "Organ Bass below 120 Hz {organ:.2} dB is as deep as the Sub Bass's {sub:.2} dB");
}

#[test]
fn warm_pad_moves() {
    // 124 BPM (the default tempo), transport playing so the 2-bar LFO is
    // locked to the bar: one cycle is 8 beats = 3.871 s. chord5 held; the
    // centroid of 0.25 s windows over one cycle after the swell (from 1.2 s).
    let mut e = load("Warm Pad");
    assert_eq!(e.command(OP_SET_TEMPO, 124.0, 0., 0., 0.), OK);
    assert_eq!(e.command(OP_PLAY, 0.0, 0., 0., 0.), OK);
    let cycle = 8.0 * 60.0 / 124.0;
    let r = play(&mut e, &CHORD5, 100, 1.2 + cycle, 0.0);
    let cs: Vec<f32> = (0..(cycle / 0.25) as usize).map(|i| centroid(&r, 1.2 + 0.25 * i as f32, 1.45 + 0.25 * i as f32)).collect();
    let (lo, hi) = (cs.iter().cloned().fold(f32::MAX, f32::min), cs.iter().cloned().fold(f32::MIN, f32::max));
    eprintln!("Warm Pad: centroid over one 2-bar cycle {lo:.0}–{hi:.0} Hz ({:.2}×): {:?}", hi / lo, cs.iter().map(|c| c.round()).collect::<Vec<_>>());
    assert!(hi >= 1.15 * lo, "centroid varies only {:.1} %", 100.0 * (hi / lo - 1.0));
}

// ---- plan 12: a Scope never changes the sound ----------------------------------

/// The first module of `kind` in `p` (its idx).
fn first_of(p: &HousePatch, kind: ModuleKind) -> usize {
    (0..32).find(|&i| kind_at(p, i) == Some(kind)).unwrap_or_else(|| panic!("{} has no {kind:?}", p.name))
}

/// The packed output feeding Out's `l` in `p`.
fn into_out(p: &HousePatch) -> f64 {
    let out = first_of(p, ModuleKind::Out);
    p.cmds
        .iter()
        .find(|c| c[0] as u32 == OP_RACK_CONNECT && c[3] as usize == out * 16)
        .map(|c| c[2])
        .expect("a cable into Out.l")
}

#[test]
fn scopes_never_change_the_sound() {
    // The Sax and the Warm Pad phrase, rendered plain and with four Scopes
    // (modules 28..31) added mid-note on four outputs: an oscillator (the
    // feedback-free audio path), what feeds Out, the LFO (a modulation
    // path) and an envelope. Then every Scope param is set (choices too),
    // a B input is disconnected and two Scopes are removed, all while
    // sounding. Every output sample is bit-identical.
    for name in ["Sax", "Warm Pad"] {
        let p = patch(name);
        let osc = (first_of(&p, ModuleKind::Osc) * 16) as f64;
        let lfo = (first_of(&p, ModuleKind::Lfo) * 16) as f64;
        let env = (first_of(&p, ModuleKind::Adsr) * 16) as f64;
        let out = into_out(&p);
        let step = p.phrase.step().unwrap_or(1.5);
        let plain = play_phrase(&mut load(name), p.phrase, 100, step, 0.5);
        let scope = spec(ModuleKind::Scope);
        let at = |sec: f32| ((sec * SR) as usize).div_ceil(BLOCK) * BLOCK;
        let ok = |c: i32| assert_eq!(c, OK);
        let mut e = load(name);
        let scoped = play_phrase_with(&mut e, p.phrase, 100, step, 0.5, &mut |e, t| {
            let cmd = |e: &mut Engine, op: u32, b: f64, c: f64, d: f64| ok(e.command(op, 0., b, c, d));
            if t == at(0.2) {
                for (s, (a, b)) in [(osc, out), (lfo, env), (out, -1.0), (env, lfo)].into_iter().enumerate() {
                    let m = 28 + s;
                    cmd(e, OP_RACK_ADD_MODULE, m as f64, ModuleKind::Scope as u32 as f64, 0.);
                    cmd(e, OP_RACK_CONNECT, a, (m * 16) as f64, 0.);
                    if b >= 0.0 {
                        cmd(e, OP_RACK_CONNECT, b, (m * 16 + 1) as f64, 0.);
                    }
                }
            } else if t == at(0.4) {
                for m in 28..32 {
                    for (i, q) in scope.params.iter().enumerate() {
                        cmd(e, OP_RACK_SET_PARAM, m as f64, i as f64, q.max as f64);
                        cmd(e, OP_RACK_SET_PARAM, m as f64, i as f64, q.min as f64);
                    }
                }
            } else if t == at(0.6) {
                cmd(e, OP_RACK_DISCONNECT, (28 * 16 + 1) as f64, 0., 0.);
                cmd(e, OP_RACK_REMOVE_MODULE, 29., 0., 0.);
                cmd(e, OP_RACK_REMOVE_MODULE, 31., 0., 0.);
            }
        });
        assert!(plain.peak > 0.01, "{name} sounds");
        assert_eq!(plain.m.len(), scoped.m.len());
        let first = plain.m.iter().zip(&scoped.m).position(|(a, b)| a.to_bits() != b.to_bits());
        assert_eq!(first, None, "{name}: the scopes changed the sound at sample {first:?}");
        assert_eq!(plain.bits, scoped.bits, "{name}: raw L/R differ");
    }
}

// ---- plan 28: seven more house patches and two transition patches ------------
//
// Spec `2026-11-19-builtin-content.md` §4. The new patches go through the
// shared level / clip / release tests above like the rest; here are their
// example-roll levels (against the older rolls), one character check each,
// and the two transition patches (Noise Sweep, Impact), which skip the
// shared loops (phrase `fx`) and are measured on their own.

/// The House set before plan 28: their example rolls set the level reference.
const PLAN11_SET: [&str; 12] = [
    "Sax", "Brass Stab", "Arp Pluck", "Tine Keys", "Piano Stab", "Garage Organ", "Organ Bass", "Reese Bass", "Acid Line",
    "Sub Bass", "Strings", "Warm Pad",
];
/// Plan 28's new house patches (each has an example roll).
const PLAN28_SET: [&str; 7] = ["Supersaw Lead", "Hoover", "Soft Pluck", "Bright Pluck", "90s Organ", "FM Bell", "Formant Pad"];
/// How far a new patch's example-roll RMS may sit from the older rolls' median (dB).
const EXAMPLE_TOL: f32 = 3.0;

#[test]
fn new_examples_match_the_older_levels() {
    // Each roll played once at 124 BPM, as written (its own velocities); the
    // RMS over the roll's span. The older rolls' spread: −19.7 (Brass Stab)
    // to −15.4 dBFS (Reese Bass), median ≈ −18.0.
    let all = house_patches();
    let level = |name: &str| example_level(all.iter().find(|p| p.name == name).unwrap()).unwrap_or_else(|| panic!("{name} has no example roll"));
    let mut old: Vec<f32> = PLAN11_SET.iter().map(|n| level(n).0).collect();
    old.sort_by(f32::total_cmp);
    let median = 0.5 * (old[5] + old[6]);
    eprintln!("older example rolls: {old:?} dBFS, median {median:.1}");
    let mut failed = Vec::new();
    for n in PLAN28_SET {
        let (rms_db, peak) = level(n);
        eprintln!("{n} example: RMS {rms_db:.1} dBFS ({:+.1} dB re median), peak {peak:.2}", rms_db - median);
        if (rms_db - median).abs() > EXAMPLE_TOL {
            failed.push(format!("{n} {rms_db:.1}"));
        }
    }
    assert!(failed.is_empty(), "example RMS outside {median:.1} ± {EXAMPLE_TOL} dB: {failed:?}");
}

/// Power-weighted RMS spread (cents) of the spectrum within ±60 cents of
/// harmonic `k` of `f0`, from a Welch spectrum of 32768-point Hann frames
/// (1.5 Hz bins at 48 kHz) between `a` and `b` s. A single clean partial
/// reads ~3 ct (the window's main lobe); detuned copies and chorus widen it.
fn spread_cents(r: &Render, f0: f32, k: u32, a: f32, b: f32) -> f32 {
    let n = 32768;
    let p = welch(r, a, b, n);
    let fk = k as f32 * f0;
    let (mut w, mut m1, mut m2) = (0.0f64, 0.0f64, 0.0f64);
    for (i, pw) in p.iter().enumerate() {
        let f = i as f32 * SR / n as f32;
        if f <= 0.0 {
            continue;
        }
        let c = cents(f, fk) as f64;
        if c.abs() <= 60.0 {
            w += pw;
            m1 += pw * c;
            m2 += pw * c * c;
        }
    }
    let mean = m1 / w;
    (m2 / w - mean * mean).sqrt() as f32
}

#[test]
fn supersaw_lead_is_wide() {
    // C4 held 2.5 s, vel 100; spread around harmonics 4–6 (1.0–1.6 kHz,
    // where 60 ct is ~37 bins), 0.3–2.5 s. Reference: Strings (four saws
    // over ±11 ct, chorus) and Brass Stab (three over ±9 ct plus one +7 ct).
    let spread = |name: &str| {
        let r = play(&mut load(name), &[60], 100, 2.5, 0.0);
        (4..=6).map(|k| spread_cents(&r, hz(60), k, 0.3, 2.5)).sum::<f32>() / 3.0
    };
    let (saw, strings, brass) = (spread("Supersaw Lead"), spread("Strings"), spread("Brass Stab"));
    let r = play_phrase(&mut load("Supersaw Lead"), Phrase::Chord4, 100, 1.5, 0.0);
    eprintln!(
        "Supersaw Lead: spread around h4–h6 {saw:.1} ct (Strings {strings:.1}, Brass Stab {brass:.1}); chord4 centroid {:.0} Hz",
        centroid(&r, 0.05, 1.5)
    );
    assert!(saw >= 1.5 * strings && saw >= 1.5 * brass, "spread {saw:.1} ct is not 1.5× Strings' {strings:.1} and Brass Stab's {brass:.1}");
}

#[test]
fn hoover_swoops_into_the_note() {
    // C4 held 1 s, vel 100. f0 per 40 ms frame (10 ms hop) over 0.4–1.3 × f0
    // (the swoop starts an octave down). The first frame (centred 20 ms) is
    // well below the note; from 0.4 s the mean is on it.
    let f0 = hz(60);
    let r = play(&mut load("Hoover"), &[60], 100, 1.0, 0.0);
    let track = f0_track(&r, 0.0, 1.0, 0.45 * f0, 1.3 * f0);
    let ct: Vec<(f32, f32)> = track.iter().map(|x| (x.0, cents(x.1, f0))).collect();
    let at = |t: f32| ct.iter().min_by(|a, b| (a.0 - t).abs().total_cmp(&(b.0 - t).abs())).unwrap().1;
    let settled: Vec<f32> = ct.iter().filter(|x| x.0 >= 0.4).map(|x| x.1).collect();
    let mean = settled.iter().sum::<f32>() / settled.len() as f32;
    let arrive = ct.iter().find(|x| x.1 >= -50.0).map(|x| x.0);
    eprintln!(
        "Hoover swoop (ct re C4): 20 ms {:.0}, 60 ms {:.0}, 100 ms {:.0}, 150 ms {:.0}, 200 ms {:.0}, 300 ms {:.0}; within 50 ct at {arrive:?} s; 0.4–1 s mean {mean:.1}",
        at(0.02), at(0.06), at(0.1), at(0.15), at(0.2), at(0.3)
    );
    eprintln!("Hoover: centroid C4 0.4–1 s {:.0} Hz", centroid(&r, 0.4, 1.0));
    assert!(at(0.02) <= -500.0, "starts only {:.0} ct under the note", at(0.02));
    assert!(mean.abs() <= 15.0, "settles {mean:.1} ct off the note");
    let arrive = arrive.expect("reaches the note");
    assert!((0.08..=0.35).contains(&arrive), "within 50 ct after {arrive:.2} s (want 0.08–0.35 s)");
}

/// The strongest formant region between `lo` and `hi` Hz over `a..b` s: the
/// centre (Hz) of the third-octave band with the highest mean power density
/// (centres every 1/24 oct), from a Welch spectrum. Third-octave smoothing
/// spreads the chord's dense harmonics into a spectral envelope, so the
/// formant (not one strong harmonic) wins.
fn formant_peak(r: &Render, a: f32, b: f32, lo: f32, hi: f32) -> f32 {
    let p = spectrum(r, a, b);
    let mut best = (lo, f64::MIN);
    let mut fc = lo;
    while fc <= hi {
        let (f1, f2) = (fc * 2f32.powf(-1.0 / 6.0), fc * 2f32.powf(1.0 / 6.0));
        let band: Vec<f64> = p.iter().enumerate().filter(|(i, _)| (f1..=f2).contains(&(*i as f32 * BIN_HZ))).map(|x| *x.1).collect();
        let d = band.iter().sum::<f64>() / band.len().max(1) as f64;
        if d > best.1 {
            best = (fc, d);
        }
        fc *= 2f32.powf(1.0 / 24.0);
    }
    best.0
}

#[test]
fn formant_pad_vowel_moves() {
    // As warm_pad_moves: 124 BPM, transport playing so the 2-bar LFO is
    // locked; chord5 held; 0.5 s windows every 0.25 s over one cycle after
    // the swell (from 1.2 s). The first formant (strongest third-octave band
    // over 300–1600 Hz) must move ≥ 0.6 oct, and the centroid with it.
    let mut e = load("Formant Pad");
    assert_eq!(e.command(OP_SET_TEMPO, 124.0, 0., 0., 0.), OK);
    assert_eq!(e.command(OP_PLAY, 0.0, 0., 0., 0.), OK);
    let cycle = 8.0 * 60.0 / 124.0;
    let r = play(&mut e, &CHORD5, 100, 1.2 + cycle + 0.5, 0.0);
    let win: Vec<f32> = (0..(cycle / 0.25) as usize).map(|i| 1.2 + 0.25 * i as f32).collect();
    let f1: Vec<f32> = win.iter().map(|&t| formant_peak(&r, t, t + 0.5, 300.0, 1600.0)).collect();
    let cs: Vec<f32> = win.iter().map(|&t| centroid(&r, t, t + 0.5)).collect();
    let span = |v: &[f32]| (v.iter().cloned().fold(f32::MAX, f32::min), v.iter().cloned().fold(f32::MIN, f32::max));
    let ((f_lo, f_hi), (c_lo, c_hi)) = (span(&f1), span(&cs));
    eprintln!("Formant Pad: F1 {f_lo:.0}–{f_hi:.0} Hz ({:.2} oct): {:?}", (f_hi / f_lo).log2(), f1.iter().map(|x| x.round()).collect::<Vec<_>>());
    eprintln!("Formant Pad: centroid {c_lo:.0}–{c_hi:.0} Hz ({:.2}×)", c_hi / c_lo);
    assert!((f_hi / f_lo).log2() >= 0.6, "the formant moves only {:.2} oct", (f_hi / f_lo).log2());
    assert!(c_hi >= 1.15 * c_lo, "centroid varies only {:.1} %", 100.0 * (c_hi / c_lo - 1.0));
}

/// The share of power (50 Hz–10 kHz) farther than f0/8 from every harmonic
/// of `f0`, between `a` and `b` s.
fn inharmonic_share(r: &Render, f0: f32, a: f32, b: f32) -> f32 {
    let p = spectrum(r, a, b);
    let (mut all, mut off) = (0.0f64, 0.0f64);
    for (i, pw) in p.iter().enumerate() {
        let f = i as f32 * BIN_HZ;
        if (50.0..=10000.0).contains(&f) {
            all += pw;
            if (f - (f / f0).round() * f0).abs() > f0 / 8.0 || f < 0.5 * f0 {
                off += pw;
            }
        }
    }
    (off / all) as f32
}

#[test]
fn fm_bell_is_inharmonic_and_rings() {
    // C5 (523 Hz) held 4 s, vel 100. Inharmonic share at the strike (0–0.5 s)
    // and later (2–3 s, the index has decayed); Tine Keys (harmonic FM) as
    // the control. Level: 20 ms RMS frames, 20 dB under the peak.
    let f0 = hz(72);
    let bell = play(&mut load("FM Bell"), &[72], 100, 4.0, 0.0);
    let tine = play(&mut load("Tine Keys"), &[72], 100, 4.0, 0.0);
    let (b0, b2, t0) = (inharmonic_share(&bell, f0, 0.0, 0.5), inharmonic_share(&bell, f0, 2.0, 3.0), inharmonic_share(&tine, f0, 0.0, 0.5));
    let env = rms_env_db(&bell, 0.02);
    let (pk_i, pk) = env.iter().enumerate().fold((0, f32::MIN), |m, (i, &v)| if v > m.1 { (i, v) } else { m });
    let t20 = env.iter().skip(pk_i).position(|&v| v <= pk - 20.0).map(|i| (i + pk_i) as f32 * 0.02);
    eprintln!(
        "FM Bell C5: inharmonic {:.0} % at 0–0.5 s, {:.0} % at 2–3 s (Tine Keys {:.0} %); −20 dB at {t20:?} s; centroid 0–0.5 s {:.0} Hz, 2–3 s {:.0} Hz",
        100.0 * b0, 100.0 * b2, 100.0 * t0, centroid(&bell, 0.0, 0.5), centroid(&bell, 2.0, 3.0)
    );
    assert!(b0 >= 0.25, "only {:.0} % inharmonic at the strike", 100.0 * b0);
    assert!(t0 <= 0.1, "control: Tine Keys reads {:.0} % inharmonic", 100.0 * t0);
    assert!(b2 < b0, "the clang does not fade ({:.0} % → {:.0} %)", 100.0 * b0, 100.0 * b2);
    let t20 = t20.unwrap_or(4.0);
    assert!(t20 >= 1.5, "falls 20 dB after {t20:.2} s (want a long ring, ≥ 1.5 s)");
}

#[test]
fn nineties_organ_is_brighter_and_shorter_than_garage() {
    // chord4 held 1 s, vel 100: centroid over the stab (0–0.3 s), and the
    // 20 ms RMS frame at 300 ms re the loudest, against Garage Organ.
    let measure = |name: &str| {
        let r = play(&mut load(name), &CHORD4, 100, 1.0, 0.0);
        let env = rms_env_db(&r, 0.02);
        let pk = env.iter().cloned().fold(f32::MIN, f32::max);
        let t20 = env.iter().position(|&v| v <= pk - 20.0).map(|i| i as f32 * 0.02);
        (centroid(&r, 0.0, 0.3), env[(0.3 / 0.02) as usize] - pk, t20)
    };
    let (c90, d90, t90) = measure("90s Organ");
    let (cg, dg, tg) = measure("Garage Organ");
    eprintln!("90s Organ: centroid 0–0.3 s {c90:.0} Hz, at 300 ms {d90:.1} dB, −20 dB at {t90:?} s; Garage Organ {cg:.0} Hz, {dg:.1} dB, {tg:?} s");
    assert!(c90 >= 1.2 * cg, "centroid {c90:.0} Hz is not 1.2 × Garage Organ's {cg:.0}");
    assert!(d90 <= dg - 6.0, "at 300 ms {d90:.1} dB is not 6 dB shorter than Garage Organ's {dg:.1} dB");
}

#[test]
fn plucks_differ_in_brightness() {
    // chord4 held 1 s, vel 100: centroid of one Hann frame over the first
    // 150 ms (the pluck), and the time to fall 20 dB under the peak (20 ms
    // RMS frames) while held: both are plucks (no sustain).
    let measure = |name: &str| {
        let r = play(&mut load(name), &CHORD4, 100, 1.0, 0.0);
        let env = rms_env_db(&r, 0.02);
        let (pk_i, pk) = env.iter().enumerate().fold((0, f32::MIN), |m, (i, &v)| if v > m.1 { (i, v) } else { m });
        let t20 = env.iter().skip(pk_i).position(|&v| v <= pk - 20.0).map(|i| (i + pk_i) as f32 * 0.02);
        (centroid_short(&r, 0.0, 0.15), centroid(&r, 0.3, 1.0), t20)
    };
    let (soft, soft_late, soft_t) = measure("Soft Pluck");
    let (bright, bright_late, bright_t) = measure("Bright Pluck");
    eprintln!("Soft Pluck: centroid 0–150 ms {soft:.0} Hz, 0.3–1 s {soft_late:.0} Hz, −20 dB at {soft_t:?} s");
    eprintln!("Bright Pluck: centroid 0–150 ms {bright:.0} Hz, 0.3–1 s {bright_late:.0} Hz, −20 dB at {bright_t:?} s");
    assert!(bright >= 2.5 * soft, "Bright Pluck {bright:.0} Hz is not 2.5 × Soft Pluck's {soft:.0}");
    for (n, t) in [("Soft Pluck", soft_t), ("Bright Pluck", bright_t)] {
        let t = t.unwrap_or_else(|| panic!("{n} does not fall 20 dB while held"));
        assert!(t <= 0.6, "{n} falls 20 dB only after {t:.2} s");
    }
}

/// Noise Sweep's filter (`housePatches.ts`): the automated cutoff.
const SWEEP_FILTER: (usize, ModuleKind) = (2, ModuleKind::Filter);

/// Noise Sweep with its cutoff at `hz`, any key held `hold` s (vel 100),
/// `release` s more.
fn sweep_at(hz: f32, hold: f32, release: f32) -> Render {
    let mut e = load("Noise Sweep");
    set(&mut e, SWEEP_FILTER, "cutoff", hz);
    play(&mut e, &[60], 100, hold, release)
}

#[test]
fn noise_sweep_follows_its_cutoff() {
    // The cutoff is the whole sweep: its filter's cv is unpatched, so the
    // knob (or the Riser / Downlifter lane on it) is the cutoff in Hz.
    let p = patch("Noise Sweep");
    assert_eq!(kind_at(&p, SWEEP_FILTER.0), Some(SWEEP_FILTER.1), "Noise Sweep's filter moved");
    let cv = (SWEEP_FILTER.0 * 16 + 1) as f64;
    assert!(!p.cmds.iter().any(|c| c[0] as u32 == OP_RACK_CONNECT && c[3] == cv), "the filter cv is patched: the cutoff lane would not be the cutoff");
    // Held 1.5 s at fixed cutoffs: centroid (0.3–1.5 s), loudness, peak.
    // Pink noise keeps the level nearly flat across the sweep (the
    // Transition's level lane does the rise); the centroid follows the
    // cutoff (up to 8 kHz: the centroid's 10 kHz band edge hides a higher one).
    let mut last = 0.0;
    let mut loud = f32::MIN;
    for hz in [150.0, 400.0, 1000.0, 3000.0, 8000.0, 16000.0] {
        let r = sweep_at(hz, 1.5, 0.0);
        let (c, m) = (centroid(&r, 0.3, 1.5), momentary_db(&r));
        eprintln!("Noise Sweep cutoff {hz:>5} Hz: centroid {c:.0} Hz, momentary {m:.1} dBFS, peak {:.2}", r.peak);
        if hz <= 8000.0 {
            assert!(c > last * 1.15, "centroid {c:.0} Hz at {hz} Hz does not rise from {last:.0}");
        }
        assert!(r.peak < PEAK_LIMIT, "peak {:.2} at {hz} Hz", r.peak);
        assert!(m <= LOUDNESS_DB + LOUDNESS_TOL, "{m:.1} dBFS at {hz} Hz: louder than the house window");
        last = c;
        loud = loud.max(m);
    }
    assert!((loud - LOUDNESS_DB).abs() <= LOUDNESS_TOL, "loudest {loud:.1} dBFS: outside the house window");
}

#[test]
fn noise_sweep_rises_and_releases() {
    // A riser's cutoff as Add track ▸ Transition writes it: swept
    // exponentially 200 Hz → 12 kHz over 4 s (set every block, as an
    // automation lane does), then released. The last 0.5 s is ≥ 4× brighter
    // than the first, at a level within 6 dB of it (the riser's rise in
    // level is its level lane, not the patch); silent 1 s after the release.
    let mut e = load("Noise Sweep");
    let cut = spec(ModuleKind::Filter).params.iter().position(|q| q.name == "cutoff").unwrap();
    let (dur, rel) = (4.0f32, 0.4f32);
    let r = run_with(&mut e, &[(0.0, Ev::On(57, 100)), (dur, Ev::Off(57))], dur + rel + 1.2, &mut |e, t| {
        let x = (t as f32 / SR / dur).min(1.0);
        let hz = 200.0 * 60f32.powf(x);
        assert_eq!(e.command(OP_RACK_SET_PARAM, 0., SWEEP_FILTER.0 as f64, cut as f64, hz as f64), OK);
    });
    let (early, late) = (db(rms(r.span(0.0, 0.5))), db(rms(r.span(3.5, 4.0))));
    let (c0, c1) = (centroid(&r, 0.0, 0.5), centroid(&r, 3.5, 4.0));
    let tail = db(rms(r.span(dur + rel + 1.0, dur + rel + 1.1)));
    eprintln!("Noise Sweep riser: 0–0.5 s {early:.1} dB / {c0:.0} Hz, 3.5–4 s {late:.1} dB / {c1:.0} Hz; peak {:.2}; {tail:.1} dBFS at release + 1 s", r.peak);
    assert!((late - early).abs() <= 6.0, "the sweep alone moves the level {:+.1} dB", late - early);
    assert!(c1 >= 4.0 * c0, "the sweep only brightens {:.1}×", c1 / c0);
    assert!(r.peak < PEAK_LIMIT, "peak {:.2}", r.peak);
    assert!(tail < -60.0, "{tail:.1} dBFS 1 s after the release");
}

/// Impact's noise VCA (`housePatches.ts`): muted to measure the sub alone.
const IMPACT_NOISE_VCA: (usize, ModuleKind) = (7, ModuleKind::Vca);

#[test]
fn impact_level_and_peak() {
    // One hit (a 1/8 at 124 BPM, as the Transition clip writes it) at vel
    // 100: momentary loudness in the house window; at vel 127 on C2–C5
    // the pre-limiter peak stays under 0.9.
    let hit = 0.25;
    let r = play(&mut load("Impact"), &[60], 100, hit, 2.0);
    let m = momentary_db(&r);
    let worst = [36u8, 48, 57, 60, 72].iter().map(|&n| play(&mut load("Impact"), &[n], 127, hit, 2.0).peak).fold(0.0, f32::max);
    eprintln!("Impact: momentary {m:.1} dBFS at vel 100; peak {:.2} (vel 100), {worst:.2} worst at vel 127", r.peak);
    assert!((m - LOUDNESS_DB).abs() <= LOUDNESS_TOL, "momentary {m:.1} dBFS outside {LOUDNESS_DB} ± {LOUDNESS_TOL}");
    assert!(worst < PEAK_LIMIT, "pre-limiter peak {worst:.2} at vel 127");
}

/// Energy (Σ|X|²) at or above `lo` Hz of one Hann frame over `a..b` s,
/// zero-padded to ≥ 4096 points (for short spans, as [`centroid_short`]).
fn energy_above(r: &Render, a: f32, b: f32, lo: f32) -> f64 {
    let (ia, ib) = ((a * SR).round() as usize, (b * SR).round() as usize);
    let n = ib - ia;
    let nfft = n.next_power_of_two().max(FFT_N);
    let w = hann(n);
    let mut re = vec![0.0f64; nfft];
    let mut im = vec![0.0f64; nfft];
    for i in 0..n {
        re[i] = r.m[ia + i] as f64 * w[i];
    }
    fft(&mut re, &mut im);
    (0..nfft / 2).filter(|&i| i as f32 * SR / nfft as f32 >= lo).map(|i| re[i] * re[i] + im[i] * im[i]).sum()
}

#[test]
fn impact_drops_cracks_and_rings() {
    // C4 hit (0.25 s). Sub drop: noise muted (A/B), f0 over 50–250 Hz; it
    // starts ≥ an octave above where it lands, and lands on C2 (C4 − 2 oct).
    let p = patch("Impact");
    assert_eq!(kind_at(&p, IMPACT_NOISE_VCA.0), Some(IMPACT_NOISE_VCA.1), "Impact's noise VCA moved");
    let mut e = load("Impact");
    set(&mut e, IMPACT_NOISE_VCA, "level", 0.0);
    let sub = play(&mut e, &[60], 100, 0.25, 1.5);
    let base = hz(36);
    let track = f0_track(&sub, 0.0, 1.2, 50.0, 250.0);
    let at = |t: f32| track.iter().min_by(|a, b| (a.0 - t).abs().total_cmp(&(b.0 - t).abs())).unwrap().1;
    eprintln!(
        "Impact sub f0: 20 ms {:.0} Hz, 100 ms {:.0}, 200 ms {:.0}, 400 ms {:.0}, 800 ms {:.0}, 1.1 s {:.0} (C2 {base:.1})",
        at(0.02), at(0.1), at(0.2), at(0.4), at(0.8), at(1.1)
    );
    assert!(at(0.02) >= 2.0 * base, "starts at {:.0} Hz: not an octave above {base:.0}", at(0.02));
    assert!(cents(at(1.1), base).abs() <= 30.0, "lands {:.0} ct off C2", cents(at(1.1), base));
    // Crack: the full patch's energy above 2 kHz, 0–50 ms vs 300–350 ms.
    let r = play(&mut load("Impact"), &[60], 100, 0.25, 3.0);
    let crack = 10.0 * (energy_above(&r, 0.0, 0.05, 2000.0) / energy_above(&r, 0.3, 0.35, 2000.0).max(1e-30)).log10();
    // Ring: the sub carries the hit: 20 dB down (20 ms RMS) only after ≥ 0.5 s.
    let env = rms_env_db(&r, 0.02);
    let (pk_i, pk) = env.iter().enumerate().fold((0, f32::MIN), |m, (i, &v)| if v > m.1 { (i, v) } else { m });
    let t20 = env.iter().skip(pk_i).position(|&v| v <= pk - 20.0).map(|i| (i + pk_i) as f32 * 0.02).expect("decays");
    let tail = db(rms(r.span(0.25 + 1.5 + 1.0, 0.25 + 1.5 + 1.1)));
    eprintln!("Impact: >2 kHz 0–50 ms vs 300–350 ms {crack:+.1} dB; −20 dB at {t20:.2} s; {tail:.1} dBFS at release + 1 s; centroid 0–50 ms {:.0} Hz", centroid_short(&r, 0.0, 0.05));
    assert!(crack >= 20.0, "the crack fades only {crack:.1} dB");
    assert!(t20 >= 0.5, "falls 20 dB after {t20:.2} s (want the sub to ring ≥ 0.5 s)");
    assert!(tail < -60.0, "{tail:.1} dBFS 1 s after the release");
}

/// The numbers to read while tuning a house patch (plan 28): per patch, its
/// momentary loudness on its phrase, its example roll's RMS and peak, the
/// worst vel-127 peak, the centroid (whole phrase and first 150 ms) and the
/// envelope (peak frame, −10 dB rise, −20 dB fall; 20 ms frames). `DUMP=a,b`
/// limits it to those patches. Not a check:
/// `cargo test --release -p daw-engine --test house_patches house_patch_numbers -- --ignored --nocapture`
#[test]
#[ignore = "a tuning aid, not a check"]
fn house_patch_numbers() {
    let only = std::env::var("DUMP").ok();
    for p in &house_patches() {
        if let Some(o) = &only {
            if !o.split(',').any(|x| x == p.name) {
                continue;
            }
        }
        let lvl = example_level(p);
        let step = p.phrase.step().unwrap_or(1.5);
        let r = play_phrase(&mut load_cmds(&p.cmds), p.phrase, 100, step, 0.5);
        let m = momentary_db(&r);
        let end = p.phrase.steps().len() as f32 * step;
        let c = centroid(&r, 0.05, end.min(1.0));
        let c_on = centroid_short(&r, 0.0, 0.15);
        let wp = worst_peak(p).unwrap_or(0.0);
        let env = rms_env_db(&r, 0.02);
        let (pk_i, pk) = env.iter().enumerate().fold((0, f32::MIN), |m, (i, &v)| if v > m.1 { (i, v) } else { m });
        let t20 = env.iter().skip(pk_i).position(|&v| v <= pk - 20.0).map(|i| (i + pk_i) as f32 * 0.02);
        let t10 = env.iter().position(|&v| v >= pk - 10.0).map(|i| i as f32 * 0.02);
        eprintln!(
            "{:14} {:?} mom {m:.1} | ex {} | pk127 {wp:.2} | centroid {c:.0} Hz (0-150ms {c_on:.0}) | env peak at {:.2}s, -10dB rise {:?}, -20dB at {t20:?}",
            p.name,
            p.phrase,
            lvl.map(|(a, b)| format!("rms {a:.1} pk {b:.2}")).unwrap_or_default(),
            pk_i as f32 * 0.02,
            t10
        );
    }
}
