import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTempo } from '../state/actions';
import { commandEdits, markEdited } from '../state/edits';
import { playPattern, playSong, stopTransport } from '../state/song-actions';
import { projectFingerprint, serialize } from './serialize';
import { createDirtyCheck } from './dirtyCheck';
import { markSaved } from './session';
import { buildFixture, nullSink } from './testFixture';

describe('dirty check (fix 5)', () => {
  afterEach(() => vi.useRealTimers());

  it('Play then Stop (either transport) leaves a just-saved project clean; the mode is saved with the next save', async () => {
    vi.useFakeTimers();
    const { p } = await buildFixture();
    markSaved(p);
    const check = createDirtyCheck(p, { delayMs: 500, idle: (fn) => fn() });
    // A sink like the App's: every command goes through commandEdits.
    const sink = { send: (op: number) => (commandEdits(p, op), true) };
    const v = p.version;
    const from = p.mode;
    const other = from === 'song' ? 'pattern' : 'song';
    (other === 'song' ? playSong : playPattern)(p, sink);
    stopTransport(p, sink);
    expect(p.mode).toBe(other);
    expect([p.dirty, p.version]).toEqual([false, v]);
    check.poke();
    vi.advanceTimersByTime(600);
    expect(p.dirty).toBe(false);
    expect(projectFingerprint(p)).toBe(p.savedFingerprint);
    // The next save writes the mode that ran last.
    expect(serialize(p).mode).toBe(other);
    check.dispose();
  });

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
