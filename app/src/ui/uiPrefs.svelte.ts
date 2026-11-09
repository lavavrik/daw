// Small UI preferences kept in localStorage (like the octave and the note
// names, ui/noteNames.svelte.ts), not in the project: they are about this
// browser's view, not the song. A $state, so every reader re-renders when one
// changes.
//
//  - velLane: the step grid's velocity lane is shown (plan 23 Task 2; the
//    "Velocity" toggle in the grid footer). Default: shown.

const VEL_LANE_KEY = 'daw.velLane';

/**
 * The page's storage. Unit tests run in node, whose own `localStorage` global
 * is a getter that warns on any touch without --localstorage-file: there
 * only a plain value (a test's vi.stubGlobal) is used, read off the property
 * descriptor without calling the getter (as noteNames.svelte.ts).
 */
function storage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  return Object.getOwnPropertyDescriptor(globalThis, 'localStorage')?.value;
}

/** Shown unless this browser stored "0" (storage blocked: shown). */
export function loadVelLane(): boolean {
  try {
    return storage()?.getItem(VEL_LANE_KEY) !== '0';
  } catch {
    return true;
  }
}

export const uiPrefs = $state<{ velLane: boolean }>({ velLane: loadVelLane() });

export function setVelLane(shown: boolean) {
  uiPrefs.velLane = shown;
  try {
    storage()?.setItem(VEL_LANE_KEY, shown ? '1' : '0');
  } catch {
    /* not persisted; still applies for this session */
  }
}
