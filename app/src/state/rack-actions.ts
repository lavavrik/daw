// Synth-track and rack edits. Like actions.ts: every function mutates Project
// AND sends the matching engine command(s), so UI and engine never diverge.
import { clampParam, fxPoolFullText, fxPoolSlots, moduleDef, portIndex } from '../audio/catalog';
import { MAX_MODULES, Op, packPort } from '../audio/protocol';
import { DEFAULT_PATTERN_BARS, MAX_TRACKS, TRACK_COLORS, newChannel, synthTrack } from './project.svelte';
import type { Project, RackCable, RackModule, SynthTrack } from './project.svelte';
import { selectTrack, uniqueTrackName } from './actions';
import type { CommandSink } from './actions';
import { STARTER_PATCHES, validatePatch } from './patches';
import { makeNotePattern } from './pattern-actions';
import type { Patch } from './patches';

/**
 * Takes the lowest free slot (shared with drums). Command order: ADD_SYNTH_TRACK,
 * the patch's commands (RACK_CLEAR first), then selectTrack, which sends
 * SET_INPUT_TRACK if the live input changes. Null when all slots are taken.
 */
export function addSynthTrack(
  p: Project, sink: CommandSink, name = uniqueTrackName(p, 'Synth'), patch: Patch = STARTER_PATCHES[0],
): SynthTrack | null {
  const used = new Set(p.tracks.map((t) => t.slot));
  let slot = 0;
  while (slot < MAX_TRACKS && used.has(slot)) slot++;
  if (slot >= MAX_TRACKS) return null;
  // ADD_SYNTH_TRACK resets all engine patterns and selects 0; bars sent below.
  const pattern = makeNotePattern(0, 'Pattern 1', DEFAULT_PATTERN_BARS);
  p.tracks.push({
    kind: 'synth',
    id: crypto.randomUUID(),
    slot,
    name,
    color: TRACK_COLORS[slot % TRACK_COLORS.length],
    patchName: '',
    modules: [],
    cables: [],
    patterns: [pattern],
    currentPatternId: pattern.id,
    clips: [],
  });
  const track = p.tracks[p.tracks.length - 1] as SynthTrack; // reactive proxy
  p.mixer.channels[track.id] = newChannel(); // the engine resets the mixer slot on ADD
  sink.send(Op.ADD_SYNTH_TRACK, slot);
  sink.send(Op.SET_PATTERN_BARS, slot, DEFAULT_PATTERN_BARS);
  loadPatch(p, sink, track.id, patch);
  selectTrack(p, sink, track.id);
  return track;
}

/**
 * Validate `patch` (validatePatch: anything unknown, out of range or
 * dangling is dropped/clamped, and pooled effects beyond the FX pool are
 * dropped) and load it into the track: RACK_CLEAR, ADD_MODULE per module,
 * SET_PARAM per non-default param, CONNECT per cable. Returns the
 * validation warnings ([] for a clean patch). The FX-pool budget is what is
 * free now plus this rack's own pooled modules: RACK_CLEAR frees them and the
 * engine hands their slots over to the adds that follow.
 */
export function loadPatch(p: Project, sink: CommandSink, trackId: string, patch: unknown): string[] {
  const t = synthTrack(p, trackId);
  if (!t) return [];
  const own = (id: string) => t.modules.filter((m) => moduleDef(m.kind).id === id).length;
  const { patch: v, warnings } = validatePatch(patch, { fxFree: (id) => fxSlotsFree(p, id) + own(id) });
  sink.send(Op.RACK_CLEAR, t.slot);
  const modules: RackModule[] = [];
  const cables: RackCable[] = [];
  const sets: [number, number, number][] = [];
  for (const pm of v.modules) {
    const def = moduleDef(pm.id);
    sink.send(Op.RACK_ADD_MODULE, t.slot, pm.idx, def.kind);
    const params = def.params.map((pd) => pd.default);
    for (const [name, value] of Object.entries(pm.params ?? {})) {
      const i = def.params.findIndex((pd) => pd.name === name);
      params[i] = value; // validated: known and in range
      if (value !== def.params[i].default) sets.push([pm.idx, i, value]);
    }
    modules.push({ idx: pm.idx, kind: def.kind, params });
  }
  for (const [m, i, value] of sets) sink.send(Op.RACK_SET_PARAM, t.slot, m, i, value);
  for (const c of v.cables) {
    const from = modules.find((m) => m.idx === c.from[0])!;
    const to = modules.find((m) => m.idx === c.to[0])!;
    const fp = portIndex(moduleDef(from.kind), 'out', c.from[1]);
    const tp = portIndex(moduleDef(to.kind), 'in', c.to[1]);
    cables.push({ from: { m: from.idx, port: fp }, to: { m: to.idx, port: tp } });
    sink.send(Op.RACK_CONNECT, t.slot, packPort(from.idx, fp), packPort(to.idx, tp));
  }
  t.modules = modules;
  t.cables = cables;
  t.patchName = v.name;
  return warnings;
}

/**
 * Pooled effects (Delay, Reverb, Chorus) share the engine's FX pool across
 * every track. Returns how many more of `kind` fit (Infinity for unpooled
 * kinds), counting the modules of all synth tracks in the project.
 */
export function fxSlotsFree(p: Project, kind: string | number): number {
  const def = moduleDef(kind);
  const slots = fxPoolSlots(def);
  if (slots === null) return Infinity;
  let used = 0;
  for (const t of p.tracks) if (t.kind === 'synth') used += t.modules.filter((m) => m.kind === def.kind).length;
  return Math.max(0, slots - used);
}

/** "All 8 delays in use" (lives in catalog.ts so patches.ts can use it too). */
export { fxPoolFullText };

/**
 * The engine refused RACK_ADD_MODULE (slot, idx, kind) with OUT_OF_MEMORY
 * (the worklet reports it, see AudioEngine.onRackAddRefused): its FX-pool
 * bank was full although `fxSlotsFree` counted a free slot. The engine hands
 * a slot over from a queued Remove/Clear of the same rack, so this only
 * happens when the slot is held elsewhere (e.g. another track's module still
 * in its removal fade). Roll the optimistic add back in state only (the
 * engine added nothing, so no command) and return the pool-full message;
 * null if that module is no longer there (already removed or replaced).
 */
export function rollbackRefusedAdd(p: Project, slot: number, idx: number, kind: number): string | null {
  const t = p.tracks.find((x): x is SynthTrack => x.kind === 'synth' && x.slot === slot);
  if (!t || !t.modules.some((m) => m.idx === idx && m.kind === kind)) return null;
  t.modules = t.modules.filter((m) => m.idx !== idx);
  t.cables = t.cables.filter((c) => c.from.m !== idx && c.to.m !== idx);
  return fxPoolFullText(moduleDef(kind)) || `No room for another ${moduleDef(kind).name}`;
}

/**
 * Lowest free idx; null when the rack is full, the kind's FX-pool slots are
 * all in use (the engine would refuse it), or the track/kind is unknown.
 */
export function addModule(p: Project, sink: CommandSink, trackId: string, kind: string | number): number | null {
  const t = synthTrack(p, trackId);
  if (!t) return null;
  let def;
  try { def = moduleDef(kind); } catch { return null; }
  if (fxSlotsFree(p, def.kind) <= 0) return null;
  const used = new Set(t.modules.map((m) => m.idx));
  let idx = 0;
  while (idx < MAX_MODULES && used.has(idx)) idx++;
  if (idx >= MAX_MODULES) return null;
  t.modules.push({ idx, kind: def.kind, params: def.params.map((pd) => pd.default) });
  sink.send(Op.RACK_ADD_MODULE, t.slot, idx, def.kind);
  return idx;
}

/** The engine drops the module's cables itself; mirror that in state. */
export function removeModule(p: Project, sink: CommandSink, trackId: string, idx: number) {
  const t = synthTrack(p, trackId);
  if (!t || !t.modules.some((m) => m.idx === idx)) return;
  t.modules = t.modules.filter((m) => m.idx !== idx);
  t.cables = t.cables.filter((c) => c.from.m !== idx && c.to.m !== idx);
  sink.send(Op.RACK_REMOVE_MODULE, t.slot, idx);
}

/** Replaces any cable already on `to` (one cable per input). */
export function connect(
  p: Project, sink: CommandSink, trackId: string,
  from: { m: number; port: number }, to: { m: number; port: number },
) {
  const t = synthTrack(p, trackId);
  if (!t) return;
  const fm = t.modules.find((m) => m.idx === from.m);
  const tm = t.modules.find((m) => m.idx === to.m);
  if (!fm || !tm) return;
  if (from.port < 0 || from.port >= moduleDef(fm.kind).outputs.length) return;
  if (to.port < 0 || to.port >= moduleDef(tm.kind).inputs.length) return;
  t.cables = t.cables.filter((c) => !(c.to.m === to.m && c.to.port === to.port));
  t.cables.push({ from: { ...from }, to: { ...to } });
  sink.send(Op.RACK_CONNECT, t.slot, packPort(from.m, from.port), packPort(to.m, to.port));
}

export function disconnect(p: Project, sink: CommandSink, trackId: string, to: { m: number; port: number }) {
  const t = synthTrack(p, trackId);
  if (!t) return;
  t.cables = t.cables.filter((c) => !(c.to.m === to.m && c.to.port === to.port));
  sink.send(Op.RACK_DISCONNECT, t.slot, packPort(to.m, to.port));
}

export function setParam(p: Project, sink: CommandSink, trackId: string, idx: number, paramIdx: number, value: number) {
  const t = synthTrack(p, trackId);
  const m = t?.modules.find((x) => x.idx === idx);
  if (!t || !m || Number.isNaN(value)) return;
  const pd = moduleDef(m.kind).params[paramIdx];
  if (!pd) return;
  m.params[paramIdx] = clampParam(pd, value);
  sink.send(Op.RACK_SET_PARAM, t.slot, idx, paramIdx, m.params[paramIdx]);
}
