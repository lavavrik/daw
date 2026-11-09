# Mixer

Per-track strips, up to eight send returns (each a Reverb or a Delay) and a limited master. Code:
`engine/src/mixer/` (the DSP, once per block), `engine/src/dsp/` (EQ,
compressor, reverb, delay, limiter), `engine/mixer_catalog.json` (the golden
parameter table), `app/src/state/mixer-actions.ts`, `app/src/ui/mixer/`.

## Signal flow

Everything below runs **once per whole block** (in 32-frame chunks while a
mixer automation lane applies, see Automation), after every track has rendered
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
   +--- Send A..H tap post-fader (after pan + gate) ---------+     |
        or, with the "pre" flag, after EQ + comp (pre-fader)   |     |
        (the gate is applied to sends too, see Mute/solo)      v     |
                       return slot 0..7: Reverb or Delay (100% wet)  |
                       (Off slots and sleeping slots do nothing)     |
                                            -> EQ -> fader -> pan -> mute
                                            -> master bus  <---------+
                                                                     |
 master bus -> x legacy gain (SET_MASTER_GAIN, 0.8) -> [EQ] -> fader |
   -> Limiter (lookahead 1.5 ms, release 50 ms, ceiling -0.3 dBFS)
   -> + metronome click (soft clip only around clicks) -> NaN-safe +-1 clamp
   -> output
```

EQ and compressor are bypassed by default and crossfade over 5 ms; once fully
off their state is reset. Fader, pan and send changes ramp over 5 ms, mute/solo
over 2 ms. Returns are 100% wet; track solo never mutes a return.

The Delay's time is a tempo-synced division (`delay_time` choices; their
lengths in beats are exported as `delay.divisionBeats` in the golden JSON).
The ring is allocated once for **2 s** (`dsp::delay::MAX_SECONDS`, exported as
`delay.maxSeconds`), so a division longer than 2 s at the current tempo (1 bar
below 120 bpm, 1/2 below 60 bpm) is clamped to 2 s; the Delay strip then shows
"(max 2 s)" under Time (`mixMath.delayClampNote`).

## Channel numbering

`MIX_CHANNELS = 41`: 0..31 are the track slots (the engine's slot, shared by
drum and synth tracks), `MIX_RETURN0 = 32` (return slots 32..39, `MAX_RETURNS =
8`), `MIX_MASTER = 40`. A track's sends are the params `send_a`..`send_h`
(`send_id(slot)`, with `send_pre_id(slot)` for the pre flag), one per return
slot. Mirrored in `app/src/audio/protocol.ts`. Wire commands: `MIX_SET ch id value`,
`MIX_SET_KEY ch key`, `MIX_RESET ch`. Parameter ids are the index into
`mixer_catalog.json`; a param sent to a channel kind that does not take it is
rejected (`appliesTo`). A removed track's strip resets, but its 2 ms fade-out
still reaches the master.

The strips' order on screen is the track order (`project.tracks`), not the
channel number: reordering the song's tracks (arrangement.md "Track order")
reorders the strips and changes no channel.

## Return slots (plan 29)

Return channel `32 + k` is slot `k`. Each slot has a **kind**: Off, Reverb or
Delay, set with `OP_RETURN_KIND` (`a` = slot 0..7, `b` = kind 0..2;
`Mixer::set_return_kind`). A new project and `OP_RESET_ALL` give slot 0 =
Reverb, slot 1 = Delay and slots 2..7 Off. A slot owns both a Reverb and a
Delay (about 1.25 MiB at 48 kHz, ~10 MiB for all eight, allocated in
`Mixer::new`); only the one matching the kind runs.

- **Params.** A return takes both the `rev_*` and the `delay_*` groups, whatever
  its kind; `MIX_SET` pushes them to that slot's effects only. `RETURN_KIND`
  resets the slot's params to their defaults (like `MIX_RESET`, and the engine
  moves the automation lanes' bases the same way), so a client sends a return's
  `MIX_SET`s *after* its `RETURN_KIND`.
- **Changing the kind of a sounding slot** fades the old effect's output over
  5 ms (the strip keeps its old gains meanwhile, so a muted return cannot leak).
  When the fade ends both effects are reset (`reset_dsp`) and the new kind starts
  clean: no tail of the old effect, and none of the new effect's earlier life.
  A second change inside the fade just retargets the new kind. A silent slot
  switches at once. Off (deleting a return) fades like any other change.
- **Sleeping.** A slot is idle when it is Off, or when its send bus, its rings
  and its filter states are exactly zero and nothing is moving (no glide, no
  fader/mute/EQ ramp). An idle slot skips its DSP, EQ and mix-out. It wakes at
  the start of the next block that has a non-zero send, a param/tempo/fader move,
  and renders bit for bit what a never-sleeping slot would (pinned by
  `sleeping_return_wakes_bit_exact`, which also moves `rev_size` and a return
  mute during the gap). Tails decay to exact zero (the effects flush denormals),
  so a fed slot sleeps about 15 s (Reverb, decay 2.2 s) to 19 s (Delay, feedback
  0.35) after the last send; a never-fed slot sleeps after one block, and six
  never-fed slots cost nothing measurable (`idle_returns_cost_nothing`).

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
compressor's reduction ramps to unity over 2 ms. Row keys follow their row
when a drum row is deleted or restored (`REMOVE_ROW` / `INSERT_ROW`,
`Mixer::row_removed` / `row_inserted`; sequencer.md "Deleting a row"): a key
on a later row moves with it, a key on the deleted row reverts to none (the
same 2 ms ramp). A delete never needs a new key slot, so the cap holds.

## Mute / solo

* Mute and solo are applied at the strip gate, never by skipping sequencing,
  so notes keep playing and unmuting is instant and in time.
* If any *track* is soloed, every unsoloed track is muted. Returns and master
  are unaffected by solo (returns can be muted; master has neither).
* **Exclusive solo** (plan 20 task 12, owner's note; `state/mixer-actions.ts
  toggleSolo`): the S button (track header or mixer strip) on a track that
  is not soloed solos it **and unsolos every other track**; on a soloed
  track it unsolos just that one. Cmd/Ctrl/Shift-click is the old additive
  toggle (`{ additive: true }`), to build a multi-track solo. Either way one
  undo entry, "Solo <name>" / "Unsolo <name>". The engine is unchanged: it
  is a batch of `MIX_SET solo` commands.
* The gate acts on the **sends too**, pre-fader sends included: a muted or
  solo-muted track feeds nothing new into Reverb/Delay. The return tails keep
  ringing out (they are not gated), which is what you want when muting a
  track mid-phrase.

## Pan law

**Strip pan** (mixer, every track and return): equal-power, normalised so
**centre is unity** (`gL = sqrt2 cos t`, `gR = sqrt2 sin t`, `t = (pan+1)
pi/4`). Hard pan therefore gives +3 dB on the active side (and silence on the
other); a default mix is bit-exact unity. Mono sources panned hard are 3 dB
louder than centred, the usual trade for a unity centre.

**Drum-row pan** (step-grid row pan, `drums.rs`, applied per voice before
the strip): plain equal-power, **-3 dB at centre** (`gL = cos t`, `gR = sin
t`, same `t`): a centred row plays at 0.707 on both sides, a hard-panned row
at 1.0 on one side. So the two laws differ by exactly 3 dB: a row's pan keeps
constant power, while the strip's pan keeps a centred mix at unity. They
stack (gains multiply): row and strip both centred = 0.707 x 1 (-3 dB per
side); both hard left = 1.0 x sqrt2 (+3 dB on L).

## Fader law (the fader and the sends)

The fader's travel is not linear in dB. `mixer::catalog::FADER_LAW` maps
dB to a position 0..1, piecewise linear in dB between (−60, 0), (−40, 0.14),
(−30, 0.25), (−20, 0.38), (−10, 0.55), (0, 0.75) and (+6, 1): 0 dB at 3/4
of the travel, the range near unity spread out, the bottom 14 % for −40 dB
down to −∞ (the −60 dB minimum, gain exactly 0). The catalog exports it as
`"faderLaw"`; the app reads it there (`app/src/ui/mixer/mixMath.ts`
`FADER_LAW`, rationale in its comment).

Since plan 19 it is also a param **curve**, `fader`, beside `lin` and
`exp`. The `fader`, `send_a` and `send_b` params have it (the −60 minimum
still reads "−∞" on the fader and "Off" on a send). So:

- **Send knobs** turn along the fader law (`knobMath` `toPos` / `fromPos`,
  continuous: no 0.1 dB snapping). Typed values are stored as typed, and
  double-click resets to the default (Off). The arrow keys step like the
  fader's: 1 dB, Shift 0.1 dB, on the 0.1 dB grid (`faderKeyStep`).
- **Volume and send lanes** are drawn and played in fader travel, the same
  in the engine and the app (automation.md, *Evaluation*).
- **MIDI-learn** on the fader or a send follows the law as the fader's drag
  does, snapped to 0.1 dB (`midiMap` `ccValue` → `faderDb`).

The on-screen fader keeps its own gestures (`faderDb` snaps a drag to
0.1 dB); the curve only adds the law to everything else that maps a value
to a travel.

## Limiter and latency

The master limiter is a brickwall lookahead limiter: **1.5 ms** of
lookahead (72 samples at 48 kHz), release 50 ms, ceiling default -0.3 dBFS (range
-6..0). The output never exceeds the ceiling (gain reduction is computed on
the look-ahead peak, so it is down before the peak arrives).

The lookahead delays the whole output by 1.5 ms (72 at 48 kHz). Two compensations:

* **Heard time.** The worklet reads `engine_latency()` (72 frames at 48 kHz, 0
  when no lookahead) once, and publishes `TELEMETRY.frame = currentFrame + n +
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
4. `MeterBus` (`ui/mixer/meterBus.ts`) reads the SAB once per frame of the
   app's shared visual frame loop (`ui/vis/frameLoop.ts`: a want-0 consumer
   on the mixer element, at most 60 Hz, paused off screen and in a hidden
   tab; plan 12) and fans out to every `Meter`/GR readout, which write styles directly (no
   reactive state per frame). The peak-hold line (1 s) is a UI concern
   (`holdStep`). The clip light latches until clicked. On a strip it is red
   when a peak reaches 0 dBFS. On the master (`mixMath.masterLight`) it is an
   amber **LIMIT** light when limiter GR > 1 dB (limiting is normal on a
   master) and turns red only when the output reaches the ceiling (>= ceiling
   - 0.01 dB), which a hard-limited mix does since the limiter output passes
   bit-exact outside clicks (see Click soft clip). It latches its worst state.
   Lights latch only from what a frame sees: while the loop is paused (mixer
   off screen, tab hidden) nothing is read, so an over that has fallen away
   under the ballistics by the time the mixer shows again does not latch.

## Strip tap (plan 12)

`VIS_TAP` (55) picks one track strip or return whose post-fader stereo the
mixer also writes into the engine's visual block, for the analysers: the
same `l`/`r` values `mix_out` adds to the master bus, so its peaks equal the
strip's meter exactly and the mix is unchanged. Off (−1) costs nothing. See
`docs/architecture/visuals.md`.

The **analyser** (plan 12 Task 3) sits right of the Master strip. Each track
and return strip has a "∿" toggle (*Show in analyser*): one at a time,
pressing it again goes back to the Master; view state, not saved, not an
edit. The analyser bus sends the choice as `OP_VIS_TAP` (only while the
panel is mounted), re-sends it after an audio restart, and falls back to the
Master when the track is removed. The mixer with every meter and the
analyser on the Master costs ~1.5 % of the main thread while the spec-6 mix
plays (serial e2e). Test ids: `analyser`, `analyser-strip-<channel>` (the
∿), `analyser-spectrum`, `analyser-readout`. See *Analyser* in
`docs/architecture/visuals.md`.

## Strip look (plan 21 Task 10)

The strips (`app/src/ui/mixer/Strip.svelte`) wear the rack's mechanical
faceplate (spec 2026-11-15 §11: the owner's "same should apply to mixer
'patches' too"; recipes in `docs/architecture/ui-theme.md` "Mechanical
faceplates"):

- a `.mech-panel` 132 px wide with four corner screws; the name button is a
  36 px `.mech-head` strip in the track colour (returns and the master on
  `--raised` with light text);
- M / S / ∿ are LED push-buttons: a `.mech-btn` under an LED that glows
  while it is on (M `--sig-cv`, S `--track-7`, ∿ `--play`). Test ids,
  `aria-pressed` and titles are unchanged;
- every knob is a compact mech dial (`Knob variant="mech" size="sm"`, 46
  px in a 56 px cell: two cells fill the strip's 112 px inside exactly), two per row: EQ, Comp, the returns' effects, the sends (one per
  return, each with its pre/post `.mech-btn` and a small LED under it), pan,
  the master's limiter ceiling beside its GR chip. The Delay's 12-way time
  division stays a skinned select; a ≤ 6-choice param would be LED buttons;
- the fader (`Fader.svelte`) is the mech fader: an 8 px `--mech-slot`, a
  lit strip in the track colour with a glow, the grooved 28×16 metal cap
  (`CAP_H` 16; the slot is inset 8 px, the meter's bottom padding matches).
  Behaviour, keys, automation and MIDI learn unchanged. The dB scale is
  engraved; the readout is a value chip. Meters unchanged.

**Height.** The dials are taller than plan 20's sliders: a track strip is
~520 px of content. The strip is at most the mixer's height
(`max-height: 100%`), and everything above the fader (`.upper`: M/S/∿,
the sections, sends, pan) shrinks and scrolls inside the strip (no
scrollbar: it would eat the two-knob rows' width; wheel or focus scroll
it), so the fader, scale, meter and readout always stay in view. With no
scrollbar the cue is a 14 px fade (a `mask-image`) at the edge that has
more past it (`fade-top` / `fade-bot`, re-checked on scroll and on any size
change). With the Sends section closed (its default) a track strip's pan
sits right under the section headers.
- **Section headers** (EQ, Comp, the return's effect, Sends): one leading glyph,
  the section's icon (brighter while open), or the ▸ / ▾ triangle when it
  has none; never both.

### Returns and sends on the strips (plan 29 Task 7)

Layout, left to right: the track strips, a dashed divider, the return strips
(`p.mixer.returns`, creation order), the **"+ Return"** ghost strip, the
Master, the analyser (`MixerView.svelte`).

- **Return strips** (`Strip kind="return"`, test id `strip-<returnId>`, so
  the default two stay `strip-reverb` / `strip-delay`). The header is
  neutral (`--raised`, so a return never passes for a track) and shows a
  colour dot (`return-dot`, `--return-<slot>`: `returnColor(slot)`), the
  name, and `returnSummary(r)` as the subtitle (`ui/mixer/returnSummary.ts`:
  "Reverb · 1.8 s" from `rev_decay`, "Delay · 3/16" from `delay_time`'s
  choice; worked out from the params, never stored, not the preset name).
  The return's own knobs (EQ, effect, pan) wear its colour. The fx section
  (`fx`, `fx-expand`) holds the knobs of the return's `kind`.
- **Rename:** double-click the name (or F2 on it): it becomes a field,
  `return-name-input`. Enter or a click away saves through `renameReturn`,
  Esc cancels; an unchanged name makes no undo entry, a refused one (empty
  or over 24 characters after trimming) keeps the old name and says so in
  the status line.
- **Delete:** the last item of the return's Presets card,
  `preset-delete-return` ("Delete return", one undo entry: `deleteReturn`).
- **"+ Return"** (`AddReturn.svelte`): a 96 px dashed outline as tall as
  the strips; its button `add-return` opens a floating card with
  `add-return-reverb` / `add-return-delay` (`addReturn`: lowest free slot,
  catalog defaults, "Reverb N" / "Delay N"). A press anywhere on the
  outline opens it too. Not rendered at 8 returns.
- **Sends on a track strip** (spec option C): a folding `Section` like EQ
  and Comp, `sends` / `sends-expand`, closed by default (view state, per
  strip, never saved), **not rendered with zero returns**.
  - Closed: the header reads "▸ SENDS" with "k of n" at its right end
    (`sends-aside`; k = sends above −∞), and under it `SendBars.svelte`:
    one 6 px mini bar per return (`send-bar-<slot>`), in creation order,
    filled in the return's colour to the send's fader position (`faderPos`,
    the knob's own travel). The bars only show (not draggable); a click on
    one opens the section. They are out of the tab order (the header button
    opens it from the keyboard).
  - Open: a knob per return, two per row: `knob-send_<letter>` (the slot's
    catalog param, `sendParam(slot)`), its ring and its pre LED in the
    return's colour, labelled with the return's name (the label is cut to
    the cell), and its pre/post button `send_<letter>-pre`. Behaviour, keys,
    automation and MIDI learn are every knob's.
- **Analyser:** a return shown in it is named by its name and drawn in its
  colour (`RETURN_COLORS[slot]`, the canvas needs the value).

## Strip presets (plan 27)

Every strip has a **Presets** button (a small sliders push-button on the
right end of its header, `strip-presets`). It opens a floating card
(`PopButton` with `float`: fixed to the window, because the strip clips its
content) listing the strip kind's presets (`preset-<id>`), and on a track
strip **Duck to kick** (`preset-duck`). Code: `app/src/state/mixerPresets.ts`
(tables, `applyPreset`), `app/src/state/mixer-actions.ts` (`duckToKick`).
In the card, ↑ / ↓ move between the items (wrapping), Home / End jump to the
first / last, and Esc closes it and puts the focus back on the button.

**Rules.**
- A preset holds absolute values for **whole sections** of its strip kind:
  - a track preset holds the EQ, the comp and a **reverb send** and a **delay send**
    with their pre flags (see *Sends follow the returns* below);
  - a return preset holds its EQ and its effect;
  - a master preset holds its EQ and the limiter.

  Applying one after another never leaves a knob of the first one behind;
  anything a preset does not list is the catalog default.
- **Sends follow the returns** (plan 29). A track preset's `reverbSend` /
  `delaySend` (and `reverbPre` / `delayPre`, post when absent) are not catalog
  params, because the knob they drive depends on the song's returns:
  - `applyPreset` sends the reverb value to the **first Reverb return** in
    creation order (`send_<its slot>`) and the delay value to the **first
    Delay return**; a value absent from the preset means Off and post;
  - if the song has no return of a kind, that value is skipped;
  - every other send (to the other returns) is left alone;
  - **Flat** turns all 8 sends Off and post-fader;
  - a return strip's presets are those of its kind (`presetKindOf` is the
    return's `kind`): Hall is offered on a Reverb return, never on a Delay.
- A preset never holds fader, pan, mute or solo (the balance is the user's),
  nor the sidechain key.
- **A keyed track strip** (a sidechain key: Duck to kick, or one picked by
  hand) holds a comp the user set up on purpose:
  - a track preset other than Flat leaves its **comp section alone**, so the
    duck survives, and applies only the preset's EQ and sends;
  - **Flat** clears the key and turns the comp off, in the same edit: Flat
    means a clean strip.

  Both are still one undo entry.
- Every value is inside its `mixer_catalog.json` range, and the strip takes it
  (`accepts`). `mixerPresets.test.ts` checks every preset.
- One apply is **one undo entry**, "Preset: <name>". The params are set in
  catalog order, through `setMix`, nested in one `edit`.

**The EQ the values talk to** (`engine/src/dsp/eq.rs`):
- a 12 dB/oct HP (20 Hz = off);
- a low shelf at 100 Hz;
- a mid peak (200 Hz to 8 kHz, Q 0.3 to 4);
- a high shelf at 8 kHz.

The comp's attack and release are in ms. The values below were chosen for
house at 120 to 130 bpm, where a beat is 460 to 500 ms.

### Track presets

Blank cells are the defaults: EQ and comp off, sends at −60 dB (off), post-fader.

| Preset | EQ: HP · low · mid (freq, gain, Q) · high | Comp: thr · ratio · att · rel · makeup | Sends (reverb · delay) | Why |
|---|---|---|---|---|
| Kick punch | 30 Hz · +3 · 400 Hz −3 Q 1.2 · +1.5 | −14 dB · 4 · 10 ms · 80 ms · +3 | — | The HP clears sub-rumble below the fundamental, which only eats headroom. The 100 Hz shelf adds weight, and the 400 Hz cut removes the cardboard "box". The 10 ms attack lets the click through before the comp clamps, so the kick hits harder. The 80 ms release recovers well before the next 16th. The kick stays dry: reverb on the kick smears the low end. On a drum bus the +1.5 dB shelf also lifts the hats. |
| Bass tidy | 30 Hz · 0 · 250 Hz −3 Q 1 · −3 | −20 dB · 4 · 15 ms · 120 ms · +3 | — | The 30 Hz HP removes the inaudible sub-sub, and costs only about 1 dB at E1 (41 Hz), so a deep-house line keeps its low notes. The 250 Hz cut takes out the mud where bass and kick body pile up. The −3 dB shelf at 8 kHz only softens the very top (string noise and the highest harmonics; about −0.5 dB at 4 kHz), so the 1–4 kHz bite that lets the bass read on small speakers stays. The 4:1 comp evens out the note levels so the low end sits at one level; the 15 ms attack keeps the pluck. Dry, so the low end stays mono-solid. |
| Hats air | 300 Hz · 0 · 3.5 kHz −2 Q 1.5 · +3 | off | −22 · — | **For a hats or percussion track.** A drum track is one strip for its whole kit, so on a full-kit strip this HP removes the kick (the blurb says so). Everything under 300 Hz in a hat is bleed or thump that clouds the kick. The 3.5 kHz dip tames the harsh "tss", and the 8 kHz shelf adds air. No comp, because squashing hats flattens the groove's dynamics. A touch of room puts them in the same space as the rest. |
| Pad wash | 180 Hz · 0 · 500 Hz −3 Q 0.8 · −2 | −24 dB · 2 · 30 ms · 300 ms · +2 | −8 · −24 | The pad leaves the kick and bass range below 180 Hz, which is the most important house mix move. A wide 500 Hz dip de-muds it, and a softer top keeps it behind. A gentle, slow 2:1 comp levels the chords without pumping. The pump comes from Duck to kick on top. It is washed well into the reverb, with a little delay. |
| Stab space | 150 Hz · 0 · 2.5 kHz +2 Q 1 · 0 | −18 dB · 3 · 5 ms · 100 ms · +2 | −14 · −16 | The stab's low end is out, and 2.5 kHz brings presence so it cuts through in short hits. A fast comp gives a consistent bite. Reverb plus a clear echo is the classic dub-chord space. |
| Lead presence | 120 Hz · 0 · 3 kHz +2 Q 1.2 · +1.5 | −18 dB · 3 · 8 ms · 150 ms · +2 | −16 · −18 | The low end is cleared, and a moderate lift at 3 kHz (where the ear is most sensitive) brings the line forward with some air. It is kept to +2 dB at Q 1.2 (about an octave): with the air shelf on top, more is fatiguing on a bright saw or supersaw lead. A 3:1 comp holds it at one level. It has a bit of space, less than the pad, so it stays upfront. |
| Flat | (defaults) | (defaults: off) | (defaults: off) | Back to a clean strip: EQ, comp and sends at their catalog defaults, as spec §3 says. On a keyed strip it also clears the key. |

### Return presets

Every reverb and delay preset high-passes its return. Low end in a reverb or
an echo is mud, and the classic move is an HP at 200 to 400 Hz.

| Preset | Return EQ | Effect | Why |
|---|---|---|---|
| Room | HP 250 Hz | size 0.35 · decay 0.8 s · damping 0.5 · predelay 10 ms | A small, short ambience that thickens drums and stabs without an audible tail. |
| Plate | HP 300 Hz | size 0.55 · decay 1.8 s · damping 0.25 · predelay 25 ms | Bright and dense, with low damping. The 25 ms predelay keeps the attack of a snare, clap or vocal clear of the tail. |
| Hall | HP 250 Hz | size 0.85 · decay 3.8 s · damping 0.45 · predelay 40 ms | A big space for breakdowns and pads. A long predelay separates the dry sound from the room. Its decay is over 3 s (the e2e checks it). |
| Dark | HP 200 Hz, high −6 dB | size 0.7 · decay 2.8 s · damping 0.85 · predelay 20 ms | Heavy damping plus a shelved-off top. A deep-house space that stays behind the mix and never fizzes. |
| 1/8 ping-pong | HP 300 Hz | 1/8 · feedback 0.35 · ping-pong on · high cut 6 kHz | Eighths bouncing left and right, with three or four audible repeats. It widens stabs and hats without washing them out. |
| 3/16 dub | HP 400 Hz, mid 800 Hz +2 Q 0.7 | 3/16 (a dotted eighth) · feedback 0.55 · ping-pong off · high cut 2.5 kHz | The dub-techno echo: a long, darkening tail in the centre, thinned and pushed into the mids, as a tape echo would be. The dotted eighth plays against the four-on-the-floor. |
| 1/4 slap | HP 250 Hz | 1/4 · feedback 0.15 · ping-pong off · high cut 5 kHz | A single soft repeat one beat (a quarter note) later, then gone: about 0.5 s at 120 to 128 bpm, and at feedback 0.15 the second repeat is already 16 dB down. Not a short rockabilly slap (60 to 120 ms); the name is spec-fixed. It adds depth to a lead or vocal without a cloud. |

### Master presets

| Preset | Master EQ | Limiter | Why |
|---|---|---|---|
| Clean | off (flat) | −0.3 dB | A transparent master, the default state. |
| Warm | HP 25 Hz · low +1.5 · 3.5 kHz −1 Q 0.7 · high −1.5 | −0.3 dB | A gentle tilt (spec §3: "gentle EQ"). The HP removes the sub-rumble that eats limiter headroom. A little 100 Hz weight is added, and the harshness and top are eased by a dB or so. No move is bigger than 1.5 dB, because a master EQ should only nudge. |

The −0.3 dB ceiling leaves a little room against inter-sample peaks on
playback.

### Duck to kick

`duckToKick(p, sink, trackId)` is the one-click pump. It keys the track's comp from the
Kick row and sets comp on, threshold −14 dB, ratio 8, attack 1 ms, release
100 ms and makeup 0 dB (`DUCK_TO_KICK`). Together:
- every kick pulls the track down by about 7–10 dB;
- the dip lands with the kick's transient (attack 1 ms) and follows the
  kick's own envelope, since the ratio is high;
- the level is back within a dB before the next beat (release 100 ms) on
  every shipped kit except Deep, whose 750 ms kick still holds 1–2 dB there;
- no makeup: a ducker is a dip, not a level change (with makeup the strip
  would jump louder whenever the kick stops, in a break or with the Kick
  muted).

**The level the duck really hears.** The key is the Kick row's own output:
- each kit's kick is normalised to −1 dBFS;
- the row plays it at `row.gain · vel/127`;
- the equal-power pan law costs 3 dB per channel at centre.

So at default row gain the key peaks at about **−4.5 dBFS on an accented
step** (`X`, vel 120) and **−6.1 dBFS on a plain one** (`x`, vel 100), never
the kick file's −1 dBFS. The values were tuned against that key. The
reduction is about (key − threshold) · 7/8: about 8 dB on an `X` kick and
7 dB on an `x` kick, a bit more in practice from the knee and ballistics.
Measured in the templates at the drop, the peak reduction is 6.7–8.2 dB and
the mean 2–4 dB. A row gain or kick velocity changes the depth with it.

*History.* The spec's first values were −30 dB, 8:1, 1 ms, 150 ms and +2 dB
(`DUCK_TO_KICK_V1`). Against this key they ducked 20–24 dB and never
recovered between kicks. The plan 27 final review retuned them; spec §3
carries a note.

It is one undo entry, "Duck to kick". Fader, pan, EQ and sends are left alone.

**The Kick** (`kickKey`): the first row whose name has the role Kick (`kits.ts
rowHasRole`: case and surrounding spaces ignored) in the first drum track, in
track order, that has one. A first drum track with no Kick, such as a
percussion track, is skipped rather than refused.

**Refused** (nothing changes, nothing is sent): the call returns `{ ok: false,
reason }`, and the strip flashes the reason in the top bar (`flashHint`). This
happens when:
- there is no Kick row;
- the target is the drum track that plays the Kick;
- the target is not a track;
- the Kick row would be a ninth distinct drum-row key (`MAX_KEYS`,
  `rowKeyAllowed`). A Kick row another strip already keys is shared, so a
  second duck is always allowed.

**Losing the Kick.** Deleting the Kick row (`removeDrumRow`) or its drum
track (`removeTrack`) clears every key on it. A strip whose comp still holds
Duck to kick's exact values (`hasDuckComp`: today's, or the `DUCK_TO_KICK_V1`
values a project saved before the retune holds) would then listen to itself
at 8:1 and squash its own loud parts. So, in the same edit (one undo entry, and
undo brings the duck back), each such strip's comp is switched off. Only
`comp_on` changes: the other values stay, so re-keying and switching it on
restores the duck. The top bar says "Duck to kick removed from Bass (kick
deleted)" (`mixer-actions.ts` `keysLostBy` / `unduckLostKeys`). A strip whose
comp the user retuned since, or keyed by hand, keeps its settings.

**Setting the key to "none" by hand.** The same rule applies when the user
picks "none" in a ducked strip's Sidechain select (`pickSidechain`, which
`Strip.svelte` uses): the comp is switched off in the same "Sidechain" edit,
and the top bar says "Duck to kick removed from Bass (sidechain set to
none)". Picking another key keeps the duck, re-keyed. Undo and the other
callers use `setSidechain`, which never touches the comp.

The menu offers Duck to kick on every track strip except the Kick's own drum
track.

### Calling them without the UI (templates)

`applyPreset(p, sink, channel, presetId)` returns a boolean.
`duckToKick(p, sink, trackId)` returns `{ ok }`. Both are plain actions, and
`edit` (`state/edits.ts`) makes no undo entry in these cases:
- the project has no history yet (a fresh `Project`);
- it is loading;
- it is baselining.

Inside an outer `edit` they are part of that one entry. A template build
(plan 27 Task 2) calls them directly, with no option and no separate
non-edit variant. Preset ids:
- tracks: `kick-punch`, `bass-tidy`, `hats-air`, `pad-wash`, `stab-space`,
  `lead-presence`, `flat`;
- the Reverb return: `room`, `plate`, `hall`, `dark`;
- the Delay return: `delay-pingpong`, `delay-dub`, `delay-slap`;
- the master: `master-clean`, `master-warm`.

## Engine reset

`OP_RESET_ALL` calls `Mixer::reset_all`: every strip is rebuilt in place
(params, keys, EQ/compressor state, insert crossfades, tails, holds), the
defaults are applied *at once* (no 5 ms glides), then the return layout is
back to the default (Reverb, Delay, six Off) and every slot's Reverb and Delay
are reset (their tails zeroed, jumping to the default settings), the
limiter is cleared (delay line, windows, envelope, positions) and the legacy
master gain is back at `MASTER_GAIN` (0.8) without a ramp. The result renders
bit for bit like a new mixer (`reset_all_clears_mixer_tails_and_master`). The
engine fades its last output sample over 5 ms across the reset, so cutting
the tails never clicks.

## Slot reuse (adding a track)

`ADD_*_TRACK` over a track (or over a removed one still fading out) is a
removal (`Mixer::slot_removed`): the strip resets to the defaults but *holds*
its old gains, gate and inserts for the 2 ms fade plus one rack sub-block, so
the old track fades out through the settings it was mixed with, then glides
to the new ones. On an **empty** slot whose strip has no hold or tail left,
nothing sounds through it, so `Mixer::slot_added` skips the hold and marks
the strip *fresh* until its first block: every setting sent before that block
(a project load's or the export's `MIX_SET`s) jumps into place instead of
ramping, and applies from the track's first sample whatever the call size
(`add_track_then_mix_set_applies_immediately`,
`render_is_call_size_independent`). Before plan 7 the hold applied here too
and ended on a call boundary, so a project's mutes and faders were ignored
for the engine's first call (see `export.md`).

## Automation

Automation lanes (`docs/architecture/automation.md`) drive continuous mixer
params through `Mixer::automate`, never through `set`:

- **Base and overlay.** The strip keeps the hand-set value (the *base*: what
  `MIX_SET` stores, `Mixer::param` reports and the project saves). The
  automated value sits in an overlay (`auto_mask` / `auto_vals`), which
  every gain and DSP update reads first (`Mixer::effective`). So a `MIX_SET`
  on an automated param only stores the base. `Mixer::release_auto`
  re-applies the base, with the normal smoothing, when the lane stops
  applying.
- **Sub-block chunks.** With no mixer lane applying, `process` runs the
  whole block as one chunk, bit for bit as before (the golden export hashes
  pin this). While one applies, it runs strips, returns, master and limiter
  in `RACK_BLOCK` (32-frame) chunks. Before each chunk it applies the block's
  `AutoFrame` entries:
  - on a *line*, the fader, pan and send ramps move linearly to the next
    sub-block value over the chunk (`Ramp::line`; a 5 ms step glide still
    running is never cut short);
  - on a *step*, they glide over the usual 5 ms;
  - EQ, compressor, reverb, delay and limiter params set their DSP target
    once per chunk and glide inside the DSP.

  Meter peaks are the maximum over the chunks.
- **Fresh strips.** A fresh strip (see Slot reuse), and the returns and
  master before their first block after a reset, take a step at once. So a
  replayed project starts at its automated values.
- **Lifecycle.** Removing or replacing a track clears its strip's overlay
  with its lanes.

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

Plan 9 adds the Audio-track variant (addendum §4), with the same budgets:

- **Native:** `spec6_mix_with_audio_tracks_renders_under_budget` plays the
  Song-mode mix plus 4 Audio tracks, each one 180 s stereo clip (276 MB of
  samples).
- **Browser:** `spec 6 mix plus 4 audio tracks with long clips` drops four
  2-minute stereo WAVs below the lanes, as from Finder (176 MB of sample
  memory at 48 kHz). It then builds the spec 6 mix, lays its patterns out as
  clips over 16 bars and plays in Song mode. It also checks that every Audio
  strip is heard.

Measured on the dev Mac (Apple M5 Pro; native in release, browser on the dev server):

| Scenario | Native (share of real time) | Browser (audio-thread CPU, mean over 10 s; range of runs) |
|---|---|---|
| Spec 6, Pattern mode | 8.1–8.2% | 16.8–18.8% (max 20.6%) |
| Spec 6, Song mode | 8.4–8.5% | 14.6% (no Audio tracks, one-off probe) |
| Spec 6, Song mode + 4 Audio tracks | 8.5–8.6% | 10.1–15.0% (max 16.7%) |
| Same + 64 automation lanes (32 applying, plan 10) | 8.2% (8.1% without the lanes, same run); 9.1% in the plan 10 Task 5 run (9.0% without) | 6.0–8.4% (max 9.0%). In one run, 7.3% without the lanes; in the full `npm run test:e2e` run, 6.0% while the two scenarios without lanes read 16–18%, so the run-to-run drift is larger than the lanes' cost |

Plan 29 (up to 8 returns), native, release, dev Mac:

| Scenario | Native (share of real time) |
|---|---|
| Spec 6, Pattern mode, 2 returns (default layout) | 9.4–9.5% |
| Spec 6 with 8 busy returns (slots 0..3 Reverb, 4..7 Delay, every track at −12 dB on all 8 sends): `spec6_mix_with_8_returns_renders_under_budget` | 10.0% |
| Same as the 2-return mix plus 6 never-fed slots (`idle_returns_cost_nothing`, median of 5) | 9.25% vs 9.38%, ×0.986 (cap ×1.03) |
| Retyping all 8 busy returns in one block (Reverb ↔ Delay), worst single block across the switch (`retyping_all_returns_fits_in_a_block`) | 0.72–0.81 ms against a 2.67 ms block (steady-state worst 0.54–0.65 ms) |

The retype figure covers the `reset_dsp` memset of the old rings (about 1 MiB per
Delay, 0.6 MiB per Reverb) at fade end, on the audio thread: it fits in a block
with room to spare, so the clear is not sliced over several blocks.
`return_kind_does_not_allocate` (`tests/no_alloc.rs`) retypes, deletes and
re-adds slots 2..7 while playing with the allocation counter armed.

Audio clips cost almost nothing: a voice reads frames from the arena and
scales them by its envelope, with no interpolation or time-stretch. The
browser figures drift by a few points between runs, more than the Audio tracks
add, so only the 0.6 budget is asserted.

Plan 10 adds automation to both scenarios (Global Constraints: Audio tracks
and 64 lanes together):

- **Native:** `spec6_mix_with_audio_and_automation_renders_under_budget`
  (64 lanes × 512 points; 32 apply, 16 mixer and 16 rack, and 32 are
  disabled). no_alloc `automation_does_not_allocate` builds the same kind of
  set: Synth, Audio and drum tracks with 64 full lanes.
- **Browser:** `spec 6 mix plus audio tracks and 64 automation lanes` is the
  Audio-track scenario plus 64 lanes built through the app's own actions
  (`__daw.actions.addLane` / `drawLane`). 32 lanes apply: a fader ride on all
  12 tracks, pan on the 4 synths, and Filter cutoff, Filter reso, ADSR decay
  and Out level on each synth. The other 32 are disabled: both sends on every
  track, and EQ mid gain on the drums and synths. Each lane is a zig-zag with
  a corner every 1/16, so 257 points over 16 bars. It runs in Song mode, with
  the same budgets.
  - **The UI is measured too.** Every track's lanes are open and the mixer is
    open, so its faders and knobs follow their lanes. While playing, the rAF
    intervals stayed at 16.7 ms (p95 and max) with no long tasks.
  - **A timeline scroll step** (wheel to the next frame) cost 16.7 ms with
    the lanes closed. With all 64 open it cost **78 ms**, because every lane
    canvas redrew on every view change, including the ~60 out of view. Now
    only the lanes in (or 2 rows around) the timeline's scroll view draw
    (`AutoLane` with an IntersectionObserver; `data-shown`). An out-of-view
    lane frees its canvas backing store and redraws at the current view when
    it scrolls in. That brought a step back to 16.6–19 ms (20 ms while
    playing), and the backing stores from 2.7 to 0.3 Mpx at dpr 1. The test
    asserts that a step costs less than the closed case + 25 ms, and that a
    lane scrolled in after a view change has drawn. Across four runs, a step
    with all 64 lanes open cost 16.1–19.1 ms.

## Plan 6: reuse as rack modules

The strip processors are plain stereo DSP structs in `engine/src/dsp/`
(`Eq3`, `Compressor`, `Reverb`, `Delay`, `Limiter`), with no mixer
knowledge: they take `&mut [f32]` L/R slices, glide their own params and reset
via `reset()`. They can **not** simply be wrapped as rack modules, though:

* A rack `Module` (`engine/src/rack/modules/mod.rs`) is an inline,
  fixed-size enum stored in preallocated slots, so **adding a module never
  allocates** (it runs on the audio thread via the command ring).
* `Eq3` and `Compressor` are inline state (biquads, envelopes): they fit that
  model and can become `Module` variants as they are.
* `Delay` and `Reverb` own heap rings sized in `new()`: the Delay ~1 MiB at
  48 kHz (2 s stereo, power-of-two rounded; ~2 MiB at 96 kHz), the Reverb
  ~256 KiB of comb lines plus its predelay ring. Constructing one on
  `add_module` would allocate on the audio thread, and storing them inline
  would make every `Module` slot that big.

So rack effect modules use an **engine-owned FX memory pool** (`FxPool`,
`engine/src/rack/fx_pool.rs`, plan 6): typed slots shared by all tracks —
**8 delay, 8 reverb and 16 chorus slots** — allocated once (in
`Synths::new`, called by `Engine::new`) for the context sample rate
(10.5 MiB at 48 kHz, 21 MiB at 96 kHz). The dsp is split into a
`DelayCore` / `ReverbCore` / `ChorusCore` holding all state except the ring,
with `process(buf, l, r)`; the rack module holds a `u8` slot index and
borrows the slot at `process` time. Adding an FX module claims a free slot
(refused with `ERR_OUT_OF_MEMORY` when that kind is used up; the add menu
greys it out with "All 8 delays in use") and removing it returns the slot
once the removal applies, after the declick fade; the slot is zeroed in
32 KiB steps before its next owner uses it. The pool is shared rather than
per-track because most patches use none, and the mixer returns already give
every track a delay and a reverb (see `docs/architecture/modular.md`).
The mixer's own Reverb/Delay returns keep their dedicated buffers: `Delay` /
`Reverb` wrap the same cores with an owned `Vec`, bit-identically (pinned by
`mixer_delay_reverb_unchanged`).

The strip's EQ/Comp inserts can become the default rack-per-track chain.
Parameter tables stay in the golden JSON style (`mixer_catalog.json`), which
is why the UI never hand-copies ranges.
