import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { createShortcutHandlers, releaseHeldKeys, installShortcuts } from './shortcuts';
import { createNoteInput } from './noteInput';
import { DEFAULT_OCTAVE } from './qwertyPiano';
import type { NoteListener } from './noteInput';

const mk = (opts: { onTogglePlay?: () => void; onToggleArm?: () => void; onSave?: () => void; onSaveAs?: () => void; onOpen?: () => void; onUndo?: () => void; onRedo?: () => void; onTab?: (t: string) => void } = {}, project: object = { playing: false }) => {
  const sent: number[][] = [];
  const octs: number[] = [];
  const heard: unknown[][] = []; // what the recorder side of the bus saw
  const listener: NoteListener = {
    noteOn: (...a) => void heard.push(['on', ...a]),
    noteOff: (...a) => void heard.push(['off', ...a]),
    closeSource: (...a) => void heard.push(['close', ...a]),
    sustain: (...a) => void heard.push(['sustain', ...a]),
  };
  const sink = { send: (...a: number[]) => (sent.push(a), true) };
  const h = createShortcutHandlers(project as any, sink, createNoteInput(sink, listener), {
    onOctave: (o) => octs.push(o),
    ...opts,
  });
  return { sent, octs, heard, h };
};
const key = (code: string, extra: object = {}) => ({ code, target: null, repeat: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, ...extra }) as unknown as KeyboardEvent;

describe('shortcut handlers', () => {
  it('while a project loads every shortcut is ignored (fix 3)', () => {
    const calls: string[] = [];
    const { sent, h } = mk({ onTogglePlay: () => calls.push('play'), onSave: () => calls.push('save'), onToggleArm: () => calls.push('arm') }, { playing: false, loading: true });
    let prevented = 0;
    h.onKeyDown(key('Space', { preventDefault: () => prevented++ }));
    h.onKeyDown(key('KeyR'));
    h.onKeyDown(key('KeyA'));
    h.onKeyDown(key('KeyS', { metaKey: true, preventDefault: () => prevented++ }));
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
    expect(prevented).toBe(2); // no page scroll / browser Save dialog either
  });
  it('Cmd/Ctrl+S saves, Cmd/Ctrl+Shift+S saves as, Cmd/Ctrl+O opens (even while typing; default prevented)', () => {
    const calls: string[] = [];
    const { sent, h } = mk({ onSave: () => calls.push('save'), onSaveAs: () => calls.push('as'), onOpen: () => calls.push('open') });
    let prevented = 0;
    const pd = { preventDefault: () => prevented++ };
    h.onKeyDown(key('KeyS', { metaKey: true, ...pd }));
    h.onKeyDown(key('KeyS', { ctrlKey: true, shiftKey: true, ...pd }));
    h.onKeyDown(key('KeyO', { ctrlKey: true, target: { tagName: 'INPUT', type: 'text' }, ...pd }));
    h.onKeyDown(key('KeyS', { metaKey: true, repeat: true, ...pd })); // held: once
    expect(calls).toEqual(['save', 'as', 'open']);
    expect(prevented).toBe(4);
    expect(sent).toEqual([]); // no piano note for S
  });

  it('Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z and Ctrl+Y redo; not while typing; Z alone is still octave down', () => {
    const calls: string[] = [];
    const { h, octs } = mk({ onUndo: () => calls.push('undo'), onRedo: () => calls.push('redo') });
    let prevented = 0;
    const pd = { preventDefault: () => prevented++ };
    h.onKeyDown(key('KeyZ', { metaKey: true, ...pd }));
    h.onKeyDown(key('KeyZ', { ctrlKey: true, ...pd }));
    h.onKeyDown(key('KeyZ', { metaKey: true, shiftKey: true, ...pd }));
    h.onKeyDown(key('KeyY', { ctrlKey: true, ...pd }));
    h.onKeyDown(key('KeyZ', { metaKey: true, repeat: true, ...pd })); // held: repeats
    expect(calls).toEqual(['undo', 'undo', 'redo', 'redo', 'undo']);
    expect(prevented).toBe(5);
    // In a text field the browser undoes the text.
    const input = { tagName: 'INPUT', type: 'text' };
    h.onKeyDown(key('KeyZ', { metaKey: true, target: input, ...pd }));
    expect(calls).toHaveLength(5);
    expect(prevented).toBe(5);
    h.onKeyDown(key('KeyZ'));
    expect(octs).toEqual([3]);
    // While a project loads: swallowed, nothing runs.
    const l = mk({ onUndo: () => calls.push('undo') }, { playing: false, loading: true });
    l.h.onKeyDown(key('KeyZ', { metaKey: true, ...pd }));
    expect(calls).toHaveLength(5);
    expect(prevented).toBe(6);
  });

  it('piano key sends note on / off', () => {
    const { sent, h } = mk();
    h.onKeyDown(key('KeyA'));
    h.onKeyUp(key('KeyA'));
    expect(sent).toEqual([[Op.NOTE_ON, 60, 100], [Op.NOTE_OFF, 60]]);
  });
  it('piano notes go through the note input with the event timestamp', () => {
    const { heard, h } = mk();
    h.onKeyDown(key('KeyA', { timeStamp: 1234.5 }));
    h.onKeyUp(key('KeyA', { timeStamp: 1500 }));
    expect(heard).toEqual([['on', 60, 100, 1234.5, 'qwerty'], ['off', 60, 1500, 'qwerty']]);
    // Releases without an event (blur, meta, dialogs) are stamped "now".
    h.onKeyDown(key('KeyS', { timeStamp: 2000 }));
    h.onBlur();
    expect(heard.at(-1)![0]).toBe('off');
    expect(Number.isFinite(heard.at(-1)![2])).toBe(true);
  });
  it('R toggles record arm (not on repeat, not while typing, not with modifiers)', () => {
    let arms = 0;
    const { sent, h } = mk({ onToggleArm: () => arms++ });
    h.onKeyDown(key('KeyR'));
    h.onKeyDown(key('KeyR', { repeat: true }));
    h.onKeyDown(key('KeyR', { target: { tagName: 'INPUT', type: 'text' } }));
    h.onKeyDown(key('KeyR', { metaKey: true })); // Cmd+R reloads; leave it alone
    expect(arms).toBe(1);
    expect(sent).toEqual([]); // R is not a piano key
  });
  it('Space calls onTogglePlay when given (count-in decided by the app)', () => {
    let toggles = 0;
    const { sent, h } = mk({ onTogglePlay: () => toggles++ });
    h.onKeyDown(key('Space'));
    expect(toggles).toBe(1);
    expect(sent).toEqual([]);
  });
  it('meta key releases held piano notes', () => {
    const { sent, h } = mk();
    h.onKeyDown(key('KeyA'));
    h.onKeyDown(key('KeyD'));
    sent.length = 0;
    h.onKeyDown(key('MetaLeft', { metaKey: true }));
    expect(sent).toEqual([[Op.NOTE_OFF, 60], [Op.NOTE_OFF, 64]]);
  });
  it('octave change while held releases the started note', () => {
    const { sent, h } = mk();
    h.onKeyDown(key('KeyA'));
    h.onKeyDown(key('KeyX'));
    sent.length = 0;
    h.onKeyUp(key('KeyA'));
    expect(sent).toEqual([[Op.NOTE_OFF, 60]]);
  });
  it('a key whose pitch another held key already sounds (after an octave change) is ignored', () => {
    const { sent, heard, h } = mk();
    h.onKeyDown(key('KeyK')); // C5 at octave 4
    h.onKeyDown(key('KeyX')); // octave 5: KeyA is C5 too
    h.onKeyDown(key('KeyA'));
    expect(sent.filter((x) => x[0] === Op.NOTE_ON)).toHaveLength(1);
    h.onKeyUp(key('KeyA')); // never started: releases nothing (K's note keeps sounding and recording)
    expect(sent.filter((x) => x[0] === Op.NOTE_OFF)).toHaveLength(0);
    expect(heard.filter((x) => x[0] === 'off')).toHaveLength(0);
    h.onKeyUp(key('KeyK'));
    expect(sent.filter((x) => x[0] === Op.NOTE_OFF)).toEqual([[Op.NOTE_OFF, 72]]);
  });
  it('the default octave is 4 (KeyA = 60), the one DEFAULT_OCTAVE', () => {
    const { sent, h } = mk();
    h.onKeyDown(key('KeyA'));
    expect(sent).toEqual([[Op.NOTE_ON, 60, 100]]);
    expect(DEFAULT_OCTAVE).toBe(4);
  });
  it('blur and hidden visibility release all', () => {
    const { sent, h } = mk();
    h.onKeyDown(key('KeyA'));
    h.onBlur();
    expect(sent.at(-1)).toEqual([Op.NOTE_OFF, 60]);
    h.onKeyDown(key('KeyA'));
    h.onVisibility(true);
    expect(sent.at(-1)).toEqual([Op.NOTE_OFF, 60]);
  });
  it('visible again does not release', () => {
    const { sent, h } = mk();
    h.onKeyDown(key('KeyA'));
    sent.length = 0;
    h.onVisibility(false);
    expect(sent).toEqual([]);
  });
  it('onOctave fires on Z/X and clamps', () => {
    const { octs, h } = mk();
    h.onKeyDown(key('KeyX'));
    h.onKeyDown(key('KeyZ'));
    h.onKeyDown(key('KeyZ'));
    expect(octs).toEqual([5, 4, 3]);
    for (let i = 0; i < 10; i++) h.onKeyDown(key('KeyZ'));
    expect(octs.at(-1)).toBe(0);
  });

  it('releaseHeldKeys releases held keys (called before an inline confirmation opens)', () => {
    // Minimal window/document so installShortcuts can register its listeners.
    const listeners = new Map<string, (e: unknown) => void>();
    const target = {
      addEventListener: (t: string, f: (e: unknown) => void) => listeners.set(t, f),
      removeEventListener: (t: string) => listeners.delete(t),
    };
    const g = globalThis as Record<string, unknown>;
    const [w, d] = [g.window, g.document];
    g.window = target;
    g.document = { ...target, hidden: false };
    try {
      const sent: number[][] = [];
      const sink = { send: (...a: number[]) => (sent.push(a), true) };
      const uninstall = installShortcuts({ playing: false } as any, sink, createNoteInput(sink, null));
      listeners.get('keydown')!(key('KeyA'));
      releaseHeldKeys();
      expect([...sent]).toEqual([[Op.NOTE_ON, 60, 100], [Op.NOTE_OFF, 60]]);
      // The keyup that goes to the popover instead never reaches us; nothing is left to release.
      uninstall();
      expect(sent).toHaveLength(2);
    } finally {
      g.window = w;
      g.document = d;
    }
  });

  it('Alt+1..4 and F6..F9 pick the bottom-panel tabs (matched on e.code, default prevented)', () => {
    const tabs: string[] = [];
    const { h } = mk({ onTab: (t) => tabs.push(t) });
    let prevented = 0;
    const pd = { preventDefault: () => prevented++ };
    for (const c of ['Digit1', 'Digit2', 'Digit3', 'Digit4']) h.onKeyDown(key(c, { altKey: true, ...pd }));
    for (const c of ['F6', 'F7', 'F8', 'F9']) h.onKeyDown(key(c, pd));
    expect(tabs).toEqual(['step', 'pianoroll', 'instrument', 'mixer', 'step', 'pianoroll', 'instrument', 'mixer']);
    expect(prevented).toBe(8);
  });
  it('tab shortcuts ignore plain digits, other modifiers, repeats and a loading project', () => {
    const tabs: string[] = [];
    const { h } = mk({ onTab: (t) => tabs.push(t) });
    h.onKeyDown(key('Digit1'));
    h.onKeyDown(key('Digit1', { altKey: true, metaKey: true }));
    h.onKeyDown(key('Digit1', { altKey: true, ctrlKey: true }));
    h.onKeyDown(key('F6', { metaKey: true }));
    h.onKeyDown(key('Digit2', { altKey: true, repeat: true }));
    expect(tabs).toEqual([]);
    const l = mk({ onTab: (t) => tabs.push(t) }, { playing: false, loading: true });
    l.h.onKeyDown(key('Digit1', { altKey: true }));
    expect(tabs).toEqual([]);
  });
  it('tab shortcuts are ignored while typing or while a confirmation is open', () => {
    const tabs: string[] = [];
    const { h } = mk({ onTab: (t) => tabs.push(t) });
    h.onKeyDown(key('Digit1', { altKey: true, target: { tagName: 'INPUT', type: 'text' } }));
    h.onKeyDown(key('F7', { target: { tagName: 'TEXTAREA' } }));
    const inConfirm = { tagName: 'BUTTON', closest: (sel: string) => (sel.includes('alertdialog') ? {} : null) };
    h.onKeyDown(key('F9', { target: inConfirm }));
    expect(tabs).toEqual([]);
  });
});
