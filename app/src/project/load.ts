// project.json -> Project + engine. See docs/architecture/projects.md.
//
// Order (each step only starts when the previous one cannot fail the load
// half-way):
//   1. validate (pure): an error throws ProjectLoadError and changes nothing.
//   2. decode every sample (async, nothing touched yet), then make sure the
//      AudioContext runs (a suspended one would never ack the reset): if it
//      cannot be resumed the load fails here, before anything is blanked.
//   3. STOP, blank the UI state, RESET_ALL, and wait for the worklet's ack:
//      sample uploads go by postMessage and must not overtake the reset.
//   4. upload the samples with compact ids 0..n-1 (old -> new id map).
//   5. replay, synchronously: projectCommands (project/commands.ts, the one
//      replay-order builder shared with undo, export and the audio restart)
//      gives the commands -- tracks (patterns, steps/notes, current pattern,
//      rows with their samples, rack, clips) -> MIX_SET by name ->
//      MIX_SET_KEY last -> tempo, metronome, mode, loop and the live input
//      track (RESET_ALL put the transport back to 124 BPM / Pattern / loop
//      off / metronome off / no input track, so these are always sent) --
//      and the normalized project the UI state (projectState) is built from.
// The rack goes through patchRack, the same builder loadPatch uses.
//
// replayInto (below) is the audio restart's variant (audio/restart.ts): the
// project is already in memory, so steps 1 and 3 fall away -- no file to
// validate, no UI state to blank, no RESET_ALL (the engine is brand new) --
// and steps 2, 4 and 5 run on `p` itself: the samples the project uses
// decoded with the new context and uploaded at their OWN ids, then
// projectCommands of serialize(p); the unused ones follow later (`rest`).
//
// p.loading is set through state/idle.ts markBusy / markIdle (a default-kit
// import waiting for the load to end awaits that signal).
import { Err, Op } from '../audio/protocol';
import { decodeBytes, loadErrorText } from '../audio/samples';
import type { SampleDecoder } from '../audio/samples';
import { mixParam } from '../audio/mixerCatalog';
import type { CommandSink } from '../state/actions';
import { markBusy, markIdle } from '../state/idle';
import { DEFAULT_LOOP_END, newChannel, newMixer } from '../state/project.svelte';
import type { ChannelState, Project, SampleFile, Track } from '../state/project.svelte';
import { sampleFile } from '../state/sampleFiles';
import { projectCommands, trackState } from './commands';
import { serialize } from './serialize';
import { validate } from './schema';
import type { MixParamsJson, ProjectJson } from './schema';

export type { SampleDecoder };

/** The slice of AudioEngine a load needs (tests pass a fake). */
export interface LoadEngine extends CommandSink {
  readonly sampleRate: number;
  /** Sends RESET_ALL; resolves with its code once the worklet has applied it. */
  resetAll(): Promise<number>;
  loadSample(id: number, channels: Float32Array[]): Promise<number>;
  /**
   * Resume the AudioContext if it is suspended; true once it runs. A load
   * checks it before blanking anything: a suspended context never answers
   * RESET_ALL, which would leave a blank session behind.
   */
  ensureRunning(): Promise<boolean>;
}

/** The project could not be loaded (invalid file, or the engine refused the reset). */
export class ProjectLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectLoadError';
  }
}

/**
 * Replace `p` (and the engine session) with the project in `json`.
 * `sampleBytes`: project path ("samples/0-…-kick.wav") -> file bytes, as
 * readProject returns them. `beforeLoad` runs once the file is known to be
 * loadable (validated, samples decoded), right before STOP: the App stops
 * the transport through its own path there (the recorder is told).
 * Returns what was skipped or changed, as warnings for a banner; throws
 * ProjectLoadError (or the reset timeout). A failure after the session was
 * blanked also clears `p.folder`, so a later Save cannot write the blank
 * session over the project it came from.
 */
export async function loadProject(
  p: Project, engine: LoadEngine, json: unknown, sampleBytes: Map<string, ArrayBuffer>, ctx: SampleDecoder,
  opts: { beforeLoad?: () => void } = {},
): Promise<string[]> {
  const v = validate(json);
  if ('error' in v) throw new ProjectLoadError(v.error);
  const proj = v.project;
  const warnings = [...v.warnings];

  markBusy(p);
  try {
    const decoded: { oldId: number; file: SampleFile; channels: Float32Array[] }[] = [];
    for (const s of proj.samples) {
      const bytes = sampleBytes.get(s.file);
      if (!bytes) {
        warnings.push(`Sample "${s.name}" is missing from the project folder (${s.file})`);
        continue;
      }
      try {
        // decodeAudioData detaches its input: decode a copy, keep the original.
        const channels = await decodeBytes(bytes.slice(0), s.name, ctx);
        decoded.push({ oldId: s.id, file: await sampleFile(s.name, s.type, bytes), channels }); // hash: async
      } catch {
        warnings.push(`Sample "${s.name}" could not be decoded (${s.file})`);
      }
    }

    if (!(await engine.ensureRunning())) {
      throw new ProjectLoadError('Audio is paused — click to start audio, then open again');
    }

    opts.beforeLoad?.();
    engine.send(Op.STOP);
    blankState(p);
    try {
      const code = await engine.resetAll();
      if (code !== Err.OK) throw new ProjectLoadError(`The audio engine refused to reset (code ${code})`);

      const ids = new Map<number, number>();
      for (const d of decoded) {
        const id = ids.size;
        const c = await engine.loadSample(id, d.channels);
        // DEFERRED cannot really happen (stopped); the worklet would finish it on its own.
        if (c === Err.OK || c === Err.DEFERRED) {
          ids.set(d.oldId, id);
          p.sampleFiles.set(id, d.file);
        } else {
          warnings.push(`Sample "${d.file.name}" could not be loaded — ${loadErrorText(c, engine.sampleRate)}`);
        }
      }
      p.nextSampleId = ids.size;

      replay(p, engine, proj, ids, warnings);
    } catch (e) {
      p.folder = null; // the session is gone: never save it over that folder
      throw e;
    }
  } finally {
    markIdle(p);
  }
  return warnings;
}

/**
 * The sample ids the project uses now (serialize(p).samples: rows,
 * SamplePlayers, clips), plus `also` (the audio restart adds the ids of
 * deferred loads still waiting for Stop, sampleLoads.ts: they are attached
 * when they settle, so they count as used).
 */
export function usedSampleIds(p: Project, also: Iterable<number> = []): Set<number> {
  const used = new Set(serialize(p).samples.map((s) => s.id));
  for (const id of also) if (p.sampleFiles.has(id)) used.add(id);
  return used;
}

/** The original (encoded) bytes of those samples: what the restart's replay timeout scales with. */
export function sampleBytes(p: Project, ids: Iterable<number>): number {
  let n = 0;
  for (const id of ids) n += p.sampleFiles.get(id)?.bytes.byteLength ?? 0;
  return n;
}

/** What replayInto resolves with. */
export interface Replayed {
  /** Samples that could not be decoded or uploaded, and projectCommands' warnings. */
  warnings: string[];
  /** Each used sample's upload result (Err.OK, or why it failed); a sample that could not be decoded has none. */
  codes: Map<number, number>;
  /**
   * Decode and upload the samples the project does not use now (only an
   * undo can bring one back: snapshots name samples by id). Call it once
   * the new engine is wired; it is not part of the restart's timeout.
   * Resolves with warnings (never rejects). A refusal for memory is no
   * warning (that sample is only needed if an undo brings it back, and then
   * plays nothing). Stops as soon as the session is replaced (p.generation:
   * its ids are someone else's now), another restart starts or succeeds, or
   * the sample left p.sampleFiles.
   */
  rest(): Promise<string[]>;
}

/**
 * Rebuild a FRESH engine (a new AudioContext: the audio restart) from the
 * live project `p`, which is not changed at all: same track ids, selection,
 * name, folder, dirty mark, version and undo history.
 *
 * The samples the project uses (`used`, usedSampleIds) are decoded from
 * their in-memory original bytes with `ctx` (the new context: it resamples
 * to the new rate) and uploaded at the ids they already have, then the
 * commands of projectCommands(serialize(p)) are sent, synchronously, after
 * the last upload (a row's sample must be in the arena before
 * SET_ROW_SAMPLE). No RESET_ALL: a new engine is blank (and a reset would
 * need a running context to be acknowledged). The unused p.sampleFiles
 * entries are left to `rest` (see Replayed), so a large unused sample
 * never holds up (or times out) the switch.
 *
 * A used sample that did not make it is a warning; the UI keeps it (a Save
 * still writes its bytes), only the engine plays nothing for it.
 */
export async function replayInto(
  p: Project, engine: LoadEngine, ctx: SampleDecoder, used: Set<number> = usedSampleIds(p),
): Promise<Replayed> {
  const warnings: string[] = [];
  const codes = new Map<number, number>();
  const files = [...p.sampleFiles].sort((a, b) => a[0] - b[0]);
  const ids = new Map<number, number>();
  for (const [id, f] of files) {
    if (!used.has(id)) continue;
    let channels: Float32Array[];
    try {
      channels = await decodeBytes(f.bytes.slice(0), f.name, ctx);
    } catch {
      warnings.push(`Sample "${f.name}" could not be decoded again`);
      continue;
    }
    const c = await engine.loadSample(id, channels);
    codes.set(id, c);
    if (c === Err.OK || c === Err.DEFERRED) ids.set(id, id);
    else warnings.push(`Sample "${f.name}" could not be reloaded — ${loadErrorText(c, engine.sampleRate)}`);
  }
  const pc = projectCommands(serialize(p), ids);
  warnings.push(...pc.warnings);
  for (const c of pc.commands) engine.send(c[0], c[1], c[2], c[3], c[4]);

  const unused = files.filter(([id]) => !used.has(id));
  const rest = async (): Promise<string[]> => {
    const out: string[] = [];
    const gen = p.generation;
    const restarts = p.audioRestarts;
    const current = (id: number, f: SampleFile) =>
      p.generation === gen && p.audioRestarts === restarts && !p.restarting && p.sampleFiles.get(id) === f;
    for (const [id, f] of unused) {
      if (!current(id, f)) continue;
      let channels: Float32Array[];
      try {
        channels = await decodeBytes(f.bytes.slice(0), f.name, ctx);
      } catch {
        if (current(id, f)) out.push(`Sample "${f.name}" could not be decoded again`);
        continue;
      }
      if (!current(id, f)) continue; // checked right before the upload is posted
      let c: number;
      try {
        c = await engine.loadSample(id, channels);
      } catch (e) {
        if (current(id, f)) out.push(`Sample "${f.name}" could not be reloaded — ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (c !== Err.OK && c !== Err.DEFERRED && c !== Err.OUT_OF_MEMORY && current(id, f)) {
        out.push(`Sample "${f.name}" could not be reloaded — ${loadErrorText(c, engine.sampleRate)}`);
      }
    }
    return out;
  };
  return { warnings, codes, rest };
}

/** The UI state of a blank engine session (what RESET_ALL leaves). */
export function blankState(p: Project) {
  p.generation++; // a new session: older async results are dropped (sampleImport)
  p.history?.clear(); // undo never crosses into another session
  p.playing = false;
  p.tracks = [];
  p.selectedTrackId = null;
  p.lastSynthTrackId = null;
  p.mixer = newMixer();
  p.mode = 'pattern';
  p.loop = { on: false, start: 0, end: DEFAULT_LOOP_END };
  p.songPosition = 0;
  p.tempo = 124;
  p.metronome = false;
  p.nextSampleId = 0;
  p.sampleFiles.clear();
}

/**
 * Step 5 above: the commands come from projectCommands (the one replay-order
 * builder, project/commands.ts); the UI state is built from the normalized
 * project it returns, so the two always agree.
 */
function replay(p: Project, sink: CommandSink, proj: ProjectJson, ids: Map<number, number>, warnings: string[]) {
  const pc = projectCommands(proj, ids);
  warnings.push(...pc.warnings);
  projectState(p, pc.project);
  for (const c of pc.commands) sink.send(c[0], c[1], c[2], c[3], c[4]);
}

/**
 * Fill a blank `p` (blankState) with the UI state of a normalized project:
 * tracks, mixer, transport, selection and name. Sends nothing.
 */
export function projectState(p: Project, proj: ProjectJson) {
  const bySlot = new Map<number, Track>();
  for (const tj of proj.tracks) {
    p.tracks.push(trackState(tj));
    const t = p.tracks[p.tracks.length - 1]; // reactive proxy
    p.mixer.channels[t.id] = newChannel();
    bySlot.set(t.slot, t);
  }
  const setParams = (ch: ChannelState, params: MixParamsJson) => {
    for (const [name, value] of Object.entries(params)) ch.params[mixParam(name).id] = value;
  };
  for (const s of proj.mixer.tracks) {
    const ch = p.mixer.channels[bySlot.get(s.slot)!.id];
    setParams(ch, s.params);
    ch.key = s.key ? { trackId: bySlot.get(s.key.track)!.id, row: s.key.row } : null;
  }
  setParams(p.mixer.reverb, proj.mixer.reverb);
  setParams(p.mixer.delay, proj.mixer.delay);
  setParams(p.mixer.master, proj.mixer.master);
  p.tempo = proj.tempo;
  p.metronome = proj.metronome;
  p.mode = proj.mode;
  p.loop = { ...proj.loop };
  const sel = proj.selection.track !== null ? bySlot.get(proj.selection.track) : p.tracks[0];
  const synth = proj.selection.synth !== null ? bySlot.get(proj.selection.synth) : p.tracks.find((t) => t.kind === 'synth');
  p.selectedTrackId = sel?.id ?? null;
  p.lastSynthTrackId = sel?.kind === 'synth' ? sel.id : (synth?.id ?? null);
  p.name = proj.name;
}
