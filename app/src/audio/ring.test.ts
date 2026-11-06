import { describe, it, expect } from 'vitest';
import { createRingBuffer, CommandRing } from './ring';
import { RING_CAPACITY, RECORD_WORDS } from './protocol';

describe('CommandRing', () => {
  it('is fifo', () => {
    const r = new CommandRing(createRingBuffer());
    r.push(1, 1, 2, 3, 4);
    r.push(2, 5, 6, 7, 8);
    const out = new Float64Array(RECORD_WORDS);
    expect(r.pop(out)).toBe(true);
    expect(Array.from(out)).toEqual([1, 1, 2, 3, 4]);
    expect(r.pop(out)).toBe(true);
    expect(Array.from(out)).toEqual([2, 5, 6, 7, 8]);
  });
  it('wraps around after many cycles', () => {
    const r = new CommandRing(createRingBuffer());
    const out = new Float64Array(RECORD_WORDS);
    for (let i = 0; i < RING_CAPACITY * 3; i++) {
      expect(r.push(i, i + 1)).toBe(true);
      expect(r.pop(out)).toBe(true);
      expect(out[0]).toBe(i);
      expect(out[1]).toBe(i + 1);
    }
  });
  it('push fails when capacity-1 items are queued', () => {
    const r = new CommandRing(createRingBuffer());
    for (let i = 0; i < RING_CAPACITY - 1; i++) expect(r.push(i)).toBe(true);
    expect(r.push(999)).toBe(false);
    const out = new Float64Array(RECORD_WORDS);
    expect(r.pop(out)).toBe(true);
    expect(r.push(999)).toBe(true);
  });
  it('pop on empty returns false', () => {
    const r = new CommandRing(createRingBuffer());
    expect(r.pop(new Float64Array(RECORD_WORDS))).toBe(false);
  });
});
