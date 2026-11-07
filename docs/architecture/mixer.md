# Mixer

Per-track strips, two send returns and a limited master. Code:
`engine/src/mixer/` (the DSP, once per block), `engine/src/dsp/` (EQ,
compressor, reverb, delay, limiter), `engine/mixer_catalog.json` (the golden
parameter table), `app/src/state/mixer-actions.ts`, `app/src/ui/mixer/`.

## Signal flow

Everything below runs **once per whole block**, after every track has rendered
into its slot buffer (Song mode renders a block in pieces, the loop wrap can
make a 0-frame piece; the mixer never sees pieces). Jumps (wrap, seek, Stop)
release notes only, so effect tails, compressor and limiter state survive them.

```
 track slot 0..31   (Drums / Synths render into per-slot stereo buffers)
   |  pre-fader, never modified by the mixer
   v
 [EQ] -> [Compressor] -> fader -> pan -> mute/solo gate ------------+--> master bus
   ^         ^   key = a source's PRE-fader signal                   |
   |         |   (own track | other track | one drum row)            |
   |         +-- Key::None = its own input                           |
   |                                                                 |
   +--- Send A / Send B tap post-fader (after pan + gate) -----+     |
        or, with the "pre" flag, after EQ + comp (pre-fader)   |     |
        (the gate is applied to sends too, see Mute/solo)      v     |
                                          Reverb (100% wet) / Delay  |
                                            -> EQ -> fader -> pan -> mute
                                            -> master bus  <---------+
                                                                     |
 master bus -> x legacy gain (SET_MASTER_GAIN, 0.8) -> [EQ] -> fader |
   -> Limiter (lookahead 72 samples, release 50 ms, ceiling -0.3 dBFS)
   -> + metronome click (soft clip only around clicks) -> NaN-safe +-1 clamp
   -> output
```

EQ and compressor are bypassed by default and crossfade over 5 ms; once fully
off their state is reset. Fader, pan and send changes ramp over 5 ms, mute/solo
over 2 ms. Returns are 100% wet; track solo never mutes a return.

## Channel numbering

`MIX_CHANNELS = 35`: 0..31 are the track slots (the engine's slot, shared by
drum and synth tracks), `MIX_REVERB = 32`, `MIX_DELAY = 33`, `MIX_MASTER = 34`.
Mirrored in `app/src/audio/protocol.ts`. Wire commands: `MIX_SET ch id value`,
`MIX_SET_KEY ch key`, `MIX_RESET ch`. Parameter ids are the index into
`mixer_catalog.json`; a param sent to a channel kind that does not take it is
rejected (`appliesTo`). A removed track's strip resets, but its 2 ms fade-out
still reaches the master.

## Key encoding

`MIX_SET_KEY` value (`keyCode` in protocol.ts):

| value               | meaning                                            |
|---------------------|----------------------------------------------------|
| `-1`                | none: the compressor hears its own signal          |
| `slot*32 + 0`       | the whole track `slot`                             |
| `slot*32 + row + 1` | drum row `row` of drum track `slot`                |

Keys are always a source's **pre-fader** signal (the track buffer, or only that
row's voices), never another strip's output, so there are no feedback cycles.
A key on the strip's own whole track is stored as none.

**Key cap: `MAX_KEYS = 8`.** Each *distinct* (drum track, row) used as a key by
any strip takes one of 8 key slots, and the drums render that row into the
slot's extra buffer. A 9th distinct row is refused (`BAD_VALUE`;
`rowKeyAllowed` in mixer-actions.ts mirrors it so the UI greys the choice out
with "max 8 keys"). Whole-track keys cost nothing and are unlimited. When a
key's source track is removed or retyped, the key reverts to none and the
compressor's reduction ramps to unity over 2 ms.

## Mute / solo

* Mute and solo are applied at the strip gate, never by skipping sequencing,
  so notes keep playing and unmuting is instant and in time.
* If any *track* is soloed, every unsoloed track is muted. Returns and master
  are unaffected by solo (returns can be muted; master has neither).
* The gate acts on the **sends too**, pre-fader sends included: a muted or
  solo-muted track feeds nothing new into Reverb/Delay. The return tails keep
  ringing out (they are not gated), which is what you want when muting a
  track mid-phrase.

## Pan law

Equal-power, normalised so **centre is unity** (`gL = sqrt2 cos t`, `gR = sqrt2
sin t`, `t = (pan+1) pi/4`). Hard pan therefore gives +3 dB on the active side
(and silence on the other); a default mix is bit-exact unity. Mono sources
panned hard are 3 dB louder than centred, the usual trade for a unity centre.

## Limiter and latency

The master limiter is a brickwall lookahead limiter: **72 samples** of
lookahead at 48 kHz (1.5 ms), release 50 ms, ceiling default -0.3 dBFS (range
-6..0). The output never exceeds the ceiling (gain reduction is computed on
the look-ahead peak, so it is down before the peak arrives).

The lookahead delays the whole output by 72 samples. Two compensations:

* **Heard time.** The worklet reads `engine_latency()` (72 frames, 0 when no
  lookahead) once, and publishes `TELEMETRY.frame = currentFrame + n +
  latency`: the context frame at which the published `ticks` are *heard*.
  `audioClock` builds the playhead and the recorder's note timing from that, so
  the playhead is not 1.5 ms early.
* **Metronome.** The click is added *after* the limiter (it is never
  compressed) but is delayed through a small ring by the same latency, so it
  stays on the beat with the limited mix.

### Click soft clip

Because the click is added after the limiter, the sum could pass the ceiling.
`ClickClip` (engine/src/mixer/mod.rs) adds it as
`out = mix + w * (soft_clip(mix + click, ceiling) - mix)`, where `w` is a
click-activity envelope:

* `w` rises linearly over the limiter latency while the *incoming* click (the
  ring's input) is sounding, so it reaches 1 exactly as the delayed click
  arrives (the ring doubles as a lookahead: no step at the click onset);
* it holds at 1 while the delayed click sample is non-zero;
* then falls linearly to exactly 0 over 5 ms.

With `w == 0` (metronome off, or between clicks) the **limiter output passes
bit for bit**: a limited mix reaches the ceiling and is never coloured by the
knee. Only around a click is the sum shaped. `soft_clip(x, ceiling)` itself is
bit-transparent while |x| <= 0.9 x ceiling, above that a tanh knee with slope
1 at the knee (no corner) that approaches but never reaches the ceiling. Both
`mix` and `soft_clip(...)` are within +-ceiling, so the blend is too (it is
clamped against rounding). Non-finite input is returned as is so the final
`is_finite` backstop turns it into silence (not a full-scale sample). The last
+-1 clamp is only that NaN-safe backstop.

## Meters path

1. The mixer writes per-block **instantaneous peaks** (L, R linear) and gain
   reduction (dB) per channel into a `MIX_CHANNELS * 3` float array
   (`MIX_METER_STRIDE = 3`). The master's peaks are the final output
   (after click and soft clip).
2. The worklet applies **ballistics** (`app/src/audio/meterBallistics.ts`) once
   per block, on the audio thread: **peak hold with instant attack and a
   60 dB/s linear-in-dB fall** (`METER_FALL_DB_PER_S`). Reason: the UI reads
   once per animation frame (~6 blocks); a plain copy would show a random
   block's peak, miss transients and make a bass note's meter follow the
   waveform phase. With the worklet doing the fall, no block peak is ever lost.
   GR is copied as is (the envelope is already smooth). The result goes to the
   meters SAB.
3. `TELEMETRY.peakL/peakR` (the master peaks the older tests and the
   status line use) are **not** ballistic: they stay raw per-block peaks.
4. `MeterBus` (`ui/mixer/meterBus.ts`) reads the SAB in one rAF loop and
   fans out to every `Meter`/GR readout, which write styles directly (no
   reactive state per frame). The peak-hold line (1 s) is a UI concern
   (`holdStep`). The clip light latches until clicked; on the master it lights
   when limiter GR > 1 dB or the output is within 0.5 dB of the ceiling,
   because the limiter output sits ~0.2 dB under the ceiling and never
   "reaches" it.

## Gain staging

Faders are -inf..+6 dB; the master limiter catches what is left. Poly starter
patches (Chord Stab, Pad, Pluck) were turned down inside the patch so a chord
does not clip; a single note on them is ~9 dB quieter than on Deep Bass/Lead.
Raise their faders instead of the patch level (see README "Mix").

## Performance

Spec section 6 scenario (4 drum tracks x 8 rows, 4 Chord Stab tracks with held
chords and arps, EQ and both sends everywhere, 2 sidechained comps, returns,
limiter): native `engine/tests/perf.rs` (`#[ignore]`, release; budget 40% of
real time) and the browser `tests/e2e/serial.spec.ts` (audio-thread CPU < 0.6,
no new dropouts, blocks >= 95% of real time; run in the serial Playwright
project so no other worker competes for the CPU).

## Plan 6: reuse as rack modules

The strip processors are plain stereo DSP structs in `engine/src/dsp/`
(`Eq3`, `Compressor`, `Reverb`, `Delay`, `Limiter`), with no mixer
knowledge: they take `&mut [f32]` L/R slices, glide their own params and reset
via `reset()`. Plan 6 wraps them as rack modules (`engine/src/rack/`) with
audio ports and catalog entries, and the strip's EQ/Comp inserts become the
default rack-per-track chain. Parameter tables stay in the golden JSON style
(`mixer_catalog.json`), which is why the UI never hand-copies ranges.
