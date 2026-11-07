import { describe, expect, it } from 'vitest';
import {
  BAR, BEAT, barLabelStep, barRange, boxSelect, clampGroupDt, hitTest, laneToY, loopFromDrag, placeLen, repeatTicks,
  resizeLeft, resizeRight, seekTick, snap, snapCeil, snapFloor, tickToX, xToTick, yToLane, zoomAt,
} from './tlMath';
import type { TlView } from './tlMath';
import { MAX_SONG_TICKS } from '../../audio/protocol';

// 1 bar = 96 px at 40 ticks/px; bar 2 (tick 3840) sits at x = 0.
const view: TlView = { ticksPerPx: 40, scrollTick: 3840, laneH: 28 };

describe('geometry', () => {
  it('tick <-> x round-trips (x = 0 is scrollTick)', () => {
    expect(tickToX(3840, view)).toBe(0);
    expect(tickToX(7680, view)).toBe(96);
    expect(xToTick(48, view)).toBe(3840 + 1920);
    for (const t of [0, 960, 1234, 3840, 15359, 999 * 3840]) expect(xToTick(tickToX(t, view), view)).toBeCloseTo(t, 9);
    for (const x of [-10, 0, 33.5, 700]) expect(tickToX(xToTick(x, view), view)).toBeCloseTo(x, 9);
  });

  it('lane <-> y: lane i covers [i*laneH, (i+1)*laneH)', () => {
    expect(laneToY(0, view)).toBe(0);
    expect(laneToY(3, view)).toBe(84);
    for (const l of [0, 1, 5, 31]) {
      expect(yToLane(laneToY(l, view), view)).toBe(l);
      expect(yToLane(laneToY(l, view) + 27.99, view)).toBe(l);
    }
    expect(yToLane(-1, view)).toBe(-1);
  });
});

describe('snap', () => {
  it('to the bar and the beat', () => {
    expect(snap(1919, BAR)).toBe(0);
    expect(snap(1920, BAR)).toBe(BAR);
    expect(snapFloor(7679, BAR)).toBe(BAR);
    expect(snapCeil(3841, BAR)).toBe(2 * BAR);
    expect(snapCeil(3840, BAR)).toBe(BAR);
    expect(snap(1400, BEAT)).toBe(960);
    expect(snap(1500, BEAT)).toBe(1920);
    expect(snapFloor(1919, BEAT)).toBe(960);
  });

  it('seekTick: nearest beat, Alt = free (rounded), never negative', () => {
    expect(seekTick(1400, false)).toBe(960);
    expect(seekTick(1400.4, true)).toBe(1400);
    expect(seekTick(-300, false)).toBe(0);
    expect(seekTick(-300, true)).toBe(0);
    expect(seekTick(MAX_SONG_TICKS + 5000, false)).toBe(MAX_SONG_TICKS);
  });

  it('loopFromDrag: whole bars covering both ends, at least one bar, either direction', () => {
    expect(loopFromDrag(3900, 8000)).toEqual({ start: BAR, end: 3 * BAR }); // bars 2-3
    expect(loopFromDrag(8000, 3900)).toEqual({ start: BAR, end: 3 * BAR });
    expect(loopFromDrag(4000, 4100)).toEqual({ start: BAR, end: 2 * BAR }); // inside one bar
    expect(loopFromDrag(3840, 3840)).toEqual({ start: BAR, end: 2 * BAR }); // on a bar line
    expect(loopFromDrag(-500, 100)).toEqual({ start: 0, end: BAR });
    expect(loopFromDrag(MAX_SONG_TICKS - 10, MAX_SONG_TICKS + 99999).end).toBe(MAX_SONG_TICKS);
  });
});

describe('hitTest', () => {
  // Lane 1, bar 2 (x 0..96), and a short one in lane 0.
  const clips = [
    { id: 'a', lane: 1, start: 3840, len: 3840 },
    { id: 's', lane: 0, start: 7680, len: 240 }, // 6 px wide
  ];
  const y1 = laneToY(1, view) + 10;

  it('body, left edge and right edge (6 px zones)', () => {
    expect(hitTest(clips, 3, y1, view)).toEqual({ id: 'a', part: 'left' });
    expect(hitTest(clips, 5.9, y1, view)).toEqual({ id: 'a', part: 'left' });
    expect(hitTest(clips, 6.1, y1, view)).toEqual({ id: 'a', part: 'body' });
    expect(hitTest(clips, 48, y1, view)).toEqual({ id: 'a', part: 'body' });
    expect(hitTest(clips, 90.1, y1, view)).toEqual({ id: 'a', part: 'right' });
    expect(hitTest(clips, 95.9, y1, view)).toEqual({ id: 'a', part: 'right' });
  });

  it('misses: outside in x, other lane', () => {
    expect(hitTest(clips, 96.1, y1, view)).toBeNull();
    expect(hitTest(clips, -0.1, y1, view)).toBeNull();
    expect(hitTest(clips, 48, laneToY(2, view) + 5, view)).toBeNull();
  });

  it('a short clip keeps a body (each edge zone is at most a third)', () => {
    const y0 = laneToY(0, view) + 10;
    expect(hitTest(clips, 96 + 3, y0, view)?.part).toBe('body');
    expect(hitTest(clips, 96 + 0.5, y0, view)?.part).toBe('left');
    expect(hitTest(clips, 96 + 5.5, y0, view)?.part).toBe('right');
  });

  it('the last (topmost-drawn) clip wins on overlap', () => {
    const two = [
      { id: 'under', lane: 0, start: 3840, len: 7680 },
      { id: 'over', lane: 0, start: 3840, len: 3840 },
    ];
    expect(hitTest(two, 30, 10, view)?.id).toBe('over');
    expect(hitTest(two, 150, 10, view)?.id).toBe('under');
  });
});

describe('clip edits', () => {
  it('repeatTicks: pattern restarts strictly inside the clip, honouring the offset', () => {
    expect(repeatTicks(0, 4 * BAR, 0, BAR)).toEqual([BAR, 2 * BAR, 3 * BAR]);
    expect(repeatTicks(0, BAR, 0, BAR)).toEqual([]);
    expect(repeatTicks(BAR, 2 * BAR, 960, BAR)).toEqual([BAR + 2880, BAR + 2880 + BAR]);
    expect(repeatTicks(0, 2 * BAR, BAR + 960, BAR)).toEqual([2880, 2880 + BAR]); // offset past one length
    expect(repeatTicks(0, 1000 * BAR, 0, 240).length).toBeLessThanOrEqual(4096); // capped
  });

  it('resizeLeft keeps the content in place (offset follows, wraps mod the pattern)', () => {
    const c = { start: 2 * BAR, len: 2 * BAR, offset: 0 };
    expect(resizeLeft(c, 2 * BAR + 960, BAR, BEAT)).toEqual({ start: 2 * BAR + 960, len: 2 * BAR - 960, offset: 960 });
    expect(resizeLeft(c, BAR + 2880, BAR, BEAT)).toEqual({ start: BAR + 2880, len: 2 * BAR + 960, offset: 2880 });
    expect(resizeLeft(c, -BAR, BAR, BEAT)).toEqual({ start: 0, len: 4 * BAR, offset: 0 }); // clamped at 0
    // never shorter than minLen
    expect(resizeLeft(c, 5 * BAR, BAR, BEAT)).toEqual({ start: 4 * BAR - BEAT, len: BEAT, offset: BAR - BEAT });
  });

  it('resizeRight: length from the new end, at least minLen, inside the song', () => {
    const c = { start: BAR, len: BAR, offset: 0 };
    expect(resizeRight(c, 5 * BAR, BEAT)).toBe(4 * BAR);
    expect(resizeRight(c, BAR + 10, BEAT)).toBe(BEAT);
    expect(resizeRight(c, MAX_SONG_TICKS + BAR, BEAT)).toBe(MAX_SONG_TICKS - BAR);
  });

  it('clampGroupDt keeps the whole group inside 0..MAX_SONG_TICKS', () => {
    const g = [{ start: BAR, len: BAR }, { start: 4 * BAR, len: 2 * BAR }];
    expect(clampGroupDt(g, 960)).toBe(960);
    expect(clampGroupDt(g, -5 * BAR)).toBe(-BAR);
    expect(clampGroupDt(g, MAX_SONG_TICKS)).toBe(MAX_SONG_TICKS - 6 * BAR);
    expect(clampGroupDt([], 960)).toBe(0);
    expect(clampGroupDt(g, -0)).toBe(0);
  });

  it('placeLen: the pattern length, cut at the next clip on the lane', () => {
    const lane = [{ start: 2 * BAR, len: BAR }, { start: 6 * BAR, len: BAR }];
    expect(placeLen(lane, 0, BAR)).toBe(BAR);
    expect(placeLen(lane, 0, 4 * BAR)).toBe(2 * BAR);
    expect(placeLen(lane, 3 * BAR, 4 * BAR)).toBe(3 * BAR);
    expect(placeLen(lane, 7 * BAR, 4 * BAR)).toBe(4 * BAR);
    expect(placeLen([], MAX_SONG_TICKS - BAR, 4 * BAR)).toBe(BAR); // song end
  });

  it('boxSelect: clips whose lane and time span overlap the rectangle', () => {
    const clips = [
      { id: 'a', lane: 0, start: 3840, len: 3840 }, // x 0..96, y 0..28
      { id: 'b', lane: 1, start: 7680, len: 3840 }, // x 96..192, y 28..56
      { id: 'c', lane: 2, start: 3840, len: 960 }, // x 0..24, y 56..84
    ];
    expect(boxSelect(clips, 50, 10, 100, 30, view).sort()).toEqual(['a', 'b']);
    expect(boxSelect(clips, 100, 30, 50, 10, view).sort()).toEqual(['a', 'b']); // any direction
    expect(boxSelect(clips, 30, 0, 90, 100, view)).toEqual(['a']); // c ends at x 24
    expect(boxSelect(clips, 200, 0, 300, 100, view)).toEqual([]);
  });
});

describe('labels and view', () => {
  it('barRange: 1-based, "bar 2" or "bars 1–4" (partial bars count)', () => {
    expect(barRange(0, BAR)).toBe('bar 1');
    expect(barRange(0, 4 * BAR)).toBe('bars 1–4');
    expect(barRange(BAR + 960, BAR)).toBe('bars 2–3');
  });

  it('barLabelStep: bars per label so labels sit >= 28 px apart', () => {
    expect(barLabelStep(10)).toBe(1); // 384 px per bar
    expect(barLabelStep(3840 / 28)).toBe(1);
    expect(barLabelStep(3840 / 20)).toBe(2);
    expect(barLabelStep(3840 / 5)).toBe(8);
  });

  it('zoomAt keeps the tick under the pointer and clamps', () => {
    const lim = { minTpp: 2, maxTpp: 400 };
    const z = zoomAt(view, 0.5, 200, lim);
    expect(z.ticksPerPx).toBe(20);
    expect(xToTick(200, z)).toBeCloseTo(xToTick(200, view), 9);
    expect(zoomAt(view, 0.0001, 200, lim).ticksPerPx).toBe(2);
    expect(zoomAt(view, 1e6, 200, lim).ticksPerPx).toBe(400);
    expect(zoomAt({ ...view, scrollTick: 0 }, 2, 200, lim).scrollTick).toBe(0); // never below 0
  });
});
