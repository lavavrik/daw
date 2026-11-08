import { describe, expect, it } from 'vitest';
import {
  AUTO_H, BAR, BEAT, LANE_H, MASTER_ROW, barLabelStep, barRange, boxSelect, clampGroupDt, hitTest, loopFromDrag, placeLen,
  followPage, lanePolyline, pointBox, pointHit, segmentHit, curveDrag, CURVE_PX, posToY, repeatTicks, resizeLeft, resizeRight, rowAt, rowLayout, rowsHeight, seekTick, snap, snapCeil,
  snapFloor, tickToX, xToTick, yToPos, zoomAt, audioEdges, audioMarks, dropTarget, fileTicks,
} from './tlMath';
import { mixParam } from '../../audio/mixerCatalog';
import { moduleDef } from '../../audio/catalog';
import { laneValueAt } from '../../state/automation';
import { toPos } from '../rack/knobMath';
import type { TlView } from './tlMath';
import { MAX_SONG_TICKS } from '../../audio/protocol';

// 1 bar = 96 px at 40 ticks/px; bar 2 (tick 3840) sits at x = 0.
const view: TlView = { ticksPerPx: 40, scrollTick: 3840 };
const tr = (id: string, lanes: string[] = []) => ({ id, automation: lanes.map((l) => ({ id: l })) });
/** n tracks without open lanes: the plain uniform layout. */
const uniform = (n: number) => rowLayout(Array.from({ length: n }, (_, i) => tr(`t${i}`)), new Set(), null);
const laneToY = (l: number) => l * LANE_H;

describe('geometry', () => {
  it('tick <-> x round-trips (x = 0 is scrollTick)', () => {
    expect(tickToX(3840, view)).toBe(0);
    expect(tickToX(7680, view)).toBe(96);
    expect(xToTick(48, view)).toBe(3840 + 1920);
    for (const t of [0, 960, 1234, 3840, 15359, 999 * 3840]) expect(xToTick(tickToX(t, view), view)).toBeCloseTo(t, 9);
    for (const x of [-10, 0, 33.5, 700]) expect(tickToX(xToTick(x, view), view)).toBeCloseTo(x, 9);
  });

  it('no open lanes: track i clip row covers [i*LANE_H, (i+1)*LANE_H)', () => {
    const rows = uniform(32);
    expect(rows[0].y).toBe(0);
    expect(rows[3].y).toBe(84);
    for (const l of [0, 1, 5, 31]) {
      expect(rowAt(rows, l * LANE_H)?.track).toBe(l);
      expect(rowAt(rows, l * LANE_H + 27.99)?.track).toBe(l);
    }
    expect(rowAt(rows, -1)).toBeNull();
    expect(rowAt(rows, 32 * LANE_H)).toBeNull();
    expect(rowsHeight(rows)).toBe(32 * LANE_H);
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

const rows4 = uniform(4);

describe('hitTest', () => {
  // Lane 1, bar 2 (x 0..96), and a short one in lane 0.
  const clips = [
    { id: 'a', lane: 1, start: 3840, len: 3840 },
    { id: 's', lane: 0, start: 7680, len: 240 }, // 6 px wide
  ];
  const y1 = laneToY(1) + 10;

  it('body, left edge and right edge (6 px zones)', () => {
    expect(hitTest(clips, 3, y1, view, rows4)).toEqual({ id: 'a', part: 'left' });
    expect(hitTest(clips, 5.9, y1, view, rows4)).toEqual({ id: 'a', part: 'left' });
    expect(hitTest(clips, 6.1, y1, view, rows4)).toEqual({ id: 'a', part: 'body' });
    expect(hitTest(clips, 48, y1, view, rows4)).toEqual({ id: 'a', part: 'body' });
    expect(hitTest(clips, 90.1, y1, view, rows4)).toEqual({ id: 'a', part: 'right' });
    expect(hitTest(clips, 95.9, y1, view, rows4)).toEqual({ id: 'a', part: 'right' });
  });

  it('misses: outside in x, other lane', () => {
    expect(hitTest(clips, 96.1, y1, view, rows4)).toBeNull();
    expect(hitTest(clips, -0.1, y1, view, rows4)).toBeNull();
    expect(hitTest(clips, 48, laneToY(2) + 5, view, rows4)).toBeNull();
  });

  it('a short clip keeps a body (each edge zone is at most a third)', () => {
    const y0 = laneToY(0) + 10;
    expect(hitTest(clips, 96 + 3, y0, view, rows4)?.part).toBe('body');
    expect(hitTest(clips, 96 + 0.5, y0, view, rows4)?.part).toBe('left');
    expect(hitTest(clips, 96 + 5.5, y0, view, rows4)?.part).toBe('right');
  });

  it('the last (topmost-drawn) clip wins on overlap', () => {
    const two = [
      { id: 'under', lane: 0, start: 3840, len: 7680 },
      { id: 'over', lane: 0, start: 3840, len: 3840 },
    ];
    expect(hitTest(two, 30, 10, view, rows4)?.id).toBe('over');
    expect(hitTest(two, 150, 10, view, rows4)?.id).toBe('under');
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
    expect(boxSelect(clips, 50, 10, 100, 30, view, rows4).sort()).toEqual(['a', 'b']);
    expect(boxSelect(clips, 100, 30, 50, 10, view, rows4).sort()).toEqual(['a', 'b']); // any direction
    expect(boxSelect(clips, 30, 0, 90, 100, view, rows4)).toEqual(['a']); // c ends at x 24
    expect(boxSelect(clips, 200, 0, 300, 100, view, rows4)).toEqual([]);
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

describe('audio lanes (plan 9)', () => {
  it('dropTarget resolves audio lane, new track, refused', () => {
    const tracks = [{ kind: 'drum' }, { kind: 'audio' }, { kind: 'synth' }, { kind: 'audio' }];
    const rows = rows4;
    expect(dropTarget(tracks, rows, 28 + 3)).toEqual({ audioLane: 1 });
    expect(dropTarget(tracks, rows, 3 * 28 + 27.9)).toEqual({ audioLane: 3 });
    expect(dropTarget(tracks, rows, 2)).toEqual({ refused: true }); // drum lane: only a hint
    expect(dropTarget(tracks, rows, 2 * 28 + 1)).toEqual({ refused: true }); // synth lane
    expect(dropTarget(tracks, rows, 4 * 28)).toEqual({ newTrack: true }); // right below the last lane
    expect(dropTarget(tracks, rows, 4000)).toEqual({ newTrack: true });
    expect(dropTarget(tracks, rows, -5)).toEqual({ refused: true }); // over the ruler
    expect(dropTarget([], [], 0)).toEqual({ newTrack: true }); // no tracks: anywhere makes one
  });

  it('dropTarget goes through the layout map: an open automation lane above shifts the audio lane down', () => {
    const tracks = [{ kind: 'audio' }, { kind: 'audio' }];
    const rows = rowLayout([tr('a', ['l1']), tr('b')], new Set(['a']), null);
    expect(dropTarget(tracks, rows, 3)).toEqual({ audioLane: 0 });
    expect(dropTarget(tracks, rows, LANE_H + 10)).toEqual({ refused: true }); // over a's automation lane
    expect(dropTarget(tracks, rows, LANE_H + AUTO_H + 3)).toEqual({ audioLane: 1 });
    expect(dropTarget(tracks, rows, 2 * LANE_H + AUTO_H)).toEqual({ newTrack: true });
    // The Master row (below the tracks) takes no audio either.
    const withMaster = rowLayout([tr('a'), tr('b')], new Set([MASTER_ROW]), [{ id: 'm1' }]);
    expect(dropTarget(tracks, withMaster, 2 * LANE_H + 3)).toEqual({ refused: true });
    expect(dropTarget(tracks, withMaster, 3 * LANE_H + AUTO_H)).toEqual({ newTrack: true });
  });

  it('audio clip edges and file-end mark', () => {
    expect(fileTicks(2, 120)).toBe(3840); // a 2 s file is one bar at 120 BPM
    // One-shot, 0.5 s into a 2 s file: it can be trimmed back 0.5 s and grown to the file's end.
    const shot = { start: 7680, len: 960, offset: 0.5, loop: false };
    expect(audioEdges(shot, 2, 120)).toEqual({ minStart: 7680 - 960, maxEnd: 7680 + 2880 });
    // Near the song start it stops at tick 0.
    expect(audioEdges({ ...shot, start: 100 }, 2, 120).minStart).toBe(0);
    // A loop clip has no file edges: it wraps.
    expect(audioEdges({ ...shot, loop: true }, 2, 120)).toEqual({ minStart: 0, maxEnd: MAX_SONG_TICKS });
    // Unknown length: no file edges either.
    expect(audioEdges(shot, null, 120)).toEqual({ minStart: 0, maxEnd: MAX_SONG_TICKS });

    // Loop clip: a notch every file length, starting where the file wraps.
    const loop = { start: 3840, len: 3 * 3840, offset: 0.5, loop: true };
    expect(audioMarks(loop, 2, 120)).toEqual({ repeats: [3840 + 2880, 3840 + 2880 + 3840, 3840 + 2880 + 7680], fileEnd: null });
    // One-shot whose clip is longer than its file (the tempo went down): the file ends inside it.
    const long = { start: 0, len: 3840 * 2, offset: 0, loop: false };
    expect(audioMarks(long, 2, 120)).toEqual({ repeats: [], fileEnd: 3840 });
    // The file ends at or after the clip end: no mark.
    expect(audioMarks({ ...long, len: 3840 }, 2, 120).fileEnd).toBeNull();
    expect(audioMarks({ ...long, len: 3000 }, 2, 120).fileEnd).toBeNull();
    // Unknown length: nothing to mark.
    expect(audioMarks(loop, null, 120)).toEqual({ repeats: [], fileEnd: null });
  });
});

describe('automation rows (plan 10)', () => {
  it('rowLayout stacks lanes under open tracks', () => {
    const tracks = [tr('a', ['a1', 'a2']), tr('b', ['b1']), tr('c'), tr('d', ['d1'])];
    // Nothing open: one clip row per track, no Master row.
    expect(rowLayout(tracks, new Set(), null).map((r) => [r.kind, r.trackId, r.y, r.h])).toEqual([
      ['clips', 'a', 0, LANE_H], ['clips', 'b', 28, LANE_H], ['clips', 'c', 56, LANE_H], ['clips', 'd', 84, LANE_H],
    ]);
    // a and c open (c has no lanes yet: one empty lane row, without laneId, to add one); b closed.
    const rows = rowLayout(tracks, new Set(['a', 'c']), [{ id: 'm1' }]);
    expect(rows.map((r) => ({ kind: r.kind, trackId: r.trackId, laneId: r.laneId, y: r.y, h: r.h, track: r.track }))).toEqual([
      { kind: 'clips', trackId: 'a', laneId: undefined, y: 0, h: 28, track: 0 },
      { kind: 'lane', trackId: 'a', laneId: 'a1', y: 28, h: 48, track: 0 },
      { kind: 'lane', trackId: 'a', laneId: 'a2', y: 76, h: 48, track: 0 },
      { kind: 'clips', trackId: 'b', laneId: undefined, y: 124, h: 28, track: 1 },
      { kind: 'clips', trackId: 'c', laneId: undefined, y: 152, h: 28, track: 2 },
      { kind: 'lane', trackId: 'c', laneId: undefined, y: 180, h: 48, track: 2 },
      { kind: 'clips', trackId: 'd', laneId: undefined, y: 228, h: 28, track: 3 },
      // The Master row is pinned under the last track; its lanes show only while it is open.
      { kind: 'master', trackId: MASTER_ROW, laneId: undefined, y: 256, h: 28, track: -1 },
    ]);
    expect(AUTO_H).toBe(48);
    expect(rowsHeight(rows)).toBe(284);
    const open = rowLayout(tracks, new Set([MASTER_ROW]), [{ id: 'm1' }, { id: 'm2' }]);
    expect(open.slice(4).map((r) => [r.kind, r.trackId, r.laneId, r.y, r.h])).toEqual([
      ['master', MASTER_ROW, undefined, 112, 28], ['lane', MASTER_ROW, 'm1', 140, 48], ['lane', MASTER_ROW, 'm2', 188, 48],
    ]);
    // rowAt resolves every y to its row, edges included.
    for (const r of rows) {
      expect(rowAt(rows, r.y)).toBe(r);
      expect(rowAt(rows, r.y + r.h - 0.01)).toBe(r);
    }
    expect(rowAt(rows, 284)).toBeNull();
  });

  it('clip hit tests, box select and cross-lane rows go through the layout map', () => {
    const rows = rowLayout([tr('a', ['a1']), tr('b')], new Set(['a']), null);
    const clips = [{ id: 'x', lane: 0, start: 3840, len: 3840 }, { id: 'y', lane: 1, start: 3840, len: 3840 }];
    expect(hitTest(clips, 48, 10, view, rows)?.id).toBe('x');
    expect(hitTest(clips, 48, LANE_H + 10, view, rows)).toBeNull(); // the automation lane is not a clip row
    expect(hitTest(clips, 48, LANE_H + AUTO_H + 10, view, rows)?.id).toBe('y');
    // A box over the automation lane alone selects no clip; one reaching b's row takes y.
    expect(boxSelect(clips, 10, LANE_H + 5, 60, LANE_H + 40, view, rows)).toEqual([]);
    expect(boxSelect(clips, 10, LANE_H + 5, 60, LANE_H + AUTO_H + 5, view, rows)).toEqual(['y']);
    expect(boxSelect(clips, 10, 5, 60, LANE_H + AUTO_H + 5, view, rows).sort()).toEqual(['x', 'y']);
  });

  it('pointHit and box select', () => {
    const def = mixParam('fader'); // -60..6 dB, linear
    const lane = {
      def,
      points: [
        { id: 'p0', tick: 3840, value: -60 }, // x 0, bottom
        { id: 'p1', tick: 3840 + 960, value: 6 }, // x 24, top
        { id: 'p2', tick: 3840 + 1920, value: -27 }, // x 48, middle
      ],
    };
    const yMid = posToY(0.5);
    expect(posToY(1)).toBeLessThan(posToY(0));
    expect(yToPos(posToY(0.25))).toBeCloseTo(0.25, 9);
    expect(yToPos(-100)).toBe(1);
    expect(yToPos(1000)).toBe(0);
    expect(pointHit(lane, 0, posToY(0), view)).toBe('p0');
    expect(pointHit(lane, 24 + 3, posToY(1) + 3, view)).toBe('p1'); // within the grab radius
    expect(pointHit(lane, 48, yMid, view)).toBe('p2');
    expect(pointHit(lane, 36, yMid, view)).toBeNull(); // between points
    expect(pointHit(lane, 48, posToY(1), view)).toBeNull(); // right tick, wrong value
    // Two points within reach: the nearer wins.
    const close = { def, points: [{ id: 'a', tick: 3840, value: -27 }, { id: 'b', tick: 3840 + 160, value: -27 }] }; // 4 px apart
    expect(pointHit(close, 1, yMid, view)).toBe('a');
    expect(pointHit(close, 3, yMid, view)).toBe('b');
    // Box select: the points inside the rectangle, any corner order.
    expect(pointBox(lane, -5, 0, 30, AUTO_H, view).sort()).toEqual(['p0', 'p1']);
    expect(pointBox(lane, 60, AUTO_H, 20, yMid - 2, view)).toEqual(['p2']);
    expect(pointBox(lane, 20, yMid + 2, 60, AUTO_H, view)).toEqual([]);
    // Exp params place points by knob position (log), as the lane is drawn.
    const hz = mixParam('eq_mid_freq'); // 200..8000 Hz
    const exp = { def: hz, points: [{ id: 'k', tick: 3840, value: Math.sqrt(200 * 8000) }] };
    expect(pointHit(exp, 0, yMid, view)).toBe('k');
  });
});

describe('curved segments (plan 16)', () => {
  const v = { ticksPerPx: 10, scrollTick: 0 };
  /** The polyline's y at x (the last vertex at x wins: a hold step is vertical). */
  const yAt = (line: [number, number][], x: number) => {
    for (let i = line.length - 1; i > 0; i--) {
      const [x0, y0] = line[i - 1];
      const [x1, y1] = line[i];
      if (x0 <= x && x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
    return NaN;
  };

  it('lanePolyline draws the bend laneValueAt plays (within half a pixel)', () => {
    const W = 600;
    for (const def of [mixParam('fader'), mixParam('eq_mid_freq')]) {
      for (const c of [-1, -0.5, 0.25, 1]) {
        const points = [
          { tick: 300, value: def.min, hold: false, curve: c },
          { tick: 3300, value: def.max, hold: false, curve: -c },
          { tick: 5200, value: def.min, hold: false, curve: 0 },
        ];
        const line = lanePolyline(points, def, v, W);
        let worst = 0;
        for (let x = 0.25; x < W; x += 0.5) {
          const want = posToY(toPos(def, laneValueAt(points, x * v.ticksPerPx, def)!));
          worst = Math.max(worst, Math.abs(yAt(line, x) - want));
        }
        expect(worst, `${def.name} curve ${c}`).toBeLessThan(0.5);
        // Off-screen parts are not sampled: a long segment costs about one vertex per pixel at most.
        expect(line.length).toBeLessThan(2 * W);
      }
    }
    // A segment far wider than the view (zoomed in) stays cheap.
    const far = lanePolyline([{ tick: 0, value: -60, hold: false, curve: 1 }, { tick: 10_000_000, value: 6, hold: false }], mixParam('fader'), v, W);
    expect(far.length).toBeLessThan(2 * W);
  });

  it('segmentHit finds the curve between two points (not a hold step, not past the ends)', () => {
    const def = mixParam('fader');
    const points = [
      { id: 'a', tick: 1000, value: -60, hold: false, curve: 1 },
      { id: 'b', tick: 3000, value: 6, hold: true, curve: 0 },
      { id: 'c', tick: 5000, value: -30, hold: false, curve: 0 },
    ];
    const lane = { points, def };
    const line = lanePolyline(points, def, v, 600);
    // On the bent line between a and b (x 100..300): a.
    expect(segmentHit(lane, 200, yAt(line, 200), v)).toBe('a');
    expect(segmentHit(lane, 200, yAt(line, 200) + 4, v)).toBe('a');
    expect(segmentHit(lane, 200, yAt(line, 200) + 12, v)).toBeNull();
    // b holds: its flat run is no curve to bend.
    expect(segmentHit(lane, 400, posToY(toPos(def, 6)), v)).toBeNull();
    // Before the first point and after the last: no segment.
    expect(segmentHit(lane, 50, posToY(toPos(def, -60)), v)).toBeNull();
    expect(segmentHit(lane, 550, posToY(toPos(def, -30)), v)).toBeNull();
  });

  it('curveDrag: 100 px is the full range, up bends the line up', () => {
    expect(CURVE_PX).toBe(100);
    // Rising segment: up (dy < 0) is a positive curve (fast, then slow: above the line).
    expect(curveDrag(0, -50, true)).toBe(1);
    expect(curveDrag(-1, -100, true)).toBe(1);
    expect(curveDrag(0, 25, true)).toBe(-0.5);
    // Falling: up is a negative curve (stays high, then drops: above the line too).
    expect(curveDrag(0, -25, false)).toBe(-0.5);
    // Clamped to -1..1, rounded to 0.01.
    expect(curveDrag(0.5, -400, true)).toBe(1);
    expect(curveDrag(0, 1000, true)).toBe(-1);
    expect(curveDrag(0, -0.333, true)).toBe(0.01);
    expect(Object.is(curveDrag(0, 0, true), 0)).toBe(true);
  });
});

describe('play follow and the drawn curve (plan 10 review)', () => {
  it('followPage flips once when the playhead leaves the view, never during a drag', () => {
    const v = { ticksPerPx: 40, scrollTick: 0 }; // 400 px = 16 000 ticks
    expect(followPage(v, 5000, 400, true, false)).toEqual({ scrollTick: null, visible: true });
    // Off the right edge (within 12 px of it counts as off): page to the bar before the playhead.
    expect(followPage(v, 15700, 400, true, false)).toEqual({ scrollTick: 3 * BAR, visible: false });
    // Already off last frame (the user scrolled away): no flip.
    expect(followPage(v, 15700, 400, false, false)).toEqual({ scrollTick: null, visible: false });
    // A drag in progress (a clip, or an AutoLane gesture): no flip, and it stays armed for after the release.
    expect(followPage(v, 15700, 400, true, true)).toEqual({ scrollTick: null, visible: true });
    expect(followPage(v, 15800, 400, true, false).scrollTick).toBe(3 * BAR);
  });

  it('lanePolyline is the curve laneValueAt plays (zero-zone exp params within a pixel)', () => {
    const v = { ticksPerPx: 10, scrollTick: 0 };
    const W = 600;
    const glide = moduleDef('midi_in').params.find((d) => d.name === 'glide')!; // exp, 0..2 s: a zero zone
    const cases = [
      { def: mixParam('fader'), points: [{ tick: 400, value: -40, hold: false }, { tick: 2400, value: 3, hold: true }, { tick: 4000, value: -60, hold: false }] },
      { def: mixParam('eq_mid_freq'), points: [{ tick: 0, value: 200, hold: false }, { tick: 5000, value: 8000, hold: false }] },
      { def: glide, points: [{ tick: 500, value: 0, hold: false }, { tick: 5500, value: 2, hold: false }] },
    ];
    for (const { def, points } of cases) {
      const line = lanePolyline(points, def, v, W);
      expect(line[0][0]).toBeLessThan(0);
      expect(line.at(-1)![0]).toBeGreaterThan(W);
      /** The polyline's y at x (the last vertex at x wins: a hold step is vertical). */
      const yAt = (x: number) => {
        for (let i = line.length - 1; i > 0; i--) {
          const [x0, y0] = line[i - 1];
          const [x1, y1] = line[i];
          if (x0 <= x && x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
        }
        return NaN;
      };
      for (let x = 0.5; x < W; x += 3) {
        const at = points.some((pt) => Math.abs(pt.tick / v.ticksPerPx - x) < 1) ? null : x;
        if (at === null) continue; // right at a hold step
        const want = posToY(toPos(def, laneValueAt(points, x * v.ticksPerPx, def)!));
        expect(Math.abs(yAt(x) - want)).toBeLessThan(def === glide ? 1 : 1e-6);
      }
    }
  });
});
