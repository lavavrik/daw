// Test helper (not a test): a model of the engine state a command stream
// builds -- tracks, patterns, rows, racks, clips, audio clips (staged and
// committed), mixer, keys, automation lanes (targets validated, unique ticks,
// cleared with their target), transport --
// following engine.rs's command semantics. history tests replay "load A,
// edit, diffApply back" through it and compare with "load A": the same
// engine state means undo restored everything the engine plays.
import { moduleDef } from '../audio/catalog';
import { defaultMixParams } from '../audio/mixerCatalog';
import { MAX_AUTO_LANES, MAX_AUTO_POINTS, MAX_CLIPS, MAX_NOTES, MAX_PATTERNS, MAX_SONG_TICKS, MAX_RETURNS, MIX_CHANNELS, MIX_RETURN0, Op, PORT_STRIDE } from '../audio/protocol';
import { MIX_PARAMS } from '../audio/mixerCatalog';
import { MAX_ROWS, MAX_TRACKS } from '../state/project.svelte';
import type { ProjectJson } from '../project/schema';

interface Pat {
  steps: Record<string, number>;
  stepCount: number;
  swing: number;
  bars: number;
  notes: Record<number, number[]>;
}
interface Slot {
  kind: 'drum' | 'synth' | 'audio';
  current: number;
  patterns: Pat[];
  rows: { sample: number; gain: number; pan: number; mute: number }[];
  modules: Record<number, { kind: number; params: number[] }>;
  cables: Record<number, number>;
  clips: Record<number, number[]>;
  /** Audio clips as committed by AUDIO_CLIP_SET: [sample, offset, loop, gain, fadeIn, fadeOut, start, len]. */
  audio: Record<number, number[]>;
  /** Per clip slot: what SOURCE and GAIN staged ([sample, offset, loop] and [gain, fadeIn, fadeOut]; null: not yet). */
  staged: Record<number, { source: number[] | null; gain: number[] | null }>;
}
/** An automation lane: target [kind 1 mix / 2 rack, channel or slot, param id or module*16+param]; points by idx. */
export interface AutoLane {
  target: number[];
  enabled: number;
  points: Record<number, number[]>;
}
export interface EngineModel {
  slots: (Slot | null)[];
  /** MAX_AUTO_LANES lanes; null: no target (cleared). */
  autos: (AutoLane | null)[];
  mixer: number[][];
  keys: number[];
  tempo: number;
  /** The song key (SET_KEY, plan 26): [root, scale index]; A minor after RESET_ALL. */
  songKey: number[];
  metronome: number;
  mode: number;
  loop: number[];
  input: number;
  /** Commands the engine would refuse (wrong slot kind, missing module, …). */
  errors: string[];
}

const pat = (): Pat => ({ steps: {}, stepCount: 16, swing: 0, bars: 4, notes: {} });
const fresh = (kind: Slot['kind']): Slot => ({
  kind,
  current: 0,
  patterns: Array.from({ length: MAX_PATTERNS }, pat),
  rows: Array.from({ length: MAX_ROWS }, () => ({ sample: -1, gain: 1, pan: 0, mute: 0 })),
  modules: {},
  cables: {},
  clips: {},
  audio: {},
  staged: {},
});

export function blankModel(): EngineModel {
  return {
    slots: new Array(MAX_TRACKS).fill(null),
    autos: new Array(MAX_AUTO_LANES).fill(null),
    mixer: Array.from({ length: MIX_CHANNELS }, defaultMixParams),
    keys: new Array(MAX_TRACKS).fill(-1),
    tempo: 124, songKey: [9, 1], metronome: 0, mode: 0, loop: [0, 0], input: -1, errors: [],
  };
}

type Cmd = readonly (number | undefined)[] | { op: number; args: number[] };

/** Apply commands (EngineCommand tuples or fake-engine log entries) to `m`. */
export function run(m: EngineModel, cmds: Cmd[]): EngineModel {
  for (const c of cmds) {
    const [op = 0, a = 0, b = 0, cc = 0, d = 0] = 'op' in c ? [c.op, ...c.args] : c;
    const bad = (why: string) => m.errors.push(`op ${op} [${a},${b},${cc},${d}]: ${why}`);
    const slotOf = (s: number, kind?: Slot['kind']) => {
      const t = m.slots[s];
      if (!t || (kind && t.kind !== kind)) {
        bad(`slot ${s} is ${t?.kind ?? 'empty'}`);
        return null;
      }
      return t;
    };
    const cur = (t: Slot) => t.patterns[t.current];
    /** Clear the lanes whose target matches (the engine's lifecycle clears). */
    const clearAutos = (f: (t: number[]) => boolean) => {
      for (let i = 0; i < MAX_AUTO_LANES; i++) if (m.autos[i] && f(m.autos[i]!.target)) m.autos[i] = null;
    };
    /** The range of an automation target, or null (with an error) when the engine would refuse it. */
    const autoRange = (kind: number, ch: number, id: number): { min: number; max: number } | null => {
      if (kind === 1) {
        const def = MIX_PARAMS[id];
        const k = ch < MAX_TRACKS ? 'track' : ch < MIX_RETURN0 + MAX_RETURNS ? 'return' : 'master';
        const ok = def && !def.integer && def.appliesTo.includes(k); // reverb/delay params apply to every return
        if (!ok || ch < 0 || ch >= MIX_CHANNELS || (ch < MAX_TRACKS && !m.slots[ch])) return null;
        return def;
      }
      const mod = kind === 2 ? slotOf(ch, 'synth')?.modules[Math.floor(id / PORT_STRIDE)] : undefined;
      const def = mod ? moduleDef(mod.kind).params[id % PORT_STRIDE] : undefined;
      return def && !def.integer ? def : null;
    };
    const unslot = (s: number) => {
      m.mixer[s] = defaultMixParams();
      m.keys[s] = -1;
      for (let i = 0; i < MAX_TRACKS; i++) if (m.keys[i] >= 0 && Math.floor(m.keys[i] / 32) === s) m.keys[i] = -1;
    };
    switch (op) {
      case Op.RESET_ALL: Object.assign(m, blankModel(), { errors: m.errors }); break;
      case Op.AUTO_LANE_SET: {
        if (!Number.isInteger(a) || a < 0 || a >= MAX_AUTO_LANES) { bad('lane index'); break; }
        const range = autoRange(b, cc, d);
        if (!range) { bad('target missing or not automatable'); break; }
        if (m.autos.some((l, i) => i !== a && l && l.target.join() === [b, cc, d].join())) { bad('a second lane on one target'); break; }
        const old = m.autos[a]?.target.length ? m.autos[a] : null;
        const enabled = m.autos[a]?.enabled ?? 1;
        if (old && Object.values(old.points).some((p) => p[1] < range.min || p[1] > range.max)) { bad('a point out of the new range'); break; }
        m.autos[a] = { target: [b, cc, d], enabled, points: old?.points ?? {} };
        break;
      }
      case Op.AUTO_POINT_SET: {
        const l = m.autos[Math.floor(a / MAX_AUTO_POINTS)];
        const idx = a % MAX_AUTO_POINTS;
        if (!l || !l.target.length) { bad('point on a lane without a target'); break; }
        const [kind, ch, id] = l.target;
        const range = autoRange(kind, ch, id);
        if (!range || !(cc >= range.min && cc <= range.max)) { bad('point value out of range'); break; }
        if (!Number.isInteger(b) || b < 0 || b > MAX_SONG_TICKS || (d !== 0 && d !== 1)) { bad('point tick or shape'); break; }
        if (Object.entries(l.points).some(([i, p]) => Number(i) !== idx && p[0] === b)) { bad(`tick ${b} is taken`); break; }
        l.points[idx] = [b, cc, d];
        break;
      }
      // Plan 16: the curve of an active point, -1..1; stored as the point's
      // 4th element only when it is not 0 (the PointTuple form). SET (above)
      // stores [tick, value, hold]: it resets the curve, as the engine does.
      case Op.AUTO_POINT_CURVE: {
        const l = m.autos[Math.floor(a / MAX_AUTO_POINTS)];
        const pt = l && Number.isInteger(a) && a >= 0 ? l.points[a % MAX_AUTO_POINTS] : undefined;
        if (!pt) { bad('curve on an inactive point'); break; }
        if (!(b >= -1 && b <= 1)) { bad('curve out of range'); break; }
        pt.length = 3;
        if (b !== 0) pt.push(b);
        break;
      }
      case Op.AUTO_POINT_REMOVE: { const l = m.autos[Math.floor(a / MAX_AUTO_POINTS)]; if (l) delete l.points[a % MAX_AUTO_POINTS]; break; }
      case Op.AUTO_LANE_CLEAR: m.autos[a] = null; break;
      // A cleared lane is enabled; ENABLE on it sticks until the next SET (an empty target here).
      case Op.AUTO_LANE_ENABLE: { const l = m.autos[a]; if (l) l.enabled = b; else m.autos[a] = { target: [], enabled: b, points: {} }; break; }
      case Op.AUTO_OVERRIDE: break;
      case Op.SET_TEMPO: m.tempo = a; break;
      case Op.SET_KEY:
        if (!Number.isInteger(a) || a < 0 || a > 11 || !Number.isInteger(b) || b < 0 || b > 7) bad('key');
        else m.songKey = [a, b];
        break;
      case Op.SET_METRONOME: m.metronome = a; break;
      case Op.SET_MODE: m.mode = a; break;
      case Op.SET_LOOP: m.loop = [a, b]; break;
      case Op.SET_INPUT_TRACK: m.input = a; break;
      case Op.ADD_DRUM_TRACK: case Op.ADD_SYNTH_TRACK: case Op.ADD_AUDIO_TRACK: {
        // A synth's or drum track's live input goes when its slot becomes
        // another kind (re-adding the same kind keeps it).
        const kind = op === Op.ADD_DRUM_TRACK ? 'drum' : op === Op.ADD_SYNTH_TRACK ? 'synth' : 'audio';
        const old = m.slots[a]?.kind;
        if (m.input === a && (old === 'synth' || old === 'drum') && old !== kind) m.input = -1;
        m.slots[a] = fresh(kind);
        unslot(a);
        clearAutos((t) => t[1] === a);
        break;
      }
      case Op.AUDIO_CLIP_SOURCE: case Op.AUDIO_CLIP_GAIN: {
        const t = slotOf(Math.floor(a / MAX_CLIPS), 'audio');
        if (!t) break;
        const s = (t.staged[a % MAX_CLIPS] ??= { source: null, gain: null });
        if (op === Op.AUDIO_CLIP_SOURCE) s.source = [b, cc, d];
        else s.gain = [b, cc, d];
        break;
      }
      case Op.AUDIO_CLIP_SET: {
        const t = slotOf(Math.floor(a / MAX_CLIPS), 'audio');
        if (!t) break;
        // The engine would commit its defaults; every sender stages both first.
        const s = t.staged[a % MAX_CLIPS];
        if (!s?.source || !s.gain) bad('audio clip committed before its SOURCE and GAIN');
        else if (s.gain[1] + s.gain[2] > cc) bad('fades longer than the clip');
        else t.audio[a % MAX_CLIPS] = [...s.source, ...s.gain, b, cc];
        break;
      }
      case Op.REMOVE_TRACK:
        m.slots[a] = null;
        if (m.input === a) m.input = -1;
        unslot(a);
        clearAutos((t) => t[1] === a);
        break;
      case Op.SET_ROW_SAMPLE: case Op.SET_ROW_GAIN: case Op.SET_ROW_PAN: case Op.SET_ROW_MUTE: {
        const t = slotOf(a, 'drum');
        if (!t) break;
        const key = ({ [Op.SET_ROW_SAMPLE]: 'sample', [Op.SET_ROW_GAIN]: 'gain', [Op.SET_ROW_PAN]: 'pan', [Op.SET_ROW_MUTE]: 'mute' } as const)[op];
        t.rows[b][key] = cc;
        break;
      }
      // Plan 21: rows, every pattern's steps and the row keys shift together
      // (engine.rs RemoveRow / InsertRow, mixer row_removed / row_inserted).
      case Op.REMOVE_ROW: case Op.INSERT_ROW: {
        const t = slotOf(a, 'drum');
        if (!t) break;
        const ins = op === Op.INSERT_ROW;
        /** Where row r goes (null: gone). */
        const move = (r: number) => (r === b ? (ins ? b + 1 : null) : r < b ? r : ins ? r + 1 : r - 1);
        const empty = { sample: -1, gain: 1, pan: 0, mute: 0 };
        const rows = Array.from({ length: MAX_ROWS }, () => ({ ...empty }));
        t.rows.forEach((row, r) => {
          const to = move(r);
          if (to !== null && to < MAX_ROWS) rows[to] = row;
        });
        t.rows = rows;
        for (const x of t.patterns) {
          const steps: Record<string, number> = {};
          for (const [k, v] of Object.entries(x.steps)) {
            const [r, s] = k.split(':').map(Number);
            const to = move(r);
            if (to !== null && to < MAX_ROWS) steps[`${to}:${s}`] = v;
          }
          x.steps = steps;
        }
        for (let i = 0; i < MAX_TRACKS; i++) {
          const k = m.keys[i];
          if (k < 0 || Math.floor(k / 32) !== a || k % 32 === 0) continue;
          const to = move((k % 32) - 1);
          m.keys[i] = to === null || to >= MAX_ROWS ? -1 : a * 32 + to + 1;
        }
        break;
      }
      case Op.SET_STEP: {
        const t = slotOf(a, 'drum');
        if (!t) break;
        if (d > 0) cur(t).steps[`${b}:${cc}`] = d;
        else delete cur(t).steps[`${b}:${cc}`];
        break;
      }
      case Op.SET_STEP_COUNT: { const t = slotOf(a, 'drum'); if (t) cur(t).stepCount = b; break; }
      case Op.SET_SWING: { const t = slotOf(a, 'drum'); if (t) cur(t).swing = b; break; }
      case Op.SET_PATTERN_BARS: { const t = slotOf(a, 'synth'); if (t) cur(t).bars = b; break; }
      case Op.SET_CURRENT_PATTERN: {
        const t = slotOf(a);
        if (t?.kind === 'audio') bad('Audio tracks have no patterns');
        else if (t) t.current = b;
        break;
      }
      case Op.COPY_PATTERN: {
        const t = slotOf(a);
        if (t && b !== cc) t.patterns[cc] = structuredClone(t.patterns[b]);
        break;
      }
      case Op.CLEAR_PATTERN_DATA: {
        const t = slotOf(a);
        if (t) Object.assign(t.patterns[b], { steps: {}, notes: {} });
        break;
      }
      case Op.NOTE_SET: { const t = slotOf(Math.floor(a / MAX_NOTES), 'synth'); if (t) cur(t).notes[a % MAX_NOTES] = [b, cc, d]; break; }
      case Op.NOTE_REMOVE: {
        const t = slotOf(Math.floor(a / MAX_NOTES), 'synth');
        if (!t) break;
        if (!(a % MAX_NOTES in cur(t).notes)) bad('no such note');
        delete cur(t).notes[a % MAX_NOTES];
        break;
      }
      case Op.NOTE_CLEAR: { const t = slotOf(a, 'synth'); if (t) cur(t).notes = {}; break; }
      case Op.CLIP_SET: {
        const t = slotOf(Math.floor(a / MAX_CLIPS));
        if (t?.kind === 'audio') bad('pattern clip on an Audio track');
        else if (t) t.clips[a % MAX_CLIPS] = [b, cc, d];
        break;
      }
      case Op.CLIP_REMOVE: {
        const t = slotOf(Math.floor(a / MAX_CLIPS));
        // Removes a pattern clip or an audio clip, and resets that slot's staged audio edit.
        if (t) for (const k of ['clips', 'audio', 'staged'] as const) delete t[k][a % MAX_CLIPS];
        break;
      }
      case Op.CLIP_CLEAR: { const t = slotOf(a); if (t) Object.assign(t, { clips: {}, audio: {}, staged: {} }); break; }
      case Op.RACK_CLEAR: {
        const t = slotOf(a, 'synth');
        if (t) Object.assign(t, { modules: {}, cables: {} });
        clearAutos((x) => x[0] === 2 && x[1] === a);
        break;
      }
      case Op.RACK_ADD_MODULE: {
        const t = slotOf(a, 'synth');
        if (!t) break;
        if (b in t.modules) bad('module idx taken');
        t.modules[b] = { kind: cc, params: moduleDef(cc).params.map((p) => p.default) };
        break;
      }
      case Op.RACK_REMOVE_MODULE: {
        const t = slotOf(a, 'synth');
        if (!t) break;
        if (!(b in t.modules)) bad('no such module');
        delete t.modules[b];
        clearAutos((x) => x[0] === 2 && x[1] === a && Math.floor(x[2] / PORT_STRIDE) === b);
        for (const [to, from] of Object.entries(t.cables)) {
          if (Math.floor(Number(to) / PORT_STRIDE) === b || Math.floor(from / PORT_STRIDE) === b) delete t.cables[Number(to)];
        }
        break;
      }
      case Op.RACK_SET_PARAM: {
        const t = slotOf(a, 'synth');
        if (!t) break;
        if (!(b in t.modules)) bad('no such module');
        else t.modules[b].params[cc] = d;
        break;
      }
      case Op.RACK_CONNECT: {
        const t = slotOf(a, 'synth');
        if (!t) break;
        if (!(Math.floor(b / PORT_STRIDE) in t.modules) || !(Math.floor(cc / PORT_STRIDE) in t.modules)) bad('cable to a missing module');
        t.cables[cc] = b;
        break;
      }
      case Op.RACK_DISCONNECT: { const t = slotOf(a, 'synth'); if (t) delete t.cables[b]; break; }
      case Op.MIX_SET: m.mixer[a][b] = cc; break;
      case Op.MIX_SET_KEY: slotOf(a); m.keys[a] = b; break;
      case Op.PLAY: case Op.STOP: case Op.SEEK: case Op.NOTE_ON: case Op.NOTE_OFF: case Op.SET_PATTERN_FOCUS: break;
      default: bad('unexpected op');
    }
  }
  return m;
}

/**
 * What must match between two engines holding project `json`: every slot,
 * and for the patterns `json` uses, data and lengths; unused pattern slots
 * only need to be empty (their lengths are rewritten when one is reused).
 */
export function view(m: EngineModel, json: ProjectJson) {
  const slots = m.slots.map((t, s) => {
    if (!t) return null;
    if (t.kind === 'audio') return { kind: t.kind, audio: t.audio };
    const tj = json.tracks.find((x) => x.slot === s);
    const used = new Set(tj && tj.kind !== 'audio' ? tj.patterns.map((x) => x.engineIdx) : []);
    const patterns = t.patterns.map((x, i) =>
      used.has(i)
        ? t.kind === 'drum' ? { steps: x.steps, stepCount: x.stepCount, swing: x.swing } : { notes: x.notes, bars: x.bars }
        : { empty: Object.keys(x.steps).length + Object.keys(x.notes).length === 0 },
    );
    return t.kind === 'drum'
      ? { kind: t.kind, current: t.current, patterns, rows: t.rows, clips: t.clips }
      : { kind: t.kind, current: t.current, patterns, modules: t.modules, cables: t.cables, clips: t.clips };
  });
  const autos = m.autos.map((l) => (l && (l.target.length || l.enabled !== 1) ? l : null));
  return { slots, autos, mixer: m.mixer, keys: m.keys, tempo: m.tempo, songKey: m.songKey, metronome: m.metronome, mode: m.mode, loop: m.loop, input: m.input };
}
