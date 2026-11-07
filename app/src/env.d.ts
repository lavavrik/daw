/// <reference types="vite/client" />

import type { AudioEngine } from './audio/engine';
import type { AudioClock } from './audio/audioClock';
import type { Op } from './audio/protocol';
import type { Recorder } from './state/recorder';
import type { Project } from './state/project.svelte';

declare global {
  interface Window {
    /** Always set: lets e2e tests (and the console) drive the engine. */
    __daw: { engine: AudioEngine | null; Op: typeof Op; clock: AudioClock | null; recorder: Recorder | null; project: Project };
  }
}
