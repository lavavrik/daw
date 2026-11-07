// The mixer view's meter fan-out. MixerView registers `tick` as a consumer
// of the app's one visual frame loop (ui/vis/frameLoop.ts; want 0, watching
// the mixer element), so it runs at most 60 times a second and pauses while
// the mixer is off screen or the tab is hidden. Each tick reads
// engine.meters() once and hands the live array to every subscriber (meters,
// GR readouts). Subscribers update their DOM directly instead of through
// reactive state, so 35 meters at 60 fps cost no Svelte re-renders.
//
// Caveat: the clip / LIMIT lights latch from what a tick sees. While the
// loop is paused nothing is read, so an over that happens (and falls away
// under the 60 dB/s ballistics) while the mixer is off screen or the tab is
// hidden does not latch them.
export type MeterFn = (meters: Float32Array, now: number) => void;

export interface MeterBus {
  /** Subscribe; returns the unsubscribe function. */
  on(fn: MeterFn): () => void;
  /** Called once per frame-loop frame (MixerView's consumer). */
  tick(meters: Float32Array, now: number): void;
}

export function createMeterBus(): MeterBus {
  const subs = new Set<MeterFn>();
  return {
    on(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    tick(meters, now) {
      for (const fn of subs) fn(meters, now);
    },
  };
}
