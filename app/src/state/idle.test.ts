// The project's busy / idle signal (state/idle.ts): what a default-kit
// import waiting out a load or an audio restart awaits instead of polling.
import { describe, expect, it } from 'vitest';
import { markBusy, markIdle, whenIdle } from './idle';
import { Project } from './project.svelte';

const settled = async (pr: Promise<void>) => {
  let done = false;
  void pr.then(() => (done = true));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
};

describe('idle signal', () => {
  it('whenIdle resolves on the idle transition', async () => {
    const p = new Project();
    expect(await settled(whenIdle(p))).toBe(true); // already idle: at once

    markBusy(p);
    expect([p.loading, p.restarting]).toEqual([true, false]);
    const w = whenIdle(p);
    expect(await settled(w)).toBe(false);
    markIdle(p);
    expect([p.loading, p.restarting]).toEqual([false, false]);
    expect(await settled(w)).toBe(true);

    // An audio restart sets both flags; idle clears both.
    markBusy(p, { restarting: true });
    expect([p.loading, p.restarting]).toEqual([true, true]);
    const r = whenIdle(p);
    expect(await settled(r)).toBe(false);
    markIdle(p);
    expect(await settled(r)).toBe(true);
  });

  it('never resolves once the session was replaced (p.generation moved)', async () => {
    const p = new Project();
    markBusy(p);
    const w = whenIdle(p);
    p.generation++; // a load blanked the session (load.ts blankState)
    markIdle(p);
    expect(await settled(w)).toBe(false);
    // A waiter from the new session still gets its signal.
    markBusy(p);
    const next = whenIdle(p);
    markIdle(p);
    expect(await settled(next)).toBe(true);
    expect(await settled(w)).toBe(false);
  });
});
