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
