# WAV export

Project ▸ **Export WAV…** renders the song offline, faster than real time,
with the same engine the AudioWorklet runs, and saves a 24-bit PCM WAV.

## What is rendered
- **Song mode** from tick 0 to the **song end** (the end of the last clip,
  pattern or audio clip alike, `songEndTicks`) at the project tempo, plus a **2 s tail** for reverb, delay
  and releases.
- **The metronome is always off** in the export, whatever the top bar shows,
  and the **loop is off** (the song plays straight through). Everything else
  is the project as the live engine plays it: the mixer, sidechains and the
  master limiter included.
- Stereo, **24-bit PCM, at the project sample rate** (the AudioContext's,
  which is also the rate the samples were decoded at).
- The limiter's lookahead (`engine_latency()`, 72 frames at 48 kHz) is
  rendered and dropped, so the song's first beat is the file's frame 0 and the
  file is exactly `round(song seconds × rate) + 2 × rate` frames long.
- The file name is `<project name> <YYYY-MM-DD>.wav` (local date; characters
  unsafe in file names become `_`).

## Pipeline (`app/src/export/`)
1. **`exportFlow.ts`** (the menu click): an empty song (no clips) is an error
   banner at once, before any save dialog, so no zero-length file is ever
   created. Then `showSaveFilePicker` opens, still inside the click (it needs
   the user gesture, which a long render would outlast). Closing it exports
   nothing. Without the picker (non-Chromium) the export runs and a banner
   offers a **download link** instead.
2. **`exportSong.ts`** (main thread): `serialize(p)` snapshots the project
   (edits made while it renders do not change the file); every sample the
   project uses is decoded from `p.sampleFiles` (the original bytes) with the
   project AudioContext's `decodeAudioData` through `decodeBytes`, the same
   path a live load takes, so the engine gets the same data (Workers have no
   `decodeAudioData`). Audio clips' samples are among them (`serialize`
   lists every sample a row, Sample Player or audio clip uses), decoded the
   same way; the clips themselves come from the same builder (Audio tracks:
   `ADD_AUDIO_TRACK`, then per clip SOURCE, GAIN, SET), so the export plays
   them exactly as the live engine does, chase and declick fades included.
   The command list is **`projectCommands`** (the one
   replay-order builder, `project/commands.ts`) for the project with the
   metronome off, Song mode and the loop off, followed by `SEEK 0` and `PLAY`
   (`exportCommands`). Sample ids map to themselves: `p.sampleFiles` is keyed
   by engine id.
3. A **dedicated Worker** (`renderWorker.ts` → `render.ts`
   `renderService`) receives the engine.wasm bytes, the commands and the
   planar sample data, all **transferred**. It instantiates engine.wasm (no
   imports) on a fresh `engine_new(rate)`, loads the samples
   (`engine_sample_alloc` / copy / `engine_sample_ready`), sends the commands
   (a refused command is ignored, as the live worklet does), and renders in
   **1024-frame blocks** (`MAX_BLOCK`), each as eight 128-frame
   `engine_process` calls like the live worklet's (see below). Each block is
   encoded to 24-bit straight away (`wav.ts Wav24Writer`): the **header is
   written first**, final from the start since the frame count is known, and
   every ~1 s byte chunk (288 KB at 48 kHz) is a **part** handed on as soon as
   it fills. It posts progress at its start, every 0.25 s of audio and at the
   end; each part as a **transferred `ArrayBuffer`**; then `done`. In all
   exceptional cases the Worker is terminated (see Errors), including a 10 s
   stall watchdog.
4. **Streaming to the file** (`exportSong` → `exportFlow`). The page writes
   the parts in order, one at a time, and **acks** each to the Worker once
   its write resolved. **Back-pressure:** the Worker posts at most
   `MAX_PARTS_IN_FLIGHT` (4) un-acked parts, then parks its render (between
   blocks, which does not change the output) until an ack arrives — never
   after the file's last part, so `done` follows it at once; so
   however much faster the render is than the disk, the page holds at most
   four parts (~1.2 MB) and the Worker one more being encoded. Neither side
   ever holds the song as floats or the whole file.
   - **Picker:** the parts go straight into the picked file's
     `createWritable()` stream; `close()` commits the file when the last part
     is written.
   - **Download fallback** (no picker): the page collects the parts into one
     Blob (`audio/wav`) for the link — unavoidable, a download needs the
     whole file. The bytes are the same as `encodeWav24` of the whole render.
5. Progress and **Cancel** are a banner in the bottom panel
   (`banners.exporting`). Cancel aborts the `AbortSignal`, which
   **terminates the Worker**; no write starts after that. On cancel or
   failure the writable is **aborted** (Chromium writes to a swap file until
   `close`, so nothing half-written is ever presented as the finished WAV),
   then the picked file, still empty, is removed again (best effort). One
   export at a time.

**The stall watchdog** restarts on every Worker message (progress and parts
alike) and only runs while no part is waiting to be written: a Worker parked
on back-pressure is waiting for the disk, not stuck. A write that never
resolves therefore never fails the export by itself; Cancel still ends it.

The live `AudioContext`, worklet and engine are never touched (only the
context's `decodeAudioData` is used), so playback and editing carry on during
an export. Speed: the 4-track test fixture renders at ~56× real time in Node
(Apple Silicon).

## Errors (inline banners, never alert/confirm)
| Case | Message |
|---|---|
| No clips | Nothing to export — the song has no clips. Add clips to the timeline in Song mode first. |
| A sample's bytes no longer decode | Export failed — sample "x.wav" could not be decoded |
| The Worker's engine refuses a sample | Export failed — sample N could not be loaded (engine code …) |
| The Worker crashed | Export failed — the render worker crashed (…) |
| A Worker message could not be deserialized (`messageerror`) | Export failed — a message from the render worker could not be read |
| No message from the Worker for 10 s while no write is pending (`STALL_MS`; it posts at its start, every 0.25 s of audio and every part) | Export failed — the render stopped responding |
| Writing a part to the picked file failed (disk full, permission revoked…) | Export failed — the file could not be written (…) |
| Cancel | "Export cancelled" (status-line hint) |

A sample that failed to load into the session never reaches `p.sampleFiles`,
so the project (and the export) has no reference to it: that row or Sample
Player is silent live and in the file alike.

## Determinism and the native reference
The render is deterministic: the same wasm, the same command list and the
same `engine_process` call sizes give the same samples. The Worker renders
1024-frame blocks (progress granularity) **as 128-frame calls**, the
AudioWorklet quantum the live worklet always uses (`render.ts
ENGINE_QUANTUM`), so it is on the live engine's exact schedule.

Call size used to matter for a replay: `ADD_*_TRACK` treated the slot as a
removal and held its mixer strip (old settings, no `MIX_SET` applied) for the
2 ms removal fade plus a rack sub-block, counted per whole call, so a
project's mute / fader / pan / sends / inserts only applied from the end of
the engine's first call — 128 frames live, 1024 in a 1024-frame call — and
then glided from the defaults. A muted track with a hit on frame 0 was
audible at the start of every load and export. Fixed in the engine
(`Mixer::slot_added`): a track added to an **empty** slot whose strip has no
hold or tail left (nothing sounds through it) gets no hold, and its strip
stays *fresh* until its first block: gains, gate and inserts jump to the
settings sent before it instead of ramping. Replacing a sounding track (or
one still fading after removal) keeps the hold, unchanged live. The fixture
now renders bit-identically in 128- and 1024-frame calls
(`export_render_is_call_size_independent`); the hold for replaced tracks is
still counted per call, which is why the export keeps the live 128.

Pinned by a shared fixture, `engine/tests/fixtures/export_render.txt` (the
export command list of the project test fixture, frozen, with generated
sample data) and its golden hash `export_render.hash` (32-bit FNV-1a over the
left then right f32 samples):
- `engine/tests/export_render.rs` renders it **natively** through the same C
  ABI and the same 128-frame call schedule and asserts the hash;
- `app/src/export/render.test.ts` (`render matches native`) renders it
  through **engine.wasm** in Node with `renderSong` (the Worker's own block
  loop) and asserts the same hash; the streamed parts are pinned to equal
  `encodeWav24` of that render, byte for byte. `npm test` builds engine.wasm first.

**Audio clips** (plan 9) are pinned the same way by a second fixture,
`engine/tests/fixtures/export_audio.txt` and its own hash
`export_audio.hash`: the export command list of `buildAudioFixture`
(`project/testFixture.ts`: two Audio tracks at 120 BPM — a loop clip of a
generated 0.5 s mono sample at −3 dB, a missing-sample clip, and a clip of
a generated 1 s stereo sample trimmed by 0.25 s with +3 dB, a 240-tick fade-in
and a 480-tick fade-out, on a strip with a compressor keyed from the first
track). Native: `export_audio_render_matches_golden`; wasm: `audio render
matches native`. The fixture is checked against what `exportCommands`
builds today (`export_audio.txt is the export command list of the audio
test project, frozen`); after an intended change regenerate it with
`UPDATE_FIXTURE=1 npx vitest run app/src/export/render.test.ts`, then the
hash with `UPDATE_GOLDEN=1 cargo test -p daw-engine --test export_render`.
`export_render.hash` did not change with plan 9: projects without audio
render exactly as before.

**Automation** (plan 10) has a third fixture, `export_auto.txt` /
`export_auto.hash`: the export command list of `buildAutoFixture`
(`project/testFixture.ts`: a drum track on a generated 0.25 s sample and a
synth on the Deep Bass patch, 3 bars at 128 BPM in Song mode, with the lanes
of `addAutomationFixture` — a send-A build-up on the drums, a fader ride
with a hold and a drop on the synth, a filter-cutoff sweep on its rack, and
a Master-row limiter-ceiling lane). Native:
`export_auto_render_matches_golden`; wasm: `automation render matches
native`, which also checks that the same job without the lane commands
renders differently (the lanes are heard). Regenerated like the audio
fixture. The export needs no automation code of its own: the lanes come
from `projectCommands`. `export_render.hash` and `export_audio.hash` did not
change with plan 10.

Native and wasm are **bit-identical** only with the same math: on wasm the
transcendental functions (`sin`, `powf`, `exp2`…) come from the pure-Rust
`libm` inside compiler-builtins, natively from the platform libm, which
differs in the last bit for some inputs (measured: 3% of the fixture's
samples off by ≤ 2e-7 without the fix). The native test therefore defines
those C symbols itself, forwarding to the `libm` crate (a test-only
dev-dependency pinned to the toolchain's version), so the engine code linked
into that test computes exactly what engine.wasm computes. After an intended
engine change: `UPDATE_GOLDEN=1 cargo test -p daw-engine --test
export_render`. If only the wasm side disagrees after a toolchain upgrade,
bump the `libm` pin (see the test's module doc).
