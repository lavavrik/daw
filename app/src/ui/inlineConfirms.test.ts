import { describe, expect, it } from 'vitest';
import { cancelOpenConfirms, registerConfirm } from './inlineConfirms';

describe('inline confirms registry', () => {
  it('undo cancels an open inline confirm', () => {
    const calls: string[] = [];
    const offA = registerConfirm(() => calls.push('a'));
    const offB = registerConfirm(() => calls.push('b'));
    expect(cancelOpenConfirms()).toBe(true);
    expect(calls.sort()).toEqual(['a', 'b']);
    // Cancelled ones are forgotten even before their host destroys them.
    expect(cancelOpenConfirms()).toBe(false);
    offA();
    offB(); // unregistering twice is harmless
    expect(cancelOpenConfirms()).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('an unregistered confirm is not cancelled', () => {
    let n = 0;
    const off = registerConfirm(() => n++);
    off();
    expect(cancelOpenConfirms()).toBe(false);
    expect(n).toBe(0);
  });
});
