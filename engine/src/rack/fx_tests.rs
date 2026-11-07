//! Plan 6 effect modules (Delay, Reverb, Chorus, Eq, Compressor, Saturator,
//! Attenuator) and the FX pool behind Delay/Reverb/Chorus.
//!
//! Module behaviour is tested on a bare module (`Rig`: one module, its
//! ports, a small pool); pool sharing, exhaustion and slot reuse go through
//! the rack and the engine, where they matter.

use super::catalog::{spec, ModuleKind};
use super::fx_pool::{FxKind, FxPool};
use super::modules::{Ctx, Module};
use super::port::PortBuf;
use super::Rack;
use crate::dsp::test_util::{tone_gain_db, Noise};
use crate::dsp::Eq3;
use crate::mixer::catalog::{DELAY_DIVISIONS, DELAY_DIVISION_BEATS};
use crate::protocol::{ERR_OUT_OF_MEMORY, OK};
use crate::{MAX_PARAMS, RACK_BLOCK};

const SR: f32 = 48000.0;

fn ctx(bpm: f32) -> Ctx {
    Ctx { sr: SR, bpm, playing: false, ticks: 0.0, ticks_per_frame: 0.0 }
}

/// One module with its ports, params at the catalog defaults, and (for the
/// pooled kinds) a slot of a small pool.
struct Rig {
    kind: ModuleKind,
    m: Module,
    fx: FxPool,
    params: [f32; MAX_PARAMS],
    ins: Vec<PortBuf>,
    outs: Vec<PortBuf>,
    bpm: f32,
}

impl Rig {
    fn new(kind: ModuleKind) -> Rig {
        let mut fx = FxPool::with_slots(SR, 1, 1, 1);
        let m = match kind.fx_kind() {
            Some(k) => Module::with_fx_slot(kind, SR, fx.claim(k).expect("a free slot")),
            None => Module::new(kind, SR),
        };
        let s = spec(kind);
        let mut params = [0.0; MAX_PARAMS];
        for (p, d) in params.iter_mut().zip(s.params) {
            *p = d.default;
        }
        Rig {
            kind,
            m,
            fx,
            params,
            ins: vec![PortBuf::new(); s.inputs.len()],
            outs: vec![PortBuf::new(); s.outputs.len()],
            bpm: 120.0,
        }
    }

    fn set(&mut self, name: &str, v: f32) {
        let i = spec(self.kind).params.iter().position(|p| p.name == name).expect("param");
        self.params[i] = v;
    }

    fn input(&self, name: &str) -> usize {
        spec(self.kind).inputs.iter().position(|p| p.name == name).expect("input")
    }

    /// Render `frames` (whole sub-blocks); `feed(ins, frame)` fills the
    /// inputs for the sub-block starting at `frame`. Returns every output's
    /// channel 0.
    fn run(&mut self, frames: usize, mut feed: impl FnMut(&mut [PortBuf], usize)) -> Vec<Vec<f32>> {
        let mut out = vec![Vec::with_capacity(frames); self.outs.len()];
        let mut f = 0;
        while f < frames {
            feed(&mut self.ins, f);
            self.m.process(&ctx(self.bpm), &self.params, &self.ins, &mut self.outs, &mut self.fx);
            for (o, port) in out.iter_mut().zip(&self.outs) {
                o.extend_from_slice(&port.data[0]);
            }
            f += RACK_BLOCK;
        }
        out
    }
}

/// Mono signal `f(frame)` on `port` (1 channel).
fn mono(ins: &mut [PortBuf], port: usize, at: usize, mut f: impl FnMut(usize) -> f32) {
    ins[port].channels = 1;
    for i in 0..RACK_BLOCK {
        ins[port].data[0][i] = f(at + i);
    }
}

fn impulse(i: usize) -> f32 {
    if i == 0 {
        1.0
    } else {
        0.0
    }
}

fn peak(xs: &[f32]) -> f32 {
    xs.iter().fold(0.0f32, |m, x| m.max(x.abs()))
}

fn rms(xs: &[f32]) -> f32 {
    (xs.iter().map(|x| x * x).sum::<f32>() / xs.len().max(1) as f32).sqrt()
}

/// First sample above -60 dB after the dry part (frame 0).
fn echo(xs: &[f32]) -> Option<usize> {
    xs.iter().skip(1).position(|v| v.abs() > 1e-3).map(|i| i + 1)
}

fn division(name: &str) -> f32 {
    DELAY_DIVISIONS.iter().position(|d| *d == name).expect("division") as f32
}

#[test]
fn catalog_ids_fixed() {
    let want = [
        (ModuleKind::Delay, 9, "delay", "effect"),
        (ModuleKind::Reverb, 10, "reverb", "effect"),
        (ModuleKind::Chorus, 11, "chorus", "effect"),
        (ModuleKind::Eq, 12, "eq", "effect"),
        (ModuleKind::Compressor, 13, "compressor", "effect"),
        (ModuleKind::Saturator, 14, "saturator", "shaping"),
        (ModuleKind::Attenuator, 15, "attenuator", "utility"),
    ];
    for (k, id, name, category) in want {
        assert_eq!(k as u8, id);
        assert_eq!(ModuleKind::from_id(id as u32), Some(k));
        assert_eq!(spec(k).id, name);
        assert_eq!(spec(k).category, category, "{name}");
    }
    assert_eq!(ModuleKind::from_id(16), None, "SamplePlayer is task 2");
    // The stereo effects: l, r (+ sc), 1-channel l/r outs.
    for k in [ModuleKind::Delay, ModuleKind::Reverb, ModuleKind::Chorus, ModuleKind::Eq, ModuleKind::Compressor] {
        let s = spec(k);
        let ins: Vec<&str> = s.inputs.iter().map(|p| p.name).collect();
        let outs: Vec<&str> = s.outputs.iter().map(|p| p.name).collect();
        let want_ins: &[&str] = if k == ModuleKind::Compressor { &["l", "r", "sc"] } else { &["l", "r"] };
        assert_eq!(ins, want_ins, "{}", s.id);
        assert_eq!(outs, ["l", "r"], "{}", s.id);
    }
    // Delay divisions are the mixer's table (one table for both).
    let div = &spec(ModuleKind::Delay).params[0];
    assert_eq!(div.name, "division");
    assert_eq!(div.choices, DELAY_DIVISIONS);
    assert_eq!(DELAY_DIVISIONS[div.default as usize], "3/16");
    // Pooled kinds.
    assert_eq!(ModuleKind::Delay.fx_kind(), Some(FxKind::Delay));
    assert_eq!(ModuleKind::Reverb.fx_kind(), Some(FxKind::Reverb));
    assert_eq!(ModuleKind::Chorus.fx_kind(), Some(FxKind::Chorus));
    for k in [ModuleKind::Eq, ModuleKind::Compressor, ModuleKind::Saturator, ModuleKind::Attenuator, ModuleKind::Osc] {
        assert_eq!(k.fx_kind(), None);
    }
}

#[test]
fn delay_module_echo_at_division() {
    for (bpm, div) in [(120.0, "1/4"), (150.0, "1/8"), (90.0, "3/16")] {
        let mut r = Rig::new(ModuleKind::Delay);
        r.bpm = bpm;
        r.set("division", division(div));
        r.set("feedback", 0.0);
        r.set("pingpong", 0.0);
        r.set("mix", 1.0);
        let beats = DELAY_DIVISION_BEATS[division(div) as usize];
        let want = (beats * 60.0 / bpm * SR).round() as i64;
        let out = r.run(want as usize + 4800, |ins, f| mono(ins, 0, f, impulse));
        // Frame 0 is the dry impulse (mix glides up from its 0.3 default).
        let first = echo(&out[0]).expect("an echo");
        assert!((first as i64 - want).abs() <= 1, "{div} @ {bpm}: echo at {first}, want {want}");
        assert_eq!(echo(&out[1]), Some(first), "r falls back to l");
    }
    // Mix 0.3 (default): 0.7 dry now, the echo later; ping-pong (default
    // on) puts the first echo on the left only.
    let mut r = Rig::new(ModuleKind::Delay);
    r.set("division", division("1/16"));
    let out = r.run(12000, |ins, f| mono(ins, 0, f, impulse));
    assert!((out[0][0] - 0.7).abs() < 1e-6, "dry {}", out[0][0]);
    assert!((out[1][0] - 0.7).abs() < 1e-6, "dry r {}", out[1][0]);
    assert!(out[0][6000] > 0.1 && out[1][6000].abs() < 1e-6, "{} {}", out[0][6000], out[1][6000]);
    // A synced time over 2 s is clamped to 2 s (the "(max 2 s)" rule).
    let mut r = Rig::new(ModuleKind::Delay);
    r.bpm = 60.0;
    r.set("division", division("1 bar")); // 4 s asked
    r.set("mix", 1.0);
    r.set("pingpong", 0.0);
    let out = r.run(100_000, |ins, f| mono(ins, 0, f, impulse));
    let first = echo(&out[0]).expect("an echo");
    assert!((first as i64 - 96000).abs() <= 1, "clamped echo at {first}");
}

#[test]
fn reverb_module_tail_and_mix_dry_at_zero() {
    let mut r = Rig::new(ModuleKind::Reverb);
    r.set("mix", 1.0);
    r.set("decay", 1.0);
    let out = r.run(3 * 48000, |ins, f| mono(ins, 0, f, impulse));
    let (early, mid, late) = (rms(&out[0][4800..14400]), rms(&out[0][48000..57600]), rms(&out[0][120000..]));
    assert!(early > 1e-3, "a tail: {early}");
    assert!(mid < early && late < mid * 0.01, "decays: {early} {mid} {late}");
    assert!(out[0] != out[1], "stereo tail");
    // Mix 0: exactly the dry signal, on both sides, once the mix has glided
    // down from its 0.3 default (5 ms).
    let mut r = Rig::new(ModuleKind::Reverb);
    r.set("mix", 0.0);
    let mut noise = Noise::new(3);
    let input: Vec<f32> = (0..9600).map(|_| noise.next()).collect();
    let out = r.run(9600, |ins, f| mono(ins, 0, f, |i| input[i]));
    assert_eq!(out[0][4800..], input[4800..]);
    assert_eq!(out[1][4800..], input[4800..]);
}

#[test]
fn chorus_modulates_and_is_bounded() {
    let sine = |i: usize| (std::f32::consts::TAU * 1000.0 * i as f32 / SR).sin();
    let periods = |y: &[f32]| {
        let ups: Vec<f32> = (4801..y.len())
            .filter(|&i| y[i - 1] < 0.0 && y[i] >= 0.0)
            .map(|i| (i - 1) as f32 + y[i - 1] / (y[i - 1] - y[i]))
            .collect();
        ups.windows(2).map(|w| w[1] - w[0]).fold((f32::MAX, 0.0f32), |(lo, hi), p| (lo.min(p), hi.max(p)))
    };
    let mut r = Rig::new(ModuleKind::Chorus);
    r.set("mix", 1.0);
    r.set("depth", 1.0);
    r.set("rate", 2.0);
    let out = r.run(2 * 48000, |ins, f| mono(ins, 0, f, sine));
    let (lo, hi) = periods(&out[0]);
    assert!(hi / lo > 1.03, "pitch sweeps: period {lo}..{hi}");
    assert!(out[0] != out[1], "L and R sweep in quadrature");
    // Bounded by the input's peak at any mix (no feedback).
    for mix in [0.0, 0.5, 1.0] {
        let mut r = Rig::new(ModuleKind::Chorus);
        r.set("mix", mix);
        r.set("depth", 1.0);
        r.set("rate", 5.0);
        let mut noise = Noise::new(9);
        let input: Vec<f32> = (0..48000).map(|_| noise.next()).collect();
        let out = r.run(48000, |ins, f| mono(ins, 0, f, |i| input[i]));
        let p = peak(&out[0]).max(peak(&out[1]));
        assert!(p <= peak(&input) + 1e-5, "mix {mix}: peak {p}");
        assert!(out[0].iter().all(|x| x.is_finite()));
    }
}

#[test]
fn eq_module_matches_dsp_response() {
    let settings = [("hp", 120.0), ("low", 6.0), ("midf", 2500.0), ("mid", -9.0), ("midq", 2.0), ("high", 4.5)];
    for hz in [40.0, 100.0, 400.0, 2500.0, 9000.0] {
        let mut dsp = Eq3::new(SR);
        dsp.set_hp(120.0);
        dsp.set_low(6.0);
        dsp.set_mid(2500.0, -9.0, 2.0);
        dsp.set_high(4.5);
        let want = tone_gain_db(SR, hz, |l, r| dsp.process(l, r));
        let mut rig = Rig::new(ModuleKind::Eq);
        for (n, v) in settings {
            rig.set(n, v);
        }
        let got = tone_gain_db(SR, hz, |l, r| {
            for (cl, cr) in l.chunks_mut(RACK_BLOCK).zip(r.chunks_mut(RACK_BLOCK)) {
                rig.ins[0].channels = 1;
                rig.ins[0].data[0].copy_from_slice(cl);
                rig.ins[1].channels = 1;
                rig.ins[1].data[0].copy_from_slice(cr);
                rig.m.process(&ctx(120.0), &rig.params, &rig.ins, &mut rig.outs, &mut rig.fx);
                cl.copy_from_slice(&rig.outs[0].data[0]);
                cr.copy_from_slice(&rig.outs[1].data[0]);
            }
        });
        assert!((got - want).abs() < 0.01, "{hz} Hz: module {got:.3} dB vs dsp {want:.3} dB");
    }
}

#[test]
fn compressor_sc_input_ducks() {
    // A steady pad on l (r follows), a kick (50 ms bursts every 0.5 s) on sc.
    let pad = |i: usize| 0.25 * (std::f32::consts::TAU * 220.0 * i as f32 / SR).sin();
    let kick = |i: usize| if i % 24000 < 2400 { (std::f32::consts::TAU * 60.0 * i as f32 / SR).sin() } else { 0.0 };
    let mut r = Rig::new(ModuleKind::Compressor);
    r.set("threshold", -30.0);
    r.set("ratio", 10.0);
    r.set("attack", 1.0);
    r.set("release", 60.0);
    let sc = r.input("sc");
    let out = r.run(4 * 24000, |ins, f| {
        mono(ins, 0, f, pad);
        mono(ins, sc, f, kick);
    });
    // Third kick: ducked while it plays, recovered before the next one.
    let ducked = rms(&out[0][48000 + 960..48000 + 2400]);
    let open = rms(&out[0][48000 + 19200..48000 + 23000]);
    let dry = 0.25 / 2f32.sqrt();
    assert!(ducked < 0.3 * dry, "ducked {ducked} vs dry {dry}");
    assert!((open / dry - 1.0).abs() < 0.05, "recovered {open} vs dry {dry}");
    assert_eq!(rms(&out[1][48000 + 960..48000 + 2400]), ducked, "linked: r ducks the same");

    // Unconnected sc: keys on itself (a loud pad is compressed, a quiet one not).
    for (amp, squashed) in [(0.9, true), (0.01, false)] {
        let mut r = Rig::new(ModuleKind::Compressor);
        r.set("threshold", -30.0);
        r.set("ratio", 10.0);
        let out = r.run(24000, |ins, f| mono(ins, 0, f, |i| amp / 0.25 * pad(i)));
        let g = rms(&out[0][12000..]) / (amp / 2f32.sqrt());
        assert_eq!(g < 0.5, squashed, "amp {amp}: gain {g}");
    }
}

#[test]
fn saturator_bounded_and_monotone() {
    // A slow ramp -4..4 on 3 voices (scaled 1, 0.5, 0.25): the static curve
    // is monotone and bounded, per voice.
    let n = 2 * 48000;
    let ramp = |i: usize| -4.0 + 8.0 * i as f32 / n as f32;
    for drive in [0.0, 0.3, 1.0] {
        let mut r = Rig::new(ModuleKind::Saturator);
        r.set("drive", drive);
        let mut outs = [Vec::new(), Vec::new(), Vec::new()];
        let mut f = 0;
        while f < n {
            r.ins[0].channels = 3;
            for (ch, s) in [1.0, 0.5, 0.25].into_iter().enumerate() {
                for i in 0..RACK_BLOCK {
                    r.ins[0].data[ch][i] = s * ramp(f + i);
                }
            }
            r.m.process(&ctx(120.0), &r.params, &r.ins, &mut r.outs, &mut r.fx);
            assert_eq!(r.outs[0].channels, 3);
            for (ch, o) in outs.iter_mut().enumerate() {
                o.extend_from_slice(&r.outs[0].data[ch]);
            }
            f += RACK_BLOCK;
        }
        for (ch, o) in outs.iter().enumerate() {
            // After 50 ms: drive glides (5 ms) from its default first.
            assert!(o[2400..].windows(2).all(|w| w[1] >= w[0] - 1e-6), "drive {drive} ch {ch}: not monotone");
            assert!(peak(o) <= 1.0 + 1e-6, "drive {drive} ch {ch}: peak {}", peak(o));
            assert!(o[n / 2 + 100] > 0.0 && o[n / 2 - 100] < 0.0, "sign kept");
        }
        // More drive, more gain at a low level.
        if drive == 1.0 {
            assert!(outs[0][n / 2 + 1200] > 2.0 * ramp(n / 2 + 1200), "drive 1 boosts small signals");
        }
    }
    // Bounded on full-scale noise at any tone.
    for tone in [0.0, 0.5, 1.0] {
        let mut r = Rig::new(ModuleKind::Saturator);
        r.set("drive", 1.0);
        r.set("tone", tone);
        let mut noise = Noise::new(5);
        let out = r.run(48000, |ins, f| mono(ins, 0, f, |_| 4.0 * noise.next()));
        assert!(peak(&out[0]) <= 1.0 + 1e-6, "tone {tone}: peak {}", peak(&out[0]));
    }
}

#[test]
fn attenuator_math() {
    let mut r = Rig::new(ModuleKind::Attenuator);
    r.set("amount", -0.5);
    r.set("offset", 0.25);
    let vals = [0.8, -0.4, 0.1];
    let mut last = Vec::new();
    for _ in 0..100 {
        r.ins[0].channels = 3;
        for (ch, v) in vals.iter().enumerate() {
            r.ins[0].data[ch] = [*v; RACK_BLOCK];
        }
        r.m.process(&ctx(120.0), &r.params, &r.ins, &mut r.outs, &mut r.fx);
        last = (0..3).map(|ch| r.outs[0].data[ch][RACK_BLOCK - 1]).collect();
    }
    assert_eq!(r.outs[0].channels, 3);
    for (v, y) in vals.iter().zip(&last) {
        // `Smooth` settles to within a few f32 ulps of its target.
        assert!((y - (v * -0.5 + 0.25)).abs() < 1e-5, "{v} -> {y}");
    }
    // Unconnected in: the offset alone, 1 channel (a constant CV source).
    r.ins[0].channels = 0;
    r.m.process(&ctx(120.0), &r.params, &r.ins, &mut r.outs, &mut r.fx);
    assert_eq!(r.outs[0].channels, 1);
    assert!((r.outs[0].data[0][0] - 0.25).abs() < 1e-5);
    // Defaults (amount 1, offset 0): identity.
    let mut r = Rig::new(ModuleKind::Attenuator);
    let out = r.run(64, |ins, f| mono(ins, 0, f, |i| i as f32 * 0.01));
    assert!(out[0].iter().enumerate().all(|(i, &y)| (y - i as f32 * 0.01).abs() < 1e-6));
}

#[test]
fn poly_input_summed_to_one_channel_for_stereo_fx() {
    // Ratio 1 makes the Compressor an exact identity, so its output is
    // exactly the voice sum; r (unconnected) falls back to l.
    let voices = [0.1f32, 0.2, -0.05, 0.3];
    let mut r = Rig::new(ModuleKind::Compressor);
    r.set("ratio", 1.0);
    let out = r.run(256, |ins, f| {
        ins[0].channels = 4;
        for (ch, a) in voices.iter().enumerate() {
            for i in 0..RACK_BLOCK {
                ins[0].data[ch][i] = a * ((f + i) as f32 * 0.05).sin();
            }
        }
    });
    let sum: f32 = voices.iter().sum();
    for (i, (&yl, &yr)) in out[0].iter().zip(&out[1]).enumerate() {
        let want = sum * (i as f32 * 0.05).sin();
        assert!((yl - want).abs() < 1e-6 && (yr - want).abs() < 1e-6, "{i}: {yl} {yr} vs {want}");
    }
    // Every stereo effect has 1-channel outputs whatever the input width.
    for k in [ModuleKind::Delay, ModuleKind::Reverb, ModuleKind::Chorus, ModuleKind::Eq, ModuleKind::Compressor] {
        let mut r = Rig::new(k);
        r.run(64, |ins, _| {
            ins[0].channels = 16;
            ins[1].channels = 5;
        });
        assert_eq!((r.outs[0].channels, r.outs[1].channels), (1, 1), "{}", spec(k).id);
    }
}

// ---- the pool through the rack and the engine --------------------------------

/// Render `frames` of `rack` (128-frame blocks); returns L.
fn render(rack: &mut Rack, fx: &mut FxPool, frames: usize) -> Vec<f32> {
    let mut out = Vec::new();
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    for _ in 0..frames.div_ceil(128) {
        l.fill(0.0);
        r.fill(0.0);
        rack.render_add(&ctx(120.0), fx, &mut l, &mut r);
        out.extend_from_slice(&l);
    }
    out
}

#[test]
fn fx_pool_exhaustion_returns_full() {
    use crate::protocol::*;
    use crate::Engine;
    let mut e = Engine::new(SR);
    let (osc, delay, out) = (ModuleKind::Osc as u32 as f64, ModuleKind::Delay as u32 as f64, ModuleKind::Out as u32 as f64);
    let pk = |m: usize, p: usize| (m * 16 + p) as f64;
    // Two tracks, each Osc -> 4 Delays in series -> Out: 8 delays in all.
    for t in 0..2 {
        let s = t as f64;
        assert_eq!(e.command(OP_ADD_SYNTH_TRACK, s, 0.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, s, 0.0, osc, 0.0), OK);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, s, 5.0, out, 0.0), OK);
        for m in 1..=4 {
            assert_eq!(e.command(OP_RACK_ADD_MODULE, s, m as f64, delay, 0.0), OK);
            assert_eq!(e.command(OP_RACK_CONNECT, s, pk(m - 1, 0), pk(m, 0), 0.0), OK);
        }
        assert_eq!(e.command(OP_RACK_CONNECT, s, pk(4, 0), pk(5, 0), 0.0), OK);
    }
    // The 9th Delay, on either track or a third one, is refused.
    assert_eq!(e.command(OP_RACK_ADD_MODULE, 0.0, 6.0, delay, 0.0), ERR_OUT_OF_MEMORY);
    assert_eq!(e.command(OP_ADD_SYNTH_TRACK, 2.0, 0.0, 0.0, 0.0), OK);
    assert_eq!(e.command(OP_RACK_ADD_MODULE, 2.0, 0.0, delay, 0.0), ERR_OUT_OF_MEMORY);
    // Nothing was added: the slot is still free for another kind.
    assert_eq!(e.command(OP_RACK_ADD_MODULE, 0.0, 6.0, out, 0.0), OK);
    // Other pooled kinds have their own slots.
    assert_eq!(e.command(OP_RACK_ADD_MODULE, 2.0, 1.0, ModuleKind::Reverb as u32 as f64, 0.0), OK);
    // The 8 existing delays still sound: both chains reach their strips.
    let mut l = [0.0f32; 128];
    let mut r = [0.0f32; 128];
    for _ in 0..200 {
        e.process(&mut l, &mut r);
    }
    for ch in 0..2 {
        assert!(e.meters()[ch * crate::MIX_METER_STRIDE] > 0.05, "track {ch} silent");
    }
    // Removing one frees its slot (after the removal fade); then a Delay fits.
    assert_eq!(e.command(OP_RACK_REMOVE_MODULE, 1.0, 4.0, 0.0, 0.0), OK);
    for _ in 0..4 {
        e.process(&mut l, &mut r);
    }
    assert_eq!(e.command(OP_RACK_ADD_MODULE, 2.0, 2.0, delay, 0.0), OK);
    assert_eq!(e.command(OP_RACK_ADD_MODULE, 2.0, 3.0, delay, 0.0), ERR_OUT_OF_MEMORY);
    // Removing a track frees all of its slots.
    assert_eq!(e.command(OP_REMOVE_TRACK, 0.0, 0.0, 0.0, 0.0), OK);
    for _ in 0..4 {
        e.process(&mut l, &mut r);
    }
    for m in 3..7 {
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 2.0, m as f64, delay, 0.0), OK, "module {m}");
    }
    assert_eq!(e.command(OP_RACK_ADD_MODULE, 2.0, 7.0, delay, 0.0), ERR_OUT_OF_MEMORY);
}

#[test]
fn fx_pool_counts_per_kind_and_rack_clear_frees() {
    let mut fx = FxPool::with_slots(SR, 2, 1, 3);
    let mut rack = Rack::new(SR);
    assert_eq!(rack.add_module(0, ModuleKind::Delay, &mut fx), OK);
    assert_eq!(rack.add_module(1, ModuleKind::Delay, &mut fx), OK);
    assert_eq!(rack.add_module(2, ModuleKind::Delay, &mut fx), ERR_OUT_OF_MEMORY);
    assert_eq!(rack.kind(2), None);
    assert_eq!(rack.add_module(2, ModuleKind::Reverb, &mut fx), OK);
    assert_eq!(rack.add_module(3, ModuleKind::Reverb, &mut fx), ERR_OUT_OF_MEMORY);
    for m in 3..6 {
        assert_eq!(rack.add_module(m, ModuleKind::Chorus, &mut fx), OK);
    }
    assert_eq!(rack.add_module(6, ModuleKind::Chorus, &mut fx), ERR_OUT_OF_MEMORY);
    // Inline effects never touch the pool.
    for (m, k) in [(6, ModuleKind::Eq), (7, ModuleKind::Compressor), (8, ModuleKind::Saturator), (9, ModuleKind::Attenuator)] {
        assert_eq!(rack.add_module(m, k, &mut fx), OK);
    }
    assert_eq!((fx.in_use(FxKind::Delay), fx.in_use(FxKind::Reverb), fx.in_use(FxKind::Chorus)), (2, 1, 3));
    rack.clear();
    render(&mut rack, &mut fx, 128);
    assert_eq!((fx.in_use(FxKind::Delay), fx.in_use(FxKind::Reverb), fx.in_use(FxKind::Chorus)), (0, 0, 0));
    // An add still queued when a clear supersedes it gives its slot back too.
    let mut fx = FxPool::with_slots(SR, 1, 0, 0);
    let mut rack = Rack::new(SR);
    assert_eq!(rack.add_module(0, ModuleKind::Osc, &mut fx), OK);
    assert_eq!(rack.add_module(1, ModuleKind::Out, &mut fx), OK);
    assert_eq!(rack.connect((0, 0), (1, 0)), OK);
    render(&mut rack, &mut fx, 4800);
    assert!(rack.is_sounding());
    assert_eq!(rack.disconnect((1, 0)), OK); // queued: later edits queue too
    assert_eq!(rack.add_module(2, ModuleKind::Delay, &mut fx), OK);
    assert_eq!(fx.in_use(FxKind::Delay), 1, "reserved while queued");
    rack.clear();
    render(&mut rack, &mut fx, 1280);
    assert_eq!(fx.in_use(FxKind::Delay), 0);
    assert_eq!(rack.add_module(2, ModuleKind::Delay, &mut fx), OK);
}

#[test]
fn fx_slot_reused_after_remove_is_silent() {
    // One delay slot, so a re-added Delay must get the same memory.
    let mut fx = FxPool::with_slots(SR, 1, 0, 0);
    let mut rack = Rack::new(SR);
    let ok = |c: i32| assert_eq!(c, OK);
    ok(rack.add_module(0, ModuleKind::Noise, &mut fx));
    ok(rack.add_module(1, ModuleKind::Delay, &mut fx));
    ok(rack.add_module(2, ModuleKind::Out, &mut fx));
    ok(rack.set_param(1, 0, division("1 bar"))); // 2 s at 120 BPM
    ok(rack.set_param(1, 1, 0.9)); // feedback
    ok(rack.set_param(1, 3, 0.0)); // ping-pong off
    ok(rack.set_param(1, 2, 1.0)); // mix: wet only
    ok(rack.connect((0, 0), (1, 0)));
    ok(rack.connect((1, 0), (2, 0)));
    // 1 s of noise fills half the 2 s line.
    render(&mut rack, &mut fx, 48000);
    ok(rack.remove_module(1));
    render(&mut rack, &mut fx, 4800);
    assert_eq!(rack.kind(1), None);
    assert_eq!(fx.in_use(FxKind::Delay), 0, "freed after the fade");
    // A new Delay (another module index) gets the slot: wet only, no input.
    ok(rack.add_module(5, ModuleKind::Delay, &mut fx));
    ok(rack.set_param(5, 0, division("1 bar")));
    ok(rack.set_param(5, 2, 1.0));
    ok(rack.connect((5, 0), (2, 0)));
    ok(rack.connect((5, 1), (2, 1)));
    let out = render(&mut rack, &mut fx, 3 * 48000);
    assert!(out.iter().all(|&x| x == 0.0), "the old echo replayed: peak {}", peak(&out));
    // And the slot works once it is clean: noise in, an echo 2 s later.
    ok(rack.connect((0, 0), (5, 0)));
    let out = render(&mut rack, &mut fx, 3 * 48000);
    assert!(peak(&out[96000 + 4800..]) > 0.1, "the reused delay echoes");
}
