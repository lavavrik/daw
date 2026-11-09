# Visuals

How the UI *sees* the sound (plan 12): the mixer meters, the strip and master
analysers, the Scope module, voice LEDs and waveforms. This page starts with
the data path every visual shares; later sections describe each visual.

Code: `engine/src/vis.rs`, `engine/src/mixer/mod.rs` (the tap),
`engine/src/rack/{mod.rs,modules/out.rs}` and `engine/src/synth.rs` (voice
activity), `app/src/audio/{visLayout,visCopy,worklet,engine}.ts`,
`app/src/ui/vis/frameLoop.ts`; the analyser: `app/src/ui/vis/{fft,spectrum,
stereo,analyserBus}.ts`, `{Spectrum,Goniometer}.svelte`,
`app/src/ui/mixer/AnalyserPanel.svelte`; waveforms:
`app/src/ui/vis/{waveMath.ts,WaveformView.svelte}`,
`app/src/audio/fineSamples.ts`; shape previews and voice LEDs:
`app/src/ui/vis/shapes.ts`, `app/src/ui/rack/{ShapePreview,VoiceLeds}.svelte`,
`engine/tests/shapes.rs` (fixture `engine/tests/fixtures/shapes.json`);
the Scope: `engine/src/rack/modules/scope.rs`, `engine/src/fx_pool.rs`
(the bank), `app/src/ui/vis/scopeMath.ts`, `app/src/ui/rack/ScopeView.svelte`;
idling: `app/src/ui/vis/{idleDriver,waveDriver,visWake}.ts`; the e2e hooks:
`app/src/ui/vis/visHooks.ts`. End-to-end: `tests/e2e/visuals.spec.ts` and,
for anything timed (dropouts, the budget), `tests/e2e/serial.spec.ts`.

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
nothing to visSab, so the copy costs one `Atomics.load`. The engine's own
side work is not gated by it: `Scope::process` (while a Scope module exists),
`write_voices` and the strip tap (while a panel has one selected) still run.
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

**The budget.** Every frame-loop visual together may use at most 5 % of the
main thread (`busyMs / wallMs`), with everything open. The serial e2e
`visuals stay under 5% of the main thread` measures it per surface while the
spec-6 mix plus an Audio track plays in Song mode (8 s each, the last 5 s
counted; the top-bar spectrum is on in every phase). Headless Chromium on
the dev machine (Apple silicon), plan 12 Task 6:

| Surface on screen | Main thread | Per drawn frame |
|---|---|---|
| top bar only (Step grid tab) | 0.8 % | 0.13 ms |
| Mixer: every meter (9 tracks, 2 returns, Master) + analyser on the Master (spectrum, goniometer, correlation) | 1.5 % | 0.26 ms |
| Instrument tab: voice LEDs + ADSR preview | 0.9 % | 0.15 ms |
| Instrument tab with 8 Scopes on screen (+ LEDs, preview) | 1.9 % | 0.31 ms |
| Clip tab waveform at 1000 frames/px, playhead moving | 1.0 % | 0.16 ms |
| stopped and silent | 0 (the loop pauses) | — |

No phase added a dropout, and the engine stayed inside the spec-6 budget
(CPU max 17–28 %, blocks at 100 % of real time). If a new visual pushes a
phase near 5 %, lower its rate (`hz: 30`) or its resolution first; a Worker
for the FFT is the last resort (see `docs/followups/plan-12.md`).

Consumers draw their canvas or DOM directly, never through Svelte state
(the MeterBus rule). The mixer meters are one: `MixerView` registers its
MeterBus tick with want 0 (the meters have their own SAB) and the mixer
element, as an idle driver (the tick returns true while any bar, peak hold or
GR readout is still showing), instead of running its own rAF. A paused loop reads nothing, so the
mixer's clip / LIMIT lights do not latch an over that happened (and fell
away) while the mixer was off screen or the tab hidden.

## Scope

The Scope module's screen (`ScopeView.svelte`, 168 × 96 px in its
ModulePanel above the knobs). The engine side — the sink rule, min/max
entries, decimation, the sync grid, the bank of 8 — is in
`docs/architecture/modular.md` *Scope (18)*; here is what the UI does.

- **Finding its data.** The view is a frame-loop consumer with want bit 8
  on its canvas. The worklet mirrors every *owned* scope slot (entries from
  the mirrored head to the engine head, then the header, then the head with
  `Atomics.store`); the view finds its slot by the header's owner (track
  slot, module idx: `findScope`) and reads only `[max(epoch, head − 2048 +
  VIS_GUARD), head)` (`readable`).
- **The window** (`scopeMath.scopeWindow`): Sync with a valid grid shows the
  last whole division, copied out of the ring when its line passes and held
  until the next (`createSyncHold`); otherwise Auto triggers on the latest
  rising zero crossing of A's mid (a Schmitt trigger at 2 % of A's
  peak-to-peak) whose window ends inside the readable range, and Free (or no
  crossing: *no trig*) shows the newest entries.
- **Drawing:** a line at decim 1, else the filled min..max band; B only while
  connected; gain with ▲/▼ clip marks; XY dots (the newest 256); the readout
  ("5 ms/div", "1/4 · sync") and tags (*no trig*, *idle* after 250 ms with no
  new entries: the last frame stays, dimmed). It redraws only when the head,
  the slot, a param or idle changes, so a stopped rack costs a few
  comparisons per frame. A click freezes it. Test hooks: `scope-<idx>` with
  `data-readout` and `data-tag` (what the canvas says).
- **Cost:** 8 Scopes on screen add ~1 % of the main thread (the budget
  table above).

## Analyser

The mixer's analyser and the top bar's master spectrum (plan 12 Task 3).

```
 master ring ─┐                               ┌─► top bar: 58–190 × 30, 20 bands
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
a correlation bar under it. (`Spectrum` re-fits its backing store whenever
its `width` prop changes, at the device pixel ratio; the panel passes a fixed
320; the top bar's is the fluid one.) Each track and return strip has a "∿" toggle (*Show in
analyser*): one strip at a time, pressing it again goes back to the Master.
The choice is view state (not saved, not an edit). The top bar's
master spectrum (30 px high; its well grows from 66 px to 3× that, 198 px,
when the bar has room, the canvas 8 px narrower; 20 bands, no labels, on an
--lcd well) sits after the
Master slider; a click opens the Mixer tab.

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
- **idle** (Task 5 review): when the transport is stopped, nothing analysed
  was heard and every shown band (levels and peaks, the mini's and the
  panel's when on screen) has been at the floor for 0.5 s
  (`IDLE_AFTER_MS`), it unregisters too, so the always-visible top-bar
  spectrum does not keep the loop running; a visuals wake (below), a new
  view or a new selection re-registers it, and the first look reads the
  stood-still ring as silence;
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
transport) skips the FFT. Measured in headless Chromium while the spec-6 mix
plays (the budget table above): top bar only 0.8 % of the main thread; the
mixer with the analyser on the Master (goniometer included) plus the top bar
1.5 %. Twice the analysis rate would still fit; a Worker FFT is a follow-up
only if it ever does not.


## Waveforms

The Clip tab's waveform and the drum-row strip (plan 12 Task 4): one
component, `app/src/ui/vis/WaveformView.svelte`, over the pure
`ui/vis/waveMath.ts` and `audio/fineSamples.ts`.

```
 zoom (frames per device px)   source                       memory
 ───────────────────────────   ──────                       ──────
 whole file .. 256             peaks pyramid (plan 9)       ~1/128 of the floats, always there
   (coarsest level with ≥ 1 pair per px: peaksLevel)
 < 256 .. 1/16 per CSS px      the sample's floats,         ONE sample cached, ≤ 256 MiB
   (16 px per sample)          decoded on demand
```

**Two sources.** At 256 frames per pixel and above, a column is the min/max
of every peaks pair it touches at the coarsest level that still has a pair
per pixel. The pairs are quantised outward (plan 9), so a column is never
smaller than the truth and at most one pair plus 1/127 bigger. Below 256 the
peaks have nothing finer, so the view asks `fineSamples` for the sample's
floats: the kept original bytes (`p.sampleFiles`) decoded with the engine's
own `AudioContext` (`decodeFine`), so the frames are exactly the ones the
engine plays (its rate, its 2 ms tail fade). `decodeFine` keeps the
AudioBuffer's own channel arrays (the fade is applied in place); the only
big synchronous copy is the encoded bytes handed to `decodeAudioData`
(which detaches them). Measured in Chromium on an 11-minute 48 kHz stereo
WAV (127 MB, 63.4 M floats): the decode takes 130–150 ms, off the main
thread; the longest main-thread stall is 21–24 ms (the bytes copy), against
44 ms for the copying `decodeBytes` path. A column is then the exact
min/max of the frames it touches (`waveMath.test.ts`, *columns equal
brute-force min/max at every zoom*). A stem never needs its samples until
someone zooms into it.

**The budget.** `fineSamples` keeps one sample, up to 256 MiB of floats
(about 11 minutes of 48 kHz stereo); a new sample evicts the old before it
decodes. The budget equals the engine's per-sample cap
(`MAX_SAMPLE_FLOATS`, 64 Mi floats = 256 MiB: ~23 min mono / ~11 min stereo
at 48 kHz), so every sample the engine accepted fits and zooms to single
samples; a longer file is refused at the drop ("too long"). Decodes run one at a time (`decodeAudioData` cannot be cancelled):
a request made meanwhile waits, the overtaken result is dropped when it
lands, and only the newest waiting request starts, so two samples' floats
never sit in memory together. Views hold their sample (`retain`) while
mounted; the last to let go releases the floats (abandoning a running
decode), and a project load clears them (`blankState`). A file whose
floats would not fit (estimated from `sampleMeta` before decoding) is never
decoded: the zoom stops at 256 frames per pixel with the note
"Sample-level zoom: files up to 256 MB". With today's equal limits that
only guards an estimate that is off (`sampleMeta` vs the decoded length);
it is pinned by unit tests (`fineSamples.test.ts`, `waveMath.test.ts`
*zoom is clamped…*), not e2e, since no loadable file reaches it. A failed decode is remembered and
the view keeps the peaks at the same limit; one that failed because an
audio restart closed the context is not (the next engine decodes it). While the floats decode, level
0 is drawn stretched, never a blank.

**Axis.** A view shows "view frames": file frames at the rate the peaks
were made at. The drum strip maps them to the file as is; the Clip tab
shows clip time (0..len at the tempo) through the clip's offset (rounded to
a frame as the engine's `stage_source` does), repeating at the file length
when it loops (`clipMap`, `seamFrames`) and showing nothing past a
one-shot's end. Floats decoded at another rate (an audio restart keeps the
old peaks) are scaled by their own length.

**Drawing.** The waveform is rendered into an offscreen buffer only when
the zoom, the scroll, the data or the size changes; the visible canvas is
that buffer plus the caller's overlay (the Clip tab's beat grid, dashed loop
seams and the gain × fades envelope from `clipEnvelope`, which is the
engine's `user_fades` × the clip gain), recomposited only when the overlay
changes. Stereo is two lanes. Below 1 frame per device pixel a line runs
through the samples, with dots from 6 px per sample; a sample at |x| ≥ 1 is
marked red at its lane's edges (columns mark it only when drawn from floats:
the peaks clamp at full scale). The work runs in a want-0 frame-loop
consumer on the view's element, registered only while there is work
(`waveDriver.ts`): a change (zoom, scroll, size, data, overlay) or playback
starting adds it, and it removes itself once nothing is dirty and playback
is off. A stopped, idle waveform costs no frames, on screen or not.

**Why the playhead is a DOM element.** Moving a 1 px element with a CSS
transform is a compositor job; redrawing even the cached buffer would cost a
full-canvas copy 60 times a second while playing. The consumer reads the
heard position each frame and writes the transform only when the pixel
changes, so playback never redraws a canvas. The Clip tab shows it while the
song playhead is inside the clip (Song mode).

**Controls.** ⌘/Ctrl-wheel or a trackpad pinch zooms at the pointer (the
frame under it stays put; Chrome and Firefox send a pinch as a ctrl-wheel,
Safari's `gesture*` events are handled too); the wheel or Shift-wheel
scrolls (while the whole file is shown a vertical wheel passes to the
panel and a horizontal swipe is swallowed, so it never navigates back); a
double-click fits. Focused (Tab), + / − zoom at the centre, ← / → scroll
an eighth of the view (Shift: a whole view) and 0 fits (`keyView`). The
view is a `slider` for assistive tech: `aria-valuenow` is the scroll
position in %, `aria-valuetext` the visible span and where it starts.
The readout shows the visible span ("1.25 s", "2.6 ms · 125 samples").
Test hooks: the canvas's `data-draw` (`none`, `peaks`, `floats`, `line`,
`dots`) and `data-fpp`; `cliptab-wave`, `row-wave-<r>`, `row-wave-btn-<r>`,
`wave-zoom-text`.

**Drum rows.** "≈" on a row with a sample opens a 72 px strip under the
rows (file time, the whole file at first; one row at a time; not saved).
It has no start/end/fade markers and no playhead: drum rows have no such
engine params yet (spec §4's per-row start offset is unbuilt) and drum
voices report no position, so the strip draws nothing it cannot back. Both
are follow-ups, as are drag handles for clip fades and trim (the Clip tab's
waveform is display only; editing stays in the fields).

## Shape previews

The ADSR and LFO panels show their shape above the knobs
(`ShapePreview.svelte`, a 120 × 40 px SVG plus a one-line label).

- **Static, not animated:** no frame loop. It redraws (at most once per
  animation frame: changes mark it dirty, one rAF draws) when a param changes
  (a knob, undo, a patch load), when the tempo changes (a synced LFO), and
  when an automation lane on one of its continuous params moves: like a
  Knob it registers those params with the autoBus (`ui/autoBus.ts`) and
  draws the lane's heard value while the lane applies, so it always shows
  what the knob rings show. The bus calls back only when a value changed;
  the preview writes the SVG `d` attributes and the label directly.
- **Label:** the ADSR's is compact ("5ms·200ms·70%·300ms", "+250ms·…"),
  clamped to `ADSR_LABEL_CHARS` = 24 with "…" (and by CSS to 120 px); the
  full text ("5 ms · 200 ms · 70% · 300 ms") is its title and what screen
  readers read (the SVG is `aria-hidden`).
- **ADSR curve** (`shapes.ts`, mirroring `adsr.rs`): Delay flat at 0 →
  Attack linear 0 → 1 → Decay exponential to `sustain` with
  `tau = decay / ln 100` → a plateau → Release exponential to 0 with
  `tau = release / ln 100`. The plateau stands for the gate held one more
  decay time (the decay has then settled to within 1e-4, the engine's
  sustain capture) and is drawn at a fixed 20 % of the width. Drawn at full
  velocity; with Velocity > 0 a dashed curve shows the softest note
  (`× (1 − vel_amt)`).
- **Time axis** (my call): each timed segment (delay, attack, decay,
  release) is `∝ √t` wide, normalised so they share the 80 % beside the
  plateau, and linear in time inside. A 1 ms attack beside a 4 s release
  is still > 1 px; the label gives the real times ("5 ms · 200 ms · 70% ·
  300 ms", "+250 ms · …" with a delay).
- **LFO curve:** one cycle of the wave × `depth` (bipolar), from the
  engine's phase 0 (synced: phase 0 is on the division's grid line). The 1
  ms output slew is not drawn. Label: "2.00 Hz · 500 ms", or "1/4 · 500
  ms" when synced (the period at the current tempo).
- **Checked against the engine:** `engine/tests/shapes.rs`
  `shape_fixtures_are_current` renders the real `Adsr` (three param sets,
  one with a delay) and `Lfo` (four waves, free and synced) and samples 64
  points of each into `engine/tests/fixtures/shapes.json`
  (`UPDATE_FIXTURES=1` writes, otherwise it compares within 1e-5);
  `shapes.test.ts` requires every point within 0.01 of the drawn polyline,
  mapped through the preview's time axis. Fixture conventions (the
  sample-time origin, the LFO's sampled phases) are in the test's header.
- Test hooks: `shape-adsr` / `shape-lfo` (the SVG; the ADSR's carries each
  segment's width in px as `data-delay` … `data-release`),
  `shape-label-adsr` / `shape-label-lfo` (the visible, compact text).

## Voice LEDs

The Instrument tab header shows "Voices" and N LEDs after the patch
dropdown (`VoiceLeds.svelte`): N is the first MIDI In's `voices` (lowest
module idx, the one whose gates the engine reports; 1 in Mono). A rack
without a MIDI In shows none and registers no consumer.

- **Data:** visSab voices (want bit 4) at `(slot × 16 + k) × 2`: the level
  (the voice's peak across the rack's Outs, with meter ballistics; 0 below
  −60 dB) and the gate (see *Data path*).
- **Drawing:** a 30 Hz frame-loop consumer on the LED row (paused off
  screen like any consumer), present only while there is something to show
  (`idleDriver.ts`): when the transport is stopped and every LED has been
  dark (no level, no gate) for 0.5 s it leaves the loop. Brightness =
  `voiceLedLevel` (−48..0 dB →
  0..1, clamped; quantised to 1/64 so an invisible change writes nothing),
  written as a CSS variable; an amber ring while the gate is held
  (`data-gate`). Only changed values touch the DOM.
- Accessible name "3 of 8 voices playing" (lit LEDs), rewritten only when
  that number changes; `aria-live="off"`.
- Test hooks: `voice-leds`, `voice-led-<k>` with `data-on` (lit) and
  `data-gate`.

## Idle visuals and waking

With the app open, stopped and silent, the frame loop pauses entirely: the
visuals that only show sound — the voice LEDs (`idleDriver.ts`) and the
analyser bus (the top-bar spectrum, the stereo view, the panel) — leave it
after 0.5 s of stopped quiet, like the waveform view leaves when it has
nothing to draw (`waveDriver.ts`). The mixer meters (`MixerView`) and the
Scope (`ScopeView`, once its ring heads have stood still 0.25 s and the
"idle" tag is drawn) are idle drivers too. `visWake.ts` brings the idle ones back: `setPlaying(true)`
on Play (App follows `project.playing`), and `wake()` on a played note-on
(`noteInput.ts`, QWERTY and MIDI, also while stopped), on any edit
(`project.version`: a patch that drones without a note) and on a new engine.
A release tail after Stop keeps them awake only while it is audible: the
analyser counts a frame as heard when the window's peak |x| reaches 1e-3
(-60 dBFS, mono for the bars, L or R for the stereo view) and the bars must
sit at or under -60 dB; on leaving it resets the bars and draws once, so the
frozen picture is empty. With the spec-6 mix's reverb and delay returns
that pauses the loop a few seconds after Stop (serial e2e limit 8 s); an app
that has played nothing pauses within a second.
Pinned by `idleDriver.test.ts` and `analyserBus.test.ts` (`the mini
spectrum leaves the loop…`: with the bus and the LEDs on one real frame
loop, no rAF is pending once both are idle).

## Tests and e2e hooks

`window.__daw.vis` (`ui/vis/visHooks.ts`, read-only):

- `stats()` — `{ busyMs, wallMs, frames }` over the last 5 s (the budget);
- `drawn()`, `running()` — frames drawn since start, whether the rAF is
  scheduled (a pause shows at once; the 5 s window only drains);
- `want()` — the want mask in visSab;
- `scopeHead(track, idx)` — the mirrored head of that Scope (−1: none);
- `analyser.peakHz()` — the centre of the panel's loudest band (null:
  silence); `analyser.tap()` — the strip tap given to the engine (−1 off).

Test ids: `scope-<idx>`, `analyser`, `analyser-strip-<channel>` (a strip's
∿), `analyser-spectrum`, `analyser-readout`, `topbar-spectrum`,
`cliptab-wave`, `row-wave-<r>`, `row-wave-btn-<r>`, `wave-zoom-text`,
`shape-adsr`, `shape-lfo`, `voice-leds`, `voice-led-<k>`.
`tests/e2e/visuals.spec.ts` drives each visual in the app (a triggered saw
on a Scope, the ninth Scope greyed, the analyser finding A5 and naming it on
hover, the strip toggle and back without an edit, the top bar pausing when
the page hides, the Clip-tab zoom to dots, fit and keys and the playhead,
the drum-row strip, the ADSR preview following Release, three of eight LEDs
for a chord); `serial.spec.ts` has Scope edits while playing (no dropouts)
and the budget.

## Adding a visual

1. **A consumer.** `frameLoop().add({ want, el, hz, frame })` from the
   component's `onMount` (return the remover). Pass the element that is the
   visual (`el`), so it stops off screen; `hz: 30` for analysis. In `frame`
   write the canvas / DOM directly and only when something changed; never
   allocate per frame. If it only shows sound, idle it when stopped and
   quiet (`idleDriver.ts`, woken by `visWake()`); if it only shows edits,
   register only while dirty (`waveDriver.ts`).
2. **A want bit**, if it needs new audio data: the next bit in `VIS_WANT`
   (`visLayout.ts`), and a branch in `copyVis` (`visCopy.ts`) that copies
   only while the bit is set. With the bit clear the worklet must write
   nothing.
3. **A ring**, if the data is a stream: a region in `visLayout.ts` (the one
   place offsets are computed; bump the layout test), a power-of-two size,
   an `i32` head in the header published with `Atomics.store` after the
   data, and readers that load the head first and stay `VIS_GUARD` away from
   the oldest end. Engine data comes from a preallocated block (`vis.rs`,
   `engine_vis`) or the FX pool, written on the audio thread without
   allocating and without touching the signal (a test that the sound is
   bit-identical with it on).
4. **Measure it:** add or extend a phase in `serial.spec.ts`
   (*visuals stay under 5% of the main thread*) and update the table above.
