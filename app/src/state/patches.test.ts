import { describe, expect, it } from 'vitest';
import { moduleDef, paramIndex, portIndex } from '../audio/catalog';
import { STARTER_PATCHES } from './patches';

describe('starter patches', () => {
  it('has the five patches in order', () => {
    expect(STARTER_PATCHES.map((p) => p.name)).toEqual(['Deep Bass', 'Chord Stab', 'Pad', 'Lead', 'Pluck']);
  });
  for (const patch of STARTER_PATCHES) {
    describe(patch.name, () => {
      const byIdx = new Map(patch.modules.map((m) => [m.idx, m]));
      it('has unique idx and known module ids', () => {
        expect(byIdx.size).toBe(patch.modules.length);
        for (const m of patch.modules) expect(() => moduleDef(m.id)).not.toThrow();
      });
      it('has in-range param names and values (no reliance on clamping)', () => {
        for (const m of patch.modules) {
          const def = moduleDef(m.id);
          for (const [name, v] of Object.entries(m.params ?? {})) {
            const pd = def.params[paramIndex(def, name)];
            expect(v, `${m.id}.${name}`).toBeGreaterThanOrEqual(pd.min);
            expect(v, `${m.id}.${name}`).toBeLessThanOrEqual(pd.max);
            if (pd.integer) expect(Number.isInteger(v), `${m.id}.${name} integer`).toBe(true);
          }
        }
      });
      it('has valid cables with the right direction, one per input', () => {
        const seen = new Set<string>();
        for (const c of patch.cables) {
          const f = byIdx.get(c.from[0])!;
          const t = byIdx.get(c.to[0])!;
          expect(f && t).toBeTruthy();
          expect(() => portIndex(moduleDef(f.id), 'out', c.from[1])).not.toThrow();
          expect(() => portIndex(moduleDef(t.id), 'in', c.to[1])).not.toThrow();
          const key = `${c.to[0]}.${c.to[1]}`;
          expect(seen.has(key), `double cable on ${key}`).toBe(false);
          seen.add(key);
        }
      });
      it('has exactly one Out and one MIDI In; pitch/gate wired', () => {
        expect(patch.modules.filter((m) => m.id === 'out')).toHaveLength(1);
        expect(patch.modules.filter((m) => m.id === 'midi_in')).toHaveLength(1);
        const midi = patch.modules.find((m) => m.id === 'midi_in')!.idx;
        for (const m of patch.modules) {
          const want = m.id === 'osc' ? 'pitch' : m.id === 'adsr' ? 'gate' : null;
          if (!want) continue;
          const wired = patch.cables.some((c) => c.from[0] === midi && c.from[1] === want && c.to[0] === m.idx && c.to[1] === want);
          expect(wired, `${m.id}#${m.idx} ${want}`).toBe(true);
        }
      });
    });
  }
});
