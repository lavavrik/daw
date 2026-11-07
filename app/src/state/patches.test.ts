import { describe, expect, it } from 'vitest';
import { moduleDef, paramIndex, portIndex } from '../audio/catalog';
import { Op } from '../audio/protocol';
import { STARTER_PATCHES, validatePatch } from './patches';
import { Project } from './project.svelte';
import { addSynthTrack, loadPatch } from './rack-actions';

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

describe('validatePatch', () => {
  it('a starter patch is valid as is', () => {
    for (const patch of STARTER_PATCHES) {
      const r = validatePatch(JSON.parse(JSON.stringify(patch)));
      expect(r.warnings).toEqual([]);
      expect(r.patch.modules.map((m) => m.idx)).toEqual(patch.modules.map((m) => m.idx));
      expect(r.patch.cables).toEqual(patch.cables);
    }
  });

  it('drops unknown kinds, clamps params, drops dangling cables', () => {
    const r = validatePatch({
      name: 'X',
      modules: [
        { idx: 0, id: 'osc', params: { wave: 9, tune: 'high', bogus: 1 } },
        { idx: 1, id: 'theremin' },
        { idx: 1, id: 'vca' }, // the theremin was dropped: idx 1 is free
        { idx: 1, id: 'out' }, // duplicate idx
        { idx: 40, id: 'out' }, // idx out of range
        { idx: 2, id: 'out' },
      ],
      cables: [
        { from: [0, 'out'], to: [1, 'in'] },
        { from: [0, 'nope'], to: [2, 'l'] },
        { from: [7, 'out'], to: [2, 'r'] },
        { from: [1, 'out'], to: [2, 'l'] },
        'garbage',
      ],
    });
    expect(r.patch.modules.map((m) => [m.idx, m.id])).toEqual([[0, 'osc'], [1, 'vca'], [2, 'out']]);
    expect(r.patch.modules[0].params).toEqual({ wave: 3 });
    expect(r.patch.cables).toEqual([{ from: [0, 'out'], to: [1, 'in'] }, { from: [1, 'out'], to: [2, 'l'] }]);
    const w = r.warnings.join('\n');
    for (const re of [/wave/, /tune/, /bogus/, /theremin/, /idx 1/, /idx 40/, /nope/, /module 7/, /cable/]) expect(w).toMatch(re);
  });

  it('drops pooled effects beyond the free FX-pool budget', () => {
    const modules = Array.from({ length: 5 }, (_, i) => ({ idx: i, id: 'delay' }));
    const r = validatePatch({ name: 'D', modules, cables: [] }, { fxFree: (id) => (id === 'delay' ? 3 : Infinity) });
    expect(r.patch.modules).toHaveLength(3);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/All 8 delays in use/);
  });

  it('loadPatch validates (budget counts the rack it replaces)', () => {
    const p = new Project();
    const sent: number[][] = [];
    const sink = { send: (...a: number[]) => (sent.push(a), true) };
    const t = addSynthTrack(p, sink, 'S', { name: 'e', modules: [], cables: [] })!;
    const eight = { name: '8', modules: Array.from({ length: 8 }, (_, i) => ({ idx: i, id: 'delay' })), cables: [] };
    expect(loadPatch(p, sink, t.id, eight)).toEqual([]);
    // Replacing the same rack: its 8 delays free up, so 8 fit again.
    expect(loadPatch(p, sink, t.id, eight)).toEqual([]);
    const t2 = addSynthTrack(p, sink, 'S2', { name: 'e', modules: [], cables: [] })!;
    const w = loadPatch(p, sink, t2.id, { name: '1', modules: [{ idx: 0, id: 'delay' }], cables: [] });
    expect(w).toHaveLength(1);
    expect(t2.modules).toHaveLength(0);
    expect(sent.some((s) => s[0] === Op.RACK_ADD_MODULE && s[1] === t2.slot)).toBe(false);
  });
});
