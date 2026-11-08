import { beforeEach, describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { bendLabel, modLabel, observeCommand, resetWheels, wheels } from './wheels.svelte';

describe('wheels', () => {
  beforeEach(() => resetWheels());

  it('mirrors bend and mod commands', () => {
    observeCommand(Op.PITCH_BEND, -0.5);
    observeCommand(Op.MOD_WHEEL, 0.25);
    expect(wheels).toEqual({ bend: -0.5, mod: 0.25 });
  });

  it('clamps out-of-range and non-finite values', () => {
    observeCommand(Op.PITCH_BEND, 3);
    observeCommand(Op.MOD_WHEEL, -1);
    expect(wheels).toEqual({ bend: 1, mod: 0 });
    observeCommand(Op.PITCH_BEND, NaN);
    expect(wheels.bend).toBe(0);
  });

  it('RESET_ALL puts both wheels at rest', () => {
    observeCommand(Op.PITCH_BEND, 1);
    observeCommand(Op.MOD_WHEEL, 1);
    observeCommand(Op.RESET_ALL);
    expect(wheels).toEqual({ bend: 0, mod: 0 });
  });

  it('ignores other commands', () => {
    observeCommand(Op.PITCH_BEND, 0.3);
    observeCommand(Op.NOTE_ON, 60);
    expect(wheels).toEqual({ bend: 0.3, mod: 0 });
  });

  it('labels', () => {
    expect(bendLabel(0.5, 2)).toBe('+1.0 st');
    expect(bendLabel(-1, 12)).toBe('-12.0 st');
    expect(bendLabel(0, 2)).toBe('0 st');
    expect(bendLabel(0.25, null)).toBe('+0.25');
    expect(modLabel(1)).toBe('127');
    expect(modLabel(0.5)).toBe('64');
  });
});
