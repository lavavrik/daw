import { describe, expect, it } from 'vitest';
import { CATALOG, clampParam, fxPoolSlots, moduleDef, paramIndex, portIndex } from './catalog';
import { MIXER_CATALOG } from './mixerCatalog';

describe('catalog', () => {
  it('lists the modules in kind order (plan 6 effects are 9..15, sample player 16, formant 17, scope 18, accent 19)', () => {
    expect(CATALOG.modules.map((m) => m.id)).toEqual([
      'midi_in', 'osc', 'noise', 'filter', 'adsr', 'vca', 'lfo', 'mixer', 'out',
      'delay', 'reverb', 'chorus', 'eq', 'compressor', 'saturator', 'attenuator',
      'sample_player', 'formant', 'scope', 'accent',
    ]);
    expect(CATALOG.modules.map((m) => m.kind)).toEqual([...Array(20).keys()]);
  });
  it('the accent is an inline shaping module: gate/vel in, cv out (plan 17)', () => {
    const a = moduleDef('accent');
    expect(a.category).toBe('shaping');
    expect(fxPoolSlots(a)).toBeNull();
    expect(a.inputs.map((p) => [p.name, p.signal])).toEqual([['gate', 'gate'], ['vel', 'cv']]);
    expect(a.outputs.map((p) => [p.name, p.signal])).toEqual([['cv', 'cv']]);
    expect(a.params.map((p) => [p.name, p.min, p.max, p.curve])).toEqual([
      ['threshold', 0, 1, 'lin'], ['amount', 0, 1, 'lin'], ['decay', 0.05, 2, 'exp'],
    ]);
    // MIDI velocity 110 and up is an accent (100, the app's default velocity, is not).
    expect(a.params[paramIndex(a, 'threshold')].default).toBeCloseTo(110 / 127, 6);
    expect(a.params[paramIndex(a, 'decay')].default).toBe(0.25);
  });
  it('the filter mode Diode is appended (id 5; LP24..Notch keep 0..4)', () => {
    const f = moduleDef('filter');
    expect(f.params[paramIndex(f, 'mode')].choices).toEqual(['LP24', 'LP12', 'HP', 'BP', 'Notch', 'Diode']);
  });
  it('the scope is a pooled utility sink (no outputs, a bank of 8)', () => {
    const s = moduleDef('scope');
    expect(s.category).toBe('utility');
    expect(s.outputs).toEqual([]);
    expect(s.inputs.map((p) => p.name)).toEqual(['a', 'b']);
    expect(fxPoolSlots(s)).toBe(8);
    expect(s.params.map((p) => p.name)).toEqual(['time', 'sync', 'division', 'gain_a', 'gain_b', 'mode', 'trig']);
  });
  it('the formant is an inline shaping module', () => {
    const f = moduleDef('formant');
    expect(f.category).toBe('shaping');
    expect(fxPoolSlots(f)).toBeNull();
    expect(f.inputs.map((p) => p.name)).toEqual(['in', 'pitch', 'cv']);
    expect(f.params.map((p) => p.name)).toEqual(['f1', 'f2', 'f3', 'q', 'g2', 'g3', 'shift', 'track', 'cv_amt', 'mix']);
  });
  it('the sample player is a pool-free source with a -1 (none) sample param', () => {
    const sp = moduleDef('sample_player');
    expect(sp.category).toBe('source');
    expect(fxPoolSlots(sp)).toBeNull();
    expect(sp.inputs.map((p) => p.name)).toEqual(['pitch', 'gate']);
    // end/loop/loopStart/fine appended in plan 15 (never reordered).
    expect(sp.params.map((p) => p.name)).toEqual(
      ['sample', 'gain', 'start', 'pitchTrack', 'root', 'end', 'loop', 'loopStart', 'fine'],
    );
    expect(sp.params.slice(5).map((p) => [p.label, p.min, p.max, p.default])).toEqual([
      ['End', 0, 1, 1], ['Loop', 0, 1, 0], ['Loop start', 0, 1, 0], ['Fine', -100, 100, 0],
    ]);
    const sample = sp.params[paramIndex(sp, 'sample')];
    expect([sample.min, sample.max, sample.default, sample.integer]).toEqual([-1, 255, -1, true]);
    expect(sp.params[paramIndex(sp, 'root')].default).toBe(60);
  });
  it('the noise has an appended White/Pink color choice (plan 16), default White', () => {
    const n = moduleDef('noise');
    expect(n.params.map((p) => p.name)).toEqual(['level', 'color']);
    const color = n.params[paramIndex(n, 'color')];
    expect([color.label, color.min, color.max, color.default, color.integer, color.choices]).toEqual(['Color', 0, 1, 0, true, ['White', 'Pink']]);
  });
  it('puts the stereo effects under Effect, with the FX-pool slot counts', () => {
    const effects = CATALOG.modules.filter((m) => m.category === 'effect').map((m) => m.id);
    expect(effects).toEqual(['delay', 'reverb', 'chorus', 'eq', 'compressor']);
    expect(fxPoolSlots(moduleDef('delay'))).toBe(8);
    expect(fxPoolSlots(moduleDef('reverb'))).toBe(8);
    expect(fxPoolSlots(moduleDef('chorus'))).toBe(16);
    expect(fxPoolSlots(moduleDef('eq'))).toBeNull();
  });
  it('rack Delay divisions are the mixer delay table', () => {
    const div = moduleDef('delay').params[paramIndex(moduleDef('delay'), 'division')];
    const mixDiv = MIXER_CATALOG.params.find((q) => q.name === 'delay_time')!;
    expect(div.choices).toEqual(mixDiv.choices);
    expect(div.choices[div.default]).toBe('3/16');
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
