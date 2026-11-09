import { describe, expect, it } from 'vitest';
import {
  MAX_ROW_H, MIN_ROW_H, chordStampPitches, clampMove, fitView, zoomRows, formatLen, formatPos, hitTest, initialView, keyRow, movedPitch, noteName, pitchToY, readout, snap, snapFloor, stretchLen, stretchReadout,
  tickToX, xToTick, yToPitch, zoomAt,
} from './prMath';
import type { View } from './prMath';

const view: View = { ticksPerPx: 20, scrollTick: 960, rowH: 12, topPitch: 72, keysW: 48 };

describe('geometry', () => {
  it('x round-trips through ticks (keyboard offset + scroll)', () => {
    expect(tickToX(960, view)).toBe(48); // scrollTick sits at the keyboard edge
    expect(tickToX(960 + 240, view)).toBe(48 + 12);
    for (const t of [0, 960, 1234, 3840, 15359]) expect(xToTick(tickToX(t, view), view)).toBeCloseTo(t, 9);
    for (const x of [48, 60, 333.5]) expect(tickToX(xToTick(x, view), view)).toBeCloseTo(x, 9);
  });

  it('y round-trips through pitches (top pitch is row 0)', () => {
    expect(pitchToY(72, view)).toBe(0);
    expect(pitchToY(71, view)).toBe(12);
    for (const p of [0, 36, 60, 72, 127]) {
      expect(yToPitch(pitchToY(p, view), view)).toBe(p); // row top edge
      expect(yToPitch(pitchToY(p, view) + view.rowH - 0.01, view)).toBe(p); // bottom edge
    }
  });
});

describe('snap', () => {
  it('snap rounds to the nearest grid line, snapFloor floors', () => {
    expect(snap(119, 240)).toBe(0);
    expect(snap(120, 240)).toBe(240);
    expect(snap(500, 240)).toBe(480);
    expect(snapFloor(479, 240)).toBe(240);
    expect(snapFloor(480, 240)).toBe(480);
    expect(snap(330, 320)).toBe(320); // triplet grid
  });
});

describe('hitTest', () => {
  // C4 at 1.1.1 (start 960 = scroll edge), 1/4 long = 48 px wide at 20 ticks/px.
  const notes = [{ id: 'a', pitch: 60, start: 960, len: 960 }];
  const y60 = pitchToY(60, view) + 6;

  it('body vs end (the last 6 px)', () => {
    expect(hitTest(notes, 49, y60, view)).toEqual({ id: 'a', part: 'body' });
    expect(hitTest(notes, 48 + 41, y60, view)).toEqual({ id: 'a', part: 'body' });
    expect(hitTest(notes, 48 + 43, y60, view)).toEqual({ id: 'a', part: 'end' });
    expect(hitTest(notes, 48 + 47.9, y60, view)).toEqual({ id: 'a', part: 'end' });
  });

  it('misses: past the end, other row, over the keyboard', () => {
    expect(hitTest(notes, 48 + 48.1, y60, view)).toBeNull();
    expect(hitTest(notes, 60, pitchToY(61, view) + 6, view)).toBeNull();
    const left = [{ id: 'b', pitch: 60, start: 0, len: 3840 }]; // starts left of the scroll edge
    expect(hitTest(left, 40, y60, view)).toBeNull();
    expect(hitTest(left, 50, y60, view)).toEqual({ id: 'b', part: 'body' });
  });

  it('a short note keeps a body (end zone is at most its right half)', () => {
    const short = [{ id: 's', pitch: 60, start: 960, len: 120 }]; // 6 px wide
    expect(hitTest(short, 49, y60, view)?.part).toBe('body');
    expect(hitTest(short, 53.5, y60, view)?.part).toBe('end');
  });

  it('a note thinner than 2 px is still hit over the 2 px it is drawn', () => {
    const tiny = [{ id: 't', pitch: 60, start: 960, len: 1 }]; // 0.05 px at 20 ticks/px
    expect(hitTest(tiny, 49.5, y60, view)?.id).toBe('t');
  });

  it('the last (topmost-drawn) note wins on overlap', () => {
    const two = [
      { id: 'under', pitch: 60, start: 960, len: 960 },
      { id: 'over', pitch: 60, start: 960, len: 480 },
    ];
    expect(hitTest(two, 50, y60, view)?.id).toBe('over');
    expect(hitTest(two, 80, y60, view)?.id).toBe('under');
  });
});

describe('labels', () => {
  it('noteName: C4 = 60', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(58)).toBe('A#3');
    expect(noteName(48)).toBe('C3');
    expect(noteName(0)).toBe('C-1');
    expect(noteName(127)).toBe('G9');
  });

  it('formatPos is bar.beat.sixteenth, 1-based, with off-grid ticks', () => {
    expect(formatPos(0)).toBe('1.1.1');
    expect(formatPos(240)).toBe('1.1.2');
    expect(formatPos(960)).toBe('1.2.1');
    expect(formatPos(3840 + 960 * 3 + 720)).toBe('2.4.4');
    expect(formatPos(96)).toBe('1.1.1 +96t');
  });

  it('formatLen prefers note values, then grid multiples, then ticks', () => {
    expect(formatLen(240, '1/16')).toBe('1/16');
    expect(formatLen(480, '1/16')).toBe('1/8');
    expect(formatLen(720, '1/16')).toBe('3×1/16');
    expect(formatLen(3840, '1/16')).toBe('1 bar');
    expect(formatLen(7680, '1/16')).toBe('2 bars');
    expect(formatLen(100, '1/16')).toBe('100 ticks');
    expect(formatLen(320, '1/16')).toBe('1/8T');
  });

  it('readout: "C3 · 1.1.1 · 1/16"', () => {
    expect(readout({ pitch: 48, start: 0, len: 240 }, '1/16')).toBe('C3 · 1.1.1 · 1/16');
  });
});

describe('clampMove', () => {
  const sel = [
    { pitch: 60, start: 0 },
    { pitch: 67, start: 960 },
  ];
  it('passes deltas that keep every note in range', () => {
    expect(clampMove(sel, 240, 2, 3840)).toEqual({ dt: 240, dp: 2 });
  });
  it('a selection with a note past the end: no right move, left/vertical moves untouched', () => {
    const past = [{ pitch: 60, start: 11520 }, { pitch: 62, start: 0 }]; // 2-bar pattern = 7680
    expect(clampMove(past, 0, 1, 7680)).toEqual({ dt: 0, dp: 1 });
    expect(clampMove(past, 240, 0, 7680)).toEqual({ dt: 0, dp: 0 });
    expect(clampMove([past[0]], -240, 0, 7680)).toEqual({ dt: -240, dp: 0 });
  });

  it('clamps the group so chords keep their shape', () => {
    expect(clampMove(sel, -500, 0, 3840)).toEqual({ dt: 0, dp: 0 });
    expect(clampMove(sel, 3000, 0, 3840)).toEqual({ dt: 3840 - 1 - 960, dp: 0 });
    expect(clampMove(sel, 0, 100, 3840)).toEqual({ dt: 0, dp: 127 - 67 });
    expect(clampMove(sel, 0, -100, 3840)).toEqual({ dt: 0, dp: -60 });
  });
});

describe('view', () => {
  it('zoomAt keeps the tick under the cursor fixed and clamps', () => {
    const z = zoomAt(view, 0.5, 200, { minTpp: 1, maxTpp: 400 });
    expect(z.ticksPerPx).toBe(10);
    expect(xToTick(200, z)).toBeCloseTo(xToTick(200, view), 9);
    expect(zoomAt(view, 0.001, 200, { minTpp: 1, maxTpp: 400 }).ticksPerPx).toBe(1);
    expect(zoomAt(view, 0.5, 49, { minTpp: 1, maxTpp: 400 }).scrollTick).toBeGreaterThanOrEqual(0);
  });

  it('initialView fits the pattern and centres C2..C5 when empty', () => {
    const v = initialView(48 + 960, 37 * 10, 15360, []);
    expect(v.ticksPerPx).toBe(16);
    expect(v.scrollTick).toBe(0);
    // C2 (36) and C5 (72) both visible.
    expect(pitchToY(72, v)).toBeGreaterThanOrEqual(0);
    expect(pitchToY(36, v) + v.rowH).toBeLessThanOrEqual(37 * 10);
  });

  it('initialView shows all of C2..C5 at 9 px rows once 37 rows fit, never below 9 px', () => {
    const v = initialView(1000, 333, 15360, []);
    expect(v.rowH).toBe(9);
    expect(pitchToY(72, v)).toBeGreaterThanOrEqual(0);
    expect(pitchToY(36, v) + v.rowH).toBeLessThanOrEqual(333);
    expect(initialView(1000, 200, 15360, []).rowH).toBe(9); // too short: centred, not squeezed
  });

  it('initialView centres existing notes', () => {
    const v = initialView(1000, 200, 15360, [{ pitch: 90 }, { pitch: 94 }]);
    const mid = v.topPitch - 200 / v.rowH / 2;
    expect(Math.abs(mid - 92)).toBeLessThanOrEqual(1);
  });
});

describe('the key (plan 26)', () => {
  const amin = { root: 9, scale: 'minor' } as const;
  it('keyRow: A rows are the root, C# rows are out of key, chromatic shows nothing', () => {
    expect([57, 69, 45].map((p) => keyRow(p, amin))).toEqual(['root', 'root', 'root']);
    expect([61, 49, 66, 68].map((p) => keyRow(p, amin))).toEqual(['out', 'out', 'out', 'out']);
    expect([60, 62, 64, 65, 67, 71].map((p) => keyRow(p, amin))).toEqual(['in', 'in', 'in', 'in', 'in', 'in']);
    const dmaj = { root: 2, scale: 'major' } as const;
    expect([61, 66, 60, 65, 62].map((p) => keyRow(p, dmaj))).toEqual(['in', 'in', 'out', 'out', 'root']);
    for (let p = 0; p < 128; p++) expect(keyRow(p, { root: 9, scale: 'chromatic' })).toBeNull();
  });

  it('movedPitch: no key = plain; with a key, snaps in the direction of the move, ties up when still', () => {
    expect(movedPitch(60, 1, null)).toBe(61);
    expect(movedPitch(60, 1, amin)).toBe(62); // C -> C#: up to D
    expect(movedPitch(62, -1, amin)).toBe(60); // D -> C#: down to C (never back to D)
    expect(movedPitch(61, 0, amin)).toBe(62); // drawn on C#: the tie goes up
    expect(movedPitch(64, 1, amin)).toBe(65); // E -> F: in key
    expect(movedPitch(60, 12, amin)).toBe(72);
    expect(movedPitch(127, 3, amin)).toBe(127);
  });
});

describe('chordStampPitches (the chord stamp)', () => {
  const amin = { root: 9, scale: 'minor' } as const;
  const cmaj = { root: 0, scale: 'major' } as const;
  it('In key on A3 in A minor is Am7; on an off-key row it builds on the key (no snap needed)', () => {
    expect(chordStampPitches(57, 'inKey', 0, amin, null)).toEqual([57, 60, 64, 67]);
    expect(chordStampPitches(57, 'inKey', 0, amin, amin)).toEqual([57, 60, 64, 67]);
    expect(chordStampPitches(58, 'inKey', 0, amin, null)).toEqual(chordStampPitches(59, 'inKey', 0, amin, null)); // A#3 -> B3 (tie up): Bm7b5
    expect(chordStampPitches(59, 'inKey', 0, amin, null)).toEqual([59, 62, 65, 69]);
  });
  it('a fixed type plays on the clicked row; Snap to key snaps its root first (nearest, ties up)', () => {
    expect(chordStampPitches(61, 'maj', 0, amin, null)).toEqual([61, 65, 68]); // C# major, as clicked
    expect(chordStampPitches(61, 'maj', 0, amin, amin)).toEqual([62, 66, 69]); // root C# -> D (tie up), then D major
    expect(chordStampPitches(66, 'min', 0, cmaj, cmaj)).toEqual([67, 70, 74]); // F# -> G (tie up): G minor (not snapped inside)
    expect(chordStampPitches(60, 'maj', 0, amin, amin)).toEqual([60, 64, 67]); // already in key
  });
  it('inversions: m9 on A3, first inversion moves the A up an octave', () => {
    expect(chordStampPitches(57, 'm9', 0, amin, null)).toEqual([57, 60, 64, 67, 71]);
    expect(chordStampPitches(57, 'm9', 1, amin, null)).toEqual([60, 64, 67, 69, 71]);
    expect(chordStampPitches(57, 'm9', 3, amin, null)).toEqual([67, 69, 71, 72, 76]);
  });
  it('notes past 127 are dropped', () => {
    expect(chordStampPitches(125, 'maj', 0, amin, null)).toEqual([125]);
  });
});

describe('draw and stretch (owner request pr-drag)', () => {
  const MAX = 61440; // pattern-actions MAX_NOTE_LEN

  it('the end goes to the grid line nearest the pointer', () => {
    expect(stretchLen(0, 3 * 240 + 60, 240, false)).toBe(720); // 3.25 cells -> 3
    expect(stretchLen(0, 3 * 240 + 130, 240, false)).toBe(960); // 3.54 cells -> 4
    expect(stretchLen(960, 960 + 480, 480, false)).toBe(480); // 1/8 grid, from beat 2
  });

  it('never shorter than one grid step: a press with no reach, or a drag left of the start', () => {
    expect(stretchLen(480, 480, 240, false)).toBe(240);
    expect(stretchLen(480, 500, 240, false)).toBe(240);
    expect(stretchLen(480, 0, 240, false)).toBe(240); // left of the start
    expect(stretchLen(480, -9999, 240, false)).toBe(240);
  });

  it('free (Alt): the end follows the pointer to the tick, still at least one grid step', () => {
    expect(stretchLen(0, 1000.4, 240, true)).toBe(1000);
    expect(stretchLen(0, 100, 240, true)).toBe(240);
  });

  it('an unsnapped (Alt) start: the end still lands on a grid line', () => {
    expect(stretchLen(17, 720 + 40, 240, false)).toBe(720 - 17);
  });

  it('at most MAX_NOTE_LEN', () => {
    expect(stretchLen(0, 1e9, 240, false)).toBe(MAX);
  });

  it('readout: the notes, where they start, and the length the roll names', () => {
    expect(stretchReadout([48], 0, 720, '1/16')).toBe('C3 · 1.1.1 · 3×1/16');
    expect(stretchReadout([57, 60, 64], 960, 1920, '1/16')).toBe('A3 C4 E4 · 1.2.1 · 1/2');
    // One note: the same text as the selected-note readout.
    expect(stretchReadout([48], 0, 720, '1/16')).toBe(readout({ pitch: 48, start: 0, len: 720 }, '1/16'));
  });
});

describe('zoom group', () => {
  it('fitView puts the span across the grid and the pitch range (with a row of air) in the note area', () => {
    const v = fitView(48 + 960, 300, 3840, 7680, 60, 67);
    expect(v.ticksPerPx).toBe(4); // 3840 ticks over 960 px
    expect(v.scrollTick).toBe(3840);
    expect(v.rowH).toBe(24); // 300 / 10 rows = 30, capped at MAX_ROW_H
    expect(v.rowH).toBe(MAX_ROW_H);
    // 12 rows shown; the range's middle (63.5) sits in the middle.
    expect(pitchToY(67, v)).toBeGreaterThanOrEqual(0);
    expect(pitchToY(60, v) + v.rowH).toBeLessThanOrEqual(300);
  });
  it('fitView never squeezes rows below MIN_ROW_H', () => {
    expect(fitView(1008, 100, 0, 3840, 0, 127).rowH).toBe(MIN_ROW_H);
  });
  it('zoomRows keeps the middle pitch and stays within MIN..MAX', () => {
    const v: View = { ticksPerPx: 10, scrollTick: 0, rowH: 12, topPitch: 72, keysW: 48 };
    const z = zoomRows(v, 1.5, 240); // 20 rows -> 13.3 rows around pitch 62
    expect(z.rowH).toBe(18);
    expect(z.topPitch).toBe(69);
    expect(zoomRows({ ...v, rowH: MAX_ROW_H }, 2, 240).rowH).toBe(MAX_ROW_H);
    expect(zoomRows({ ...v, rowH: MIN_ROW_H }, 0.5, 240)).toEqual({ ...v, rowH: MIN_ROW_H });
  });
});
