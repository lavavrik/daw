# Visuals

How the UI *sees* the sound (plan 12): the mixer meters, the strip and master
analysers, the Scope module, voice LEDs and waveforms. This page starts with
the data path every visual shares; later sections describe each visual.

Code: `engine/src/vis.rs`, `engine/src/mixer/mod.rs` (the tap),
`engine/src/rack/{mod.rs,modules/out.rs}` and `engine/src/synth.rs` (voice
activity), `app/src/audio/{visLayout,visCopy,worklet,engine}.ts`,
`app/src/ui/vis/frameLoop.ts`; the analyser: `app/src/ui/vis/{fft,spectrum,
stereo,analyserBus}.ts`, `{Spectrum,Goniometer}.svelte`,
`app/src/ui/mixer/AnalyserPanel.svelte`.

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
   want & 8: scopes -> scope rings ──────└─────────► consumers: frame(now, vis)
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
  every `attach`. The analyser bus is the one caller (*Analyser* below).
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

## Analyser

The mixer's analyser and the top bar's master spectrum (plan 12 Task 3).

```
 master ring ─┐                               ┌─► top bar: 64 × 18, 20 bands
 tap ring  ───┼─► analyserBus (ONE 30 Hz ─────┼─► AnalyserPanel spectrum:
 SAB [3]   ───┘    frame-loop consumer)       │     320 × 140, 60 bands
                   newest frames → (L+R)/2 →  └─► Goniometer + correlation
                   Hann → FFT 4096 → bands →        (Master only)
                   ballistics; correlation,
                   goniometer points
```

**Where.** `AnalyserPanel` sits right of the Master strip (340 px; it
scrolls with the strips): a header "Analyser · Master" or "· <strip>" in the
strip's colour, the spectrum, and for the Master a 120 × 120 goniometer and
a correlation bar. Each track and return strip has a "∿" toggle (*Show in
analyser*): one strip at a time, pressing it again goes back to the Master.
The choice is view state (not saved, not an edit). The top bar's 64 × 18
master spectrum (20 bands, no labels) sits before the CPU pill; a click
opens the Mixer tab.

**Analysis** (`spectrum.ts`, `fft.ts`):

- input: the mono sum `(L+R)/2` of the newest 4096 frames of the ring;
- an in-place radix-2 real FFT (one complex 2048-point FFT, split), Hann
  window, twiddles and every buffer allocated once per instance;
- level: dB with the Hann coherent gain (0.5) corrected, so a full-scale
  sine reads 0 dB; display range −90..+6 dB, gridlines at
  30/50/100/200/500/1k/2k/5k/10k/20k Hz and 0/−12/−24/−48/−72 dB on a log10
  axis (`freqToX(f) = log10(f/20)/3`, 1 kHz at 0.566);
- **bands**, log-spaced 20 Hz–20 kHz: 60 (1/6 octave) for the panel, 20
  (1/2 octave) for the top bar. Between bins the spectrum is a parabola (in
  dB) through the taller of the two neighbouring bins and its neighbours —
  the classic peak interpolation, which undoes the Hann scalloping (up to
  −1.4 dB halfway between bins). A band takes the max of that curve over
  its span: a band wider than a bin is the max of its bins (or a peak's
  parabola top in the band); a band narrower than a bin (below ~100 Hz in
  the panel: a bin is 11.7 Hz at 48 kHz) is interpolated, so the low end is
  a curve, not a staircase. Measured over phases and both band sets: a
  full-scale sine reads within ±0.32 dB in its own band from 30 Hz to
  19.9 kHz at 44.1 and 48 kHz and from 45 Hz at 96 kHz (a bin is 23 Hz
  there); lower, its mirror image near 0 Hz bends the lowest bins (up to
  ~1.5 dB). Bands two octaves away read below −60 dB;
- **ballistics**: instant rise, fall 24 dB/s; peak-hold dots hold 1.0 s,
  then fall 12 dB/s; no slope tilt (a 3/4.5 dB/oct tilt is a follow-up);
- hover readout "55 Hz · A1 · −8.2 dB": the frequency under the pointer,
  its nearest note (A4 = 440 Hz), the level of its band — for tuning kick
  and bass. Pointer-only for now (a keyboard cursor is a follow-up); the
  panel is one labelled image to assistive tech, the top-bar view hidden
  (its button has the label).

**Stereo** (`stereo.ts`, Master only). Correlation `Σ LR / √(Σ L² Σ R²)`
over the newest 100 ms (4800 frames at 48 kHz). The bar does not smooth
the per-window ratio: it smooths the window's mean sums (`ΣLR`, `ΣL²`,
`ΣR²`) with a 300 ms one-pole and shows the ratio of the smoothed sums, so
sparse material — a click every half second, a kick between gaps — reads
its true correlation (a sparse mono click reads > 0.95) instead of being
pulled toward 0 by the silent windows in between. Below a gate (smoothed
RMS under −60 dBFS) it holds the last reading, and after 2 s of sustained
gating eases to 0 (300 ms); it starts at 0 and never reads NaN. The
goniometer draws the newest 2048 frames at 48 kHz (the same ~43 ms at
other rates) as dots at `x = (R − L)/√2`, `y = (L + R)/√2`: mono is
vertical, an inverted side horizontal, with a short phosphor trail (each
frame fades the last). The scale is fixed with full scale at the radius
(|(L, R)| ≤ √2 for samples within ±1 maps to the circle). Window lengths
follow the sample rate but never exceed a ring read (8192 − 256 = 7936
frames: 83 ms at 96 kHz, 41 ms at 192 kHz).

**The bus** (`analyserBus.ts`) is one 30 Hz frame-loop consumer; views
subscribe (`mini`, `panel`, `stereo`, each with its canvas as `el`, watched
by the bus's own IntersectionObserver) and draw from its arrays after each
analysis, so there is never a per-view FFT:

- it wants the master ring (bit 1) while any master view is on screen —
  the top bar, the goniometer, or the panel showing the Master — and the
  tap ring (bit 2) only while the panel is on screen showing a strip; it
  re-registers on the loop when those bits change and unregisters while
  nothing is on screen;
- it owns the tap choice: `select(ch | 'master')` / `toggle(ch)`; the
  engine taps the selected strip while a panel is mounted, else −1,
  through `frameLoop().setTap`, which re-sends it on every `attach` (App
  attaches the loop and the bus, for its sample rate, to each engine);
  `sync(strips)` (MixerView) falls back to the Master when the selected
  track is removed or its slot now holds another track;
- a change of the tapped channel (the SAB's `[3]`) resets the panel's
  history, and until `[3]` equals the selection the panel reads silence;
  frames from before a ring stood still (its bit off, the loop paused:
  it moved less than half the frames the elapsed time should have
  brought) read as silence, so old audio never shows as current, while a
  slow frame rate (a throttled tab) is not mistaken for a pause;
- ballistics and smoothing step by the real time between analyses (at
  most 1 s: a pause is the staleness rule's job, so a throttled tab still
  falls at the stated rates);
- at most 30 analyses a second (the loop's `hz: 30` and a 29 ms guard
  against re-registration); nothing allocates per frame.

**The master includes the click**, as the master meter does: the master
ring is the engine output, metronome included.

**Why on the main thread.** The worklet already does the one cheap thing
(copy the frames it is asked for); an FFT there would cost the audio
thread on every block whether anyone looks or not, and a Worker would
need a second copy and a message per frame. On the main thread the
analysis runs only while a view is on screen, at 30 Hz: a 4096-point FFT
plus 80 bands takes ~0.05 ms (Node), and digital silence (a stopped
transport) skips the FFT. Measured in headless Chromium while playing
(`window.__daw.vis.stats()`, every frame-loop visual together): top bar
only 0.33 % of the main thread; mixer + analyser on the Master (goniometer
included) + top bar 1.5 %; the same on a strip 0.8 % — within the 5 %
budget.

