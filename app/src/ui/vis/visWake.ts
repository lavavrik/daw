// Waking idle visuals (plan 12 Task 5 review). Visuals that only show sound
// (the voice LEDs, the analysers) leave the frame loop when the transport is
// stopped and nothing has shown for IDLE_AFTER_MS (idleDriver.ts,
// analyserBus.ts), so with the app open and idle the loop pauses entirely.
// This is what brings them back:
//   - setPlaying(true): the transport starts (App follows project.playing);
//   - wake(): a played note-on (input/noteInput.ts, QWERTY or MIDI, also
//     while stopped), any edit (a patch that drones without a note), and a
//     new engine (App).
// Sound the engine makes without any of these (a release tail after Stop)
// keeps a visual awake while it lasts, because it is still showing it.
export interface VisWake {
  /** Subscribe to wakes; returns the unsubscribe. */
  onWake(fn: () => void): () => void;
  /** Something may sound or show now: every idle visual comes back. */
  wake(): void;
  /** The transport's play state; starting to play wakes everything. */
  setPlaying(on: boolean): void;
  playing(): boolean;
}

export function createVisWake(): VisWake {
  const fns = new Set<() => void>();
  let playing = false;
  const wake = () => {
    for (const fn of [...fns]) fn();
  };
  return {
    onWake(fn) {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    wake,
    setPlaying(on) {
      const start = on && !playing;
      playing = on;
      if (start) wake();
    },
    playing: () => playing,
  };
}

let shared: VisWake | null = null;
/** The app's one wake bus. */
export function visWake(): VisWake {
  return (shared ??= createVisWake());
}
