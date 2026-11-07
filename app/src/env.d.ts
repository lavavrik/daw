/// <reference types="vite/client" />

import type { AudioEngine } from './audio/engine';
import type { AudioClock } from './audio/audioClock';
import type { Op } from './audio/protocol';
import type { Recorder } from './state/recorder';
import type { Clip, Project } from './state/project.svelte';

/** Real state actions bound to the project + engine, for e2e tests (App.svelte). */
interface DawActions {
  addClip: (trackId: string, o: { start: number; len?: number; patternId?: string; offset?: number }) => Clip | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [name: string]: (...args: any[]) => any;
}

declare global {
  interface Window {
    /** Always set: lets e2e tests (and the console) drive the engine. */
    __daw: {
      engine: AudioEngine | null; Op: typeof Op; clock: AudioClock | null; recorder: Recorder | null; project: Project; actions: DawActions;
      /** Project ▸ Save / Open with any directory handle (e2e: OPFS). */
      saveTo: (dir: FileSystemDirectoryHandle) => Promise<void>;
      /** Resolves with the load warnings. */
      openFrom: (dir: FileSystemDirectoryHandle) => Promise<string[]>;
    };
  }
}
