import { describe, expect, it } from 'vitest';
import { MAX_ARENA_FLOATS } from '../audio/protocol';
import { Project } from './project.svelte';
import { budgetText, fitsBudget, overBudgetText } from './sampleBudget';

const MB = (1024 * 1024) / 4; // floats per MB

describe('sample budget', () => {
  it('fitsBudget counts what is already uploaded', () => {
    const p = new Project();
    expect(fitsBudget(p, MAX_ARENA_FLOATS)).toBe(true);
    expect(fitsBudget(p, MAX_ARENA_FLOATS + 1)).toBe(false);
    p.arenaFloats = MAX_ARENA_FLOATS - 10;
    expect(fitsBudget(p, 10)).toBe(true);
    expect(fitsBudget(p, 11)).toBe(false);
  });

  it('budgetText reads "412 MB / 1 GB"', () => {
    const p = new Project();
    expect(budgetText(p)).toBe('0 MB / 1 GB');
    p.arenaFloats = 412 * MB;
    expect(budgetText(p)).toBe('412 MB / 1 GB');
  });

  it('the refusal names the file, the size, what is free and how to free more (addendum §3.3)', () => {
    const p = new Project();
    p.arenaFloats = MAX_ARENA_FLOATS - 120 * MB;
    expect(overBudgetText(p, 'long.wav', 230 * MB)).toBe(
      'long.wav needs 230 MB of sample memory; 120 MB is free (1 GB limit). Removed samples are freed when the project is reopened.',
    );
    // Never "needs 120, 120 free": the need rounds up, the free space down.
    expect(overBudgetText(p, 'x.wav', 120 * MB + 1)).toMatch(/needs 121 MB.*120 MB is free/);
  });
});
