// The "Note names" preference: letters (C D E, today's spelling) or solfège
// (Do Re Mi). A UI preference kept in localStorage (like the octave), not in
// the project. It is a $state so every reader of noteName() (ui/noteName.ts)
// re-renders when it changes, and so does the canvas drawing that calls it
// inside a $effect (piano roll keys and labels).
export type NoteNameStyle = 'letters' | 'solfege';

const KEY = 'daw.noteNames';

function load(): NoteNameStyle {
  try {
    return localStorage.getItem(KEY) === 'solfege' ? 'solfege' : 'letters';
  } catch {
    return 'letters'; // storage blocked: the default
  }
}

export const noteNames = $state<{ style: NoteNameStyle }>({ style: load() });

export function setNoteNames(style: NoteNameStyle) {
  noteNames.style = style;
  try {
    localStorage.setItem(KEY, style);
  } catch {
    /* not persisted; still applies for this session */
  }
}
