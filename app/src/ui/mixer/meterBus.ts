// One animation-frame loop for the whole mixer view (MixerView owns it): each
// frame it reads engine.meters() once and hands the live array to every
// subscriber (meters, GR readouts). Subscribers update their DOM directly
// instead of through reactive state, so 35 meters at 60 fps cost no Svelte
// re-renders.
export type MeterFn = (meters: Float32Array, now: number) => void;

export interface MeterBus {
  /** Subscribe; returns the unsubscribe function. */
  on(fn: MeterFn): () => void;
  /** Called by the owner's rAF loop. */
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
