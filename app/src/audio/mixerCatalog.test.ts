import { clampParam } from './catalog';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIXER_CATALOG, MIX_PARAMS, defaultMixParams, mixParam } from './mixerCatalog';

describe('mixer catalog', () => {
  it('loads the golden verbatim', () => {
    const golden = JSON.parse(readFileSync(new URL('../../../engine/mixer_catalog.json', import.meta.url), 'utf8'));
    expect(MIXER_CATALOG).toEqual(golden);
  });
  it('param ids are unique and equal their index', () => {
    expect(new Set(MIX_PARAMS.map((p) => p.id)).size).toBe(MIX_PARAMS.length);
    MIX_PARAMS.forEach((p, i) => expect(p.id).toBe(i));
    expect(new Set(MIX_PARAMS.map((p) => p.name)).size).toBe(MIX_PARAMS.length);
  });
  it('defaults are inside their ranges', () => {
    for (const p of MIX_PARAMS) {
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
    }
    expect(defaultMixParams()).toHaveLength(MIX_PARAMS.length);
  });
  it('clampParam', () => {
    expect(clampParam(mixParam('fader'), -Infinity)).toBe(-60);
    expect(clampParam(mixParam('fader'), 20)).toBe(6);
    expect(clampParam(mixParam('fader'), NaN)).toBe(0);
    expect(clampParam(mixParam('mute'), 0.4)).toBe(0);
  });
  it('delay division beats: one per delay_time choice, 3/16 = 0.75 beats', () => {
    const d = mixParam('delay_time');
    expect(MIXER_CATALOG.delay.divisionBeats).toHaveLength(d.choices.length);
    expect(MIXER_CATALOG.delay.divisionBeats[d.default]).toBe(0.75);
    expect(MIXER_CATALOG.delay.maxSeconds).toBe(2);
  });
  it('mixParam throws on unknown', () => {
    expect(() => mixParam('nope')).toThrow();
  });
});
