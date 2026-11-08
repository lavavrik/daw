import { describe, expect, it } from 'vitest';
import { createSweepKeys } from './sweep';

describe('createSweepKeys', () => {
  it('same key within the gap, new key after idle, bases independent', () => {
    let t = 0;
    const key = createSweepKeys(1000, () => t);
    const a0 = key('a');
    t = 1000;
    expect(key('a')).toBe(a0); // exactly the gap: same sweep
    t = 1900;
    expect(key('a')).toBe(a0); // idle is measured from the last call
    t = 2901;
    const a1 = key('a');
    expect(a1).not.toBe(a0);
    expect(key('b')).toBe('b:0');
    t = 2902;
    expect(key('a')).toBe(a1);
  });
});
