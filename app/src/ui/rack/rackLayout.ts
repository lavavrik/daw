// Pure rack layout: rows of panels placed on a GRID-px grid. No DOM, no state.
// The model stores only `pos` ({row, x}); widths are measured at draw time, so
// overlap is always re-resolved here (a panel that grows pushes its right-hand
// neighbours instead of covering them).

import type { RackPos } from '../../state/project.svelte';

export const GRID = 10;

/** x, w in grid units. */
export interface Placed { idx: number; row: number; x: number; w: number }

const wUnits = (px: number) => Math.max(1, Math.ceil(px / GRID));

/** Renumber rows 0..n-1 in order (drops empty rows / saved gaps) and sort by (row, x, idx). */
function compact(items: Placed[]): Placed[] {
  const rows = [...new Set(items.map((p) => p.row))].sort((a, b) => a - b);
  const map = new Map(rows.map((r, i) => [r, i]));
  return items
    .map((p) => ({ ...p, row: map.get(p.row)! }))
    .sort((a, b) => a.row - b.row || a.x - b.x || a.idx - b.idx);
}

/** null when no module has a pos (flow). Overlaps in a row are resolved left to right (push right); unpositioned modules go at the end of the bottom row in idx order. */
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
      edge = p.x + p.w;
      out.push(p);
    }
    if (row === bottom) {
      const loose = mods.filter((m) => !m.pos).sort((a, b) => a.idx - b.idx);
      for (const m of loose) {
        out.push({ idx: m.idx, row, x: edge, w: w(m.idx) });
        edge += w(m.idx);
      }
    }
  }
  return compact(out);
}

/** Place `idx` at (row, x): push overlaps right (cascading), remove empty rows, renumber. row may equal maxRow + 1 (new row). */
export function moveTo(placed: readonly Placed[], idx: number, row: number, x: number): Placed[] {
  const me = placed.find((p) => p.idx === idx);
  if (!me) return placed.map((p) => ({ ...p }));
  const maxRow = Math.max(...placed.map((p) => p.row));
  const r = Math.min(Math.max(0, row), maxRow + 1);
  const moved: Placed = { idx, row: r, x: Math.max(0, x), w: me.w };
  // The mover leaves its old row first, so that row keeps its gap.
  const others = placed.filter((p) => p.idx !== idx).map((p) => ({ ...p }));
  const target = others.filter((p) => p.row === r).sort((a, b) => a.x - b.x || a.idx - b.idx);
  let edge = moved.x + moved.w;
  for (const p of target) {
    if (p.x + p.w <= moved.x) continue; // wholly left of the mover
    if (p.x < edge) p.x = edge; // overlapped (by the mover or an already-pushed panel)
    edge = p.x + p.w;
  }
  return compact([...others, moved]);
}

/** Pins from the flow layout's measured rects (content-relative px). */
export function pinFromRects(
  rects: readonly { idx: number; left: number; top: number; width: number }[],
  padLeft: number,
): Placed[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left || a.idx - b.idx);
  const out: Placed[] = [];
  let row = -1;
  let rowTop = 0;
  for (const r of sorted) {
    if (row < 0 || r.top > rowTop + 2) { row++; rowTop = r.top; }
    out.push({ idx: r.idx, row, x: Math.max(0, Math.round((r.left - padLeft) / GRID)), w: wUnits(r.width) });
  }
  return out;
}

export function toPositions(placed: readonly Placed[]): { idx: number; pos: RackPos }[] {
  return placed.map((p) => ({ idx: p.idx, pos: { row: p.row, x: p.x } }));
}
