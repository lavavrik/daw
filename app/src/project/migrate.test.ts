import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrate';
import { SCHEMA_VERSION, validate } from './schema';

const v1Fixture = () => JSON.parse(readFileSync(new URL('./testdata/v1-fixture.json', import.meta.url), 'utf8'));
/** Frozen plan-9 save (schema 2) of buildFixture + addAudioFixture: Audio tracks, no automation. */
const v2Fixture = () => JSON.parse(readFileSync(new URL('./testdata/v2-fixture.json', import.meta.url), 'utf8'));
/** Frozen plan-13 save (schema 3) of buildFixture + addAudioFixture + addAutomationFixture: lanes, no MIDI mappings. */
const v3Fixture = () => JSON.parse(readFileSync(new URL('./testdata/v3-fixture.json', import.meta.url), 'utf8'));
/**
 * A schema-4 save (plan 21 Task 4): the v3 fixture as the plan-14 app saved
 * it (v3 -> v4 adds only `midiMap`, so a v4 save of the same project is the
 * v3 one plus its mapping list) with three mappings. No pattern library.
 */
const v4Fixture = () => JSON.parse(readFileSync(new URL('./testdata/v4-fixture.json', import.meta.url), 'utf8'));
/**
 * A schema-5 save (plan 26 Task 1): the v4 fixture as the plan-21 app saved
 * it (v4 -> v5 adds only `patternLibrary`) with two library patterns. No key.
 */
const v5Fixture = () => JSON.parse(readFileSync(new URL('./testdata/v5-fixture.json', import.meta.url), 'utf8'));

type J = Record<string, unknown>;
/** What v2 -> v3 must make of a v2 project: every track and the mixer get an empty `automation`, nothing else changes. */
const withEmptyAutomation = (v2: J): J => ({
  ...v2,
  schemaVersion: 3,
  ...(Array.isArray(v2.tracks) ? { tracks: v2.tracks.map((t) => (t && typeof t === 'object' ? { ...t, automation: [] } : t)) } : {}),
  ...(v2.mixer && typeof v2.mixer === 'object' ? { mixer: { ...(v2.mixer as J), automation: [] } } : {}),
});

/** What v3 -> v4 must make of a v3 project: an empty top-level `midiMap`, nothing else changes. */
const withEmptyMidiMap = (v3: J): J => ({ ...v3, schemaVersion: 4, midiMap: [] });
/** What v4 -> v5 must make of a v4 project: an empty top-level `patternLibrary`, nothing else changes. */
const withEmptyLibrary = (v4: J): J => ({ ...v4, schemaVersion: 5, patternLibrary: [] });
/** What v5 -> v6 must make of a v5 project: the key A minor, nothing else changes. */
const withAMinor = (v5: J): J => ({ ...v5, schemaVersion: 6, key: { root: 9, scale: 'minor' } });
/** v4 -> current. */
const fromV4 = (v4: J): J => withAMinor(withEmptyLibrary(v4));
/** v3 -> current. */
const fromV3 = (v3: J): J => fromV4(withEmptyMidiMap(v3));
/** v2 -> current. */
const fromV2 = (v2: J): J => fromV3(withEmptyAutomation(v2));

/** Every v1 project the tests know: the frozen v1 save of the test fixture, an empty one, minimal ones. */
const V1 = (): Record<string, unknown>[] => [
  v1Fixture(),
  { schemaVersion: 1, name: 'Untitled', tempo: 124, metronome: false, mode: 'pattern', loop: { on: false, start: 0, end: 15360 }, tracks: [], mixer: { tracks: [], reverb: {}, delay: {}, master: {} }, samples: [], selection: { track: null, synth: null } },
  { schemaVersion: 1, name: 'A', samples: [{ id: 0, name: 'kick.wav', type: '', file: 'samples/0-kick.wav' }] },
  { schemaVersion: 1, tracks: [{ kind: 'drum', slot: 3 }] },
  { schemaVersion: 1 },
];

describe('schema migration', () => {
  it('migrates v1 to v2 losslessly (and on to v6)', () => {
    expect(SCHEMA_VERSION).toBe(6);
    for (const v1 of V1()) {
      const before = JSON.stringify(v1);
      const v6 = migrate(v1) as Record<string, unknown>;
      expect(JSON.stringify(v1)).toBe(before); // the input is not changed
      // v1 had no Audio tracks, automation, MIDI mappings, library or key: everything else is carried over as is.
      expect(v6).toEqual(fromV2({ ...v1, schemaVersion: 2 }));
      // validate migrates by itself: a v1 file reads like the same file saved as v2, v3, v4, v5 or v6.
      const a = validate(v1);
      const b = validate({ ...v1, schemaVersion: 2 });
      expect(a).toEqual(b);
      expect(a).toEqual(validate(withEmptyAutomation({ ...v1, schemaVersion: 2 })));
      expect(a).toEqual(validate(fromV2({ ...v1, schemaVersion: 2 })));
      if ('error' in a) throw new Error(a.error);
      expect(a.project.schemaVersion).toBe(6);
      expect(a.project.patternLibrary).toEqual([]);
      expect(a.project.key).toEqual({ root: 9, scale: 'minor' });
    }
    // The frozen v1 fixture reads with no warnings.
    const r = validate(v1Fixture());
    expect('warnings' in r && r.warnings).toEqual([]);
  });

  it('migrates v2 to v3 losslessly (and on to v6)', () => {
    const v2s: J[] = [
      v2Fixture(),
      { schemaVersion: 2, name: 'A', tracks: [{ kind: 'audio', slot: 0, clips: [] }, 'junk'], mixer: { tracks: [] } },
      { schemaVersion: 2, tracks: 'junk', mixer: null },
      { schemaVersion: 2 },
    ];
    expect(v2s[0].schemaVersion).toBe(2);
    expect((v2s[0].tracks as { kind: string }[]).map((t) => t.kind)).toEqual(['drum', 'synth', 'synth', 'audio', 'audio']);
    for (const v2 of v2s) {
      const before = JSON.stringify(v2);
      const v6 = migrate(v2);
      expect(JSON.stringify(v2)).toBe(before);
      expect(v6).toEqual(fromV2(v2));
      expect(validate(v2)).toEqual(validate(withEmptyAutomation(v2)));
    }
    // The frozen v2 fixture reads with no warnings, and saves (serialize of
    // the loaded state) as itself plus the empty lanes: checked by
    // load.test.ts 'a v2 project loads and saves as v6'.
    const r = validate(v2Fixture());
    expect('warnings' in r && r.warnings).toEqual([]);
    expect('project' in r && r.project).toEqual(fromV2(v2Fixture()));
  });

  it('migrates v3 to v4 losslessly (and on to v6)', () => {
    const v3s: J[] = [
      v3Fixture(),
      { schemaVersion: 3, name: 'A', tracks: [{ kind: 'audio', slot: 0, clips: [], automation: [] }] },
      { schemaVersion: 3, midiMap: 'junk' },
      { schemaVersion: 3 },
    ];
    expect(v3s[0].schemaVersion).toBe(3);
    expect((v3s[0].tracks as { automation: unknown[] }[]).some((t) => t.automation.length > 0)).toBe(true);
    for (const v3 of v3s) {
      const before = JSON.stringify(v3);
      const v6 = migrate(v3);
      expect(JSON.stringify(v3)).toBe(before);
      expect(v6).toEqual(fromV3(v3));
      expect(validate(v3)).toEqual(validate(withEmptyMidiMap(v3)));
    }
    // The frozen v3 fixture reads with no warnings, as itself plus the empty mapping list.
    const r = validate(v3Fixture());
    expect('warnings' in r && r.warnings).toEqual([]);
    expect('project' in r && r.project).toEqual(fromV3(v3Fixture()));
  });

  it('migrates v4 to v5 losslessly: an old project opens with an empty pattern library (and on to v6)', () => {
    const v4s: J[] = [
      v4Fixture(),
      { schemaVersion: 4, name: 'A', midiMap: [] },
      { schemaVersion: 4, patternLibrary: 'junk' }, // never written by v4: replaced
      { schemaVersion: 4 },
    ];
    expect(v4s[0].schemaVersion).toBe(4);
    expect((v4s[0].midiMap as unknown[]).length).toBe(3);
    for (const v4 of v4s) {
      const before = JSON.stringify(v4);
      const v6 = migrate(v4);
      expect(JSON.stringify(v4)).toBe(before);
      expect(v6).toEqual(fromV4(v4));
      expect(validate(v4)).toEqual(validate(withEmptyLibrary(v4)));
    }
    // The v4 fixture reads with no warnings, as itself plus the empty library (and the key).
    const r = validate(v4Fixture());
    expect('warnings' in r && r.warnings).toEqual([]);
    expect('project' in r && r.project).toEqual(fromV4(v4Fixture()));
  });

  it('migrates v5 to v6 losslessly: an old project opens in A minor', () => {
    const v5s: J[] = [
      v5Fixture(),
      { schemaVersion: 5, name: 'A', patternLibrary: [] },
      { schemaVersion: 5, key: { root: 2, scale: 'major' } }, // never written by v5: replaced
      { schemaVersion: 5 },
    ];
    expect(v5s[0].schemaVersion).toBe(5);
    expect((v5s[0].patternLibrary as unknown[]).length).toBe(2);
    expect(v5s[0].key).toBeUndefined();
    for (const v5 of v5s) {
      const before = JSON.stringify(v5);
      const v6 = migrate(v5);
      expect(JSON.stringify(v5)).toBe(before);
      expect(v6).toEqual(withAMinor(v5));
      expect(validate(v5)).toEqual(validate(withAMinor(v5)));
      const r = validate(v5);
      expect('project' in r && r.project.key).toEqual({ root: 9, scale: 'minor' });
    }
    // The v5 fixture reads with no warnings, as itself plus A minor.
    const r = validate(v5Fixture());
    expect('warnings' in r && r.warnings).toEqual([]);
    expect('project' in r && r.project).toEqual(withAMinor(v5Fixture()));
  });

  it('leaves current, newer and non-project input to validate', () => {
    const v6 = { schemaVersion: 6, name: 'x' };
    expect(migrate(v6)).toBe(v6);
    const v7 = { schemaVersion: 7 };
    expect(migrate(v7)).toBe(v7);
    for (const x of [null, 'x', [], { tracks: [] }]) expect(migrate(x)).toBe(x);
  });
});
