import { describe, expect, it } from 'vitest';
import { createMeterBus } from './meterBus';

describe('meterBus', () => {
  it('tick reports busy while any subscriber is, and fans out the array', () => {
    const bus = createMeterBus();
    const m = new Float32Array(4);
    const seen: number[] = [];
    const off1 = bus.on(() => false);
    expect(bus.tick(m, 0)).toBe(false);
    const off2 = bus.on((a) => (seen.push(a.length), true));
    expect(bus.tick(m, 1)).toBe(true);
    expect(seen).toEqual([4]);
    off2();
    expect(bus.tick(m, 2)).toBe(false);
    off1();
  });
});
