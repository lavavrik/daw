// Settles `p.dirty` exactly: once edits pause (`delayMs` after the last
// poke), in an idle callback, compare the project's fingerprint with the one
// saved. markEdited (state/edits.ts) sets dirty at once on every edit; this
// only CLEARS it again when the project is back to its saved state. One
// serialize per pause instead of one per reactive change.
import { untrack } from 'svelte';
import type { Project } from '../state/project.svelte';
import { projectFingerprint } from './serialize';

type Idle = (fn: () => void) => void;

const defaultIdle: Idle = (fn) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 2000 });
  else setTimeout(fn, 0);
};

export function createDirtyCheck(p: Project, opts: { delayMs?: number; idle?: Idle } = {}) {
  const delay = opts.delayMs ?? 500;
  const idle = opts.idle ?? defaultIdle;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    /** An edit happened (App: on every Project.version change). */
    poke() {
      clearTimeout(timer);
      timer = setTimeout(() => idle(() => untrack(() => {
        if (p.loading || p.savedFingerprint === null) return;
        p.dirty = projectFingerprint(p) !== p.savedFingerprint;
      })), delay);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
