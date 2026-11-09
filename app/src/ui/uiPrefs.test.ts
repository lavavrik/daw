import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadVelLane, setVelLane, uiPrefs } from './uiPrefs.svelte';

describe('uiPrefs: the velocity lane (plan 23 Task 2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to shown; persists a hide and a show', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    expect(loadVelLane()).toBe(true); // nothing stored
    setVelLane(false);
    expect(uiPrefs.velLane).toBe(false);
    expect(store.get('daw.velLane')).toBe('0');
    expect(loadVelLane()).toBe(false); // what a reload reads
    setVelLane(true);
    expect(uiPrefs.velLane).toBe(true);
    expect(loadVelLane()).toBe(true);
  });

  it('blocked storage: shown, and a toggle still applies without throwing', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(loadVelLane()).toBe(true);
    expect(() => setVelLane(false)).not.toThrow();
    expect(uiPrefs.velLane).toBe(false);
  });
});
