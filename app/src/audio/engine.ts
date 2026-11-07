// Main-thread handle to the audio engine running inside the 'daw-engine'
// AudioWorklet (worklet.ts). Commands go through a lock-free SharedArrayBuffer
// ring (never postMessage, which allocates and is not real-time safe), fronted
// by a main-thread backlog (sendQueue.ts) so a full ring never drops one;
// telemetry comes back through a second SAB that the worklet overwrites every
// block. Only sample uploads use the MessagePort. See docs/architecture/audio-path.md.
//
// Failure model: if the engine traps (or the worklet dies) after start, the
// worklet goes silent for good and `onError` fires once; `failure` keeps the
// message. Every loadSample() promise always settles (pending ones resolve
// with HostErr.ENGINE_STOPPED).

import workletUrl from './worklet.ts?worker&url';
import { CommandRing, createRingBuffer } from './ring';
import { CommandSender } from './sendQueue';
import { Err, HostErr, MIX_CHANNELS, MIX_METER_STRIDE, TELEMETRY, TELEMETRY_LEN } from './protocol';
import type { ProcessorOptions } from './worklet';

type WorkletMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'engine-error'; message: string }
  | { type: 'sample-result'; id: number; code: number }
  | { type: 'sample-loaded'; id: number; code: number };

/** Chrome's AudioContext.playbackStats (not in lib.dom; feature-detected). */
type WithPlaybackStats = { playbackStats?: { underrunEvents?: number } };

export class AudioEngine {
  readonly sampleRate: number;
  /**
   * Fires when a load that first resolved with Err.DEFERRED finishes: code is
   * Err.OK (now playable) or the failure (an Err / HostErr code).
   */
  onSampleLoaded?: (id: number, code: number) => void;
  /** Fires once if the engine stops working after start (see `failure`). */
  onError?: (message: string) => void;
  /**
   * Commands have been waiting > 2 s for room in the ring, or the backlog is
   * huge (message), or it drained again (null). Nothing is dropped.
   */
  onCommandStall?: (message: string | null) => void;

  private readonly ring: CommandRing;
  private readonly sender: CommandSender;
  private readonly tele: Float64Array;
  private readonly meterView: Float32Array;
  /** FIFO of loadSample resolvers per sample id (the worklet replies in order). */
  private readonly waiting = new Map<number, ((code: number) => void)[]>();
  private readonly ready: Promise<void>;
  private started = false;
  private failMsg: string | null = null;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    ringSab: SharedArrayBuffer,
    telemetrySab: SharedArrayBuffer,
    metersSab: SharedArrayBuffer,
  ) {
    this.sampleRate = ctx.sampleRate;
    this.ring = new CommandRing(ringSab);
    const ring = this.ring;
    this.sender = new CommandSender({
      push: (op, a, b, c, d) => ring.push(op, a, b, c, d),
      schedule: (fn) => void setTimeout(fn, 0),
      now: () => performance.now(),
      onStall: (m) => {
        if (m !== null) console.warn(m);
        this.onCommandStall?.(m);
      },
    });
    this.tele = new Float64Array(telemetrySab, 0, TELEMETRY_LEN);
    this.meterView = new Float32Array(metersSab, 0, MIX_CHANNELS * MIX_METER_STRIDE);
    this.ready = new Promise((resolve, reject) => {
      // Before 'ready' a failure rejects start(); after it, it's reported via onError.
      const failed = (message: string) =>
        this.started ? this.fail(message) : reject(new Error(`daw-engine worklet: ${message}`));
      node.onprocessorerror = () => failed('the audio worklet crashed');
      node.port.onmessage = (ev: MessageEvent<WorkletMessage>) => {
        const m = ev.data;
        switch (m.type) {
          case 'ready':
            this.started = true;
            return resolve();
          case 'error':
            return failed(m.message);
          case 'engine-error':
            return this.fail(m.message);
          case 'sample-result': {
            const q = this.waiting.get(m.id);
            const done = q?.shift();
            if (q && q.length === 0) this.waiting.delete(m.id);
            return done?.(m.code);
          }
          case 'sample-loaded':
            return this.onSampleLoaded?.(m.id, m.code);
        }
      };
    });
  }

  /** Message of the failure that stopped the engine, or null while healthy. */
  get failure(): string | null {
    return this.failMsg;
  }

  private fail(message: string): void {
    if (this.failMsg !== null) return;
    this.failMsg = message;
    this.sender.clear(); // nothing drains the ring any more
    console.error(`daw-engine stopped: ${message}`);
    // Nothing will answer pending uploads any more (or answers are moot).
    for (const q of this.waiting.values()) for (const done of q) done(HostErr.ENGINE_STOPPED);
    this.waiting.clear();
    this.onError?.(message);
  }

  /** Must be called from a user gesture (it creates/resumes the AudioContext). */
  static async start(): Promise<AudioEngine> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    // Resume synchronously inside the gesture, before any await.
    const resumed = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
    try {
      const [wasmBytes] = await Promise.all([
        fetch('/engine.wasm').then((r) => {
          if (!r.ok) throw new Error(`engine.wasm: HTTP ${r.status}`);
          return r.arrayBuffer();
        }),
        ctx.audioWorklet.addModule(workletUrl),
      ]);
      const ringSab = createRingBuffer();
      const telemetrySab = new SharedArrayBuffer(TELEMETRY_LEN * 8);
      const metersSab = new SharedArrayBuffer(MIX_CHANNELS * MIX_METER_STRIDE * 4);
      const processorOptions: ProcessorOptions = {
        wasmBytes,
        ringSab,
        telemetrySab,
        metersSab,
        sampleRate: ctx.sampleRate,
      };
      const node = new AudioWorkletNode(ctx, 'daw-engine', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
      });
      const engine = new AudioEngine(ctx, node, ringSab, telemetrySab, metersSab);
      await engine.ready;
      node.connect(ctx.destination);
      await resumed;
      return engine;
    } catch (e) {
      void ctx.close();
      throw e;
    }
  }

  /**
   * Queue a command for the audio thread, after every earlier one. Never
   * drops: if the ring is full it waits in the backlog (see sendQueue.ts).
   * False only once the engine has failed (the command goes nowhere).
   */
  send(op: number, a = 0, b = 0, c = 0, d = 0): boolean {
    if (this.failMsg !== null) return false;
    this.sender.send(op, a, b, c, d);
    return true;
  }

  /** Commands waiting for room in the ring (0 normally). */
  get commandBacklog(): number {
    return this.sender.backlog;
  }

  /**
   * Upload a sample (1 or 2 equal-length channels) into engine slot `id`.
   * Resolves with the worklet's first result code. Err.DEFERRED means the
   * transport was playing and the arena needed to grow: the worklet retries
   * once stopped and then calls `onSampleLoaded(id, code)`. Always settles.
   */
  loadSample(id: number, channels: Float32Array[]): Promise<number> {
    if (this.failMsg !== null) return Promise.resolve(HostErr.ENGINE_STOPPED);
    // The worklet matches replies by id, so only post ids it can echo as u32.
    if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) return Promise.resolve(Err.BAD_INDEX);
    const frames = channels[0]?.length ?? 0;
    if (channels.length < 1 || channels.length > 2 || channels.some((ch) => ch.length !== frames)) {
      return Promise.resolve(Err.BAD_VALUE);
    }
    // Planar [L..., R...], transferred (not copied) to the worklet.
    const data = new Float32Array(frames * channels.length);
    channels.forEach((ch, i) => data.set(ch, i * frames));
    return new Promise((resolve) => {
      let q = this.waiting.get(id);
      if (!q) this.waiting.set(id, (q = []));
      q.push(resolve);
      this.node.port.postMessage(
        { type: 'sample', id, frames, channels: channels.length, data },
        [data.buffer],
      );
    });
  }

  /** The engine's AudioContext, for decodeAudioData (resamples to engine rate). */
  get context(): BaseAudioContext {
    return this.ctx;
  }

  /** Live view of the telemetry slots (see TELEMETRY); updated every block. */
  telemetry(): Float64Array {
    return this.tele;
  }

  /**
   * Live view of the mixer meters, updated every block: per channel
   * (MIX_METER_STRIDE floats) peak L, peak R (linear), gain reduction (dB).
   */
  meters(): Float32Array {
    return this.meterView;
  }

  /** Output underruns if the browser reports them, else worklet overrun count. */
  dropouts(): number {
    const u = (this.ctx as AudioContext & WithPlaybackStats).playbackStats?.underrunEvents;
    return typeof u === 'number' ? u : this.tele[TELEMETRY.dropouts];
  }

  /** Context time <-> performance time pair; zeros when unavailable (see audioClock). */
  outputTimestamp(): { contextTime: number; performanceTime: number } {
    const c = this.ctx as AudioContext;
    if (typeof c.getOutputTimestamp !== 'function') return { contextTime: 0, performanceTime: 0 };
    const t = c.getOutputTimestamp();
    return { contextTime: t.contextTime ?? 0, performanceTime: t.performanceTime ?? 0 };
  }

  fallbackTimes(): { currentTime: number; baseLatency: number; outputLatency: number } {
    return {
      currentTime: this.ctx.currentTime,
      baseLatency: this.ctx.baseLatency || 0,
      outputLatency: this.ctx.outputLatency || 0,
    };
  }

  latencyMs(): number {
    return (this.ctx.baseLatency + (this.ctx.outputLatency || 0)) * 1000;
  }
}
