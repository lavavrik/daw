// Transition tracks (plan 28 Task 3; spec 2026-11-19-builtin-content §4):
// Add track ▸ Transition ▸ Riser / Downlifter / Impact. Each one is a synth
// track named after it ("Riser", "Riser 2", …) with a transition patch
// (housePatches.ts TRANSITION_PATCHES), one pattern holding its notes, one
// clip of that pattern placed against the playhead's bar, and, for the
// sweeps, two automation lanes drawn with the shapes of automation-actions.ts.
//
// Placement (owner, after plan 28): a Riser builds INTO a moment, so it ENDS
// where the user clicked: its clip fills the bars before the playhead's bar
// (click bar 17, get bars 9–16, the drop lands on 17). With fewer than 8 bars
// before the playhead it is shortened to fit (at least 1 bar); at bar 1 there
// is nothing before, so it starts there instead. A Downlifter (it follows a
// moment) and an Impact (it IS the moment) START at the playhead's bar.
//
//
//   Riser       8 bars  Noise Sweep  cutoff ramps up 200 Hz → 12 kHz,
//                                    track volume −24 dB → 0 dB
//   Downlifter  4 bars  Noise Sweep  cutoff ramps down 12 kHz → 200 Hz,
//                                    track volume 0 dB → −30 dB
//   Impact      1 bar   Impact       one 1/8 hit on beat 1, reverb send −6 dB
//
// Built from the ordinary actions (addSynthTrack, renamePattern,
// setPatternBars, addNotes, addClip, setMix, addLane, insertShape), so the
// engine gets exactly the commands a user's own edits would send and a saved
// project holds nothing new. The whole add is ONE undo entry ("Add riser",
// …): the outer edit(); the nested actions run inside it and make no entry of
// their own. Everything that can fail (tracks full, too few free automation
// lanes) is checked BEFORE the first change, so a refusal returns null with
// no state change, no engine command and no undo entry.
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
import { moduleDef } from '../audio/catalog';
import { BAR_TICKS, MAX_AUTO_LANES, MAX_SONG_TICKS } from '../audio/protocol';
import { TRACKS_FULL_TEXT, uniqueTrackName } from './actions';
import type { CommandSink } from './actions';
import { addLane, insertShape } from './automation-actions';
import type { AutoShape } from './automation-actions';
import { laneCount } from './automation';
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
/** The Riser's volume starts here (dB) and rises to 0 dB. */
export const RISER_FROM_DB = -24;
/** The Downlifter's volume falls from 0 dB to here (dB). */
export const DOWNLIFTER_TO_DB = -30;
/** The Impact track's reverb send (dB): a long, audible tail. */
export const IMPACT_REVERB_SEND_DB = -6;
/** Every transition note's pitch (C4). */
export const TRANSITION_PITCH = 60;
/** The Impact's hit: a 1/8 note (Task 1: one hit; 1/8 is enough). */
export const IMPACT_HIT_TICKS = BAR_TICKS / 8;

/** A lane a transition draws: the filter's cutoff or the track's volume, with its shape over the clip. */
interface LaneSpec {
  target: 'cutoff' | 'volume';
  shape: AutoShape;
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
    title: 'Add a Riser track: 8 bars of noise ending at the playhead (the drop), its filter opening and its volume rising',
    notes: barNotes,
    lanes: [
      { target: 'cutoff', shape: { kind: 'ramp-up', lo: SWEEP_LO_HZ, hi: SWEEP_HI_HZ } },
      { target: 'volume', shape: { kind: 'ramp-up', lo: RISER_FROM_DB, hi: 0 } },
    ],
    mix: {},
  },
  {
    kind: 'downlifter', label: 'Downlifter', bars: 4, anchor: 'start', patch: TRANSITION_PATCHES.noiseSweep,
    title: 'Add a Downlifter track: 4 bars of noise from the playhead, its filter closing and its volume falling',
    notes: barNotes,
    lanes: [
      { target: 'cutoff', shape: { kind: 'ramp-down', lo: SWEEP_LO_HZ, hi: SWEEP_HI_HZ } },
      { target: 'volume', shape: { kind: 'ramp-down', lo: DOWNLIFTER_TO_DB, hi: 0 } },
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
  if (p.tracks.length >= MAX_TRACKS) return TRACKS_FULL_TEXT;
  const need = transitionDef(kind).lanes.length;
  if (laneCount(p) + need > MAX_AUTO_LANES) return `A ${transitionDef(kind).label} needs ${need} free automation lanes: all ${MAX_AUTO_LANES} are in use`;
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

/** The lane target a LaneSpec names on the new track (its rack's filter, or the volume fader). */
function laneTarget(t: SynthTrack, target: LaneSpec['target']): AutoTarget | null {
  if (target === 'volume') return { kind: 'mix', param: 'fader' };
  const filter = t.modules.find((m) => moduleDef(m.kind).id === 'filter');
  return filter ? { kind: 'rack', module: filter.idx, param: 'cutoff' } : null;
}

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
      const target = laneTarget(t, l.target);
      const lane = target && addLane(p, sink, t.id, target);
      // The shape spans the clip; its closing point sits on the clip's end (the range end is exclusive,
      // the lane is empty there, so the point is written): the value holds after the clip.
      if (lane) insertShape(p, sink, lane.id, l.shape, { start, end: start + len });
    }
    return t;
  });
}
