# Audio path

How sound gets from a click in the UI to the speakers, and the rules that keep
it glitch-free. Code: `app/src/audio/{engine,sendQueue,worklet,ring,protocol}.ts`,
`engine/src/ffi.rs`.

```
 main thread                         audio thread (AudioWorkletGlobalScope)
 ───────────                         ──────────────────────────────────────
 UI ── AudioEngine.send(op,a..d)
    └─ FIFO backlog if full ───────► CommandRing (SAB) ──┐
                                                         ▼  process(), every 128 frames
                                     DawEngineProcessor: 1 drain ring -> engine_command
                                                         2 engine_process(128)
                                                         3 copy out L/R -> outputs[0]  ──► speakers
                                                         4 copy telemetry -> telemetry SAB,
                                                           meters (ballistics) -> meters SAB
                                                         4b visuals -> vis SAB, only what the
                                                           want mask asks (visCopy.ts)
                                                         5/6 cpu load, overrun count
 AudioEngine.telemetry() ◄──────────── telemetry SAB (Float64Array(9), overwritten each block)
 AudioEngine.meters()    ◄──────────── meters SAB (MIX_CHANNELS × 3 f32, overwritten each block)
 frameLoop ── want mask ─────────────► vis SAB header[0]
 AudioEngine.vis()       ◄──────────── vis SAB (rings with published heads, voices; ~400 KB)

 AudioEngine.loadSample() ── port.postMessage({type:'sample'}) ──► arena alloc + copy
                          ◄── {type:'sample-result', id, code} ──┘
                          ◄── {type:'sample-loaded', id, code}  (only after a DEFERRED)
 AudioEngine.onError(msg) ◄── {type:'engine-error', message}       (once, fatal)
```

`AudioEngine.start()` (from the "Click to start audio" gesture) creates the
`AudioContext`, fetches `/engine.wasm`, loads the worklet module, and passes the
wasm bytes plus the SABs (command ring, telemetry, meters, visuals) as
`processorOptions`. The worklet compiles and
instantiates the module synchronously in its constructor (0 imports) and posts
`ready`. Cross-origin isolation (COOP/COEP headers in `vite.config.ts`) is what
makes `SharedArrayBuffer` available at all.

## Real-time rules (and why)

| Rule | Why |
| --- | --- |
| `process()` never allocates | GC pauses on the audio thread are dropouts. Views, scratch (`Float64Array(5)`) and the pending queue are created in the constructor. |
| `process()` never blocks or waits on the UI | The block deadline is ~2.7 ms at 48 kHz. Commands arrive via a lock-free SPSC ring (`Atomics` load/store only), never `postMessage`. |
| `process()` never throws; the engine never panics | A thrown exception or WASM trap kills the node: silence until reload. Every command is validated in Rust and bad ones return an `Err` code (also recorded in telemetry slot 7); `process()` and the port handler are additionally wrapped in try/catch (see *When the engine fails*). |
| WASM memory grows only while stopped | `memory.grow` is slow and detaches every typed-array view. The engine reserves a 128 MB sample arena up front and refuses to grow while playing (`Err.DEFERRED`). The worklet rebuilds its views whenever `memory.buffer` changes identity. |
| Telemetry is a plain overwrite, never a queue | The UI just samples the latest values; nothing can back up. |

## When the command ring is full

The ring holds `RING_CAPACITY - 1` = 1023 records and the worklet drains all of
it every block, so it only fills when one task sends more than that (a bulk
note edit, undoing a big take) or when the audio thread is not running.
A dropped command would leave the engine out of step with the UI state for
good, so `AudioEngine.send` never drops (`app/src/audio/sendQueue.ts`):

- While nothing is waiting, a command goes straight into the ring.
- Otherwise it joins a main-thread FIFO *backlog*. New commands queue behind a
  non-empty backlog even if the ring has room, so order is always preserved.
- A `setTimeout(0)` flush moves backlog records into the ring as the worklet
  frees space and re-arms until the backlog is empty (a 3000-command burst
  takes about three blocks).
- If the backlog has existed for more than 2 s, or exceeds 65536 records,
  `onCommandStall(message)` fires once (App shows it as the red error banner);
  `onCommandStall(null)` when it drains again clears it. Still nothing is
  dropped.
- Once the engine has failed, `send` returns false and the backlog is cleared
  (nothing will ever drain it).

`AudioEngine.commandBacklog` is the number of waiting records (0 normally).

CPU (slot 3) is time spent in `process()` divided by wall time, published once a
second; overruns (slot 4) count blocks that took longer than `128/sampleRate`,
except the one block that runs the deferred-sample retry at stop time (a
one-off copy, maybe a `memory.grow`, not a steady-state overrun).
`AudioEngine.dropouts()` prefers the browser's own
`ctx.playbackStats.underrunEvents` when Chrome exposes it.

## How samples travel

1. Main thread packs channels planar `[L…, R…]` into one `Float32Array` and
   transfers (not copies) it to the worklet port.
2. The port handler (audio thread, but between blocks, so allocation is fine)
   calls `engine_sample_alloc(id, frames, channels)`, then creates a view at the
   returned pointer *after* the call (alloc may have grown memory), copies, and
   calls `engine_sample_ready`. It replies `sample-result` with the code;
   `loadSample()` resolves with it.
3. If the code is `Err.DEFERRED` (playing and the arena is full), the request is
   parked in a fixed 32-entry queue. When it is full the oldest entry is
   evicted and answered with `sample-loaded` / `HostErr.QUEUE_FULL`. On the
   first block after `playing` goes to 0 the worklet retries each entry once
   and posts `sample-loaded` with the result; `AudioEngine` calls
   `onSampleLoaded(id, code)` and the step grid either attaches the sample or
   shows a red banner. This one-off work happens in `process()` only at stop
   time, never during steady-state playback.
4. Growing the arena is fallible: if `memory.grow` hits the 4 GB maximum the
   engine returns `Err.OUT_OF_MEMORY` instead of aborting (an abort is a WASM
   trap that would kill the engine).
5. **The budget.** Sample memory is capped at 1 GiB
   (`MAX_ARENA_FLOATS = 256 Mi` floats, `lib.rs`, mirrored in
   `protocol.ts`): the floats the arena handed out since the last
   `RESET_ALL`, live samples and replaced ones together (the arena is a bump
   allocator, so a replaced sample leaks until the next load or reset). A
   request that would pass it is `Err.OUT_OF_MEMORY` **whether playing or
   not** (waiting for Stop cannot help, so it is never `DEFERRED`), and a
   grown chunk is cut so it never extends past the budget. Requests are
   placed **first fit** (the first chunk whose free tail holds them), so the
   tail a large file skipped (a 40 MB file leaves 24 MB of a 64 MB chunk)
   takes a later, smaller one: without it, physical memory could reach about
   twice the budget with 33–64 MB files. Tails smaller than every later
   request still go unused, so physical memory can exceed the handed-out
   total by up to one tail per chunk. One file stays
   capped at `MAX_SAMPLE_FLOATS` (256 MB). `SampleArena::allocated()`
   reports the total; tests use `SampleArena::with_budget` so they never
   touch 1 GiB. The UI checks the same budget after decode and before
   upload (plan 9 Task 4), so the engine's refusal is a backstop.

Every `sample` message gets exactly one `sample-result` that echoes its
original `id` (replies are matched by id), even for malformed requests
(`Err.BAD_VALUE`). `AudioEngine.loadSample()` rejects non-u32 ids itself
(`Err.BAD_INDEX`) without posting, and every promise it returns settles. Error
codes are turned into plain words for the user by `loadErrorText()` in
`samples.ts`.

### Sample generations and the engine reset

Each `SamplePool::set` stamps the slot with a new pool-wide generation, and
`clear()` (engine reset) moves it on as well. Voices (drum rows, the rack's
Sample Player, audio clips) capture the generation at trigger and keep reading only while
`playable(id)` reports the same one; otherwise they hold their last output
and fade it out over 2 ms. This is what makes an arena reset safe: the next
upload may land on the very same arena slice, but never in the same
generation.

`OP_RESET_ALL` (44, stopped only, else `BAD_VALUE`) is what a project load
sends first (`STOP` + `RESET_ALL` in one batch is fine). In the command phase
it removes every track without a fade, frees every FX-pool slot, resets the
mixer, transport and metronome, empties the sample pool and rewinds the
arena to its first chunk (`SampleArena::reset`: grown chunks are freed, the
first is **not** re-zeroed, which would be a 128 MB memset on the audio
thread; every allocation is fully written before its sample is marked
ready), and clears `TELEMETRY_LAST_ERROR` (an error from the previous
session never shows in the new one). Commands after it in the same batch
land on the blank engine. The
audible result is a 5 ms linear fade of the last output sample (L/R), added
to the blank engine's silent output, so a ringing reverb tail ends without a
step. It allocates nothing (`no_alloc.rs` `reset_all_does_not_allocate`).

On the host side a successful `RESET_ALL` also drops the worklet's deferred
uploads (step 3 above): they belong to the session that just ended, so each
is answered with `sample-loaded` / `HostErr.RESET`, which the UI settles
silently.

Every `RESET_ALL` is also confirmed with `{type:'reset-done', code}`
(`AudioEngine.resetAll()`, `app/src/audio/resetAck.ts`): the reset travels
through the ring, but sample uploads go by `postMessage` and are handled
between render quanta, so an upload sent right after the reset could land
before it, load into the old session and be wiped. A project load awaits the
ack (2 s timeout) before uploading any sample (see projects.md).

Command results otherwise never come back to the UI (the ring is one-way).
The one exception is a `RACK_ADD_MODULE` refused with `OUT_OF_MEMORY` (FX pool
full): the worklet posts `{type:'rack-add-refused', slot, idx, kind}` (a rare
error path, so the allocation is acceptable) and the UI rolls back its
optimistic add (`rollbackRefusedAdd`).

## When the engine fails

A caught exception from any engine call (most likely a WASM trap, after which
the instance may be half-updated) is fatal and handled once, in
`worklet.ts` `fail()`:

1. The instance is dropped and never called again; `process()` keeps the node
   alive but outputs silence (the failing block is zeroed too).
2. Deferred uploads are answered with `HostErr.ENGINE_STOPPED`, and so is every
   later `sample` message.
3. `{type:'engine-error'}` is posted. `AudioEngine` records it in `failure`,
   resolves all pending `loadSample()` promises with `ENGINE_STOPPED`, and
   fires `onError`. A crash of the worklet itself (`onprocessorerror`) after
   start takes the same path. The top bar shows **Audio engine stopped —
   reload**.

Before `ready`, failures reject `AudioEngine.start()` instead (the start
overlay shows them). The worklet accepts `{type:'test-fail'}` to make the next
`process()` throw, so e2e tests can exercise this path.

## Restarting the engine (audio settings)

The ⚙ readout at the right of the top bar opens **Settings**
(`app/src/ui/Settings.svelte`): the latency hint (`interactive`, the default;
`balanced`; `playback`; or a custom buffer in ms, passed as seconds), a 4 Hz
readout of the sample rate, `baseLatency`, `outputLatency` and their total, and
the Bluetooth hint (no buffer setting removes the 100–300 ms a wireless output
adds; it turns orange above 40 ms, as does the ⚙ readout). The hint is saved in
`localStorage` (`daw.latencyHint`) and used by the next start
(`StartOverlay` -> `AudioEngine.start({ latencyHint })`).

A context's latency hint is fixed when it is created, so **Apply** builds a new
`AudioContext`, worklet and engine and puts the project back onto it from
memory — no reload, no disk read. `restartAudio` (`app/src/audio/restart.ts`)
sequences it; App (`applyAudioSettings`) owns the wiring:

The old engine keeps running until the new one is fully up, so any failure
leaves the user exactly where they were:

1. Runs under the project session's one-operation guard
   (`session.exclusive`; never during an Open / Save / restore) and not during a
   WAV export. The autosave is flushed first. Then `p.loading` and
   `p.restarting` are set for the whole restart (`markBusy` / `markIdle`,
   `app/src/state/idle.ts`): the "Restarting audio…" overlay blocks edits;
   shortcuts, undo and sample imports respect it (an import overlapping a
   restart ends with "Audio restarted — drop … again"; a default-kit import
   waits for the idle signal and retries).
2. Stop the transport through App's Stop path (the recorder closes held notes
   at the heard tick) and release held keys.
3. `AudioEngine.start({ latencyHint })` **while the old engine still runs**
   (two contexts for a moment), within 8 s (`RESTART_TIMEOUT_MS`, which
   covers only the start: a vanished device can leave `resume()` pending
   forever). Its command-stall watch is
   attached at once (`prepare`), before any replayed command.
4. `replayInto` (`app/src/project/load.ts`), within its own timeout,
   `replayTimeoutMs(usedBytes)` = 8 s + 1 s per 25 MB of the used samples'
   original bytes (audio clips make large used samples normal; decoding one
   is not a hang): the samples the project **uses** (`usedSampleIds`:
   `serialize(p).samples`, plus the ids deferred loads still wait for,
   `pendingSampleIds`) are decoded from their in-memory original bytes with
   the **new** context and uploaded at the ids they already have, then the
   commands of `projectCommands(serialize(p))` (the one replay-order
   builder) are sent. No `RESET_ALL`: the engine is new. `p` itself is not
   touched, so track ids, selection, name, folder handle, the "● unsaved"
   mark, `version` and the undo history all carry over.
5. Success: `unwireEngine` (the old engine's transport watch and stall watch),
   then `wireEngine(new engine)` in the same task as the last replayed
   command: `engine` (a prop: TopBar, Browser, song area, editors and the
   mixer's meter consumer read it each time), the visual frame loop
   re-attached to the new engine's vis SAB (`frameLoop().attach`; the old
   one is detached by `unwireEngine`), a new `AudioClock` (telemetry
   history is per engine), `onCommand` / `onRackAddRefused`, deferred sample
   loads moved over and settled from the upload results (`rebindSampleLoads`),
   and the transport watch. TopBar re-attaches `onError` and the Browser drops
   its preview player. Then the old engine closes (`AudioEngine.close()`:
   pending uploads and reset waits settle with `ENGINE_STOPPED`, later
   `send()`s go nowhere and mark no edit) and `p.audioRestarts` is bumped.
   Then, once idle and **outside any timeout**, `replayInto`'s `rest()`
   uploads the unused `p.sampleFiles` entries (only an undo can bring one
   back: snapshots name samples by id), so a large unused file never holds up
   or times out the switch. Its warnings join the same "Audio restarted —
   skipped or changed" banner (`RestartResult.later`). An unused sample
   refused for memory is dropped silently: only a later undo could need it,
   and that clip or row then plays nothing ("sample not loaded"). `rest`
   stops as soon as the session is replaced (`p.generation`: the ids are
   someone else's then) or another restart starts. Until it lands, an undo
   that brings such a sample back plays nothing for it; when it lands, the
   commands binding it to what uses it now (`bindingCommands`: the
   `projectCommands` that differ with and without that id) are sent again,
   as no edit (`p.baselining`). They are compared as units: an audio clip's
   `AUDIO_CLIP_SOURCE` only stages, so its whole SOURCE, GAIN, SET triple is
   re-sent (plan 9). The restart also starts the sample budget over:
   `p.arenaFloats` becomes what it re-uploaded, plus each late upload. Late warnings are dropped if the session
   was replaced or another restart finished meanwhile.
6. Failure (the hint refused, a start or replay timeout, a replay error): the
   new engine is closed (a start that answers after the timeout is closed when
   it does), the old one was never unwired, and an inline banner says
   "Couldn't apply Playback: <reason>; kept previous settings". The hint is
   not saved.

A failed or closed engine refuses `PLAY` (`send` returns false), and `play`
then leaves the transport stopped.

What needs no re-wiring: everything created once per session — the note input,
Web MIDI, the QWERTY shortcuts, the recorder (still armed if it was), the
history and the project session — holds App's `live` forwarding view
(`send`, `context`, `loadSample`, ...) and `liveClock`, which always reach
the current engine and clock. The library's and the project folder's handles
(IndexedDB, `FileSystemDirectoryHandle`) and the autosave's OPFS lock never
belonged to the `AudioContext`. Pinned by the e2e test
`restart keeps project and handles` (`tests/e2e/settings.spec.ts`).

## Engine timing rules (engine/src/drums.rs)

- **Retrigger:** a new hit on a still-sounding row starts at full level (its
  attack is the sample's own); only the old voice fades out, over 2 ms.
- **Swing latching:** a swing change is stored and only takes effect when the
  playhead crosses a step-pair boundary (every 2 steps), or at once while
  stopped. An odd step always sits inside its pair, so a swing change can
  never make it fire twice or be skipped. Swing is per pattern; only the
  pattern that is playing latches, and copying into it keeps its latched
  swing until the next pair boundary. In Song mode each clip has its own
  latch (two overlapping clips of one pattern cannot move each other's
  steps); a clip latches at once at its start, when edited into a new
  mapping (start / offset / pattern) or where it has not played yet, and on
  any jump of song time (Play, seek, loop wrap, a loop set behind the
  playhead, mode switch). Only lengthening or shortening a clip under the
  playhead keeps its latch (R12), and its synth notes keep sounding.
- **Patterns:** a drum track has 16 patterns (steps of every row, step count,
  swing); rows (sample, gain, pan, mute) and voices are per track. Switching
  the current pattern needs no release: hits ring out, and the new pattern's
  steps are placed from the same playhead (`ticks mod newPeriod`).
- **Tempo:** changes apply from the next block; the playhead position is
  integrated, never recomputed, so it never jumps. Within one tempo it is
  `anchor + frames / samplesPerTick` from the last jump or tempo change, so
  it does not drift (tick 11520 at 120 bpm / 48 kHz is exactly frame 288000).
- **Loop wrap (Song mode):** `Engine::process` renders a block in pieces split
  at the loop end (`Transport::split`); each piece gets its own song-time
  window and synth `Ctx`, so metronome, steps, notes and synced LFOs follow
  song time across the wrap. The wrap is the first frame whose tick reaches
  the loop end and that frame plays exactly the loop start, so a pass is
  `ceil(loopTicks * samplesPerTick)` frames and nothing double-fires or
  skips. See `docs/architecture/sequencer.md` (Song timeline).

## One engine block (plan 5: the mixer)

`Engine::process` (engine/src/engine.rs) renders every track into its *own*
stereo buffer, piece by piece across a Song-mode loop wrap (drum rows used as
sidechain keys also render into key buffers), then runs the mixer **once per
block** (engine/src/mixer/mod.rs: strips → sends → Reverb/Delay returns →
master → lookahead limiter), then adds the metronome after the limiter
(delayed by the limiter's 1.5 ms / 72-sample lookahead so it stays on the
beat; never compressed), then a NaN-safe ±1 clamp as a backstop only.
Consequences worth knowing:

- **Output latency +1.5 ms.** Everything leaves the engine 72 samples (48 kHz)
  after it was rendered. Sequencing is unchanged. The worklet reads
  `engine_latency(e)` once and publishes `TELEMETRY_FRAME = currentFrame +
  n + latency`, so heard time (playheads, recording) maps to what is actually
  output. Engine unit tests that pin exact sample positions build the engine
  with `Engine::with_lookahead(sr, 0.0)`.
- **Click headroom.** The click is added after the limiter, then a soft-clip
  stage keeps the sum under the ceiling: bit-transparent up to 0.9 × ceiling,
  a tanh knee above it that never reaches the ceiling. The ±1 clamp is only a
  NaN-safe backstop.
- **Jumps never reset effects.** Stop, seek and loop wraps release notes only;
  reverb/delay tails, compressor and limiter state carry on.
- **Meters:** `engine_meters(e)` points at `[MIX_CHANNELS × (peakL, peakR,
  gr_db)]` f32s refreshed every block (track/return peaks post-fader; master =
  the final output, gr = the limiter's). Telemetry `PEAK_L/R` is the final
  output too.
- **Visuals (plan 12), step 4b.** `engine_vis(e)` points at the engine's
  visual block (`engine/src/vis.rs`): the strip tap (`VIS_TAP` (55) picks one
  track strip or return; the mixer writes its post-fader stereo) and
  per-voice activity of every synth track. After the meters the worklet calls
  `copyVis` (`app/src/audio/visCopy.ts`): it reads the want mask the UI's
  frame loop writes into the vis SAB and copies only those parts (the output
  into the master ring, the tap into the tap ring, voice levels with meter
  ballistics), each ring's head published with `Atomics.store` after its
  data. With nothing on screen the mask is 0 and step 4b is one
  `Atomics.load`. See `docs/architecture/visuals.md`.
- **Mixer params** are a catalog (`engine/mixer_catalog.json`, golden-tested
  like the rack catalog): `MIX_SET` (41) validates against it, `MIX_SET_KEY`
  (42) sets a sidechain key, `MIX_RESET` (43) restores a channel's defaults.
- **Automation (plan 10).** The block is split into its loop-wrap pieces
  once. The automation lanes are evaluated over those pieces (one value per
  32-frame sub-block), then the pieces render. The racks apply rack lanes at
  their sub-block boundaries. While a mixer lane applies, the mixer runs in
  32-frame chunks. See `docs/architecture/automation.md`.

## Adding an opcode

1. Add `OP_*` to `engine/src/protocol.rs` and handle it (validated!) in
   `Engine::command`.
2. Mirror it in `Op` in `app/src/audio/protocol.ts`.
3. `npm test`: `protocol.test.ts` parses the Rust file and fails on any name or
   value mismatch.
4. Send it with `engine.send(Op.YOUR_OP, a, b, c, d)` (args are f64). Nothing in
   the worklet changes: it forwards every ring record to `engine_command`.
