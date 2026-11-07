# Modular rack

The synth-track engine: each synth track owns a rack (up to 32 modules) that
the audio thread renders in small sub-blocks. Code: `engine/src/rack/mod.rs` (graph, order, declick),
`engine/src/rack/catalog.rs` (module specs, golden generator),
`engine/src/rack/modules/*.rs` (the DSP); the generated module list is
`engine/catalog.json`.

## Signals

All signals are f32 buffers; the kind only matters for cable colour and docs.

| Kind  | Range | Notes |
|-------|-------|-------|
| audio | about -1..1 | |
| pitch | V/oct, 0 = C4 | `midi_in` pitch includes bend and glide |
| gate  | 0 / 1 | |
| CV    | 0..1 or -1..1 | envelopes 0..1, LFO bipolar |

## Sub-blocks, order, feedback

The rack renders in `RACK_BLOCK` = 32-frame sub-blocks (a 128-frame quantum is
4 of them). Modules run in Kahn topological order. If the graph has a cycle it
is broken at the lowest-index module actually on the cycle; that cable
becomes a feedback edge and reads the previous sub-block (a 32-frame delay).
The rack output is guarded against NaN/inf, and modules flush DSP state
below 1e-20 to 0 (denormals).

## Polyphony

Cables are multichannel: channel count = max over the module's connected
inputs. `midi_in` emits one channel per voice (1 in mono mode); a mono signal
feeding a poly input is broadcast. An input takes one cable (connecting again
replaces it).

- **Poly**: a new note-on takes a free voice (never-used first, then the
  longest-released, so fresh release tails survive); with none free it steals
  the voice with the oldest note-on. Glide is ignored in poly. A reused voice gets a
  one-sub-block gate gap so envelopes retrigger.
- **Mono**: legato (overlapping notes do not retrigger) with optional glide (last-note priority);
  glide is the time to cover 99% of the interval (1% remains).
  `glide_mode` picks which notes glide: **Always** (the default, as before
  plan 11) glides every note, including one started from silence;
  **Legato** glides only a note pressed while another is held (the gate
  stays high), so a note from silence jumps to its pitch. That is the house
  "slide" (Acid Line, Sax). Poly ignores both modes.
- The ladder filter (LP24) is characterful on purpose: a saturator inside the
  feedback loop makes the resonant peak compress with input level (ruling
  R10; see `rack/modules/filter.rs`). Cutoff is smoothed in the log domain.

## Envelopes

The ADSR (`rack/modules/adsr.rs`) runs Idle → Delay → Attack → Decay →
Sustain → Release per channel. Plan 11 appended (indices unchanged):

- `delay` (0..4 s, 0 = off): a rising gate holds the current level for
  `delay`, then attacks. A falling gate during it releases from that level;
  a retrigger restarts it; a held gate (legato) never does. Used for delayed
  vibrato (the Sax).
- input `vel` and `vel_amt`: `env = level × (1 − vel_amt + vel_amt × v)`,
  with `v` latched at the rising gate (unconnected = 1), so a note's dynamic
  holds through it; the latched value glides over 5 ms so a voice steal at a
  sounding level never steps. Patch MIDI In `vel` into it for velocity
  brightness or loudness.
- With `delay` 0, `vel_amt` 0 the output is bit-identical to the
  pre-plan-11 envelope (pinned by `adsr_defaults_are_bit_identical`), so old
  patches and export hashes are unchanged.

## Declicked edits and smoothing

Structural edits (remove module, connect, disconnect, clear) made while the
rack is sounding are validated at once, queued (64 entries), and the output
fades out over 2 ms (`DECLICK_SECONDS`), the queue applies at a sub-block
boundary, then it fades in over 2 ms. On a silent rack the edit applies at
once but the output still ramps up from 0. Adding a module (it has no cables
yet) applies immediately unless edits are already queued.
Parameters marked `smooth` in the catalog glide over 5 ms. Integer and
choice parameters (osc wave/octave/unison, filter mode, LFO wave/sync/
division, MIDI In voices/mode/bend/glide_mode) switch the signal in a step, so they are
declicked like structural edits: queued behind the 2 ms fade-out while
sounding, applied, faded back in (on a silent rack: applied at once, output
ramps up from 0). Re-sending the current value is a no-op and never dips the
output. The remaining non-`smooth` continuous params (tune, fine, ADSR times incl. delay,
glide, LFO rate) apply at once: they change a rate, not a level, so phase and
envelopes stay continuous, and fading them would dip the output on every step
of a knob drag.

## Automation (`Rack::automate`)

An automation lane on a rack param (`docs/architecture/automation.md`) is
applied by `Synths::render_add`. It passes the block's `AutoFrame` to
`Rack::render_add_auto`, and at each sub-block boundary every entry for this
slot calls `Rack::automate(module, param, value)`:

- **The normal path, never queued.** The value goes straight into the
  running module's param: a `smooth` param glides over its 5 ms one-pole,
  the others apply at the sub-block. It never queues behind a structural
  fade. That is why only non-integer params are automatable: a stepped one
  would need the fade.
- **Modules not driven.** A module whose add or removal is still queued is
  not driven, and neither is an integer param.
- **The base.** The lane keeps the hand-set value (the *base*). While the
  lane drives the param, `RACK_SET_PARAM` only stores the base, validated
  by `Rack::check_param`. When the lane stops applying (Pattern mode,
  disabled, overridden, cleared), the engine re-applies the base with
  `set_param`. `AUTO_LANE_SET` captures the base with
  `Rack::pending_param`: the value once queued edits apply.
- **Lifecycle.** `RACK_REMOVE_MODULE` clears the module's lanes at once,
  even when the removal is queued behind the fade. `RACK_CLEAR` (a patch
  load) and removing or replacing the track clear the rack's lanes.

## Levels

Out sums every poly channel unnormalised (8 voices at full level would be
8x one voice), times `level`. The poly starter patches therefore set a low
Out `level` (Chord Stab 0.4, Pad 0.25, Pluck 0.3) so a 4-note chord (5 for
Pad) peaks below ~0.9 before the master limiter (plan 5; it replaced the
plan-1 hard clamp). `engine/tests/starter_patches.rs`
replays each starter patch's exact UI command list from
`engine/tests/fixtures/starter_patches.txt` (generated and parity-checked by
`app/src/state/patches.fixture.test.ts`) and asserts this.

## Effect modules and the FX pool

Plan 6 added Delay (9), Reverb (10), Chorus (11), EQ (12), Compressor (13),
Saturator (14) and Attenuator (15). They wrap the mixer's DSP
(`engine/src/dsp/`), with the mixer's defaults where they overlap.

- **Stereo effects** (Delay, Reverb, Chorus, EQ, Compressor; the pink
  *Effect* group): inputs `l` and `r` (`r` falls back to `l` when
  unconnected), outputs `l` and `r` of **one channel each**. A poly input is
  summed first, so one reverb serves a whole 16-voice patch. The
  Compressor's `sc` input is the key (summed to mono); unconnected, it keys
  on itself.
- **Delay** syncs to the transport tempo and uses the mixer delay's
  division table (`DELAY_DIVISIONS` in `mixer/catalog.rs`, default 3/16).
  Synced times over 2 s are clamped; the knob shows "(max 2 s)" then, as on
  the mixer delay.
- **Saturator** (*Shaping*) and **Attenuator** (*Utility*: `in × amount +
  offset`) are per channel (poly).
- **FX pool** (`engine/src/rack/fx_pool.rs`). The module enum is inline and
  fixed-size, so Delay (2 s stereo ring), Reverb (FDN lines + predelay) and
  Chorus (50 ms ring) never own memory. They hold a `u8` slot of an
  engine-owned pool, allocated once for the context sample rate and
  **shared by all tracks**: 8 delay, 8 reverb and 16 chorus slots (10.5 MiB
  at 48 kHz). The dsp structs come as a `*Core` that takes the ring in
  `process(buf, l, r)`; the mixer's own Delay/Reverb wrap the same core with
  a `Vec`, bit-identically (`mixer_delay_reverb_unchanged`).
  - Adding one when its bank is full returns `ERR_OUT_OF_MEMORY` and adds
    nothing. The UI never sends it: the add menu greys the module with
    "All 8 delays in use" (counted over the project's tracks).
  - A slot returns to the pool only when its module is gone: when the removal
    or clear *applies*, after the 2 ms declick fade.
  - A reused slot is zeroed before its new module gets it, 32 KiB per
    sub-block (`CLEAR_CHUNK`; a reused delay is mute for about 21 ms), so it
    never replays the previous owner's echo. Worst case, every pooled slot
    zeroing in the same sub-block, is 1 MiB of memset per 0.67 ms sub-block.
  - **Handover on replace.** Because a slot is held through its module's
    removal fade, "remove (or clear) then add" in one batch on a sounding
    rack (a patch load) would find a full bank although the UI counts the
    slot free. So when the bank is full, `add_module` takes over the slot of
    a *queued* Remove/Clear in the same rack: the queue applies in order, so
    the old module is gone before the new one runs. The new module is reset
    when it applies, which restarts the slot's zeroing (`FxPool::reassign`),
    so it starts silent. A `handed` mask absorbs the old owner's release.
    Across tracks there is no handover (another track's fade is independent):
    if the engine still refuses an add, the worklet reports it and the UI
    rolls the add back with the same "All 8 delays in use" message.
  - `Module::reset` on a pooled effect also restarts its slot's zeroing (the
    ring is the pool's; the module only marks it).
  - The engine reset (`OP_RESET_ALL`) hard-clears every rack first
    (`Rack::reset_hard`: no fade, queued edits and pending releases
    forgotten) and only then frees the whole pool, so no stale release can
    free a slot a new module has claimed.

## Sample Player (16)

A *Source* that plays a sample of the project's sample pool (the samples
the drum rows use), one voice per channel. Inputs `pitch` and `gate`, output
`out` (one mono channel per voice; stereo samples play as `(L + R) / 2`).
Params: `sample` (pool id 0..255, −1 = none), `gain` (0..2, smoothed),
`start` (0..1 of the sample, read at trigger), `pitchTrack` (Off/On) and
`root` (MIDI note, default 60).

- A rising gate starts the voice at `start · frames`; it plays to the end of
  the sample (one-shot: follow it with an ADSR + VCA for gated notes). A gate
  with no playable sample starts nothing.
- With `pitchTrack` on the rate is `2^(pitch − (root − 60)/12)`, per sample
  (bends follow), with linear interpolation; off, the rate is 1.
- Declicked like the drum voices: a retrigger fades the sounding voice out
  over 2 ms under the new one. A voice captures the sample's *generation*
  (`engine/src/samples.rs`) at trigger; when the sample is replaced,
  un-readied or cleared by an engine reset, the voice never reads the slot
  again: it holds its last value and fades it to 0 over 2 ms.
- Modules get the pool read-only as a `SampleView`, passed next to the FX
  pool down `Synths::render_add` → `Rack::render_add` → `Module::process`.

## Formant (17)

A *Shaping* module (`rack/modules/formant.rs`): three resonant band-pass
peaks with pitch tracking and a CV shift. It is the body of the Sax and
the "bloom"/"wah" of Brass Stab and Garage Organ. Inline (no FX pool).

- **Signal flow.** `in` → three band-passes in parallel →
  `wet = bp1 + g2·bp2 + g3·bp3` → `out = dry + mix·(wet − dry)` → the
  Filter's output soft limiter (linear to ±2, easing into ±3.5), so full-
  scale noise at q 20 stays within ±3.5.
- **Centres.** Peak *i* sits at `f_i × 2^(shift + track·pitch + cv_amt·cv)`,
  clamped to 20 Hz..0.45·sr; `pitch` and `cv` read 0 when unconnected. With
  `track` 1 the peaks follow the note; 0 keeps a fixed body (a real
  instrument's resonances do not move with the note); the Sax uses ≈ 0.15.
- **Unity-peak sum.** Each peak is the Filter's TPT SVF band-pass (`k·v1`,
  damping `k = 1/q`; the SVF step, its coefficients and `tan_fast` are
  shared with `filter.rs`, not copied), so every peak has unity gain at its
  centre and, with `g2 = g3 = 1`, the response peaks within 1.5 dB of 0 dB at
  each `f_i` (tested). No input saturation.
- **Smoothing and channels.** Every param is smoothed over 5 ms (`f1..f3`
  and `q` in log2). Coefficients are computed per sample, shared across
  channels when `pitch` and `cv` are mono or unconnected (as in the Filter),
  per channel otherwise. Channels are the maximum over the connected inputs
  (a mono `in` is broadcast to a poly `pitch`). Even a 1-octave cv step does
  not click: the TPT states stay continuous.
- **Defaults** are an alto-sax body: 500 / 1500 / 2600 Hz, q 6, gains 1 /
  0.7 / 0.5, so a fresh Formant is useful at once.
- **No vowel table.** Three explicit peaks plus a CV shift cover sax, brass
  and organ "wah" with 10 params (≤ 12). A vowel morph table (a/e/i/o/u
  presets interpolated by a knob) would need either more params or a fixed
  table that fits only one voice size; it is a follow-up if wanted.

## Adding a module

Modules are enum-dispatched (no trait objects, no allocation):

1. Add `engine/src/rack/modules/<name>.rs` with the DSP struct (`new(sr)`,
   `process(...)`; follow the contract at the top of `rack/modules/mod.rs`).
   Declare it with `pub mod <name>;` in `rack/modules/mod.rs`.
2. Add the variant to `enum Module` and wire it into
   `Module::with_fx_slot`, `Module::kind`, `Module::process`,
   `Module::reset` and `Module::snap` (same file). A module that needs a big buffer borrows it
   from the FX pool instead (see above): give it a `FxKind` bank and
   `ModuleKind::fx_kind`.
3. Add the variant to `enum ModuleKind` in `rack/catalog.rs` with a **fixed
   id** (append only: ids are wire format and saved-project format), to
   `ModuleKind::ALL`, and add its `ModuleSpec` (ports, params with
   min/max/default/curve/choices/`smooth`) plus an arm in `spec()`.
4. Regenerate the golden file:
   `UPDATE_CATALOG=1 cargo test -p daw-engine catalog`, and review the diff
   to `engine/catalog.json`. The kind-id test in `catalog.rs` must be extended.
5. Nothing in the UI changes: it imports `engine/catalog.json`, so the module
   shows in "+ Add module", with knobs and cable colours, automatically.

## Live input routing

Keyboard and MIDI notes go to the *input track*: the selected synth track,
else the last-selected one (selecting drums keeps the previous synth).
`SET_INPUT_TRACK` sends pedal-up, an Off per live-held pitch (keys down or
pedal-held) and bend 0 to the old track, never AllOff, so its sequenced notes
keep playing (a pitch held both live and by the pattern ends on the pattern's
Off); then it replays the cached bend, mod and sustain to the new one. Removing the input
track unsets it.

## Performance

Native (`cargo test --release -p daw-engine --test perf -- --ignored
--nocapture`): about 8.5% of the audio budget for 4 tracks x 13 modules x 8
voices, about 9% with each track also playing a 16-note pattern (plan 3). The e2e `four synth tracks stay under budget` runs four drone patches
(8 voices, 2 saw oscs with unison 2, LP24 + LFO, VCA) in Chromium and
requires CPU telemetry below 60%, audible output (peak L/R > 0), and no new
dropouts or errors; a single run measured about 7%.

Rack effects (plan 6, `fx_chain_track_renders_under_budget`): one track
running MIDI In → Osc → Filter (8 voices) → Chorus → Delay → Reverb → Out
measured 0.65% of real time natively. The effects run once, on the summed
stereo signal.
