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
                                                         4 copy telemetry -> telemetry SAB
                                                         5/6 cpu load, overrun count
 AudioEngine.telemetry() ◄──────────── telemetry SAB (Float64Array(9), overwritten each block)

 AudioEngine.loadSample() ── port.postMessage({type:'sample'}) ──► arena alloc + copy
                          ◄── {type:'sample-result', id, code} ──┘
                          ◄── {type:'sample-loaded', id, code}  (only after a DEFERRED)
 AudioEngine.onError(msg) ◄── {type:'engine-error', message}       (once, fatal)
```

`AudioEngine.start()` (from the "Click to start audio" gesture) creates the
`AudioContext`, fetches `/engine.wasm`, loads the worklet module, and passes the
wasm bytes plus both SABs as `processorOptions`. The worklet compiles and
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

Every `sample` message gets exactly one `sample-result` that echoes its
original `id` (replies are matched by id), even for malformed requests
(`Err.BAD_VALUE`). `AudioEngine.loadSample()` rejects non-u32 ids itself
(`Err.BAD_INDEX`) without posting, and every promise it returns settles. Error
codes are turned into plain words for the user by `loadErrorText()` in
`samples.ts`.

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
  steps); a clip latches at once at its start, when edited, and on any jump
  of song time (Play, seek, loop wrap, mode switch).
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

## Adding an opcode

1. Add `OP_*` to `engine/src/protocol.rs` and handle it (validated!) in
   `Engine::command`.
2. Mirror it in `Op` in `app/src/audio/protocol.ts`.
3. `npm test`: `protocol.test.ts` parses the Rust file and fails on any name or
   value mismatch.
4. Send it with `engine.send(Op.YOUR_OP, a, b, c, d)` (args are f64). Nothing in
   the worklet changes: it forwards every ring record to `engine_command`.
