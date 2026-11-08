import { describe, expect, it } from 'vitest';
import { inputSlot } from './commands';
import type { ProjectJson } from './schema';

/** Just what inputSlot reads: track slots and kinds, and the selection. */
function json(tracks: [number, 'drum' | 'synth' | 'audio'][], track: number | null, synth: number | null): ProjectJson {
  return { tracks: tracks.map(([slot, kind]) => ({ slot, kind })), selection: { track, synth } } as unknown as ProjectJson;
}

describe('inputSlot (the live input at load)', () => {
  it('is the selected synth or drum track (plan 15: drum rows from the keyboard)', () => {
    expect(inputSlot(json([[0, 'drum'], [1, 'synth']], 0, 1))).toBe(0);
    expect(inputSlot(json([[0, 'drum'], [1, 'synth']], 1, 1))).toBe(1);
    // No selection recorded: the first track (a drum) is selected.
    expect(inputSlot(json([[3, 'drum'], [1, 'synth']], null, null))).toBe(3);
  });

  it('falls back to the last synth when an audio track (or nothing) is selected', () => {
    expect(inputSlot(json([[0, 'audio'], [2, 'synth']], 0, 2))).toBe(2);
    expect(inputSlot(json([[0, 'audio'], [2, 'synth']], 0, null))).toBe(2);
    expect(inputSlot(json([[0, 'audio']], 0, null))).toBe(-1);
    expect(inputSlot(json([], null, null))).toBe(-1);
  });
});
