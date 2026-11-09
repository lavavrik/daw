/// <reference types="vite/client" />

import type { AudioEngine } from './audio/engine';
import type { AudioClock } from './audio/audioClock';
import type { Op } from './audio/protocol';
import type { Recorder } from './state/recorder';
import type { Clip, Project } from './state/project.svelte';
import type { Autosave } from './project/autosave';
import type { Library } from './library/library.svelte';
import type { History } from './history/history';
import type { ProjectJson } from './project/schema';
import type { VisHooks } from './ui/vis/visHooks';

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
      /** The visuals' e2e hooks (ui/vis/visHooks.ts): frame-loop cost, want mask, scope heads, analyser. */
      vis: VisHooks;
      /** Test hook (set once audio starts): feeds raw MIDI bytes through the same handler as a real input. */
      midi?: { inject(bytes: number[]): void };
      /** Project ▸ Save / Open with any directory handle (e2e: OPFS). */
      saveTo: (dir: FileSystemDirectoryHandle) => Promise<void>;
      /** Resolves with the load warnings. */
      openFrom: (dir: FileSystemDirectoryHandle) => Promise<string[]>;
      /** Project ▸ New, as the menu runs it (e2e). */
      newProject: () => Promise<void>;
      /** File ▸ New from template ▸ <id> (state/templates.ts), as the menu runs it (e2e). */
      newFromTemplate: (id: string) => Promise<void>;
      /** The OPFS autosave (e2e: lastSaved, flush). */
      autosave: Autosave;
      /** The Browser's library (e2e: attach(handle) with an OPFS folder). */
      library: Library;
      /** Undo/redo (null until audio starts). */
      history: History | null;
      /** The Pitch / Mod wheels' state (input/wheels.svelte.ts), for e2e. */
      wheels?: { bend: number; mod: number };
      /** serialize(project): what a save writes and undo snapshots (e2e). */
      snapshot: () => ProjectJson;
    };
  }
}
