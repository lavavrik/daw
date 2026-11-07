// Global keyboard shortcuts: Space = play/stop, R = record arm, Z/X = octave
// down/up, Shift+L = PAT/SONG, Cmd/Ctrl+S save (+Shift: save as), Cmd/Ctrl+O open,
// Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z or Ctrl+Y redo, home-row/top-row keys = piano (see qwertyPiano.ts). Piano notes go
// through the note input bus (noteInput.ts) stamped with the KeyboardEvent's
// timeStamp, so the recorder can place them at the heard time.
import { togglePlay } from '../state/actions';
import { setMode } from '../state/song-actions';
import type { CommandSink } from '../state/actions';
import type { Project } from '../state/project.svelte';
import { keyToNote } from './qwertyPiano';
import type { NoteInput } from './noteInput';

const PIANO_VELOCITY = 100;
/** Recorder source id of the computer keyboard. */
export const QWERTY_SOURCE = 'qwerty';

export interface ShortcutOptions {
  /** Fires (with the new octave) on Z/X. */
  onOctave?: (o: number) => void;
  /** Space. The app passes its own (count-in, recorder stop tick); default togglePlay(p, sink). */
  onTogglePlay?: () => void;
  /** R: toggle record arm. */
  onToggleArm?: () => void;
  /** Shift+L: toggle PAT/SONG (plain L stays a piano key). Default setMode(p, sink, other). */
  onToggleMode?: () => void;
  /** Cmd/Ctrl+S: Project ▸ Save (Save As when there is no folder yet). */
  onSave?: () => void;
  /** Cmd/Ctrl+Shift+S: Project ▸ Save As…. */
  onSaveAs?: () => void;
  /** Cmd/Ctrl+O: Project ▸ Open…. */
  onOpen?: () => void;
  /** Cmd/Ctrl+Z (not while typing: the text field undoes its own text). */
  onUndo?: () => void;
  /** Shift+Cmd/Ctrl+Z or Ctrl+Y (not while typing). */
  onRedo?: () => void;
}

/** Performance-time stamp of an event; "now" when absent (synthetic releases). */
const stamp = (e?: { timeStamp?: number }) =>
  e && Number.isFinite(e.timeStamp) ? (e.timeStamp as number) : performance.now();

/** Input types that don't take typed text: shortcuts stay live while they have focus. */
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

/**
 * True when keys should go to the focused element (text entry), not to the
 * shortcuts. Sliders/checkboxes/buttons don't count: touching one must not
 * silently disable Space and the piano. Number fields (BPM) do count while
 * focused; they release focus on Enter/commit (TopBar).
 */
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
  return el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export interface ShortcutHandlers {
  onKeyDown(e: KeyboardEvent): void;
  onKeyUp(e: KeyboardEvent): void;
  onBlur(): void;
  /** Call with document.hidden on visibilitychange; releases when hidden. */
  onVisibility(hidden: boolean): void;
  /** NOTE_OFF for every held piano key. */
  releaseAll(): void;
}

/**
 * Window-free core (tested with fake events). Stuck-note rules: any held
 * piano note is released on blur, on page hidden, and when a Meta key goes
 * down (macOS swallows the keyup of keys held during Cmd shortcuts).
 */
export function createShortcutHandlers(
  p: Project, sink: CommandSink, input: NoteInput, opts: ShortcutOptions = {},
): ShortcutHandlers {
  const { onOctave } = opts;
  let octave = 4;
  // KeyboardEvent.code -> note that was actually started, so changing the
  // octave while a key is held still releases the right note.
  const held = new Map<string, number>();

  const release = (code: string, perfMs: number) => {
    const note = held.get(code);
    if (note === undefined) return;
    held.delete(code);
    input.off(note, perfMs, QWERTY_SOURCE);
  };
  const releaseAll = () => {
    const now = performance.now();
    for (const code of [...held.keys()]) release(code, now);
  };

  return {
    onKeyDown(e) {
      if (e.metaKey) releaseAll(); // before the typing/modifier bail-out below
      if (p.loading) {
        // A project is replacing the session: no edits, transport or notes.
        // Still swallow Space / Cmd+S / Cmd+O so the browser does nothing.
        if (e.code === 'Space' || ((e.metaKey || e.ctrlKey) && ['KeyS', 'KeyO', 'KeyZ', 'KeyY'].includes(e.code))) e.preventDefault();
        return;
      }
      // Undo / redo (held: repeats, like any editor). In a text field the
      // browser's own text undo runs instead.
      const undoKey = (e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyZ';
      const redoKey = (undoKey && e.shiftKey) || (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyY');
      if ((undoKey || redoKey) && !isTyping(e.target)) {
        e.preventDefault();
        (redoKey ? opts.onRedo : opts.onUndo)?.();
        return;
      }
      // Project shortcuts work even in a text field (like any app's Save);
      // the browser's own Save page / Open file are suppressed.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.code === 'KeyS' || e.code === 'KeyO')) {
        e.preventDefault();
        if (e.repeat) return;
        if (e.code === 'KeyO') opts.onOpen?.();
        else (e.shiftKey ? opts.onSaveAs : opts.onSave)?.();
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault(); // no page scroll / focused-button activation
        if (!e.repeat) (opts.onTogglePlay ?? (() => togglePlay(p, sink)))();
        return;
      }
      if (e.code === 'KeyL' && e.shiftKey) {
        if (!e.repeat) (opts.onToggleMode ?? (() => setMode(p, sink, p.mode === 'song' ? 'pattern' : 'song')))();
        return;
      }
      if (e.code === 'KeyR') {
        if (!e.repeat) opts.onToggleArm?.();
        return;
      }
      if (e.code === 'KeyZ' || e.code === 'KeyX') {
        if (!e.repeat) {
          const next = Math.min(8, Math.max(0, octave + (e.code === 'KeyX' ? 1 : -1)));
          if (next !== octave) {
            octave = next;
            onOctave?.(octave);
          }
        }
        return;
      }
      if (e.repeat) return;
      const note = keyToNote(e.code, octave);
      if (note === null || held.has(e.code)) return;
      held.set(e.code, note);
      input.on(note, PIANO_VELOCITY, stamp(e), QWERTY_SOURCE);
    },
    onKeyUp: (e) => release(e.code, stamp(e)), // always, even if focus moved into an input
    onBlur: releaseAll,
    onVisibility(hidden) {
      if (hidden) releaseAll();
    },
    releaseAll,
  };
}

/** Handlers of the installed shortcuts (one per session), for releaseHeldKeys. */
let installed: ShortcutHandlers | null = null;

/** Release every held piano key now (no-op when shortcuts aren't installed). */
export function releaseHeldKeys() {
  installed?.releaseAll();
}

/**
 * Native confirm() that can't strand a note: the dialog blocks the main
 * thread and swallows the keyup of a piano key held while it is open, so the
 * note would hang after Cancel. Release held keys first. `ask` is for tests.
 */
export function confirmReleasingKeys(message: string, ask: (m: string) => boolean = (m) => window.confirm(m)): boolean {
  releaseHeldKeys();
  return ask(message);
}

/** Returns an uninstall function. */
export function installShortcuts(p: Project, sink: CommandSink, input: NoteInput, opts: ShortcutOptions = {}): () => void {
  const h = createShortcutHandlers(p, sink, input, opts);
  installed = h;
  const onVis = () => h.onVisibility(document.hidden);
  window.addEventListener('keydown', h.onKeyDown);
  window.addEventListener('keyup', h.onKeyUp);
  window.addEventListener('blur', h.onBlur);
  document.addEventListener('visibilitychange', onVis);
  return () => {
    h.onBlur();
    if (installed === h) installed = null;
    window.removeEventListener('keydown', h.onKeyDown);
    window.removeEventListener('keyup', h.onKeyUp);
    window.removeEventListener('blur', h.onBlur);
    document.removeEventListener('visibilitychange', onVis);
  };
}
