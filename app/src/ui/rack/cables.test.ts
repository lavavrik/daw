import { describe, expect, it } from 'vitest';
import { cableBottom, cablePath, SIGNAL_COLORS } from './cables';

/** "M x y C x1 y1 x2 y2 x y" -> the 8 numbers. */
function nums(d: string): number[] {
  return (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

describe('cablePath', () => {
  const cases: [{ x: number; y: number }, { x: number; y: number }][] = [
    [{ x: 10, y: 20 }, { x: 200, y: 20 }],
    [{ x: 300, y: 50 }, { x: 40, y: 180 }], // right-to-left, b lower
    [{ x: 0, y: 400 }, { x: 10, y: 0 }], // a much lower than b, small dx
    [{ x: 5, y: 5 }, { x: 5, y: 5 }], // zero length
  ];
  for (const [a, b] of cases) {
    it(`starts at a, ends at b, controls sag below both ends (${a.x},${a.y})->(${b.x},${b.y})`, () => {
      const d = cablePath(a, b);
      expect(d.startsWith('M')).toBe(true);
      expect(d).toContain('C');
      const n = nums(d);
      expect(n).toHaveLength(8);
      expect([n[0], n[1]]).toEqual([a.x, a.y]);
      expect([n[6], n[7]]).toEqual([b.x, b.y]);
      const low = Math.max(a.y, b.y);
      expect(n[3]).toBeGreaterThan(low);
      expect(n[5]).toBeGreaterThan(low);
    });
  }

  it('sags by 30 + 0.15·|dx| below the lower end', () => {
    const n = nums(cablePath({ x: 0, y: 10 }, { x: 200, y: 40 }));
    expect(n[3]).toBeCloseTo(40 + 30 + 0.15 * 200);
    expect(n[5]).toBeCloseTo(40 + 30 + 0.15 * 200);
  });
});

describe('SIGNAL_COLORS', () => {
  it('has the agreed colour per signal kind', () => {
    expect(SIGNAL_COLORS).toEqual({ audio: '#5ec4ff', pitch: '#f0a23a', gate: '#7ddc7d', cv: '#b28cff' });
  });
});

describe('cableBottom', () => {
  it('bounds every point of the curve from below', () => {
    const a = { x: 10, y: 200 }, b = { x: 600, y: 120 };
    const n = (cablePath(a, b).match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    let low = -Infinity;
    for (let t = 0; t <= 1; t += 0.01) {
      const u = 1 - t;
      low = Math.max(low, u * u * u * n[1] + 3 * u * u * t * n[3] + 3 * u * t * t * n[5] + t * t * t * n[7]);
    }
    expect(cableBottom(a, b)).toBeGreaterThanOrEqual(low);
    expect(cableBottom(a, b)).toBeCloseTo(200 + 30 + 0.15 * 590);
  });
});
