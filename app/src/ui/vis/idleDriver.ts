// A frame-loop consumer that leaves the loop while there is nothing to show
// (plan 12 Task 5 review; the voice LEDs). kick() registers it (once); each
// frame `frame` draws and says whether anything is still showing (a lit LED,
// a held gate). Once the transport is stopped and nothing has shown for
// IDLE_AFTER_MS it removes itself, so an idle Instrument tab costs no frames
// and the loop can pause. A visuals wake (visWake.ts: Play, a note-on, an
// edit, a new engine) kicks it again; stop() (unmount) removes it for good.
// Like waveDriver.ts, but for consumers that read visSab (want bits, 30 Hz)
// and whose "work" is the sound itself.
import type { VisViews } from '../../audio/visLayout';
import type { FrameConsumer, FrameLoop } from './frameLoop';
import { visWake, type VisWake } from './visWake';

/** Stopped and dark for this long: leave the frame loop. */
export const IDLE_AFTER_MS = 500;

export interface IdleDriver {
  /** Be in the frame loop (until idle again). */
  kick(): void;
  /** Leave the loop for good (unmount). */
  stop(): void;
  /** Registered on the loop now. */
  readonly running: boolean;
}

export function createIdleDriver(o: {
  loop: Pick<FrameLoop, 'add'>;
  want: number;
  el?: Element | null;
  hz?: 60 | 30;
  /** Draw; true while anything still shows (keeps it awake). */
  frame(now: number, vis: VisViews): boolean;
  /** Defaults to the app's wake bus. */
  wake?: Pick<VisWake, 'onWake' | 'playing'>;
}): IdleDriver {
  const wake = o.wake ?? visWake();
  let remove: (() => void) | null = null;
  let stopped = false;
  /** When it last showed something or played (NaN: since the next frame). */
  let lastBusy = NaN;
  const leave = () => {
    remove?.();
    remove = null;
  };
  const c: FrameConsumer = {
    want: o.want,
    el: o.el,
    hz: o.hz,
    frame(now, vis) {
      const busy = o.frame(now, vis) || wake.playing();
      if (busy || Number.isNaN(lastBusy)) lastBusy = now;
      else if (now - lastBusy > IDLE_AFTER_MS) leave();
    },
  };
  const kick = () => {
    if (stopped) return;
    lastBusy = NaN;
    remove ??= o.loop.add(c);
  };
  const off = wake.onWake(kick);
  return {
    kick,
    stop() {
      stopped = true;
      off();
      leave();
    },
    get running() {
      return remove !== null;
    },
  };
}
