// Every user edit: mutate Project AND send the matching engine command.
// Each exported edit runs its body inside edit() (state/edits.ts): one undo
// step, nested calls included (docs/architecture/history.md). Same in
// pattern-, song-, audio-, mixer- and rack-actions.ts.
import { BAR_TICKS, Op, PATTERN_FOCUS_NONE } from '../audio/protocol';
import { MAX_ROWS, MAX_STEPS, MAX_TRACKS, TRACK_COLORS, currentPattern, isPatternTrack, newChannel } from './project.svelte';
import type { DrumRow, DrumTrack, Project, SynthTrack } from './project.svelte';
import { makeDrumPattern } from './pattern-actions';
import { edit, markEdited } from './edits';
import { dropTrackMappings } from './midiMap';
import { keysLostBy, unduckLostKeys } from './mixer-actions';
import { clampStepVel } from '../ui/stepGrid';
import { humanizeAmount, humanizeSeed, humanizedVel, nextHumanizeCounter, peekHumanizeCounter } from './groove';

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

/** Why "add track" buttons are disabled at MAX_TRACKS (the timeline, the examples menu). */
export const TRACKS_FULL_TEXT = `${MAX_TRACKS} tracks is the maximum: remove one to add another`;
/** Why an add is refused while a load, New or restore replaces the session (p.loading). */
export const LOADING_TEXT = 'Loading a project…';

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

// ---- Deleting a row (plan 21 task 7; docs/architecture/sequencer.md "Deleting a row")
// Engine rows are addressed by index, so a row in the middle can't simply
// vanish: every later row must move up one, with its steps in EVERY pattern
// (not just the current one) and the sidechain keys on it. REMOVE_ROW does
// all of that in one command (atomic for the audio thread, no pattern
// switching, no flood of SET_STEPs); the two functions below make the state
// mirror it. No automation lane or MIDI mapping can point at a row (row
// gain/pan are native ranges, not params), so there are none to drop.

/** The state side of REMOVE_ROW (engine.rs `RemoveRow`): no command. */
export function rowRemovedState(p: Project, track: DrumTrack, row: number) {
  track.rows.splice(row, 1);
  for (const pat of track.patterns) {
    pat.steps.splice(row, 1);
    pat.steps.push(new Array(MAX_STEPS).fill(0));
  }
  for (const ch of Object.values(p.mixer.channels)) {
    const k = ch.key;
    if (k?.trackId !== track.id || k.row === null || k.row < row) continue;
    ch.key = k.row === row ? null : { trackId: k.trackId, row: k.row - 1 };
  }
}

/**
 * The state side of INSERT_ROW (engine.rs `InsertRow`; diffApply's undo of a
 * delete): `r` at `row`, empty steps there in every pattern, keys from that
 * row on move down one. No command.
 */
export function rowInsertedState(p: Project, track: DrumTrack, row: number, r: DrumRow) {
  track.rows.splice(row, 0, r);
  for (const pat of track.patterns) {
    pat.steps.splice(row, 0, new Array(MAX_STEPS).fill(0));
    pat.steps.length = MAX_ROWS; // the dropped last row is unused, so empty
  }
  for (const ch of Object.values(p.mixer.channels)) {
    const k = ch.key;
    if (k?.trackId !== track.id || k.row === null || k.row < row) continue;
    ch.key = k.row + 1 < MAX_ROWS ? { trackId: k.trackId, row: k.row + 1 } : null;
  }
}

/**
 * Delete a drum row: one undo entry ("Delete row") that removes its sample,
 * settings and steps in every pattern; sidechain keys on it go to none.
 * Undo puts it all back (diffApply: INSERT_ROW, then the row's data). The
 * last row can go too: the track is then empty, with "+ Add row".
 */
export function removeDrumRow(p: Project, sink: CommandSink, trackId: string, rowId: string): boolean {
  return edit(p, 'Delete row', () => {
    const f = find(p, trackId, rowId);
    if (!f) return false;
    const lost = keysLostBy(p, f.track.id, f.row);
    sink.send(Op.REMOVE_ROW, f.track.slot, f.row);
    rowRemovedState(p, f.track, f.row);
    unduckLostKeys(p, sink, lost); // a ducked strip that lost its kick: comp off, in this entry
    return true;
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

// ---- Step velocity (plan 23; docs/architecture/sequencer.md "Step velocity")
// The step grid's in-cell edits (wheel, Shift-drag, Shift+arrows) and the
// velocity lane write velocities here. An edit only re-levels a LIT step,
// clamped to 1..127 (ui/stepGrid.ts clampStepVel), so it never turns one on
// or off: that stays a click / right-click (setStep). Undo, one entry per
// gesture labelled "Step velocity":
//   - wheel / key bursts: pass `opts.coalesce` (an idle-aware sweep key per
//     cell, history/sweep.ts), so a burst merges into one entry;
//   - drags and lane strokes run inside the App's pointer gesture (one entry
//     per press, history/gestures.ts); stepVelocityGesture adds the cancel.

/**
 * Re-level a lit step of the current pattern (SET_STEP). Returns the velocity
 * it now has (unchanged: no write, no entry), or null when refused: an off
 * step, a bad step / row / track, NaN.
 */
export function setStepVelocity(
  p: Project, sink: CommandSink, trackId: string, rowId: string, step: number, velocity: number,
  opts?: { coalesce?: string },
): number | null {
  const f = find(p, trackId, rowId);
  if (!f || Number.isNaN(velocity) || !Number.isInteger(step) || step < 0 || step >= MAX_STEPS) return null;
  const cur = currentPattern(f.track).steps[f.row][step];
  if (cur === 0) return null;
  const v = clampStepVel(velocity);
  if (v !== cur) edit(p, 'Step velocity', () => setStep(p, sink, trackId, rowId, step, v), opts);
  return v;
}

/**
 * One velocity drag or lane stroke on track `trackId`. `set` re-levels a lit
 * step (setStepVelocity; null for an off one) and remembers the value each
 * step had before its first write; `cancel` (Esc, Cmd/Ctrl+Z mid-drag via
 * registerDragCancel) puts all of those back. Run it inside the pointer
 * gesture: a cancelled gesture then ends where it began and makes no entry.
 */
export interface StepVelocityGesture {
  set(rowId: string, step: number, velocity: number): number | null;
  cancel(): void;
}

export function stepVelocityGesture(p: Project, sink: CommandSink, trackId: string): StepVelocityGesture {
  const before = new Map<string, { rowId: string; step: number; vel: number }>();
  return {
    set(rowId, step, velocity) {
      const f = find(p, trackId, rowId);
      const cur = f && Number.isInteger(step) && step >= 0 && step < MAX_STEPS ? currentPattern(f.track).steps[f.row][step] : 0;
      const k = `${rowId}:${step}`;
      if (cur > 0 && !before.has(k)) before.set(k, { rowId, step, vel: cur });
      return setStepVelocity(p, sink, trackId, rowId, step, velocity);
    },
    cancel() {
      // setStep, not setStepVelocity: put back exactly what was there.
      if (before.size) edit(p, 'Step velocity', () => {
        for (const b of before.values()) setStep(p, sink, trackId, b.rowId, b.step, b.vel);
      });
      before.clear();
    },
  };
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

/**
 * Humanize (plan 25; docs/architecture/sequencer.md "Humanize"): jitter the
 * velocity of every lit step of the current pattern's first `stepCount`
 * steps by up to ±HUMANIZE_VEL x `amount` (0..1), kept at 1..127 so no step
 * turns off and no off step turns on. Deterministic: seeded by the pattern
 * id and its humanize counter (state/groove.ts). One undo entry
 * ("Humanize"). Amount 0 (or NaN), or a pattern where nothing would change,
 * is a no-op: no write, no entry, and the counter is not used. Returns how
 * many steps changed.
 */
export function humanizeDrum(p: Project, sink: CommandSink, trackId: string, amount: number): number {
  const a = humanizeAmount(amount);
  const track = p.tracks.find((t) => t.id === trackId);
  if (a === 0 || !track || track.kind !== 'drum') return 0;
  const pat = currentPattern(track);
  const seed = humanizeSeed(pat.id, peekHumanizeCounter(pat.id));
  const changes: { rowId: string; step: number; vel: number }[] = [];
  track.rows.forEach((row, r) => {
    for (let s = 0; s < pat.stepCount; s++) {
      const cur = pat.steps[r][s];
      if (cur === 0) continue;
      const v = humanizedVel(cur, seed, `${r}:${s}`, a);
      if (v !== cur) changes.push({ rowId: row.id, step: s, vel: v });
    }
  });
  if (!changes.length) return 0; // nothing to change: no entry, no counter used
  nextHumanizeCounter(pat.id);
  return edit(p, 'Humanize', () => {
    for (const c of changes) setStep(p, sink, trackId, c.rowId, c.step, c.vel);
    return changes.length;
  });
}

export function setTempo(p: Project, sink: CommandSink, bpm: number) {
  return edit(p, 'Tempo', () => {
    if (Number.isNaN(bpm)) return;
    p.tempo = Math.round(clamp(bpm, 20, 300) * 10) / 10;
    sink.send(Op.SET_TEMPO, p.tempo);
  });
}

/**
 * The tempo a scrub is passing through (NumberField onpreview): heard at
 * once, but not an edit. `p.tempo` and the undo history are untouched; the
 * scrub's release commits once with setTempo (one undo entry), and a dropped
 * scrub previews `p.tempo` back. (SET_TEMPO still marks the project unsaved
 * for a moment; the dirty check clears it if the scrub ends where it began.)
 */
export function previewTempo(sink: CommandSink, bpm: number) {
  if (Number.isNaN(bpm)) return;
  sink.send(Op.SET_TEMPO, Math.round(clamp(bpm, 20, 300) * 10) / 10);
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

/**
 * The track that receives live keys: the selected synth or drum track (a
 * drum track plays row r on MIDI note 36 + r, plan 15), else the
 * last-selected synth (e.g. while an Audio track is selected).
 */
export function liveInputTrack(p: Project): SynthTrack | DrumTrack | null {
  const sel = p.tracks.find((t) => t.id === p.selectedTrackId);
  if (sel?.kind === 'synth' || sel?.kind === 'drum') return sel;
  const last = p.tracks.find((t) => t.id === p.lastSynthTrackId);
  return last?.kind === 'synth' ? last : null;
}

/** Sends SET_INPUT_TRACK only when `before` (a live input captured earlier) differs from the current one. */
function syncInput(p: Project, sink: CommandSink, before: SynthTrack | DrumTrack | null) {
  const now = liveInputTrack(p);
  if (now?.id !== before?.id) sink.send(Op.SET_INPUT_TRACK, now ? now.slot : -1);
}

// ---- Pattern focus (plan 20 task 12) ----------------------------------------
// "When playing the grid/roll, nothing else should be playing": while the
// pattern transport runs, the engine plays only the track the bottom panel
// shows (SET_PATTERN_FOCUS; docs/architecture/sequencer.md "Pattern focus").
// The focus follows the selection; it is transport state, never an edit.

/** The slot the pattern transport plays: the selected drum or synth track's, else null. */
export function patternFocusSlot(p: Project): number | null {
  const t = p.tracks.find((x) => x.id === p.selectedTrackId);
  return t && isPatternTrack(t) ? t.slot : null;
}

/** SET_PATTERN_FOCUS(slot, or 255 for none), remembered in `p.patternFocus`. */
export function sendPatternFocus(p: Project, sink: CommandSink, slot: number | null) {
  p.patternFocus = slot;
  sink.send(Op.SET_PATTERN_FOCUS, slot ?? PATTERN_FOCUS_NONE);
}

/**
 * While the pattern transport plays, move the focus to the selected track:
 * SET_PATTERN_FOCUS(slot) for a drum or synth track. An Audio track or no
 * selection keeps the last focus (nothing is sent). Stopped or Song mode:
 * nothing (playPattern sends the focus when it starts). Re-sending the
 * current slot is harmless (the engine ignores an unchanged focus).
 */
export function syncPatternFocus(p: Project, sink: CommandSink) {
  if (!p.playing || p.mode !== 'pattern') return;
  const slot = patternFocusSlot(p);
  if (slot !== null) sendPatternFocus(p, sink, slot);
}

export function selectTrack(p: Project, sink: CommandSink, trackId: string) {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return;
  const before = liveInputTrack(p);
  p.history?.settle(); // a selection is snapshotted but not an edit: not part of a pending pass
  p.selectedTrackId = t.id;
  if (t.kind === 'synth') p.lastSynthTrackId = t.id;
  syncInput(p, sink, before);
  syncPatternFocus(p, sink);
}

/**
 * Reorder the song's tracks (plan 22 Task 4): the track at index `from` of
 * `p.tracks` goes to index `to` (indices of the list before and after the
 * move, like Array splice-out then splice-in). One undo entry, "Move track".
 *
 * The order of `p.tracks` IS the song's track order (timeline rows, headers,
 * mixer strips, the saved file), and nothing else is keyed by it: the engine
 * addresses a track by `slot`, the UI by `id` (lane heights, the open lanes,
 * the selection, clip focus, MIDI mappings, the recorder), and the colour is
 * stored on the track. So a move is a pure permutation here: no engine
 * command, and markEdited marks it (there is no command to do that). Undo
 * puts the order back through diffApply's step 2 (`p.tracks = order`), which
 * sends nothing for unchanged tracks either.
 *
 * `opts.coalesce`: quick keyboard moves merge into one entry (TrackHeaders:
 * an idle-aware sweep key, like the rack's Alt+arrow nudges). False (no
 * write) for a move to the same place or an index out of range.
 */
export function moveTrack(p: Project, from: number, to: number, opts?: { coalesce?: string }): boolean {
  const n = p.tracks.length;
  const ok = (i: number) => Number.isInteger(i) && i >= 0 && i < n;
  if (!ok(from) || !ok(to) || from === to) return false;
  return edit(p, 'Move track', () => {
    const [t] = p.tracks.splice(from, 1);
    p.tracks.splice(to, 0, t);
    markEdited(p); // no engine command, so mark it here
    return true;
  }, opts);
}

export function removeTrack(p: Project, sink: CommandSink, trackId: string) {
  return edit(p, 'Remove track', () => {
    const i = p.tracks.findIndex((t) => t.id === trackId);
    if (i < 0) return;
    const before = liveInputTrack(p);
    const slot = p.tracks[i].slot;
    const lost = keysLostBy(p, trackId);
    p.tracks.splice(i, 1);
    // Mirror the engine: the strip goes away and every key that pointed at the
    // track falls back to none (state only; the engine already does the same).
    delete p.mixer.channels[trackId];
    for (const ch of Object.values(p.mixer.channels)) if (ch.key?.trackId === trackId) ch.key = null;
    dropTrackMappings(p, trackId); // its MIDI mappings go in the same undo entry
    sink.send(Op.REMOVE_TRACK, slot);
    unduckLostKeys(p, sink, lost); // a ducked strip that lost its kick: comp off, in this entry
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
    // The pattern transport follows the new selection. If it was playing the
    // removed track and the selection is now an Audio track or none, there
    // is nothing left to play ("nothing else should be playing", and the
    // slot may be reused by the next new track): stop it. The App's
    // transport safety net closes a recording pass on the next frame.
    if (p.playing && p.mode === 'pattern' && p.patternFocus === slot && patternFocusSlot(p) === null) stop(p, sink);
    else syncPatternFocus(p, sink);
  });
}
