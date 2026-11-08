import { describe, expect, it } from 'vitest';
import { moduleDef, paramIndex } from '../../audio/catalog';
import { formatValue, parseValue } from './knobMath';
import { clampMarker, dragMarker, markerXs, noteName, stepMarker, STRIP_W, valueToX, xToValue } from './sampleStrip';

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
