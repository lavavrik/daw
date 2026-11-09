import { describe, expect, it } from 'vitest';
import { mixParam } from '../../audio/mixerCatalog';
import { newReturn } from '../../state/returns';
import { returnSummary } from './returnSummary';

describe('returnSummary (plan 29: a return strip\'s subtitle)', () => {
  it('a Reverb shows its decay time, 1 decimal', () => {
    const r = newReturn('r', 'reverb', 'Room', 0);
    r.params[mixParam('rev_decay').id] = 1.8;
    expect(returnSummary(r)).toBe('Reverb · 1.8 s');
    r.params[mixParam('rev_decay').id] = 12.345;
    expect(returnSummary(r)).toBe('Reverb · 12.3 s');
  });
  it('a Delay shows its time division\'s label', () => {
    const r = newReturn('d', 'delay', 'Echo', 1);
    r.params[mixParam('delay_time').id] = mixParam('delay_time').choices.indexOf('3/16');
    expect(returnSummary(r)).toBe('Delay · 3/16');
    r.params[mixParam('delay_time').id] = 11;
    expect(returnSummary(r)).toBe('Delay · 1 bar');
  });
  it('the catalog defaults read sensibly', () => {
    expect(returnSummary(newReturn('r', 'reverb', 'Reverb', 0))).toBe(`Reverb · ${mixParam('rev_decay').default.toFixed(1)} s`);
    expect(returnSummary(newReturn('d', 'delay', 'Delay', 1))).toBe(`Delay · ${mixParam('delay_time').choices[mixParam('delay_time').default]}`);
  });
});
