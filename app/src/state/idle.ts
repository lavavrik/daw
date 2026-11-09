// The project's busy / idle signal. See docs/architecture/projects.md
// "The default kit".
//
// `p.loading` (a load, New, restore read or audio restart is replacing or
// rebuilding the session) and `p.restarting` (an audio restart; `loading`
// is set too) are only ever changed through markBusy / markIdle, so work
// that has to wait for the project to be free can await whenIdle instead of
// polling the flags on a timer. Users: a default-kit or kit import refused
// as `busy` (state/defaultKit.ts, state/kit-actions.ts) retries once on the
// signal; a kit load also awaits whenSessionEnds, so a wait whose session is
// gone (whenIdle never resolves for it) still ends.
//
// Callers that set the flags: project/load.ts loadProject, the restore read
// in project/session.ts, audio/restart.ts restartAudio. Tests may still set
// the flags by hand when nothing waits on them.
import type { Project } from './project.svelte';

interface Waiter {
  /** p.generation when whenIdle was called. */
  gen: number;
  resolve: () => void;
}

/** Per project: who waits for the next idle transition. */
const waiters = new WeakMap<Project, Waiter[]>();

/** Per project: the end of one session (its generation) that someone awaits. */
const enders = new WeakMap<Project, { gen: number; promise: Promise<void>; resolve: () => void }>();

/** The project is busy: a load / restore read (`loading`), or an audio restart (both flags). */
export function markBusy(p: Project, opts: { restarting?: boolean } = {}) {
  p.loading = true;
  if (opts.restarting) p.restarting = true;
}

/**
 * The project is free again: both flags cleared, and every whenIdle of the
 * current session resolves. A waiter from an older session (p.generation
 * moved since it asked: a load replaced the session) is dropped, never
 * resolved: what it waited to do belongs to a session that is gone.
 */
export function markIdle(p: Project) {
  p.loading = false;
  p.restarting = false;
  const e = enders.get(p);
  if (e && e.gen !== p.generation) {
    enders.delete(p);
    e.resolve();
  }
  const ws = waiters.get(p);
  if (!ws) return;
  waiters.delete(p);
  for (const w of ws) if (w.gen === p.generation) w.resolve();
}

/**
 * Resolves on the next markIdle (at once if the project is idle now);
 * never if the session was replaced before that (see markIdle). No timer.
 */
export function whenIdle(p: Project): Promise<void> {
  if (!p.loading && !p.restarting) return Promise.resolve();
  const gen = p.generation;
  return new Promise((resolve) => {
    const ws = waiters.get(p) ?? [];
    ws.push({ gen, resolve });
    waiters.set(p, ws);
  });
}

/**
 * Resolves once session `gen` is gone: at the first markIdle after a load
 * replaced it (p.generation moved), or at once if it already has. Never for
 * the session still running. One shared promise per session, so racing it
 * against many waits keeps nothing per wait.
 */
export function whenSessionEnds(p: Project, gen: number): Promise<void> {
  if (p.generation !== gen) return Promise.resolve();
  let e = enders.get(p);
  if (!e || e.gen !== gen) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    enders.set(p, (e = { gen, promise, resolve }));
  }
  return e.promise;
}
