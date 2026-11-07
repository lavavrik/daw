// project.json: the saved form of a Project (schemaVersion 3) and its
// validator. See docs/architecture/projects.md. An older file is migrated
// first (migrate.ts: v1 -> v2 adds Audio tracks, which v1 never had; v2 -> v3
// adds automation lanes, which v2 never had).
//
// Design rules:
//   - Everything the engine needs is by catalog NAME (rack module ids, rack
//     and mixer params, port names), never by catalog index, so catalog
//     growth never shifts values.
//   - Engine slots ARE stored (track `slot`, pattern `engineIdx`, clip and
//     note `idx`, automation `lane`; a lane's points are listed in engine
//     idx order, which is dense: point i is idx i) and references use them (clip `pattern`, `currentPattern`,
//     sidechain `key.track`), so a restore (load, plan-7 undo) puts every
//     object back in the same engine slot.
//   - UUIDs are not stored; a load makes fresh ones.
//   - Audio clips store their sample by session id like rows do; a clip
//     whose sample is missing is kept with `sample: null` ("missing
//     sample", silent), with a warning, so its place in the song survives.
//   - `validate` never throws and never lets an out-of-range value through:
//     unknown fields are ignored, a value of the wrong type falls back to its
//     default, an out-of-range one is clamped, and an object that cannot be
//     placed (bad slot, unknown kind, dangling reference) is dropped. Each of
//     these adds a warning (a missing optional field silently gets its
//     default). Only a missing/newer schemaVersion is an error.
import { MAX_AUTO_LANES, MAX_AUTO_POINTS, MAX_CLIPS, MAX_NOTES, MAX_PATTERN_BARS, MAX_PATTERNS, MAX_SONG_TICKS, MIX_DELAY, MIX_MASTER, MIX_REVERB, BAR_TICKS } from '../audio/protocol';
import { moduleDef } from '../audio/catalog';
import type { ParamDef } from '../audio/catalog';
import type { MixParamDef } from '../audio/mixerCatalog';
import { clampParam } from '../audio/catalog';
import { MIX_PARAMS } from '../audio/mixerCatalog';
import type { MixTarget } from '../audio/mixerCatalog';
import { accepts } from '../state/mixer-actions';
import { validatePatch } from '../state/patches';
import type { Patch } from '../state/patches';
import { DEFAULT_LOOP_END, DEFAULT_PATTERN_BARS, MAX_ROWS, MAX_SAMPLES, MAX_STEPS, MAX_TRACKS, TRACK_COLORS } from '../state/project.svelte';
import { CLIP_GAIN_MAX_DB, CLIP_GAIN_MIN_DB, MAX_SAVED_OFFSET } from '../state/audio-actions';
import { migrate } from './migrate';

/** Plan 9: 2 (Audio tracks); plan 10: 3 (automation). Older files are migrated (migrate.ts). */
export const SCHEMA_VERSION = 3;
/** Largest clip offset / note start (16 bars - 1 tick) and longest note. */
const MAX_OFFSET = MAX_PATTERN_BARS * BAR_TICKS - 1;
const MAX_NOTE_LEN = MAX_PATTERN_BARS * BAR_TICKS;

export interface ProjectJson {
  schemaVersion: typeof SCHEMA_VERSION;
  name: string;
  /** BPM 20..300 (0.1 steps). */
  tempo: number;
  metronome: boolean;
  mode: 'pattern' | 'song';
  /** Song-mode loop range in ticks (0 <= start < end <= MAX_SONG_TICKS). */
  loop: { on: boolean; start: number; end: number };
  /** In track-list order. */
  tracks: TrackJson[];
  mixer: MixerJson;
  /** Every sample the project uses (drum rows, SamplePlayer modules and audio clips). */
  samples: SampleJson[];
  /** Selected track and last-selected synth (the Keys → target), by slot. */
  selection: { track: number | null; synth: number | null };
}

interface TrackCommon {
  /** Engine track slot 0..31, unique. */
  slot: number;
  name: string;
  /** "#rrggbb". */
  color: string;
  /** engineIdx of the current pattern. */
  currentPattern: number;
  clips: ClipJson[];
  /** The track's lanes (its mixer strip; synth tracks: also its rack). */
  automation: LaneJson[];
}

/**
 * An automation lane. `target` by catalog name: a param of the owner's mixer
 * channel ({mix}), or of module `moduleIdx` of the owner's rack ({rack}:
 * synth tracks only). Non-integer params only.
 */
export interface LaneJson {
  /** Engine lane 0..MAX_AUTO_LANES-1, unique in the project. */
  lane: number;
  enabled: boolean;
  target: { mix: string } | { rack: [moduleIdx: number, name: string] };
  /** [tick, value, 0 linear | 1 hold], listed in engine idx order (point i is idx i); unique ticks. */
  points: [number, number, 0 | 1][];
}

/** A Master row lane: a lane of the Reverb, Delay or master channel. */
export type MasterLaneJson = { channel: 'reverb' | 'delay' | 'master' } & LaneJson;

export interface DrumTrackJson extends TrackCommon {
  kind: 'drum';
  /** Index = engine row (0..MAX_ROWS-1). */
  rows: RowJson[];
  patterns: DrumPatternJson[];
}

export interface RowJson {
  name: string;
  /** Session sample id (an entry of `samples`), or null. */
  sample: number | null;
  gain: number;
  pan: number;
  mute: boolean;
}

export interface DrumPatternJson {
  engineIdx: number;
  name: string;
  stepCount: 16 | 32 | 64;
  swing: number;
  /** Non-zero steps as [row, step 0..63, velocity 1..127]. */
  hits: [number, number, number][];
}

export interface SynthTrackJson extends TrackCommon {
  kind: 'synth';
  /** The rack, by name (state/patches.ts Patch; validated by validatePatch). */
  patch: Patch;
  patterns: NotePatternJson[];
}

export interface NotePatternJson {
  engineIdx: number;
  name: string;
  bars: number;
  notes: NoteJson[];
}

export interface NoteJson {
  idx: number;
  pitch: number;
  vel: number;
  start: number;
  len: number;
}

export interface ClipJson {
  idx: number;
  /** engineIdx of a pattern of the same track. */
  pattern: number;
  start: number;
  len: number;
  offset: number;
}

/** An Audio track (plan 9): no patterns, rows or rack; just its clips. */
export interface AudioTrackJson {
  kind: 'audio';
  slot: number;
  name: string;
  color: string;
  clips: AudioClipJson[];
  /** Mixer-strip lanes only. */
  automation: LaneJson[];
}

export interface AudioClipJson {
  /** Engine clip slot 0..MAX_CLIPS-1, unique within the track. */
  idx: number;
  /** Session sample id (an entry of `samples`), or null: a missing sample (silent). */
  sample: number | null;
  /** Song ticks; start + len <= MAX_SONG_TICKS. */
  start: number;
  len: number;
  /** Seconds into the file (sample-rate independent). */
  offset: number;
  loop: boolean;
  /** dB, -60 (= -inf) .. +12. */
  gain: number;
  /** Ticks; fadeIn + fadeOut <= len. */
  fadeIn: number;
  fadeOut: number;
}

export type TrackJson = DrumTrackJson | SynthTrackJson | AudioTrackJson;
/** The kinds that play patterns. */
export type PatternTrackJson = DrumTrackJson | SynthTrackJson;

/** Mixer params by catalog name (MIX_PARAMS[].name). */
export type MixParamsJson = Record<string, number>;

export interface MixerJson {
  tracks: { slot: number; params: MixParamsJson; key: KeyJson | null }[];
  reverb: MixParamsJson;
  delay: MixParamsJson;
  master: MixParamsJson;
  /** The Master row's lanes. */
  automation: MasterLaneJson[];
}

/** Sidechain source: a whole track (row null) or one drum row. */
export interface KeyJson {
  track: number;
  row: number | null;
}

export interface SampleJson {
  /** Session sample id (reassigned compactly 0..n-1 on load). */
  id: number;
  /** Original file name ("kick.wav"). */
  name: string;
  type: string;
  /** Path in the project folder: "samples/<id>-<name>". */
  file: string;
}

export type Validated = { project: ProjectJson; warnings: string[] } | { error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const COLOR = /^#[0-9a-fA-F]{6}$/;
/** "samples/<one file name>": no sub-folders, no "." / "..". */
const SAMPLE_PATH = /^samples\/(?!\.\.?$)[^/\\]+$/;

/** Collects warnings; each reader returns a valid value. */
class Reader {
  readonly warnings: string[] = [];
  warn(m: string) {
    this.warnings.push(m);
  }
  /** A number in [lo, hi] (integer: rounded). Missing: `def`, silently. */
  num(v: unknown, def: number, lo: number, hi: number, what: string, integer = false): number {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.warn(`${what}: not a number (using ${def})`);
      return def;
    }
    const c = clampParam({ min: lo, max: hi, default: def, integer }, v);
    if (c !== v) this.warn(`${what} ${v} clamped to ${c}`);
    return c;
  }
  bool(v: unknown, def: boolean, what: string): boolean {
    if (v === undefined) return def;
    if (typeof v !== 'boolean') {
      this.warn(`${what}: not true/false (using ${def})`);
      return def;
    }
    return v;
  }
  str(v: unknown, def: string, what: string): string {
    if (v === undefined) return def;
    if (typeof v !== 'string') {
      this.warn(`${what}: not text (using "${def}")`);
      return def;
    }
    return v;
  }
  /** An index 0..n-1 not in `taken`; null (and a warning) if it can't be used. */
  index(v: unknown, n: number, taken: Set<number>, what: string): number | null {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= n) {
      this.warn(`Dropped ${what}: ${String(v)} is not in 0..${n - 1}`);
      return null;
    }
    if (taken.has(v)) {
      this.warn(`Dropped ${what}: ${v} is already taken`);
      return null;
    }
    taken.add(v);
    return v;
  }
}

/** Check (and clamp/drop) everything in a parsed project.json (migrated first). Pure; never throws. */
export function validate(input: unknown): Validated {
  const json = migrate(input);
  if (!isObj(json)) return { error: 'Not a project file (expected a JSON object)' };
  const ver = json.schemaVersion;
  if (typeof ver !== 'number' || !Number.isInteger(ver) || ver < 1) {
    return { error: 'Not a project file (no schemaVersion)' };
  }
  if (ver > SCHEMA_VERSION) {
    return { error: `This project was saved by a newer version of the app (schema ${ver}; this one reads up to ${SCHEMA_VERSION})` };
  }
  const r = new Reader();

  const name = r.str(json.name, 'Untitled', 'Project name');
  const tempo = Math.round(r.num(json.tempo, 124, 20, 300, 'Tempo') * 10) / 10;
  const metronome = r.bool(json.metronome, false, 'Metronome');
  let mode: 'pattern' | 'song' = 'pattern';
  if (json.mode === 'song' || json.mode === 'pattern') mode = json.mode;
  else if (json.mode !== undefined) r.warn(`Mode "${String(json.mode)}" is unknown (using Pattern)`);
  const loop = readLoop(r, json.loop);

  const samples: SampleJson[] = [];
  const sampleIds = new Set<number>();
  for (const s of arr(json.samples)) {
    if (!isObj(s)) {
      r.warn('Dropped a malformed sample entry');
      continue;
    }
    const sname = r.str(s.name, typeof s.file === 'string' ? s.file : 'sample', 'Sample name');
    if (typeof s.file !== 'string' || !SAMPLE_PATH.test(s.file)) {
      r.warn(`Dropped sample "${sname}": bad file path "${String(s.file)}"`);
      continue;
    }
    const id = r.index(s.id, MAX_SAMPLES, sampleIds, `sample "${sname}" id`);
    if (id === null) continue;
    samples.push({ id, name: sname, type: r.str(s.type, '', `Sample "${sname}" type`), file: s.file });
  }

  const tracks: TrackJson[] = [];
  const slots = new Set<number>();
  const lanes: Lanes = { taken: new Set(), count: 0 };
  for (const t of arr(json.tracks)) {
    if (!isObj(t)) {
      r.warn('Dropped a malformed track');
      continue;
    }
    const kind = t.kind;
    const tname = r.str(t.name, kind === 'synth' ? 'Synth' : kind === 'audio' ? 'Audio' : 'Drums', 'Track name');
    if (kind !== 'drum' && kind !== 'synth' && kind !== 'audio') {
      r.warn(`Dropped track "${tname}": unknown kind "${String(kind)}"`);
      continue;
    }
    const slot = r.index(t.slot, MAX_TRACKS, slots, `track "${tname}" slot`);
    if (slot === null) continue;
    let color = TRACK_COLORS[slot % TRACK_COLORS.length];
    if (typeof t.color === 'string' && COLOR.test(t.color)) color = t.color;
    else if (t.color !== undefined) r.warn(`Track "${tname}": bad colour "${String(t.color)}"`);
    const at = `Track "${tname}"`;
    const common = { slot, name: tname, color };
    const auto = (rack: Patch | null) => readLanes(r, t.automation, lanes, at, (target) => laneDef(target, 'track', slot, rack));
    if (kind === 'audio') {
      tracks.push({ kind, ...common, clips: readAudioClips(r, t.clips, sampleIds, at), automation: auto(null) });
    } else if (kind === 'drum') {
      const rows = readRows(r, t.rows, sampleIds, at);
      const patterns = readPatterns(r, t.patterns, at, (p, w) => readDrumPattern(r, p, rows.length, w));
      tracks.push({ kind, ...common, rows, patterns, ...readCurrentAndClips(r, t, patterns, at), automation: auto(null) });
    } else {
      const v = validatePatch(t.patch ?? { name: '', modules: [], cables: [] });
      for (const w of v.warnings) r.warn(`${at}: ${w}`);
      for (const m of v.patch.modules) {
        const s = m.params?.sample;
        if (m.id === 'sample_player' && s !== undefined && s >= 0 && !sampleIds.has(s)) {
          r.warn(`${at}: Sample Player ${m.idx} uses sample ${s}, which is not in the project (cleared)`);
          m.params!.sample = -1;
        }
      }
      const patterns = readPatterns(r, t.patterns, at, (p, w) => readNotePattern(r, p, w));
      tracks.push({ kind, ...common, patch: v.patch, patterns, ...readCurrentAndClips(r, t, patterns, at), automation: auto(v.patch) });
    }
  }

  const mixer = readMixer(r, json.mixer, tracks, lanes);
  const sel = isObj(json.selection) ? json.selection : {};
  const slotOf = (v: unknown, synthOnly: boolean) =>
    tracks.find((t) => t.slot === v && (!synthOnly || t.kind === 'synth'))?.slot ?? null;
  const selection = { track: slotOf(sel.track, false), synth: slotOf(sel.synth, true) };

  return {
    project: { schemaVersion: SCHEMA_VERSION, name, tempo, metronome, mode, loop, tracks, mixer, samples, selection },
    warnings: r.warnings,
  };
}

function readLoop(r: Reader, v: unknown): ProjectJson['loop'] {
  const def = { on: false, start: 0, end: DEFAULT_LOOP_END };
  if (v === undefined) return def;
  const o = isObj(v) ? v : {};
  const int = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_SONG_TICKS;
  if (!int(o.start) || !int(o.end) || (o.start as number) >= (o.end as number)) {
    r.warn('Loop range is invalid (reset to bars 1-4, off)');
    return def;
  }
  return { on: r.bool(o.on, false, 'Loop on'), start: o.start as number, end: o.end as number };
}

function readRows(r: Reader, v: unknown, sampleIds: Set<number>, at: string): RowJson[] {
  const blank = (i: number): RowJson => ({ name: `Row ${i + 1}`, sample: null, gain: 1, pan: 0, mute: false });
  if (v === undefined) return [0, 1, 2, 3].map(blank);
  const raw = arr(v);
  if (raw.length > MAX_ROWS) r.warn(`${at}: only the first ${MAX_ROWS} rows were kept`);
  // A malformed row becomes an empty one: rows are positional (hits, keys).
  return raw.slice(0, MAX_ROWS).map((x, i) => {
    if (!isObj(x)) {
      r.warn(`${at} row ${i + 1}: malformed (emptied)`);
      return blank(i);
    }
    const w = `${at} row ${i + 1}`;
    let sample: number | null = null;
    if (typeof x.sample === 'number' && sampleIds.has(x.sample)) sample = x.sample;
    else if (x.sample !== null && x.sample !== undefined) {
      r.warn(`${w}: sample ${String(x.sample)} is not in the project (cleared)`);
    }
    return {
      name: r.str(x.name, `Row ${i + 1}`, `${w} name`),
      sample,
      gain: r.num(x.gain, 1, 0, 2, `${w} gain`),
      pan: r.num(x.pan, 0, -1, 1, `${w} pan`),
      mute: r.bool(x.mute, false, `${w} mute`),
    };
  });
}

/** Patterns with unique engineIdx; never empty (a default one is made if needed). */
function readPatterns<P extends { engineIdx: number }>(
  r: Reader, v: unknown, at: string, read: (p: Record<string, unknown>, what: string) => Omit<P, 'engineIdx'>,
): P[] {
  const out: P[] = [];
  const taken = new Set<number>();
  for (const x of arr(v)) {
    if (!isObj(x)) {
      r.warn(`${at}: dropped a malformed pattern`);
      continue;
    }
    const pname = typeof x.name === 'string' ? x.name : `Pattern ${out.length + 1}`;
    const engineIdx = r.index(x.engineIdx, MAX_PATTERNS, taken, `${at} pattern "${pname}" engine slot`);
    if (engineIdx === null) continue;
    out.push({ engineIdx, ...read(x, `${at} pattern "${pname}"`) } as P);
  }
  if (out.length === 0) {
    if (v !== undefined) r.warn(`${at}: no usable pattern (added an empty one)`);
    out.push({ engineIdx: 0, ...read({}, `${at} pattern`) } as P);
  }
  return out;
}

function readDrumPattern(r: Reader, x: Record<string, unknown>, rows: number, w: string): Omit<DrumPatternJson, 'engineIdx'> {
  let stepCount: 16 | 32 | 64 = 16;
  if (x.stepCount === 16 || x.stepCount === 32 || x.stepCount === 64) stepCount = x.stepCount;
  else if (x.stepCount !== undefined) r.warn(`${w}: step count ${String(x.stepCount)} is not 16/32/64 (using 16)`);
  const hits: [number, number, number][] = [];
  const seen = new Set<number>();
  for (const h of arr(x.hits)) {
    const ok = Array.isArray(h) && h.length === 3 && h.every((n) => typeof n === 'number' && Number.isInteger(n));
    if (!ok || h[0] < 0 || h[0] >= rows || h[1] < 0 || h[1] >= MAX_STEPS) {
      r.warn(`${w}: dropped a step hit out of range (${JSON.stringify(h)})`);
      continue;
    }
    if (h[2] <= 0) continue; // velocity 0 = off
    const vel = r.num(h[2], 100, 1, 127, `${w} row ${h[0] + 1} step ${h[1] + 1} velocity`, true);
    const key = h[0] * MAX_STEPS + h[1];
    if (seen.has(key)) {
      r.warn(`${w}: row ${h[0] + 1} step ${h[1] + 1} appears twice (first kept)`);
      continue;
    }
    seen.add(key);
    hits.push([h[0], h[1], vel]);
  }
  return {
    name: r.str(x.name, 'Pattern 1', `${w} name`),
    stepCount,
    swing: r.num(x.swing, 0, 0, 1, `${w} swing`),
    hits,
  };
}

function readNotePattern(r: Reader, x: Record<string, unknown>, w: string): Omit<NotePatternJson, 'engineIdx'> {
  const notes: NoteJson[] = [];
  const taken = new Set<number>();
  for (const n of arr(x.notes)) {
    if (!isObj(n)) {
      r.warn(`${w}: dropped a malformed note`);
      continue;
    }
    const idx = r.index(n.idx, MAX_NOTES, taken, `${w} note slot`);
    if (idx === null) continue;
    notes.push({
      idx,
      pitch: r.num(n.pitch, 60, 0, 127, `${w} note pitch`, true),
      vel: r.num(n.vel, 100, 1, 127, `${w} note velocity`, true),
      start: r.num(n.start, 0, 0, MAX_OFFSET, `${w} note start`, true),
      len: r.num(n.len, 240, 1, MAX_NOTE_LEN, `${w} note length`, true),
    });
  }
  return {
    name: r.str(x.name, 'Pattern 1', `${w} name`),
    bars: r.num(x.bars, DEFAULT_PATTERN_BARS, 1, MAX_PATTERN_BARS, `${w} bars`, true),
    notes,
  };
}

function readAudioClips(r: Reader, v: unknown, sampleIds: Set<number>, at: string): AudioClipJson[] {
  const clips: AudioClipJson[] = [];
  const taken = new Set<number>();
  for (const c of arr(v)) {
    if (!isObj(c)) {
      r.warn(`${at}: dropped a malformed audio clip`);
      continue;
    }
    const idx = r.index(c.idx, MAX_CLIPS, taken, `${at} clip slot`);
    if (idx === null) continue;
    let sample: number | null = null;
    if (typeof c.sample === 'number' && sampleIds.has(c.sample)) sample = c.sample;
    else if (c.sample !== null && c.sample !== undefined) {
      r.warn(`${at}: clip sample ${String(c.sample)} is not in the project (missing sample)`);
    }
    const start = r.num(c.start, 0, 0, MAX_SONG_TICKS - 1, `${at} clip start`, true);
    const len = r.num(c.len, BAR_TICKS, 1, MAX_SONG_TICKS - start, `${at} clip length`, true);
    let fadeIn = r.num(c.fadeIn, 0, 0, len, `${at} clip fade-in`, true);
    const fadeOut = r.num(c.fadeOut, 0, 0, len, `${at} clip fade-out`, true);
    if (fadeIn + fadeOut > len) {
      r.warn(`${at}: clip fades are longer than the clip (fade-in shortened)`);
      fadeIn = len - fadeOut;
    }
    clips.push({
      idx,
      sample,
      start,
      len,
      offset: r.num(c.offset, 0, 0, MAX_SAVED_OFFSET, `${at} clip offset`),
      loop: r.bool(c.loop, false, `${at} clip loop`),
      // null is what JSON.stringify makes of -Infinity: -inf, the minimum.
      gain: c.gain === null ? CLIP_GAIN_MIN_DB : r.num(c.gain, 0, CLIP_GAIN_MIN_DB, CLIP_GAIN_MAX_DB, `${at} clip gain`),
      fadeIn,
      fadeOut,
    });
  }
  return clips;
}

function readCurrentAndClips(
  r: Reader, t: Record<string, unknown>, patterns: { engineIdx: number }[], at: string,
): { currentPattern: number; clips: ClipJson[] } {
  const has = (v: unknown) => patterns.some((p) => p.engineIdx === v);
  let currentPattern = patterns[0].engineIdx;
  if (has(t.currentPattern)) currentPattern = t.currentPattern as number;
  else if (t.currentPattern !== undefined) r.warn(`${at}: current pattern ${String(t.currentPattern)} does not exist`);
  const clips: ClipJson[] = [];
  const taken = new Set<number>();
  for (const c of arr(t.clips)) {
    if (!isObj(c)) {
      r.warn(`${at}: dropped a malformed clip`);
      continue;
    }
    if (!has(c.pattern)) {
      r.warn(`${at}: dropped a clip of pattern ${String(c.pattern)}, which does not exist`);
      continue;
    }
    const idx = r.index(c.idx, MAX_CLIPS, taken, `${at} clip slot`);
    if (idx === null) continue;
    const start = r.num(c.start, 0, 0, MAX_SONG_TICKS - 1, `${at} clip start`, true);
    clips.push({
      idx,
      pattern: c.pattern as number,
      start,
      len: r.num(c.len, BAR_TICKS, 1, MAX_SONG_TICKS - start, `${at} clip length`, true),
      offset: r.num(c.offset, 0, 0, MAX_OFFSET, `${at} clip offset`, true),
    });
  }
  return { currentPattern, clips };
}

/** Params of one mixer channel by name: unknown or not-for-this-channel ones are dropped. */
function readMixParams(r: Reader, v: unknown, kind: MixTarget, index: number, at: string): MixParamsJson {
  const out: MixParamsJson = {};
  if (v === undefined) return out;
  if (!isObj(v)) {
    r.warn(`${at}: malformed params (defaults used)`);
    return out;
  }
  for (const [name, x] of Object.entries(v)) {
    const def = MIX_PARAMS.find((d) => d.name === name);
    if (!def) r.warn(`${at}: unknown param "${name}" (ignored)`);
    else if (!accepts(def, kind, index)) r.warn(`${at}: ${name} does not apply here (ignored)`);
    else out[name] = r.num(x, def.default, def.min, def.max, `${at} ${name}`, def.integer);
  }
  return out;
}

function readMixer(r: Reader, v: unknown, tracks: TrackJson[], lanes: Lanes): MixerJson {
  const o = isObj(v) ? v : {};
  const strips: MixerJson['tracks'] = [];
  const seen = new Set<number>();
  for (const s of arr(o.tracks)) {
    const t = isObj(s) ? tracks.find((x) => x.slot === s.slot) : undefined;
    if (!isObj(s) || !t || seen.has(t.slot)) {
      r.warn(`Mixer: dropped the strip of track slot ${isObj(s) ? String(s.slot) : '?'} (no such track, or twice)`);
      continue;
    }
    seen.add(t.slot);
    const at = `Mixer "${t.name}"`;
    let key: KeyJson | null = null;
    if (isObj(s.key)) {
      const k = s.key;
      const src = tracks.find((x) => x.slot === k.track);
      const row = k.row;
      const rowOk = row === null || (src?.kind === 'drum' && typeof row === 'number' && Number.isInteger(row) && row >= 0 && row < src.rows.length);
      if (src && rowOk) key = { track: src.slot, row: row as number | null };
      else r.warn(`${at}: sidechain key ${JSON.stringify(s.key)} has no source (dropped)`);
    } else if (s.key !== null && s.key !== undefined) r.warn(`${at}: malformed sidechain key (dropped)`);
    strips.push({ slot: t.slot, params: readMixParams(r, s.params, 'track', t.slot, at), key });
  }
  return {
    tracks: strips,
    reverb: readMixParams(r, o.reverb, 'return', MIX_REVERB, 'Mixer Reverb'),
    delay: readMixParams(r, o.delay, 'return', MIX_DELAY, 'Mixer Delay'),
    master: readMixParams(r, o.master, 'master', MIX_MASTER, 'Mixer Master'),
    automation: readMasterLanes(r, o.automation, lanes),
  };
}

const MASTER_CHANNELS = { reverb: ['return', MIX_REVERB], delay: ['return', MIX_DELAY], master: ['master', MIX_MASTER] } as const;

/** The Master row's lanes: each names its channel; one of another channel is dropped. */
function readMasterLanes(r: Reader, v: unknown, lanes: Lanes): MasterLaneJson[] {
  const out: MasterLaneJson[] = [];
  const raw = arr(v);
  for (const x of raw) {
    const ch = isObj(x) ? x.channel : undefined;
    if (ch !== 'reverb' && ch !== 'delay' && ch !== 'master') {
      r.warn(`Master row: dropped an automation lane of channel "${String(ch)}" (no such channel)`);
      continue;
    }
    const [kind, index] = MASTER_CHANNELS[ch];
    // One lane at a time, so a duplicate target is caught against this channel's earlier lanes only.
    const mine = out.filter((l) => l.channel === ch);
    const got = readLanes(r, [x], lanes, `Master row ${ch}`, (t) => laneDef(t, kind, index, null), mine);
    for (const l of got) out.push({ channel: ch, ...l });
  }
  return out;
}

/** Engine lanes used so far, and how many lanes were kept (at most MAX_AUTO_LANES). */
interface Lanes {
  taken: Set<number>;
  count: number;
}

/**
 * The catalog def of a lane target on a mixer channel (`kind`, `index`) and,
 * for a synth track, its rack `patch` (validated); null when the engine
 * would refuse it: unknown, integer, not on this channel, a rack target off
 * a synth track, or a module the rack does not have. `why` says which.
 */
function laneDef(
  target: unknown, kind: MixTarget, index: number, patch: Patch | null,
): { def: MixParamDef | ParamDef } | { why: string } {
  if (!isObj(target)) return { why: 'no target' };
  if (typeof target.mix === 'string') {
    const name = target.mix;
    const def = MIX_PARAMS.find((d) => d.name === name);
    if (!def) return { why: `unknown param "${name}"` };
    if (def.integer) return { why: `${name} cannot be automated` };
    if (!accepts(def, kind, index)) return { why: `${name} does not apply here` };
    return { def };
  }
  const rack = target.rack;
  if (Array.isArray(rack) && rack.length === 2 && typeof rack[1] === 'string') {
    const [mod, name] = rack as [unknown, string];
    if (!patch) return { why: `${name}: only synth tracks have a rack` };
    const pm = patch.modules.find((m) => m.idx === mod);
    if (!pm) return { why: `${name}: no module ${String(mod)} in the rack` };
    const def = moduleDef(pm.id).params.find((d) => d.name === name);
    if (!def) return { why: `unknown param "${name}" of module ${String(mod)}` };
    if (def.integer) return { why: `${name} cannot be automated` };
    return { def };
  }
  return { why: 'no target' };
}

/**
 * A list of lanes of one owner. Dropped, with a warning: a malformed lane,
 * one whose target laneDef refuses or that already has a lane (`earlier`:
 * the owner's lanes kept before this list), one whose engine lane is out of
 * range or taken, and any beyond MAX_AUTO_LANES. Points: malformed ones and
 * a repeated tick are dropped, ticks and values clamped, at most
 * MAX_AUTO_POINTS kept; the kept ones stay in their order (their engine idx).
 */
function readLanes(
  r: Reader, v: unknown, lanes: Lanes, at: string,
  defOf: (target: unknown) => { def: MixParamDef | ParamDef } | { why: string }, earlier: LaneJson[] = [],
): LaneJson[] {
  const out: LaneJson[] = [];
  const key = (t: LaneJson['target']) => JSON.stringify(t);
  const seen = new Set([...earlier, ...out].map((l) => key(l.target)));
  for (const x of arr(v)) {
    if (!isObj(x)) {
      r.warn(`${at}: dropped a malformed automation lane`);
      continue;
    }
    const d = defOf(x.target);
    if ('why' in d) {
      r.warn(`${at}: dropped an automation lane (${d.why})`);
      continue;
    }
    const t = x.target as Record<string, unknown>;
    const target: LaneJson['target'] = typeof t.mix === 'string' ? { mix: t.mix } : { rack: [(t.rack as [number, string])[0], (t.rack as [number, string])[1]] };
    const name = 'mix' in target ? target.mix : target.rack[1];
    if (seen.has(key(target))) {
      r.warn(`${at}: dropped an automation lane of ${name} (that target already has a lane)`);
      continue;
    }
    if (lanes.count >= MAX_AUTO_LANES) {
      r.warn(`${at}: dropped the automation lane of ${name} (at most ${MAX_AUTO_LANES} lanes per project)`);
      continue;
    }
    const lane = r.index(x.lane, MAX_AUTO_LANES, lanes.taken, `${at} automation lane ${String(x.lane)} (${name}): engine lane`);
    if (lane === null) continue;
    seen.add(key(target));
    lanes.count++;
    const w = `${at} automation of ${name}`;
    const points: [number, number, 0 | 1][] = [];
    const ticks = new Set<number>();
    const raw = arr(x.points);
    for (const pt of raw) {
      if (!Array.isArray(pt) || pt.length !== 3 || !pt.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        r.warn(`${w}: dropped a malformed point (${JSON.stringify(pt)})`);
        continue;
      }
      if (points.length >= MAX_AUTO_POINTS) {
        r.warn(`${w}: only the first ${MAX_AUTO_POINTS} points were kept`);
        break;
      }
      const tick = r.num(pt[0], 0, 0, MAX_SONG_TICKS, `${w} point tick`, true);
      if (ticks.has(tick)) {
        r.warn(`${w}: a second point at tick ${tick} (dropped)`);
        continue;
      }
      ticks.add(tick);
      const value = r.num(pt[1], d.def.default, d.def.min, d.def.max, `${w} point value`);
      if (pt[2] !== 0 && pt[2] !== 1) r.warn(`${w}: point shape ${pt[2]} is not 0/1 (linear)`);
      points.push([tick, value, pt[2] === 1 ? 1 : 0]);
    }
    out.push({ lane, enabled: r.bool(x.enabled, true, `${w} enabled`), target, points });
  }
  return out;
}
