import { beforeEach, describe, expect, it } from 'vitest';
import { laneHeight, laneView, setLaneHeight } from './laneView.svelte';
import { AUTO_H, LANE_MAX_H, LANE_MIN_H, rowLayout } from './tlMath';

// Lane heights (plan 19): UI state keyed by lane id, clamped, never saved.
describe('lane heights', () => {
  beforeEach(() => {
    laneView.heights = new Map();
  });

  it('set_height_clamps', () => {
    expect(laneHeight('a')).toBe(AUTO_H);
    setLaneHeight('a', 10);
    expect(laneHeight('a')).toBe(LANE_MIN_H);
    setLaneHeight('a', 999);
    expect(laneHeight('a')).toBe(LANE_MAX_H);
    setLaneHeight('a', NaN);
    expect(laneHeight('a')).toBe(AUTO_H);
    setLaneHeight('a', 100.4); // whole pixels
    expect(laneHeight('a')).toBe(100);
    setLaneHeight('a', Infinity);
    expect(laneHeight('a')).toBe(AUTO_H);
    // The default is not stored: the map holds only lanes someone resized.
    setLaneHeight('a', AUTO_H);
    expect(laneView.heights.has('a')).toBe(false);
  });

  it('stale_id_ignored', () => {
    setLaneHeight('gone', 200); // a lane since removed (or never there)
    expect(laneHeight('nope')).toBe(AUTO_H);
    const rows = rowLayout([{ id: 't', automation: [{ id: 'l1' }] }], new Set(['t']), null, laneHeight);
    expect(rows.map((r) => r.h)).toEqual([28, AUTO_H]);
    // Its own lane id still finds it (an undo that brings the lane back gets its height back).
    expect(laneHeight('gone')).toBe(200);
  });
});
