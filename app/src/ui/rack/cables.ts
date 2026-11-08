// Cable geometry (pure; unit-tested in cables.test.ts).
// Colours live in ui/theme.ts (jackColor, moduleColor): spec §2/§4.

export interface Pt {
  x: number;
  y: number;
}

/**
 * A hanging cable from `a` to `b`: a cubic bezier whose two control points sit
 * `30 + 0.15·|dx|` px below the LOWER of the two ends, so the cable always
 * sags downward (longer cables sag more), whichever end is higher.
 */
export function cablePath(a: Pt, b: Pt): string {
  const cy = cableBottom(a, b);
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M ${r(a.x)} ${r(a.y)} C ${r(a.x)} ${r(cy)} ${r(b.x)} ${r(cy)} ${r(b.x)} ${r(b.y)}`;
}

/**
 * y of the control points, which bounds the lowest point of the curve (a
 * bezier stays inside its control hull). The Rack sizes the cable SVG, and so
 * the scroll area, to cover this, so no cable is clipped or unreachable.
 */
export function cableBottom(a: Pt, b: Pt): number {
  return Math.max(a.y, b.y) + 30 + 0.15 * Math.abs(b.x - a.x);
}
