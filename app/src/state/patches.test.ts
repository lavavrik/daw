import { describe, expect, it } from 'vitest';
import { moduleDef, paramIndex, portIndex } from '../audio/catalog';
import { Op } from '../audio/protocol';
import { HOUSE_GROUPS, HOUSE_PHRASES, TRANSITION_PATCHES } from './housePatches';
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
      'Starter', 'Sampler', 'House · Leads & Stabs', 'House · Plucks', 'House · Keys', 'House · Bass', 'House · Pads', 'House · FX',
    ]);
    expect(BUILTIN_PATCHES).toEqual(BUILTIN_GROUPS.flatMap((g) => g.patches));
    expect(BUILTIN_GROUPS.slice(2)).toEqual(HOUSE_GROUPS);
  });
  it('the House set has the Sax first, and every house patch a phrase', () => {
    expect(HOUSE_GROUPS[0].patches[0]?.name).toBe('Sax');
    for (const p of HOUSE_GROUPS.flatMap((g) => g.patches)) expect(HOUSE_PHRASES[p.name], p.name).toMatch(/^(chord4|chord5|bass|lead|arp|fx)$/);
  });
  it('the House set has its 21 patches in their groups (plan 28: 7 more, and the FX group)', () => {
    expect(HOUSE_GROUPS.map((g) => g.patches.map((p) => p.name))).toEqual([
      ['Sax', 'Brass Stab', 'Supersaw Lead', 'Hoover'],
      ['Arp Pluck', 'Soft Pluck', 'Bright Pluck'],
      ['Tine Keys', 'Piano Stab', 'Garage Organ', '90s Organ', 'FM Bell'],
      ['Organ Bass', 'Reese Bass', 'Acid Line', 'Sub Bass'],
      ['Strings', 'Warm Pad', 'Formant Pad'],
      ['Noise Sweep', 'Impact'],
    ]);
    expect(Object.keys(HOUSE_PHRASES).sort()).toEqual(HOUSE_GROUPS.flatMap((g) => g.patches.map((p) => p.name)).sort());
  });
  it('the transition patches are the FX group, phrase fx; Noise Sweep leaves its cutoff to automation', () => {
    const fx = HOUSE_GROUPS.find((g) => g.label === 'House · FX')!.patches;
    expect(fx).toEqual([TRANSITION_PATCHES.noiseSweep, TRANSITION_PATCHES.impact]);
    for (const p of fx) expect(HOUSE_PHRASES[p.name]).toBe('fx');
    expect(Object.entries(HOUSE_PHRASES).filter(([, v]) => v === 'fx').map(([k]) => k).sort()).toEqual(['Impact', 'Noise Sweep']);
    // The sweep is the filter's cutoff param itself: nothing patched into its cv.
    const sweep = TRANSITION_PATCHES.noiseSweep;
    const filter = sweep.modules.find((m) => m.id === 'filter')!;
    expect(sweep.cables.some((c) => c.to[0] === filter.idx && c.to[1] === 'cv')).toBe(false);
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

  it('a Sample Player saved with its first 5 params loads with end/loop/loopStart/fine at defaults', () => {
    // Plan 15 appended end, loop, loopStart and fine; older patches and
    // projects carry only sample..root.
    const old = {
      name: 'Old SP',
      modules: [
        { idx: 0, id: 'midi_in' },
        { idx: 1, id: 'sample_player', params: { sample: 2, gain: 0.8, start: 0.25, pitchTrack: 0, root: 48 } },
        { idx: 2, id: 'out' },
      ],
      cables: [{ from: [0, 'gate'], to: [1, 'gate'] }, { from: [1, 'out'], to: [2, 'l'] }],
    };
    const r = validatePatch(old);
    expect(r.warnings).toEqual([]);
    const p = new Project();
    const t = addSynthTrack(p, { send: () => true }, 'S', r.patch)!;
    const out = trackPatch(t, (id) => id);
    expect(out.modules[1].params).toEqual({
      sample: 2, gain: 0.8, start: 0.25, pitchTrack: 0, root: 48, end: 1, loop: 0, loopStart: 0, fine: 0,
    });
  });

  it('Chord and Arp save in a patch and load back; a second of either is dropped (plan 26)', () => {
    const patch = {
      name: 'Arp chords',
      modules: [
        { idx: 0, id: 'midi_in' },
        { idx: 1, id: 'chord', params: { type: 4, inversion: 2 } },
        { idx: 2, id: 'arp', params: { rate: 4, mode: 3, octaves: 2, gate: 75, latch: 1 } },
        { idx: 3, id: 'out' },
      ],
      cables: [],
    };
    expect(validatePatch(patch).warnings).toEqual([]);
    const p = new Project();
    const t = addSynthTrack(p, { send: () => true }, 'S', validatePatch(patch).patch)!;
    const out = trackPatch(t, () => -1);
    expect(out.modules.map((m) => [m.id, m.params])).toEqual(patch.modules.map((m) => [m.id, expect.objectContaining(m.params ?? {})]));
    expect(out.modules[2].params).toEqual({ rate: 4, mode: 3, octaves: 2, gate: 75, latch: 1 });
    const twice = validatePatch({ ...patch, modules: [...patch.modules, { idx: 5, id: 'arp' }, { idx: 6, id: 'chord' }] });
    expect(twice.patch.modules.map((m) => m.idx)).toEqual([0, 1, 2, 3]);
    expect(twice.warnings).toEqual(['Dropped Arp (module 5): one per rack', 'Dropped Chord (module 6): one per rack']);
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

describe('rack module pos', () => {
  const base = (pos: unknown[]) => ({
    name: 'x',
    modules: pos.map((p, i) => ({ idx: i, id: 'osc', ...(p === undefined ? {} : { pos: p }) })),
    cables: [],
  });

  it('validate_keeps_pos', () => {
    const { patch, warnings } = validatePatch(base([{ row: 0, x: 0 }, { row: 31, x: 1000 }, undefined]));
    expect(patch.modules.map((m) => m.pos)).toEqual([{ row: 0, x: 0 }, { row: 31, x: 1000 }, undefined]);
    expect(warnings).toEqual([]);
  });

  it.each([
    ['row 32', { row: 32, x: 0 }],
    ['x -1', { row: 0, x: -1 }],
    ['x 1.5', { row: 0, x: 1.5 }],
    ['x 1001', { row: 0, x: 1001 }],
    ['not an object', 'a'],
  ])('invalid_pos_drops_all (%s)', (_n, bad) => {
    const { patch, warnings } = validatePatch(base([{ row: 1, x: 5 }, bad]));
    expect(patch.modules).toHaveLength(2);
    expect(patch.modules.every((m) => m.pos === undefined)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(validatePatch(patch).warnings).toEqual([]); // fixed point
  });

  it('serialize_round_trip_pos', () => {
    const p = new Project();
    const sink = { send: () => true };
    const t = addSynthTrack(p, sink)!;
    expect(trackPatch(t, () => -1).modules.every((m) => !('pos' in m))).toBe(true);
    t.modules[0].pos = { row: 2, x: 7 };
    const saved = trackPatch(t, () => -1);
    expect(saved.modules[0].pos).toEqual({ row: 2, x: 7 });
    const q = new Project();
    const t2 = addSynthTrack(q, sink, 'B', JSON.parse(JSON.stringify(saved)))!;
    expect(t2.modules[0].pos).toEqual({ row: 2, x: 7 });
    expect(t2.modules[1].pos).toBeUndefined();
  });
});
