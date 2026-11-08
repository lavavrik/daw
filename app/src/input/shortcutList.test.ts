import { describe, expect, it } from 'vitest';
import { createShortcutHandlers } from './shortcuts';
import { createNoteInput } from './noteInput';
import { SHORTCUTS, comboMatches, formatKeys } from './shortcutList';
import type { KeyCombo } from './shortcutList';

// Keeps Help ▸ Keyboard shortcuts (shortcutList.ts) in sync with
// shortcuts.ts: every key + modifier mix is pressed through the real
// handlers; whatever reacts (a callback, a note, a prevented default) must be
// listed, and every listed global combo must react.

const CODES = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((d) => `Digit${d}`),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  'Space', 'Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'Comma', 'Period', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Minus', 'Equal',
  'Slash', 'Backslash', 'Backquote',
];
const MODS = Array.from({ length: 16 }, (_, i) => ({
  metaKey: !!(i & 1), ctrlKey: !!(i & 2), altKey: !!(i & 4), shiftKey: !!(i & 8),
}));

/** Press one key on fresh handlers: did anything react? */
function reacts(code: string, mods: (typeof MODS)[number]): boolean {
  let hit = false;
  const on = () => void (hit = true);
  const sink = { send: () => true };
  const input = createNoteInput(sink, { noteOn: on, noteOff: () => {}, closeSource: () => {}, sustain: () => {} });
  const h = createShortcutHandlers({ playing: false, tracks: [] } as never, sink, input, {
    onTab: on, onOctave: on, onStop: on, onToggleSong: on, onTogglePattern: on, onToggleArm: on,
    onSave: on, onSaveAs: on, onOpen: on, onUndo: on, onRedo: on, pointerDown: () => false,
  });
  h.onKeyDown({ code, key: code, target: null, repeat: false, ...mods, preventDefault: on } as unknown as KeyboardEvent);
  return hit;
}

const listed = (code: string, mods: (typeof MODS)[number]) =>
  SHORTCUTS.some((g) => g.entries.some((e) => e.combos?.some((c) => comboMatches(c, { code, ...mods }))));

describe('the shortcuts sheet list', () => {
  it('lists every key the global shortcuts react to', () => {
    const missing: string[] = [];
    for (const code of CODES) {
      for (const m of MODS) {
        if (reacts(code, m) && !listed(code, m)) missing.push(`${code} ${JSON.stringify(m)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every listed global combo reacts (no stale entries)', () => {
    const dead: KeyCombo[] = [];
    for (const g of SHORTCUTS) {
      for (const e of g.entries) {
        for (const c of e.combos ?? []) {
          const m = {
            metaKey: c.mod === 'cmd', ctrlKey: c.mod === 'ctrl', altKey: !!c.alt, shiftKey: c.shift === true,
          };
          if (!reacts(c.code, m)) dead.push(c);
        }
      }
    }
    expect(dead).toEqual([]);
  });

  it('Space is listed (the e2e checks the sheet shows it)', () => {
    expect(SHORTCUTS.flatMap((g) => g.entries).some((e) => e.keys.includes('Space'))).toBe(true);
  });

  it('formats Mod / Shift / Alt per platform', () => {
    expect(formatKeys('Shift+Mod+S', true)).toBe('⇧⌘S');
    expect(formatKeys('Shift+Mod+S', false)).toBe('Shift+Ctrl+S');
    expect(formatKeys('Alt+1', true)).toBe('⌥1');
    expect(formatKeys('Ctrl+Y', true)).toBe('⌃Y');
  });

  it('comboMatches: Cmd or Ctrl for "cmd", Ctrl only for "ctrl", shift "any"', () => {
    const ev = (o: object) => ({ code: 'KeyZ', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
    expect(comboMatches({ code: 'KeyZ', mod: 'cmd' }, ev({ ctrlKey: true }))).toBe(true);
    expect(comboMatches({ code: 'KeyZ', mod: 'cmd' }, ev({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(comboMatches({ code: 'KeyZ', mod: 'ctrl' }, ev({ metaKey: true }))).toBe(false);
    expect(comboMatches({ code: 'KeyZ', shift: 'any' }, ev({ shiftKey: true }))).toBe(true);
    expect(comboMatches({ code: 'KeyZ' }, ev({ altKey: true }))).toBe(false);
  });
});
