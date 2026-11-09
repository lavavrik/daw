import { describe, expect, it } from 'vitest';
import { DROP_WINDOW_MS, createDropWindow, midiLabel, topWarning } from './topStatus';

describe('createDropWindow (dropouts in the last 10 s)', () => {
  it('counts the dropouts since the first sample while the app is younger than the window', () => {
    const w = createDropWindow();
    expect(w.push(0, 0)).toBe(0);
    expect(w.push(250, 3)).toBe(3);
    expect(w.push(500, 3)).toBe(3);
  });
  it('a total already there at the first sample counts (it happened during start-up)', () => {
    expect(createDropWindow().push(1000, 5)).toBe(5);
  });
  it('forgets dropouts older than the window', () => {
    const w = createDropWindow();
    w.push(0, 0);
    w.push(1000, 4); // 4 dropouts at t = 1 s
    expect(w.push(DROP_WINDOW_MS, 4)).toBe(4); // t = 10 s: the 1 s sample is still inside
    expect(w.push(DROP_WINDOW_MS + 1000, 4)).toBe(0); // t = 11 s: the 4 are 10 s old
    expect(w.push(DROP_WINDOW_MS + 2000, 6)).toBe(2);
  });
  it('a lower total (a new engine after an audio restart) starts over', () => {
    const w = createDropWindow();
    w.push(0, 0);
    w.push(500, 9);
    expect(w.push(1000, 1)).toBe(1);
  });
  it('keeps a bounded history at 4 Hz', () => {
    const w = createDropWindow();
    for (let t = 0; t < 600_000; t += 250) w.push(t, 0);
    expect(w.size()).toBeLessThanOrEqual(DROP_WINDOW_MS / 250 + 2);
  });
});

describe('topWarning (the one badge at the top right)', () => {
  const ok = { recentDrops: 0, midi: 'connected' as const, latencyMs: 12 };
  it('is null in the normal state (no device and unsupported MIDI are normal too)', () => {
    expect(topWarning(ok)).toBeNull();
    expect(topWarning({ ...ok, midi: 'no-devices' })).toBeNull();
    expect(topWarning({ ...ok, midi: 'unsupported' })).toBeNull();
  });
  it('dropouts win over MIDI blocked, which wins over high latency', () => {
    const all = { recentDrops: 3, midi: 'denied' as const, latencyMs: 120 };
    expect(topWarning(all)?.kind).toBe('dropouts');
    expect(topWarning({ ...all, recentDrops: 0 })?.kind).toBe('midi');
    expect(topWarning({ ...all, recentDrops: 0, midi: 'connected' })?.kind).toBe('latency');
  });
  it('labels are short; the tooltip says what a click does', () => {
    expect(topWarning({ ...ok, recentDrops: 1 })).toMatchObject({ label: '1 dropout', title: expect.stringMatching(/Click for audio settings/) });
    expect(topWarning({ ...ok, recentDrops: 123 })?.label).toBe('123 dropouts');
    expect(topWarning({ ...ok, midi: 'denied' })).toMatchObject({ label: 'MIDI blocked', title: expect.stringMatching(/site settings.*Click for MIDI/s) });
    expect(topWarning({ ...ok, latencyMs: 180.4 })).toMatchObject({ label: '180 ms latency', title: expect.stringMatching(/Bluetooth/) });
  });
  it('latency at the threshold (40 ms) is still fine', () => {
    expect(topWarning({ ...ok, latencyMs: 40 })).toBeNull();
    expect(topWarning({ ...ok, latencyMs: 40.1 })?.kind).toBe('latency');
  });
});

describe('midiLabel (Options ▸ MIDI… names the device)', () => {
  it('names the first device and counts the rest', () => {
    expect(midiLabel({ state: 'connected', devices: ['Arturia KeyStep'] })).toBe('Arturia KeyStep');
    expect(midiLabel({ state: 'connected', devices: ['A', 'B', 'C'] })).toBe('A +2');
  });
  it('says why there is none', () => {
    expect(midiLabel({ state: 'no-devices', devices: [] })).toBe('no device');
    expect(midiLabel({ state: 'denied', devices: [] })).toBe('blocked');
    expect(midiLabel({ state: 'unsupported', devices: [] })).toBe('unsupported');
  });
});
