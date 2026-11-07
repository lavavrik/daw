// Test helpers shared by the project tests (not a test file itself): a fixture
// project built through the real actions, a recording fake engine, a fake
// decoder, and a small model of the engine's command validation
// (engine/src/protocol.rs `decode` ranges + the track/module existence checks
// in engine.rs) used to check that a load never sends an invalid command.
import { moduleDef, paramIndex } from '../audio/catalog';
import {
  BAR_TICKS, MAX_CLIPS, MAX_MODULES, MAX_NOTES, MAX_PATTERN_BARS, MAX_PATTERNS, MAX_SONG_TICKS, MIX_CHANNELS,
  MIX_DELAY, MIX_REVERB, Op, PORT_STRIDE,
} from '../audio/protocol';
import { MIX_PARAMS } from '../audio/mixerCatalog';
import { addDrumTrack, addRow, selectTrack, setMetronome, setRowGain, setRowMute, setRowPan, setRowSample, setStep, setStepCount, setSwing, setTempo } from '../state/actions';
import { setMix, setSidechain } from '../state/mixer-actions';
import { addNote, newPattern, selectPattern, setPatternBars } from '../state/pattern-actions';
import { addModule, addSynthTrack, connect, setParam } from '../state/rack-actions';
import { addClip, setLoop, setMode } from '../state/song-actions';
import { STARTER_PATCHES } from '../state/patches';
import { sampleFile } from '../state/sampleFiles';
import { MAX_ROWS, MAX_SAMPLES, MAX_STEPS, MAX_TRACKS, Project } from '../state/project.svelte';
import type { DrumTrack, SynthTrack } from '../state/project.svelte';
import type { LoadEngine, SampleDecoder } from './load';

export const nullSink = { send: () => true };

/** Bytes standing in for an audio file; the fake decoder reads byte 0 as the length in frames. */
export const fakeAudio = (frames: number): ArrayBuffer => new Uint8Array([frames, 1, 2, 3]).buffer;

/**
 * Drums (2 patterns, samples, row gain/pan/mute), a synth with a modified
 * patch (+ a Reverb and a SamplePlayer), notes in 2 patterns, clips, mixer
 * params on strips and returns, two sidechain keys, loop + Song mode.
 */
export async function buildFixture(): Promise<{ p: Project; drums: DrumTrack; synth: SynthTrack; synth2: SynthTrack }> {
  const p = new Project();
  const s = nullSink;
  p.name = 'Fixture';
  const drums = addDrumTrack(p, s)!;
  // Samples 0 and 1 on rows 0/1; id 2 is used only by the SamplePlayer.
  for (const [id, name] of [[0, 'kick'], [1, 'snare'], [2, 'vox']] as const) {
    p.sampleFiles.set(id, await sampleFile(`${name}.wav`, 'audio/wav', fakeAudio(10 + id)));
  }
  p.nextSampleId = 3;
  setRowSample(p, s, drums.id, drums.rows[0].id, 0, 'kick');
  setRowSample(p, s, drums.id, drums.rows[1].id, 1, 'snare');
  setRowGain(p, s, drums.id, drums.rows[1].id, 0.5);
  setRowPan(p, s, drums.id, drums.rows[1].id, -0.25);
  setRowMute(p, s, drums.id, drums.rows[2].id, true);
  addRow(p, s, drums.id);
  for (const st of [0, 4, 8, 12]) setStep(p, s, drums.id, drums.rows[0].id, st, 100);
  setStep(p, s, drums.id, drums.rows[1].id, 4, 60);
  setSwing(p, s, drums.id, 0.2);
  const pat2 = newPattern(p, s, drums.id)!;
  setStepCount(p, s, drums.id, 32);
  setStep(p, s, drums.id, drums.rows[4].id, 31, 127);
  selectPattern(p, s, drums.id, drums.patterns[0].id);

  const synth = addSynthTrack(p, s, 'Bass', STARTER_PATCHES[0])!;
  setParam(p, s, synth.id, 4, paramIndex(moduleDef('filter'), 'cutoff'), 1234);
  const rev = addModule(p, s, synth.id, 'reverb')!;
  setParam(p, s, synth.id, rev, paramIndex(moduleDef('reverb'), 'size'), 0.9);
  connect(p, s, synth.id, { m: 6, port: 0 }, { m: rev, port: 0 });
  const sp = addModule(p, s, synth.id, 'sample_player')!;
  setParam(p, s, synth.id, sp, paramIndex(moduleDef('sample_player'), 'sample'), 2);
  addNote(p, s, synth.id, { pitch: 36, start: 0, len: 480, vel: 110 });
  addNote(p, s, synth.id, { pitch: 43, start: 960, len: 240 });
  const n2 = newPattern(p, s, synth.id)!;
  setPatternBars(p, s, synth.id, 2);
  addNote(p, s, synth.id, { pitch: 48, start: 3840, len: 3840 });
  // Pattern 2 stays current on the synth.

  const synth2 = addSynthTrack(p, s, 'Keys', STARTER_PATCHES[1])!;

  addClip(p, s, drums.id, { start: 0, patternId: drums.patterns[0].id });
  addClip(p, s, drums.id, { start: 3840, len: 7680, patternId: pat2.id, offset: 240 });
  addClip(p, s, synth.id, { start: 0, patternId: n2.id });

  setMix(p, s, drums.id, 'fader', -3);
  setMix(p, s, drums.id, 'send_a', -10);
  setMix(p, s, synth.id, 'comp_on', 1);
  setMix(p, s, synth.id, 'pan', 0.3);
  setMix(p, s, 'reverb', 'rev_size', 0.8);
  setMix(p, s, 'delay', 'delay_time', 3);
  setMix(p, s, 'master', 'limiter_ceiling', -1);
  setSidechain(p, s, synth.id, { trackId: drums.id, row: 0 });
  setSidechain(p, s, synth2.id, { trackId: synth.id, row: null });

  setTempo(p, s, 132.5);
  setMetronome(p, s, true);
  setLoop(p, s, { on: true, start: BAR_TICKS, end: 5 * BAR_TICKS });
  setMode(p, s, 'song');
  selectTrack(p, s, synth.id);
  selectTrack(p, s, drums.id); // keys stay on the synth
  return { p, drums, synth, synth2 };
}

export type LogEntry = { op: number; args: number[] } | { sample: number };

/**
 * A fake engine recording every command and sample upload in one log.
 * `holdReset`: resetAll() stays pending until `ack()` is called.
 */
export function fakeEngine(o: { holdReset?: boolean; sampleCode?: (id: number) => number; audioRunning?: boolean } = {}) {
  const log: LogEntry[] = [];
  let release: ((code: number) => void) | null = null;
  let resetSent!: () => void;
  const resetCalled = new Promise<void>((r) => (resetSent = r));
  const engine: LoadEngine & { log: LogEntry[]; ack: (code?: number) => void; untilReset: (timeoutMs?: number) => Promise<void> } = {
    log,
    sampleRate: 48000,
    send(op: number, a = 0, b = 0, c = 0, d = 0) {
      log.push({ op, args: [a, b, c, d] });
      return true;
    },
    resetAll() {
      engine.send(Op.RESET_ALL);
      resetSent();
      if (!o.holdReset) return Promise.resolve(0);
      return new Promise<number>((r) => (release = r));
    },
    ensureRunning: async () => o.audioRunning ?? true,
    loadSample(id: number) {
      log.push({ sample: id });
      return Promise.resolve(o.sampleCode ? o.sampleCode(id) : 0);
    },
    ack(code = 0) {
      release?.(code);
    },
    /**
     * Resolves once a load has sent RESET_ALL (after its async decode, hash
     * and ensureRunning steps): wait on this, never on a fixed number of
     * ticks. Rejects after `timeoutMs`.
     */
    untilReset(timeoutMs = 2000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('RESET_ALL was never sent')), timeoutMs)));
      return Promise.race([resetCalled, timeout]).finally(() => clearTimeout(timer));
    },
  };
  return engine;
}

/** Decodes fakeAudio bytes (byte 0 = frames); an empty buffer fails like a bad file. */
export const fakeDecoder: SampleDecoder = {
  async decodeAudioData(buf: ArrayBuffer) {
    const b = new Uint8Array(buf);
    if (b.length === 0) throw new Error('decode');
    const frames = b[0];
    return {
      length: frames,
      numberOfChannels: 1,
      sampleRate: 48000,
      getChannelData: () => new Float32Array(frames).fill(0.5),
    } as unknown as AudioBuffer;
  },
};

/** What the engine model ends up with (for the transport reconcile test). */
export interface ModelState {
  tempo: number;
  metronome: boolean;
  song: boolean;
  loop: [number, number];
  input: number;
  kinds: ('empty' | 'drum' | 'synth')[];
}

/**
 * Replays `log` against a model of the engine's checks. Returns the first
 * problem per command (with its index) and the final transport state. Rules
 * beyond the per-op ranges: RESET_ALL only while stopped; slot-addressed ops
 * need a track of the right kind; rack ops need the modules/ports; a row's
 * sample must be uploaded first; MIX_SET_KEY sources must exist; and once a
 * key was sent no track/mixer-param command may follow (keys last).
 */
export function checkLog(log: LogEntry[]): { errors: string[]; state: ModelState } {
  const errors: string[] = [];
  const fresh = (): ModelState => ({
    tempo: 124, metronome: false, song: false, loop: [0, 0], input: -1, kinds: new Array(MAX_TRACKS).fill('empty'),
  });
  let st = fresh();
  let playing = false;
  let samples = new Set<number>();
  let racks = new Map<number, Map<number, number>>(); // slot -> idx -> kind
  let keysSent = false;
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  const inR = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
  log.forEach((e, i) => {
    const bad = (why: string) => errors.push(`#${i} ${'op' in e ? `op ${e.op} [${e.args}]` : `sample ${e.sample}`}: ${why}`);
    if ('sample' in e) {
      if (!int(e.sample, 0, MAX_SAMPLES - 1)) bad('sample id');
      samples.add(e.sample);
      return;
    }
    const [a, b, c, d] = e.args;
    const kind = (slot: number) => (int(slot, 0, MAX_TRACKS - 1) ? st.kinds[slot] : 'bad');
    const need = (slot: number, k: 'drum' | 'synth' | 'any') => {
      const have = kind(slot);
      if (have === 'bad' || have === 'empty' || (k !== 'any' && have !== k)) bad(`slot ${slot} is ${have}, need ${k}`);
    };
    const afterKeys = () => keysSent && bad('sent after a sidechain key (keys must be last)');
    switch (e.op) {
      case Op.STOP: playing = false; break;
      case Op.PLAY: playing = true; break;
      case Op.RESET_ALL:
        if (playing) bad('RESET_ALL while playing');
        st = fresh(); samples = new Set(); racks = new Map(); keysSent = false;
        break;
      case Op.SET_TEMPO: if (!inR(a, 20, 300)) bad('tempo'); else st.tempo = a; break;
      case Op.SET_METRONOME: if (a !== 0 && a !== 1) bad('flag'); else st.metronome = a === 1; break;
      case Op.SET_MODE: if (a !== 0 && a !== 1) bad('flag'); else st.song = a === 1; break;
      case Op.SET_LOOP:
        if (!int(a, 0, MAX_SONG_TICKS) || !int(b, 0, MAX_SONG_TICKS)) bad('loop');
        else st.loop = b > a ? [a, b] : [0, 0];
        break;
      case Op.SEEK: if (!int(a, 0, MAX_SONG_TICKS)) bad('seek'); break;
      case Op.SET_INPUT_TRACK: if (a !== -1) need(a, 'synth'); st.input = a; break;
      case Op.ADD_DRUM_TRACK: case Op.ADD_SYNTH_TRACK:
        afterKeys();
        if (!int(a, 0, MAX_TRACKS - 1)) bad('slot');
        else { st.kinds[a] = e.op === Op.ADD_DRUM_TRACK ? 'drum' : 'synth'; racks.set(a, new Map()); }
        break;
      case Op.SET_ROW_SAMPLE:
        need(a, 'drum'); if (!int(b, 0, MAX_ROWS - 1)) bad('row');
        if (c !== -1 && !samples.has(c)) bad(`sample ${c} not uploaded`);
        break;
      case Op.SET_ROW_GAIN: need(a, 'drum'); if (!int(b, 0, MAX_ROWS - 1) || !inR(c, 0, 2)) bad('gain'); break;
      case Op.SET_ROW_PAN: need(a, 'drum'); if (!int(b, 0, MAX_ROWS - 1) || !inR(c, -1, 1)) bad('pan'); break;
      case Op.SET_ROW_MUTE: need(a, 'drum'); if (!int(b, 0, MAX_ROWS - 1) || (c !== 0 && c !== 1)) bad('mute'); break;
      case Op.SET_STEP:
        afterKeys(); need(a, 'drum');
        if (!int(b, 0, MAX_ROWS - 1) || !int(c, 0, MAX_STEPS - 1) || !int(d, 0, 127)) bad('step');
        break;
      case Op.SET_STEP_COUNT: need(a, 'drum'); if (![16, 32, 64].includes(b)) bad('count'); break;
      case Op.SET_SWING: need(a, 'drum'); if (!inR(b, 0, 1)) bad('swing'); break;
      case Op.SET_CURRENT_PATTERN: need(a, 'any'); if (!int(b, 0, MAX_PATTERNS - 1)) bad('pattern'); break;
      case Op.SET_PATTERN_BARS: need(a, 'synth'); if (!int(b, 1, MAX_PATTERN_BARS)) bad('bars'); break;
      case Op.NOTE_SET: {
        const slot = Math.floor(a / MAX_NOTES);
        need(slot, 'synth');
        const pitch = Math.floor(b / 128), vel = b % 128;
        if (!int(a % MAX_NOTES, 0, MAX_NOTES - 1) || !int(pitch, 0, 127) || !int(vel, 1, 127)) bad('note');
        if (!int(c, 0, MAX_PATTERN_BARS * BAR_TICKS - 1) || !int(d, 1, 61440)) bad('note time');
        break;
      }
      case Op.CLIP_SET: {
        afterKeys();
        need(Math.floor(a / MAX_CLIPS), 'any');
        const off = Math.floor(b / 16), pat = b % 16;
        if (!int(a % MAX_CLIPS, 0, MAX_CLIPS - 1) || !int(off, 0, 61439) || !int(pat, 0, MAX_PATTERNS - 1)) bad('clip');
        if (!int(c, 0, MAX_SONG_TICKS) || !int(d, 1, MAX_SONG_TICKS) || c + d > MAX_SONG_TICKS) bad('clip time');
        break;
      }
      case Op.RACK_CLEAR: need(a, 'synth'); racks.set(a, new Map()); break;
      case Op.RACK_ADD_MODULE:
        afterKeys(); need(a, 'synth');
        if (!int(b, 0, MAX_MODULES - 1)) bad('module idx');
        try { moduleDef(c); racks.get(a)?.set(b, c); } catch { bad('unknown kind'); }
        break;
      case Op.RACK_SET_PARAM: {
        need(a, 'synth');
        const k = racks.get(a)?.get(b);
        if (k === undefined) { bad('no such module'); break; }
        const pd = moduleDef(k).params[c];
        if (!pd || !inR(d, pd.min, pd.max) || (pd.integer && !Number.isInteger(d))) bad('param value');
        break;
      }
      case Op.RACK_CONNECT: {
        need(a, 'synth');
        const fm = racks.get(a)?.get(Math.floor(b / PORT_STRIDE));
        const tm = racks.get(a)?.get(Math.floor(c / PORT_STRIDE));
        if (fm === undefined || tm === undefined) { bad('cable to a missing module'); break; }
        if (b % PORT_STRIDE >= moduleDef(fm).outputs.length || c % PORT_STRIDE >= moduleDef(tm).inputs.length) bad('port');
        break;
      }
      case Op.MIX_SET: {
        afterKeys();
        const def = MIX_PARAMS[b];
        if (!int(a, 0, MIX_CHANNELS - 1) || !def) { bad('mix index'); break; }
        if (a < MAX_TRACKS) need(a, 'any');
        const ok = def.group === 'reverb' ? a === MIX_REVERB : def.group === 'delay' ? a === MIX_DELAY
          : def.appliesTo.includes(a < MAX_TRACKS ? 'track' : a === MIX_REVERB || a === MIX_DELAY ? 'return' : 'master');
        if (!ok) bad(`${def.name} not on channel ${a}`);
        if (!inR(c, def.min, def.max)) bad('mix value');
        break;
      }
      case Op.MIX_SET_KEY:
        keysSent = true;
        need(a, 'any');
        if (b !== -1) {
          const slot = Math.floor(b / 32), row = b % 32;
          need(slot, row === 0 ? 'any' : 'drum');
          if (row > MAX_ROWS) bad('key row');
        }
        break;
      default:
        bad('unexpected op during a load');
    }
  });
  return { errors, state: st };
}
