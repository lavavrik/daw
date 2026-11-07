import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrate';
import { SCHEMA_VERSION, validate } from './schema';

const v1Fixture = () => JSON.parse(readFileSync(new URL('./testdata/v1-fixture.json', import.meta.url), 'utf8'));

/** Every v1 project the tests know: the frozen v1 save of the test fixture, an empty one, minimal ones. */
const V1 = (): Record<string, unknown>[] => [
  v1Fixture(),
  { schemaVersion: 1, name: 'Untitled', tempo: 124, metronome: false, mode: 'pattern', loop: { on: false, start: 0, end: 15360 }, tracks: [], mixer: { tracks: [], reverb: {}, delay: {}, master: {} }, samples: [], selection: { track: null, synth: null } },
  { schemaVersion: 1, name: 'A', samples: [{ id: 0, name: 'kick.wav', type: '', file: 'samples/0-kick.wav' }] },
  { schemaVersion: 1, tracks: [{ kind: 'drum', slot: 3 }] },
  { schemaVersion: 1 },
];

describe('schema migration', () => {
  it('migrates v1 to v2 losslessly', () => {
    expect(SCHEMA_VERSION).toBe(2);
    for (const v1 of V1()) {
      const before = JSON.stringify(v1);
      const v2 = migrate(v1) as Record<string, unknown>;
      expect(JSON.stringify(v1)).toBe(before); // the input is not changed
      // v1 had no Audio tracks: everything else is carried over as is.
      expect(v2).toEqual({ ...v1, schemaVersion: 2 });
      // validate migrates by itself: a v1 file reads like the same file saved as v2.
      const a = validate(v1);
      const b = validate({ ...v1, schemaVersion: 2 });
      expect(a).toEqual(b);
      if ('error' in a) throw new Error(a.error);
      expect(a.project.schemaVersion).toBe(2);
    }
    // The frozen v1 fixture reads with no warnings.
    const r = validate(v1Fixture());
    expect('warnings' in r && r.warnings).toEqual([]);
  });

  it('leaves current, newer and non-project input to validate', () => {
    const v2 = { schemaVersion: 2, name: 'x' };
    expect(migrate(v2)).toBe(v2);
    const v3 = { schemaVersion: 3 };
    expect(migrate(v3)).toBe(v3);
    for (const x of [null, 'x', [], { tracks: [] }]) expect(migrate(x)).toBe(x);
  });
});
