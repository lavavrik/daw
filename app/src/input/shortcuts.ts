// Global keyboard shortcuts: Space = play/stop, Z/X = octave down/up,
// home-row/top-row keys = piano (see qwertyPiano.ts).
import { Op } from '../audio/protocol';
import { togglePlay } from '../state/actions';
import type { CommandSink } from '../state/actions';
import type { Project } from '../state/project.svelte';
import { keyToNote } from './qwertyPiano';

const PIANO_VELOCITY = 100;

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
}

/**
 * Window-free core (tested with fake events). Stuck-note rules: any held
 * piano note is released on blur, on page hidden, and when a Meta key goes
 * down (macOS swallows the keyup of keys held during Cmd shortcuts).
 */
export function createShortcutHandlers(p: Project, sink: CommandSink, onOctave?: (o: number) => void): ShortcutHandlers {
  let octave = 4;
  // KeyboardEvent.code -> note that was actually started, so changing the
  // octave while a key is held still releases the right note.
  const held = new Map<string, number>();

  const release = (code: string) => {
    const note = held.get(code);
    if (note === undefined) return;
    held.delete(code);
    sink.send(Op.NOTE_OFF, note);
  };
  const releaseAll = () => {
    for (const code of [...held.keys()]) release(code);
  };

  return {
    onKeyDown(e) {
      if (e.metaKey) releaseAll(); // before the typing/modifier bail-out below
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault(); // no page scroll / focused-button activation
        if (!e.repeat) togglePlay(p, sink);
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
      sink.send(Op.NOTE_ON, note, PIANO_VELOCITY);
    },
    onKeyUp: (e) => release(e.code), // always, even if focus moved into an input
    onBlur: releaseAll,
    onVisibility(hidden) {
      if (hidden) releaseAll();
    },
  };
}

/** Returns an uninstall function. `onOctave` fires (with the new octave) on Z/X. */
export function installShortcuts(p: Project, sink: CommandSink, onOctave?: (o: number) => void): () => void {
  const h = createShortcutHandlers(p, sink, onOctave);
  const onVis = () => h.onVisibility(document.hidden);
  window.addEventListener('keydown', h.onKeyDown);
  window.addEventListener('keyup', h.onKeyUp);
  window.addEventListener('blur', h.onBlur);
  document.addEventListener('visibilitychange', onVis);
  return () => {
    h.onBlur();
    window.removeEventListener('keydown', h.onKeyDown);
    window.removeEventListener('keyup', h.onKeyUp);
    window.removeEventListener('blur', h.onBlur);
    document.removeEventListener('visibilitychange', onVis);
  };
}
