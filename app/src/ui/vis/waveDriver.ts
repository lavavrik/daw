// When a WaveformView is in the shared frame loop (plan 12 Task 4 review):
// only while it has work. kick() registers its consumer (once) when
// something changed (zoom, scroll, size, data, overlay, playback starting);
// each frame draws what is dirty and moves the playhead, and the consumer
// removes itself as soon as `idle()` says nothing is dirty and nothing is
// playing. So a stopped, idle waveform costs no frames at all, and the
// frame loop can pause when it was the only consumer. stop() (unmount)
// removes it for good.
import type { FrameConsumer, FrameLoop } from './frameLoop';

export interface WaveDriver {
  /** There is work: be in the frame loop until idle. */
  kick(): void;
  /** Leave the loop for good (unmount). */
  stop(): void;
}

export function createWaveDriver(o: {
  loop: Pick<FrameLoop, 'add'>;
  el: Element;
  /** One frame: redraw what is dirty, move the playhead. */
  frame(): void;
  /** Nothing dirty and nothing playing (checked after each frame). */
  idle(): boolean;
}): WaveDriver {
  let remove: (() => void) | null = null;
  let stopped = false;
  const leave = () => {
    remove?.();
    remove = null;
  };
  const c: FrameConsumer = {
    want: 0,
    el: o.el,
    frame() {
      o.frame();
      if (o.idle()) leave();
    },
  };
  return {
    kick() {
      if (!stopped && !remove) remove = o.loop.add(c);
    },
    stop() {
      stopped = true;
      leave();
    },
  };
}
