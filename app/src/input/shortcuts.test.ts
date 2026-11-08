import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { createShortcutHandlers, releaseHeldKeys, installShortcuts, tabFor } from './shortcuts';
import { createNoteInput } from './noteInput';
import { DEFAULT_OCTAVE } from './qwertyPiano';
import type { NoteListener } from './noteInput';

const mk = (opts: { onToggleSong?: () => void; onTogglePattern?: () => void; inBottomPanel?: (t: EventTarget | null) => boolean; onToggleArm?: () => void; onSave?: () => void; onSaveAs?: () => void; onOpen?: () => void; onUndo?: () => void; onRedo?: () => void; onTab?: (t: string) => void; initialOctave?: number; pointerDown?: () => boolean } = {}, project: object = { playing: false, tracks: [] }) => {
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
    const { sent, h } = mk({ onToggleSong: () => calls.push('play'), onTogglePattern: () => calls.push('pat'), onSave: () => calls.push('save'), onToggleArm: () => calls.push('arm') }, { playing: false, loading: true });
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

  it('Cmd/Ctrl+Alt+Z is undo (and +Shift redo) only while a pointer is down: an Alt-drag cancels (plan 16)', () => {
    const calls: string[] = [];
    let down = false;
    const { h } = mk({ onUndo: () => calls.push('undo'), onRedo: () => calls.push('redo'), pointerDown: () => down });
    h.onKeyDown(key('KeyZ', { metaKey: true, altKey: true }));
    h.onKeyDown(key('KeyY', { ctrlKey: true, altKey: true }));
    expect(calls).toEqual([]); // no drag: Alt makes it some other shortcut
    down = true;
    h.onKeyDown(key('KeyZ', { metaKey: true, altKey: true }));
    h.onKeyDown(key('KeyZ', { ctrlKey: true, altKey: true }));
    h.onKeyDown(key('KeyZ', { metaKey: true, altKey: true, shiftKey: true }));
    h.onKeyDown(key('KeyY', { ctrlKey: true, altKey: true }));
    expect(calls).toEqual(['undo', 'undo', 'redo', 'redo']);
  });

  it('piano key sends note on / off', () => {
    const { sent, h } = mk();
    h.onKeyDown(key('KeyA'));
    h.onKeyUp(key('KeyA'));
    expect(sent).toEqual([[Op.NOTE_ON, 60, 100], [Op.NOTE_OFF, 60]]);
  });
  it('a drum input track: the octave\'s C key plays row 1 (note 36) and the next keys rows 2..15, for engine and recorder', () => {
    // Plan 15 ruling G: note n -> 36 + (n - 12 * (octave + 1)), whatever the octave.
    const drum = { playing: false, tracks: [{ kind: 'drum', id: 'd' }], selectedTrackId: 'd', lastSynthTrackId: null };
    const { sent, heard, h } = mk({ initialOctave: 6 }, drum);
    h.onKeyDown(key('KeyA', { timeStamp: 10 }));
    h.onKeyDown(key('KeyL', { timeStamp: 11 }));
    h.onKeyUp(key('KeyA', { timeStamp: 20 }));
    h.onKeyUp(key('KeyL', { timeStamp: 21 }));
    expect(sent).toEqual([[Op.NOTE_ON, 36, 100], [Op.NOTE_ON, 50, 100], [Op.NOTE_OFF, 36], [Op.NOTE_OFF, 50]]);
    expect(heard.map((x) => x.slice(0, 2))).toEqual([['on', 36], ['on', 50], ['off', 36], ['off', 50]]);
    // A synth input: the keys are a piano again.
    (drum.tracks as { kind: string; id: string }[]).push({ kind: 'synth', id: 's' });
    drum.selectedTrackId = 's';
    h.onKeyDown(key('KeyA'));
    expect(sent.at(-1)).toEqual([Op.NOTE_ON, 84, 100]);
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
  it('Space routes by focus: inside the bottom panel the pattern transport, elsewhere the song transport', () => {
    const calls: string[] = [];
    const panel = { tagName: 'BUTTON', inPanel: true }; // e.g. a step cell
    const { sent, h } = mk({
      onToggleSong: () => calls.push('song'),
      onTogglePattern: () => calls.push('pattern'),
      inBottomPanel: (t) => !!(t as { inPanel?: boolean } | null)?.inPanel,
    });
    let prevented = 0;
    const pd = { preventDefault: () => prevented++ };
    h.onKeyDown(key('Space', pd)); // body
    h.onKeyDown(key('Space', { target: panel, ...pd }));
    h.onKeyDown(key('Space', { target: { tagName: 'CANVAS' }, ...pd })); // the timeline
    h.onKeyDown(key('Space', { target: panel, repeat: true, ...pd })); // held: once
    expect(calls).toEqual(['song', 'pattern', 'song']);
    expect(prevented).toBe(4); // no page scroll, no focused-button click
    expect(sent).toEqual([]);
  });
  it('Space in a text, number or select field (in the panel or not) is left to the field: no transport', () => {
    const calls: string[] = [];
    const { h } = mk({ onToggleSong: () => calls.push('song'), onTogglePattern: () => calls.push('pattern'), inBottomPanel: () => true });
    let prevented = 0;
    const pd = { preventDefault: () => prevented++ };
    for (const target of [
      { tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT', type: 'number' }, { tagName: 'TEXTAREA' },
      { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true },
    ]) h.onKeyDown(key('Space', { target, ...pd }));
    expect(calls).toEqual([]);
    expect(prevented).toBe(0); // the space is typed / the select opens
    // A slider or checkbox is no typing target: Space still toggles.
    h.onKeyDown(key('Space', { target: { tagName: 'INPUT', type: 'range' } }));
    expect(calls).toEqual(['pattern']);
  });
  it('Space without app handlers toggles the song transport (Song mode + PLAY), then STOP', () => {
    const p = { playing: false, mode: 'pattern', songPosition: 0, loop: { on: false, start: 0, end: 3840 }, tracks: [] };
    const { sent, h } = mk({}, p);
    h.onKeyDown(key('Space'));
    expect(sent.map((x) => x[0])).toEqual([Op.SET_MODE, Op.SEEK, Op.PLAY]);
    expect([p.mode, p.playing]).toEqual(['song', true]);
    h.onKeyDown(key('Space'));
    expect(sent.at(-1)![0]).toBe(Op.STOP);
  });
  it('Shift+L is no longer a mode toggle (it plays the L key like plain L)', () => {
    const p = { playing: false, mode: 'pattern', tracks: [] };
    const { sent, h } = mk({}, p);
    h.onKeyDown(key('KeyL', { shiftKey: true }));
    expect(p.mode).toBe('pattern');
    expect(sent.map((x) => x[0])).toEqual([Op.NOTE_ON]);
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
  it('setOctave changes the next note and clamps, without firing onOctave', () => {
    const { sent, octs, h } = mk();
    h.setOctave(6);
    h.onKeyDown(key('KeyA'));
    expect(sent).toEqual([[Op.NOTE_ON, 84, 100]]);
    h.onKeyUp(key('KeyA'));
    h.setOctave(12);
    sent.length = 0;
    h.onKeyDown(key('KeyA'));
    expect(sent).toEqual([[Op.NOTE_ON, 108, 100]]); // octave 8
    expect(octs).toEqual([]);
  });
  it('setOctave while held releases the original note', () => {
    const { sent, h } = mk();
    h.onKeyDown(key('KeyA'));
    h.setOctave(6);
    sent.length = 0;
    h.onKeyUp(key('KeyA'));
    expect(sent).toEqual([[Op.NOTE_OFF, 60]]);
  });
  it('Z/X step from a set octave; initialOctave seeds it', () => {
    const { octs, h } = mk();
    h.setOctave(6);
    h.onKeyDown(key('KeyX'));
    h.onKeyDown(key('KeyZ'));
    h.onKeyDown(key('KeyZ'));
    expect(octs).toEqual([7, 6, 5]);
    const b = mk({ initialOctave: 2 });
    b.h.onKeyDown(key('KeyA'));
    expect(b.sent).toEqual([[Op.NOTE_ON, 36, 100]]);
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
      const uninstall = installShortcuts({ playing: false, tracks: [] } as any, sink, createNoteInput(sink, null));
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

  it('Alt+1..6 follow the tab order and F6..F9 keep their tabs (matched on e.code, default prevented)', () => {
    const tabs: string[] = [];
    const { h } = mk({ onTab: (t) => tabs.push(t) });
    let prevented = 0;
    const pd = { preventDefault: () => prevented++ };
    for (const c of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']) h.onKeyDown(key(c, { altKey: true, ...pd }));
    for (const c of ['F6', 'F7', 'F8', 'F9']) h.onKeyDown(key(c, pd));
    expect(tabs).toEqual(['step', 'pianoroll', 'acid', 'instrument', 'mixer', 'step', 'pianoroll', 'instrument', 'mixer']);
    expect(prevented).toBe(9);
  });
  it('the Acid tab (Alt+3, no F-key) is for synth tracks only', () => {
    expect(tabFor('acid', 'synth')).toEqual({ ok: true });
    expect(tabFor('acid', 'drum')).toEqual({ hint: 'Select a synth track' });
    expect(tabFor('acid', 'audio')).toEqual({ hint: 'Select a synth track' });
    expect(tabFor('acid', null)).toEqual({ hint: 'Select a synth track' });
  });
  it('Alt+6 opens the Clip tab only for audio tracks', () => {
    const tabs: string[] = [];
    const { h } = mk({ onTab: (t) => tabs.push(t) });
    let prevented = 0;
    const pd = { preventDefault: () => prevented++ };
    h.onKeyDown(key('Digit6', { altKey: true, ...pd }));
    expect(tabs).toEqual(['clip']);
    expect(prevented).toBe(1);
    // No F-key: F10 is the browser's menu key (Windows/Linux) and the F6..F9 row stays FL's.
    h.onKeyDown(key('F10', pd));
    expect(tabs).toEqual(['clip']);
    // The host asks tabFor whether the tab is open for the selected track's kind.
    expect(tabFor('clip', 'audio')).toEqual({ ok: true });
    expect(tabFor('clip', 'drum')).toEqual({ hint: 'Select an audio track' });
    expect(tabFor('clip', 'synth')).toEqual({ hint: 'Select an audio track' });
    expect(tabFor('clip', null)).toEqual({ hint: 'Select an audio track' });
    // Audio tracks have no Step grid, Piano roll or Instrument (their existing tooltips).
    expect(tabFor('step', 'audio')).toEqual({ hint: 'Select a drum track' });
    expect(tabFor('pianoroll', 'audio')).toEqual({ hint: 'Select a synth track' });
    expect(tabFor('instrument', 'audio')).toEqual({ hint: 'Select a synth track' });
    expect(tabFor('step', 'drum')).toEqual({ ok: true });
    expect(tabFor('instrument', 'synth')).toEqual({ ok: true });
    expect(tabFor('mixer', 'audio')).toEqual({ ok: true });
    expect(tabFor('mixer', null)).toEqual({ ok: true });
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
    let prevented = 0;
    const pd = { preventDefault: () => prevented++ };
    h.onKeyDown(key('Digit1', { altKey: true, target: { tagName: 'INPUT', type: 'text' }, ...pd }));
    h.onKeyDown(key('F7', { target: { tagName: 'TEXTAREA' }, ...pd }));
    const inConfirm = { tagName: 'BUTTON', closest: (sel: string) => (sel.includes('alertdialog') ? {} : null) };
    h.onKeyDown(key('F9', { target: inConfirm, ...pd }));
    expect(tabs).toEqual([]);
    expect(prevented).toBe(0); // the browser/OS keeps the key where the app does nothing
  });
});
