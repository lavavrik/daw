// Pure parts of the global tooltip (Tooltip.svelte): where the tip goes and
// when it appears. No DOM here so both are unit-testable.

export interface Rect { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }

/** Gap between the element and the tip, and the minimum margin to the viewport edge (px). */
export const TIP_GAP = 6;
export const TIP_MARGIN = 4;

export interface Placement { x: number; y: number; side: 'below' | 'above' }

/** Prefer below the element, centred on it. Flip above when there is no room
 *  below (and more room above); if neither fits, pick the roomier side and
 *  clamp. The x position is clamped into the viewport. */
export function placeTip(anchor: Rect, tip: Size, vp: Size): Placement {
  const below = anchor.top + anchor.height + TIP_GAP;
  const above = anchor.top - TIP_GAP - tip.height;
  const fitsBelow = below + tip.height <= vp.height - TIP_MARGIN;
  const fitsAbove = above >= TIP_MARGIN;
  const side: 'below' | 'above' =
    fitsBelow ? 'below' : fitsAbove ? 'above' : anchor.top > vp.height - (anchor.top + anchor.height) ? 'above' : 'below';
  const rawY = side === 'below' ? below : above;
  const y = Math.max(TIP_MARGIN, Math.min(rawY, vp.height - TIP_MARGIN - tip.height));
  const rawX = anchor.left + anchor.width / 2 - tip.width / 2;
  const x = Math.max(TIP_MARGIN, Math.min(rawX, vp.width - TIP_MARGIN - tip.width));
  return { x, y, side };
}

export const TIP_DELAY_MS = 250;
export const TIP_QUICK_MS = 600;

/** The show delay: 250 ms normally, 0 while a tip is showing or within 600 ms
 *  of the last one hiding (moving along a toolbar). Times are caller-supplied
 *  (performance.now()), so tests need no fake timers. */
export function createTipTiming(delay = TIP_DELAY_MS, quick = TIP_QUICK_MS) {
  let visible = false;
  let hiddenAt = -Infinity;
  return {
    delayFor(now: number): number {
      return visible || now - hiddenAt <= quick ? 0 : delay;
    },
    shown(): void { visible = true; },
    hidden(now: number): void {
      // Only a tip that was actually visible starts the quick-switch window.
      if (visible) hiddenAt = now;
      visible = false;
    },
  };
}
