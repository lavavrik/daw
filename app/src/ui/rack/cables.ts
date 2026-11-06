// Rack palette and cable geometry (pure; unit-tested in cables.test.ts).
import type { SignalKind } from '../../audio/catalog';

/** Cable/jack colour per signal kind: you can tell what a cable carries at a glance. */
export const SIGNAL_COLORS: Record<SignalKind, string> = {
  audio: '#5ec4ff',
  pitch: '#f0a23a',
  gate: '#7ddc7d',
  cv: '#b28cff',
};

/** Module header colour per catalog category (unknown categories fall back to utility). */
export const CATEGORY_COLORS: Record<string, string> = {
  source: '#f0a23a',
  shaping: '#b28cff',
  utility: '#8aa0b8',
  effect: '#ff7a8a',
};

export const categoryColor = (category: string) => CATEGORY_COLORS[category] ?? CATEGORY_COLORS.utility;

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
  const sag = 30 + 0.15 * Math.abs(b.x - a.x);
  const cy = Math.max(a.y, b.y) + sag;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M ${r(a.x)} ${r(a.y)} C ${r(a.x)} ${r(cy)} ${r(b.x)} ${r(cy)} ${r(b.x)} ${r(b.y)}`;
}
