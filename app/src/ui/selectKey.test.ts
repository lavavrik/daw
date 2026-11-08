import { describe, expect, it, vi } from 'vitest';
import { isTypeAheadKey, selectKey } from './selectKey';

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
