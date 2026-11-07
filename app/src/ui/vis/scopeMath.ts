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
//     override it); a grid not valid (stopped, after a seek) falls back to:
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
 * VIS_SCOPE_RING × 4 floats; `hdr`: its VIS_SCOPE_HDR fields. The window
 * never reaches outside the readable range (`len` shrinks to what there is).
 */
export function scopeWindow(ring: Float32Array, hdr: Int32Array, o: ScopeOpts, len: number): ScopeWin {
  const { head, n } = readable(hdr);
  const lo = (head - n) | 0;
  if (o.sync && hdr[SCOPE_HDR.flags] & SCOPE_FLAG.grid) {
    const prev = hdr[SCOPE_HDR.gridPrev];
    const last = hdr[SCOPE_HDR.gridLast];
    const span = (last - prev) | 0;
    if (span > 0 && ((prev - lo) | 0) >= 0 && ((head - last) | 0) >= 0) return { start: prev, len: span, triggered: true };
  }
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
