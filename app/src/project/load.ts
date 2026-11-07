// project.json -> Project + engine. See docs/architecture/projects.md.
//
// Order (each step only starts when the previous one cannot fail the load
// half-way):
//   1. validate (pure): an error throws ProjectLoadError and changes nothing.
//   2. decode every sample (async, nothing touched yet).
//   3. STOP, blank the UI state, RESET_ALL, and wait for the worklet's ack:
//      sample uploads go by postMessage and must not overtake the reset.
//   4. upload the samples with compact ids 0..n-1 (old -> new id map).
//   5. replay, synchronously: tracks (patterns, steps/notes, current pattern,
//      rows with their samples, rack via loadPatch, clips) -> MIX_SET by
//      name -> MIX_SET_KEY last (keys need their source tracks and rows) ->
//      tempo, metronome, mode, loop and the live input track. RESET_ALL put
//      the transport back to 124 BPM / Pattern / loop off / metronome off /
//      no input track, so these are always sent to match the UI.
// The replay goes through the same code as the UI where one exists
// (loadPatch, setMix, setSidechain), so a load can never send a command an
// edit could not.
import { Err, MAX_CLIPS, MAX_NOTES, Op } from '../audio/protocol';
import { decodeBytes, loadErrorText } from '../audio/samples';
import type { SampleDecoder } from '../audio/samples';
import { mixParam } from '../audio/mixerCatalog';
import { liveInputTrack } from '../state/actions';
import type { CommandSink } from '../state/actions';
import { setMix, setSidechain } from '../state/mixer-actions';
import type { MixChannelTarget } from '../state/mixer-actions';
import { makeDrumPattern, makeNotePattern } from '../state/pattern-actions';
import { loadPatch } from '../state/rack-actions';
import { DEFAULT_LOOP_END, newChannel, newMixer } from '../state/project.svelte';
import type { Clip, DrumTrack, Project, SampleFile, SynthTrack, Track } from '../state/project.svelte';
import { validate } from './schema';
import type { ClipJson, MixParamsJson, ProjectJson } from './schema';

export type { SampleDecoder };

/** The slice of AudioEngine a load needs (tests pass a fake). */
export interface LoadEngine extends CommandSink {
  readonly sampleRate: number;
  /** Sends RESET_ALL; resolves with its code once the worklet has applied it. */
  resetAll(): Promise<number>;
  loadSample(id: number, channels: Float32Array[]): Promise<number>;
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
 * `sampleBytes`: project path ("samples/0-kick.wav") -> file bytes, as
 * readProject returns them. Returns what was skipped or changed, as
 * warnings for a banner; throws ProjectLoadError (or the reset timeout).
 */
export async function loadProject(
  p: Project, engine: LoadEngine, json: unknown, sampleBytes: Map<string, ArrayBuffer>, ctx: SampleDecoder,
): Promise<string[]> {
  const v = validate(json);
  if ('error' in v) throw new ProjectLoadError(v.error);
  const proj = v.project;
  const warnings = [...v.warnings];

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
      decoded.push({ oldId: s.id, file: { name: s.name, type: s.type, bytes }, channels });
    } catch {
      warnings.push(`Sample "${s.name}" could not be decoded (${s.file})`);
    }
  }

  engine.send(Op.STOP);
  blankState(p);
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
  return warnings;
}

/** The UI state of a blank engine session (what RESET_ALL leaves). */
export function blankState(p: Project) {
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

/** Rebuild the state of a validated project and send its commands (step 5 above). */
function replay(p: Project, sink: CommandSink, proj: ProjectJson, ids: Map<number, number>, warnings: string[]) {
  const sampleId = (old: number | null) => (old === null ? null : (ids.get(old) ?? null));
  const bySlot = new Map<number, Track>();

  for (const tj of proj.tracks) {
    let track: Track;
    if (tj.kind === 'drum') {
      const patterns = tj.patterns.map((pj) => {
        const pat = makeDrumPattern(pj.engineIdx, pj.name, pj.stepCount, pj.swing);
        for (const [r, s, vel] of pj.hits) pat.steps[r][s] = vel;
        return pat;
      });
      p.tracks.push({
        kind: 'drum',
        id: crypto.randomUUID(),
        slot: tj.slot,
        name: tj.name,
        color: tj.color,
        rows: tj.rows.map((r) => ({
          id: crypto.randomUUID(), name: r.name, sampleId: sampleId(r.sample), gain: r.gain, pan: r.pan, mute: r.mute,
        })),
        patterns,
        currentPatternId: patterns.find((x) => x.engineIdx === tj.currentPattern)!.id,
        clips: [],
      });
      const t = p.tracks[p.tracks.length - 1] as DrumTrack; // reactive proxy
      track = t;
      p.mixer.channels[t.id] = newChannel();
      sink.send(Op.ADD_DRUM_TRACK, t.slot);
      // Step edits act on the engine's current pattern: select each in turn.
      for (const pat of t.patterns) {
        sink.send(Op.SET_CURRENT_PATTERN, t.slot, pat.engineIdx);
        sink.send(Op.SET_STEP_COUNT, t.slot, pat.stepCount);
        sink.send(Op.SET_SWING, t.slot, pat.swing);
        pat.steps.forEach((row, r) => row.forEach((vel, s) => vel > 0 && sink.send(Op.SET_STEP, t.slot, r, s, vel)));
      }
      sink.send(Op.SET_CURRENT_PATTERN, t.slot, tj.currentPattern);
      t.rows.forEach((r, i) => {
        if (r.sampleId !== null) sink.send(Op.SET_ROW_SAMPLE, t.slot, i, r.sampleId);
        if (r.gain !== 1) sink.send(Op.SET_ROW_GAIN, t.slot, i, r.gain);
        if (r.pan !== 0) sink.send(Op.SET_ROW_PAN, t.slot, i, r.pan);
        if (r.mute) sink.send(Op.SET_ROW_MUTE, t.slot, i, 1);
      });
    } else {
      const patterns = tj.patterns.map((pj) => ({
        ...makeNotePattern(pj.engineIdx, pj.name, pj.bars),
        notes: pj.notes.map((n) => ({ id: crypto.randomUUID(), ...n })),
      }));
      p.tracks.push({
        kind: 'synth',
        id: crypto.randomUUID(),
        slot: tj.slot,
        name: tj.name,
        color: tj.color,
        patchName: '',
        modules: [],
        cables: [],
        patterns,
        currentPatternId: patterns.find((x) => x.engineIdx === tj.currentPattern)!.id,
        clips: [],
      });
      const t = p.tracks[p.tracks.length - 1] as SynthTrack;
      track = t;
      p.mixer.channels[t.id] = newChannel();
      sink.send(Op.ADD_SYNTH_TRACK, t.slot);
      for (const pat of t.patterns) {
        sink.send(Op.SET_CURRENT_PATTERN, t.slot, pat.engineIdx);
        sink.send(Op.SET_PATTERN_BARS, t.slot, pat.bars);
        for (const n of pat.notes) {
          sink.send(Op.NOTE_SET, t.slot * MAX_NOTES + n.idx, n.pitch * 128 + n.vel, n.start, n.len);
        }
      }
      sink.send(Op.SET_CURRENT_PATTERN, t.slot, tj.currentPattern);
      // SamplePlayer `sample` params follow the compact sample ids (a sample
      // that did not load: none; its own warning says why).
      const patch = {
        ...tj.patch,
        modules: tj.patch.modules.map((m) =>
          m.id === 'sample_player' && m.params?.sample !== undefined
            ? { ...m, params: { ...m.params, sample: sampleId(m.params.sample < 0 ? null : m.params.sample) ?? -1 } }
            : m,
        ),
      };
      for (const w of loadPatch(p, sink, t.id, patch)) warnings.push(`Track "${t.name}": ${w}`);
    }
    addClips(sink, track, tj.clips);
    bySlot.set(track.slot, track);
  }

  // Mixer: params by name (only non-defaults: RESET_ALL set the defaults),
  // then every sidechain key last.
  const setParams = (target: MixChannelTarget, params: MixParamsJson) => {
    for (const [name, value] of Object.entries(params)) {
      if (value !== mixParam(name).default) setMix(p, sink, target, name, value);
    }
  };
  for (const s of proj.mixer.tracks) setParams(bySlot.get(s.slot)!.id, s.params);
  setParams('reverb', proj.mixer.reverb);
  setParams('delay', proj.mixer.delay);
  setParams('master', proj.mixer.master);
  for (const s of proj.mixer.tracks) {
    if (!s.key) continue;
    const t = bySlot.get(s.slot)!;
    const src = bySlot.get(s.key.track)!;
    if (!setSidechain(p, sink, t.id, { trackId: src.id, row: s.key.row })) {
      warnings.push(`Mixer "${t.name}": sidechain key ${src.name}${s.key.row === null ? '' : ` row ${s.key.row + 1}`} could not be set (dropped)`);
    }
  }

  // Transport and live input (RESET_ALL reset them in the engine).
  p.tempo = proj.tempo;
  sink.send(Op.SET_TEMPO, p.tempo);
  p.metronome = proj.metronome;
  sink.send(Op.SET_METRONOME, p.metronome ? 1 : 0);
  p.mode = proj.mode;
  sink.send(Op.SET_MODE, p.mode === 'song' ? 1 : 0);
  p.loop = { ...proj.loop };
  sink.send(Op.SET_LOOP, p.loop.on ? p.loop.start : 0, p.loop.on ? p.loop.end : 0);
  const sel = proj.selection.track !== null ? bySlot.get(proj.selection.track) : p.tracks[0];
  const synth = proj.selection.synth !== null ? bySlot.get(proj.selection.synth) : p.tracks.find((t) => t.kind === 'synth');
  p.selectedTrackId = sel?.id ?? null;
  p.lastSynthTrackId = sel?.kind === 'synth' ? sel.id : (synth?.id ?? null);
  sink.send(Op.SET_INPUT_TRACK, liveInputTrack(p)?.slot ?? -1);
  p.name = proj.name;
}

function addClips(sink: CommandSink, t: Track, clips: ClipJson[]) {
  const ps: { id: string; engineIdx: number }[] = t.patterns;
  for (const cj of clips) {
    const pat = ps.find((x) => x.engineIdx === cj.pattern)!;
    const c: Clip = { id: crypto.randomUUID(), idx: cj.idx, patternId: pat.id, start: cj.start, len: cj.len, offset: cj.offset };
    t.clips.push(c);
    sink.send(Op.CLIP_SET, t.slot * MAX_CLIPS + c.idx, c.offset * 16 + pat.engineIdx, c.start, c.len);
  }
}
