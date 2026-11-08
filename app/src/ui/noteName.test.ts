import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteName } from './noteName';
import { setNoteNames } from './noteNames.svelte';
import { parseNoteName } from './rack/knobMath';

afterEach(() => setNoteNames('letters'));

describe('noteName styles', () => {
  it('letters keep today\'s spelling', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(58)).toBe('A#3');
    expect(noteName(0)).toBe('C-1');
  });
  it('solfège: syllables, sharps as ♯, octave unchanged', () => {
    setNoteNames('solfege');
    expect(noteName(60)).toBe('Do4');
    expect(noteName(61)).toBe('Do♯4');
    expect(noteName(67)).toBe('Sol4');
    expect(noteName(58)).toBe('La♯3');
    expect(noteName(71)).toBe('Si4');
    expect(noteName(0)).toBe('Do-1');
  });
  it('the setting is persisted; blocked storage does not throw', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    setNoteNames('solfege');
    expect(store.get('daw.noteNames')).toBe('solfege');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(() => setNoteNames('letters')).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe('parseNoteName accepts both forms whatever the style', () => {
  it.each([
    ['C4', 60], ['c#3', 49], ['Db4', 61], ['Do4', 60], ['do♯3', 49], ['DO# 3', 49], ['Sol4', 67], ['so4', 67],
    ['Reb2', 37], ['Si-1', 11], ['La4', 69], ['Fa♯4', 66],
  ])('%s → %i', (t, n) => {
    expect(parseNoteName(t)).toBe(n);
    setNoteNames('solfege');
    expect(parseNoteName(t)).toBe(n);
  });
  it('rejects junk', () => {
    expect(parseNoteName('Xo4')).toBeNull();
    expect(parseNoteName('Do')).toBeNull();
  });
});
