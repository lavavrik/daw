import { describe, expect, it } from 'vitest';
import { CATALOG, clampParam, moduleDef, paramIndex, portIndex } from './catalog';

describe('catalog', () => {
  it('lists exactly the nine modules', () => {
    expect(CATALOG.modules.map((m) => m.id)).toEqual(
      ['midi_in', 'osc', 'noise', 'filter', 'adsr', 'vca', 'lfo', 'mixer', 'out']);
  });
  it('looks modules up by id or kind', () => {
    expect(moduleDef('filter').kind).toBe(3);
    expect(moduleDef(8).id).toBe('out');
    expect(() => moduleDef('nope')).toThrow();
  });
  it('finds params and ports by name', () => {
    const f = moduleDef('filter');
    expect(paramIndex(f, 'cutoff')).toBe(1);
    expect(portIndex(f, 'in', 'cv')).toBe(1);
    expect(portIndex(moduleDef('midi_in'), 'out', 'gate')).toBe(1);
    expect(() => paramIndex(f, 'x')).toThrow();
  });
  it('clampParam clamps ranges and rounds integer params', () => {
    const osc = moduleDef('osc');
    const octave = osc.params[paramIndex(osc, 'octave')];
    expect(clampParam(octave, 1.6)).toBe(2);
    expect(clampParam(octave, -9)).toBe(-3);
    const cutoff = moduleDef('filter').params[1];
    expect(clampParam(cutoff, 99999)).toBe(20000);
    expect(clampParam(cutoff, 440.5)).toBe(440.5);
    expect(clampParam(cutoff, NaN)).toBe(cutoff.default);
  });
});
