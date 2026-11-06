// Every user edit: mutate Project AND send the matching engine command.
import { Op } from '../audio/protocol';
import { MAX_ROWS, MAX_STEPS, MAX_TRACKS, TRACK_COLORS } from './project.svelte';
import type { DrumRow, DrumTrack, Project } from './project.svelte';

/** AudioEngine satisfies this structurally; tests use a recording fake. */
export interface CommandSink {
  send(op: number, a?: number, b?: number, c?: number, d?: number): boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function makeRow(n: number): DrumRow {
  return {
    id: crypto.randomUUID(),
    name: `Row ${n}`,
    sampleId: null,
    gain: 1,
    pan: 0,
    mute: false,
    steps: new Array<number>(MAX_STEPS).fill(0),
  };
}

function find(p: Project, trackId: string, rowId: string) {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const row = track.rows.findIndex((r) => r.id === rowId);
  return row < 0 ? null : { track, row, r: track.rows[row] };
}

/** Returns null when all MAX_TRACKS slots are taken. */
export function addDrumTrack(p: Project, sink: CommandSink, name = 'Drums'): DrumTrack | null {
  const used = new Set(p.tracks.map((t) => t.slot));
  let slot = 0;
  while (slot < MAX_TRACKS && used.has(slot)) slot++;
  if (slot >= MAX_TRACKS) return null;
  p.tracks.push({
    id: crypto.randomUUID(),
    slot,
    name,
    color: TRACK_COLORS[slot % TRACK_COLORS.length],
    stepCount: 16,
    swing: 0,
    rows: [1, 2, 3, 4].map(makeRow),
  });
  const track = p.tracks[p.tracks.length - 1]; // reactive proxy
  p.selectedTrackId = track.id;
  sink.send(Op.ADD_DRUM_TRACK, slot);
  return track;
}

/** No engine command: all engine rows already exist (empty). */
export function addRow(p: Project, _sink: CommandSink, trackId: string): DrumRow | null {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track || track.rows.length >= MAX_ROWS) return null;
  track.rows.push(makeRow(track.rows.length + 1));
  return track.rows[track.rows.length - 1];
}

export function setStep(p: Project, sink: CommandSink, trackId: string, rowId: string, step: number, velocity: number) {
  const f = find(p, trackId, rowId);
  if (!f || Number.isNaN(velocity) || !Number.isInteger(step) || step < 0 || step >= MAX_STEPS) return;
  const v = Math.round(clamp(velocity, 0, 127));
  f.r.steps[step] = v;
  sink.send(Op.SET_STEP, f.track.slot, f.row, step, v);
}

export function toggleStep(p: Project, sink: CommandSink, trackId: string, rowId: string, step: number) {
  const f = find(p, trackId, rowId);
  if (!f) return;
  setStep(p, sink, trackId, rowId, step, f.r.steps[step] > 0 ? 0 : 100);
}

export function setRowSample(p: Project, sink: CommandSink, trackId: string, rowId: string, sampleId: number | null, name: string) {
  const f = find(p, trackId, rowId);
  if (!f) return;
  f.r.sampleId = sampleId;
  f.r.name = name;
  sink.send(Op.SET_ROW_SAMPLE, f.track.slot, f.row, sampleId ?? -1);
}

export function setRowGain(p: Project, sink: CommandSink, trackId: string, rowId: string, gain: number) {
  const f = find(p, trackId, rowId);
  if (!f || Number.isNaN(gain)) return;
  f.r.gain = clamp(gain, 0, 2);
  sink.send(Op.SET_ROW_GAIN, f.track.slot, f.row, f.r.gain);
}

export function setRowPan(p: Project, sink: CommandSink, trackId: string, rowId: string, pan: number) {
  const f = find(p, trackId, rowId);
  if (!f || Number.isNaN(pan)) return;
  f.r.pan = clamp(pan, -1, 1);
  sink.send(Op.SET_ROW_PAN, f.track.slot, f.row, f.r.pan);
}

export function setRowMute(p: Project, sink: CommandSink, trackId: string, rowId: string, mute: boolean) {
  const f = find(p, trackId, rowId);
  if (!f) return;
  f.r.mute = mute;
  sink.send(Op.SET_ROW_MUTE, f.track.slot, f.row, mute ? 1 : 0);
}

export function setStepCount(p: Project, sink: CommandSink, trackId: string, n: 16 | 32 | 64) {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track || (n !== 16 && n !== 32 && n !== 64)) return;
  track.stepCount = n;
  sink.send(Op.SET_STEP_COUNT, track.slot, n);
}

export function setSwing(p: Project, sink: CommandSink, trackId: string, s: number) {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track || Number.isNaN(s)) return;
  track.swing = clamp(s, 0, 1);
  sink.send(Op.SET_SWING, track.slot, track.swing);
}

export function setTempo(p: Project, sink: CommandSink, bpm: number) {
  if (Number.isNaN(bpm)) return;
  p.tempo = Math.round(clamp(bpm, 20, 300) * 10) / 10;
  sink.send(Op.SET_TEMPO, p.tempo);
}

export function setMetronome(p: Project, sink: CommandSink, on: boolean) {
  p.metronome = on;
  sink.send(Op.SET_METRONOME, on ? 1 : 0);
}

export function play(p: Project, sink: CommandSink) {
  p.playing = true;
  sink.send(Op.PLAY);
}

export function stop(p: Project, sink: CommandSink) {
  p.playing = false;
  sink.send(Op.STOP);
}

export function togglePlay(p: Project, sink: CommandSink) {
  if (p.playing) stop(p, sink);
  else play(p, sink);
}
