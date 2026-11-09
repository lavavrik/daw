// Step grid look (spec §4 "Step grid"): the pure maths behind StepGrid.svelte's
// row colours and step cells (its sliders' fills: ui/rangeFill.ts). No
// Svelte, no project access; the component turns the results into classes
// and CSS custom properties, and the CSS (StepGrid.svelte) draws them with
// theme.css tokens.
import { ACCENT_MIN_VEL } from '../state/acidSteps';
import { TRACK_COLORS } from './theme';

/**
 * A drum row's colour: the palette walked from the track's engine slot,
 * `TRACK_COLORS[(slot + row) % 8]` (spec §2). UI only, never saved.
 *
 * The slot, not the track's index in the list: a slot never changes for the
 * life of a track (removing or adding other tracks leaves it alone), so a
 * row keeps its colour. New tracks are coloured `TRACK_COLORS[slot % 8]`,
 * so row 0 matches the track's own colour unless the track was recoloured
 * or comes from an old project with the old palette — the rows still derive
 * from the current palette (the track colour itself is data and stays).
 */
export function rowColor(slot: number, row: number): string {
  return TRACK_COLORS[(((slot + row) % 8) + 8) % 8];
}

export interface StepCellLook {
  /** velocity > 0 */
  on: boolean;
  /** velocity >= ACCENT_MIN_VEL (110, the Acid tab's rule): ring and glow. */
  accent: boolean;
  /** The heard playhead is on this step: white outline, brightened fill. */
  playing: boolean;
  /** The step is in an odd group of four (steps 4–7, 12–15, …): off cells a shade lighter. */
  alt: boolean;
  /** Fill height in percent of the cell: velocity / 127 (0 when off). */
  fill: number;
}

/**
 * How one step cell looks. `vel` is the stored step velocity (0..127, 0 =
 * off); `playing` comes from the grid's playhead (the heard step).
 *
 * The fill height is the velocity over the stored range 0..127 (spec §4
 * "the fill height is the velocity"; controller ruling, plan 20 Task 8 fix
 * round 1): 127 fills the cell, the grid's click (100) fills ~79 % and its
 * Alt-click ghost (60) ~47 %. From 110 the accent ring is added.
 */
export function stepCellStyle(vel: number, step: number, playing: boolean): StepCellLook {
  const on = vel > 0;
  return {
    on,
    accent: on && vel >= ACCENT_MIN_VEL,
    playing,
    alt: Math.floor(step / 4) % 2 === 1,
    fill: on ? (Math.min(127, vel) / 127) * 100 : 0,
  };
}

// ---- Step velocity editing (plan 23; docs/architecture/sequencer.md "Step velocity")
// The maths of the in-cell edits (wheel, Shift-drag, Shift+arrows) and of the
// velocity lane: no events, no project access. The writes themselves go
// through state/actions.ts setStepVelocity / stepVelocityGesture.

/** An edit keeps a step lit: 0 (off) stays a click or a right-click. */
export const STEP_VEL_MIN = 1;
export const STEP_VEL_MAX = 127;
/** Wheel travel per velocity step (trackpads send many small deltas). */
export const VEL_WHEEL_PX = 40;
/** Shift-drag: one velocity per this many px of vertical travel. */
export const VEL_DRAG_PX = 2;

/** A velocity an edit may write: rounded, 1..127. */
export function clampStepVel(v: number): number {
  return Math.min(STEP_VEL_MAX, Math.max(STEP_VEL_MIN, Math.round(v)));
}

/** Partial wheel travel on a cell is forgotten after this long without a wheel event. */
export const VEL_WHEEL_IDLE_MS = 300;

/**
 * A wheel event's vertical travel in px (negative = up). Line and page deltas
 * (Firefox, some mice) count one step each. With Shift, browsers move a mouse
 * wheel's delta to deltaX, so that axis is read then. Without Shift, a
 * mostly horizontal swipe (|deltaX| > |deltaY|, which nearly always carries
 * some Y jitter) is 0: the grid's horizontal scroll or the browser's back
 * swipe, not an edit (and the caller leaves it un-prevented).
 */
export function wheelPx(e: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean }): number {
  if (!e.shiftKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return 0;
  const d = e.deltaY !== 0 ? e.deltaY : e.shiftKey ? e.deltaX : 0;
  return e.deltaMode === 0 ? d : d * VEL_WHEEL_PX;
}

/**
 * The partial travel a wheel event on cell `key` at time `t` (ms) starts
 * from: what `prev` left, if it was the same cell less than
 * VEL_WHEEL_IDLE_MS ago; else 0 (a tiny touch minutes later must not finish
 * an old notch).
 */
export function wheelCarry(prev: { key: string; acc: number; t: number }, key: string, t: number): number {
  return prev.key === key && t - prev.t < VEL_WHEEL_IDLE_MS ? prev.acc : 0;
}

/**
 * Accumulate wheel travel `px` onto `acc`: a step (notch = +1 louder for up,
 * -1 quieter) once |acc| reaches VEL_WHEEL_PX, then acc restarts at 0. At
 * most one step per event, so a mouse notch (one event of ~100 px) is one
 * step, not two. A reversal drops the other way's partial travel first.
 */
export function wheelNotch(acc: number, px: number): { acc: number; notch: number } {
  if (px === 0) return { acc, notch: 0 };
  const a = (Math.sign(acc) === -Math.sign(px) ? 0 : acc) + px;
  if (Math.abs(a) < VEL_WHEEL_PX) return { acc: a, notch: 0 };
  return { acc: 0, notch: a < 0 ? 1 : -1 };
}

/** Velocity per wheel notch: 5, or 1 with Shift (fine). */
export const wheelVelStep = (fine: boolean) => (fine ? 1 : 5);

/**
 * Shift-drag: the velocity `dy` px above the press (negative = below), from
 * the step's velocity at the press. Relative, 1 per VEL_DRAG_PX px (whole
 * velocities only: the travel is truncated toward 0), clamped to 1..127.
 */
export function dragVel(start: number, dy: number): number {
  return clampStepVel(start + Math.trunc(dy / VEL_DRAG_PX));
}

/**
 * A velocity key on a focused cell: Shift+↑ / Shift+↓ = ±5, Alt+Shift+↑ / ↓
 * = ±1; null for any other key (plain arrows mean nothing on a cell, and
 * Cmd / Ctrl chords are left to the browser and the app).
 */
export function velKeyStep(e: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }): number | null {
  if (!e.shiftKey || e.metaKey || e.ctrlKey) return null;
  const dir = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
  return dir === 0 ? null : dir * (e.altKey ? 1 : 5);
}

/** The floating value chip while editing. */
export const velChip = (v: number) => `vel ${v}`;
/** A lit cell's tooltip (data-tip). */
export const velTip = (v: number) => `Velocity ${v} — wheel or Shift-drag to change`;
/** What the live region says after a keyboard change. */
export const velStatus = (v: number) => `Velocity ${v}`;
