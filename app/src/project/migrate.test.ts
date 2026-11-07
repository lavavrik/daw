import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrate';
import { SCHEMA_VERSION, validate } from './schema';

const v1Fixture = () => JSON.parse(readFileSync(new URL('./testdata/v1-fixture.json', import.meta.url), 'utf8'));
/** Frozen plan-9 save (schema 2) of buildFixture + addAudioFixture: Audio tracks, no automation. */
const v2Fixture = () => JSON.parse(readFileSync(new URL('./testdata/v2-fixture.json', import.meta.url), 'utf8'));

type J = Record<string, unknown>;
/** What v2 -> v3 must make of a v2 project: every track and the mixer get an empty `automation`, nothing else changes. */
const withEmptyAutomation = (v2: J): J => ({
  ...v2,
  schemaVersion: 3,
  ...(Array.isArray(v2.tracks) ? { tracks: v2.tracks.map((t) => (t && typeof t === 'object' ? { ...t, automation: [] } : t)) } : {}),
  ...(v2.mixer && typeof v2.mixer === 'object' ? { mixer: { ...(v2.mixer as J), automation: [] } } : {}),
});

/** Every v1 project the tests know: the frozen v1 save of the test fixture, an empty one, minimal ones. */
const V1 = (): Record<string, unknown>[] => [
  v1Fixture(),
  { schemaVersion: 1, name: 'Untitled', tempo: 124, metronome: false, mode: 'pattern', loop: { on: false, start: 0, end: 15360 }, tracks: [], mixer: { tracks: [], reverb: {}, delay: {}, master: {} }, samples: [], selection: { track: null, synth: null } },
  { schemaVersion: 1, name: 'A', samples: [{ id: 0, name: 'kick.wav', type: '', file: 'samples/0-kick.wav' }] },
  { schemaVersion: 1, tracks: [{ kind: 'drum', slot: 3 }] },
  { schemaVersion: 1 },
];

describe('schema migration', () => {
  it('migrates v1 to v2 losslessly (and on to v3)', () => {
    expect(SCHEMA_VERSION).toBe(3);
    for (const v1 of V1()) {
      const before = JSON.stringify(v1);
      const v3 = migrate(v1) as Record<string, unknown>;
      expect(JSON.stringify(v1)).toBe(before); // the input is not changed
      // v1 had no Audio tracks and no automation: everything else is carried over as is.
      expect(v3).toEqual(withEmptyAutomation({ ...v1, schemaVersion: 2 }));
      // validate migrates by itself: a v1 file reads like the same file saved as v2, or as v3.
      const a = validate(v1);
      const b = validate({ ...v1, schemaVersion: 2 });
      expect(a).toEqual(b);
      expect(a).toEqual(validate(withEmptyAutomation({ ...v1, schemaVersion: 2 })));
      if ('error' in a) throw new Error(a.error);
      expect(a.project.schemaVersion).toBe(3);
    }
    // The frozen v1 fixture reads with no warnings.
    const r = validate(v1Fixture());
    expect('warnings' in r && r.warnings).toEqual([]);
  });

  it('migrates v2 to v3 losslessly', () => {
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
      const v3 = migrate(v2);
      expect(JSON.stringify(v2)).toBe(before);
      expect(v3).toEqual(withEmptyAutomation(v2));
      expect(validate(v2)).toEqual(validate(withEmptyAutomation(v2)));
    }
    // The frozen v2 fixture reads with no warnings, and saves (serialize of
    // the loaded state) as itself plus the empty lanes: checked by
    // load.test.ts 'a v2 project loads and saves as v3'.
    const r = validate(v2Fixture());
    expect('warnings' in r && r.warnings).toEqual([]);
    expect('project' in r && r.project).toEqual(withEmptyAutomation(v2Fixture()));
  });

  it('leaves current, newer and non-project input to validate', () => {
    const v3 = { schemaVersion: 3, name: 'x' };
    expect(migrate(v3)).toBe(v3);
    const v4 = { schemaVersion: 4 };
    expect(migrate(v4)).toBe(v4);
    for (const x of [null, 'x', [], { tracks: [] }]) expect(migrate(x)).toBe(x);
  });
});
