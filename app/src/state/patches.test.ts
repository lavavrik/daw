import { describe, expect, it } from 'vitest';
import { moduleDef, paramIndex, portIndex } from '../audio/catalog';
import { Op } from '../audio/protocol';
import { HOUSE_GROUPS, HOUSE_PHRASES } from './housePatches';
import { BUILTIN_GROUPS, BUILTIN_PATCHES, isBuiltinName, STARTER_PATCHES, trackPatch, validatePatch } from './patches';
import { Project } from './project.svelte';
import { addSynthTrack, loadPatch } from './rack-actions';

describe('built-in patches', () => {
  it('has the five starter patches in order', () => {
    expect(STARTER_PATCHES.map((p) => p.name)).toEqual(['Deep Bass', 'Chord Stab', 'Pad', 'Lead', 'Pluck']);
  });
  it('BUILTIN_GROUPS starts with Starter in the old order', () => {
    expect(BUILTIN_GROUPS[0].label).toBe('Starter');
    expect(BUILTIN_GROUPS[0].patches).toBe(STARTER_PATCHES);
    expect(BUILTIN_GROUPS.map((g) => g.label)).toEqual([
      'Starter', 'House · Leads & Stabs', 'House · Keys', 'House · Bass', 'House · Pads',
    ]);
    expect(BUILTIN_PATCHES).toEqual(BUILTIN_GROUPS.flatMap((g) => g.patches));
    expect(BUILTIN_GROUPS.slice(1)).toEqual(HOUSE_GROUPS);
  });
  it('the House set has the Sax first, and every house patch a phrase', () => {
    expect(HOUSE_GROUPS[0].patches[0]?.name).toBe('Sax');
    for (const p of HOUSE_GROUPS.flatMap((g) => g.patches)) expect(HOUSE_PHRASES[p.name], p.name).toMatch(/^(chord4|chord5|bass|lead)$/);
  });
  it('the House set has its 12 patches in their groups', () => {
    expect(HOUSE_GROUPS.map((g) => g.patches.map((p) => p.name))).toEqual([
      ['Sax', 'Brass Stab', 'Arp Pluck'],
      ['Tine Keys', 'Piano Stab', 'Garage Organ'],
      ['Organ Bass', 'Reese Bass', 'Acid Line', 'Sub Bass'],
      ['Strings', 'Warm Pad'],
    ]);
    expect(Object.keys(HOUSE_PHRASES).sort()).toEqual(HOUSE_GROUPS.flatMap((g) => g.patches.map((p) => p.name)).sort());
  });
  it('names unique case-insensitively, no trademarks', () => {
    const names = BUILTIN_PATCHES.map((p) => p.name.trim().toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const n of BUILTIN_PATCHES.map((p) => p.name)) expect(n, n).not.toMatch(/\b(M1|Rhodes|303|TB|Roland|Korg)\b/i);
  });
  it('isBuiltinName matches case-insensitively', () => {
    expect(isBuiltinName('Deep Bass')).toBe(true);
    expect(isBuiltinName('  deep BASS ')).toBe(true);
    expect(isBuiltinName('sax')).toBe(true);
    expect(isBuiltinName('SAX ')).toBe(true);
    expect(isBuiltinName('Saxophone')).toBe(false);
    expect(isBuiltinName('')).toBe(false);
  });
  for (const patch of BUILTIN_PATCHES) {
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
      it('has at most 24 modules and no Delay or Reverb (mixer sends instead)', () => {
        expect(patch.modules.length).toBeLessThanOrEqual(24);
        expect(patch.modules.filter((m) => m.id === 'delay' || m.id === 'reverb')).toEqual([]);
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
  it('validatePatch keeps every built-in as is', () => {
    for (const patch of BUILTIN_PATCHES) {
      const r = validatePatch(JSON.parse(JSON.stringify(patch)));
      expect(r.warnings, patch.name).toEqual([]);
      expect(r.patch.modules.map((m) => [m.idx, m.id, m.params ?? {}])).toEqual(
        patch.modules.map((m) => [m.idx, m.id, m.params ?? {}]),
      );
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

  it('validatePatch drops unknown modules and bad cables', () => {
    // A patch as it might come from the library folder (hand-edited, from a
    // newer version, or simply broken).
    const r = validatePatch({
      name: 'From library',
      modules: [
        { idx: 0, id: 'midi_in' },
        { idx: 1, id: 'granular_cloud' }, // a module this version does not know
        { idx: 2, id: 'osc' },
        { idx: 3, id: 'out' },
        null,
      ],
      cables: [
        { from: [0, 'pitch'], to: [2, 'pitch'] },
        { from: [2, 'out'], to: [1, 'in'] }, // into the dropped module
        { from: [2, 'out'], to: [3, 'nope'] }, // no such input
        { from: [3, 'l'], to: [2, 'pitch'] }, // an input used as an output
        { from: [2, 'out'], to: [3, 'l'] },
        { from: 'x', to: [3, 'r'] },
      ],
    });
    expect(r.patch.modules.map((m) => m.id)).toEqual(['midi_in', 'osc', 'out']);
    expect(r.patch.cables).toEqual([
      { from: [0, 'pitch'], to: [2, 'pitch'] },
      { from: [2, 'out'], to: [3, 'l'] },
    ]);
    expect(r.warnings).toHaveLength(6);
    expect(r.warnings.join('\n')).toMatch(/granular_cloud/);
    expect(validatePatch(r.patch).warnings).toEqual([]); // a fixed point
  });

  it('trackPatch turns a rack back into a patch (SamplePlayer sample ids mapped)', () => {
    const p = new Project();
    const sink = { send: () => true };
    const t = addSynthTrack(p, sink, 'S', {
      name: 'SP',
      modules: [
        { idx: 0, id: 'midi_in' },
        { idx: 4, id: 'sample_player', params: { sample: 3, gain: 0.5 } },
        { idx: 7, id: 'out' },
      ],
      cables: [{ from: [0, 'gate'], to: [4, 'gate'] }, { from: [4, 'out'], to: [7, 'l'] }],
    })!;
    const out = trackPatch(t, () => -1);
    expect(out.name).toBe('SP');
    expect(out.modules.map((m) => [m.idx, m.id])).toEqual([[0, 'midi_in'], [4, 'sample_player'], [7, 'out']]);
    expect(out.modules[1].params).toMatchObject({ sample: -1, gain: 0.5 });
    expect(out.cables).toEqual([{ from: [0, 'gate'], to: [4, 'gate'] }, { from: [4, 'out'], to: [7, 'l'] }]);
    expect(validatePatch(out).warnings).toEqual([]);
    expect(trackPatch(t, (id) => id).modules[1].params!.sample).toBe(3);
  });

  it('a patch saved before plan 11 loads with the new defaults', () => {
    // ADSR `delay`/`vel_amt` and MIDI In `glide_mode` were appended in plan
    // 11; an older patch (project or library) has none of them.
    const old = {
      name: 'Old',
      modules: [
        { idx: 0, id: 'midi_in', params: { voices: 1, mode: 1, glide: 0.05, bend: 2 } },
        { idx: 1, id: 'adsr', params: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3 } },
        { idx: 2, id: 'out' },
      ],
      cables: [{ from: [0, 'gate'], to: [1, 'gate'] }],
    };
    const r = validatePatch(old);
    expect(r.warnings).toEqual([]);
    const p = new Project();
    const t = addSynthTrack(p, { send: () => true }, 'S', r.patch)!;
    const out = trackPatch(t, () => -1);
    expect(out.modules[0].params).toMatchObject({ mode: 1, glide: 0.05, glide_mode: 0 });
    expect(out.modules[1].params).toMatchObject({ attack: 0.01, release: 0.3, delay: 0, vel_amt: 0 });
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
