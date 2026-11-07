// Audio settings: the latency hint (persisted) and the engine restart that
// applies it. See docs/architecture/audio-path.md "Restarting the engine".
//
// An AudioContext's latency hint is fixed at creation, so applying a new one
// means a new AudioContext, and with it a new worklet and engine. The
// project never leaves memory: the new engine is rebuilt from `p` itself
// (project/load.ts replayInto: p.sampleFiles' original bytes decoded with the
// new context, then projectCommands of serialize(p)) -- no page reload, no
// disk reads, and `p` is not touched at all, so its name, folder handle,
// dirty mark, edit count (version) and undo history all carry over. The
// library and project folder handles (IndexedDB / FileSystemDirectoryHandle)
// never belonged to the AudioContext and keep working.
//
// restartAudio only sequences the steps; the App owns what is wired to an
// engine (deps.*). The old engine keeps running until the new one is fully
// up, so any failure leaves the user exactly where they were:
//   1. refuse while a load (or another restart) runs: p.loading;
//   2. deps.flush(): write the autosave first (a failure is ignored: the
//      autosave reports its own errors);
//   3. p.loading + p.restarting for the whole restart (the "Restarting
//      audio…" overlay blocks edits; shortcuts, undo and sample imports
//      respect it);
//   4. deps.stop(): the transport stops through the App's own path (the
//      recorder closes held notes at the heard tick), held keys released;
//   5. start a new engine with the hint (two contexts exist for a moment),
//      within RESTART_TIMEOUT_MS (a vanished device can leave
//      AudioContext.resume() pending forever);
//   6. deps.prepare(new): stall reporting, before any command reaches it;
//   7. replayInto the new engine, within the same timeout;
//   8. success: deps.unwire() (old), deps.wire(new, upload codes) -- in the
//      same task as the last replayed command -- then the old engine closes
//      and p.audioRestarts is bumped;
//      failure (start refused / timed out, replay threw / timed out): the
//      new engine (if any; a start that answers late too) is closed, the old
//      one was never unwired, and the result says "Couldn't apply …; kept
//      previous settings".
import { replayInto } from '../project/load';
import type { LoadEngine, SampleDecoder } from '../project/load';
import type { Project } from '../state/project.svelte';
import type { LatencyHint } from './engine';

export type { LatencyHint };

export const DEFAULT_LATENCY_HINT: LatencyHint = 'interactive';
export const LATENCY_HINT_KEY = 'daw.latencyHint';
/** Custom hints are a buffer length in seconds, within these bounds. */
export const CUSTOM_HINT_MIN_S = 0.001;
export const CUSTOM_HINT_MAX_S = 1;

/** Above this total output latency the UI suggests Bluetooth output as the cause. */
export const BT_LATENCY_MS = 40;

const CATEGORIES: readonly string[] = ['interactive', 'balanced', 'playback'];

/** A valid hint from anything (a stored string, a number); invalid -> 'interactive'. */
export function parseLatencyHint(v: unknown): LatencyHint {
  if (typeof v === 'string' && CATEGORIES.includes(v)) return v as LatencyHint;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LATENCY_HINT;
  return Math.min(CUSTOM_HINT_MAX_S, Math.max(CUSTOM_HINT_MIN_S, n));
}

/**
 * The hint for the Settings panel's custom field (milliseconds; clamped to
 * the bounds above), or null when it applies nothing: empty (NaN from an
 * emptied number input), zero or negative.
 */
export function customHint(ms: number | null | undefined): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(CUSTOM_HINT_MAX_S, Math.max(CUSTOM_HINT_MIN_S, ms / 1000));
}

/** "Interactive", "Balanced", "Playback", or "Custom 20 ms". */
export function hintLabel(h: LatencyHint): string {
  if (typeof h === 'number') return `Custom ${Math.round(h * 1000)} ms`;
  return h[0].toUpperCase() + h.slice(1);
}

type StoreLike = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): StoreLike | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // access itself can throw (blocked site data)
  }
};

/** The hint the next start uses (StartOverlay). Never throws. */
export function loadLatencyHint(store: StoreLike | null = defaultStore()): LatencyHint {
  try {
    return parseLatencyHint(store?.getItem(LATENCY_HINT_KEY) ?? null);
  } catch {
    return DEFAULT_LATENCY_HINT;
  }
}

/** Stored as the category name or the number of seconds. Never throws. */
export function saveLatencyHint(h: LatencyHint, store: StoreLike | null = defaultStore()) {
  try {
    store?.setItem(LATENCY_HINT_KEY, String(h));
  } catch {
    // Private mode / blocked storage: the setting just doesn't persist.
  }
}

/** What a restart needs of an engine (AudioEngine; tests pass a fake). */
export interface RestartEngine extends LoadEngine {
  readonly context: SampleDecoder;
  close(): Promise<void>;
}

/** How long starting the new engine, and then restoring the project onto it, may each take. */
export const RESTART_TIMEOUT_MS = 8000;

export interface RestartDeps<E extends RestartEngine> {
  /** The engine running now (closed once the new one is up; kept on any failure). */
  old: E;
  /** The hint `old` was started with (the result's hint if the new one fails). */
  oldHint: LatencyHint;
  /** AudioEngine.start with that hint. */
  start(hint: LatencyHint): Promise<E>;
  /** Autosave now, before anything changes. */
  flush?(): Promise<unknown>;
  /** Stop the transport the App's way (recorder stop tick) and release held keys. */
  stop(): void;
  /** Hook up what must see the replay already (command-stall reports). */
  prepare?(e: E): void;
  /** Detach what runs against the old engine (its rAF loops, callbacks). */
  unwire(): void;
  /**
   * Point everything at the new engine (clock, recorder, MIDI, meters, ...).
   * `codes`: each re-uploaded sample's result (deferred loads settle from it).
   */
  wire(e: E, codes: Map<number, number>): void;
  /** Tests: RESTART_TIMEOUT_MS otherwise. */
  timeoutMs?: number;
}

export interface RestartResult {
  /** The hint the running engine has (the old one if the restart failed). */
  hint: LatencyHint;
  /** Samples that could not be re-uploaded, and the like. */
  warnings: string[];
  /** Why the requested hint was not applied, or null. */
  error: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Timeout extends Error {}

/** `pr`, or a Timeout rejection after `ms` (pr keeps running). */
function within<T>(pr: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Timeout(`${what} within ${ms / 1000} s`)), ms)));
  return Promise.race([pr, t]).finally(() => clearTimeout(timer));
}

/**
 * Re-create the AudioContext and engine with `hint` and restore the project
 * in memory onto it (sequence above). Null if refused (a load or another
 * restart is running; nothing was touched). Never rejects for an audio
 * failure: `error` says why the old engine was kept.
 */
export async function restartAudio<E extends RestartEngine>(
  p: Project, hint: LatencyHint, deps: RestartDeps<E>,
): Promise<RestartResult | null> {
  if (p.loading) return null;
  const ms = deps.timeoutMs ?? RESTART_TIMEOUT_MS;
  try {
    await deps.flush?.();
  } catch {
    // The autosave shows its own error; the restart keeps the project in memory anyway.
  }
  if (p.loading) return null; // a load started during the flush
  p.loading = true;
  p.restarting = true;
  let e: E | null = null;
  let abandoned = false;
  try {
    deps.stop();
    const starting = deps.start(hint);
    // A start that answers after we gave up is closed at once, never wired.
    starting.then((late) => abandoned && void late.close(), () => {});
    e = await within(starting, ms, 'audio did not start');
    deps.prepare?.(e);
    const { warnings, codes } = await within(replayInto(p, e, e.context), ms, 'restoring the project did not finish');
    deps.unwire();
    deps.wire(e, codes);
    p.audioRestarts++;
    void deps.old.close();
    return { hint, warnings, error: null };
  } catch (err) {
    abandoned = true;
    if (e) void e.close();
    return { hint: deps.oldHint, warnings: [], error: `Couldn't apply ${hintLabel(hint)}: ${message(err)}; kept previous settings` };
  } finally {
    p.loading = false;
    p.restarting = false;
  }
}
