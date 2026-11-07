// Built-in patches: the starter patches (here) and the House set
// (housePatches.ts), listed in the patch menu by BUILTIN_GROUPS. Params are
// given by catalog name; anything omitted uses the catalog default. Choice params are choice indices (osc wave: 0 saw, 1 square,
// 2 tri, 3 sine; filter mode: 0 LP24, 1 LP12; midi_in mode: 0 poly, 1 mono;
// lfo wave: 0 sine, 1 tri). patches.test.ts checks every value is in range.
// In every patch MIDI In `pitch` feeds each Osc and `gate` feeds each ADSR.
//
// Levels: Out sums poly voices unnormalised, so the poly patches (Chord Stab,
// Pad, Pluck) set a low Out `level` to keep a 4-note chord (5 for Pad) under
// ~0.9 before the master clamp. engine/tests/starter_patches.rs measures this
// from engine/tests/fixtures/starter_patches.txt; after editing a patch,
// regenerate that fixture (see patches.fixture.test.ts) and rerun cargo test.
//
// Level policy (plan 11). The starter patches keep the quiet poly levels
// above (they are the default track patch and the test fixtures, so they never
// change). The House set is levelled instead: each house patch, played its
// typical phrase at velocity 100, reads −15 dBFS ± 3 dB momentary loudness
// (max RMS of (L+R)/2 over 400 ms windows, unweighted, pre-limiter at the
// default master gain), and its pre-limiter peak at velocity 127 stays < 0.9.
// Unweighted RMS makes a sub bass sound quieter on small speakers at equal
// RMS; that is accepted. engine/tests/house_patches.rs measures both.
//
// The group (menu section) is not part of a Patch, so saved files never
// carry it; a built-in name can't be used for Save patch (isBuiltinName).

import { clampParam, fxPoolFullText, fxPoolSlots, moduleDef } from '../audio/catalog';
import type { ModuleDef } from '../audio/catalog';
import { MAX_MODULES } from '../audio/protocol';
import { HOUSE_GROUPS } from './housePatches';
import type { SynthTrack } from './project.svelte';

/**
 * A rack patch by name: module kinds by catalog id, params by catalog name,
 * cable ends by port name, so catalog growth never shifts anything. The same
 * shape is used by the starter patches, saved projects (a synth track's
 * `patch`) and the patch library.
 */
export interface Patch {
  name: string;
  modules: { idx: number; id: string; params?: Record<string, number> }[];
  cables: { from: [number, string]; to: [number, string] }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isEnd = (v: unknown): v is [number, string] =>
  Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && typeof v[1] === 'string';

/**
 * Check a patch from outside the program (project file, library, …) before
 * anything reaches the engine. Never throws; whatever is wrong is dropped or
 * clamped with a warning:
 *   - modules of unknown kind, or with an idx out of 0..MAX_MODULES-1 or
 *     already taken (first one wins);
 *   - pooled effects (Delay, Reverb, Chorus) beyond `fxFree(id)`, the FX-pool
 *     slots the caller can still spend on that kind (default: the whole
 *     pool), with the "All 8 delays in use" text;
 *   - unknown or non-numeric params (the default is used); out-of-range ones
 *     are clamped (clampParam: integer params round);
 *   - malformed cables, cables whose module or port does not exist; a second
 *     cable into the same input replaces the first (one cable per input).
 * The result is a fixed point: validating it again gives no warnings.
 */
export function validatePatch(
  json: unknown,
  opts: { fxFree?: (moduleId: string) => number } = {},
): { patch: Patch; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  if (!isObj(json)) warn('The patch is not an object: loaded an empty rack');
  const o = isObj(json) ? json : {};
  const patch: Patch = { name: typeof o.name === 'string' ? o.name : '', modules: [], cables: [] };

  const byIdx = new Map<number, ModuleDef>();
  const pooled = new Map<string, number>(); // pooled module id -> kept so far
  for (const raw of Array.isArray(o.modules) ? o.modules : []) {
    if (!isObj(raw)) {
      warn('Dropped a malformed module');
      continue;
    }
    let def: ModuleDef | null = null;
    try {
      if (typeof raw.id === 'string') def = moduleDef(raw.id);
    } catch { /* unknown */ }
    if (!def) {
      warn(`Dropped module "${String(raw.id)}": unknown kind`);
      continue;
    }
    const idx = raw.idx;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= MAX_MODULES) {
      warn(`Dropped ${def.name}: module idx ${String(idx)} is out of range (0..${MAX_MODULES - 1})`);
      continue;
    }
    if (byIdx.has(idx)) {
      warn(`Dropped ${def.name}: module idx ${idx} is already taken`);
      continue;
    }
    const slots = fxPoolSlots(def);
    if (slots !== null) {
      const kept = pooled.get(def.id) ?? 0;
      if (kept >= (opts.fxFree ? opts.fxFree(def.id) : slots)) {
        warn(`Dropped ${def.name} (module ${idx}): ${fxPoolFullText(def)}`);
        continue;
      }
      pooled.set(def.id, kept + 1);
    }
    const m: Patch['modules'][number] = { idx, id: def.id };
    if (isObj(raw.params)) {
      const params: Record<string, number> = {};
      for (const [name, v] of Object.entries(raw.params)) {
        const pd = def.params.find((x) => x.name === name);
        if (!pd) warn(`${def.name} has no param "${name}" (ignored)`);
        else if (typeof v !== 'number' || !Number.isFinite(v)) warn(`${def.name} ${name}: not a number (default used)`);
        else {
          const c = clampParam(pd, v);
          if (c !== v) warn(`${def.name} ${name} ${v} clamped to ${c}`);
          params[name] = c;
        }
      }
      m.params = params;
    }
    patch.modules.push(m);
    byIdx.set(idx, def);
  }

  for (const raw of Array.isArray(o.cables) ? o.cables : []) {
    if (!isObj(raw) || !isEnd(raw.from) || !isEnd(raw.to)) {
      warn('Dropped a malformed cable');
      continue;
    }
    const [fm, fp] = raw.from;
    const [tm, tp] = raw.to;
    const what = `cable ${fm}.${fp} → ${tm}.${tp}`;
    const fd = byIdx.get(fm);
    const td = byIdx.get(tm);
    if (!fd || !td) {
      warn(`Dropped ${what}: no module ${!fd ? fm : tm}`);
      continue;
    }
    if (!fd.outputs.some((x) => x.name === fp)) {
      warn(`Dropped ${what}: ${fd.name} has no output "${fp}"`);
      continue;
    }
    if (!td.inputs.some((x) => x.name === tp)) {
      warn(`Dropped ${what}: ${td.name} has no input "${tp}"`);
      continue;
    }
    const k = patch.cables.findIndex((c) => c.to[0] === tm && c.to[1] === tp);
    if (k >= 0) {
      warn(`The ${what} replaced another cable into the same input`);
      patch.cables.splice(k, 1);
    }
    patch.cables.push({ from: [fm, fp], to: [tm, tp] });
  }
  return { patch, warnings };
}

/**
 * A synth track's rack as a Patch (by name; every param written, so a later
 * catalog default change never alters it). `sample` maps a SamplePlayer's
 * `sample` param (a sample-pool id of this session): a project save keeps
 * ids it writes and turns others into -1; a library patch, which outlives
 * the session, uses -1 (none) for all of them.
 */
export function trackPatch(t: SynthTrack, sample: (id: number) => number): Patch {
  const defAt = (idx: number) => moduleDef(t.modules.find((m) => m.idx === idx)!.kind);
  return {
    name: t.patchName,
    modules: t.modules.map((m) => {
      const def = moduleDef(m.kind);
      const params: Record<string, number> = {};
      def.params.forEach((pd, i) => (params[pd.name] = m.params[i]));
      if (def.id === 'sample_player') params.sample = sample(params.sample);
      return { idx: m.idx, id: def.id, params };
    }),
    cables: t.cables.map((c) => ({
      from: [c.from.m, defAt(c.from.m).outputs[c.from.port].name],
      to: [c.to.m, defAt(c.to.m).inputs[c.to.port].name],
    })),
  };
}

export const STARTER_PATCHES: Patch[] = [
  {
    name: 'Deep Bass',
    modules: [
      { idx: 0, id: 'midi_in', params: { mode: 1, glide: 0.04 } },
      { idx: 1, id: 'osc', params: { wave: 0, octave: -1 } },
      { idx: 2, id: 'osc', params: { wave: 1, octave: -2 } },
      { idx: 3, id: 'mixer' },
      { idx: 4, id: 'filter', params: { mode: 0, cutoff: 300, reso: 0.35, cv_amt: 3 } },
      { idx: 5, id: 'adsr', params: { attack: 0.002, decay: 0.25, sustain: 0.25, release: 0.12 } },
      { idx: 6, id: 'vca' },
      { idx: 7, id: 'out' },
    ],
    cables: [
      { from: [0, 'pitch'], to: [1, 'pitch'] },
      { from: [0, 'pitch'], to: [2, 'pitch'] },
      { from: [0, 'gate'], to: [5, 'gate'] },
      { from: [1, 'out'], to: [3, 'in1'] },
      { from: [2, 'out'], to: [3, 'in2'] },
      { from: [3, 'out'], to: [4, 'in'] },
      { from: [5, 'env'], to: [4, 'cv'] },
      { from: [4, 'out'], to: [6, 'in'] },
      { from: [5, 'env'], to: [6, 'cv'] },
      { from: [6, 'out'], to: [7, 'l'] },
      { from: [6, 'out'], to: [7, 'r'] },
    ],
  },
  {
    name: 'Chord Stab',
    modules: [
      { idx: 0, id: 'midi_in', params: { mode: 0, voices: 8 } },
      { idx: 1, id: 'osc', params: { wave: 0, unison: 2, detune: 12 } },
      { idx: 2, id: 'filter', params: { mode: 0, cutoff: 500, reso: 0.3, cv_amt: 4 } },
      { idx: 3, id: 'adsr', params: { attack: 0.002, decay: 0.18, sustain: 0, release: 0.15 } },
      { idx: 4, id: 'vca' },
      { idx: 5, id: 'out', params: { level: 0.4 } },
    ],
    cables: [
      { from: [0, 'pitch'], to: [1, 'pitch'] },
      { from: [0, 'gate'], to: [3, 'gate'] },
      { from: [1, 'out'], to: [2, 'in'] },
      { from: [3, 'env'], to: [2, 'cv'] },
      { from: [2, 'out'], to: [4, 'in'] },
      { from: [3, 'env'], to: [4, 'cv'] },
      { from: [4, 'out'], to: [5, 'l'] },
      { from: [4, 'out'], to: [5, 'r'] },
    ],
  },
  {
    name: 'Pad',
    modules: [
      { idx: 0, id: 'midi_in', params: { mode: 0 } },
      { idx: 1, id: 'osc', params: { wave: 0, unison: 4, detune: 22 } },
      { idx: 2, id: 'filter', params: { mode: 1, cutoff: 1500, cv_amt: 0.6 } },
      { idx: 3, id: 'lfo', params: { wave: 0, rate: 0.25 } },
      { idx: 4, id: 'adsr', params: { attack: 0.6, decay: 1, sustain: 0.8, release: 1.5 } },
      { idx: 5, id: 'vca' },
      { idx: 6, id: 'out', params: { level: 0.25 } },
    ],
    cables: [
      { from: [0, 'pitch'], to: [1, 'pitch'] },
      { from: [0, 'gate'], to: [4, 'gate'] },
      { from: [1, 'out'], to: [2, 'in'] },
      { from: [3, 'out'], to: [2, 'cv'] },
      { from: [2, 'out'], to: [5, 'in'] },
      { from: [4, 'env'], to: [5, 'cv'] },
      { from: [5, 'out'], to: [6, 'l'] },
      { from: [5, 'out'], to: [6, 'r'] },
    ],
  },
  {
    name: 'Lead',
    modules: [
      { idx: 0, id: 'midi_in', params: { mode: 1 } },
      { idx: 1, id: 'osc', params: { wave: 1 } },
      { idx: 2, id: 'lfo', params: { wave: 1, rate: 5, depth: 0.3 } },
      { idx: 3, id: 'filter', params: { mode: 0, cutoff: 2500, reso: 0.5 } },
      { idx: 4, id: 'adsr', params: { attack: 0.005, decay: 0.3, sustain: 0.6, release: 0.2 } },
      { idx: 5, id: 'vca' },
      { idx: 6, id: 'out' },
    ],
    cables: [
      { from: [0, 'pitch'], to: [1, 'pitch'] },
      { from: [0, 'gate'], to: [4, 'gate'] },
      { from: [2, 'out'], to: [1, 'pw'] },
      { from: [1, 'out'], to: [3, 'in'] },
      { from: [3, 'out'], to: [5, 'in'] },
      { from: [4, 'env'], to: [5, 'cv'] },
      { from: [5, 'out'], to: [6, 'l'] },
      { from: [5, 'out'], to: [6, 'r'] },
    ],
  },
  {
    name: 'Pluck',
    modules: [
      { idx: 0, id: 'midi_in', params: { mode: 0 } },
      { idx: 1, id: 'osc', params: { wave: 0 } },
      { idx: 2, id: 'osc', params: { wave: 2 } },
      { idx: 3, id: 'mixer' },
      { idx: 4, id: 'filter', params: { mode: 0, cutoff: 200, cv_amt: 5 } },
      { idx: 5, id: 'adsr', params: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.12 } },
      { idx: 6, id: 'vca' },
      { idx: 7, id: 'out', params: { level: 0.3 } },
    ],
    cables: [
      { from: [0, 'pitch'], to: [1, 'pitch'] },
      { from: [0, 'pitch'], to: [2, 'pitch'] },
      { from: [0, 'gate'], to: [5, 'gate'] },
      { from: [1, 'out'], to: [3, 'in1'] },
      { from: [2, 'out'], to: [3, 'in2'] },
      { from: [3, 'out'], to: [4, 'in'] },
      { from: [5, 'env'], to: [4, 'cv'] },
      { from: [4, 'out'], to: [6, 'in'] },
      { from: [5, 'env'], to: [6, 'cv'] },
      { from: [6, 'out'], to: [7, 'l'] },
      { from: [6, 'out'], to: [7, 'r'] },
    ],
  },
];

/** The patch menu's built-in sections, in order: Starter, then the House groups. */
export const BUILTIN_GROUPS: { label: string; patches: Patch[] }[] = [
  { label: 'Starter', patches: STARTER_PATCHES },
  ...HOUSE_GROUPS,
];

/** Every built-in patch, flat, in menu order. */
export const BUILTIN_PATCHES: Patch[] = BUILTIN_GROUPS.flatMap((g) => g.patches);

/** True if `name` (trimmed, any case) is a built-in patch's name: Save patch refuses those. */
export function isBuiltinName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n !== '' && BUILTIN_PATCHES.some((p) => p.name.toLowerCase() === n);
}
