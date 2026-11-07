import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { confirmReleasingKeys, createShortcutHandlers, installShortcuts } from './shortcuts';

const mk = () => {
  const sent: number[][] = [];
  const octs: number[] = [];
  const h = createShortcutHandlers({ playing: false } as any, { send: (...a: number[]) => (sent.push(a), true) }, (o) => octs.push(o));
  return { sent, octs, h };
};
const key = (code: string, extra: object = {}) => ({ code, target: null, repeat: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, ...extra }) as unknown as KeyboardEvent;

describe('shortcut handlers', () => {
  it('piano key sends note on / off', () => {
    const { sent, h } = mk();
    h.onKeyDown(key('KeyA'));
    h.onKeyUp(key('KeyA'));
    expect(sent).toEqual([[Op.NOTE_ON, 60, 100], [Op.NOTE_OFF, 60]]);
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

  it('confirmReleasingKeys releases held keys before the (blocking) dialog', () => {
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
      const uninstall = installShortcuts({ playing: false } as any, { send: (...a: number[]) => (sent.push(a), true) });
      listeners.get('keydown')!(key('KeyA'));
      let atDialog: number[][] = [];
      const ok = confirmReleasingKeys('Remove?', () => ((atDialog = [...sent]), false));
      expect(ok).toBe(false);
      expect(atDialog).toEqual([[Op.NOTE_ON, 60, 100], [Op.NOTE_OFF, 60]]);
      // The keyup the dialog swallowed never comes; nothing is left to release.
      uninstall();
      expect(sent).toHaveLength(2);
    } finally {
      g.window = w;
      g.document = d;
    }
  });
});
