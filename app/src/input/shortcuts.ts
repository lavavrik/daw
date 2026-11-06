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

/** Returns an uninstall function. */
export function installShortcuts(p: Project, sink: CommandSink): () => void {
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

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') {
      e.preventDefault(); // no page scroll / focused-button activation
      if (!e.repeat) togglePlay(p, sink);
      return;
    }
    if (e.code === 'KeyZ' || e.code === 'KeyX') {
      if (!e.repeat) octave = Math.min(8, Math.max(0, octave + (e.code === 'KeyX' ? 1 : -1)));
      return;
    }
    if (e.repeat) return;
    const note = keyToNote(e.code, octave);
    if (note === null || held.has(e.code)) return;
    held.set(e.code, note);
    sink.send(Op.NOTE_ON, note, PIANO_VELOCITY);
  };

  const onKeyUp = (e: KeyboardEvent) => release(e.code); // always, even if focus moved into an input

  const onBlur = () => {
    for (const code of [...held.keys()]) release(code);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    onBlur();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}
