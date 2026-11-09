import { describe, expect, it } from 'vitest';
import {
  AUTO_H, BAR, BEAT, LANE_H, LANE_MAX_H, LANE_MIN_H, MASTER_ROW, barLabelStep, barRange, boxSelect, clampGroupDt, hitTest, loopFromDrag, placeLen,
  clipLaneAt, followPage, lanePolyline, pointBox, pointHit, segmentHit, curveDrag, CURVE_PX, posToY, repeatTicks, resizeLeft, resizeRight, rowAt, rowLayout, rowsHeight, seekTick, snap, snapCeil,
  snapFloor, tickToX, xToTick, yToPos, zoomAt, audioEdges, audioMarks, dropTarget, fileTicks, drumPreview, notePreview, periodStarts,
  RULER_H, RULER_BAR_H, RULER_TIME_H, TIME_LABEL_MIN_PX, clockLabel, posReadout, tickSeconds, timeLabelStep, timeLabels,
  dropGap, gapIndex, gapY, trackBlocks,
} from './tlMath';
import { mixParam } from '../../audio/mixerCatalog';
import { moduleDef } from '../../audio/catalog';
import { laneValueAt } from '../../state/automation';
import { fromPos, toPos } from '../rack/knobMath';
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

  it('the ruler is two rows: BAR over TIME', () => {
    expect(RULER_BAR_H).toBe(18);
    expect(RULER_TIME_H).toBe(14);
    expect(RULER_H).toBe(32);
  });

  it('tickSeconds: song ticks to seconds at a tempo', () => {
    expect(tickSeconds(BEAT, 120)).toBe(0.5);
    expect(tickSeconds(31 * BAR, 124)).toBe(60); // bar 32 starts at 1:00 at 124 BPM
    expect(tickSeconds(0, 90)).toBe(0);
  });

  it('timeLabelStep: the smallest of 1/2/5/10/15/30 s, 1/2/5/10… min that keeps labels >= 48 px apart', () => {
    // 120 BPM: 1920 ticks per second.
    expect(timeLabelStep(1920 / 100, 120)).toBe(1); // 100 px per second
    expect(timeLabelStep(1920 / 48, 120)).toBe(1); // exactly 48 px
    expect(timeLabelStep(1920 / 47, 120)).toBe(2);
    expect(timeLabelStep(1920 / 20, 120)).toBe(5); // 2 s = 40 px, 5 s = 100 px
    expect(timeLabelStep(1920 / 4, 120)).toBe(15); // 10 s = 40 px, 15 s = 60 px
    expect(timeLabelStep(1920 / 1, 120)).toBe(60); // 30 s = 30 px
    expect(timeLabelStep(1920 / 0.3, 120)).toBe(300); // 2 min = 36 px
    // The zoom is in ticks: a faster tempo packs more ticks into a second, so seconds are wider.
    expect(timeLabelStep(1920 / 47, 240)).toBe(1); // 94 px per second
    expect(timeLabelStep(1920 / 47, 60)).toBe(5); // 23.5 px per second: 2 s = 47 px
    // Never runs off the ladder: the most zoomed-out view still gets a step.
    expect(timeLabelStep(1e9, 120)).toBeGreaterThan(0);
    for (const tpp of [2, 7, 40, 133, 400]) for (const bpm of [60, 124, 200]) {
      const step = timeLabelStep(tpp, bpm);
      expect(fileTicks(step, bpm) / tpp).toBeGreaterThanOrEqual(TIME_LABEL_MIN_PX);
    }
  });

  it('clockLabel: m:ss, rounded to the second', () => {
    expect(clockLabel(0)).toBe('0:00');
    expect(clockLabel(5)).toBe('0:05');
    expect(clockLabel(59.9999)).toBe('1:00');
    expect(clockLabel(60)).toBe('1:00');
    expect(clockLabel(754)).toBe('12:34');
    expect(clockLabel(3600)).toBe('60:00');
  });

  it('timeLabels: one label per step in [t0, t1], at the exact tick of that second', () => {
    // 124 BPM, zoomed so a minute is in view: bar 32 (tick 31 * BAR) reads 1:00.
    const tpp = (40 * BAR) / 1000; // 40 bars over 1000 px
    const step = timeLabelStep(tpp, 124);
    const ls = timeLabels(0, 40 * BAR, tpp, 124);
    expect(ls[0]).toEqual({ t: 0, text: '0:00' });
    expect(ls.find((l) => l.text === '1:00')?.t).toBe(31 * BAR);
    expect(ls[1].t - ls[0].t).toBeCloseTo(fileTicks(step, 124));
    // A scrolled view starts at the first label at or after t0.
    const later = timeLabels(10 * BAR, 20 * BAR, tpp, 124);
    expect(later[0].t).toBeGreaterThanOrEqual(10 * BAR);
    expect(later[0].t - fileTicks(step, 124)).toBeLessThan(10 * BAR);
    expect(later.at(-1)!.t).toBeLessThanOrEqual(20 * BAR);
  });

  it('posReadout: "Bar b.beat · m:ss.t" (1-based bar and beat; tenths floored)', () => {
    expect(posReadout(0, 120)).toBe('Bar 1.1 · 0:00.0');
    // Bar 5, beat 3 at 100 BPM: 18 beats = 10.8 s.
    expect(posReadout(4 * BAR + 2 * BEAT, 100)).toBe('Bar 5.3 · 0:10.8');
    expect(posReadout(4 * BAR + 2 * BEAT + BEAT - 1, 120)).toBe('Bar 5.3 · 0:09.4'); // still beat 3; 9.4997 s
    expect(posReadout(31 * BAR, 124)).toBe('Bar 32.1 · 1:00.0');
    expect(posReadout(-5, 120)).toBe('Bar 1.1 · 0:00.0'); // never negative
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

  it('rows_use_lane_height', () => {
    // Plan 19: each lane row is as tall as laneH(laneId) says (laneView.laneHeight);
    // the empty-lane placeholder row (no laneId) and the default are AUTO_H.
    expect([LANE_MIN_H, AUTO_H, LANE_MAX_H]).toEqual([32, 48, 240]);
    const tracks = [tr('a', ['a1', 'a2']), tr('b'), tr('c')];
    const hs: Record<string, number> = { a1: 160, m1: 32 };
    const laneH = (id: string) => hs[id] ?? AUTO_H;
    const rows = rowLayout(tracks, new Set(['a', 'b']), [{ id: 'm1' }], laneH).map((r) => [r.kind, r.trackId, r.laneId, r.y, r.h]);
    expect(rows).toEqual([
      ['clips', 'a', undefined, 0, LANE_H], ['lane', 'a', 'a1', 28, 160], ['lane', 'a', 'a2', 188, AUTO_H],
      ['clips', 'b', undefined, 236, LANE_H], ['lane', 'b', undefined, 264, AUTO_H],
      ['clips', 'c', undefined, 312, LANE_H], ['master', MASTER_ROW, undefined, 340, LANE_H],
    ]);
    const open = rowLayout(tracks, new Set([MASTER_ROW]), [{ id: 'm1' }], laneH);
    expect(open.at(-1)).toMatchObject({ kind: 'lane', laneId: 'm1', y: 112, h: 32 });
    expect(rowsHeight(open)).toBe(144);
    // The hit tests go through the same rows: a y deep in the tall lane is still that lane.
    const tall = rowLayout(tracks, new Set(['a']), null, laneH);
    expect(rowAt(tall, 28 + 150)?.laneId).toBe('a1');
    expect(clipLaneAt(tall, 28 + 150)).toBe(-1);
    expect(clipLaneAt(tall, 28 + 160 + AUTO_H + 1)).toBe(1);
  });

  it('point and segment hits use the row height they are given (a 160 px lane)', () => {
    const def = mixParam('pan'); // -1..1, linear
    const h = 160;
    const lane = { def, points: [{ id: 'q', tick: 3840, value: -0.5, hold: false, curve: 0 }, { id: 'r', tick: 3840 + 4800, value: 0.5, hold: false, curve: 0 }] };
    const yq = posToY(0.25, h);
    expect(yq).toBe(6 + 0.75 * 148);
    expect(yToPos(yq, h)).toBeCloseTo(0.25, 9);
    expect(pointHit(lane, 0, yq, view, h)).toBe('q');
    expect(pointHit(lane, 0, yq, view, AUTO_H)).toBeNull(); // 48 px maths would look ~80 px higher
    expect(pointBox(lane, -5, yq - 5, 5, yq + 5, view, h)).toEqual(['q']);
    // Halfway along the straight q..r segment (x 0..120): its line sits at position 0.5.
    expect(segmentHit(lane, 60, posToY(0.5, h), view, h)).toBe('q');
    expect(segmentHit(lane, 60, posToY(0.5, h) + 12, view, h)).toBeNull();
    const line = lanePolyline(lane.points, def, view, 200, h);
    expect(line[1]).toEqual([0, yq]);
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
    const def = mixParam('fader'); // -60..6 dB on the fader taper
    const mid = fromPos(def, 0.5); // the lane's vertical middle
    const lane = {
      def,
      points: [
        { id: 'p0', tick: 3840, value: -60 }, // x 0, bottom
        { id: 'p1', tick: 3840 + 960, value: 6 }, // x 24, top
        { id: 'p2', tick: 3840 + 1920, value: mid }, // x 48, middle
      ],
    };
    const H = AUTO_H;
    const yMid = posToY(0.5, H);
    expect(posToY(1, H)).toBeLessThan(posToY(0, H));
    expect(yToPos(posToY(0.25, H), H)).toBeCloseTo(0.25, 9);
    expect(yToPos(-100, H)).toBe(1);
    expect(yToPos(1000, H)).toBe(0);
    expect(pointHit(lane, 0, posToY(0, H), view, H)).toBe('p0');
    expect(pointHit(lane, 24 + 3, posToY(1, H) + 3, view, H)).toBe('p1'); // within the grab radius
    expect(pointHit(lane, 48, yMid, view, H)).toBe('p2');
    expect(pointHit(lane, 36, yMid, view, H)).toBeNull(); // between points
    expect(pointHit(lane, 48, posToY(1, H), view, H)).toBeNull(); // right tick, wrong value
    // Two points within reach: the nearer wins.
    const close = { def, points: [{ id: 'a', tick: 3840, value: mid }, { id: 'b', tick: 3840 + 160, value: mid }] }; // 4 px apart
    expect(pointHit(close, 1, yMid, view, H)).toBe('a');
    expect(pointHit(close, 3, yMid, view, H)).toBe('b');
    // Box select: the points inside the rectangle, any corner order.
    expect(pointBox(lane, -5, 0, 30, H, view, H).sort()).toEqual(['p0', 'p1']);
    expect(pointBox(lane, 60, H, 20, yMid - 2, view, H)).toEqual(['p2']);
    expect(pointBox(lane, 20, yMid + 2, 60, H, view, H)).toEqual([]);
    // Exp params place points by knob position (log), as the lane is drawn.
    const hz = mixParam('eq_mid_freq'); // 200..8000 Hz
    const exp = { def: hz, points: [{ id: 'k', tick: 3840, value: Math.sqrt(200 * 8000) }] };
    expect(pointHit(exp, 0, yMid, view, H)).toBe('k');
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
        const line = lanePolyline(points, def, v, W, AUTO_H);
        let worst = 0;
        for (let x = 0.25; x < W; x += 0.5) {
          const want = posToY(toPos(def, laneValueAt(points, x * v.ticksPerPx, def)!), AUTO_H);
          worst = Math.max(worst, Math.abs(yAt(line, x) - want));
        }
        expect(worst, `${def.name} curve ${c}`).toBeLessThan(0.5);
        // Off-screen parts are not sampled: a long segment costs about one vertex per pixel at most.
        expect(line.length).toBeLessThan(2 * W);
      }
    }
    // A segment far wider than the view (zoomed in) stays cheap.
    const far = lanePolyline([{ tick: 0, value: -60, hold: false, curve: 1 }, { tick: 10_000_000, value: 6, hold: false }], mixParam('fader'), v, W, AUTO_H);
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
    const line = lanePolyline(points, def, v, 600, AUTO_H);
    // On the bent line between a and b (x 100..300): a.
    expect(segmentHit(lane, 200, yAt(line, 200), v, AUTO_H)).toBe('a');
    expect(segmentHit(lane, 200, yAt(line, 200) + 4, v, AUTO_H)).toBe('a');
    expect(segmentHit(lane, 200, yAt(line, 200) + 12, v, AUTO_H)).toBeNull();
    // b holds: its flat run is no curve to bend.
    expect(segmentHit(lane, 400, posToY(toPos(def, 6), AUTO_H), v, AUTO_H)).toBeNull();
    // Before the first point and after the last: no segment.
    expect(segmentHit(lane, 50, posToY(toPos(def, -60), AUTO_H), v, AUTO_H)).toBeNull();
    expect(segmentHit(lane, 550, posToY(toPos(def, -30), AUTO_H), v, AUTO_H)).toBeNull();
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
      const line = lanePolyline(points, def, v, W, AUTO_H);
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
        const want = posToY(toPos(def, laneValueAt(points, x * v.ticksPerPx, def)!), AUTO_H);
        expect(Math.abs(yAt(x) - want)).toBeLessThan(def === glide ? 1 : 1e-6);
      }
    }
  });
});

describe('clip previews (plan 20)', () => {
  it('drumPreview: a mark per hit, one band per row that has a hit (rows without hits take no space)', () => {
    const steps = [
      [127, 0, 0, 0, 99], // step 4 is past stepCount: not shown
      [0, 0, 0, 0],
      [0, 64, 0, 1],
      [127, 127, 127, 127], // past the track's rows: not shown
    ];
    expect(drumPreview(steps, 3, 4)).toEqual([
      { t0: 0, t1: 0.25, y: 0, h: 0.5 },
      { t0: 0.25, t1: 0.5, y: 0.5, h: 0.5 },
      { t0: 0.75, t1: 1, y: 0.5, h: 0.5 },
    ]);
    expect(drumPreview([[0, 0], [0, 0]], 2, 16)).toEqual([]);
  });

  it('notePreview: a dash per note in the loop, at its pitch (highest on top), cut at the loop end', () => {
    const marks = notePreview([
      { pitch: 60, start: 0, len: BEAT },
      { pitch: 64, start: 2 * BEAT, len: BAR }, // runs past the 1-bar loop: cut at its end
      { pitch: 72, start: BAR, len: BEAT }, // starts after the loop: not played, not shown
    ], 1);
    expect(marks).toEqual([
      { t0: 0, t1: 0.25, y: 0.8, h: 0.2 },
      { t0: 0.5, t1: 1, y: 0, h: 0.2 },
    ]);
    // A narrow range is centred in at least 4 pitch rows (one pitch is not a full-height bar).
    expect(notePreview([{ pitch: 60, start: 0, len: BEAT }], 2)).toEqual([{ t0: 0, t1: 0.125, y: 0.25, h: 0.25 }]);
    expect(notePreview([], 1)).toEqual([]);
  });

  it('periodStarts: the pattern periods of a clip that overlap a tick range', () => {
    // Starts at bar 2 with a 1-beat offset: the pattern began a beat before the clip.
    expect(periodStarts(BAR, 3 * BAR, BEAT, BAR, 0, Infinity)).toEqual([BAR - BEAT, 2 * BAR - BEAT, 3 * BAR - BEAT, 4 * BAR - BEAT]);
    expect(periodStarts(BAR, 3 * BAR, BEAT, BAR, 7000, 9000)).toEqual([2 * BAR - BEAT]);
    expect(periodStarts(BAR, 3 * BAR, 0, BAR, 0, BAR)).toEqual([]); // the range ends where the clip starts
    expect(periodStarts(0, BAR, 0, 0, 0, Infinity)).toEqual([]);
  });
});

describe('track reorder geometry (plan 22 Task 4)', () => {
  // a (open: two lanes, the second 60 px), b (closed), c (open, no lane yet: one empty row), then the Master row.
  const rows = rowLayout([tr('a', ['l1', 'l2']), tr('b'), tr('c')], new Set(['a', 'c']), [], (id) => (id === 'l2' ? 60 : AUTO_H));
  const blocks = trackBlocks(rows);

  it('a block is the track header and its lane rows; the Master row is no block', () => {
    expect(blocks).toEqual([
      { trackId: 'a', top: 0, bottom: LANE_H + AUTO_H + 60 },
      { trackId: 'b', top: LANE_H + AUTO_H + 60, bottom: 2 * LANE_H + AUTO_H + 60 },
      { trackId: 'c', top: 2 * LANE_H + AUTO_H + 60, bottom: 3 * LANE_H + 2 * AUTO_H + 60 },
    ]);
    expect(trackBlocks([])).toEqual([]);
  });

  it('dropGap: how many blocks have their middle above y', () => {
    const [a, b, c] = blocks;
    expect(dropGap(blocks, -50)).toBe(0);
    expect(dropGap(blocks, (a.top + a.bottom) / 2 - 1)).toBe(0);
    expect(dropGap(blocks, (a.top + a.bottom) / 2 + 1)).toBe(1);
    expect(dropGap(blocks, (b.top + b.bottom) / 2 + 1)).toBe(2);
    expect(dropGap(blocks, (c.top + c.bottom) / 2 + 1)).toBe(3);
    expect(dropGap(blocks, 1e6)).toBe(3); // over the Master row and beyond: after the last track
  });

  it('gapY: the top of the block under the gap, the last bottom after the last', () => {
    expect([0, 1, 2, 3].map((g) => gapY(blocks, g))).toEqual([0, blocks[1].top, blocks[2].top, blocks[2].bottom]);
    expect(gapY([], 0)).toBe(0);
  });

  it('gapIndex: where the dragged track lands (its own two gaps are no move)', () => {
    // Track 2 of 3 (index 1): gaps 1 and 2 are its own edges.
    expect([0, 1, 2, 3].map((g) => gapIndex(1, g))).toEqual([0, 1, 1, 2]);
    expect(gapIndex(2, 0)).toBe(0); // the third track above the first
    expect(gapIndex(0, 3)).toBe(2); // the first under the last
  });
});
