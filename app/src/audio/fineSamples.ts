// Sample-level waveform data (plan 12 Task 4; docs/architecture/visuals.md
// *Waveforms*): a sample's floats, decoded on demand from its kept original
// bytes (Project.sampleFiles) when a waveform view zooms in below
// FINE_FPP (256) frames per pixel, where the peaks pyramid has nothing finer.
//
// - ONE sample is cached, up to FINE_BUDGET_BYTES (256 MiB) of floats: only
//   one waveform is zoomed at a time, and a stem's floats are large (ten
//   minutes of 48 kHz stereo is ~220 MB). Loading another sample evicts it
//   at once (before its decode, so two never sit in memory together), and a
//   decode overtaken by another sample is dropped when it lands.
// - A file whose estimated floats (frames × channels, from sampleMeta at the
//   decode rate) exceed the budget is refused without decoding ('too-big');
//   the view then stops zooming at 256 frames per pixel with a note. One that
//   turns out bigger once decoded is dropped the same way.
// - A failed decode is remembered ('failed', never retried on every redraw);
//   the view keeps the peaks. load() never throws.
// - The caller decodes with the engine's AudioContext (samples.ts
//   decodeBytes), so the frames are exactly the ones the engine plays (same
//   rate, same 2 ms tail fade). Keys should therefore include the rate (an
//   audio restart may change it).
//
// Not reactive: views subscribe() and redraw on a change.

/** The most float bytes kept (one sample). */
export const FINE_BUDGET_BYTES = 256 * 1024 * 1024;

export type FineStatus = 'none' | 'decoding' | 'ready' | 'too-big' | 'failed';

export interface FineRequest {
  /** The kept original bytes (not detached: the decoder gets a copy). */
  bytes: ArrayBuffer;
  /** For error messages. */
  name: string;
  /** Estimated floats once decoded (frames × channels at the decode rate). */
  floats: number;
  /** Decodes a copy of `bytes` (decodeBytes with the engine's context). */
  decode(bytes: ArrayBuffer, name: string): Promise<Float32Array[]>;
}

export interface FineSamples {
  status(key: string): FineStatus;
  /** The decoded channels of `key`, or null when it is not the cached, ready sample. */
  channels(key: string): Float32Array[] | null;
  /** True when `floats` fit the budget. */
  fits(floats: number): boolean;
  /**
   * Decode `key` (or join its running decode), evicting any other sample.
   * Resolves to the final status: 'none' when another sample took over
   * meanwhile. Never throws.
   */
  load(key: string, req: FineRequest): Promise<FineStatus>;
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
  let entry: Entry | null = null;
  const subs = new Set<() => void>();
  const changed = () => {
    for (const fn of subs) fn();
  };
  const fits = (floats: number) => floats * 4 <= budgetBytes;

  return {
    status: (key) => (entry?.key === key ? entry.status : 'none'),
    channels: (key) => (entry?.key === key && entry.status === 'ready' ? entry.channels : null),
    fits,
    load(key, req) {
      if (entry?.key === key) return entry.done;
      if (!fits(req.floats)) return Promise.resolve('too-big');
      const e: Entry = { key, status: 'decoding', channels: null, done: Promise.resolve('decoding') };
      entry = e; // the old sample is dropped here
      e.done = (async (): Promise<FineStatus> => {
        let status: FineStatus;
        let chans: Float32Array[] | null = null;
        try {
          chans = await req.decode(req.bytes, req.name);
          status = fits(chans.reduce((n, c) => n + c.length, 0)) ? 'ready' : 'too-big';
        } catch {
          status = 'failed';
        }
        if (entry !== e) return 'none'; // overtaken: let it go
        e.status = status;
        e.channels = status === 'ready' ? chans : null;
        changed();
        return status;
      })();
      changed();
      return e.done;
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
