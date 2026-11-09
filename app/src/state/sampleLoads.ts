// Session-lifetime bookkeeping for deferred sample loads.
//
// A sample dropped while playing may not fit the worklet's arena; the engine
// parks it (Err.DEFERRED) and settles it once playback stops, by calling
// `engine.onSampleLoaded(id, code)` exactly once per load. That callback must
// outlive the step grid: the grid unmounts whenever a synth track is selected
// (BottomPanel), and a load that settled while it was gone would be lost (no
// row assigned, the "will load when playback stops" notice stuck forever).
// So the pending map and the handler live here, installed once from App.
//
// Sample memory (state/sampleBudget.ts): importSample reserved a deferred
// load's floats in p.arenaFloats when it took the id. Each pending entry
// keeps that amount (from p.sampleMeta at the engine's rate), and a load
// that later fails gives it back. A reset (project load) recounts by itself;
// after an audio restart the new engine's own uploads were counted, so only
// a load still deferred there keeps (a recomputed) reservation.
//
// Failed loads (plan 9): an audio clip is placed on its sample id at once,
// before the deferred load settles. A load that then fails (not OK, not a
// reset) is remembered here for the session (`sampleFailed`): the timeline
// draws its clip as failed instead of as a normal clip that plays nothing,
// and the target's `onFail` can say more than the generic banner. The clip
// keeps its sample id (Save still writes the bytes; a reopen loads it). A
// new session forgets the failures (ids start over: Project.generation), and
// an audio restart that uploads the sample fine clears it.
import { Err, HostErr } from '../audio/protocol';
import { loadErrorText } from '../audio/samples';
import { setRowSample } from './actions';
import type { CommandSink } from './actions';
import { banners } from './banners.svelte';
import type { Project } from './project.svelte';

/** The slice of AudioEngine this needs (tests pass a fake). */
export interface SampleLoadEngine extends CommandSink {
  onSampleLoaded?: (id: number, code: number) => void;
  readonly sampleRate: number;
}

interface Waiting {
  name: string;
  /** Put the loaded sample where it was dropped (a row, a SamplePlayer); a no-op if that is gone. */
  attach: (id: number) => void;
  /** Floats reserved for it in p.arenaFloats (0: none to give back). */
  floats: number;
  /** Runs after a failure (not a reset), after the generic banner is set. */
  onFail?: (id: number) => void;
  /**
   * Runs when the load is dropped without an answer: an engine reset (its
   * session is gone), an audio restart whose new engine never got it, or a
   * new installSampleLoads. Lets a waiter (a kit load) stop waiting.
   */
  onDrop?: () => void;
}

/** Sample id -> the Project.generation in which its deferred load failed. */
const failed = new Map<number, number>();

/** Deferred loads: sample id -> where to attach it once the worklet has it. */
const pending = new Map<number, Waiting>();
/** The session installSampleLoads was given (row attaches go through it). */
let project: Project | null = null;
let sink: SampleLoadEngine | null = null;

/**
 * Install the engine's onSampleLoaded handler for the whole session. Returns
 * an uninstall function (forgets pending loads too).
 */
export function installSampleLoads(p: Project, engine: SampleLoadEngine): () => void {
  dropAll();
  failed.clear();
  project = p;
  bind(engine);
  return () => {
    if (sink) sink.onSampleLoaded = undefined;
    dropAll();
    failed.clear();
    project = null;
    sink = null;
  };
}

/** Forget every waiting load, telling each one's onDrop. */
function dropAll() {
  const ws = [...pending.values()];
  pending.clear();
  for (const w of ws) w.onDrop?.();
}

/** The settle handler on `engine` (and row attaches through it). */
function bind(engine: SampleLoadEngine) {
  sink = engine;
  engine.onSampleLoaded = (id, code) => settle(id, code, engine.sampleRate);
}

/** The floats sample `id` takes at `sampleRate` (p.sampleMeta), or 0 when unknown. */
function floatsOf(id: number, sampleRate: number): number {
  const m = project?.sampleMeta.get(id);
  return m ? Math.round(m.seconds * sampleRate) * m.channels : 0;
}

function settle(id: number, code: number, sampleRate: number) {
  const w = pending.get(id);
  if (!w) return;
  pending.delete(id);
  // The track or row may have been removed meanwhile; setRowSample is a no-op then.
  // RESET: dropped by an engine reset (project load); its session is gone.
  if (code === Err.OK) w.attach(id);
  else if (code === HostErr.RESET) w.onDrop?.();
  else if (project) project.arenaFloats = Math.max(0, project.arenaFloats - w.floats);
  if (code !== Err.OK && code !== HostErr.RESET) {
    if (project) failed.set(id, project.generation);
    banners.error = `Couldn't load "${w.name}" — ${loadErrorText(code, sampleRate)}`;
    w.onFail?.(id);
  }
  if (pending.size === 0) banners.notice = null;
}

/** Did sample `id`'s deferred load fail in this session? (Its audio clips then play nothing.) */
export function sampleFailed(id: number): boolean {
  const gen = failed.get(id);
  return gen !== undefined && project !== null && gen === project.generation;
}

/**
 * Audio restart (audio/restart.ts): the old engine is closed with loads
 * still waiting for Stop. Move the handler to `engine` and settle each
 * waiting load from the new engine's upload results (`codes`, from
 * replayInto: the restart re-uploaded every kept sample at its own id); a
 * load the new engine never got (its bytes were not kept) is dropped.
 */
export function rebindSampleLoads(engine: SampleLoadEngine, codes: Map<number, number>) {
  if (sink && sink !== engine) sink.onSampleLoaded = undefined;
  bind(engine);
  for (const [id, code] of codes) if (code === Err.OK) failed.delete(id); // the new engine has it now
  for (const [id, w] of [...pending]) {
    const code = codes.get(id);
    // The restart counted only the uploads its engine took (OK / DEFERRED).
    w.floats = code === Err.DEFERRED ? floatsOf(id, engine.sampleRate) : 0;
    if (code === undefined) {
      pending.delete(id);
      w.onDrop?.();
    } else if (code !== Err.DEFERRED) settle(id, code, engine.sampleRate); // DEFERRED: the new engine settles it
  }
  if (pending.size === 0) banners.notice = null;
}

/**
 * Remember a DEFERRED load for drum row `rowId` and show the "will load when
 * playback stops" notice.
 */
export function deferSampleLoad(id: number, tid: string, rowId: string, name: string) {
  deferSampleAssign(id, name, (sid) => {
    if (project && sink) setRowSample(project, sink, tid, rowId, sid, name);
  });
}

/**
 * Same, for any target: `attach(id)` runs once the load succeeded, `onFail(id)`
 * once it failed (not for a reset), `onDrop()` when it is dropped unanswered
 * (a reset, an audio restart that lost it, a new session's install). Register it as soon as importSample
 * returns: a Stop before that would settle the load with no one waiting.
 */
export function deferSampleAssign(
  id: number, name: string, attach: (id: number) => void, onFail?: (id: number) => void, onDrop?: () => void,
) {
  failed.delete(id);
  pending.set(id, { name, attach, floats: sink ? floatsOf(id, sink.sampleRate) : 0, onFail, onDrop });
  banners.notice = `"${name}" will load when playback stops`;
}

/** Loads still waiting for Stop (tests / debugging). */
export const pendingSampleLoads = (): number => pending.size;

/**
 * The sample ids those loads wait for. An audio restart counts them as used
 * (audio/restart.ts deps.inFlight): they are uploaded before the switch, so
 * rebindSampleLoads can settle them from the codes.
 */
export const pendingSampleIds = (): number[] => [...pending.keys()];
