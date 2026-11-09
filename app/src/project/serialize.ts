// Project -> project.json (schema.ts). Pure: reads the project, changes
// nothing, same input -> same output. Plan 7's undo snapshots and autosave
// (Task 4) build on this, and App's "● unsaved" mark compares fingerprints.
import { MIX_RETURN0, MIX_MASTER } from '../audio/protocol';
import { MIX_PARAMS } from '../audio/mixerCatalog';
import type { MixTarget } from '../audio/mixerCatalog';
import { accepts } from '../state/mixer-actions';
import { trackPatch } from '../state/patches';
import { currentPattern, MAX_STEPS } from '../state/project.svelte';
import type { AudioTrack, AutomationLane, ChannelState, DrumTrack, PatternTrack, Project, SynthTrack } from '../state/project.svelte';
import { SCHEMA_VERSION } from './schema';
import type { AudioTrackJson, ClipJson, DrumTrackJson, LaneJson, MidiMapJson, MixParamsJson, PointJson, ProjectJson, SynthTrackJson, TrackJson } from './schema';
import { isMasterChannel, pointTuple } from '../state/automation';
import { libraryJson } from '../state/pattern-library';

/** Characters that are unsafe in a file name on some OS. */
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * "samples/<id>-<hash>-<name>" with the name made safe for any file system.
 * The content hash means a different file never reuses an existing name.
 */
export function sampleFilePath(id: number, name: string, hash: string): string {
  let safe = name.replace(UNSAFE, '_').trim().slice(0, 100);
  if (safe === '' || safe === '.' || safe === '..') safe = 'sample';
  return `samples/${id}-${hash}-${safe}`;
}

function mixParams(ch: ChannelState, kind: MixTarget, index: number): MixParamsJson {
  const out: MixParamsJson = {};
  for (const def of MIX_PARAMS) if (accepts(def, kind, index)) out[def.name] = ch.params[def.id];
  return out;
}

function clipsOf(t: PatternTrack): ClipJson[] {
  const out: ClipJson[] = [];
  for (const c of t.clips) {
    const ps: { id: string; engineIdx: number }[] = t.patterns;
    const pat = ps.find((x) => x.id === c.patternId);
    if (pat) out.push({ idx: c.idx, pattern: pat.engineIdx, start: c.start, len: c.len, offset: c.offset });
  }
  return out;
}

/** A lane as saved: points in engine idx order (dense, so point i is idx i). */
export function laneJson(l: AutomationLane): LaneJson {
  return {
    lane: l.lane,
    enabled: l.enabled,
    target: l.target.kind === 'mix' ? { mix: l.target.param } : { rack: [l.target.module, l.target.param] },
    points: [...l.points].sort((a, b) => a.idx - b.idx).map((x) => [...pointTuple(x)] as PointJson),
  };
}

/**
 * The project as saved. Samples: only those used by a drum row, a
 * SamplePlayer `sample` param or an audio clip AND whose original file the session has
 * (p.sampleFiles); a use of any other id is written as "none" (null / -1),
 * since a load could not restore it.
 */
export function serialize(p: Project): ProjectJson {
  const used = new Set<number>();
  const use = (id: number | null): number | null => {
    if (id === null || id < 0 || !p.sampleFiles.has(id)) return null;
    used.add(id);
    return id;
  };

  const drum = (t: DrumTrack): DrumTrackJson => ({
    kind: 'drum',
    slot: t.slot,
    name: t.name,
    color: t.color,
    rows: t.rows.map((r) => ({ name: r.name, sample: use(r.sampleId), gain: r.gain, pan: r.pan, mute: r.mute })),
    patterns: t.patterns.map((pat) => {
      const hits: [number, number, number][] = [];
      for (let r = 0; r < t.rows.length; r++) {
        for (let s = 0; s < MAX_STEPS; s++) if (pat.steps[r][s] > 0) hits.push([r, s, pat.steps[r][s]]);
      }
      return { engineIdx: pat.engineIdx, name: pat.name, stepCount: pat.stepCount, swing: pat.swing, hits };
    }),
    currentPattern: currentPattern(t).engineIdx,
    clips: clipsOf(t),
    automation: t.automation.map(laneJson),
  });

  const synth = (t: SynthTrack): SynthTrackJson => ({
    kind: 'synth',
    slot: t.slot,
    name: t.name,
    color: t.color,
    patch: trackPatch(t, (id) => use(id) ?? -1),
    patterns: t.patterns.map((pat) => ({
      engineIdx: pat.engineIdx,
      name: pat.name,
      bars: pat.bars,
      notes: pat.notes.map((n) => ({ idx: n.idx, pitch: n.pitch, vel: n.vel, start: n.start, len: n.len })),
    })),
    currentPattern: currentPattern(t).engineIdx,
    clips: clipsOf(t),
    automation: t.automation.map(laneJson),
  });

  const audio = (t: AudioTrack): AudioTrackJson => ({
    kind: 'audio',
    slot: t.slot,
    name: t.name,
    color: t.color,
    clips: t.clips.map((c) => ({
      idx: c.idx, sample: use(c.sampleId), start: c.start, len: c.len, offset: c.offset, loop: c.loop,
      gain: c.gain, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
    })),
    automation: t.automation.map(laneJson),
  });

  const tracks = p.tracks.map((t): TrackJson => (t.kind === 'drum' ? drum(t) : t.kind === 'synth' ? synth(t) : audio(t)));
  const slotOf = (id: string | null) => p.tracks.find((t) => t.id === id)?.slot ?? null;
  const mixer = {
    tracks: p.tracks.map((t) => {
      const ch = p.mixer.channels[t.id];
      const keySlot = ch?.key ? slotOf(ch.key.trackId) : null;
      return {
        slot: t.slot,
        params: ch ? mixParams(ch, 'track', t.slot) : {},
        key: ch?.key && keySlot !== null ? { track: keySlot, row: ch.key.row } : null,
      };
    }),
    reverb: mixParams(p.mixer.reverb, 'return', MIX_RETURN0),
    delay: mixParams(p.mixer.delay, 'return', (MIX_RETURN0 + 1)),
    master: mixParams(p.mixer.master, 'master', MIX_MASTER),
    automation: p.mixer.automation.map((x) => ({ channel: x.channel, ...laneJson(x.lane) })),
  };
  const samples = [...used].sort((a, b) => a - b).map((id) => {
    const f = p.sampleFiles.get(id)!;
    return { id, name: f.name, type: f.type, file: sampleFilePath(id, f.name, f.hash) };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    name: p.name,
    tempo: p.tempo,
    metronome: p.metronome,
    mode: p.mode,
    loop: { on: p.loop.on, start: p.loop.start, end: p.loop.end },
    tracks,
    mixer,
    samples,
    selection: { track: slotOf(p.selectedTrackId), synth: slotOf(p.lastSynthTrackId) },
    midiMap: p.midiMap.flatMap((m): MidiMapJson[] => {
      const t = m.target;
      if (isMasterChannel(m.owner)) return t.kind === 'mix' ? [{ cc: m.cc, channel: m.owner, target: { mix: t.param } }] : [];
      const slot = slotOf(m.owner);
      if (slot === null) return []; // cannot happen: a track's removal drops its mappings
      return [{ cc: m.cc, track: slot, target: t.kind === 'mix' ? { mix: t.param } : { rack: [t.module, t.param] } }];
    }),
    patternLibrary: p.patternLibrary.map(libraryJson),
    key: { root: p.key.root, scale: p.key.scale },
  };
}

/**
 * What "unsaved changes" compares: the serialized project minus the track
 * selection (selecting a track is not an edit).
 */
export function projectFingerprint(p: Project): string {
  return fingerprintOf(serialize(p));
}

/** projectFingerprint of an already serialized project (no second serialize). */
export function fingerprintOf(json: ProjectJson): string {
  // Neither the selection nor the mode (which transport ran last) counts as
  // a change: both are saved, but switching them never makes the project
  // "unsaved" (plan 20 ruling: Play / Stop leave a saved project clean).
  return JSON.stringify({ ...json, selection: null, mode: null });
}

/** The sample files a save writes: project path -> original bytes. */
export function projectFiles(p: Project, json: ProjectJson): Map<string, ArrayBuffer> {
  const files = new Map<string, ArrayBuffer>();
  for (const s of json.samples) {
    const f = p.sampleFiles.get(s.id);
    if (f) files.set(s.file, f.bytes);
  }
  return files;
}

// ---- Snapshot sharing (undo history; docs/architecture/history.md "Cost") ----
//
// Equality here is JSON equality (what fingerprintOf compares) up to key
// order: serialize always writes keys in one order, and its values are plain
// JSON (no undefined), so the two agree. Primitives compare with ===, plus
// NaN equals NaN (JSON writes both as null).

type Json = unknown;
type Obj = Record<string, Json>;

const isObj = (v: Json): v is Obj => v !== null && typeof v === 'object';
const samePrim = (a: Json, b: Json) => a === b || (a !== a && b !== b);
/** Arrays matched by `slot` (tracks, mixer strips): a removed track does not shift the rest. */
const slotted = (a: Json[]) => a.length > 0 && a.every((x) => isObj(x) && typeof x.slot === 'number');

/** JSON equality, with a fast path for shared (identical) subtrees. */
export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (!isObj(a) || !isObj(b)) return samePrim(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !jsonEqual(a[k], b[k])) return false;
  return true;
}

/** fingerprintOf(a) === fingerprintOf(b), without building the strings: equal but for the selection and the mode. */
export function sameProject(a: ProjectJson, b: ProjectJson): boolean {
  return equalExcept(a, b, ['selection', 'mode']);
}

/**
 * What the undo history compares (history/history.ts): equal but for the
 * selection and the mode. Both are saved but not undone: selecting is not
 * an edit, and the mode is which transport ran last (plan 20: a transport
 * switch is not an undo entry; state/song-actions.ts setMode).
 */
export function sameUndoState(a: ProjectJson, b: ProjectJson): boolean {
  return equalExcept(a, b, ['selection', 'mode']);
}

function equalExcept(a: ProjectJson, b: ProjectJson, skip: (keyof ProjectJson)[]): boolean {
  if (a === b) return true;
  for (const k of Object.keys(a) as (keyof ProjectJson)[]) {
    if (!skip.includes(k) && !jsonEqual(a[k], b[k])) return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
}

function share(prev: Json, next: Json, freeze: boolean): Json {
  if (!isObj(next)) return samePrim(prev, next) ? prev : next;
  if (prev === next) return prev;
  const arr = Array.isArray(next);
  const p = isObj(prev) && Array.isArray(prev) === arr ? prev : null;
  let same = p !== null;
  if (arr) {
    const n = next as Json[];
    const pa = p as Json[] | null;
    if (pa && pa.length !== n.length) same = false;
    // Tracks and strips by slot (an element only ever shares with its own track's old one).
    const bySlot = pa && slotted(n) && slotted(pa) ? new Map(pa.map((x) => [(x as Obj).slot, x])) : null;
    for (let i = 0; i < n.length; i++) {
      n[i] = share(bySlot ? bySlot.get((n[i] as Obj).slot) : pa?.[i], n[i], freeze);
      if (!pa || n[i] !== pa[i]) same = false;
    }
  } else {
    const keys = Object.keys(next);
    if (p && Object.keys(p).length !== keys.length) same = false;
    for (const k of keys) {
      next[k] = share(p?.[k], next[k], freeze);
      if (!p || !Object.hasOwn(p, k) || next[k] !== p[k]) same = false;
    }
  }
  if (same) return prev;
  if (freeze) Object.freeze(next);
  return next;
}

/**
 * Structural sharing between consecutive undo snapshots: `next` with every
 * subtree that equals (jsonEqual) its counterpart in `prev` replaced by
 * prev's object, so an edit of one track costs that track's nodes, not the
 * project's. Tracks and mixer strips match by slot, everything else by index
 * or key. Returns `prev` itself when nothing changed.
 *
 * `next` must be fresh (serialize's output): sharing nothing with the live
 * project, and a tree, with no node reachable twice (an aliased node would
 * be visited and rewritten twice, and could be frozen by one path while the
 * other still writes into it). It is completed in place. Snapshots are immutable from here on;
 * with `freeze` (dev/test) every node it creates is frozen, so an accidental
 * write to a shared subtree throws instead of silently corrupting undo.
 */
export function shareSnapshot(prev: ProjectJson | null, next: ProjectJson, freeze: boolean): ProjectJson {
  return share(prev, next, freeze) as ProjectJson;
}
