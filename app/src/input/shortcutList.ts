// The list of keyboard shortcuts shown by Help ▸ Keyboard shortcuts
// (ui/ShortcutsSheet.svelte, plan 21 Task 3). It lives next to shortcuts.ts
// on purpose: shortcutList.test.ts presses every key and modifier mix through
// createShortcutHandlers and fails when a key does something that is not
// listed here (or a listed combo does nothing). So a new global shortcut
// cannot ship without its line in the sheet.
//
// Two kinds of entries:
//   - global (with `combos`): bound in shortcuts.ts, checked by the test;
//   - local (no `combos`): an editor's own keys (the piano roll, the
//     timeline …), only while it has the focus. Listed for completeness,
//     not checked (each editor has its own tests).
//
// Display keys use "Mod+" for ⌘ on macOS / Ctrl elsewhere; formatKeys()
// turns them into the platform's spelling.

/** One way to press a shortcut (KeyboardEvent.code plus modifiers). */
export interface KeyCombo {
  code: string;
  /** 'cmd': Cmd or Ctrl (either one; shortcuts.ts takes both); 'ctrl': Ctrl only. Unset: neither. */
  mod?: 'cmd' | 'ctrl';
  /** Shift must be up (false, the default), down (true), or either ('any'). */
  shift?: boolean | 'any';
  alt?: boolean;
}

export interface ShortcutEntry {
  /** What to press, e.g. "Mod+S"; alternatives are separate strings. */
  keys: string[];
  what: string;
  /** Global shortcuts: the combos shortcuts.ts reacts to. Unset: an editor's local keys. */
  combos?: KeyCombo[];
}

export interface ShortcutGroup {
  title: string;
  entries: ShortcutEntry[];
}

const PIANO_CODES = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ', 'KeyK', 'KeyO', 'KeyL'];
const bare = (code: string): KeyCombo => ({ code, shift: 'any' });

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Transport',
    entries: [
      { keys: ['Space'], what: 'Play / stop the song (the pattern while the bottom panel has the focus)', combos: [bare('Space')] },
      { keys: ['R'], what: 'Record arm', combos: [bare('KeyR')] },
    ],
  },
  {
    title: 'Computer keyboard',
    entries: [
      {
        keys: ['A W S E D F T G Y H U J K O L'],
        what: 'Play notes on the Keys → track (on a drum track: its rows)',
        combos: PIANO_CODES.map(bare),
      },
      { keys: ['Z', 'X'], what: 'Octave down / up', combos: [bare('KeyZ'), bare('KeyX')] },
    ],
  },
  {
    title: 'Project',
    entries: [
      { keys: ['Mod+S'], what: 'Save', combos: [{ code: 'KeyS', mod: 'cmd' }] },
      { keys: ['Shift+Mod+S'], what: 'Save as…', combos: [{ code: 'KeyS', mod: 'cmd', shift: true }] },
      { keys: ['Mod+O'], what: 'Open…', combos: [{ code: 'KeyO', mod: 'cmd', shift: 'any' }] },
    ],
  },
  {
    title: 'Edit',
    entries: [
      { keys: ['Mod+Z'], what: 'Undo (during a drag: cancel the drag)', combos: [{ code: 'KeyZ', mod: 'cmd' }] },
      {
        keys: ['Shift+Mod+Z', 'Ctrl+Y'], what: 'Redo',
        combos: [{ code: 'KeyZ', mod: 'cmd', shift: true }, { code: 'KeyY', mod: 'ctrl' }],
      },
    ],
  },
  {
    title: 'Bottom panel tabs',
    entries: [
      {
        keys: ['Alt+1 … Alt+6'], what: 'Step grid, Piano roll, Acid, Instrument, Mixer, Clip',
        combos: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].map((code) => ({ code, alt: true })),
      },
      { keys: ['F6', 'F7', 'F8', 'F9'], what: 'Step grid, Piano roll, Instrument, Mixer', combos: ['F6', 'F7', 'F8', 'F9'].map((code) => ({ code })) },
    ],
  },
  {
    title: 'In the editors (while one has the focus)',
    entries: [
      { keys: ['Esc'], what: 'Cancel a drag, clear the selection, close a menu' },
      { keys: ['Delete', 'Backspace'], what: 'Delete the selected notes or clips' },
      { keys: ['Mod+A'], what: 'Select all (piano roll, timeline)' },
      { keys: ['←', '→', '↑', '↓'], what: 'Nudge the selection (Shift: a bar / an octave)' },
      { keys: ['Q'], what: 'Quantize (piano roll)' },
      { keys: ['Mod+D'], what: 'Duplicate the selected clips (timeline)' },
      { keys: ['Mod+E'], what: 'Split clips at the playhead (timeline)' },
    ],
  },
];

/** Does a key event (code + modifier state) match `c`? */
export function comboMatches(
  c: KeyCombo, e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
): boolean {
  if (c.code !== e.code || !!c.alt !== e.altKey) return false;
  const shift = c.shift ?? false;
  if (shift !== 'any' && shift !== e.shiftKey) return false;
  if (c.mod === 'ctrl') return e.ctrlKey && !e.metaKey;
  if (c.mod === 'cmd') return e.metaKey || e.ctrlKey;
  return !e.metaKey && !e.ctrlKey;
}

/** "Shift+Mod+S" -> "⇧⌘S" on macOS, "Shift+Ctrl+S" elsewhere. */
export function formatKeys(keys: string, mac: boolean): string {
  if (!mac) return keys.replace(/Mod\+/g, 'Ctrl+');
  return keys.replace(/Shift\+/g, '⇧').replace(/Mod\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Ctrl\+/g, '⌃');
}

/** True on macOS (the ⌘ spelling). */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
