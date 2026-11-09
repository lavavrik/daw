// Transition tracks (plan 28 Task 3; spec 2026-11-19-builtin-content §4):
// Add track ▸ Transition ▸ Riser / Downlifter / Impact. Each one is a synth
// track named after it ("Riser", "Riser 2", …) with a transition patch
// (housePatches.ts TRANSITION_PATCHES), one pattern holding its notes, one
// clip of that pattern placed against the playhead's bar, and, for the
// sweeps, two automation lanes drawn with the shapes of automation-actions.ts.
// The lanes are the patch's own: the filter's cutoff and the amp VCA's
// level, both inside the rack, so the track's mixer fader stays the user's
// to set the transition's level (a fader lane would take it over).
// Automation follows clips (song-actions.ts), so moving or duplicating the
// clip takes its sweep along.
//
// Placement (owner, after plan 28): a Riser builds INTO a moment, so it ENDS
// where the user clicked: its clip fills the bars before the playhead's bar
// (click bar 17, get bars 9–16, the drop lands on 17). With fewer than 8 bars
// before the playhead it is shortened to fit (at least 1 bar); at bar 1 there
// is nothing before, so it starts there instead. A Downlifter (it follows a
// moment) and an Impact (it IS the moment) START at the playhead's bar.
//
//   Riser       8 bars  Noise Sweep  cutoff ramps up 200 Hz → 12 kHz,
//                                    amp level −24 dB → 0 dB
//   Downlifter  4 bars  Noise Sweep  cutoff ramps down 12 kHz → 200 Hz,
//                                    amp level 0 dB → −30 dB
//   Impact      1 bar   Impact       one 1/8 hit on beat 1, reverb send −6 dB
//
// The level lane is the VCA's linear `level` (0..1); its ramp is bent
// (a point curve) so it passes the dB midpoint halfway, i.e. it rises or
// falls about evenly in dB, as a fader ramp would. Each shape's closing
// point sits one tick before the clip's end: automation that follows a
// clip takes the points in [start, end), so the sweep's end goes with it
// and a copy placed right after never fights it for a tick.
//
// Built from the ordinary actions (addSynthTrack, renamePattern,
// setPatternBars, addNotes, addClip, setMix, addLane, insertShape,
// setPointCurve), so the engine gets exactly the commands a user's own
// edits would send and a saved project holds nothing new. The whole add is ONE undo entry ("Add riser",
// …): the outer edit(); the nested actions run inside it and make no entry of
// their own. Everything that can fail (tracks full, too few free automation
// lanes, a load in progress, a patch without the module a lane needs) is
// checked BEFORE the first change, so a refusal returns null with no state
// change, no engine command and no undo entry.
//
// The sweeps' notes: one bar-long C4 per bar, back to back, rather than one
// note held over the whole clip. Noise Sweep is mono with a full-sustain
// ADSR, and the engine sends a bar's note-off before the next bar's note-on
// at the same tick (sequencer.rs: Offs before Ons), so the gate retriggers
// from the held level and the noise runs on without a dip; played from the
// clip's start it sounds as one held note. But notes are not chased: a song
// started (or a loop wrapped) mid-clip would stay silent for the rest of one
// long note, while bar notes pick up at the next bar line. The pitch is
// unused by Noise Sweep (no pitch cable). The Impact's pitch matters: its sub
// lands two octaves under the note, so C4 drops onto C2 (65 Hz; Task 1's
// measurements were made on C4), while a low note would sink the sub out of
// hearing (C2 → 16 Hz). Keep it in C3–C5.
//
// Impact has no reverb in its rack (house patches hold no Delay or Reverb),
// so its tail is the track's reverb send (send_a, the Reverb return): −6 dB,
// louder than any mix preset's send (Pad wash −8), so the hit leaves a long,
// clearly audible tail on whatever reverb the project's return holds.
import { BAR_TICKS, MAX_AUTO_LANES, MAX_SONG_TICKS } from '../audio/protocol';
import { LOADING_TEXT, TRACKS_FULL_TEXT, uniqueTrackName } from './actions';
import type { CommandSink } from './actions';
import { addLane, insertShape, setPointCurve } from './automation-actions';
import type { AutoShape } from './automation-actions';
import { laneCount } from './automation';
import { banners } from './banners.svelte';
import { edit } from './edits';
import { TRANSITION_PATCHES } from './housePatches';
import { setMix } from './mixer-actions';
import type { Patch } from './patches';
import { addNotes, renamePattern, setPatternBars } from './pattern-actions';
import { MAX_TRACKS, currentPattern } from './project.svelte';
import type { AutoTarget, Project, SynthTrack } from './project.svelte';
import { addSynthTrack } from './rack-actions';
import { addClip } from './song-actions';

export type TransitionKind = 'riser' | 'downlifter' | 'impact';

/** The sweeps' cutoff travel (Task 1's recommended Noise Sweep lane range). */
export const SWEEP_LO_HZ = 200;
export const SWEEP_HI_HZ = 12000;
/** The Riser's level starts here (dB) and rises to 0 dB. */
export const RISER_FROM_DB = -24;
/** The Downlifter's level falls from 0 dB to here (dB). */
export const DOWNLIFTER_TO_DB = -30;

/** A gain in dB as a VCA `level` (linear amplitude, 0 dB = 1). */
export const dbLevel = (db: number) => 10 ** (db / 20);

/**
 * The curve (automation.ts bend: f(x) = x^(2^(−3·curve))) that makes a
 * linear-level ramp from `fromDb` to `toDb` pass their dB midpoint halfway
 * through, so it moves about evenly in dB. Riser −24 → 0: −0.40 (slow, then
 * fast); Downlifter 0 → −30: 0.69 (fast, then slow).
 */
export function dbRampCurve(fromDb: number, toDb: number): number {
  const a = dbLevel(fromDb);
  const b = dbLevel(toDb);
  const frac = (dbLevel((fromDb + toDb) / 2) - a) / (b - a); // the way along at x = 0.5
  return Math.min(1, Math.max(-1, -Math.log2(Math.log(frac) / Math.log(0.5)) / 3));
}
/** The Impact track's reverb send (dB): a long, audible tail. */
export const IMPACT_REVERB_SEND_DB = -6;
/** Every transition note's pitch (C4). */
export const TRANSITION_PITCH = 60;
/** The Impact's hit: a 1/8 note (Task 1: one hit; 1/8 is enough). */
export const IMPACT_HIT_TICKS = BAR_TICKS / 8;

/**
 * A lane a transition draws: the filter's cutoff or the amp VCA's level, with
 * its shape over the clip and the curve of its first point (0: straight).
 */
interface LaneSpec {
  target: 'cutoff' | 'level';
  shape: AutoShape;
  curve: number;
}

export interface TransitionDef {
  kind: TransitionKind;
  /** The menu label, the track's base name and the pattern's name. */
  label: string;
  /** The menu item's tooltip. */
  title: string;
  /** Clip and pattern length (a Riser may be shortened to fit before the playhead). */
  bars: number;
  /** 'end': the clip ends at the playhead's bar (builds into it); 'start': it starts there. */
  anchor: 'start' | 'end';
  patch: Patch;
  /** The pattern's notes for a clip of `bars` bars (ticks from the pattern start). */
  notes: (bars: number) => { pitch: number; start: number; len: number; vel: number }[];
  lanes: LaneSpec[];
  /** Mixer params set on the new track (param name → value). */
  mix: Record<string, number>;
}

/** One bar-long C4 per bar (see the header: picks up mid-clip). */
const barNotes = (bars: number) =>
  Array.from({ length: bars }, (_, i) => ({ pitch: TRANSITION_PITCH, start: i * BAR_TICKS, len: BAR_TICKS, vel: 100 }));

/** The Transition submenu's items, in menu order. */
export const TRANSITIONS: readonly TransitionDef[] = [
  {
    kind: 'riser', label: 'Riser', bars: 8, anchor: 'end', patch: TRANSITION_PATCHES.noiseSweep,
    title: 'Add a Riser track: 8 bars of noise ending at the playhead (the drop), its filter opening and its level rising',
    notes: barNotes,
    lanes: [
      { target: 'cutoff', shape: { kind: 'ramp-up', lo: SWEEP_LO_HZ, hi: SWEEP_HI_HZ }, curve: 0 },
      { target: 'level', shape: { kind: 'ramp-up', lo: dbLevel(RISER_FROM_DB), hi: 1 }, curve: dbRampCurve(RISER_FROM_DB, 0) },
    ],
    mix: {},
  },
  {
    kind: 'downlifter', label: 'Downlifter', bars: 4, anchor: 'start', patch: TRANSITION_PATCHES.noiseSweep,
    title: 'Add a Downlifter track: 4 bars of noise from the playhead, its filter closing and its level falling',
    notes: barNotes,
    lanes: [
      { target: 'cutoff', shape: { kind: 'ramp-down', lo: SWEEP_LO_HZ, hi: SWEEP_HI_HZ }, curve: 0 },
      { target: 'level', shape: { kind: 'ramp-down', lo: dbLevel(DOWNLIFTER_TO_DB), hi: 1 }, curve: dbRampCurve(0, DOWNLIFTER_TO_DB) },
    ],
    mix: {},
  },
  {
    kind: 'impact', label: 'Impact', bars: 1, anchor: 'start', patch: TRANSITION_PATCHES.impact,
    title: 'Add an Impact track: one hit at the playhead, with a long reverb tail',
    notes: () => [{ pitch: TRANSITION_PITCH, start: 0, len: IMPACT_HIT_TICKS, vel: 100 }],
    lanes: [],
    mix: { send_a: IMPACT_REVERB_SEND_DB },
  },
];

export const transitionDef = (kind: TransitionKind): TransitionDef => TRANSITIONS.find((d) => d.kind === kind)!;

/** Why transition `kind` can't be added now (its menu item's disabled tooltip), or null. */
export function transitionBlocked(p: Project, kind: TransitionKind): string | null {
  if (p.loading) return LOADING_TEXT;
  if (p.tracks.length >= MAX_TRACKS) return TRACKS_FULL_TEXT;
  const d = transitionDef(kind);
  const need = d.lanes.length;
  if (laneCount(p) + need > MAX_AUTO_LANES) return `A ${d.label} needs ${need} free automation lanes: all ${MAX_AUTO_LANES} are in use`;
  if (d.lanes.some((l) => laneModule(d.patch, l.target) === null)) return `${d.patch.name} has no module for the ${d.label}'s sweep`;
  return null;
}

/**
 * Where a transition of `bars` bars goes for the playhead at `playhead`: the
 * start of the bar it is in, moved back so the clip ends inside the song.
 */
export function transitionStart(playhead: number, bars: number): number {
  const bar = Number.isFinite(playhead) ? Math.max(0, Math.floor(playhead / BAR_TICKS)) * BAR_TICKS : 0;
  return Math.min(bar, MAX_SONG_TICKS - bars * BAR_TICKS);
}

/**
 * Where a transition goes for the playhead at `playhead`: `{ start, bars }`.
 * 'start': transitionStart. 'end': the clip ends on the playhead's bar line,
 * shortened to the bars before it (≥ 1); at bar 1 it starts there instead.
 */
export function transitionPlace(playhead: number, bars: number, anchor: 'start' | 'end'): { start: number; bars: number } {
  if (anchor === 'start') return { start: transitionStart(playhead, bars), bars };
  const end = transitionStart(playhead, 0); // the playhead's bar line, inside the song
  const before = Math.floor(end / BAR_TICKS);
  if (before < 1) return { start: 0, bars };
  const n = Math.min(bars, before);
  return { start: end - n * BAR_TICKS, bars: n };
}

/**
 * The module of `patch` a LaneSpec drives (the new track's modules keep the
 * patch's idx): its first filter, or the VCA cabled into its Out (the amp,
 * before the mixer: the fader stays free). Null: the patch has none.
 */
function laneModule(patch: Patch, target: LaneSpec['target']): number | null {
  if (target === 'cutoff') return patch.modules.find((m) => m.id === 'filter')?.idx ?? null;
  const outs = new Set(patch.modules.filter((m) => m.id === 'out').map((m) => m.idx));
  const vcas = new Set(patch.modules.filter((m) => m.id === 'vca').map((m) => m.idx));
  return patch.cables.find((c) => vcas.has(c.from[0]) && outs.has(c.to[0]))?.from[0] ?? null;
}

/** The lane target a LaneSpec names (laneModule, checked by transitionBlocked). */
const laneTarget = (patch: Patch, target: LaneSpec['target']): AutoTarget => ({
  kind: 'rack', module: laneModule(patch, target)!, param: target === 'cutoff' ? 'cutoff' : 'level',
});

/**
 * Add transition `kind` with its clip at the bar `playhead` (a song tick) is
 * in: a new synth track (selected, as any added track), its patch, one
 * pattern with its notes, one clip, its mixer settings and its lanes. One undo
 * entry. Null (nothing changed) when transitionBlocked refuses it.
 */
export function addTransition(p: Project, sink: CommandSink, kind: TransitionKind, playhead: number): SynthTrack | null {
  const d = transitionDef(kind);
  if (transitionBlocked(p, kind)) return null;
  const { start, bars } = transitionPlace(playhead, d.bars, d.anchor);
  const len = bars * BAR_TICKS;
  return edit(p, `Add ${d.label.toLowerCase()}`, () => {
    const t = addSynthTrack(p, sink, uniqueTrackName(p, d.label), d.patch);
    if (!t) return null; // no free slot (checked above): addSynthTrack changed nothing
    // The fresh track's empty "Pattern 1" becomes the transition's pattern.
    const pat = currentPattern(t);
    renamePattern(p, sink, t.id, pat.id, d.label);
    setPatternBars(p, sink, t.id, bars); // first: addNotes keeps starts inside the pattern
    addNotes(p, sink, t.id, d.notes(bars));
    addClip(p, sink, t.id, { start, len, patternId: pat.id });
    for (const [param, v] of Object.entries(d.mix)) setMix(p, sink, t.id, param, v);
    for (const l of d.lanes) {
      const lane = addLane(p, sink, t.id, laneTarget(d.patch, l.target));
      // The shape spans the clip; its closing point sits one tick before the clip's end (the header:
      // it moves with the clip), and the value holds after it.
      const shaped = lane ? insertShape(p, sink, lane.id, l.shape, { start, end: start + len - 1 }) : null;
      if (lane && shaped?.ok && l.curve) setPointCurve(p, sink, t.id, lane.id, lane.points[0].id, l.curve);
      // Checked up front (transitionBlocked), so this should never happen; if it does, say so.
      if (!shaped?.ok) banners.error = `The ${d.label}'s ${l.target} sweep could not be drawn${shaped && !shaped.ok ? `: ${shaped.message}` : ''}`;
    }
    return t;
  });
}
