// Every user edit: mutate Project AND send the matching engine command.
// Each exported edit runs its body inside edit() (state/edits.ts): one undo
// step, nested calls included (docs/architecture/history.md). Same in
// pattern-, song-, audio-, mixer- and rack-actions.ts.
import { BAR_TICKS, Op } from '../audio/protocol';
import { MAX_ROWS, MAX_STEPS, MAX_TRACKS, TRACK_COLORS, currentPattern, newChannel } from './project.svelte';
import type { DrumRow, DrumTrack, Project, SynthTrack } from './project.svelte';
import { makeDrumPattern } from './pattern-actions';
import { edit, markEdited } from './edits';

/** AudioEngine satisfies this structurally; tests use a recording fake. */
export interface CommandSink {
  send(op: number, a?: number, b?: number, c?: number, d?: number): boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function makeRow(name: string): DrumRow {
  return {
    id: crypto.randomUUID(),
    name,
    sampleId: null,
    gain: 1,
    pan: 0,
    mute: false,
  };
}

function find(p: Project, trackId: string, rowId: string) {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track || track.kind !== 'drum') return null;
  const row = track.rows.findIndex((r) => r.id === rowId);
  return row < 0 ? null : { track, row, r: track.rows[row] };
}

/** First unused "Base", "Base 2", "Base 3"… so the list and the "Keys →" pill stay unambiguous. */
export function uniqueTrackName(p: Project, base: string): string {
  const names = new Set(p.tracks.map((t) => t.name));
  let n = 1;
  while (names.has(n === 1 ? base : `${base} ${n}`)) n++;
  return n === 1 ? base : `${base} ${n}`;
}

/**
 * Returns null when all MAX_TRACKS slots are taken. `rowNames`: the rows it
 * starts with, empty (the default kit's names for a fresh session's track,
 * state/defaultKit.ts; at most MAX_ROWS).
 */
export function addDrumTrack(
  p: Project, sink: CommandSink, name = uniqueTrackName(p, 'Drums'), rowNames = ['Row 1', 'Row 2', 'Row 3', 'Row 4'],
): DrumTrack | null {
  return edit(p, 'Add drum track', () => {
    const used = new Set(p.tracks.map((t) => t.slot));
    let slot = 0;
    while (slot < MAX_TRACKS && used.has(slot)) slot++;
    if (slot >= MAX_TRACKS) return null;
    // ADD_DRUM_TRACK resets all engine patterns (16 steps, no swing) and selects 0.
    const pattern = makeDrumPattern(0, 'Pattern 1', 16, 0);
    p.tracks.push({
      kind: 'drum',
      id: crypto.randomUUID(),
      slot,
      name,
      color: TRACK_COLORS[slot % TRACK_COLORS.length],
      rows: rowNames.slice(0, MAX_ROWS).map(makeRow),
      patterns: [pattern],
      currentPatternId: pattern.id,
      clips: [],
      automation: [],
    });
    const track = p.tracks[p.tracks.length - 1] as DrumTrack; // reactive proxy
    // The engine resets the mixer slot on ADD; mirror it with default state.
    p.mixer.channels[track.id] = newChannel();
    sink.send(Op.ADD_DRUM_TRACK, slot);
    selectTrack(p, sink, track.id);
    return track;
  });
}

/** No engine command: all engine rows already exist (empty), and every pattern holds MAX_ROWS step rows. */
export function addRow(p: Project, _sink: CommandSink, trackId: string): DrumRow | null {
  return edit(p, 'Add row', () => {
    const track = p.tracks.find((t) => t.id === trackId);
    if (!track || track.kind !== 'drum' || track.rows.length >= MAX_ROWS) return null;
    track.rows.push(makeRow(`Row ${track.rows.length + 1}`));
    markEdited(p); // no engine command, so mark it here
    return track.rows[track.rows.length - 1];
  });
}

// Step, step-count and swing edits act on the track's current pattern, which
// is also the engine's current pattern (only selectPattern changes either).

export function setStep(p: Project, sink: CommandSink, trackId: string, rowId: string, step: number, velocity: number) {
  return edit(p, 'Set step', () => {
    const f = find(p, trackId, rowId);
    if (!f || Number.isNaN(velocity) || !Number.isInteger(step) || step < 0 || step >= MAX_STEPS) return;
    const v = Math.round(clamp(velocity, 0, 127));
    currentPattern(f.track).steps[f.row][step] = v;
    sink.send(Op.SET_STEP, f.track.slot, f.row, step, v);
  });
}

export function toggleStep(p: Project, sink: CommandSink, trackId: string, rowId: string, step: number) {
  return edit(p, 'Toggle step', () => {
    const f = find(p, trackId, rowId);
    if (!f) return;
    setStep(p, sink, trackId, rowId, step, currentPattern(f.track).steps[f.row][step] > 0 ? 0 : 100);
  });
}

export function setRowSample(p: Project, sink: CommandSink, trackId: string, rowId: string, sampleId: number | null, name: string) {
  return edit(p, 'Load sample', () => {
    const f = find(p, trackId, rowId);
    if (!f) return;
    f.r.sampleId = sampleId;
    f.r.name = name;
    sink.send(Op.SET_ROW_SAMPLE, f.track.slot, f.row, sampleId ?? -1);
  });
}

export function setRowGain(p: Project, sink: CommandSink, trackId: string, rowId: string, gain: number) {
  return edit(p, 'Row gain', () => {
    const f = find(p, trackId, rowId);
    if (!f || Number.isNaN(gain)) return;
    f.r.gain = clamp(gain, 0, 2);
    sink.send(Op.SET_ROW_GAIN, f.track.slot, f.row, f.r.gain);
  });
}

export function setRowPan(p: Project, sink: CommandSink, trackId: string, rowId: string, pan: number) {
  return edit(p, 'Row pan', () => {
    const f = find(p, trackId, rowId);
    if (!f || Number.isNaN(pan)) return;
    f.r.pan = clamp(pan, -1, 1);
    sink.send(Op.SET_ROW_PAN, f.track.slot, f.row, f.r.pan);
  });
}

export function setRowMute(p: Project, sink: CommandSink, trackId: string, rowId: string, mute: boolean) {
  return edit(p, mute ? 'Mute row' : 'Unmute row', () => {
    const f = find(p, trackId, rowId);
    if (!f) return;
    f.r.mute = mute;
    sink.send(Op.SET_ROW_MUTE, f.track.slot, f.row, mute ? 1 : 0);
  });
}

export function setStepCount(p: Project, sink: CommandSink, trackId: string, n: 16 | 32 | 64) {
  return edit(p, 'Step count', () => {
    const track = p.tracks.find((t) => t.id === trackId);
    if (!track || track.kind !== 'drum' || (n !== 16 && n !== 32 && n !== 64)) return;
    currentPattern(track).stepCount = n;
    sink.send(Op.SET_STEP_COUNT, track.slot, n);
  });
}

export function setSwing(p: Project, sink: CommandSink, trackId: string, s: number) {
  return edit(p, 'Swing', () => {
    const track = p.tracks.find((t) => t.id === trackId);
    if (!track || track.kind !== 'drum' || Number.isNaN(s)) return;
    const pat = currentPattern(track);
    pat.swing = clamp(s, 0, 1);
    sink.send(Op.SET_SWING, track.slot, pat.swing);
  });
}

export function setTempo(p: Project, sink: CommandSink, bpm: number) {
  return edit(p, 'Tempo', () => {
    if (Number.isNaN(bpm)) return;
    p.tempo = Math.round(clamp(bpm, 20, 300) * 10) / 10;
    sink.send(Op.SET_TEMPO, p.tempo);
  });
}

export function setMetronome(p: Project, sink: CommandSink, on: boolean) {
  return edit(p, 'Metronome', () => {
    p.metronome = on;
    sink.send(Op.SET_METRONOME, on ? 1 : 0);
  });
}

/** `countIn`: ticks of count-in (BAR_TICKS = one bar; the engine accepts only 0 or BAR_TICKS). */
/**
 * False (and still stopped) if the engine refused the command: it failed,
 * or it is closed (an audio restart replaced it) -- the Play button must not
 * show a transport that is not running.
 */
export function play(p: Project, sink: CommandSink, countIn = 0): boolean {
  if (!sink.send(Op.PLAY, countIn === BAR_TICKS ? BAR_TICKS : 0)) return false;
  p.playing = true;
  return true;
}

/** Song mode with the loop on: the engine parks at the loop start (and makes it the song start). */
export function stop(p: Project, sink: CommandSink) {
  p.playing = false;
  sink.send(Op.STOP);
  if (p.mode === 'song' && p.loop.on) p.songPosition = p.loop.start;
}

export function togglePlay(p: Project, sink: CommandSink, countIn = 0) {
  if (p.playing) stop(p, sink);
  else play(p, sink, countIn);
}

/** The synth that receives live keys: the selected synth, else the last-selected one. */
export function liveInputTrack(p: Project): SynthTrack | null {
  const sel = p.tracks.find((t) => t.id === p.selectedTrackId);
  if (sel?.kind === 'synth') return sel;
  const last = p.tracks.find((t) => t.id === p.lastSynthTrackId);
  return last?.kind === 'synth' ? last : null;
}

/** Sends SET_INPUT_TRACK only when `before` (a live input captured earlier) differs from the current one. */
function syncInput(p: Project, sink: CommandSink, before: SynthTrack | null) {
  const now = liveInputTrack(p);
  if (now?.id !== before?.id) sink.send(Op.SET_INPUT_TRACK, now ? now.slot : -1);
}

export function selectTrack(p: Project, sink: CommandSink, trackId: string) {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return;
  const before = liveInputTrack(p);
  p.history?.settle(); // a selection is snapshotted but not an edit: not part of a pending pass
  p.selectedTrackId = t.id;
  if (t.kind === 'synth') p.lastSynthTrackId = t.id;
  syncInput(p, sink, before);
}

export function removeTrack(p: Project, sink: CommandSink, trackId: string) {
  return edit(p, 'Remove track', () => {
    const i = p.tracks.findIndex((t) => t.id === trackId);
    if (i < 0) return;
    const before = liveInputTrack(p);
    const slot = p.tracks[i].slot;
    p.tracks.splice(i, 1);
    // Mirror the engine: the strip goes away and every key that pointed at the
    // track falls back to none (state only; the engine already does the same).
    delete p.mixer.channels[trackId];
    for (const ch of Object.values(p.mixer.channels)) if (ch.key?.trackId === trackId) ch.key = null;
    sink.send(Op.REMOVE_TRACK, slot);
    if (p.selectedTrackId === trackId) {
      p.selectedTrackId = (p.tracks[i] ?? p.tracks[i - 1] ?? null)?.id ?? null;
    }
    const sel = p.tracks.find((t) => t.id === p.selectedTrackId);
    if (sel?.kind === 'synth') {
      // Selection landed on a synth: keys follow it, and stay on it if a drum is selected later.
      p.lastSynthTrackId = sel.id;
    } else if (p.lastSynthTrackId === trackId) {
      // Removed the last synth while a drum is selected: fall back to any remaining synth.
      p.lastSynthTrackId = p.tracks.find((t) => t.kind === 'synth')?.id ?? null;
    }
    syncInput(p, sink, before);
  });
}
