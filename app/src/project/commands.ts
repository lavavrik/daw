// project.json -> the engine commands that rebuild it, and the matching UI
// state. The ONE place that knows the replay order (plan 7 "one
// command-list builder"): a project load (load.ts), undo's whole-track
// restore (history/diffApply.ts), the export Worker and the audio restart
// all use it.
//
// Order, on a blank engine (after RESET_ALL):
//   tracks, each: ADD_*_TRACK -> patterns (drum: select, step count, swing,
//     steps; synth: select, bars, notes) -> current pattern -> drum rows /
//     synth rack (patchRack) -> clips
//   -> MIX_SET by name (non-defaults only: RESET_ALL set the defaults)
//   -> MIX_SET_KEY last (keys need their source tracks and rows)
//   -> tempo, metronome, mode, loop, live input track (always sent: they
//     must match the UI whatever the engine had).
//
// Pure: no Project, no engine. A validated project (schema.ts validate) is
// still checked against what only a whole project knows: the shared FX pool
// (pooled effects beyond it are dropped) and the MAX_KEYS distinct drum-row
// sidechain keys (a key beyond them is dropped), each with a warning; the
// returned `project` is the normalized one the commands realize.
import { MAX_CLIPS, MAX_KEYS, MIX_DELAY, MIX_MASTER, MIX_REVERB, Op, keyCode } from '../audio/protocol';
import { fxPoolSlots, moduleDef } from '../audio/catalog';
import { mixParam } from '../audio/mixerCatalog';
import { validatePatch } from '../state/patches';
import { makeDrumPattern, makeNotePattern } from '../state/pattern-actions';
import { patchRack } from '../state/rack-actions';
import type { EngineCommand } from '../state/rack-actions';
import { MAX_NOTES } from '../audio/protocol';
import type { Clip, DrumTrack, SynthTrack, Track } from '../state/project.svelte';
import type { MixParamsJson, ProjectJson, SampleJson, TrackJson } from './schema';

export type { EngineCommand };

export interface ProjectCommands {
  /** Send in order to a blank engine. */
  commands: EngineCommand[];
  /** The samples the commands use, with the engine id each must be loaded at. */
  samples: { id: number; sample: SampleJson }[];
  /** `json` as the commands realize it (sample ids remapped, dropped parts gone). */
  project: ProjectJson;
  warnings: string[];
}

/**
 * The commands that rebuild `json` on a blank engine. `sampleIds`: the
 * project's sample id -> the engine id it was loaded at; a use of an id
 * missing from it becomes "none" (its load failed; the caller warned).
 */
export function projectCommands(json: ProjectJson, sampleIds: Map<number, number>): ProjectCommands {
  const warnings: string[] = [];
  const project = normalize(json, sampleIds, warnings);
  const commands: EngineCommand[] = [];
  for (const tj of project.tracks) commands.push(...trackCommands(tj));
  commands.push(...mixerCommands(project));
  commands.push(
    [Op.SET_TEMPO, project.tempo],
    [Op.SET_METRONOME, project.metronome ? 1 : 0],
    [Op.SET_MODE, project.mode === 'song' ? 1 : 0],
    [Op.SET_LOOP, project.loop.on ? project.loop.start : 0, project.loop.on ? project.loop.end : 0],
    [Op.SET_INPUT_TRACK, inputSlot(project)],
  );
  const samples = json.samples
    .filter((s) => sampleIds.has(s.id))
    .map((s) => ({ id: sampleIds.get(s.id)!, sample: s }));
  return { commands, samples, project, warnings };
}

/**
 * Everything one track needs on a blank (or just re-added) slot, in replay
 * order, minus its mixer strip (mixerCommands). `tj` must be normalized
 * (validated names, sample ids already the engine's).
 */
export function trackCommands(tj: TrackJson): EngineCommand[] {
  const out: EngineCommand[] = [];
  const slot = tj.slot;
  if (tj.kind === 'drum') {
    out.push([Op.ADD_DRUM_TRACK, slot]);
    // Step edits act on the engine's current pattern: select each in turn.
    for (const pj of tj.patterns) {
      out.push([Op.SET_CURRENT_PATTERN, slot, pj.engineIdx], [Op.SET_STEP_COUNT, slot, pj.stepCount], [Op.SET_SWING, slot, pj.swing]);
      for (const [r, s, vel] of pj.hits) out.push([Op.SET_STEP, slot, r, s, vel]);
    }
    out.push([Op.SET_CURRENT_PATTERN, slot, tj.currentPattern]);
    tj.rows.forEach((r, i) => {
      if (r.sample !== null) out.push([Op.SET_ROW_SAMPLE, slot, i, r.sample]);
      if (r.gain !== 1) out.push([Op.SET_ROW_GAIN, slot, i, r.gain]);
      if (r.pan !== 0) out.push([Op.SET_ROW_PAN, slot, i, r.pan]);
      if (r.mute) out.push([Op.SET_ROW_MUTE, slot, i, 1]);
    });
  } else {
    out.push([Op.ADD_SYNTH_TRACK, slot]);
    for (const pj of tj.patterns) {
      out.push([Op.SET_CURRENT_PATTERN, slot, pj.engineIdx], [Op.SET_PATTERN_BARS, slot, pj.bars]);
      for (const n of pj.notes) out.push(noteCommand(slot, n));
    }
    out.push([Op.SET_CURRENT_PATTERN, slot, tj.currentPattern]);
    out.push(...patchRack(slot, tj.patch).commands);
  }
  for (const c of tj.clips) out.push(clipCommand(slot, c));
  return out;
}

/** NOTE_SET for note `n` of the slot's current engine pattern (same encoding as sendNote). */
export const noteCommand = (slot: number, n: { idx: number; pitch: number; vel: number; start: number; len: number }): EngineCommand =>
  [Op.NOTE_SET, slot * MAX_NOTES + n.idx, n.pitch * 128 + n.vel, n.start, n.len];

/** CLIP_SET for a clip of pattern engineIdx `c.pattern` (same encoding as sendClip). */
export const clipCommand = (slot: number, c: { idx: number; pattern: number; start: number; len: number; offset: number }): EngineCommand =>
  [Op.CLIP_SET, slot * MAX_CLIPS + c.idx, c.offset * 16 + c.pattern, c.start, c.len];

/** MIX_SET per non-default param (strips, then returns, then master), then every key. */
function mixerCommands(project: ProjectJson): EngineCommand[] {
  const out: EngineCommand[] = [];
  const params = (index: number, ps: MixParamsJson) => {
    for (const [name, value] of Object.entries(ps)) {
      const def = mixParam(name);
      if (value !== def.default) out.push([Op.MIX_SET, index, def.id, value]);
    }
  };
  for (const s of project.mixer.tracks) params(s.slot, s.params);
  params(MIX_REVERB, project.mixer.reverb);
  params(MIX_DELAY, project.mixer.delay);
  params(MIX_MASTER, project.mixer.master);
  for (const s of project.mixer.tracks) {
    if (s.key) out.push([Op.MIX_SET_KEY, s.slot, keyCode(s.key.row === null ? { slot: s.key.track } : { slot: s.key.track, row: s.key.row })]);
  }
  return out;
}

/** The slot that receives live keys (liveInputTrack of the loaded selection), or -1. */
export function inputSlot(project: ProjectJson): number {
  const bySlot = (s: number | null) => (s === null ? undefined : project.tracks.find((t) => t.slot === s));
  const sel = project.selection.track !== null ? bySlot(project.selection.track) : project.tracks[0];
  const synth = project.selection.synth !== null ? bySlot(project.selection.synth) : project.tracks.find((t) => t.kind === 'synth');
  const input = sel?.kind === 'synth' ? sel : synth;
  return input?.kind === 'synth' ? input.slot : -1;
}

/** Sample ids remapped; pooled effects / row keys beyond what the engine holds dropped (warned). */
function normalize(json: ProjectJson, ids: Map<number, number>, warnings: string[]): ProjectJson {
  const sampleId = (old: number | null) => (old === null || old < 0 ? null : (ids.get(old) ?? null));
  const pooled = new Map<string, number>(); // pooled module id -> used by earlier tracks
  const tracks: TrackJson[] = json.tracks.map((tj) => {
    if (tj.kind === 'drum') return { ...tj, rows: tj.rows.map((r) => ({ ...r, sample: sampleId(r.sample) })) };
    // SamplePlayer `sample` params follow the engine ids (a sample that did
    // not load: none; its own warning says why).
    const remapped = {
      ...tj.patch,
      modules: tj.patch.modules.map((m) =>
        m.id === 'sample_player' && m.params?.sample !== undefined
          ? { ...m, params: { ...m.params, sample: sampleId(m.params.sample) ?? -1 } }
          : m,
      ),
    };
    const fxFree = (id: string) => (fxPoolSlots(moduleDef(id)) ?? Infinity) - (pooled.get(id) ?? 0);
    const v = validatePatch(remapped, { fxFree });
    for (const w of v.warnings) warnings.push(`Track "${tj.name}": ${w}`);
    for (const m of v.patch.modules) if (fxPoolSlots(moduleDef(m.id)) !== null) pooled.set(m.id, (pooled.get(m.id) ?? 0) + 1);
    return { ...tj, patch: v.patch };
  });

  // Keys: at most MAX_KEYS distinct drum rows (the engine refuses one more);
  // a key at the strip's own whole track is none.
  const rows = new Set<string>();
  const name = (slot: number) => tracks.find((t) => t.slot === slot)!.name;
  const strips = json.mixer.tracks.map((s) => {
    const k = s.key;
    if (!k || (k.row === null && k.track === s.slot)) return { ...s, key: null };
    if (k.row !== null) {
      const id = `${k.track}:${k.row}`;
      if (rows.size >= MAX_KEYS && !rows.has(id)) {
        warnings.push(`Mixer "${name(s.slot)}": sidechain key ${name(k.track)} row ${k.row + 1} could not be set (dropped)`);
        return { ...s, key: null };
      }
      rows.add(id);
    }
    return { ...s, key: { ...k } };
  });

  const samples = json.samples
    .filter((s) => ids.has(s.id))
    .map((s) => ({ ...s, id: ids.get(s.id)! }))
    .sort((a, b) => a.id - b.id);
  return { ...json, tracks, mixer: { ...json.mixer, tracks: strips }, samples };
}

/**
 * The UI state of one track of a normalized project (fresh ids; its mixer
 * strip is not included). The state trackCommands builds in the engine.
 */
export function trackState(tj: TrackJson): Track {
  const clipsOf = (patterns: { id: string; engineIdx: number }[]): Clip[] =>
    tj.clips.map((c) => ({
      id: crypto.randomUUID(), idx: c.idx, patternId: patterns.find((x) => x.engineIdx === c.pattern)!.id,
      start: c.start, len: c.len, offset: c.offset,
    }));
  if (tj.kind === 'drum') {
    const patterns = tj.patterns.map((pj) => {
      const pat = makeDrumPattern(pj.engineIdx, pj.name, pj.stepCount, pj.swing);
      for (const [r, s, vel] of pj.hits) pat.steps[r][s] = vel;
      return pat;
    });
    const t: DrumTrack = {
      kind: 'drum',
      id: crypto.randomUUID(),
      slot: tj.slot,
      name: tj.name,
      color: tj.color,
      rows: tj.rows.map((r) => ({ id: crypto.randomUUID(), name: r.name, sampleId: r.sample, gain: r.gain, pan: r.pan, mute: r.mute })),
      patterns,
      currentPatternId: patterns.find((x) => x.engineIdx === tj.currentPattern)!.id,
      clips: clipsOf(patterns),
    };
    return t;
  }
  const patterns = tj.patterns.map((pj) => ({
    ...makeNotePattern(pj.engineIdx, pj.name, pj.bars),
    notes: pj.notes.map((n) => ({ id: crypto.randomUUID(), ...n })),
  }));
  const rack = patchRack(tj.slot, tj.patch);
  const t: SynthTrack = {
    kind: 'synth',
    id: crypto.randomUUID(),
    slot: tj.slot,
    name: tj.name,
    color: tj.color,
    patchName: tj.patch.name,
    modules: rack.modules,
    cables: rack.cables,
    patterns,
    currentPatternId: patterns.find((x) => x.engineIdx === tj.currentPattern)!.id,
    clips: clipsOf(patterns),
  };
  return t;
}
