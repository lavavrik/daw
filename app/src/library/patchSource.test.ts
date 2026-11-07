import { describe, expect, it } from 'vitest';
import { LIB, patchOptionValue } from './patchSource';

const starters = ['Deep Bass', 'Pad', 'Lead'];
const lib = [
  { name: 'Pad', path: 'patches/Pad.json' }, // a library patch named like a starter (hand-made file)
  { name: 'Acid', path: 'patches/Acid.json' },
];

describe('patch dropdown value (where the current patch came from)', () => {
  it('a library patch named like a starter stays the library one (selection and revert)', () => {
    expect(patchOptionValue('Pad', `${LIB}patches/Pad.json`, starters, lib)).toBe(`${LIB}patches/Pad.json`);
    expect(patchOptionValue('Pad', 'Pad', starters, lib)).toBe('Pad');
  });

  it('without a known source: starter first, then the library by name, else the name itself', () => {
    expect(patchOptionValue('Pad', null, starters, lib)).toBe('Pad');
    expect(patchOptionValue('Acid', null, starters, lib)).toBe(`${LIB}patches/Acid.json`);
    expect(patchOptionValue('From project', null, starters, lib)).toBe('From project');
  });

  it('a stale source (renamed patch, other library) falls back by name', () => {
    expect(patchOptionValue('Acid', `${LIB}patches/Gone.json`, starters, lib)).toBe(`${LIB}patches/Acid.json`);
    expect(patchOptionValue('Acid', 'Pad', starters, lib)).toBe(`${LIB}patches/Acid.json`);
    expect(patchOptionValue('Pad', `${LIB}patches/Pad.json`, starters, [])).toBe('Pad');
  });
});
