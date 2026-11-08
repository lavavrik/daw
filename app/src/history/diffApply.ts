// Restore a project snapshot by sending only the commands the difference
// needs (undo/redo; docs/architecture/history.md). No RESET_ALL, no STOP:
// the transport keeps playing, and the engine's own release rules end any
// note or clip that is removed or changed (no stuck notes).
//
// Objects are matched by their engine address, which snapshots store:
// tracks by slot, patterns by engineIdx, notes and clips by idx, rows by
// index, rack modules by idx, cables by input port. Matched objects are
// edited in place (their UI ids survive, so editor selections stay valid);
// the rest are created or removed.
//
// Order:
//   1. tracks that are gone, or whose slot changed kind: REMOVE_TRACK; then
//      every rack module that goes, on every track (the FX pool is shared:
//      removals before any add);
//   2. per track, in `to` order: a track the live project lacks is rebuilt
//      whole (trackState + trackCommands, the plan-6 load builders);
//      otherwise name/colour, drum rows, patterns (new ones, then data of
//      changed ones -- the engine edits its current pattern, so each is
//      selected in turn -- then the current pattern, then clips, then
//      patterns that are gone: CLEAR_PATTERN_DATA), and the synth rack
//      (modules added, params, cables); an Audio track: its clips by idx
//      (CLIP_REMOVE for the ones that go, then SOURCE, GAIN, SET for each
//      new or changed one; an unchanged clip keeps its UI id and is not
//      re-sent; a clip that moved between Audio lanes keeps its UI id: a
//      new clip takes the id of a clip leaving another Audio track with the
//      same sample, length, offset, loop, gain and fades);
//   3. mixer params by name, then sidechain keys (their sources exist now);
//   3b. automation lanes (plan 10), matched by engine lane: the engine lost
//      the lanes of the tracks and modules step 1 removed (the state drops
//      them there too). Then, explicitly CLEAR FIRST, THEN RE-TARGET: every
//      lane that goes, or whose target (or owner) changes, gets
//      AUTO_LANE_CLEAR before any AUTO_LANE_SET, so two lanes trading
//      targets never hit "a second lane on one target"; a new or
//      re-targeted lane is then set whole (commands.ts laneCommands), and a
//      kept one gets its point difference by idx (state/automation.ts
//      pointCommands: removals before sets) and its enable flag. Lane and
//      point UI ids survive when their engine lane / idx is kept;
//   4. tempo, metronome, loop, mode; selection and the live input track;
//      the MIDI mappings (UI state only, no command: rebuilt from `to` by
//      slot, so a track rebuilt in step 2 under a fresh id keeps them).
// The project name is not restored (a Save As names the project, not an edit).
import { MAX_CLIPS, MAX_NOTES, MIX_DELAY, MIX_MASTER, MIX_REVERB, Op, packPort } from '../audio/protocol';
import { moduleDef } from '../audio/catalog';
import { MIX_PARAMS } from '../audio/mixerCatalog';
import type { MixTarget } from '../audio/mixerCatalog';
import { liveInputTrack, setMetronome, setTempo } from '../state/actions';
import type { CommandSink } from '../state/actions';
import { markEdited } from '../state/edits';
import { accepts, setMix, setSidechain } from '../state/mixer-actions';
import type { MixChannelTarget } from '../state/mixer-actions';
import { makeDrumPattern, makeNotePattern, sendNote } from '../state/pattern-actions';
import { patchRack } from '../state/rack-actions';
import { sendClip, setLoop, setMode } from '../state/song-actions';
import { sendAudioClip } from '../state/audio-actions';
import { MAX_ROWS, MAX_STEPS, currentPattern, newChannel } from '../state/project.svelte';
import type {
  AudioClip, AudioTrack, AutomationLane, ChannelState, Clip, DrumPattern, DrumTrack, MasterChannel, NotePatternState, PatternTrack,
  Project, SidechainKey, SynthTrack, Track,
} from '../state/project.svelte';
import { laneCommands, lanesState, midiMapState, trackCommands, trackState } from '../project/commands';
import { MASTER_CHANNEL_INDEX, pointCommands, pointMap } from '../state/automation';
import type { PointTuple } from '../state/automation';
import type {
  AudioTrackJson, ClipJson, DrumTrackJson, LaneJson, MixParamsJson, PatternTrackJson, ProjectJson, SynthTrackJson,
} from '../project/schema';
import { laneJson } from '../project/serialize';

// Snapshots share unchanged subtrees (history.ts), so identity settles most compares.
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Make `p` (whose snapshot is `from`) and the engine match `to`. */
export function diffApply(p: Project, sink: CommandSink, from: ProjectJson, to: ProjectJson) {
  /** The engine's live input slot (REMOVE_TRACK of it unsets it). */
  let engineInput = liveInputTrack(p)?.slot ?? -1;
  const want = new Map(to.tracks.map((t) => [t.slot, t]));
  const was = new Map(from.tracks.map((t) => [t.slot, t]));

  // 1. Gone, or another kind now.
  for (const t of [...p.tracks]) {
    const tj = want.get(t.slot);
    if (tj && tj.kind === t.kind) continue;
    dropTrack(p, sink, t);
    if (engineInput === t.slot) engineInput = -1;
  }
  // ...and every rack module that goes, on every track, before any is added:
  // pooled effects (Delay/Reverb/Chorus) share one FX pool, so an effect
  // moved between tracks must leave its old track first or its add is refused.
  for (const t of p.tracks) {
    const tj = want.get(t.slot);
    if (t.kind === 'synth' && tj?.kind === 'synth' && !same(was.get(t.slot), tj)) removeModules(sink, t, tj);
  }

  // What the engine's lanes are now: the live state's (it mirrors the engine,
  // the lanes step 1 cleared included), before step 2 adds whole tracks
  // whose lanes the engine does not have yet.
  const engineLanes = liveLanes(p);

  // Audio clips leaving their track (a move between Audio lanes, undone or
  // redone): a matching new clip on another Audio track takes the id back.
  const leaving: AudioClip[] = [];
  for (const t of p.tracks) {
    const tj = want.get(t.slot);
    if (t.kind !== 'audio' || tj?.kind !== 'audio') continue;
    const kept = new Set(tj.clips.map((c) => c.idx));
    leaving.push(...t.clips.filter((c) => !kept.has(c.idx)));
  }

  // 2. Every track of `to`, in its order.
  const bySlot = new Map<number, Track>();
  const order: Track[] = [];
  for (const tj of to.tracks) {
    let t = p.tracks.find((x) => x.slot === tj.slot);
    if (!t) {
      p.tracks.push(trackState(tj));
      t = p.tracks[p.tracks.length - 1]; // reactive proxy
      p.mixer.channels[t.id] = newChannel(); // ADD resets the engine's strip
      for (const c of trackCommands(tj)) sink.send(c[0], c[1], c[2], c[3], c[4]);
    } else if (!same(was.get(tj.slot), tj)) {
      t.name = tj.name;
      t.color = tj.color;
      if (t.kind === 'drum') diffDrum(p, sink, t, tj as DrumTrackJson);
      else if (t.kind === 'synth') diffSynth(p, sink, t, tj as SynthTrackJson);
      else diffAudio(sink, t, tj as AudioTrackJson, leaving);
    }
    bySlot.set(t.slot, t);
    order.push(t);
  }
  if (order.some((t, i) => p.tracks[i] !== t)) p.tracks = order;

  // 3. Mixer: params by name, then keys.
  const params = (target: MixChannelTarget, ch: ChannelState, kind: MixTarget, index: number, ps: MixParamsJson) => {
    for (const def of MIX_PARAMS) {
      if (!accepts(def, kind, index)) continue;
      const v = ps[def.name] ?? def.default;
      if (ch.params[def.id] !== v) setMix(p, sink, target, def.name, v);
    }
  };
  const strips = new Map(to.mixer.tracks.map((s) => [s.slot, s]));
  for (const t of order) params(t.id, p.mixer.channels[t.id], 'track', t.slot, strips.get(t.slot)?.params ?? {});
  params('reverb', p.mixer.reverb, 'return', MIX_REVERB, to.mixer.reverb);
  params('delay', p.mixer.delay, 'return', MIX_DELAY, to.mixer.delay);
  params('master', p.mixer.master, 'master', MIX_MASTER, to.mixer.master);
  const keyOf = (t: Track): SidechainKey | null => {
    const k = strips.get(t.slot)?.key;
    const src = k ? bySlot.get(k.track) : undefined;
    return k && src ? { trackId: src.id, row: k.row } : null;
  };
  const changing = order.filter((t) => !same(p.mixer.channels[t.id].key, keyOf(t)));
  // Clear first: frees drum-row key slots (MAX_KEYS) the new keys may need.
  for (const t of changing) if (keyOf(t) === null) setSidechain(p, sink, t.id, null);
  let todo = changing.filter((t) => keyOf(t) !== null);
  for (let pass = 0; pass < 2 && todo.length; pass++) todo = todo.filter((t) => !setSidechain(p, sink, t.id, keyOf(t)));

  // 3b. Automation lanes.
  diffLanes(p, sink, engineLanes, to, order);

  // 4. Transport, selection, live input.
  if (p.tempo !== to.tempo) setTempo(p, sink, to.tempo);
  if (p.metronome !== to.metronome) setMetronome(p, sink, to.metronome);
  if (!same(p.loop, to.loop)) setLoop(p, sink, to.loop);
  if (p.mode !== to.mode) setMode(p, sink, to.mode);
  const sel = to.selection.track !== null ? bySlot.get(to.selection.track) : order[0];
  const synth = to.selection.synth !== null ? bySlot.get(to.selection.synth) : order.find((t) => t.kind === 'synth');
  p.selectedTrackId = sel?.id ?? null;
  p.lastSynthTrackId = sel?.kind === 'synth' ? sel.id : (synth?.id ?? null);
  const midiMap = midiMapState(to.midiMap, (slot) => bySlot.get(slot)?.id);
  if (!same(p.midiMap, midiMap)) p.midiMap = midiMap;
  const input = liveInputTrack(p)?.slot ?? -1;
  if (input !== engineInput) sink.send(Op.SET_INPUT_TRACK, input);
  markEdited(p); // also when only UI-only fields (names) changed
}

/**
 * Remove (engine + state) the modules of `t` that `tj`'s rack does not have
 * at their idx with their kind; the engine drops their cables, so does the
 * state. Returns `tj`'s rack (patchRack). Idempotent.
 */
function removeModules(sink: CommandSink, t: SynthTrack, tj: SynthTrackJson) {
  const want = patchRack(t.slot, tj.patch);
  const kept = (idx: number, kind: number) => want.modules.some((m) => m.idx === idx && m.kind === kind);
  const gone = new Set(t.modules.filter((m) => !kept(m.idx, m.kind)).map((m) => m.idx));
  if (gone.size) {
    for (const idx of gone) sink.send(Op.RACK_REMOVE_MODULE, t.slot, idx);
    t.modules = t.modules.filter((m) => !gone.has(m.idx));
    t.cables = t.cables.filter((c) => !gone.has(c.from.m) && !gone.has(c.to.m));
    // The engine cleared their lanes too (RACK_REMOVE_MODULE).
    const lost = (l: AutomationLane) => l.target.kind === 'rack' && gone.has(l.target.module);
    if (t.automation.some(lost)) t.automation = t.automation.filter((l) => !lost(l));
  }
  return want;
}

/** State + REMOVE_TRACK; keys that pointed at it fall back to none (as in the engine). */
function dropTrack(p: Project, sink: CommandSink, t: Track) {
  const id = t.id;
  p.tracks = p.tracks.filter((x) => x.id !== id);
  delete p.mixer.channels[id];
  for (const ch of Object.values(p.mixer.channels)) if (ch.key?.trackId === id) ch.key = null;
  sink.send(Op.REMOVE_TRACK, t.slot);
}

type AnyPattern = DrumPattern | NotePatternState;

/**
 * The pattern table of one track. `edit(live, pj)` returns the commands that
 * turn pattern `live` (null: a new one, its slot empty) into `pj` and updates
 * the state; they are sent with that pattern selected in the engine.
 */
function diffPatterns<PJ extends { engineIdx: number }>(
  p: Project, sink: CommandSink, t: PatternTrack, tj: PatternTrackJson & { patterns: PJ[] },
  make: (pj: PJ) => AnyPattern, edit: (live: AnyPattern | null, made: AnyPattern, pj: PJ) => number[][],
) {
  const slot = t.slot;
  const live: AnyPattern[] = t.patterns;
  const byIdx = new Map(live.map((x) => [x.engineIdx, x]));
  const stateCur = currentPattern(t).engineIdx;
  let engineCur = stateCur;
  // The recorder must close held notes into the old pattern while the engine still plays it.
  if (stateCur !== tj.currentPattern) p.beforePatternSwitch?.(t.id);

  const next: AnyPattern[] = [];
  for (const pj of tj.patterns) {
    const old = byIdx.get(pj.engineIdx) ?? null;
    const pat = old ?? make(pj);
    const cmds = edit(old, pat, pj);
    if (cmds.length && engineCur !== pj.engineIdx) {
      sink.send(Op.SET_CURRENT_PATTERN, slot, pj.engineIdx);
      engineCur = pj.engineIdx;
    }
    for (const c of cmds) sink.send(c[0], c[1], c[2], c[3], c[4]);
    next.push(pat);
  }
  if (t.kind === 'drum') t.patterns = next as DrumPattern[];
  else t.patterns = next as NotePatternState[];
  const patterns: AnyPattern[] = t.patterns; // reactive proxies
  const cur = patterns.find((x) => x.engineIdx === tj.currentPattern)!;
  t.currentPatternId = cur.id;
  if (engineCur !== cur.engineIdx) sink.send(Op.SET_CURRENT_PATTERN, slot, cur.engineIdx);

  diffClips(sink, t, tj.clips);
  for (const x of live) if (!patterns.some((y) => y.engineIdx === x.engineIdx)) sink.send(Op.CLEAR_PATTERN_DATA, slot, x.engineIdx);
}

function diffClips(sink: CommandSink, t: PatternTrack, clips: ClipJson[]) {
  const patterns: AnyPattern[] = t.patterns;
  const byIdx = new Map(t.clips.map((c) => [c.idx, c]));
  const wanted = new Set(clips.map((c) => c.idx));
  for (const c of t.clips) if (!wanted.has(c.idx)) sink.send(Op.CLIP_REMOVE, t.slot * MAX_CLIPS + c.idx);
  const next: Clip[] = [];
  for (const cj of clips) {
    const patternId = patterns.find((x) => x.engineIdx === cj.pattern)!.id;
    let c = byIdx.get(cj.idx);
    const changed = !c || c.patternId !== patternId || c.start !== cj.start || c.len !== cj.len || c.offset !== cj.offset;
    if (!c) c = { id: crypto.randomUUID(), idx: cj.idx, patternId, start: cj.start, len: cj.len, offset: cj.offset };
    else Object.assign(c, { patternId, start: cj.start, len: cj.len, offset: cj.offset });
    next.push(c);
    if (changed) sendClip(sink, t, c);
  }
  t.clips = next;
}

/**
 * An Audio track's clips by idx: removals first, then each new or changed
 * clip (SOURCE, GAIN, SET). A new clip takes the id of a matching clip in
 * `leaving` (removed from it), so a selection survives a cross-lane move.
 */
function diffAudio(sink: CommandSink, t: AudioTrack, tj: AudioTrackJson, leaving: AudioClip[]) {
  const byIdx = new Map(t.clips.map((c) => [c.idx, c]));
  const wanted = new Set(tj.clips.map((c) => c.idx));
  for (const c of t.clips) if (!wanted.has(c.idx)) sink.send(Op.CLIP_REMOVE, t.slot * MAX_CLIPS + c.idx);
  const next: AudioClip[] = [];
  const changed: AudioClip[] = [];
  for (const cj of tj.clips) {
    const fields = {
      sampleId: cj.sample, start: cj.start, len: cj.len, offset: cj.offset, loop: cj.loop,
      gain: cj.gain, fadeIn: cj.fadeIn, fadeOut: cj.fadeOut,
    };
    let c = byIdx.get(cj.idx);
    const same = c && (Object.keys(fields) as (keyof typeof fields)[]).every((k) => c![k] === fields[k]);
    if (!c) {
      const i = leaving.findIndex((x) =>
        x.sampleId === fields.sampleId && x.len === fields.len && x.offset === fields.offset && x.loop === fields.loop &&
        x.gain === fields.gain && x.fadeIn === fields.fadeIn && x.fadeOut === fields.fadeOut);
      const id = i >= 0 ? leaving.splice(i, 1)[0].id : crypto.randomUUID();
      c = { id, idx: cj.idx, ...fields };
    }
    else Object.assign(c, fields);
    next.push(c);
    if (!same) changed.push(c);
  }
  t.clips = next;
  for (const c of t.clips) if (changed.some((x) => x.idx === c.idx)) sendAudioClip(sink, t, c);
}

function diffDrum(p: Project, sink: CommandSink, t: DrumTrack, tj: DrumTrackJson) {
  const slot = t.slot;
  // Rows: append-only in the UI; a row that goes away is reset in the engine.
  while (t.rows.length > tj.rows.length) {
    const i = t.rows.length - 1;
    const r = t.rows.pop()!;
    if (r.sampleId !== null) sink.send(Op.SET_ROW_SAMPLE, slot, i, -1);
    if (r.gain !== 1) sink.send(Op.SET_ROW_GAIN, slot, i, 1);
    if (r.pan !== 0) sink.send(Op.SET_ROW_PAN, slot, i, 0);
    if (r.mute) sink.send(Op.SET_ROW_MUTE, slot, i, 0);
  }
  tj.rows.forEach((rj, i) => {
    let r = t.rows[i];
    if (!r) {
      t.rows.push({ id: crypto.randomUUID(), name: rj.name, sampleId: null, gain: 1, pan: 0, mute: false });
      r = t.rows[i];
    }
    r.name = rj.name;
    if (r.sampleId !== rj.sample) sink.send(Op.SET_ROW_SAMPLE, slot, i, rj.sample ?? -1);
    if (r.gain !== rj.gain) sink.send(Op.SET_ROW_GAIN, slot, i, rj.gain);
    if (r.pan !== rj.pan) sink.send(Op.SET_ROW_PAN, slot, i, rj.pan);
    if (r.mute !== rj.mute) sink.send(Op.SET_ROW_MUTE, slot, i, rj.mute ? 1 : 0);
    Object.assign(r, { sampleId: rj.sample, gain: rj.gain, pan: rj.pan, mute: rj.mute });
  });

  diffPatterns(p, sink, t, tj,
    (pj) => makeDrumPattern(pj.engineIdx, pj.name, pj.stepCount, pj.swing),
    (old, made, pj) => {
      const pat = made as DrumPattern;
      const out: number[][] = [];
      pat.name = pj.name;
      if (!old || pat.stepCount !== pj.stepCount) out.push([Op.SET_STEP_COUNT, slot, pj.stepCount]);
      if (!old || pat.swing !== pj.swing) out.push([Op.SET_SWING, slot, pj.swing]);
      pat.stepCount = pj.stepCount;
      pat.swing = pj.swing;
      const hits = new Map(pj.hits.map(([r, s, v]) => [r * MAX_STEPS + s, v]));
      for (let r = 0; r < MAX_ROWS; r++) {
        for (let s = 0; s < MAX_STEPS; s++) {
          const v = hits.get(r * MAX_STEPS + s) ?? 0;
          if (pat.steps[r][s] === v) continue;
          pat.steps[r][s] = v;
          out.push([Op.SET_STEP, slot, r, s, v]);
        }
      }
      return out;
    });
}

function diffSynth(p: Project, sink: CommandSink, t: SynthTrack, tj: SynthTrackJson) {
  const slot = t.slot;
  diffPatterns(p, sink, t, tj,
    (pj) => makeNotePattern(pj.engineIdx, pj.name, pj.bars),
    (old, made, pj) => {
      const pat = made as NotePatternState;
      const out: number[][] = [];
      pat.name = pj.name;
      if (!old || pat.bars !== pj.bars) out.push([Op.SET_PATTERN_BARS, slot, pj.bars]);
      pat.bars = pj.bars;
      const byIdx = new Map(pat.notes.map((n) => [n.idx, n]));
      const wanted = new Set(pj.notes.map((n) => n.idx));
      for (const n of pat.notes) if (!wanted.has(n.idx)) out.push([Op.NOTE_REMOVE, slot * MAX_NOTES + n.idx]);
      const sink2 = { send: (op: number, a = 0, b = 0, c = 0, d = 0) => (out.push([op, a, b, c, d]), true) };
      pat.notes = pj.notes.map((nj) => {
        const n = byIdx.get(nj.idx);
        if (n && n.pitch === nj.pitch && n.vel === nj.vel && n.start === nj.start && n.len === nj.len) return n;
        const next = n ? Object.assign(n, nj) : { id: crypto.randomUUID(), ...nj };
        sendNote(sink2, t, next);
        return next;
      });
      return out;
    });

  // Rack: modules by idx (a different kind there is a remove + add), params, cables by input.
  // (Removals already went out for every track: removeModules in step 1.)
  const want = removeModules(sink, t, tj);
  t.patchName = tj.patch.name;
  const cables = t.cables;
  t.modules = want.modules.map((wm) => {
    const m = t.modules.find((x) => x.idx === wm.idx);
    if (!m) {
      sink.send(Op.RACK_ADD_MODULE, slot, wm.idx, wm.kind);
      const defs = moduleDef(wm.kind).params;
      wm.params.forEach((v, i) => v !== defs[i].default && sink.send(Op.RACK_SET_PARAM, slot, wm.idx, i, v));
      return wm.pos ? { idx: wm.idx, kind: wm.kind, params: [...wm.params], pos: { ...wm.pos } }
        : { idx: wm.idx, kind: wm.kind, params: [...wm.params] };
    }
    wm.params.forEach((v, i) => {
      if (m.params[i] !== v) sink.send(Op.RACK_SET_PARAM, slot, m.idx, i, v);
    });
    m.params = [...wm.params];
    // Layout only: no engine command.
    if (wm.pos) m.pos = { ...wm.pos };
    else delete m.pos;
    return m;
  });
  const into = (c: { to: { m: number; port: number } }) => packPort(c.to.m, c.to.port);
  const wantBy = new Map(want.cables.map((c) => [into(c), c]));
  for (const c of cables) if (!wantBy.has(into(c))) sink.send(Op.RACK_DISCONNECT, slot, into(c));
  for (const c of want.cables) {
    const l = cables.find((x) => into(x) === into(c));
    if (!l || l.from.m !== c.from.m || l.from.port !== c.from.port) {
      sink.send(Op.RACK_CONNECT, slot, packPort(c.from.m, c.from.port), into(c));
    }
  }
  t.cables = want.cables;
}

/** One lane as the engine holds it: who owns it ("slot:<n>" or a Master row channel), its target (JSON form), enable, points by idx. */
interface EngineLane {
  owner: string;
  target: string;
  enabled: boolean;
  points: Map<number, PointTuple>;
}

const trackOwner = (slot: number) => `slot:${slot}`;

/** The live project's lanes by engine lane. */
function liveLanes(p: Project): Map<number, EngineLane> {
  const out = new Map<number, EngineLane>();
  const add = (owner: string, l: AutomationLane) =>
    out.set(l.lane, { owner, target: JSON.stringify(laneJson(l).target), enabled: l.enabled, points: pointMap(l) });
  for (const t of p.tracks) for (const l of t.automation) add(trackOwner(t.slot), l);
  for (const x of p.mixer.automation) add(x.channel, x.lane);
  return out;
}

/** Step 3b (see the top). `order`: the live tracks, now matching `to.tracks`. */
function diffLanes(p: Project, sink: CommandSink, engine: Map<number, EngineLane>, to: ProjectJson, order: Track[]) {
  const send = (c: readonly (number | undefined)[]) => sink.send(c[0]!, c[1], c[2], c[3], c[4]);
  type Want = { owner: string; channel: number; patch: SynthTrackJson['patch'] | null; lj: LaneJson };
  const want = new Map<number, Want>();
  for (const tj of to.tracks) {
    for (const lj of tj.automation) want.set(lj.lane, { owner: trackOwner(tj.slot), channel: tj.slot, patch: tj.kind === 'synth' ? tj.patch : null, lj });
  }
  for (const mj of to.mixer.automation) {
    want.set(mj.lane, { owner: mj.channel, channel: MASTER_CHANNEL_INDEX[mj.channel], patch: null, lj: mj });
  }
  // Clear first...
  for (const [i, e] of engine) {
    const w = want.get(i);
    if (!w || w.owner !== e.owner || JSON.stringify(w.lj.target) !== e.target) {
      sink.send(Op.AUTO_LANE_CLEAR, i);
      engine.delete(i);
    }
  }
  // ...then re-target, and edit the kept lanes.
  for (const [i, w] of want) {
    const e = engine.get(i);
    if (!e) {
      for (const c of laneCommands(w.lj, w.channel, w.patch)) send(c);
      continue;
    }
    for (const c of pointCommands(i, e.points, new Map(w.lj.points.map((pt, idx) => [idx, pt])))) send(c);
    if (e.enabled !== w.lj.enabled) sink.send(Op.AUTO_LANE_ENABLE, i, w.lj.enabled ? 1 : 0);
  }

  // The state: each owner's lanes as in `to`, reusing the UI ids of lanes
  // kept on their engine lane and target, and of their points (reusePoints).
  const reuse = (old: AutomationLane[], lanes: LaneJson[]): AutomationLane[] | null => {
    if (same(old.map(laneJson), lanes)) return null; // unchanged: leave the state alone
    const fresh = lanesState(lanes);
    return fresh.map((l) => {
      const o = old.find((x) => x.lane === l.lane && JSON.stringify(laneJson(x).target) === JSON.stringify(laneJson(l).target));
      if (!o) return l;
      o.enabled = l.enabled;
      o.points = reusePoints(o.points, l.points);
      return o;
    });
  };
  const bySlot = new Map(to.tracks.map((tj) => [tj.slot, tj]));
  for (const t of order) {
    const next = reuse(t.automation, bySlot.get(t.slot)!.automation);
    if (next) t.automation = next;
  }
  const masterOld = p.mixer.automation;
  const oldOf = (ch: MasterChannel) => masterOld.filter((x) => x.channel === ch).map((x) => x.lane);
  if (!same(masterOld.map((x) => ({ channel: x.channel, ...laneJson(x.lane) })), to.mixer.automation)) {
    const lanes: { channel: MasterChannel; lane: AutomationLane }[] = [];
    for (const ch of ['reverb', 'delay', 'master'] as const) {
      const mine = to.mixer.automation.filter((mj) => mj.channel === ch);
      const got = reuse(oldOf(ch), mine) ?? oldOf(ch);
      mine.forEach((mj, k) => lanes.push({ channel: ch, lane: got[k] }));
    }
    // Keep `to`'s order across channels.
    p.mixer.automation = to.mixer.automation.map((mj) => lanes.find((x) => x.lane.lane === mj.lane)!);
  }
}

/**
 * `fresh` (a lane's wanted points) with the UI objects (ids) of `old` where
 * they are the same point, so a selection by id stays on the right point.
 * First by TICK (a tick is a point's identity within a lane: a delete
 * compacts idx, so a kept point may come back at another idx); then, for
 * the rest, by idx: an old point whose own tick is not in `fresh` (so it
 * was not matched by tick) takes the wanted point at its idx (a point moved
 * in place). Each old object is used at most once.
 */
function reusePoints<P extends { idx: number; tick: number; value: number; hold: boolean; curve: number }>(old: P[], fresh: P[]): P[] {
  const byTick = new Map(old.map((x) => [x.tick, x]));
  const byIdx = new Map(old.map((x) => [x.idx, x]));
  const used = new Set<P>();
  const pick = fresh.map((x) => {
    const o = byTick.get(x.tick);
    if (o) used.add(o);
    return o ?? null;
  });
  return fresh.map((x, i) => {
    let o = pick[i];
    if (!o) {
      const c = byIdx.get(x.idx);
      if (c && !used.has(c)) {
        used.add(c);
        o = c;
      }
    }
    return o ? Object.assign(o, { idx: x.idx, tick: x.tick, value: x.value, hold: x.hold, curve: x.curve }) : x;
  });
}
