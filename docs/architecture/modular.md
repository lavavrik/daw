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
- The ladder filter (LP24) is characterful on purpose: a saturator inside the
  feedback loop makes the resonant peak compress with input level (ruling
  R10; see `rack/modules/filter.rs`). Cutoff is smoothed in the log domain.

## Declicked edits and smoothing

Structural edits (remove module, connect, disconnect, clear) made while the
rack is sounding are validated at once, queued (64 entries), and the output
fades out over 2 ms (`DECLICK_SECONDS`), the queue applies at a sub-block
boundary, then it fades in over 2 ms. On a silent rack the edit applies at
once but the output still ramps up from 0. Adding a module (it has no cables
yet) applies immediately unless edits are already queued.
Parameters marked `smooth` in the catalog glide over 5 ms; others apply
at once.

## Adding a module

Modules are enum-dispatched (no trait objects, no allocation):

1. Add `engine/src/rack/modules/<name>.rs` with the DSP struct (`new(sr)`,
   `process(...)`; follow the contract at the top of `rack/modules/mod.rs`).
   Declare it with `pub mod <name>;` in `rack/modules/mod.rs`.
2. Add the variant to `enum Module` and wire it into `Module::new`,
   `Module::kind` and `Module::process` (same file).
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
`SET_INPUT_TRACK` sends AllOff, pedal-up and bend 0 to the old track, then
replays the cached bend, mod and sustain to the new one. Removing the input
track unsets it.

## Performance

Native (`cargo test --release -p daw-engine --test perf -- --ignored
--nocapture`): about 8.5% of the audio budget for 4 tracks x 13 modules x 8
voices. The e2e `four synth tracks stay under budget` runs four drone patches
(8 voices, 2 saw oscs with unison 2, LP24 + LFO, VCA) in Chromium and
requires CPU telemetry below 60% with no new dropouts or errors; it measured
about 7%.
