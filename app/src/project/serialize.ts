// Project -> project.json (schema.ts). Pure: reads the project, changes
// nothing, same input -> same output. Plan 7's undo snapshots and autosave
// (Task 4) build on this, and App's "● unsaved" mark compares fingerprints.
import { moduleDef } from '../audio/catalog';
import { MIX_DELAY, MIX_MASTER, MIX_REVERB } from '../audio/protocol';
import { MIX_PARAMS } from '../audio/mixerCatalog';
import type { MixTarget } from '../audio/mixerCatalog';
import { accepts } from '../state/mixer-actions';
import { currentPattern, MAX_STEPS } from '../state/project.svelte';
import type { ChannelState, DrumTrack, Project, SynthTrack, Track } from '../state/project.svelte';
import { SCHEMA_VERSION } from './schema';
import type { ClipJson, DrumTrackJson, MixParamsJson, ProjectJson, SynthTrackJson } from './schema';

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

function clipsOf(t: Track): ClipJson[] {
  const out: ClipJson[] = [];
  for (const c of t.clips) {
    const ps: { id: string; engineIdx: number }[] = t.patterns;
    const pat = ps.find((x) => x.id === c.patternId);
    if (pat) out.push({ idx: c.idx, pattern: pat.engineIdx, start: c.start, len: c.len, offset: c.offset });
  }
  return out;
}

/**
 * The project as saved. Samples: only those used by a drum row or a
 * SamplePlayer `sample` param AND whose original file the session has
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
  });

  const synth = (t: SynthTrack): SynthTrackJson => ({
    kind: 'synth',
    slot: t.slot,
    name: t.name,
    color: t.color,
    patch: {
      name: t.patchName,
      modules: t.modules.map((m) => {
        const def = moduleDef(m.kind);
        const params: Record<string, number> = {};
        def.params.forEach((pd, i) => (params[pd.name] = m.params[i]));
        if (def.id === 'sample_player') params.sample = use(params.sample) ?? -1;
        return { idx: m.idx, id: def.id, params };
      }),
      cables: t.cables.map((c) => {
        const from = moduleDef(t.modules.find((m) => m.idx === c.from.m)!.kind);
        const to = moduleDef(t.modules.find((m) => m.idx === c.to.m)!.kind);
        return { from: [c.from.m, from.outputs[c.from.port].name], to: [c.to.m, to.inputs[c.to.port].name] };
      }),
    },
    patterns: t.patterns.map((pat) => ({
      engineIdx: pat.engineIdx,
      name: pat.name,
      bars: pat.bars,
      notes: pat.notes.map((n) => ({ idx: n.idx, pitch: n.pitch, vel: n.vel, start: n.start, len: n.len })),
    })),
    currentPattern: currentPattern(t).engineIdx,
    clips: clipsOf(t),
  });

  const tracks = p.tracks.map((t) => (t.kind === 'drum' ? drum(t) : synth(t)));
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
    reverb: mixParams(p.mixer.reverb, 'return', MIX_REVERB),
    delay: mixParams(p.mixer.delay, 'return', MIX_DELAY),
    master: mixParams(p.mixer.master, 'master', MIX_MASTER),
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
  };
}

/**
 * What "unsaved changes" compares: the serialized project minus the track
 * selection (selecting a track is not an edit).
 */
export function projectFingerprint(p: Project): string {
  return JSON.stringify({ ...serialize(p), selection: null });
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
