// Sample-level waveform data (plan 12 Task 4; docs/architecture/visuals.md
// *Waveforms*): a sample's floats, decoded on demand from its kept original
// bytes (Project.sampleFiles) when a waveform view zooms in below
// FINE_FPP (256) frames per pixel, where the peaks pyramid has nothing finer.
//
// - ONE sample is kept, up to FINE_BUDGET_BYTES (256 MiB) of floats: only
//   one waveform is zoomed at a time, and a stem's floats are large (ten
//   minutes of 48 kHz stereo is ~220 MB). Loading another sample drops the
//   kept one at once.
// - Decodes run ONE AT A TIME. decodeAudioData cannot be cancelled, so a
//   request made while another decode runs waits for it; the overtaken
//   result is dropped when it lands and only the newest waiting request
//   starts. So two samples' floats never sit in memory together.
// - release(key) and clear() (a project load: project/load.ts blankState)
//   drop the floats and abandon a running decode: its result is dropped on
//   landing. Views hold their key with retain(key) and let go on unmount;
//   the last one to let go releases it.
// - A file whose estimated floats (frames × channels, from sampleMeta at the
//   decode rate) exceed the budget is refused without decoding ('too-big');
//   the view then stops zooming at 256 frames per pixel with a note. One that
//   turns out bigger once decoded is dropped the same way.
// - A failed decode is remembered ('failed', never retried on every redraw);
//   the view keeps the peaks. A decode that failed because the context was
//   closed under it (an audio restart: ContextClosedError) is NOT
//   remembered: the next engine can decode it. load() never throws.
// - decodeFine decodes with the engine's AudioContext, so the frames are
//   exactly the ones the engine plays (same rate, same 2 ms tail fade as
//   samples.ts decodeBytes), and keeps the AudioBuffer's own channel arrays
//   (no copy of the floats: decodeBytes copies because the engine upload
//   transfers its arrays; these stay here). Keys should include the rate.
//
// Not reactive: views subscribe() and redraw on a change.
import { fadeOutTail } from './samples';
import type { SampleFile } from '../state/project.svelte';

/** The most float bytes kept (one sample). */
export const FINE_BUDGET_BYTES = 256 * 1024 * 1024;

export type FineStatus = 'none' | 'decoding' | 'ready' | 'too-big' | 'failed';

/** The context went away under a decode (audio restart): not the file's fault. */
export class ContextClosedError extends Error {
  constructor() {
    super('the audio context was closed');
    this.name = 'ContextClosedError';
  }
}

/** What decodeFine needs from an AudioContext (tests pass a fake). */
export type FineDecoder = Pick<BaseAudioContext, 'decodeAudioData' | 'state'>;

/**
 * The engine's view of encoded `bytes` (left untouched: decodeAudioData gets
 * a copy, the one big copy here), at most 2 channels, each with the engine's
 * 2 ms fade-out tail applied in place. Throws ContextClosedError when the
 * context is closed, else an Error.
 */
export async function decodeFine(bytes: ArrayBuffer, ctx: FineDecoder): Promise<Float32Array[]> {
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(bytes.slice(0));
  } catch (e) {
    if (ctx.state === 'closed') throw new ContextClosedError();
    throw e;
  }
  if (buf.length === 0 || buf.numberOfChannels === 0) throw new Error('empty audio');
  const fade = Math.round(0.002 * buf.sampleRate); // as decodeBytes
  const out: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
    const ch = buf.getChannelData(c);
    fadeOutTail(ch, fade);
    out.push(ch);
  }
  return out;
}

export interface FineRequest {
  /** The kept original bytes (never detached). */
  bytes: ArrayBuffer;
  /** For error messages. */
  name: string;
  /** Estimated floats once decoded (frames × channels at the decode rate). */
  floats: number;
  /** Decodes `bytes` (decodeFine with the engine's context). */
  decode(bytes: ArrayBuffer): Promise<Float32Array[]>;
}

/**
 * The request for a sample (its kept file and meta) on the engine `ctx`; the
 * key names the file at the context's rate.
 */
export function fineRequestFor(
  file: SampleFile, meta: { seconds: number; channels: number }, ctx: FineDecoder & { sampleRate: number },
): FineRequest & { key: string } {
  return {
    key: `${file.hash}@${ctx.sampleRate}`,
    bytes: file.bytes,
    name: file.name,
    floats: Math.ceil(meta.seconds * ctx.sampleRate) * Math.min(2, meta.channels),
    decode: (b) => decodeFine(b, ctx),
  };
}

export interface FineSamples {
  status(key: string): FineStatus;
  /** The decoded channels of `key`, or null when it is not the kept, ready sample. */
  channels(key: string): Float32Array[] | null;
  /** True when `floats` fit the budget. */
  fits(floats: number): boolean;
  /**
   * Decode `key` (or join its pending decode), dropping any other sample.
   * Resolves to the final status: 'none' when another sample (or a release)
   * took over meanwhile. Never throws.
   */
  load(key: string, req: FineRequest): Promise<FineStatus>;
  /** Drop `key`'s floats or abandon its decode (no-op for another key). */
  release(key: string): void;
  /** Drop everything (a project load). */
  clear(): void;
  /** Hold `key` (a mounted view); the returned function lets go, and the last holder releases it. */
  retain(key: string): () => void;
  /** Called after every status change. Returns the unsubscribe function. */
  subscribe(fn: () => void): () => void;
}

interface Entry {
  key: string;
  status: FineStatus;
  channels: Float32Array[] | null;
  done: Promise<FineStatus>;
}

export function createFineSamples(budgetBytes = FINE_BUDGET_BYTES): FineSamples {
  /** The wanted sample (kept, decoding or waiting to decode). */
  let entry: Entry | null = null;
  /** The decode running now (whoever asked for it), or null. */
  let running: Promise<unknown> | null = null;
  const subs = new Set<() => void>();
  const holders = new Map<string, number>();
  const changed = () => {
    for (const fn of subs) fn();
  };
  const fits = (floats: number) => floats * 4 <= budgetBytes;
  const drop = (key?: string) => {
    if (!entry || (key !== undefined && entry.key !== key)) return;
    entry = null;
    changed();
  };

  async function run(e: Entry, req: FineRequest): Promise<FineStatus> {
    // One decode at a time: wait for the running one (its result is dropped).
    while (running) await running.catch(() => {});
    if (entry !== e) return 'none'; // overtaken while waiting: never started
    let status: FineStatus;
    let chans: Float32Array[] | null = null;
    const job = req.decode(req.bytes);
    running = job;
    try {
      chans = await job;
      status = fits(chans.reduce((n, c) => n + c.length, 0)) ? 'ready' : 'too-big';
    } catch (err) {
      status = err instanceof ContextClosedError ? 'none' : 'failed';
    } finally {
      running = null;
    }
    if (entry !== e) return 'none'; // overtaken or released: let it go
    if (status === 'none') {
      entry = null; // not remembered: a new engine may decode it
    } else {
      e.status = status;
      e.channels = status === 'ready' ? chans : null;
    }
    changed();
    return status;
  }

  return {
    status: (key) => (entry?.key === key ? entry.status : 'none'),
    channels: (key) => (entry?.key === key && entry.status === 'ready' ? entry.channels : null),
    fits,
    load(key, req) {
      if (entry?.key === key) return entry.done;
      if (!fits(req.floats)) return Promise.resolve('too-big');
      const e: Entry = { key, status: 'decoding', channels: null, done: Promise.resolve('decoding') };
      entry = e; // the kept sample is dropped here
      e.done = run(e, req);
      changed();
      return e.done;
    },
    release: (key) => drop(key),
    clear: () => drop(),
    retain(key) {
      holders.set(key, (holders.get(key) ?? 0) + 1);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        const n = (holders.get(key) ?? 1) - 1;
        if (n > 0) holders.set(key, n);
        else {
          holders.delete(key);
          drop(key);
        }
      };
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

let shared: FineSamples | null = null;

/** The app's one cache (created on first use). */
export function fineSamples(): FineSamples {
  shared ??= createFineSamples();
  return shared;
}
