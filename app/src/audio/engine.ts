// Main-thread handle to the audio engine running inside the 'daw-engine'
// AudioWorklet (worklet.ts). Commands go through a lock-free SharedArrayBuffer
// ring (never postMessage, which allocates and is not real-time safe);
// telemetry comes back through a second SAB that the worklet overwrites every
// block. Only sample uploads use the MessagePort. See docs/architecture/audio-path.md.

import workletUrl from './worklet.ts?worker&url';
import { CommandRing, createRingBuffer } from './ring';
import { Err, TELEMETRY, TELEMETRY_LEN } from './protocol';
import type { ProcessorOptions } from './worklet';

type WorkletMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'sample-result'; id: number; code: number }
  | { type: 'sample-loaded'; id: number; code: number };

/** Chrome's AudioContext.playbackStats (not in lib.dom; feature-detected). */
type WithPlaybackStats = { playbackStats?: { underrunEvents?: number } };

export class AudioEngine {
  readonly sampleRate: number;
  /** Fires when a load that first resolved with Err.DEFERRED completes. */
  onSampleLoaded?: (id: number) => void;

  private readonly ring: CommandRing;
  private readonly tele: Float64Array;
  /** FIFO of loadSample resolvers per sample id (the worklet replies in order). */
  private readonly waiting = new Map<number, ((code: number) => void)[]>();
  private readonly ready: Promise<void>;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    ringSab: SharedArrayBuffer,
    telemetrySab: SharedArrayBuffer,
  ) {
    this.sampleRate = ctx.sampleRate;
    this.ring = new CommandRing(ringSab);
    this.tele = new Float64Array(telemetrySab, 0, TELEMETRY_LEN);
    this.ready = new Promise((resolve, reject) => {
      node.onprocessorerror = () => reject(new Error('daw-engine worklet failed'));
      node.port.onmessage = (ev: MessageEvent<WorkletMessage>) => {
        const m = ev.data;
        switch (m.type) {
          case 'ready':
            return resolve();
          case 'error':
            return reject(new Error(`daw-engine worklet: ${m.message}`));
          case 'sample-result': {
            const q = this.waiting.get(m.id);
            const done = q?.shift();
            if (q && q.length === 0) this.waiting.delete(m.id);
            return done?.(m.code);
          }
          case 'sample-loaded':
            if (m.code === Err.OK) this.onSampleLoaded?.(m.id);
            else console.warn(`deferred sample ${m.id} failed with code ${m.code}`);
            return;
        }
      };
    });
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
      const processorOptions: ProcessorOptions = {
        wasmBytes,
        ringSab,
        telemetrySab,
        sampleRate: ctx.sampleRate,
      };
      const node = new AudioWorkletNode(ctx, 'daw-engine', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
      });
      const engine = new AudioEngine(ctx, node, ringSab, telemetrySab);
      await engine.ready;
      node.connect(ctx.destination);
      await resumed;
      return engine;
    } catch (e) {
      void ctx.close();
      throw e;
    }
  }

  /** Queue a command for the next audio block. False (and a warning) if the ring is full. */
  send(op: number, a = 0, b = 0, c = 0, d = 0): boolean {
    const ok = this.ring.push(op, a, b, c, d);
    if (!ok) console.warn(`command ring full, dropped op ${op}`);
    return ok;
  }

  /**
   * Upload a sample (1 or 2 equal-length channels) into engine slot `id`.
   * Resolves with the worklet's first result code. Err.DEFERRED means the
   * transport was playing and the arena needed to grow: the worklet retries
   * once stopped and then calls `onSampleLoaded(id)`.
   */
  loadSample(id: number, channels: Float32Array[]): Promise<number> {
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

  /** Live view of the telemetry slots (see TELEMETRY); updated every block. */
  telemetry(): Float64Array {
    return this.tele;
  }

  /** Output underruns if the browser reports them, else worklet overrun count. */
  dropouts(): number {
    const u = (this.ctx as AudioContext & WithPlaybackStats).playbackStats?.underrunEvents;
    return typeof u === 'number' ? u : this.tele[TELEMETRY.dropouts];
  }

  latencyMs(): number {
    return (this.ctx.baseLatency + (this.ctx.outputLatency || 0)) * 1000;
  }
}
