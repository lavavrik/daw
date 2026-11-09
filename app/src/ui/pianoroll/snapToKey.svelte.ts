// The piano roll's "Snap to key" toggle (plan 26 Task 1; docs/architecture/
// theory.md): while on, notes drawn, dragged or nudged land on the nearest
// in-key pitch (prMath.movedPitch). A UI preference kept in localStorage,
// like the note names (ui/noteNames.svelte.ts), not in the project: it is
// how this person likes to edit, not part of the song. Off by default.
const KEY = 'daw.snapToKey';

/** The page's storage (see ui/noteNames.svelte.ts: node's own localStorage getter warns on any touch). */
function storage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  return Object.getOwnPropertyDescriptor(globalThis, 'localStorage')?.value;
}

function load(): boolean {
  try {
    return storage()?.getItem(KEY) === '1';
  } catch {
    return false; // storage blocked: the default
  }
}

export const snapToKey = $state<{ on: boolean }>({ on: load() });

export function setSnapToKey(on: boolean) {
  snapToKey.on = on;
  try {
    storage()?.setItem(KEY, on ? '1' : '0');
  } catch {
    /* not persisted; still applies for this session */
  }
}
