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
//   4. upload the samples with compact ids 0..n-1 (old -> new id map),
//      recording each one's length, channels and waveform peaks (p.sampleMeta;
//      the peaks are computed in step 2, audio/peaks.ts) and the
//      floats it takes (p.arenaFloats: the sample budget starts over, so
//      samples replaced in the old session no longer count).
//   5. replay, synchronously: projectCommands (project/commands.ts, the one
//      replay-order builder shared with undo, export and the audio restart)
//      gives the commands -- tracks (patterns, steps/notes, current pattern,
//      rows with their samples, rack, clips; Audio tracks and their clips)
//      -> MIX_SET by name ->
//      MIX_SET_KEY -> automation lanes (each AUTO_LANE_SET, its points,
//      AUTO_LANE_ENABLE) -> tempo, metronome, mode, loop and the live input
//      track (RESET_ALL put the transport back to 124 BPM / Pattern / loop
//      off / metronome off / no input track, so these are always sent) --
//      and the normalized project the UI state (projectState) is built from
//      (MIDI mappings included: UI state only, by track slot -> new id).
// The rack goes through patchRack, the same builder loadPatch uses.
//
// replayInto (below) is the audio restart's variant (audio/restart.ts): the
// project is already in memory, so steps 1 and 3 fall away -- no file to
// validate, no UI state to blank, no RESET_ALL (the engine is brand new) --
// and steps 2, 4 and 5 run on `p` itself: the samples the project uses
// decoded with the new context and uploaded at their OWN ids, then
// projectCommands of serialize(p); the unused ones follow later (`rest`).
// The new engine's arena is empty: the restart sets p.arenaFloats to what
// replayInto uploaded (Replayed.floats) and `rest` adds the late ones.
//
// p.loading is set through state/idle.ts markBusy / markIdle (a default-kit
// import waiting for the load to end awaits that signal).
import { Err, MAX_AUTO_POINTS, Op } from '../audio/protocol';
import { decodeBytes, loadErrorText } from '../audio/samples';
import type { SampleDecoder } from '../audio/samples';
import { mixParam } from '../audio/mixerCatalog';
import type { CommandSink } from '../state/actions';
import { markBusy, markIdle } from '../state/idle';
import { DEFAULT_LOOP_END, newChannel, newMixer } from '../state/project.svelte';
import type { ChannelState, Peaks, Project, SampleFile, Track } from '../state/project.svelte';
import { peaksFor } from '../audio/peaks';
import { sampleFile } from '../state/sampleFiles';
import { fitsBudget, overBudgetText, sampleFloats } from '../state/sampleBudget';
import { deferSampleAssign } from '../state/sampleLoads';
import { lanesState, midiMapState, projectCommands, trackState } from './commands';
import type { EngineCommand } from './commands';
import { serialize } from './serialize';
import { validate } from './schema';
import type { MixParamsJson, ProjectJson } from './schema';
import { fineSamples } from '../audio/fineSamples';

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
    const decoded: { oldId: number; file: SampleFile; channels: Float32Array[]; peaks: Peaks | null }[] = [];
    for (const s of proj.samples) {
      const bytes = sampleBytes.get(s.file);
      if (!bytes) {
        warnings.push(`Sample "${s.name}" is missing from the project folder (${s.file})`);
        continue;
      }
      try {
        // decodeAudioData detaches its input: decode a copy, keep the original.
        const decodedChannels = await decodeBytes(bytes.slice(0), s.name, ctx);
        const file = await sampleFile(s.name, s.type, bytes); // hash: async
        // Waveform peaks before the upload transfers the buffers (audio/peaks.ts; cached by hash).
        // A peaks worker that died with the buffers: decode again, no peaks (flat placeholder).
        const pk = await peaksFor(decodedChannels, file.hash);
        const channels = pk.channels ?? (await decodeBytes(bytes.slice(0), s.name, ctx));
        decoded.push({ oldId: s.id, file, channels, peaks: pk.peaks });
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
        const meta = { seconds: d.channels[0].length / engine.sampleRate, channels: d.channels.length, peaks: d.peaks };
        const floats = sampleFloats(d.channels); // before the upload transfers the buffers away
        if (!fitsBudget(p, floats)) {
          // Reopened at a higher rate (or a bigger decode) than the file was saved at.
          warnings.push(overBudgetText(p, `Sample "${d.file.name}"`, floats));
          continue;
        }
        const c = await engine.loadSample(id, d.channels);
        // DEFERRED cannot really happen (stopped); the worklet would finish it on its own.
        if (c === Err.OK || c === Err.DEFERRED) {
          ids.set(d.oldId, id);
          p.sampleFiles.set(id, d.file);
          p.sampleMeta.set(id, meta);
          p.arenaFloats += floats;
        } else {
          warnings.push(`Sample "${d.file.name}" could not be loaded — ${loadErrorText(c, engine.sampleRate)}`);
        }
      }
      p.nextSampleId = ids.size;
      p.peaksVersion++;

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
  /** Sample floats the new engine took for them (the restart's p.arenaFloats once it switched). */
  floats: number;
  /**
   * Decode and upload the samples the project does not use now (only an
   * undo can bring one back: snapshots name samples by id). Call it once
   * the new engine is wired; it is not part of the restart's timeout.
   * Resolves with warnings (never rejects). A refusal for memory is no
   * warning (that sample is only needed if an undo brings it back, and then
   * plays nothing). Stops as soon as the session is replaced (p.generation:
   * its ids are someone else's now), another restart starts or succeeds, or
   * the sample left p.sampleFiles. Each sample that lands adds its floats
   * to p.arenaFloats (the new engine is the current one by then).
   */
  rest(onLanded?: (id: number) => void): Promise<string[]>;
}

/**
 * The commands that bind sample `id` to what uses it in `p` now (a drum
 * row's SET_ROW_SAMPLE, a SamplePlayer's sample param, an audio clip, ...):
 * those of projectCommands(serialize(p)) that differ between the engine
 * having `id` and not having it. The restart re-sends them when a late
 * (`rest`) upload lands, for an undo that brought the sample back before it
 * was in the arena (the engine refused or never played that binding then).
 * Empty if nothing uses `id`.
 *
 * Compared as UNITS, not single commands: an audio clip's AUDIO_CLIP_SOURCE
 * only stages its change, so the clip's whole SOURCE, GAIN, SET triple
 * (commands.ts audioClipCommands) is one unit and goes out whole when its
 * SOURCE differs -- a SOURCE alone would never be committed.
 */
export function bindingCommands(p: Project, id: number): [number, number, number, number, number][] {
  const json = serialize(p);
  const all = new Map([...p.sampleFiles.keys()].map((k) => [k, k]));
  const without = new Map(all);
  all.set(id, id);
  without.delete(id);
  const key = (u: EngineCommand[]) => u.map((c) => c.join(',')).join(';');
  const unbound = new Map<string, number>();
  for (const u of units(projectCommands(json, without).commands)) unbound.set(key(u), (unbound.get(key(u)) ?? 0) + 1);
  const out: [number, number, number, number, number][] = [];
  for (const u of units(projectCommands(json, all).commands)) {
    const n = unbound.get(key(u)) ?? 0;
    if (n > 0) unbound.set(key(u), n - 1);
    else for (const c of u) out.push([c[0], c[1] ?? 0, c[2] ?? 0, c[3] ?? 0, c[4] ?? 0]);
  }
  return out;
}

/**
 * `cmds` grouped into what must be sent together: an audio clip's SOURCE,
 * GAIN, SET; an automation lane's AUTO_LANE_SET with its AUTO_POINT_SETs and
 * AUTO_LANE_ENABLE (commands.ts laneCommands: a point needs its lane's
 * target, so a lane is never split); any other command alone.
 */
export function units(cmds: EngineCommand[]): EngineCommand[][] {
  const out: EngineCommand[][] = [];
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    const commit = cmds[i + 2];
    if (c[0] === Op.AUDIO_CLIP_SOURCE && commit?.[0] === Op.AUDIO_CLIP_SET && commit[1] === c[1]) {
      out.push(cmds.slice(i, i + 3));
      i += 2;
    } else if (c[0] === Op.AUTO_LANE_SET) {
      const lane = c[1];
      let j = i + 1;
      while (j < cmds.length && cmds[j][0] === Op.AUTO_POINT_SET && Math.floor(cmds[j][1]! / MAX_AUTO_POINTS) === lane) j++;
      if (j < cmds.length && cmds[j][0] === Op.AUTO_LANE_ENABLE && cmds[j][1] === lane) j++;
      out.push(cmds.slice(i, j));
      i = j - 1;
    } else out.push([c]);
  }
  return out;
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
  let floats = 0;
  /**
   * Length and channels at the new rate (the peaks, a picture of the same
   * audio, are kept), and the floats; read before the upload transfers the
   * buffers away.
   */
  const measure = (id: number, channels: Float32Array[]) => {
    const peaks = p.sampleMeta.get(id)?.peaks ?? null;
    p.sampleMeta.set(id, { seconds: channels[0].length / engine.sampleRate, channels: channels.length, peaks });
    p.peaksVersion++;
    return sampleFloats(channels);
  };
  for (const [id, f] of files) {
    if (!used.has(id)) continue;
    let channels: Float32Array[];
    try {
      channels = await decodeBytes(f.bytes.slice(0), f.name, ctx);
    } catch {
      warnings.push(`Sample "${f.name}" could not be decoded again`);
      continue;
    }
    const n = measure(id, channels);
    // The new engine is blank, so its use is `floats` (p.arenaFloats is the OLD engine's).
    const fresh = { arenaFloats: floats } as Project;
    if (!fitsBudget(fresh, n)) {
      // The new engine (maybe a higher rate) cannot hold it: name the limit, skip the upload.
      codes.set(id, Err.OUT_OF_MEMORY);
      warnings.push(overBudgetText(fresh, `Sample "${f.name}"`, n));
      continue;
    }
    const c = await engine.loadSample(id, channels);
    codes.set(id, c);
    if (c === Err.OK || c === Err.DEFERRED) {
      ids.set(id, id);
      floats += n;
    } else warnings.push(`Sample "${f.name}" could not be reloaded — ${loadErrorText(c, engine.sampleRate)}`);
  }
  const pc = projectCommands(serialize(p), ids);
  warnings.push(...pc.warnings);
  for (const c of pc.commands) engine.send(c[0], c[1], c[2], c[3], c[4]);

  const unused = files.filter(([id]) => !used.has(id));
  const rest = async (onLanded?: (id: number) => void): Promise<string[]> => {
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
      const n = measure(id, channels);
      let c: number;
      try {
        c = await engine.loadSample(id, channels);
      } catch (e) {
        if (current(id, f)) out.push(`Sample "${f.name}" could not be reloaded — ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!current(id, f)) continue;
      if (c === Err.OK) {
        p.arenaFloats += n;
        onLanded?.(id);
      } else if (c === Err.DEFERRED) {
        // Playback was started first: the engine parks the upload until Stop.
        // Reserve its floats now, but bind (onLanded) only once it landed OK;
        // a failure at Stop gives the floats back (sampleLoads.settle).
        p.arenaFloats += n;
        deferSampleAssign(id, f.name, () => onLanded?.(id));
      } else if (c !== Err.OUT_OF_MEMORY) out.push(`Sample "${f.name}" could not be reloaded — ${loadErrorText(c, engine.sampleRate)}`);
    }
    return out;
  };
  return { warnings, codes, floats, rest };
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
  p.midiMap = [];
  p.mode = 'pattern';
  p.loop = { on: false, start: 0, end: DEFAULT_LOOP_END };
  p.songPosition = 0;
  p.tempo = 124;
  p.metronome = false;
  p.nextSampleId = 0;
  p.sampleFiles.clear();
  p.sampleMeta.clear(); // a new session's ids are not the old ones
  fineSamples().clear(); // the waveform's decoded floats (plan 12)
  p.peaksVersion++;
  p.arenaFloats = 0; // RESET_ALL empties the engine's sample arena
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
  const master = lanesState(proj.mixer.automation);
  p.mixer.automation = proj.mixer.automation.map((mj, i) => ({ channel: mj.channel, lane: master[i] }));
  p.midiMap = midiMapState(proj.midiMap, (slot) => bySlot.get(slot)?.id);
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
