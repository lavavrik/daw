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
  tid: string;
  rowId: string;
  name: string;
}

/** Deferred loads: sample id -> where to attach it once the worklet has it. */
const pending = new Map<number, Waiting>();

/**
 * Install the engine's onSampleLoaded handler for the whole session. Returns
 * an uninstall function (forgets pending loads too).
 */
export function installSampleLoads(p: Project, engine: SampleLoadEngine): () => void {
  pending.clear();
  engine.onSampleLoaded = (id, code) => {
    const w = pending.get(id);
    if (!w) return;
    pending.delete(id);
    // The track or row may have been removed meanwhile; setRowSample is a no-op then.
    // RESET: dropped by an engine reset (project load); its session is gone.
    if (code === Err.OK) setRowSample(p, engine, w.tid, w.rowId, id, w.name);
    else if (code !== HostErr.RESET) banners.error = `Couldn't load "${w.name}" — ${loadErrorText(code, engine.sampleRate)}`;
    if (pending.size === 0) banners.notice = null;
  };
  return () => {
    engine.onSampleLoaded = undefined;
    pending.clear();
  };
}

/** Remember a DEFERRED load and show the "will load when playback stops" notice. */
export function deferSampleLoad(id: number, tid: string, rowId: string, name: string) {
  pending.set(id, { tid, rowId, name });
  banners.notice = `"${name}" will load when playback stops`;
}

/** Loads still waiting for Stop (tests / debugging). */
export const pendingSampleLoads = (): number => pending.size;
