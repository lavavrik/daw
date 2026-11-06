# Modular rack

The synth-track engine: each synth track owns a rack (up to 32 modules) that
the audio thread renders in small sub-blocks. Code: `engine/src/rack/`,
`engine/src/modules/`; the module list is `engine/catalog.json`.

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
Every output is guarded against NaN and denormals.

## Polyphony

Cables are multichannel: channel count = max over the module's connected
inputs. `midi_in` emits one channel per voice (1 in mono mode); a mono signal
feeding a poly input is broadcast. An input takes one cable (connecting again
replaces it).

- **Poly**: a new note-on takes a free voice, preferring the longest-released;
  with none free it steals the oldest held note. A reused voice gets a
  one-sub-block gate gap so envelopes retrigger.
- **Mono**: legato (overlapping notes do not retrigger) with optional glide;
  glide time is the time to cover 99% of the interval.
- The ladder filter (LP24) is characterful on purpose: resonance compresses
  with input level, and cutoff follows the R8 mapping.

## Declicked edits and smoothing

Structural edits (add/remove module, connect, disconnect, clear) fade out
over 2 ms, apply, then fade in over 2 ms. An edit on an already silent rack
still fades in, and adding a module with no cables applies immediately.
Parameters marked `smooth` in the catalog glide over 5 ms; others apply
at once.

## Adding a module

1. Add `engine/src/modules/<name>.rs` implementing the module trait (ports,
   params, `process`), and register it in the module factory with a new
   `kind` id (append only; ids are wire-format).
2. Add its catalog entry (ports, params with min/max/default/curve/choices,
   `smooth`).
3. Regenerate the golden file: `UPDATE_CATALOG=1 cargo test -p daw-engine catalog`,
   review the diff to `engine/catalog.json`.
4. Nothing in the UI changes: it imports `engine/catalog.json`, so the module
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
