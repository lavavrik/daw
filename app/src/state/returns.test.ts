import { describe, expect, it } from 'vitest';
import { MIX_RETURN0 } from '../audio/protocol';
import { defaultMixParams } from '../audio/mixerCatalog';
import { Project } from './project.svelte';
import {
  KIND_CODE, MAX_RETURNS, findReturn, firstReturnOfKind, freeSlot, nextReturnName, returnChannel, returnColor,
} from './returns';
import type { ReturnKind, ReturnState } from './returns';
import { RETURN_COLORS } from '../ui/theme';

const ret = (slot: number, kind: ReturnKind, name: string, id = `r${slot}`): ReturnState =>
  ({ id, kind, name, slot, params: defaultMixParams(), key: null });

describe('returns', () => {
  it('a new project has the default layout: Reverb on slot 0, Delay on slot 1', () => {
    const p = new Project();
    expect(p.mixer.returns.map(({ id, kind, name, slot }) => ({ id, kind, name, slot }))).toEqual([
      { id: 'reverb', kind: 'reverb', name: 'Reverb', slot: 0 },
      { id: 'delay', kind: 'delay', name: 'Delay', slot: 1 },
    ]);
    expect(p.mixer.returns.every((r) => r.key === null && r.params.length === defaultMixParams().length)).toBe(true);
    expect(MAX_RETURNS).toBe(8);
    expect(KIND_CODE).toEqual({ off: 0, reverb: 1, delay: 2 });
  });

  it('channel, colour and lookups', () => {
    const p = new Project();
    p.mixer.returns.push(ret(4, 'reverb', 'Reverb 2'));
    expect(returnChannel(findReturn(p, 'r4')!)).toBe(MIX_RETURN0 + 4);
    expect(returnColor(4)).toBe('var(--return-4)');
    expect(RETURN_COLORS).toHaveLength(MAX_RETURNS); // one theme token per slot (theme.test.ts mirrors them)
    expect(findReturn(p, 'nope')).toBeUndefined();
    expect(firstReturnOfKind(p, 'reverb')?.id).toBe('reverb'); // creation order, not slot order
    expect(firstReturnOfKind(p, 'delay')?.id).toBe('delay');
    p.mixer.returns = p.mixer.returns.filter((r) => r.kind !== 'delay');
    expect(firstReturnOfKind(p, 'delay')).toBeUndefined();
  });

  it('nextReturnName: "Reverb 2" next to "Reverb", "Reverb 3" when "Reverb 2" exists', () => {
    const p = new Project();
    expect(nextReturnName(p, 'reverb')).toBe('Reverb 2');
    expect(nextReturnName(p, 'delay')).toBe('Delay 2');
    p.mixer.returns.push(ret(2, 'reverb', 'Reverb 2'));
    expect(nextReturnName(p, 'reverb')).toBe('Reverb 3');
    expect(nextReturnName(p, 'delay')).toBe('Delay 2'); // by kind
    p.mixer.returns.push(ret(3, 'reverb', 'Reverb 4'));
    expect(nextReturnName(p, 'reverb')).toBe('Reverb 3'); // the lowest free number
    p.mixer.returns = [];
    expect(nextReturnName(p, 'reverb')).toBe('Reverb 2'); // N >= 2 even with none
  });

  it('freeSlot gives the lowest free slot, and null at 8', () => {
    const p = new Project();
    expect(freeSlot(p)).toBe(2);
    p.mixer.returns = [ret(1, 'delay', 'Delay'), ret(3, 'reverb', 'Reverb')];
    expect(freeSlot(p)).toBe(0);
    p.mixer.returns = Array.from({ length: 7 }, (_, i) => ret(i === 5 ? 7 : i, 'reverb', 'R'));
    expect(freeSlot(p)).toBe(5);
    p.mixer.returns = Array.from({ length: 8 }, (_, i) => ret(i, 'delay', 'D'));
    expect(freeSlot(p)).toBeNull();
  });
});
