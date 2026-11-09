// The "Note names" preference: letters (C D E, today's spelling) or solfège
// (Do Re Mi). A UI preference kept in localStorage (like the octave), not in
// the project. It is a $state so every reader of noteName() (ui/noteName.ts)
// re-renders when it changes, and so does the canvas drawing that calls it
// inside a $effect (piano roll keys and labels).
export type NoteNameStyle = 'letters' | 'solfege';

const KEY = 'daw.noteNames';

/**
 * The page's storage. Unit tests run in node, whose own `localStorage` global
 * is a getter that warns on any touch (even `typeof`) without
 * --localstorage-file: there only a plain value (a test's vi.stubGlobal) is
 * used, read off the property descriptor without calling the getter.
 */
function storage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  return Object.getOwnPropertyDescriptor(globalThis, 'localStorage')?.value;
}

function load(): NoteNameStyle {
  try {
    return storage()?.getItem(KEY) === 'solfege' ? 'solfege' : 'letters';
  } catch {
    return 'letters'; // storage blocked: the default
  }
}

export const noteNames = $state<{ style: NoteNameStyle }>({ style: load() });

export function setNoteNames(style: NoteNameStyle) {
  noteNames.style = style;
  try {
    storage()?.setItem(KEY, style);
  } catch {
    /* not persisted; still applies for this session */
  }
}
