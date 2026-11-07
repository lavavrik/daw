// Test helper (not a test): a model of the engine state a command stream
// builds -- tracks, patterns, rows, racks, clips, mixer, keys, transport --
// following engine.rs's command semantics. history tests replay "load A,
// edit, diffApply back" through it and compare with "load A": the same
// engine state means undo restored everything the engine plays.
import { moduleDef } from '../audio/catalog';
import { defaultMixParams } from '../audio/mixerCatalog';
import { MAX_CLIPS, MAX_NOTES, MAX_PATTERNS, MIX_CHANNELS, Op, PORT_STRIDE } from '../audio/protocol';
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
  kind: 'drum' | 'synth';
  current: number;
  patterns: Pat[];
  rows: { sample: number; gain: number; pan: number; mute: number }[];
  modules: Record<number, { kind: number; params: number[] }>;
  cables: Record<number, number>;
  clips: Record<number, number[]>;
}
export interface EngineModel {
  slots: (Slot | null)[];
  mixer: number[][];
  keys: number[];
  tempo: number;
  metronome: number;
  mode: number;
  loop: number[];
  input: number;
  /** Commands the engine would refuse (wrong slot kind, missing module, …). */
  errors: string[];
}

const pat = (): Pat => ({ steps: {}, stepCount: 16, swing: 0, bars: 4, notes: {} });
const fresh = (kind: 'drum' | 'synth'): Slot => ({
  kind,
  current: 0,
  patterns: Array.from({ length: MAX_PATTERNS }, pat),
  rows: Array.from({ length: MAX_ROWS }, () => ({ sample: -1, gain: 1, pan: 0, mute: 0 })),
  modules: {},
  cables: {},
  clips: {},
});

export function blankModel(): EngineModel {
  return {
    slots: new Array(MAX_TRACKS).fill(null),
    mixer: Array.from({ length: MIX_CHANNELS }, defaultMixParams),
    keys: new Array(MAX_TRACKS).fill(-1),
    tempo: 124, metronome: 0, mode: 0, loop: [0, 0], input: -1, errors: [],
  };
}

type Cmd = readonly (number | undefined)[] | { op: number; args: number[] };

/** Apply commands (EngineCommand tuples or fake-engine log entries) to `m`. */
export function run(m: EngineModel, cmds: Cmd[]): EngineModel {
  for (const c of cmds) {
    const [op = 0, a = 0, b = 0, cc = 0, d = 0] = 'op' in c ? [c.op, ...c.args] : c;
    const bad = (why: string) => m.errors.push(`op ${op} [${a},${b},${cc},${d}]: ${why}`);
    const slotOf = (s: number, kind?: 'drum' | 'synth') => {
      const t = m.slots[s];
      if (!t || (kind && t.kind !== kind)) {
        bad(`slot ${s} is ${t?.kind ?? 'empty'}`);
        return null;
      }
      return t;
    };
    const cur = (t: Slot) => t.patterns[t.current];
    const unslot = (s: number) => {
      m.mixer[s] = defaultMixParams();
      m.keys[s] = -1;
      for (let i = 0; i < MAX_TRACKS; i++) if (m.keys[i] >= 0 && Math.floor(m.keys[i] / 32) === s) m.keys[i] = -1;
    };
    switch (op) {
      case Op.RESET_ALL: Object.assign(m, blankModel(), { errors: m.errors }); break;
      case Op.SET_TEMPO: m.tempo = a; break;
      case Op.SET_METRONOME: m.metronome = a; break;
      case Op.SET_MODE: m.mode = a; break;
      case Op.SET_LOOP: m.loop = [a, b]; break;
      case Op.SET_INPUT_TRACK: m.input = a; break;
      case Op.ADD_DRUM_TRACK: case Op.ADD_SYNTH_TRACK:
        if (op === Op.ADD_DRUM_TRACK && m.input === a) m.input = -1;
        m.slots[a] = fresh(op === Op.ADD_DRUM_TRACK ? 'drum' : 'synth');
        unslot(a);
        break;
      case Op.REMOVE_TRACK:
        m.slots[a] = null;
        if (m.input === a) m.input = -1;
        unslot(a);
        break;
      case Op.SET_ROW_SAMPLE: case Op.SET_ROW_GAIN: case Op.SET_ROW_PAN: case Op.SET_ROW_MUTE: {
        const t = slotOf(a, 'drum');
        if (!t) break;
        const key = ({ [Op.SET_ROW_SAMPLE]: 'sample', [Op.SET_ROW_GAIN]: 'gain', [Op.SET_ROW_PAN]: 'pan', [Op.SET_ROW_MUTE]: 'mute' } as const)[op];
        t.rows[b][key] = cc;
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
      case Op.SET_CURRENT_PATTERN: { const t = slotOf(a); if (t) t.current = b; break; }
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
      case Op.CLIP_SET: { const t = slotOf(Math.floor(a / MAX_CLIPS)); if (t) t.clips[a % MAX_CLIPS] = [b, cc, d]; break; }
      case Op.CLIP_REMOVE: { const t = slotOf(Math.floor(a / MAX_CLIPS)); if (t) delete t.clips[a % MAX_CLIPS]; break; }
      case Op.CLIP_CLEAR: { const t = slotOf(a); if (t) t.clips = {}; break; }
      case Op.RACK_CLEAR: { const t = slotOf(a, 'synth'); if (t) Object.assign(t, { modules: {}, cables: {} }); break; }
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
      case Op.PLAY: case Op.STOP: case Op.SEEK: case Op.NOTE_ON: case Op.NOTE_OFF: break;
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
    const used = new Set(json.tracks.find((x) => x.slot === s)?.patterns.map((x) => x.engineIdx) ?? []);
    const patterns = t.patterns.map((x, i) =>
      used.has(i)
        ? t.kind === 'drum' ? { steps: x.steps, stepCount: x.stepCount, swing: x.swing } : { notes: x.notes, bars: x.bars }
        : { empty: Object.keys(x.steps).length + Object.keys(x.notes).length === 0 },
    );
    return t.kind === 'drum'
      ? { kind: t.kind, current: t.current, patterns, rows: t.rows, clips: t.clips }
      : { kind: t.kind, current: t.current, patterns, modules: t.modules, cables: t.cables, clips: t.clips };
  });
  return { slots, mixer: m.mixer, keys: m.keys, tempo: m.tempo, metronome: m.metronome, mode: m.mode, loop: m.loop, input: m.input };
}
