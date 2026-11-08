import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_WINDOW_MS, isTypeAheadKey, releaseSelect, selectKey } from './selectKey';

const ev = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods, preventDefault: vi.fn() }) as unknown as KeyboardEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
  };

describe('selectKey', () => {
  it('swallows printable keys (the QWERTY piano)', () => {
    for (const k of ['a', 'Z', '3', ' ', ',']) {
      const e = ev(k);
      selectKey(e);
      expect(e.preventDefault, k).toHaveBeenCalled();
    }
  });

  it('leaves navigation keys and shortcuts alone', () => {
    for (const e of [ev('ArrowDown'), ev('Enter'), ev('Escape'), ev('Tab'), ev('z', { metaKey: true }), ev('z', { ctrlKey: true }), ev('a', { altKey: true })]) {
      selectKey(e);
      expect(e.preventDefault, e.key).not.toHaveBeenCalled();
    }
    expect(isTypeAheadKey(ev('F1'))).toBe(false);
  });
});

describe('releaseSelect', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  /** A select that records focus listeners and blurs, and an element to hand the focus to. */
  function fakes() {
    const listeners = new Set<() => void>();
    const sel = {
      blur: vi.fn(),
      addEventListener: (_t: string, f: () => void) => listeners.add(f),
      removeEventListener: (_t: string, f: () => void) => listeners.delete(f),
    };
    const to = { focus: vi.fn() };
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => frames.push(f));
    vi.stubGlobal('document', { activeElement: sel });
    return { sel, to, listeners, frames, refocus: () => listeners.forEach((f) => f()) };
  }

  it('blurs at once, again when the picker hands focus back (for a while), and on the next frame', () => {
    vi.useFakeTimers();
    const f = fakes();
    releaseSelect(f.sel as unknown as HTMLSelectElement);
    expect(f.sel.blur).toHaveBeenCalledTimes(1);
    f.refocus();
    expect(f.sel.blur).toHaveBeenCalledTimes(2);
    f.frames.forEach((fn) => fn()); // still focused a frame later
    expect(f.sel.blur).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(RELEASE_WINDOW_MS);
    expect(f.listeners.size).toBe(0);
  });

  it('with `to`: focuses it instead (the piano roll keeps the keys)', () => {
    vi.useFakeTimers();
    const f = fakes();
    releaseSelect(f.sel as unknown as HTMLSelectElement, f.to as unknown as HTMLElement);
    f.refocus();
    expect(f.sel.blur).not.toHaveBeenCalled();
    expect(f.to.focus).toHaveBeenCalledTimes(2);
    expect(f.to.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
