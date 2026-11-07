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
// engine (deps.stop / unwire / wire):
//   1. refuse while a load (or another restart) runs: p.loading;
//   2. p.loading = true for the whole restart (the "Loading…" overlay blocks
//      edits; shortcuts, undo and sample imports already respect it);
//   3. deps.stop(): the transport stops through the App's own path (the
//      recorder closes held notes at the heard tick), held keys released;
//   4. deps.unwire(): per-engine loops detached; then the old engine closes
//      (its context too: pending uploads settle, later sends do nothing);
//   5. start a new engine with the hint; if the device refuses it, start
//      again with the old hint and report the error (if that fails too, the
//      error propagates: there is no engine any more);
//   6. replayInto the new engine, then deps.wire(new engine, upload codes)
//      in the same task as the last replayed command.
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

export interface RestartDeps<E extends RestartEngine> {
  /** The engine running now (closed by the restart). */
  old: E;
  /** The hint `old` was started with: the fallback if the new one fails. */
  oldHint: LatencyHint;
  /** AudioEngine.start with that hint. */
  start(hint: LatencyHint): Promise<E>;
  /** Stop the transport the App's way (recorder stop tick) and release held keys. */
  stop(): void;
  /** Detach what runs against the old engine (its rAF loops, callbacks). */
  unwire(): void;
  /**
   * Point everything at the new engine (clock, recorder, MIDI, meters, ...).
   * `codes`: each re-uploaded sample's result (deferred loads settle from it).
   */
  wire(e: E, codes: Map<number, number>): void;
}

export interface RestartResult {
  /** The hint the running engine has (the old one if the new was refused). */
  hint: LatencyHint;
  /** Samples that could not be re-uploaded, and the like. */
  warnings: string[];
  /** Why the requested hint was not applied, or null. */
  error: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Re-create the AudioContext and engine with `hint` and restore the project
 * in memory onto it (sequence above). Null if refused (a load or another
 * restart is running; nothing was touched). Rejects only if no engine could
 * be started at all.
 */
export async function restartAudio<E extends RestartEngine>(
  p: Project, hint: LatencyHint, deps: RestartDeps<E>,
): Promise<RestartResult | null> {
  if (p.loading) return null;
  p.loading = true;
  try {
    deps.stop();
    deps.unwire();
    await deps.old.close();
    let used = hint;
    let error: string | null = null;
    let e: E;
    try {
      e = await deps.start(hint);
    } catch (err) {
      error = `Couldn't start audio with ${hintLabel(hint)} — ${message(err)}. Kept ${hintLabel(deps.oldHint)}.`;
      used = deps.oldHint;
      e = await deps.start(deps.oldHint);
    }
    const { warnings, codes } = await replayInto(p, e, e.context);
    deps.wire(e, codes);
    return { hint: used, warnings, error };
  } finally {
    p.loading = false;
  }
}
