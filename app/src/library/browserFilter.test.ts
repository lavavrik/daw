import { describe, expect, it } from 'vitest';
import { folderVisible, hasMatchInside, nameMatches, tabSections } from './browserFilter';
import type { LibListing } from './scan';

const L = (folders: [string, string][], samples: string[]): LibListing => ({
  folders: folders.map(([name, path]) => ({ name, path })),
  samples: samples.map((name) => ({ name, path: name })),
  more: 0,
});
const listings: Record<string, LibListing> = {
  '': L([['drums', 'drums'], ['pads', 'pads'], ['unopened', 'unopened']], ['bass.wav']),
  drums: L([['sub', 'drums/sub']], ['Kick.wav', 'snare.wav']),
  'drums/sub': L([], ['deep-kick.wav']),
  pads: L([], ['warm.wav']),
};

describe('browser filter', () => {
  it('matches case-insensitively; blank matches all', () => {
    expect(nameMatches('Kick.wav', 'kICK')).toBe(true);
    expect(nameMatches('Kick.wav', 'snare')).toBe(false);
    expect(nameMatches('x', '  ')).toBe(true);
  });
  it('finds matches at any loaded depth', () => {
    expect(hasMatchInside(listings, '', 'kick')).toBe(true);
    expect(hasMatchInside(listings, 'drums', 'deep')).toBe(true);
    expect(hasMatchInside(listings, 'pads', 'kick')).toBe(false);
    expect(hasMatchInside(listings, 'unopened', 'kick')).toBe(false);
  });
  it('shows a folder by its own name or by a match inside', () => {
    expect(folderVisible(listings, 'drums', 'drums', 'kick')).toBe(true);
    expect(folderVisible(listings, 'pads', 'pads', 'kick')).toBe(false);
    expect(folderVisible(listings, 'pads', 'pads', 'pad')).toBe(true);
  });
  it('maps tabs to sections', () => {
    expect(tabSections('all')).toEqual({ samples: true, patches: true, kit: true });
    expect(tabSections('samples')).toEqual({ samples: true, patches: false, kit: true });
    expect(tabSections('patches')).toEqual({ samples: false, patches: true, kit: false });
    expect(tabSections('kits')).toEqual({ samples: false, patches: false, kit: true });
  });
});
