import { describe, expect, it } from 'vitest';
import { moduleDef, paramIndex } from '../../audio/catalog';
import { formatValue, parseValue } from './knobMath';
import {
  clampMarker, drawnValue, dragMarker, keyMarker, loopMin, loopTooShort, markerChanges, markerXs, noteName, stepMarker,
  stripEmptyText, STRIP_W, valueToX, xToValue,
} from './sampleStrip';

const W = STRIP_W; // 220
const PX = 1 / W;

describe('noteName', () => {
  it('C4 = 60, sharps, the lowest octave is -1', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(0)).toBe('C-1');
    expect(noteName(64)).toBe('E4');
    expect(noteName(127)).toBe('G9');
  });

  it('the Sample Player root knob reads and types note names', () => {
    const d = moduleDef('sample_player');
    const root = d.params[paramIndex(d, 'root')];
    expect(formatValue(root, 60)).toBe('C4');
    expect(formatValue(root, 64)).toBe('E4');
    expect(parseValue(root, 'E4')).toBe(64);
    expect(parseValue(root, 'c#3')).toBe(49);
    expect(parseValue(root, 'Db4')).toBe(61);
    expect(parseValue(root, 'C-1')).toBe(0);
    expect(parseValue(root, '72')).toBe(72); // a bare number is still the MIDI note
    expect(parseValue(root, 'H4')).toBeNull();
    // Other integer params keep plain numbers.
    const oct = moduleDef('osc').params[paramIndex(moduleDef('osc'), 'octave')];
    expect(formatValue(oct, 1)).not.toMatch(/[A-G]/);
  });
});

describe('marker x <-> value', () => {
  it('maps 0..1 across the width and clamps', () => {
    expect(valueToX(0, W)).toBe(0);
    expect(valueToX(1, W)).toBe(W);
    expect(valueToX(0.5, W)).toBe(110);
    expect(valueToX(-0.2, W)).toBe(0);
    expect(valueToX(1.5, W)).toBe(W);
    expect(xToValue(55, W)).toBeCloseTo(0.25);
    expect(xToValue(-10, W)).toBe(0);
    expect(xToValue(W + 10, W)).toBe(1);
    expect(xToValue(valueToX(0.37, W), W)).toBeCloseTo(0.37);
  });

  it('draws end never left of start + 1 px, loop start inside the region', () => {
    expect(markerXs({ start: 0.25, end: 0.75, loopStart: 0.5 }, W)).toEqual({ start: 55, end: 165, loopStart: 110 });
    // end before start (set from the knobs): shown 1 px right of start
    expect(markerXs({ start: 0.5, end: 0.2, loopStart: 0 }, W).end).toBe(111);
    // start at the very end: start backs off 1 px so end still fits
    const m = markerXs({ start: 1, end: 1, loopStart: 0 }, W);
    expect(m).toMatchObject({ start: W - 1, end: W });
    // loop start before start plays from start (the engine's max(loopStart, s))
    expect(markerXs({ start: 0.5, end: 1, loopStart: 0.1 }, W).loopStart).toBe(110);
    expect(markerXs({ start: 0, end: 0.5, loopStart: 0.9 }, W).loopStart).toBe(110);
  });
});

describe('clampMarker / dragMarker / stepMarker', () => {
  const r = { start: 0.2, end: 0.8, loopStart: 0.4 };
  it('end never left of start + 1 px; start never right of end − 1 px', () => {
    expect(clampMarker('end', 0.1, r, W)).toBeCloseTo(0.2 + PX);
    expect(clampMarker('end', 2, r, W)).toBe(1);
    expect(clampMarker('start', 0.9, r, W)).toBeCloseTo(0.8 - PX);
    expect(clampMarker('start', -1, r, W)).toBe(0);
    expect(clampMarker('end', 0.5, r, W)).toBe(0.5);
  });

  it('loop start stays within [start, end − 1 px]', () => {
    expect(clampMarker('loopStart', 0, r, W)).toBe(0.2);
    expect(clampMarker('loopStart', 0.95, r, W)).toBeCloseTo(0.8 - PX);
    expect(clampMarker('loopStart', 0.5, r, W)).toBe(0.5);
  });

  it('degenerate knob values still give a value in 0..1', () => {
    const bad = { start: 1, end: 0, loopStart: 0 };
    for (const m of ['start', 'end', 'loopStart'] as const) {
      const v = clampMarker(m, 0.5, bad, W);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('a drag moves by dx / width from where it was grabbed', () => {
    expect(dragMarker('end', 0.8, -44, r, W)).toBeCloseTo(0.6);
    expect(dragMarker('end', 0.8, -500, r, W)).toBeCloseTo(0.2 + PX);
    expect(dragMarker('start', 0.2, 22, r, W)).toBeCloseTo(0.3);
  });

  it('arrow keys step 0.01, Shift 0.001, clamped', () => {
    expect(stepMarker('end', r, -1, false, W)).toBeCloseTo(0.79);
    expect(stepMarker('end', r, 1, true, W)).toBeCloseTo(0.801);
    expect(stepMarker('start', { ...r, start: 0 }, -1, false, W)).toBe(0);
    expect(stepMarker('end', { ...r, end: 1 }, 1, false, W)).toBe(1);
  });
});

describe('loop length (the engine plays a loop shorter than 20 ms as loop off)', () => {
  // A 1 s file at 48 kHz: 20 ms (two 480-frame crossfades) + 1 frame of margin.
  const MIN = loopMin(48000, 48000);
  it('loopMin is two 10 ms crossfades plus a frame, as a fraction of the file', () => {
    expect(MIN).toBeCloseTo(961 / 48000, 9);
    expect(loopMin(4800, 48000)).toBeCloseTo(961 / 4800, 9); // 0.1 s file
    expect(loopMin(500, 48000)).toBe(1); // shorter than a loop can be
    expect(loopMin(0, 48000)).toBe(0); // unknown length: no limit
    expect(loopMin(NaN, 48000)).toBe(0);
  });

  it('loop start stays at least loopMin before end', () => {
    const r = { start: 0, end: 0.5, loopStart: 0.2 };
    expect(clampMarker('loopStart', 0.499, r, W, MIN)).toBeCloseTo(0.5 - MIN, 9);
    expect(clampMarker('loopStart', 0.3, r, W, MIN)).toBe(0.3);
    // ... but never before start (the region is then too short: see below)
    expect(clampMarker('loopStart', 0.4, { start: 0.49, end: 0.5, loopStart: 0.49 }, W, MIN)).toBe(0.49);
    // keys too
    expect(stepMarker('loopStart', { ...r, loopStart: 0.48 }, 1, false, W, MIN)).toBeCloseTo(0.5 - MIN, 9);
  });

  it('End dragged left past loopStart + loopMin pushes loop start back with it (loop on)', () => {
    const r = { start: 0.1, end: 0.8, loopStart: 0.5 };
    expect(markerChanges('end', 0.7, r, W, MIN, true)).toEqual({ end: 0.7 }); // room left
    const c = markerChanges('end', 0.51, r, W, MIN, true);
    expect(c.end).toBe(0.51);
    expect(c.loopStart).toBeCloseTo(0.51 - MIN, 9);
    // Not past start: then the loop is too short and plays once.
    const d = markerChanges('end', 0.105, r, W, MIN, true);
    expect(d.loopStart).toBe(0.1);
    expect(loopTooShort({ ...r, ...d }, MIN)).toBe(true);
    // Loop off: loop start is not shown and not touched.
    expect(markerChanges('end', 0.51, r, W, MIN, false)).toEqual({ end: 0.51 });
    // End moving right never pulls loop start along.
    expect(markerChanges('end', 0.9, r, W, MIN, true)).toEqual({ end: 0.9 });
    // Nothing changes: no changes.
    expect(markerChanges('start', 0.1, r, W, MIN, true)).toEqual({});
  });

  it('loopTooShort follows the engine region (loop start below start plays from start)', () => {
    expect(loopTooShort({ start: 0, end: 0.5, loopStart: 0.4 }, MIN)).toBe(false);
    expect(loopTooShort({ start: 0, end: 0.5, loopStart: 0.5 - MIN }, MIN)).toBe(false);
    expect(loopTooShort({ start: 0, end: 0.5, loopStart: 0.495 }, MIN)).toBe(true);
    expect(loopTooShort({ start: 0.495, end: 0.5, loopStart: 0 }, MIN)).toBe(true);
    expect(loopTooShort({ start: 0.6, end: 0.5, loopStart: 0 }, MIN)).toBe(true); // end before start
    expect(loopTooShort({ start: 0, end: 0.5, loopStart: 0.495 }, 0)).toBe(false); // length unknown
  });
});

describe('drawnValue (a drag starts from where the marker is drawn)', () => {
  it('is the value itself on a sane region', () => {
    const r = { start: 0.2, end: 0.8, loopStart: 0.4 };
    for (const m of ['start', 'end', 'loopStart'] as const) expect(drawnValue(m, r, W)).toBe(r[m]);
  });

  it('is the clamped, drawn position on a degenerate one', () => {
    // End before start is drawn 1 px right of start: the drag starts there.
    expect(drawnValue('end', { start: 0.5, end: 0.2, loopStart: 0 }, W)).toBeCloseTo(0.5 + PX, 9);
    // Loop start before start is drawn on start.
    expect(drawnValue('loopStart', { start: 0.5, end: 1, loopStart: 0.1 }, W)).toBe(0.5);
    // So a 1 px drag moves the marker 1 px from where it is drawn, not a jump.
    const r = { start: 0.5, end: 0.2, loopStart: 0 };
    expect(dragMarker('end', drawnValue('end', r, W), 1, r, W)).toBeCloseTo(0.5 + 2 * PX, 9);
  });
});

describe('keyMarker', () => {
  const r = { start: 0.2, end: 0.8, loopStart: 0.4 };
  it('arrows ±0.01 (Shift a tenth), PageUp/PageDown ±0.1, Home/End to the bounds', () => {
    expect(keyMarker('end', r, 'ArrowLeft', false, W)).toBeCloseTo(0.79);
    expect(keyMarker('end', r, 'ArrowUp', true, W)).toBeCloseTo(0.801);
    expect(keyMarker('end', r, 'PageDown', false, W)).toBeCloseTo(0.7);
    expect(keyMarker('start', r, 'PageUp', false, W)).toBeCloseTo(0.3);
    expect(keyMarker('end', r, 'Home', false, W)).toBeCloseTo(0.2 + PX); // clamped to start + 1 px
    expect(keyMarker('start', r, 'Home', false, W)).toBe(0);
    expect(keyMarker('end', r, 'End', false, W)).toBe(1);
    expect(keyMarker('loopStart', r, 'End', false, W, loopMin(48000, 48000))).toBeCloseTo(0.8 - 961 / 48000, 9);
    expect(keyMarker('loopStart', r, 'Home', false, W)).toBe(0.2);
    expect(keyMarker('start', r, 'a', false, W)).toBeNull();
  });
});

describe('stripEmptyText', () => {
  it('"Drop a sample here" with nothing assigned, "Sample not loaded" for an unknown id', () => {
    const meta = { seconds: 1, channels: 1, peaks: null };
    expect(stripEmptyText(-1, null)).toBe('Drop a sample here');
    expect(stripEmptyText(3, null)).toBe('Sample not loaded');
    expect(stripEmptyText(3, meta)).toBeNull();
  });
});
