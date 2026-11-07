# Visuals

How the UI *sees* the sound (plan 12): the mixer meters, the strip and master
analysers, the Scope module, voice LEDs and waveforms. This page starts with
the data path every visual shares; later sections describe each visual.

Code: `engine/src/vis.rs`, `engine/src/mixer/mod.rs` (the tap),
`engine/src/rack/{mod.rs,modules/out.rs}` and `engine/src/synth.rs` (voice
activity), `app/src/audio/{visLayout,visCopy,worklet,engine}.ts`,
`app/src/ui/vis/frameLoop.ts`.

## Data path

```
 audio thread                                   main thread
 ────────────                                   ───────────
 Engine::process
   mixer: tapped strip's post-fader l/r ─┐
   racks: Out peaks + MIDI In gates ──── VisBlock (engine_vis, wasm memory)
                                         │
 worklet step 4b: copyVis ◄── want mask ─┼──────────── frameLoop (one rAF)
   want & 1: output     -> master ring ──┤               │ OR of on-screen
   want & 2: tap        -> tap ring ─────┤ visSab        │ consumers' want
   want & 4: voices (ballistics) ────────┤ (~400 KB)     ▼
   (want & 8: scopes, Task 2)            └─────────► consumers: frame(now, vis)
   Atomics.store(head) after the data                 draw canvas / DOM directly
```

**Shared memory only.** Visual data crosses threads only through `visSab`,
created once by `AudioEngine.start` and passed to the worklet as a
processor option. No `postMessage` per block, no allocation in `process()`.
Its layout is computed in exactly one place, `app/src/audio/visLayout.ts`:
an `Int32Array` header (want mask, ring heads, the tapped channel, the
scope headers) followed by the `Float32Array`s (master ring and tap ring,
`VIS_TAP_RING` = 8192 stereo planar frames each; the voices; the scope
rings).

**What the engine provides.** `engine_vis` points at a preallocated,
fixed-address `VisBlock` (`vis.rs`):

- *Strip tap.* `VIS_TAP` (op 55, `a` = a mixer channel `0..=33` or −1 =
  off) picks one track strip or return. While on, `Mixer::process` zeroes
  the tap at block start and `mix_out` writes the strip's post-fader `l`/`r`,
  the same values it adds to the master bus, so the tap's peaks are exactly
  the strip's meter. A strip that does not run leaves zeros. The master is
  refused (`BAD_VALUE`): the worklet copies the engine output itself. The tap
  is view state: not an edit (`NON_EDIT_OPS`), never in `projectCommands`,
  kept across `RESET_ALL`; a new engine (audio restart) starts with it off,
  so the UI sets it through `frameLoop().setTap(ch)`, which re-sends it on
  every `attach`.
- *Voice activity.* Each rack Out records its input channels' peaks beside
  its (unchanged) sum; the rack keeps the max over its Outs and the gates of
  its first MIDI In; once per block `Synths::write_voices` writes level and
  gate per voice per track slot (`[(slot × 16 + k) × 2]`, `+ 1`). Levels
  under −60 dBFS read 0 (an activity light, not a meter); a rack that did not
  render writes zeros. Non-finite samples never count as a peak; the
  worklet ignores non-finite levels and darkens below the same −60 dB.

Both only read signals. `vis_tap_does_not_change_audio`, `out_sum_unchanged`
and the untouched export hashes pin that the sound is bit-identical.

**The want mask.** Header word 0, written by the UI's frame loop: the OR of
the on-screen consumers' bits (1 master, 2 strip tap, 4 voices, 8 scopes).
The worklet's step 4b (`copyVis`) copies only what is set; with 0 it writes
nothing, so a hidden or idle UI costs the audio thread one `Atomics.load`.
Voice levels get the meters' ballistics (instant attack, 60 dB/s fall) so a
60 Hz reader never misses a short note; gates are copied as is.

**Heads and the guard.** Each ring has a monotonically increasing `i32`
head counting frames (it wraps at 2^31; compare heads with `(a - b) | 0`).
Frame `h` lives at `h & (RING - 1)`; the ring size divides 2^32, so
positions stay continuous across the wrap. The worklet writes a block's
frames, then publishes the head with `Atomics.store` (the ordering rule:
data first). Readers `Atomics.load` the head first, read backwards from it,
and never read the oldest `VIS_GUARD` = 256 frames of the ring: the worklet
adds at most 128 per block, so a read can never meet a write. A head moves
only while its bit is wanted, so frames from before a consumer turned its
bit on may be stale.

**One frame loop.** `ui/vis/frameLoop.ts` runs the app's only
`requestAnimationFrame` loop for visuals (App's `wireEngine` attaches it to
each engine; `unwireEngine` detaches it):

- `add({ want, el?, hz?, frame })` registers a consumer and returns its
  remove function; `el` is watched with one `IntersectionObserver`;
- the rAF runs only while the document is visible and at least one consumer
  is on screen (or has no `el`); otherwise it stops and the want mask is 0;
- at most 60 frames a second: a display frame less than a 60 Hz period
  (minus 1 ms of jitter) after the last drawn one is skipped, so 120 and
  240 Hz displays draw 60 fps and a 144 Hz one 48 fps; `hz: 30` consumers
  run every other drawn frame (analysis);
- every callback is timed: `stats()` = `{ busyMs, wallMs, frames }` over the
  last 5 s, where `wallMs` is only the time the loop was running (a pause
  neither costs nor dilutes), exposed as `window.__daw.vis.stats()`; the
  ≤ 5 % main-thread budget is `busyMs / wallMs`;
- `setTap(ch)` chooses the strip tap: sent to the attached engine and
  remembered, and `attach` re-sends it to a new engine (an audio restart
  starts with the tap off), like the want mask;
- a consumer that throws is removed and logged once.

Consumers draw their canvas or DOM directly, never through Svelte state
(the MeterBus rule). The mixer meters are one: `MixerView` registers its
MeterBus tick with want 0 (the meters have their own SAB) and the mixer
element, instead of running its own rAF. A paused loop reads nothing, so the
mixer's clip / LIMIT lights do not latch an over that happened (and fell
away) while the mixer was off screen or the tab hidden.
