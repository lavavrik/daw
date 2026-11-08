// Test helpers shared by the project tests (not a test file itself): a fixture
// project built through the real actions, a recording fake engine, a fake
// decoder, and a small model of the engine's command validation
// (engine/src/protocol.rs `decode` ranges + the track/module existence checks
// in engine.rs) used to check that a load never sends an invalid command.
import { moduleDef, paramIndex } from '../audio/catalog';
import {
  BAR_TICKS, MAX_AUTO_LANES, MAX_AUTO_POINTS, MAX_CLIPS, MAX_CLIP_GAIN, MAX_MODULES, MAX_NOTES, MAX_PATTERN_BARS, MAX_PATTERNS,
  MAX_SAMPLE_FLOATS, MAX_SONG_TICKS, MIX_CHANNELS, MIX_DELAY, MIX_REVERB, Op, PORT_STRIDE,
} from '../audio/protocol';
import { addLane, addPoint, setLaneEnabled } from '../state/automation-actions';
import { MIX_PARAMS } from '../audio/mixerCatalog';
import { addDrumTrack, addRow, selectTrack, setMetronome, setRowGain, setRowMute, setRowPan, setRowSample, setStep, setStepCount, setSwing, setTempo } from '../state/actions';
import { setMix, setSidechain } from '../state/mixer-actions';
import { addNote, newPattern, selectPattern, setPatternBars } from '../state/pattern-actions';
import { addModule, addSynthTrack, connect, setParam } from '../state/rack-actions';
import { addClip, setLoop, setMode } from '../state/song-actions';
import { addAudioClip, addAudioTrack, setAudioClip, trimAudioClipStart } from '../state/audio-actions';
import { STARTER_PATCHES } from '../state/patches';
import { sampleFile } from '../state/sampleFiles';
import { MAX_ROWS, MAX_SAMPLES, MAX_STEPS, MAX_TRACKS, Project } from '../state/project.svelte';
import type { AudioTrack, DrumTrack, SynthTrack } from '../state/project.svelte';
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

/**
 * Two Audio tracks on `p` (plan 9): "Loop" with a loop clip of a mono
 * sample (-3 dB) plus a clip whose sample is missing (sample null), and
 * "Vox" with a trimmed and faded clip of a stereo sample (+3 dB) whose strip
 * is sidechained from "Loop" (compressor on). Samples get the next two ids
 * (fakeAudio bytes; `sampleMeta` says 0.5 s mono and 1 s stereo, which is
 * what export_audio.txt generates for them). Song mode.
 */
export async function addAudioFixture(p: Project): Promise<{ loop: AudioTrack; vox: AudioTrack; ids: [number, number] }> {
  const s = nullSink;
  const ids: [number, number] = [p.nextSampleId, p.nextSampleId + 1];
  p.sampleFiles.set(ids[0], await sampleFile('loop.wav', 'audio/wav', fakeAudio(30)));
  p.sampleFiles.set(ids[1], await sampleFile('vox.wav', 'audio/wav', fakeAudio(31)));
  p.sampleMeta.set(ids[0], { seconds: 0.5, channels: 1, peaks: null });
  p.sampleMeta.set(ids[1], { seconds: 1, channels: 2, peaks: null });
  p.nextSampleId += 2;
  const loop = addAudioTrack(p, s, { name: 'Loop' })!;
  addAudioClip(p, s, loop.id, { sampleId: ids[0], start: 0, len: 2 * BAR_TICKS, loop: true, gain: -3 });
  addAudioClip(p, s, loop.id, { sampleId: null, start: 3 * BAR_TICKS, len: BAR_TICKS });
  const vox = addAudioTrack(p, s, { name: 'Vox' })!;
  const vc = addAudioClip(p, s, vox.id, { sampleId: ids[1], start: BAR_TICKS / 2 })!;
  trimAudioClipStart(p, s, vc.id, vc.start + BAR_TICKS / 8); // 0.25 s into the file at 120 BPM
  setAudioClip(p, s, vc.id, { gain: 3, fadeIn: 240, fadeOut: 480 });
  setMix(p, s, vox.id, 'comp_on', 1);
  setMix(p, s, vox.id, 'fader', -2);
  setSidechain(p, s, vox.id, { trackId: loop.id, row: null });
  setMode(p, s, 'song');
  return { loop, vox, ids };
}

/** A project of just the two addAudioFixture tracks at 120 BPM (the export_audio.txt source). */
export async function buildAudioFixture() {
  const p = new Project();
  p.name = 'Audio fixture';
  setTempo(p, nullSink, 120);
  return { p, ...(await addAudioFixture(p)) };
}

/**
 * Automation lanes on a project that has a "Drums" and a "Bass" track
 * (buildFixture, buildAutoFixture; Bass's rack has its filter at module 4):
 * a send build-up on the drums (send A -60 -> 0 dB over two bars), a fader
 * ride with a hold drop on Bass (-24 dB up to 0 dB over a bar, held, then
 * -inf from bar 2.5), a filter-cutoff sweep on Bass's rack (200 Hz -> 8 kHz
 * over two bars) and a disabled Master-row limiter-ceiling lane (0 -> -3 dB).
 */
export function addAutomationFixture(p: Project) {
  const s = nullSink;
  const drums = p.tracks.find((t) => t.name === 'Drums')!;
  const bass = p.tracks.find((t) => t.name === 'Bass')!;
  const send = addLane(p, s, drums.id, { kind: 'mix', param: 'send_a' })!;
  addPoint(p, s, send.id, { tick: 0, value: -60 });
  addPoint(p, s, send.id, { tick: 2 * BAR_TICKS, value: 0 });
  const fader = addLane(p, s, bass.id, { kind: 'mix', param: 'fader' })!;
  addPoint(p, s, fader.id, { tick: 0, value: -24 });
  addPoint(p, s, fader.id, { tick: BAR_TICKS, value: 0, hold: true });
  addPoint(p, s, fader.id, { tick: 1.5 * BAR_TICKS, value: -60 });
  const cutoff = addLane(p, s, bass.id, { kind: 'rack', module: 4, param: 'cutoff' })!;
  addPoint(p, s, cutoff.id, { tick: 0, value: 200 });
  addPoint(p, s, cutoff.id, { tick: 2 * BAR_TICKS, value: 8000 });
  const ceiling = addLane(p, s, 'master', { kind: 'mix', param: 'limiter_ceiling' })!;
  addPoint(p, s, ceiling.id, { tick: 0, value: 0 });
  addPoint(p, s, ceiling.id, { tick: 2 * BAR_TICKS, value: -3 });
  setLaneEnabled(p, s, ceiling.id, false);
  return { send, fader, cutoff, ceiling };
}

/**
 * The export_auto.txt source: "Drums" (a kick on every beat of a sample 0.25 s
 * long, clips over 3 bars) and "Bass" (STARTER_PATCHES[0], a note per beat,
 * clips over 3 bars) at 128 BPM in Song mode, with addAutomationFixture's
 * lanes and the Master-row lane enabled (all five play in the render).
 */
export async function buildAutoFixture() {
  const p = new Project();
  const s = nullSink;
  p.name = 'Automation fixture';
  setTempo(p, s, 128);
  const ids: [number] = [0];
  p.sampleFiles.set(0, await sampleFile('kick.wav', 'audio/wav', fakeAudio(40)));
  p.nextSampleId = 1;
  const drums = addDrumTrack(p, s)!;
  setRowSample(p, s, drums.id, drums.rows[0].id, 0, 'kick');
  for (const st of [0, 4, 8, 12]) setStep(p, s, drums.id, drums.rows[0].id, st, 110);
  const bass = addSynthTrack(p, s, 'Bass', STARTER_PATCHES[0])!;
  setPatternBars(p, s, bass.id, 1);
  for (let b = 0; b < 4; b++) addNote(p, s, bass.id, { pitch: 36 + 7 * (b % 2), start: b * 960, len: 720, vel: 100 });
  for (let bar = 0; bar < 3; bar++) {
    addClip(p, s, drums.id, { start: bar * BAR_TICKS, patternId: drums.patterns[0].id });
    addClip(p, s, bass.id, { start: bar * BAR_TICKS, patternId: bass.patterns[0].id });
  }
  const lanes = addAutomationFixture(p);
  setLaneEnabled(p, s, lanes.ceiling.id, true);
  setMode(p, s, 'song');
  return { p, ids, drums, bass, lanes };
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
  kinds: ('empty' | 'drum' | 'synth' | 'audio')[];
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
  /** Automation lanes: their target (as sent), range and points' ticks by idx. */
  let lanes = new Map<number, { target: string; min: number; max: number; ticks: Map<number, number> }>();
  let autoSent = false;
  /** Staged audio-clip gain/fades per address (SOURCE/GAIN stage, SET commits). */
  let staged = new Map<number, { source: boolean; fades: number }>();
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
    /** 'pattern': drum or synth (an Audio track has no patterns). */
    const need = (slot: number, k: 'drum' | 'synth' | 'audio' | 'pattern' | 'any') => {
      const have = kind(slot);
      const ok = k === 'any' || have === k || (k === 'pattern' && (have === 'drum' || have === 'synth'));
      if (have === 'bad' || have === 'empty' || !ok) bad(`slot ${slot} is ${have}, need ${k}`);
    };
    const afterKeys = () => {
      if (keysSent) bad('sent after a sidechain key (keys must be last)');
      if (autoSent) bad('sent after an automation lane (lanes go after the tracks, mixer and keys)');
    };
    /** Range of an automation target as AUTO_LANE_SET names it (null: the engine refuses it). */
    const autoRange = (kind: number, ch: number, id: number): { min: number; max: number } | null => {
      if (kind === 1) {
        const def = MIX_PARAMS[id];
        if (!def || def.integer || !int(ch, 0, MIX_CHANNELS - 1)) return null;
        if (ch < MAX_TRACKS && (kind === 1 && st.kinds[ch] === 'empty')) return null;
        const ok = def.group === 'reverb' ? ch === MIX_REVERB : def.group === 'delay' ? ch === MIX_DELAY
          : def.appliesTo.includes(ch < MAX_TRACKS ? 'track' : ch === MIX_REVERB || ch === MIX_DELAY ? 'return' : 'master');
        return ok ? def : null;
      }
      if (kind !== 2 || kind === 2 && st.kinds[ch] !== 'synth') return null;
      const mk = racks.get(ch)?.get(Math.floor(id / PORT_STRIDE));
      const pd = mk === undefined ? undefined : moduleDef(mk).params[id % PORT_STRIDE];
      return pd && !pd.integer ? pd : null;
    };
    switch (e.op) {
      case Op.STOP: playing = false; break;
      case Op.PLAY: playing = true; break;
      case Op.RESET_ALL:
        if (playing) bad('RESET_ALL while playing');
        st = fresh(); samples = new Set(); racks = new Map(); keysSent = false; staged = new Map();
        lanes = new Map(); autoSent = false;
        break;
      case Op.AUTO_LANE_SET: {
        autoSent = true;
        if (!int(a, 0, MAX_AUTO_LANES - 1)) { bad('lane'); break; }
        const range = autoRange(b, c, d);
        const target = `${b}:${c}:${d}`;
        if (!range) bad('lane target missing or not automatable');
        else if ([...lanes].some(([l, x]) => l !== a && x.target === target)) bad('a second lane on one target');
        else lanes.set(a, { target, ...range, ticks: lanes.get(a)?.ticks ?? new Map() });
        break;
      }
      case Op.AUTO_POINT_SET: {
        const l = lanes.get(Math.floor(a / MAX_AUTO_POINTS));
        const idx = a % MAX_AUTO_POINTS;
        if (!l) { bad('point on a lane without a target'); break; }
        if (!int(b, 0, MAX_SONG_TICKS) || !inR(c, l.min, l.max) || (d !== 0 && d !== 1)) bad('point');
        else if ([...l.ticks].some(([i, t]) => i !== idx && t === b)) bad(`tick ${b} is taken`);
        else l.ticks.set(idx, b);
        break;
      }
      // Plan 16: a curve -1..1 on an active point (the engine refuses anything else).
      case Op.AUTO_POINT_CURVE: {
        const l = lanes.get(Math.floor(a / MAX_AUTO_POINTS));
        if (!int(a, 0, MAX_AUTO_LANES * MAX_AUTO_POINTS - 1) || !l?.ticks.has(a % MAX_AUTO_POINTS)) bad('curve on an inactive point');
        else if (!inR(b, -1, 1)) bad('curve');
        break;
      }
      case Op.AUTO_POINT_REMOVE: lanes.get(Math.floor(a / MAX_AUTO_POINTS))?.ticks.delete(a % MAX_AUTO_POINTS); break;
      case Op.AUTO_LANE_CLEAR: lanes.delete(a); break;
      case Op.AUTO_LANE_ENABLE: if (!int(a, 0, MAX_AUTO_LANES - 1) || (b !== 0 && b !== 1)) bad('lane enable'); break;
      case Op.SET_TEMPO: if (!inR(a, 20, 300)) bad('tempo'); else st.tempo = a; break;
      case Op.SET_METRONOME: if (a !== 0 && a !== 1) bad('flag'); else st.metronome = a === 1; break;
      case Op.SET_MODE: if (a !== 0 && a !== 1) bad('flag'); else st.song = a === 1; break;
      case Op.SET_LOOP:
        if (!int(a, 0, MAX_SONG_TICKS) || !int(b, 0, MAX_SONG_TICKS)) bad('loop');
        else st.loop = b > a ? [a, b] : [0, 0];
        break;
      case Op.SEEK: if (!int(a, 0, MAX_SONG_TICKS)) bad('seek'); break;
      // A synth or (plan 15) drum track, or -1.
      case Op.SET_INPUT_TRACK: if (a !== -1) need(a, 'pattern'); st.input = a; break;
      case Op.ADD_DRUM_TRACK: case Op.ADD_SYNTH_TRACK: case Op.ADD_AUDIO_TRACK:
        afterKeys();
        if (!int(a, 0, MAX_TRACKS - 1)) bad('slot');
        else {
          st.kinds[a] = e.op === Op.ADD_DRUM_TRACK ? 'drum' : e.op === Op.ADD_SYNTH_TRACK ? 'synth' : 'audio';
          racks.set(a, new Map());
          for (const k of staged.keys()) if (Math.floor(k / MAX_CLIPS) === a) staged.delete(k);
        }
        break;
      // Audio clips: SOURCE + GAIN stage, SET commits; a source must name an
      // uploaded sample (or -1), and the staged fades must fit the clip.
      case Op.AUDIO_CLIP_SOURCE:
        afterKeys(); need(Math.floor(a / MAX_CLIPS), 'audio');
        if (b !== -1 && !samples.has(b)) bad(`sample ${b} not uploaded`);
        if (!inR(c, 0, MAX_SAMPLE_FLOATS / 8000) || (d !== 0 && d !== 1)) bad('audio clip source');
        staged.set(a, { source: true, fades: staged.get(a)?.fades ?? -1 });
        break;
      case Op.AUDIO_CLIP_GAIN:
        afterKeys(); need(Math.floor(a / MAX_CLIPS), 'audio');
        if (!inR(b, 0, MAX_CLIP_GAIN) || !int(c, 0, MAX_SONG_TICKS) || !int(d, 0, MAX_SONG_TICKS)) bad('audio clip gain');
        staged.set(a, { source: staged.get(a)?.source ?? false, fades: c + d });
        break;
      case Op.AUDIO_CLIP_SET: {
        afterKeys(); need(Math.floor(a / MAX_CLIPS), 'audio');
        if (!int(b, 0, MAX_SONG_TICKS) || !int(c, 1, MAX_SONG_TICKS) || b + c > MAX_SONG_TICKS) bad('audio clip time');
        const g = staged.get(a);
        if (!g?.source || g.fades < 0) bad('audio clip committed before its SOURCE and GAIN');
        else if (g.fades > c) bad('audio clip fades longer than the clip');
        break;
      }
      case Op.CLIP_REMOVE: need(Math.floor(a / MAX_CLIPS), 'any'); staged.delete(a); break;
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
      case Op.SET_CURRENT_PATTERN: need(a, 'pattern'); if (!int(b, 0, MAX_PATTERNS - 1)) bad('pattern'); break;
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
        need(Math.floor(a / MAX_CLIPS), 'pattern');
        const off = Math.floor(b / 16), pat = b % 16;
        if (!int(a % MAX_CLIPS, 0, MAX_CLIPS - 1) || !int(off, 0, 61439) || !int(pat, 0, MAX_PATTERNS - 1)) bad('clip');
        if (!int(c, 0, MAX_SONG_TICKS) || !int(d, 1, MAX_SONG_TICKS) || c + d > MAX_SONG_TICKS) bad('clip time');
        break;
      }
      case Op.RACK_CLEAR: need(a, 'synth'); racks.set(a, new Map()); break; // (a load clears before any lane)
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
        if (autoSent) bad('sidechain key after an automation lane');
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
