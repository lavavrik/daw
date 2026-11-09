import { describe, it, expect } from 'vitest';
import { fits, flowRack, inBounds, layoutRack, moveTo, nearestFit, toPositions, GAP, GRID, MAX_ROW, MAX_X, type Placed } from './rackLayout';

const widths = (o: Record<number, number>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
const P = (idx: number, row: number, x: number, w: number): Placed => ({ idx, row, x, w });
const by = (p: Placed[], idx: number) => p.find((q) => q.idx === idx)!;

describe('flowRack', () => {
  it('null_until_every_width_is_measured', () => {
    expect(flowRack([0, 1], widths({ 0: 100 }), 50)).toBeNull();
    expect(flowRack([], widths({}), 50)).toBeNull();
  });

  it('wraps_by_idx_on_the_grid', () => {
    // Footprint = width units + GAP: 190 -> 19 + 1, 220 -> 22 + 1; the third would end at 20 + 23 + 22 = 65 > 60: the third wraps.
    const p = flowRack([2, 0, 1], widths({ 0: 190, 1: 220, 2: 220 }), 60)!;
    expect(p).toEqual([P(0, 0, 0, 19), P(1, 0, 20, 22), P(2, 1, 0, 22)]);
    expect(GAP).toBe(1);
  });

  it('every_gap_in_a_row_is_exactly_one_unit', () => {
    // The owner's "uneven spacing": panel widths are whole units (ModulePanel), so the
    // gaps are GAP * GRID = 10 px each, whatever the widths.
    const p = flowRack([0, 1, 2, 3, 4], widths({ 0: 180, 1: 280, 2: 250, 3: 180, 4: 230 }), 200)!;
    expect(p.every((q) => q.row === 0)).toBe(true);
    for (let i = 1; i < p.length; i++) expect(p[i].x - (p[i - 1].x + p[i - 1].w)).toBe(GAP);
    expect(GAP * GRID).toBe(10);
  });

  it('fits_exactly_up_to_the_last_column', () => {
    // 10 + 1 + 10 = 21 columns: fits in 21, wraps in 20 (the trailing gap needs no room).
    expect(flowRack([0, 1], widths({ 0: 100, 1: 100 }), 21)!.map((q) => q.row)).toEqual([0, 0]);
    expect(flowRack([0, 1], widths({ 0: 100, 1: 100 }), 20)!.map((q) => q.row)).toEqual([0, 1]);
  });

  it('a_panel_wider_than_the_rack_gets_its_own_row', () => {
    const p = flowRack([0, 1, 2], widths({ 0: 100, 1: 900, 2: 100 }), 50)!;
    expect(p.map((q) => [q.row, q.x])).toEqual([[0, 0], [1, 0], [2, 0]]);
  });

  it('pinning_the_flow_draws_it_unchanged', () => {
    // The first drag saves the flow placement: drawn from the saved pos it is identical (no jump).
    const w = widths({ 0: 190, 1: 280, 2: 250, 3: 180, 4: 230 });
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
    // idx 2 then 3 (idx order) GAP after idx 1's right edge (2 + 5 + 1 = 8), each GAP after the previous.
    expect(by(p, 2)).toEqual(P(2, 1, 8, 4));
    expect(by(p, 3)).toEqual(P(3, 1, 13, 2));
  });

  it('saved_layout_without_overlap_is_drawn_as_saved', () => {
    const mods = [{ idx: 0, pos: { row: 0, x: 3 } }, { idx: 1, pos: { row: 0, x: 20 } }, { idx: 2, pos: { row: 1, x: 7 } }];
    const p = layoutRack(mods, widths({ 0: 100, 1: 100, 2: 100 }))!;
    expect(p.map((q) => [q.idx, q.row, q.x])).toEqual([[0, 0, 3], [1, 0, 20], [2, 1, 7]]);
  });

  it('saved_overlap_resolves_left_to_right', () => {
    // Older data: A at x 0 was 5 wide, B at x 5; A is now 8 units -> B drawn at 9, GAP after A (and saved there by the next move).
    const p = layoutRack(
      [{ idx: 0, pos: { row: 0, x: 0 } }, { idx: 1, pos: { row: 0, x: 5 } }],
      widths({ 0: 80, 1: 30 }),
    )!;
    expect(by(p, 0).x).toBe(0);
    expect(by(p, 1).x).toBe(9);
    // Deterministic and idempotent: drawing the resolved layout again changes nothing.
    expect(layoutRack(toPositions(p), widths({ 0: 80, 1: 30 }))).toEqual(p);
  });

  it('saved_touching_panels_get_a_gap_cascading_right', () => {
    // Saved before the GAP rule (touching was allowed): drawn GAP apart, the rest of the row follows.
    const p = layoutRack(
      [{ idx: 0, pos: { row: 0, x: 0 } }, { idx: 1, pos: { row: 0, x: 5 } }, { idx: 2, pos: { row: 0, x: 8 } }, { idx: 3, pos: { row: 0, x: 30 } }],
      widths({ 0: 50, 1: 30, 2: 40, 3: 10 }),
    )!;
    expect(p.map((q) => q.x)).toEqual([0, 6, 10, 30]); // 3 is far enough already: it stays
  });

  it('keeps_empty_rows_as_saved', () => {
    // An emptied middle row stays an empty band until Tidy: nothing below it changes row.
    const p = layoutRack([{ idx: 0, pos: { row: 0, x: 0 } }, { idx: 1, pos: { row: 5, x: 0 } }], widths({ 0: 10, 1: 10 }))!;
    expect(by(p, 1).row).toBe(5);
  });
});

describe('fits', () => {
  const row = [P(0, 0, 0, 4), P(1, 0, 10, 4), P(2, 1, 0, 3)];
  it('free_spot_between_neighbours_one_unit_clear', () => {
    expect(fits(row, 2, 0, 5)).toBe(true); // GAP after 0's right edge
    expect(fits(row, 2, 0, 6)).toBe(true); // GAP before 1's left edge (6 + 3 + 1 = 10)
    expect(fits(row, 2, 0, 15)).toBe(true);
  });
  it('touching_does_not_fit', () => {
    expect(fits(row, 2, 0, 4)).toBe(false); // touching 0
    expect(fits(row, 2, 0, 7)).toBe(false); // touching 1
    expect(fits(row, 2, 0, 14)).toBe(false); // touching 1 on the other side
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
  it('snaps_within_reach_one_unit_clear', () => {
    expect(nearestFit(row, 2, 0, 5, 2)).toBe(5);
    expect(nearestFit(row, 2, 0, 4, 2)).toBe(5); // touching 0: one unit clear of it
    expect(nearestFit(row, 2, 0, 8, 2)).toBe(6); // a near miss into 1 (6 + 3 + 1 = 10)
  });
  it('null_when_no_spot_in_reach', () => {
    expect(nearestFit([P(0, 0, 0, 10), P(1, 1, 0, 3)], 1, 0, 3, 2)).toBeNull();
  });
  it('ties_go_left', () => {
    // x 9 is too close to module 1 (9..10); 7 and 11 are both free, two units away: 7 wins.
    const s = [P(0, 0, 0, 4), P(1, 0, 9, 1), P(2, 0, 15, 4), P(3, 1, 0, 1)];
    expect(fits(s, 3, 0, 7)).toBe(true);
    expect(fits(s, 3, 0, 11)).toBe(true);
    expect(nearestFit(s, 3, 0, 9, 2)).toBe(7);
  });
  it('never_past_max_x', () => {
    // At MAX_X with the spots to the left taken: x + 1 / + 2 would be out of the saved bounds.
    const s = [P(0, 0, MAX_X - 4, 3), P(1, 1, 0, 2)];
    expect(nearestFit(s, 1, 0, MAX_X, 2)).toBe(MAX_X);
    expect(nearestFit([P(0, 0, MAX_X - 4, 5), P(1, 1, 0, 2)], 1, 0, MAX_X, 2)).toBeNull();
  });
});

describe('moveTo', () => {
  const start = [P(0, 0, 0, 4), P(1, 0, 5, 4), P(2, 0, 10, 4), P(3, 1, 0, 3)];

  it('moves_only_the_module_into_a_free_spot', () => {
    const r = moveTo(start, 3, 0, 15)!;
    expect(by(r, 3)).toEqual(P(3, 0, 15, 3));
    expect([by(r, 0).x, by(r, 1).x, by(r, 2).x]).toEqual([0, 5, 10]);
  });

  it('overlap_is_refused_nothing_pushed', () => {
    expect(moveTo(start, 3, 0, 1)).toBeNull();
    expect(moveTo(start, 3, 0, 12)).toBeNull();
    expect(moveTo(start, 3, 0, 14)).toBeNull(); // touching 2: refused too
    expect(moveTo(start, 2, 0, 9)).toBeNull(); // a nudge left into the one-unit gap
  });

  it('gap_kept_when_moving_out', () => {
    const r = moveTo(start, 1, 1, 10)!;
    expect(by(r, 0).x).toBe(0);
    expect(by(r, 2).x).toBe(10); // not closed up
    expect(by(r, 1)).toEqual(P(1, 1, 10, 4));
  });

  it('within_own_footprint_is_fine', () => {
    // A slight move right overlaps only the module's own old spot.
    const r = moveTo([P(0, 0, 0, 10), P(1, 0, 20, 4)], 0, 0, 3)!;
    expect(by(r, 0).x).toBe(3);
    expect(by(r, 1).x).toBe(20);
  });

  it('emptied_middle_row_stays', () => {
    const s = [P(0, 0, 0, 4), P(1, 1, 0, 4), P(2, 2, 0, 4)];
    const r = moveTo(s, 1, 0, 6)!; // 6 = 0's right edge + more than GAP
    expect(by(r, 1).row).toBe(0);
    expect(by(r, 2)).toEqual(P(2, 2, 0, 4)); // not renumbered: row 1 is an empty band
  });

  it('drop_below_creates_row', () => {
    const s = [P(0, 0, 0, 4), P(1, 0, 5, 4), P(2, 1, 0, 4)];
    expect(by(moveTo(s, 0, 2, 0)!, 0)).toEqual(P(0, 2, 0, 4));
    expect(by(moveTo(s, 0, 99, 0)!, 0).row).toBe(2);
  });

  it('a_module_alone_in_the_bottom_row_stays_on_a_new_row_drop', () => {
    // "New row" is one below the others' last row: its own row. No empty row above it.
    const s = [P(0, 0, 0, 4), P(1, 1, 0, 4)];
    expect(moveTo(s, 1, 2, 0)).toEqual(s);
    // Moving it up leaves a trailing empty row: gone, which moves nothing.
    expect(Math.max(...moveTo(s, 1, 0, 5)!.map((q) => q.row))).toBe(0);
  });

  it('x_never_negative', () => {
    expect(by(moveTo([P(0, 0, 3, 4)], 0, 0, -5)!, 0).x).toBe(0);
    expect(by(moveTo([P(0, 0, 3, 4), P(1, 1, 0, 2)], 1, -2, 8)!, 1).row).toBe(0);
    expect(moveTo([P(0, 0, 2, 4), P(1, 1, 0, 2)], 1, 0, -5)).toBeNull(); // clamped to 0: 0..2 touches 2..6
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
