import { describe, expect, it } from 'vitest';
import { noPatternReason, patternReadout } from './patternReadout';

const BAR = 3840;

describe('patternReadout', () => {
  it('bar.beat of the position in the pattern, over its length in bars', () => {
    expect(patternReadout(0, 2 * BAR)).toBe('1.1 / 2');
    expect(patternReadout(2 * 960, 2 * BAR)).toBe('1.3 / 2');
    expect(patternReadout(BAR + 959, 2 * BAR)).toBe('2.1 / 2');
    expect(patternReadout(BAR + 960, 2 * BAR)).toBe('2.2 / 2');
  });
  it('wraps: Pattern mode loops the pattern from tick 0', () => {
    expect(patternReadout(2 * BAR + 960, 2 * BAR)).toBe('1.2 / 2');
    expect(patternReadout(5 * BAR, BAR)).toBe('1.1 / 1');
  });
  it('stopped, counting in or nonsense: a dash', () => {
    expect(patternReadout(null, 2 * BAR)).toBe('– / 2');
    expect(patternReadout(-100, 4 * BAR)).toBe('– / 4');
    expect(patternReadout(NaN, BAR)).toBe('– / 1');
    expect(patternReadout(10, 0)).toBe('– / 1');
  });
});

describe('noPatternReason', () => {
  it('drum and synth tracks play patterns; no track or an audio track says why', () => {
    expect(noPatternReason('drum')).toBeNull();
    expect(noPatternReason('synth')).toBeNull();
    expect(noPatternReason(null)).toBe('Select a drum or synth track');
    expect(noPatternReason('audio')).toBe('An audio track has no pattern: select a drum or synth track');
  });
});
