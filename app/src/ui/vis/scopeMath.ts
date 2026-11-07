// Scope maths (plan 12, Task 2): pure functions over one scope slot's ring
// and header in visSab (layout: audio/visLayout.ts SCOPE_HDR). The engine
// only records min/max entries and the sync-grid marks
// (engine/src/rack/modules/scope.rs); everything here is UI-side, run by
// ScopeView.svelte once per frame.
//
// Reading rule (visuals.md *Data path*): the head is Atomics.loaded first;
// the readable entries are [max(epoch, head - (RING - VIS_GUARD)), head),
// compared with `(a - b) | 0` so heads may wrap at 2^31. An epoch ahead of
// the loaded head (the header fields are copied before the head is
// published) means nothing is readable yet.
//
// Window choice (`scopeWindow`):
//   - Sync with the grid valid: the last whole division, [grid_prev,
//     grid_last) (Sync is the timebase, so the trigger choice does not
//     override it). A division is up to VIS_SCOPE_WINDOW entries, so late
//     in the next one its start has left the readable range (RING - GUARD
//     = 1792 < 2 divisions): the view keeps a **hold** (`createSyncHold`),
//     a preallocated copy of the last whole division taken the moment
//     grid_last changes (it is then at most a block old, so readable), and
//     draws Sync from it (`held`) until the next line: no fallback, no
//     flicker. A grid not valid (stopped, after a seek), a division not
//     captured, or no hold falls back to:
//   - Trigger Free: the latest `len` entries;
//   - Trigger Auto: the latest rising zero crossing of A's mid
//     ((min + max) / 2) that still has `len` entries after it. A Schmitt
//     trigger: armed below -h, fires at the first entry >= 0, with h = 2 %
//     of A's peak-to-peak over the readable entries (min 1e-4), so noise on
//     a slow wave does not retrigger. No crossing: free-run (triggered
//     false, the view tags it "no trig").
import { SCOPE_FLAG, SCOPE_HDR, VIS_GUARD } from '../../audio/visLayout';
import { VIS_SCOPE_HDR, VIS_SCOPE_RING, VIS_SCOPE_WINDOW, VIS_SCOPES } from '../../audio/protocol';

const MASK = VIS_SCOPE_RING - 1;
/** Most entries a reader may look back from the head. */
const READABLE = VIS_SCOPE_RING - VIS_GUARD;

export interface ScopeOpts {
  /** The `sync` param is on. */
  sync: boolean;
  /** The `trig` param: 0 Auto, 1 Free. */
  trig: number;
}

export interface ScopeWin {
  /** First entry (a head value; position `start & (RING - 1)`). */
  start: number;
  /** Entries in the window. */
  len: number;
  /** Locked to a crossing or the sync grid (false: free-running). */
  triggered: boolean;
  /** Sync: the entries are the hold's `buf` (from 0), not the ring. */
  held?: true;
}

/** Entries a hold keeps: one division (≤ VIS_SCOPE_WINDOW, + rounding). */
const HOLD_CAP = VIS_SCOPE_WINDOW + 2;

/**
 * The last whole sync division, copied out of the ring (see the file
 * comment). Preallocated: make one per view, reset `has` when the view's
 * slot changes.
 */
export interface SyncHold {
  /** HOLD_CAP entries × 4 f32, entry i at i × 4 (the ring's layout). */
  buf: Float32Array;
  /** Entries held. */
  len: number;
  /** The grid_last it was taken at. */
  last: number;
  /** Holds a division. */
  has: boolean;
}

export function createSyncHold(): SyncHold {
  return { buf: new Float32Array(HOLD_CAP * 4), len: 0, last: 0, has: false };
}

/**
 * Keep `hold` on the slot's last whole division: copy [grid_prev,
 * grid_last) when grid_last moved (or nothing is held) and the division is
 * readable; drop it when the grid is not valid. Returns whether it holds
 * one. Reads only readable entries.
 */
export function holdDivision(ring: Float32Array, hdr: Int32Array, hold: SyncHold): boolean {
  if (!(hdr[SCOPE_HDR.flags] & SCOPE_FLAG.grid)) return (hold.has = false);
  const last = hdr[SCOPE_HDR.gridLast];
  if (hold.has && last === hold.last) return true;
  const { head, n } = readable(hdr);
  const lo = (head - n) | 0;
  let prev = hdr[SCOPE_HDR.gridPrev];
  let span = (last - prev) | 0;
  if (span <= 0 || ((prev - lo) | 0) < 0 || ((head - last) | 0) < 0) return (hold.has = false);
  if (span > HOLD_CAP) {
    prev = (last - HOLD_CAP) | 0;
    span = HOLD_CAP;
  }
  const buf = hold.buf;
  for (let i = 0; i < span; i++) {
    const at = ((prev + i) & MASK) << 2;
    const o = i << 2;
    buf[o] = ring[at];
    buf[o + 1] = ring[at + 1];
    buf[o + 2] = ring[at + 2];
    buf[o + 3] = ring[at + 3];
  }
  hold.len = span;
  hold.last = last;
  return (hold.has = true);
}

/**
 * The scope slot owned by module `idx` of track slot `track`, or -1.
 * `hdrs`: every scope header (VIS_SCOPES × VIS_SCOPE_HDR i32).
 */
export function findScope(hdrs: Int32Array, track: number, idx: number): number {
  if (track < 0) return -1;
  for (let s = 0; s < VIS_SCOPES; s++) {
    const b = s * VIS_SCOPE_HDR;
    if (hdrs[b + SCOPE_HDR.ownerTrack] === track && hdrs[b + SCOPE_HDR.ownerModule] === idx) return s;
  }
  return -1;
}

/** The readable range of a slot: `n` entries ending at `head`. */
export function readable(hdr: Int32Array): { head: number; n: number } {
  const head = Atomics.load(hdr, SCOPE_HDR.head);
  let n = (head - hdr[SCOPE_HDR.epoch]) | 0;
  if (n < 0) n = 0;
  if (n > READABLE) n = READABLE;
  return { head, n };
}

/** A's mid at entry `j`. */
const midA = (ring: Float32Array, j: number) => {
  const at = (j & MASK) << 2;
  return (ring[at] + ring[at + 1]) * 0.5;
};

/**
 * Which `len` entries to draw (see the file comment). `ring`: the slot's
 * VIS_SCOPE_RING × 4 floats; `hdr`: its VIS_SCOPE_HDR fields; `hold`: the
 * view's sync hold (Sync needs one). A `held` window is read from
 * `hold.buf`; any other never reaches outside the readable range (`len`
 * shrinks to what there is).
 */
export function scopeWindow(ring: Float32Array, hdr: Int32Array, o: ScopeOpts, len: number, hold?: SyncHold): ScopeWin {
  if (o.sync && hold && holdDivision(ring, hdr, hold)) return { start: 0, len: hold.len, triggered: true, held: true };
  const { head, n } = readable(hdr);
  const lo = (head - n) | 0;
  len = Math.max(0, Math.min(Math.floor(len), n));
  const free: ScopeWin = { start: (head - len) | 0, len, triggered: false };
  if (o.trig === 1 || len === 0) return free;

  // Hysteresis from A's peak-to-peak over the readable entries.
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < n; i++) {
    const at = ((lo + i) & MASK) << 2;
    if (ring[at] < mn) mn = ring[at];
    if (ring[at + 1] > mx) mx = ring[at + 1];
  }
  const h = Math.max(1e-4, 0.02 * (mx - mn));
  // Candidates: starts in [lo, head - len]; keep the latest firing.
  const last = (n - len) | 0;
  let armed = false;
  let found = -1;
  for (let i = 0; i <= last; i++) {
    const m = midA(ring, lo + i);
    if (m < -h) armed = true;
    else if (armed && m >= 0) {
      found = i;
      armed = false;
    }
  }
  return found < 0 ? free : { start: (lo + found) | 0, len, triggered: true };
}

/** Ticks per `division` choice: the LFO's table (engine catalog.rs
 * LFO_DIVISION_TICKS, parity-tested), 960 PPQ, 4/4 bars. */
export const DIVISION_TICKS = [240, 480, 720, 960, 1920, 3840, 7680, 15360] as const;

/**
 * Frames the window spans, as the engine computes it (scope.rs): Free
 * 10 × `time` ms, Sync one `division` at `bpm`.
 */
export function windowFrames(p: { time: number; sync: boolean; division: number }, sr: number, bpm: number): number {
  if (p.sync) {
    const ticks = DIVISION_TICKS[Math.max(0, Math.min(DIVISION_TICKS.length - 1, Math.round(p.division)))];
    return (ticks * 60 * sr) / ((bpm > 0 ? bpm : 120) * 960);
  }
  return (10 * p.time * sr) / 1000;
}

/** Entries a window of `frames` spans at `decim` frames per entry (1..VIS_SCOPE_WINDOW). */
export function windowLen(frames: number, decim: number): number {
  return Math.max(1, Math.min(VIS_SCOPE_WINDOW, Math.round(frames / Math.max(1, decim))));
}

/** The readout: "5 ms/div", "0.25 ms/div", "12 ms/div", or "1/4 · sync". */
export function readout(time: number, sync: boolean, division: string): string {
  if (sync) return `${division} · sync`;
  const t = time >= 10 ? Math.round(time) : time >= 1 ? +time.toFixed(1) : +time.toFixed(2);
  return `${t} ms/div`;
}
