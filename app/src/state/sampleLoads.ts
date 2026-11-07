// Session-lifetime bookkeeping for deferred sample loads.
//
// A sample dropped while playing may not fit the worklet's arena; the engine
// parks it (Err.DEFERRED) and settles it once playback stops, by calling
// `engine.onSampleLoaded(id, code)` exactly once per load. That callback must
// outlive the step grid: the grid unmounts whenever a synth track is selected
// (BottomPanel), and a load that settled while it was gone would be lost (no
// row assigned, the "will load when playback stops" notice stuck forever).
// So the pending map and the handler live here, installed once from App.
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
}

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
  pending.clear();
  project = p;
  bind(engine);
  return () => {
    if (sink) sink.onSampleLoaded = undefined;
    pending.clear();
    project = null;
    sink = null;
  };
}

/** The settle handler on `engine` (and row attaches through it). */
function bind(engine: SampleLoadEngine) {
  sink = engine;
  engine.onSampleLoaded = (id, code) => settle(id, code, engine.sampleRate);
}

function settle(id: number, code: number, sampleRate: number) {
  const w = pending.get(id);
  if (!w) return;
  pending.delete(id);
  // The track or row may have been removed meanwhile; setRowSample is a no-op then.
  // RESET: dropped by an engine reset (project load); its session is gone.
  if (code === Err.OK) w.attach(id);
  else if (code !== HostErr.RESET) banners.error = `Couldn't load "${w.name}" — ${loadErrorText(code, sampleRate)}`;
  if (pending.size === 0) banners.notice = null;
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
  for (const id of [...pending.keys()]) {
    const code = codes.get(id);
    if (code === undefined) pending.delete(id);
    else if (code !== Err.DEFERRED) settle(id, code, engine.sampleRate); // DEFERRED: the new engine settles it
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

/** Same, for any target: `attach(id)` runs once the load succeeded. */
export function deferSampleAssign(id: number, name: string, attach: (id: number) => void) {
  pending.set(id, { name, attach });
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
