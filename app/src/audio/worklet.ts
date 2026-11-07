// AudioWorkletProcessor hosting the Rust engine (engine/src/ffi.rs).
//
// Runs on the real-time audio thread. Rules (see docs/architecture/audio-path.md):
//   - process() never allocates, blocks or throws. Every buffer/view it touches
//     is created in the constructor or rebuilt only when WASM memory grows
//     (which the engine allows only while the transport is stopped).
//   - Port message handlers also run on this thread but *between* render
//     quanta, so they may allocate (sample uploads happen there).
//   - Must stay DOM-free: imports only protocol.ts and ring.ts.
//   - Any exception from an engine call (a WASM trap, which may leave the
//     instance half-updated) is fatal: the instance is dropped, output goes
//     silent, and {type:'engine-error'} tells the UI to ask for a reload.
//     Every 'sample' request still gets exactly one reply, with its original id.

import { CommandRing } from './ring';
import { Err, HostErr, MAX_BLOCK, RECORD_WORDS, TELEMETRY, TELEMETRY_LEN } from './protocol';

// --- AudioWorkletGlobalScope (not in lib.dom) -------------------------------
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(
  name: string,
  ctor: new (options: { processorOptions: ProcessorOptions }) => AudioWorkletProcessor,
): void;

/** What AudioEngine.start() passes as `processorOptions`. */
export interface ProcessorOptions {
  wasmBytes: ArrayBuffer;
  ringSab: SharedArrayBuffer;
  telemetrySab: SharedArrayBuffer;
  sampleRate: number;
}

/** The engine's C ABI. Pointers are i32 byte offsets into `memory`. */
interface EngineExports {
  memory: WebAssembly.Memory;
  engine_new(sampleRate: number): number;
  engine_out_left(e: number): number;
  engine_out_right(e: number): number;
  engine_process(e: number, frames: number): void;
  engine_command(e: number, op: number, a: number, b: number, c: number, d: number): number;
  engine_sample_alloc(e: number, id: number, frames: number, channels: number): number;
  engine_sample_ready(e: number, id: number): number;
  engine_telemetry(e: number): number;
}

/** Fixed capacity of the deferred-sample queue (oldest dropped when full). */
const PENDING_CAP = 32;
/** Telemetry slots the engine owns; 3 (cpu) and 4 (dropouts) are filled here. */
const ENGINE_SLOTS = [
  TELEMETRY.blocks,
  TELEMETRY.playing,
  TELEMETRY.ticks,
  TELEMETRY.peakL,
  TELEMETRY.peakR,
  TELEMETRY.lastError,
] as const;

// Resolved once so process() does no feature detection per block.
const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

const isU32 = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

class DawEngineProcessor extends AudioWorkletProcessor {
  private ex: EngineExports | null = null;
  private h = 0; // engine handle (*mut Host)
  private ring: CommandRing;
  private readonly cmd = new Float64Array(RECORD_WORDS); // reused pop() scratch
  private readonly tele: Float64Array; // shared with the main thread

  // Views into WASM memory; rebuilt when memory.buffer changes identity.
  private buf: ArrayBuffer | null = null;
  private outL = new Float32Array(0);
  private outR = new Float32Array(0);
  private engTele = new Float64Array(0);

  // CPU / overrun accounting (milliseconds).
  private readonly budgetMs: number;
  private busyMs = 0;
  private windowStart = now();
  private overruns = 0;

  // Deferred sample uploads: fixed-capacity FIFO, preallocated.
  private readonly pId = new Uint32Array(PENDING_CAP);
  private readonly pFrames = new Uint32Array(PENDING_CAP);
  private readonly pChannels = new Uint32Array(PENDING_CAP);
  private readonly pData: (Float32Array | null)[] = new Array(PENDING_CAP).fill(null);
  private pHead = 0;
  private pLen = 0;

  /** Test hook ({type:'test-fail'}): the next process() throws, exercising the fatal path. */
  private failNext = false;

  constructor(options: { processorOptions: ProcessorOptions }) {
    super(options);
    const o = options.processorOptions;
    this.ring = new CommandRing(o.ringSab);
    this.tele = new Float64Array(o.telemetrySab, 0, TELEMETRY_LEN);
    const sr = o.sampleRate || sampleRate;
    this.budgetMs = (128 / sr) * 1000;
    this.port.onmessage = (ev) => this.onMessage(ev.data);
    try {
      // Synchronous compile is allowed off the main thread; the module has 0 imports.
      const inst = new WebAssembly.Instance(new WebAssembly.Module(o.wasmBytes), {});
      this.ex = inst.exports as unknown as EngineExports;
      this.h = this.ex.engine_new(sr);
      this.refreshViews();
      this.port.postMessage({ type: 'ready' });
    } catch (e) {
      this.ex = null;
      this.port.postMessage({ type: 'error', message: String(e) });
    }
  }

  /**
   * Fatal: an engine call threw (most likely a WASM trap). The instance may be
   * corrupted, so it is never called again; process() outputs silence from now
   * on. Deferred loads are answered so nothing waits forever. One-off path, so
   * allocating/posting here is acceptable.
   */
  private fail(e: unknown): void {
    if (this.ex === null) return;
    this.ex = null;
    console.error('daw-engine: engine failed', e);
    this.tele[TELEMETRY.playing] = 0;
    this.tele[TELEMETRY.peakL] = 0;
    this.tele[TELEMETRY.peakR] = 0;
    this.port.postMessage({ type: 'engine-error', message: String(e) });
    while (this.pLen > 0) {
      const s = this.pHead;
      this.pData[s] = null;
      this.pHead = (s + 1) % PENDING_CAP;
      this.pLen--;
      this.port.postMessage({ type: 'sample-loaded', id: this.pId[s], code: HostErr.ENGINE_STOPPED });
    }
  }

  /** Rebuild typed-array views after WASM memory growth (rare; stopped only). */
  private refreshViews(): void {
    const ex = this.ex!;
    const b = ex.memory.buffer;
    if (b === this.buf) return;
    this.buf = b;
    this.outL = new Float32Array(b, ex.engine_out_left(this.h) >>> 0, MAX_BLOCK);
    this.outR = new Float32Array(b, ex.engine_out_right(this.h) >>> 0, MAX_BLOCK);
    this.engTele = new Float64Array(b, ex.engine_telemetry(this.h) >>> 0, TELEMETRY_LEN);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const t0 = now();
    const out = outputs[0];
    const ex = this.ex;
    if (ex === null || out === undefined || out.length === 0) return true;
    let retried = false;
    try {
      if (this.failNext) throw new Error('test-fail: simulated engine failure');

      // 1. Drain UI commands. Invalid ones return an error code, never trap.
      const c = this.cmd;
      while (this.ring.pop(c)) ex.engine_command(this.h, c[0], c[1], c[2], c[3], c[4]);

      // 2. Render.
      const l = out[0];
      const n = l.length < MAX_BLOCK ? l.length : MAX_BLOCK;
      ex.engine_process(this.h, n);

      // 3. Copy out (views only change if memory grew; a no-op compare otherwise).
      if (ex.memory.buffer !== this.buf) this.refreshViews();
      const srcL = this.outL;
      const srcR = this.outR;
      for (let i = 0; i < n; i++) l[i] = srcL[i];
      const r = out.length > 1 ? out[1] : null;
      if (r !== null) for (let i = 0; i < n; i++) r[i] = srcR[i];

      // 4. Publish engine telemetry.
      const et = this.engTele;
      const tele = this.tele;
      for (let k = 0; k < ENGINE_SLOTS.length; k++) tele[ENGINE_SLOTS[k]] = et[ENGINE_SLOTS[k]];
      // The context frame at which the published ticks apply (start of next block).
      tele[TELEMETRY.frame] = currentFrame + n;

      // Deferred samples retry on the first block once stopped (playing 1 -> 0).
      if (this.pLen > 0 && et[TELEMETRY.playing] === 0) {
        retried = true;
        this.retryPending();
      }
    } catch (e) {
      // Should be unreachable. Never let an exception kill the node: drop the
      // engine, output silence (this block may be half-written), tell the UI.
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      this.fail(e);
    }

    // 5./6. CPU load (once per second) and overruns. The block that ran the
    // deferred retry (copies, maybe memory.grow) is a one-off at stop time, not
    // a steady-state overrun: it is not counted as a dropout.
    const t1 = now();
    const dt = t1 - t0;
    this.busyMs += dt;
    if (dt > this.budgetMs && !retried) this.tele[TELEMETRY.dropouts] = ++this.overruns;
    const elapsed = t1 - this.windowStart;
    if (elapsed >= 1000) {
      this.tele[TELEMETRY.cpu] = this.busyMs / elapsed;
      this.busyMs = 0;
      this.windowStart = t1;
    }
    return true;
  }

  // --- Samples (port handler; may allocate) --------------------------------

  /**
   * Always replies exactly once to a 'sample' message, echoing the ORIGINAL
   * id (AudioEngine matches replies by id; a substituted id would leave its
   * promise pending forever).
   */
  private onMessage(msg: unknown): void {
    const m = msg as { type?: string; id?: unknown; frames?: unknown; channels?: unknown; data?: unknown };
    if (m?.type === 'test-fail') {
      this.failNext = true;
      return;
    }
    if (m?.type !== 'sample') return;
    let code: number;
    if (this.ex === null) {
      code = HostErr.ENGINE_STOPPED;
    } else if (
      !isU32(m.id) ||
      !isU32(m.frames) ||
      !isU32(m.channels) ||
      !(m.data instanceof Float32Array) ||
      m.data.length < m.frames * m.channels
    ) {
      code = Err.BAD_VALUE;
    } else {
      try {
        code = this.loadSample(m.id, m.frames, m.channels, m.data);
        if (code === Err.DEFERRED) this.enqueue(m.id, m.frames, m.channels, m.data);
      } catch (e) {
        this.fail(e);
        code = HostErr.ENGINE_STOPPED;
      }
    }
    this.port.postMessage({ type: 'sample-result', id: m.id, code });
  }

  /** Alloc in the arena, copy planar data in, mark ready. Returns an Err code; throws on a trap. */
  private loadSample(id: number, frames: number, channels: number, data: Float32Array): number {
    const ex = this.ex;
    if (ex === null) return HostErr.ENGINE_STOPPED;
    const ptr = ex.engine_sample_alloc(this.h, id, frames, channels) >>> 0;
    // alloc may have grown memory: refresh first (engTele too), and create the
    // copy view only now, against the current buffer.
    this.refreshViews();
    if (ptr === 0) return this.engTele[TELEMETRY.lastError];
    const len = frames * channels;
    new Float32Array(ex.memory.buffer, ptr, len).set(data.length === len ? data : data.subarray(0, len));
    return ex.engine_sample_ready(this.h, id);
  }

  private enqueue(id: number, frames: number, channels: number, data: Float32Array): void {
    if (this.pLen === PENDING_CAP) {
      // Evict the oldest and tell the UI, so its row doesn't wait forever.
      const old = this.pHead;
      this.pData[old] = null;
      this.pHead = (old + 1) % PENDING_CAP;
      this.pLen--;
      this.port.postMessage({ type: 'sample-loaded', id: this.pId[old], code: HostErr.QUEUE_FULL });
    }
    const slot = (this.pHead + this.pLen) % PENDING_CAP;
    this.pId[slot] = id;
    this.pFrames[slot] = frames;
    this.pChannels[slot] = channels;
    this.pData[slot] = data;
    this.pLen++;
  }

  /**
   * Called from process() only on the first stopped block with work queued, so
   * this one-off (it may grow memory and posts messages) never happens during
   * steady-state playback. Each entry gets exactly one retry; the outcome is
   * reported as {type:'sample-loaded', id, code}. A trap during a retry is
   * fatal (fail() answers the remaining entries) but still answers this one.
   */
  private retryPending(): void {
    while (this.pLen > 0 && this.ex !== null) {
      const s = this.pHead;
      const data = this.pData[s]!;
      this.pData[s] = null;
      this.pHead = (s + 1) % PENDING_CAP;
      this.pLen--;
      let code: number;
      try {
        code = this.loadSample(this.pId[s], this.pFrames[s], this.pChannels[s], data);
      } catch (e) {
        code = HostErr.ENGINE_STOPPED;
        this.port.postMessage({ type: 'sample-loaded', id: this.pId[s], code });
        this.fail(e);
        return;
      }
      this.port.postMessage({ type: 'sample-loaded', id: this.pId[s], code });
    }
  }
}

registerProcessor('daw-engine', DawEngineProcessor);
