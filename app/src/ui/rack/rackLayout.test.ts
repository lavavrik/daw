import { describe, it, expect } from 'vitest';
import { fits, flowRack, inBounds, layoutRack, moveTo, nearestFit, toPositions, FLOW_GAP, GRID, MAX_ROW, MAX_X, type Placed } from './rackLayout';

const widths = (o: Record<number, number>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
const P = (idx: number, row: number, x: number, w: number): Placed => ({ idx, row, x, w });
const by = (p: Placed[], idx: number) => p.find((q) => q.idx === idx)!;

describe('flowRack', () => {
  it('null_until_every_width_is_measured', () => {
    expect(flowRack([0, 1], widths({ 0: 100 }), 50)).toBeNull();
    expect(flowRack([], widths({}), 50)).toBeNull();
  });

  it('wraps_by_idx_on_the_grid', () => {
    // Footprint ceil((w + FLOW_GAP) / GRID): 182 -> 19, 220 -> 23; the third would end at 19 + 23 + 22 = 64 > 60: the third wraps.
    const p = flowRack([2, 0, 1], widths({ 0: 182, 1: 220, 2: 220 }), 60)!;
    expect(p).toEqual([P(0, 0, 0, 19), P(1, 0, 19, 22), P(2, 1, 0, 22)]);
    expect(Math.ceil((182 + FLOW_GAP) / GRID)).toBe(19);
  });

  it('a_panel_wider_than_the_rack_gets_its_own_row', () => {
    const p = flowRack([0, 1, 2], widths({ 0: 100, 1: 900, 2: 100 }), 50)!;
    expect(p.map((q) => [q.row, q.x])).toEqual([[0, 0], [1, 0], [2, 0]]);
  });

  it('pinning_the_flow_draws_it_unchanged', () => {
    // The first drag saves the flow placement: drawn from the saved pos it is identical (no jump).
    const w = widths({ 0: 182, 1: 276.125, 2: 251.3, 3: 180, 4: 226 });
    const flow = flowRack([0, 1, 2, 3, 4], w, 80)!;
    const saved = toPositions(flow).map(({ idx, pos }) => ({ idx, pos }));
    expect(layoutRack(saved, w)).toEqual(flow);
  });
});

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

  it('saved_layout_without_overlap_is_drawn_as_saved', () => {
    const mods = [{ idx: 0, pos: { row: 0, x: 3 } }, { idx: 1, pos: { row: 0, x: 20 } }, { idx: 2, pos: { row: 1, x: 7 } }];
    const p = layoutRack(mods, widths({ 0: 100, 1: 100, 2: 100 }))!;
    expect(p.map((q) => [q.idx, q.row, q.x])).toEqual([[0, 0, 3], [1, 0, 20], [2, 1, 7]]);
  });

  it('saved_overlap_resolves_left_to_right', () => {
    // Older data: A at x 0 was 5 wide, B at x 5; A is now 8 units -> B drawn at 8 (and saved there by the next move).
    const p = layoutRack(
      [{ idx: 0, pos: { row: 0, x: 0 } }, { idx: 1, pos: { row: 0, x: 5 } }],
      widths({ 0: 80, 1: 30 }),
    )!;
    expect(by(p, 0).x).toBe(0);
    expect(by(p, 1).x).toBe(8);
    // Deterministic and idempotent: drawing the resolved layout again changes nothing.
    expect(layoutRack(toPositions(p), widths({ 0: 80, 1: 30 }))).toEqual(p);
  });

  it('compacts_gap_rows', () => {
    const p = layoutRack([{ idx: 0, pos: { row: 0, x: 0 } }, { idx: 1, pos: { row: 5, x: 0 } }], widths({ 0: 10, 1: 10 }))!;
    expect(by(p, 1).row).toBe(1);
  });
});

describe('fits', () => {
  const row = [P(0, 0, 0, 4), P(1, 0, 10, 4), P(2, 1, 0, 3)];
  it('free_spot_between_neighbours', () => {
    expect(fits(row, 2, 0, 4)).toBe(true); // touching 0's right edge
    expect(fits(row, 2, 0, 7)).toBe(true); // touching 1's left edge
    expect(fits(row, 2, 0, 14)).toBe(true);
  });
  it('overlap_does_not_fit', () => {
    expect(fits(row, 2, 0, 3)).toBe(false);
    expect(fits(row, 2, 0, 8)).toBe(false);
    expect(fits(row, 2, 0, -1)).toBe(false);
  });
  it('own_spot_and_new_row_fit', () => {
    expect(fits(row, 0, 0, 0)).toBe(true); // itself is not in the way
    expect(fits(row, 0, 0, 2)).toBe(true);
    expect(fits(row, 0, 2, 50)).toBe(true); // a row past the last is empty
  });
});

describe('nearestFit', () => {
  const row = [P(0, 0, 0, 4), P(1, 0, 10, 4), P(2, 1, 0, 3)];
  it('snaps_within_reach', () => {
    expect(nearestFit(row, 2, 0, 5, 2)).toBe(5);
    expect(nearestFit(row, 2, 0, 3, 2)).toBe(4); // a near miss into 0
    expect(nearestFit(row, 2, 0, 9, 2)).toBe(7); // a near miss into 1 (7 + 3 = 10)
  });
  it('null_when_no_spot_in_reach', () => {
    expect(nearestFit([P(0, 0, 0, 10), P(1, 1, 0, 3)], 1, 0, 3, 2)).toBeNull();
  });
});

describe('moveTo', () => {
  const start = [P(0, 0, 0, 4), P(1, 0, 4, 4), P(2, 0, 8, 4), P(3, 1, 0, 3)];

  it('moves_only_the_module_into_a_free_spot', () => {
    const r = moveTo(start, 3, 0, 12)!;
    expect(by(r, 3)).toEqual(P(3, 0, 12, 3));
    expect([by(r, 0).x, by(r, 1).x, by(r, 2).x]).toEqual([0, 4, 8]);
  });

  it('overlap_is_refused_nothing_pushed', () => {
    expect(moveTo(start, 3, 0, 1)).toBeNull();
    expect(moveTo(start, 3, 0, 10)).toBeNull();
    expect(moveTo(start, 2, 0, 7)).toBeNull(); // a nudge left into a touching neighbour
  });

  it('gap_kept_when_moving_out', () => {
    const r = moveTo(start, 1, 1, 10)!;
    expect(by(r, 0).x).toBe(0);
    expect(by(r, 2).x).toBe(8); // not closed up
    expect(by(r, 1)).toEqual(P(1, 1, 10, 4));
  });

  it('within_own_footprint_is_fine', () => {
    // A slight move right overlaps only the module's own old spot.
    const r = moveTo([P(0, 0, 0, 10), P(1, 0, 20, 4)], 0, 0, 3)!;
    expect(by(r, 0).x).toBe(3);
    expect(by(r, 1).x).toBe(20);
  });

  it('empty_row_removed_and_renumbered', () => {
    const s = [P(0, 0, 0, 4), P(1, 1, 0, 4), P(2, 2, 0, 4)];
    const r = moveTo(s, 1, 0, 6)!;
    expect(by(r, 1).row).toBe(0);
    expect(by(r, 2)).toEqual(P(2, 1, 0, 4)); // row index only; x unchanged
  });

  it('drop_below_creates_row', () => {
    const s = [P(0, 0, 0, 4), P(1, 0, 4, 4), P(2, 1, 0, 4)];
    expect(by(moveTo(s, 0, 2, 0)!, 0)).toEqual(P(0, 2, 0, 4));
    expect(by(moveTo(s, 0, 99, 0)!, 0).row).toBe(2);
  });

  it('x_never_negative', () => {
    expect(by(moveTo([P(0, 0, 3, 4)], 0, 0, -5)!, 0).x).toBe(0);
    expect(by(moveTo([P(0, 0, 3, 4), P(1, 1, 0, 2)], 1, -2, 7)!, 1).row).toBe(0);
    expect(moveTo([P(0, 0, 1, 4), P(1, 1, 0, 2)], 1, 0, -5)).toBeNull(); // clamped to 0: 0..2 overlaps 1..5
  });
});

it('toPositions maps to pos', () => {
  expect(toPositions([P(4, 1, 7, 3)])).toEqual([{ idx: 4, pos: { row: 1, x: 7 } }]);
});

it('toPositions clamps a drawn x past MAX_X (drawn there, not moved): the saved layout stays valid', () => {
  expect(toPositions([P(4, 1, MAX_X + 7, 3)])).toEqual([{ idx: 4, pos: { row: 1, x: MAX_X } }]);
});

describe('inBounds', () => {
  it('row_past_max_row_is_out', () => {
    expect(inBounds([P(0, MAX_ROW, 0, 1)])).toBe(true);
    expect(inBounds([P(0, MAX_ROW + 1, 0, 1)])).toBe(false);
    // A move to a 33rd row (row 32 is past the last) is out.
    const full = Array.from({ length: MAX_ROW + 1 }, (_, i) => P(i, i, 0, 1)).concat(P(99, 0, 5, 1));
    expect(inBounds(moveTo(full, 99, MAX_ROW + 1, 0)!)).toBe(false);
  });
  it('only_moved_panels_are_checked', () => {
    // C already sits past 1000 (appended at the end of the bottom row): moving A elsewhere is fine.
    const base = [P(0, 0, 0, 4), P(1, 1, 0, 4), P(2, 1, MAX_X + 5, 4)];
    expect(inBounds(base)).toBe(false);
    expect(inBounds(moveTo(base, 0, 1, 10)!, base)).toBe(true);
    // C moved (even left) and still past 1000 is out.
    expect(inBounds(moveTo(base, 2, 1, MAX_X + 3)!, base)).toBe(false);
  });
});
