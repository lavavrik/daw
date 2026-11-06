# Audio path

How sound gets from a click in the UI to the speakers, and the rules that keep
it glitch-free. Code: `app/src/audio/{engine,worklet,ring,protocol}.ts`,
`engine/src/ffi.rs`.

```
 main thread                         audio thread (AudioWorkletGlobalScope)
 ───────────                         ──────────────────────────────────────
 UI ── AudioEngine.send(op,a..d) ──► CommandRing (SAB) ──┐
                                                         ▼  process(), every 128 frames
                                     DawEngineProcessor: 1 drain ring -> engine_command
                                                         2 engine_process(128)
                                                         3 copy out L/R -> outputs[0]  ──► speakers
                                                         4 copy telemetry -> telemetry SAB
                                                         5/6 cpu load, overrun count
 AudioEngine.telemetry() ◄──────────── telemetry SAB (Float64Array(8), overwritten each block)

 AudioEngine.loadSample() ── port.postMessage({type:'sample'}) ──► arena alloc + copy
                          ◄── {type:'sample-result', id, code} ──┘
                          ◄── {type:'sample-loaded', id, code}  (only after a DEFERRED)
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
| `process()` never throws; the engine never panics | A thrown exception or WASM trap kills the node: silence until reload. Every command is validated in Rust and bad ones return an `Err` code (also recorded in telemetry slot 7); `process()` is additionally wrapped in try/catch. |
| WASM memory grows only while stopped | `memory.grow` is slow and detaches every typed-array view. The engine reserves a 128 MB sample arena up front and refuses to grow while playing (`Err.DEFERRED`). The worklet rebuilds its views whenever `memory.buffer` changes identity. |
| Telemetry is a plain overwrite, never a queue | The UI just samples the latest values; nothing can back up. |

CPU (slot 3) is time spent in `process()` divided by wall time, published once a
second; overruns (slot 4) count blocks that took longer than `128/sampleRate`.
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
   parked in a fixed 32-entry queue (oldest dropped with a warning when full).
   On the first block after `playing` goes to 0 the worklet retries each entry
   once and posts `sample-loaded`; `AudioEngine` then calls `onSampleLoaded(id)`
   (or warns if the retry failed). This one-off work happens in `process()` only
   at stop time, never during steady-state playback.

## Adding an opcode

1. Add `OP_*` to `engine/src/protocol.rs` and handle it (validated!) in
   `Engine::command`.
2. Mirror it in `Op` in `app/src/audio/protocol.ts`.
3. `npm test`: `protocol.test.ts` parses the Rust file and fails on any name or
   value mismatch.
4. Send it with `engine.send(Op.YOUR_OP, a, b, c, d)` (args are f64). Nothing in
   the worklet changes: it forwards every ring record to `engine_command`.
