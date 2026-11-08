import { describe, it, expect } from 'vitest';
import { inBounds, layoutRack, moveTo, pinFromRects, toPositions, GRID, MAX_ROW, MAX_X, type Placed } from './rackLayout';

const widths = (o: Record<number, number>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
const P = (idx: number, row: number, x: number, w: number): Placed => ({ idx, row, x, w });
const by = (p: Placed[], idx: number) => p.find((q) => q.idx === idx)!;

describe('layoutRack', () => {
  it('flow_when_no_pos', () => {
    expect(layoutRack([{ idx: 0 }, { idx: 1 }], widths({ 0: 100, 1: 100 }))).toBeNull();
    expect(layoutRack([], widths({}))).toBeNull();
  });

  it('unpositioned_go_end_of_bottom_row', () => {
    const p = layoutRack(
      [{ idx: 0, pos: { row: 0, x: 0 } }, { idx: 1, pos: { row: 1, x: 2 } }, { idx: 3 }, { idx: 2 }],
      widths({ 0: 100, 1: 50, 2: 31, 3: 20 }),
    )!;
    // idx 2 then 3 (idx order) after idx 1's right edge (2 + 5 = 7), each after the previous.
    expect(by(p, 2)).toEqual(P(2, 1, 7, 4));
    expect(by(p, 3)).toEqual(P(3, 1, 11, 2));
  });

  it('wider_panel_pushes_when_drawn', () => {
    // A at x 0 was 5 wide, B at x 5; A grew to 8 units -> B pushed to 8.
    const p = layoutRack(
      [{ idx: 0, pos: { row: 0, x: 0 } }, { idx: 1, pos: { row: 0, x: 5 } }],
      widths({ 0: 80, 1: 30 }),
    )!;
    expect(by(p, 0).x).toBe(0);
    expect(by(p, 1).x).toBe(8);
  });

  it('compacts_gap_rows', () => {
    const p = layoutRack([{ idx: 0, pos: { row: 0, x: 0 } }, { idx: 1, pos: { row: 5, x: 0 } }], widths({ 0: 10, 1: 10 }))!;
    expect(by(p, 1).row).toBe(1);
  });
});

describe('moveTo', () => {
  it('drop_pushes_overlaps_cascading', () => {
    const start = [P(0, 0, 0, 4), P(1, 0, 4, 4), P(2, 0, 8, 4), P(3, 1, 0, 3)];
    // x 1 is in 0's left half (0..4): occupies 1..4, 0 is pushed to 4, then 1 and 2 cascade.
    const r = moveTo(start, 3, 0, 1);
    expect(by(r, 3)).toEqual(P(3, 0, 1, 3));
    expect(by(r, 0).x).toBe(4);
    expect(by(r, 1).x).toBe(8);
    expect(by(r, 2).x).toBe(12);
    // x 3 is in 0's right half: snaps to 4 (0 stays), pushes 1 and 2 instead.
    const s = moveTo(start, 3, 0, 3);
    expect([by(s, 0).x, by(s, 3).x, by(s, 1).x, by(s, 2).x]).toEqual([0, 4, 7, 11]);
  });

  it('gap_kept_when_moving_out', () => {
    const start = [P(0, 0, 0, 4), P(1, 0, 4, 4), P(2, 0, 8, 4), P(3, 1, 0, 3)];
    const r = moveTo(start, 1, 1, 10);
    expect(by(r, 0).x).toBe(0);
    expect(by(r, 2).x).toBe(8); // not closed up
    expect(by(r, 1)).toEqual(P(1, 1, 10, 4));
  });

  it('empty_row_removed_and_renumbered', () => {
    const start = [P(0, 0, 0, 4), P(1, 1, 0, 4), P(2, 2, 0, 4)];
    const r = moveTo(start, 1, 0, 6);
    expect(by(r, 1).row).toBe(0);
    expect(by(r, 2).row).toBe(1);
  });

  it('drop_below_creates_row', () => {
    const start = [P(0, 0, 0, 4), P(1, 0, 4, 4), P(2, 1, 0, 4)];
    const r = moveTo(start, 0, 2, 0);
    expect(by(r, 0)).toEqual(P(0, 2, 0, 4));
    expect(moveTo(start, 0, 99, 0).find((q) => q.idx === 0)!.row).toBe(2);
  });

  it('left_half_overlap_pushes_neighbour_right', () => {
    // B dropped with its left edge in A's LEFT half (A 0..10, half at 5): A goes right of B.
    const start = [P(0, 0, 0, 10), P(1, 0, 10, 4)];
    const r = moveTo(start, 1, 0, 3);
    expect(by(r, 1)).toEqual(P(1, 0, 3, 4));
    expect(by(r, 0).x).toBe(7);
  });

  it('right_half_overlap_snaps_to_neighbours_right_edge', () => {
    // B's left edge in A's RIGHT half (x >= 5): B snaps to A's right edge, no swap.
    const start = [P(0, 0, 0, 10), P(1, 0, 20, 4), P(2, 0, 14, 3)];
    const r = moveTo(start, 1, 0, 7);
    expect(by(r, 0).x).toBe(0);
    expect(by(r, 1).x).toBe(10);
    expect(by(r, 2).x).toBe(14); // 10 + 4 = 14: touching, not pushed
    expect(by(moveTo(start, 1, 0, 5), 1).x).toBe(10); // exactly the middle snaps too
    // ...and the snap still pushes what the snapped panel overlaps.
    expect(by(moveTo([P(0, 0, 0, 10), P(1, 1, 0, 6), P(2, 0, 12, 3)], 1, 0, 8), 2).x).toBe(16);
  });

  it('nudge_left_into_touching_neighbour_is_no_change', () => {
    // Alt+Left on B touching A lands in A's right half: back on A's right edge.
    const start = [P(0, 0, 0, 10), P(1, 0, 10, 4)];
    expect(moveTo(start, 1, 0, 9)).toEqual(start);
  });

  it('x_never_negative', () => {
    expect(by(moveTo([P(0, 0, 3, 4)], 0, 0, -5), 0).x).toBe(0);
    expect(by(moveTo([P(0, 0, 3, 4), P(1, 1, 0, 2)], 1, -2, 0), 1).row).toBe(0);
  });
});

describe('pinFromRects', () => {
  it('pin_rows_from_tops_with_tolerance', () => {
    const p = pinFromRects(
      [{ idx: 0, left: 8, top: 6, width: 100 }, { idx: 1, left: 120, top: 7, width: 100 }, { idx: 2, left: 8, top: 120, width: 100 }],
      8,
    );
    expect([by(p, 0).row, by(p, 1).row, by(p, 2).row]).toEqual([0, 0, 1]);
  });

  it('pin_x_rounds_to_grid', () => {
    const p = pinFromRects([{ idx: 0, left: 8 + 24, top: 0, width: 101 }, { idx: 1, left: 0, top: 0, width: 20 }], 8);
    expect(by(p, 0).x).toBe(2); // 24/10 = 2.4 -> 2
    expect(by(p, 0).w).toBe(Math.ceil(101 / GRID));
    expect(by(p, 1).x).toBe(0); // negative clamps to 0
  });
});

it('toPositions maps to pos', () => {
  expect(toPositions([P(4, 1, 7, 3)])).toEqual([{ idx: 4, pos: { row: 1, x: 7 } }]);
});

it('toPositions clamps a drawn x past MAX_X (pushed there, not moved): the saved layout stays valid', () => {
  expect(toPositions([P(4, 1, MAX_X + 7, 3)])).toEqual([{ idx: 4, pos: { row: 1, x: MAX_X } }]);
});

describe('inBounds', () => {
  it('push_past_max_x_is_out', () => {
    // A at 990 (w 5) dropped at 996 pushes B (at 1000) to 1001: refused by the rack.
    const base = [P(0, 0, 990, 5), P(1, 0, MAX_X, 4)];
    expect(inBounds(base)).toBe(true);
    const r = moveTo(base, 0, 0, 996);
    expect(by(r, 1).x).toBe(1001);
    expect(inBounds(r)).toBe(false);
  });
  it('row_past_max_row_is_out', () => {
    expect(inBounds([P(0, MAX_ROW, 0, 1)])).toBe(true);
    expect(inBounds([P(0, MAX_ROW + 1, 0, 1)])).toBe(false);
  });
  it('only_moved_panels_are_checked', () => {
    // C already sits past 1000 (pushed by a grown panel / appended): moving A elsewhere is fine.
    const base = [P(0, 0, 0, 4), P(1, 1, 0, 4), P(2, 1, MAX_X + 5, 4)];
    expect(inBounds(base)).toBe(false);
    expect(inBounds(moveTo(base, 0, 1, 10), base)).toBe(true);
    // A move that pushes C (further) right is still out.
    expect(inBounds(moveTo(base, 0, 1, MAX_X + 3), base)).toBe(false);
  });
});
