// Groove maths (plan 25 Task 3; docs/architecture/sequencer.md "Swing
// presets" and "Humanize"): the MPC swing presets and the deterministic
// jitter that Humanize uses. Pure: no Project, no engine. The actions that
// write it are humanizeDrum (actions.ts) and humanizeNotes
// (pattern-actions.ts).

// ---- swing presets -----------------------------------------------------------
// The engine (engine/src/drums.rs `step_tick`) pushes every odd 16th late by
// `swing * 0.5 * STEP_TICKS` (240 ticks a 16th). A pair of 16ths is 480
// ticks, and the off-16th lands at 240 + 120 * swing, so it sits at
//   (240 + 120 * swing) / 480 = 0.5 + 0.25 * swing
// of the pair. MPC swing % is exactly that fraction, so
//   mpc = 50 + 25 * swing      swing = (mpc - 50) / 25.
// 50 % is straight (swing 0); 66 % puts the off-16th at 0.66 of the pair,
// just short of a true 16th triplet (2/3 = 66.7 %, swing 0.667). Every
// preset lands on the swing slider's 1 % grid (0.16, 0.32, 0.48, 0.64), so
// the slider and the ValuePopover show it exactly.

/** MPC swing percent (50..75) -> the engine's swing 0..1. */
export const mpcToSwing = (mpc: number) => (mpc - 50) / 25;
/** The engine's swing 0..1 -> MPC swing percent (50..75). */
export const swingToMpc = (swing: number) => 50 + 25 * swing;

export interface SwingPreset {
  label: string;
  /** MPC swing percent. */
  mpc: number;
  /** The engine's swing (0..1), on the slider's 0.01 grid. */
  swing: number;
}

/** The swing popover's chips, in order. */
export const SWING_PRESETS: readonly SwingPreset[] = [50, 54, 58, 62, 66].map((mpc) => ({
  label: mpc === 50 ? 'Straight' : `${mpc} %`,
  mpc,
  // Rounded to the slider's 1 % so float noise never makes a near-miss.
  swing: Math.round(mpcToSwing(mpc) * 100) / 100,
}));

/** The preset `swing` matches at the slider's 1 % resolution, or null. */
export function activeSwingPreset(swing: number): SwingPreset | null {
  const pct = Math.round(swing * 100);
  return SWING_PRESETS.find((s) => Math.round(s.swing * 100) === pct) ?? null;
}

// ---- humanize ----------------------------------------------------------------
// Amount 0..1 (the popover's 0-100 %). At 100 %:
//   - velocities move by up to ±HUMANIZE_VEL (drum steps and notes alike);
//   - note starts move by up to ±HUMANIZE_TICKS (spec §1: ±12 ticks x amount).
// Each value's offset is `jitter(seed, key) * max * amount`, with `key` the
// item's own identity (row:step for a drum step, the note id for a note), so
// the result does not depend on iteration order. The seed is the pattern id
// plus a per-pattern counter (humanizeSeed), so the same pattern and counter
// always give the same result, and each new Humanize of a pattern a new one.

/** Largest velocity offset at amount 1. *My call:* ±20 of 127, audible but never flattening accents. */
export const HUMANIZE_VEL = 20;
/** Largest start offset at amount 1 (spec §1), in ticks (960 PPQ: 12 ticks = 1/80 of a beat). */
export const HUMANIZE_TICKS = 12;

/** 32-bit FNV-1a of a string. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3's 32-bit finaliser: spreads FNV's weak low bits over the word. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The seed of Humanize number `counter` (0, 1, 2…) of pattern `patternId`. */
export const humanizeSeed = (patternId: string, counter: number) => fnv1a(`${patternId}#${counter}`);

/** A deterministic value in [-1, 1) for item `key` under `seed`. */
export function jitter(seed: number, key: string): number {
  return (fmix32(fnv1a(key) ^ seed) / 0x100000000) * 2 - 1;
}

/** Clamps the popover's amount to 0..1; NaN / ±Infinity give 0 (a no-op). */
export const humanizeAmount = (amount: number) => (Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0);

/**
 * How many times each pattern was humanized this session (the seed's
 * counter). Session state, not saved and not undone: an undo then a new
 * Humanize gives a fresh result, while redo replays its snapshot (history),
 * so it matches the original exactly. Keyed by pattern id (UUIDs, unique
 * across projects).
 */
const counters = new Map<string, number>();

/**
 * The counter the next Humanize of `patternId` uses (0 first), without
 * using it: an action peeks, computes, and calls nextHumanizeCounter only
 * when something changed (a Humanize that changes nothing uses no counter).
 */
export const peekHumanizeCounter = (patternId: string): number => counters.get(patternId) ?? 0;

/** The next counter of `patternId` (0 first), counted as used. */
export function nextHumanizeCounter(patternId: string): number {
  const n = counters.get(patternId) ?? 0;
  counters.set(patternId, n + 1);
  return n;
}

/**
 * A lit step's or a note's velocity after Humanize: `vel` moved by the
 * jitter, rounded and kept at 1..127, so a lit drum step is never turned off.
 */
export function humanizedVel(vel: number, seed: number, key: string, amount: number): number {
  const v = Math.round(vel + jitter(seed, `v:${key}`) * HUMANIZE_VEL * amount);
  return Math.min(127, Math.max(1, v));
}

/**
 * A note's start after Humanize, kept inside the pattern (`total` ticks):
 * never before 0, and its end (start + len) never past `total`. A note that
 * already overhangs the end (or is longer than the pattern) may only move
 * earlier: its end never grows. `start` must be >= 0 (the engine's range).
 */
export function humanizedStart(start: number, len: number, total: number, seed: number, key: string, amount: number): number {
  const s = Math.round(start + jitter(seed, `t:${key}`) * HUMANIZE_TICKS * amount);
  const hi = start + len > total ? start : total - len;
  // hi >= 0: start >= 0, and when the note fits, total - len >= start.
  return Math.min(hi, Math.max(0, s));
}
