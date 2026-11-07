// Waveform peaks (plan 9, spec addendum §3.2): what the audio lanes draw.
//
// Shape: per channel, 8-bit min/max pairs (Int8, interleaved [min, max, …],
// ±127 = full scale) over every PEAK_FRAMES (256) frames at level 0; each
// further level is 4× coarser (a pair over 4 pairs of the level below),
// down to a single pair. Ten minutes of stereo at 48 kHz is about 0.6 MB.
// Quantized outward (min floors, max ceils), so a peak is never drawn
// smaller than it is; NaN counts as 0 and out-of-range samples clamp.
//
// When: once per sample, after decode and BEFORE the upload (the upload
// transfers the channel buffers to the worklet): sampleImport.ts (a drop),
// project/load.ts (Open, and the autosave restore, which loads the same
// way). The audio restart keeps the peaks it has (the same audio at
// another rate: the lanes map peaks to file time, not to frames).
//
// Where: a file over WORKER_FLOATS (2^22 floats, frames × channels: ~44 s of
// stereo at 48 kHz) goes to a dedicated Worker (peaksWorker.ts) with its
// channel buffers TRANSFERRED there and back, so nothing is copied and the
// UI thread never stalls on a stem; smaller files are computed inline (a few
// ms). A worker failure never throws: peaksFor then gives no peaks (the lane
// draws a flat placeholder) and no channels if they were lost in the worker,
// and the caller decodes the kept original bytes again. Results are cached in
// session memory by content hash (state/sampleFiles.ts contentHash), so a
// restore, an undo-revived sample or the same file dropped twice costs
// nothing. Peaks are never saved.
import type { Peaks } from '../state/project.svelte';

/** Frames per min/max pair at level 0. */
export const PEAK_FRAMES = 256;
/** Files bigger than this (frames × channels) are analysed in a Worker. */
export const WORKER_FLOATS = 2 ** 22;

/** Peaks plus the file's length in frames (where the last, partial pair ends). */
export interface PeaksData extends Peaks {
  frames: number;
}

const q = (v: number, up: boolean) => {
  if (!(v === v)) return 0; // NaN
  const x = v * 127;
  return Math.max(-127, Math.min(127, up ? Math.ceil(x) : Math.floor(x)));
};

/** Level 0 + the 4× levels for `channels` (equal lengths, as decodeAudioData gives them). */
export function computePeaks(channels: readonly Float32Array[]): PeaksData {
  const frames = channels[0]?.length ?? 0;
  const pairs = Math.max(1, Math.ceil(frames / PEAK_FRAMES));
  const level0 = channels.map((ch) => {
    const out = new Int8Array(pairs * 2);
    for (let i = 0; i < pairs; i++) {
      let lo = Infinity;
      let hi = -Infinity;
      const end = Math.min(ch.length, (i + 1) * PEAK_FRAMES);
      for (let f = i * PEAK_FRAMES; f < end; f++) {
        let v = ch[f];
        if (!(v === v)) v = 0;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (lo === Infinity) lo = hi = 0;
      out[2 * i] = q(lo, false);
      out[2 * i + 1] = q(hi, true);
    }
    return out;
  });
  const levels: Int8Array[][] = [level0];
  while (levels[levels.length - 1][0] && levels[levels.length - 1][0].length > 2) {
    levels.push(levels[levels.length - 1].map((fine) => {
      const n = fine.length / 2;
      const m = Math.ceil(n / 4);
      const out = new Int8Array(m * 2);
      for (let i = 0; i < m; i++) {
        let lo = 127;
        let hi = -127;
        for (let j = 4 * i; j < Math.min(4 * i + 4, n); j++) {
          if (fine[2 * j] < lo) lo = fine[2 * j];
          if (fine[2 * j + 1] > hi) hi = fine[2 * j + 1];
        }
        out[2 * i] = lo;
        out[2 * i + 1] = hi;
      }
      return out;
    }));
  }
  return { framesPerPeak: PEAK_FRAMES, frames, levels };
}

/**
 * The level for a zoom of `framesPerPx` file frames per pixel: the coarsest
 * one that still has at least one pair per pixel (level 0 when zoomed in
 * further than that).
 */
export function peaksLevel(peaks: Peaks, framesPerPx: number): { level: number; framesPerPeak: number; data: Int8Array[] } {
  let level = 0;
  while (level + 1 < peaks.levels.length && peaks.framesPerPeak * 4 ** (level + 1) <= framesPerPx) level++;
  return { level, framesPerPeak: peaks.framesPerPeak * 4 ** level, data: peaks.levels[level] };
}

/** The file's length in frames: PeaksData.frames, or (older peaks) level 0's pairs × frames per pair. */
export const peaksFrames = (peaks: Peaks): number =>
  (peaks as Partial<PeaksData>).frames ?? ((peaks.levels[0]?.[0]?.length ?? 0) / 2) * peaks.framesPerPeak;

// ---- worker -----------------------------------------------------------------

/** What crosses into the worker and back. */
export interface PeaksRequest { channels: Float32Array[] }
export interface PeaksReply { peaks: PeaksData; channels: Float32Array[] }

/** The worker's side (peaksWorker.ts wires it to onmessage): the reply and what it transfers back. */
export function peaksWorkerReply(channels: Float32Array[]): { msg: PeaksReply; transfer: Transferable[] } {
  const peaks = computePeaks(channels);
  const transfer: Transferable[] = channels.map((c) => c.buffer as ArrayBuffer);
  for (const lv of peaks.levels) for (const a of lv) transfer.push(a.buffer as ArrayBuffer);
  return { msg: { peaks, channels }, transfer };
}

/** The slice of Worker this needs (tests pass a fake with postMessage semantics). */
export interface PeaksWorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  /** The reply could not be deserialized (the buffers are gone with it). */
  onmessageerror: ((e: unknown) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

const spawnWorker = (): PeaksWorkerLike =>
  new Worker(new URL('./peaksWorker.ts', import.meta.url), { type: 'module' }) as unknown as PeaksWorkerLike;

/**
 * Peaks of `channels` computed in a Worker. The channel buffers are
 * transferred in (the caller's arrays are detached) and come back in the
 * reply: use the returned `channels`. One worker per call (big files are
 * rare), terminated after.
 */
export function peaksInWorker(channels: Float32Array[], spawn: () => PeaksWorkerLike = spawnWorker): Promise<PeaksReply> {
  return new Promise((resolve, reject) => {
    const w = spawn();
    w.onmessage = (e) => {
      w.terminate();
      resolve(e.data as PeaksReply);
    };
    w.onerror = w.onmessageerror = (e) => {
      w.terminate();
      reject(new Error(`waveform analysis failed${typeof ErrorEvent !== 'undefined' && e instanceof ErrorEvent ? `: ${e.message}` : ''}`));
    };
    const req: PeaksRequest = { channels };
    w.postMessage(req, channels.map((c) => c.buffer as ArrayBuffer));
  });
}

// ---- cache --------------------------------------------------------------------

/** Session cache: content hash -> peaks (oldest dropped past CACHE_BYTES). */
const cache = new Map<string, PeaksData>();
const CACHE_BYTES = 64 * 1024 * 1024;
let cacheBytes = 0;
const sizeOf = (pk: PeaksData) => pk.levels.reduce((n, lv) => n + lv.reduce((m, a) => m + a.byteLength, 0), 0);

function remember(key: string, pk: PeaksData) {
  if (cache.has(key)) return;
  cache.set(key, pk);
  cacheBytes += sizeOf(pk);
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_BYTES || k === key) break;
    cache.delete(k);
    cacheBytes -= sizeOf(v);
  }
}

/**
 * What peaksFor gives: the peaks and the channels to use from now on; or,
 * after a worker failure, no peaks, and `channels` null when the worker
 * took them with it (decode the kept bytes again).
 */
export type PeaksResult = PeaksReply | { peaks: null; channels: Float32Array[] | null };

/**
 * Peaks for a decoded sample, from the cache (`hash`: its content hash) or
 * computed: in a Worker past WORKER_FLOATS (when Workers exist), else
 * inline. Always use the returned `channels` afterwards (a worker run
 * transferred the originals away). Never throws (see PeaksResult).
 */
export async function peaksFor(
  channels: Float32Array[], hash: string | null, spawn: () => PeaksWorkerLike = spawnWorker,
): Promise<PeaksResult> {
  const hit = hash !== null ? cache.get(hash) : undefined;
  if (hit) return { peaks: hit, channels };
  const floats = channels.reduce((n, c) => n + c.length, 0);
  const canSpawn = spawn !== spawnWorker || typeof Worker !== 'undefined';
  if (!(floats > WORKER_FLOATS && canSpawn)) {
    const peaks = computePeaks(channels);
    if (hash !== null) remember(hash, peaks);
    return { peaks, channels };
  }
  try {
    const r = await peaksInWorker(channels, spawn);
    if (hash !== null) remember(hash, r.peaks);
    return r;
  } catch {
    // Not cached. A worker that never started left the buffers attached.
    const kept = channels.length > 0 && channels.every((c) => c.byteLength > 0);
    return { peaks: null, channels: kept ? channels : null };
  }
}
