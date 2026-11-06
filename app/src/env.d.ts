/// <reference types="vite/client" />

import type { AudioEngine } from './audio/engine';
import type { Op } from './audio/protocol';

declare global {
  interface Window {
    /** Always set: lets e2e tests (and the console) drive the engine. */
    __daw: { engine: AudioEngine | null; Op: typeof Op };
  }
}
