// Content sanity for the factory patterns (plan 25 Task 2; spec
// 2026-11-19-builtin-content §1 and "Testing"): the data is hand-written, so
// these pin what the list, the loader and the theory helpers rely on.
import { describe, expect, it } from 'vitest';
import { BAR_TICKS } from '../audio/protocol';
import { validate } from '../project/schema';
import type { ProjectJson } from '../project/schema';
import { serialize } from '../project/serialize';
import { DEFAULT_KIT } from './defaultKit';
import { DRUM_ROLES, FACTORY_GROUPS, FACTORY_PATTERNS, factoryGroup, factoryPattern } from './factoryPatterns';
import type { FactoryPattern } from './factoryPatterns';
import { mapLibraryRows } from './pattern-library';
import { LIBRARY_NAME_MAX, MAX_STEPS, Project } from './project.svelte';

type Drum = Extract<FactoryPattern, { kind: 'drum' }>;
type Synth = Extract<FactoryPattern, { kind: 'synth' }>;
const drums = FACTORY_PATTERNS.filter((e): e is Drum => e.kind === 'drum');
const synths = FACTORY_PATTERNS.filter((e): e is Synth => e.kind === 'synth');

/** A natural minor's pitch classes: A B C D E F G. */
const A_MINOR = new Set([9, 11, 0, 2, 4, 5, 7]);
/** "Roughly A1–A2" / "roughly A3–E5": a few semitones of slack each side. */
const BASS_RANGE = [28, 52] as const; //   E1..E3
const CHORD_RANGE = [55, 79] as const; //  G3..G5

/**
 * The kits a drum entry must map onto: state/kits.ts KITS once plan 25 Task 1
 * has landed (a track built from a kit names its rows by role and holds the
 * kit's files), else the starter kit (DEFAULT_KIT). The glob is empty when
 * kits.ts does not exist, so this file builds either way.
 */
type KitLike = { id: string; rows: { role?: string; name: string; file: string }[] };
const kitsModule = Object.values(import.meta.glob('./kits.ts', { eager: true }))[0] as { KITS?: KitLike[] } | undefined;
const KITS: KitLike[] = kitsModule?.KITS ?? [{ id: 'starter', rows: DEFAULT_KIT.map((r) => ({ ...r })) }];

describe('factory patterns', () => {
  it('has the spec\'s entries, by group, in order', () => {
    expect(factoryGroup('drums').map((e) => e.name)).toEqual([
      'Four on the floor', 'Classic house', 'Deep shuffle', 'Garage 2-step', 'Speed garage', 'Tech house',
      'Tribal perc', 'Disco hats', 'Broken beat', 'Minimal', 'Fill A', 'Fill B',
    ]);
    expect(factoryGroup('bass').map((e) => e.name)).toEqual([
      'Offbeat', 'Octave bounce', 'Rolling 16ths', 'Garage sub', 'Deep walk', 'Acid 303 line', 'Reese hold', 'Disco octaves',
    ]);
    expect(factoryGroup('chords').map((e) => e.name)).toEqual([
      'Detroit minor stabs', 'Deep m9 progression', 'Garage organ', 'Piano house vamp', 'Classic M1 stab', 'Dub chord', 'Pad long', 'Disco strings',
    ]);
    // Each group holds one kind; the list is the groups in FACTORY_GROUPS order.
    for (const g of FACTORY_GROUPS) expect(factoryGroup(g.group).every((e) => e.kind === g.kind)).toBe(true);
    expect(FACTORY_PATTERNS.map((e) => e.group)).toEqual(FACTORY_GROUPS.flatMap((g) => factoryGroup(g.group).map(() => g.group)));
  });

  it('names and ids are unique, ids stable and looked up', () => {
    expect(new Set(FACTORY_PATTERNS.map((e) => e.name)).size).toBe(FACTORY_PATTERNS.length);
    expect(new Set(FACTORY_PATTERNS.map((e) => e.id)).size).toBe(FACTORY_PATTERNS.length);
    for (const e of FACTORY_PATTERNS) {
      expect(e.name.length).toBeLessThanOrEqual(LIBRARY_NAME_MAX);
      expect(factoryPattern(e.id)).toBe(e);
    }
    expect(factoryPattern('factory-garage-2-step')?.name).toBe('Garage 2-step');
    expect(factoryPattern('nope')).toBeNull();
  });

  it('the drum roles are DEFAULT_KIT\'s row names', () => {
    expect([...DRUM_ROLES]).toEqual(DEFAULT_KIT.map((r) => r.name));
  });

  it('every drum entry: 16 or 32 steps, all eight role rows and nothing else, hits only inside its length', () => {
    for (const e of drums) {
      expect([16, 32], e.name).toContain(e.stepCount);
      expect(e.swing, e.name).toBeGreaterThanOrEqual(0);
      expect(e.swing, e.name).toBeLessThan(1);
      expect(e.rows.map((r) => r.name), e.name).toEqual([...DRUM_ROLES]);
      for (const r of e.rows) {
        expect(r.sampleName, e.name).toBeUndefined();
        expect(r.steps, `${e.name} ${r.name}`).toHaveLength(MAX_STEPS);
        expect(r.steps.slice(e.stepCount).every((v) => v === 0), `${e.name} ${r.name}`).toBe(true);
        expect(r.steps.every((v) => Number.isInteger(v) && v >= 0 && v <= 127), `${e.name} ${r.name}`).toBe(true);
      }
      // A groove: a kick somewhere, and more than one row playing.
      expect(e.rows[0].steps.some((v) => v > 0), e.name).toBe(true);
      expect(e.rows.filter((r) => r.steps.some((v) => v > 0)).length, e.name).toBeGreaterThan(1);
    }
  });

  it('every drum entry maps onto every kit with no dropped row', () => {
    for (const kit of KITS) {
      const target = kit.rows.map((r) => ({ name: r.role ?? r.name, sampleName: r.file.slice(r.file.lastIndexOf('/') + 1) }));
      for (const e of drums) {
        const { to, dropped } = mapLibraryRows(e.rows, target, e.stepCount);
        expect(dropped, `${e.name} on ${kit.id}`).toBe(0);
        // Every row with steps lands on the row of its own role.
        e.rows.forEach((r, i) => {
          if (r.steps.some((v) => v > 0)) expect(target[to[i]!]?.name, `${e.name} ${r.name} on ${kit.id}`).toBe(r.name);
        });
      }
    }
  });

  it('every synth entry: 1, 2 or 4 bars, notes inside them, in A minor, in range, velocities 80–115', () => {
    for (const e of synths) {
      expect([1, 2, 4], e.name).toContain(e.bars);
      expect(e.notes.length, e.name).toBeGreaterThan(0);
      const [lo, hi] = e.group === 'bass' ? BASS_RANGE : CHORD_RANGE;
      for (const n of e.notes) {
        const at = `${e.name} ${JSON.stringify(n)}`;
        expect(Number.isInteger(n.start) && Number.isInteger(n.len), at).toBe(true);
        expect(n.start, at).toBeGreaterThanOrEqual(0);
        expect(n.len, at).toBeGreaterThanOrEqual(1);
        expect(n.start + n.len, at).toBeLessThanOrEqual(e.bars * BAR_TICKS);
        expect(A_MINOR.has(n.pitch % 12), at).toBe(true);
        expect(n.pitch, at).toBeGreaterThanOrEqual(lo);
        expect(n.pitch, at).toBeLessThanOrEqual(hi);
        expect(n.vel, at).toBeGreaterThanOrEqual(80);
        expect(n.vel, at).toBeLessThanOrEqual(115);
      }
      // Some dynamics: not one flat velocity.
      expect(new Set(e.notes.map((n) => n.vel)).size, e.name).toBeGreaterThan(1);
      // No stacked duplicates (the same pitch struck twice at once).
      const keys = e.notes.map((n) => `${n.pitch}@${n.start}`);
      expect(new Set(keys).size, e.name).toBe(keys.length);
    }
    // Every bassline starts on its A.
    for (const e of synths.filter((x) => x.group === 'bass')) expect(e.notes[0].pitch % 12, e.name).toBe(9);
  });

  it('every entry is a valid saved library pattern: validate keeps it as it is, with no warning', () => {
    const json = JSON.parse(JSON.stringify(serialize(new Project()))) as ProjectJson;
    json.patternLibrary = FACTORY_PATTERNS.map(({ id: _id, group: _group, ...entry }) => entry);
    const v = validate(json);
    if ('error' in v) throw new Error(v.error);
    expect(v.warnings).toEqual([]);
    expect(v.project.patternLibrary).toEqual(json.patternLibrary);
  });
});
