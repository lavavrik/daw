// Pure rack layout: rows of panels placed on a GRID-px grid. No DOM, no state.
// Spec: plan 22 "Rack placement" (supersedes plan 18's push rule); the long
// form is docs/architecture/modular.md "Layout".
//
// - Flow (no module has a `pos`): `flowRack` wraps the panels by idx onto the
//   SAME grid the positioned layout uses, so the first drag pins exactly what
//   is on screen (no module jumps).
// - Positioned: `layoutRack` draws the saved `pos`. It only resolves overlap
//   that is already in the saved data (an older project, a panel that got
//   wider): left to right per row, deterministically. Every write saves the
//   drawn layout (`toPositions` of a `moveTo` on it), so such an overlap is
//   resolved once and is gone from the data after the next move.
// - `moveTo` never pushes: only the moved module changes, and only into a
//   spot where it `fits`; otherwise it returns null (the caller writes nothing).
// - Rows are never renumbered (plan 22 fix round 1): a row a move or a removal
//   empties stays as an empty band until Tidy, so no other module changes row.
//   Only trailing empty rows go, which moves nothing (the row count is the
//   last occupied row + 1). The rack draws every row equally tall (Rack.svelte).

import type { RackPos } from '../../state/project.svelte';

export const GRID = 10;
/** The saved bounds (state/patches.ts validates them: an out-of-range pos drops the whole rack's layout). */
export const MAX_ROW = 31;
export const MAX_X = 1000;
/** The minimum gap between two panels of a row, in grid units (exactly this in the flow). */
export const GAP = 1;

/** x, w in grid units. */
export interface Placed { idx: number; row: number; x: number; w: number }

/**
 * A panel's width in grid units. The rendered width is already a multiple of
 * GRID (ModulePanel rounds it up), so this is exact; the ceil only matters
 * for a sub-pixel measurement and for the unit tests' raw widths.
 */
const wUnits = (px: number) => Math.max(1, Math.ceil(px / GRID - 1e-6));

/** Sorted by (row, x, idx). Rows keep their numbers: an empty row in the middle stays (an empty band). */
function ordered(items: Placed[]): Placed[] {
  return items.sort((a, b) => a.row - b.row || a.x - b.x || a.idx - b.idx);
}

/**
 * The flow layout on the grid: panels by idx, left to right, each taking
 * its width in units plus GAP, wrapping to a new row when the next one would
 * pass `cols` units (a panel wider than `cols` gets a row of its own). Every
 * gap in a row is exactly GAP units (10 px). null until every panel has a measured width (the rack shows the CSS
 * flex flow meanwhile).
 */
export function flowRack(idxs: readonly number[], widthsPx: ReadonlyMap<number, number>, cols: number): Placed[] | null {
  if (!idxs.length || idxs.some((i) => !widthsPx.has(i))) return null;
  const out: Placed[] = [];
  let row = 0;
  let x = 0;
  for (const idx of [...idxs].sort((a, b) => a - b)) {
    const w = wUnits(widthsPx.get(idx)!);
    if (x > 0 && x + w > cols) { row++; x = 0; }
    out.push({ idx, row, x, w });
    x += w + GAP;
  }
  return out;
}

/**
 * null when no module has a pos (flow). Saved overlap in a row (older data, a
 * panel that grew, panels saved touching before the GAP rule) is resolved left
 * to right: each panel starts at least GAP units after the previous one's
 * right edge, so one overlap can move several panels of that row (a cascade).
 * A layout that keeps GAP everywhere is drawn exactly as saved, empty rows
 * (gaps in the saved row numbers) included. Unpositioned modules go at the end
 * of the bottom row in idx order, GAP apart.
 */
export function layoutRack(
  mods: readonly { idx: number; pos?: RackPos }[],
  widthsPx: ReadonlyMap<number, number>,
): Placed[] | null {
  if (!mods.some((m) => m.pos)) return null;
  const w = (idx: number) => wUnits(widthsPx.get(idx) ?? 0);
  const positioned: Placed[] = mods
    .filter((m) => m.pos)
    .map((m) => ({ idx: m.idx, row: m.pos!.row, x: Math.max(0, m.pos!.x), w: w(m.idx) }));
  const bottom = Math.max(...positioned.map((p) => p.row));

  const out: Placed[] = [];
  const byRow = new Map<number, Placed[]>();
  for (const p of positioned) (byRow.get(p.row) ?? byRow.set(p.row, []).get(p.row)!).push(p);
  for (const [row, items] of byRow) {
    items.sort((a, b) => a.x - b.x || a.idx - b.idx);
    let edge = 0;
    for (const p of items) {
      p.x = Math.max(p.x, edge);
      edge = p.x + p.w + GAP;
      out.push(p);
    }
    if (row === bottom) {
      const loose = mods.filter((m) => !m.pos).sort((a, b) => a.idx - b.idx);
      for (const m of loose) {
        out.push({ idx: m.idx, row, x: edge, w: w(m.idx) });
        edge += w(m.idx) + GAP;
      }
    }
  }
  return ordered(out);
}

/**
 * Whether module `idx` fits at (row, x) with at least GAP units to every other
 * module of that row (itself excluded): no overlap, and no touching either. A
 * row past the last one is empty, so it always fits there.
 */
export function fits(placed: readonly Placed[], idx: number, row: number, x: number): boolean {
  const me = placed.find((p) => p.idx === idx);
  if (!me || row < 0 || x < 0) return false;
  return placed.every((p) => p.idx === idx || p.row !== row || p.x + p.w + GAP <= x || x + me.w + GAP <= p.x);
}

/**
 * The fitting x in `row` nearest to `x` (GAP from its neighbours: `fits`), at
 * most `reach` units away (ties go left), within 0..MAX_X, or null. The drag's outline snaps to a free spot
 * just beside the pointer instead of turning red for a near miss.
 */
export function nearestFit(placed: readonly Placed[], idx: number, row: number, x: number, reach: number): number | null {
  for (let d = 0; d <= reach; d++) {
    if (x - d <= MAX_X && fits(placed, idx, row, x - d)) return x - d;
    if (d && x + d <= MAX_X && fits(placed, idx, row, x + d)) return x + d;
  }
  return null;
}

/**
 * Place `idx` at (row, x), moving nothing else: null when it doesn't fit there
 * (the caller writes nothing and the module stays). x < 0 is clamped to 0.
 * The new row is one below the last row any OTHER module is in (larger rows
 * clamp to it), so a module alone in the bottom row stays put, and no empty
 * row is ever left above the mover. Rows keep their numbers: a row the move
 * empties stays (an empty band) unless it is trailing.
 */
export function moveTo(placed: readonly Placed[], idx: number, row: number, x: number): Placed[] | null {
  const me = placed.find((p) => p.idx === idx);
  if (!me) return null;
  const maxOther = Math.max(-1, ...placed.filter((p) => p.idx !== idx).map((p) => p.row));
  const r = Math.min(Math.max(0, row), maxOther + 1);
  const nx = Math.max(0, x);
  if (!fits(placed, idx, r, nx)) return null;
  return ordered(placed.map((p) => (p.idx === idx ? { ...p, row: r, x: nx } : { ...p })));
}

/**
 * Every module within the saved bounds: a move whose result is not (a 33rd
 * row, an x past 1000) must not be written. With `before` (the layout the move
 * started from) only panels whose x the move changed are held to x <= MAX_X:
 * one already drawn past 1000 (a module appended at the end of the bottom row,
 * older overlapping data resolved to the right) must not block every other
 * move. Rows are checked for all (only the mover's row changes).
 */
export function inBounds(placed: readonly Placed[], before?: readonly Placed[]): boolean {
  const was = new Map(before?.map((p) => [p.idx, p.x]));
  return placed.every((p) => p.row <= MAX_ROW && (p.x <= MAX_X || was.get(p.idx) === p.x));
}

/**
 * The positions to save. x is clamped to MAX_X: a panel drawn past 1000 that
 * this move did not touch (see inBounds) is saved at 1000 and drawn back where
 * it was (layoutRack resolves the overlap the same way), so the saved layout
 * always validates (patches.ts drops a rack's whole layout otherwise).
 */
export function toPositions(placed: readonly Placed[]): { idx: number; pos: RackPos }[] {
  return placed.map((p) => ({ idx: p.idx, pos: { row: p.row, x: Math.min(MAX_X, p.x) } }));
}
