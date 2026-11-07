import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTempo } from '../state/actions';
import { markEdited } from '../state/edits';
import { createDirtyCheck } from './dirtyCheck';
import { markSaved } from './session';
import { buildFixture, nullSink } from './testFixture';

describe('dirty check (fix 5)', () => {
  afterEach(() => vi.useRealTimers());

  it('after edits settle, dirty follows the fingerprint (back to the saved state = clean)', async () => {
    vi.useFakeTimers();
    const { p } = await buildFixture();
    markSaved(p);
    const check = createDirtyCheck(p, { delayMs: 500, idle: (fn) => fn() });
    setTempo(p, nullSink, 140);
    markEdited(p);
    check.poke();
    expect(p.dirty).toBe(true);
    setTempo(p, nullSink, 132.5); // back to the saved tempo
    markEdited(p);
    check.poke();
    vi.advanceTimersByTime(499);
    expect(p.dirty).toBe(true); // debounced
    vi.advanceTimersByTime(1);
    expect(p.dirty).toBe(false);
    check.dispose();
  });

  it('a real difference stays dirty', async () => {
    vi.useFakeTimers();
    const { p } = await buildFixture();
    markSaved(p);
    const check = createDirtyCheck(p, { delayMs: 500, idle: (fn) => fn() });
    setTempo(p, nullSink, 90);
    markEdited(p);
    check.poke();
    vi.advanceTimersByTime(600);
    expect(p.dirty).toBe(true);
  });
});
