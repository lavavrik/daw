import { describe, expect, it } from 'vitest';
import { BAR_TICKS as BAR, MAX_AUTO_LANES, MAX_SONG_TICKS } from '../audio/protocol';
import { moduleDef } from '../audio/catalog';
import { mixParam } from '../audio/mixerCatalog';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { blankModel, run, view } from '../history/engineModel';
import { projectCommands } from '../project/commands';
import { serialize } from '../project/serialize';
import type { ProjectJson } from '../project/schema';
import { addDrumTrack } from './actions';
import { addLane } from './automation-actions';
import { targetDef } from './automation';
import { commandEdits } from './edits';
import { TRANSITION_PATCHES } from './housePatches';
import { MAX_TRACKS, Project, currentPattern } from './project.svelte';
import { duplicateClips, moveClips } from './song-actions';
import type { SynthTrack } from './project.svelte';
import {
  DOWNLIFTER_TO_DB, IMPACT_HIT_TICKS, IMPACT_REVERB_SEND_DB, RISER_FROM_DB, SWEEP_HI_HZ, SWEEP_LO_HZ, TRANSITIONS,
  addTransition, dbLevel, dbRampCurve, transitionBlocked, transitionPlace, transitionStart,
} from './transitions';
import type { TransitionKind } from './transitions';

const ids = (json: ProjectJson) => new Map(json.samples.map((s) => [s.id, s.id]));
/** The engine state a fresh load of `json` builds. */
const loaded = (json: ProjectJson) => view(run(blankModel(), projectCommands(json, ids(json)).commands), json);

/** A project with a drum track, its commands run into a modelled engine, its history installed as App does it. */
function rig() {
  const p = new Project();
  const m = blankModel();
  const sent: number[][] = [];
  const sink = {
    send(op: number, a = 0, b = 0, c = 0, d = 0) {
      sent.push([op, a, b, c, d]);
      run(m, [[op, a, b, c, d]]);
      commandEdits(p, op);
      return true;
    },
  };
  addDrumTrack(p, sink);
  p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
  /** The modelled engine matches a fresh load of the project, and refused nothing. */
  const agrees = () => {
    expect(m.errors).toEqual([]);
    const json = serialize(p);
    expect(view(m, json)).toEqual(loaded(json));
  };
  return { p, sink, sent, agrees };
}

const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const filterIdx = (t: SynthTrack) => t.modules.find((m) => moduleDef(m.kind).id === 'filter')!.idx;
const vcaIdx = (t: SynthTrack) => t.modules.find((m) => moduleDef(m.kind).id === 'vca')!.idx;
/** The lane-evaluation bend (automation.ts): the way along at x for a curve. */
const bendAt = (x: number, curve: number) => x ** (2 ** (-3 * curve));
/** A lane's points as [tick, value]. */
const pts = (t: SynthTrack, i: number) => t.automation[i].points.map((x) => [x.tick, x.value]);

describe('transitions', () => {
  it('each transition is one undo entry: track, patch, pattern, clip, lanes; undo removes all of it', () => {
    for (const d of TRANSITIONS) {
      const s = rig();
      const before = plain(serialize(s.p));
      const t = addTransition(s.p, s.sink, d.kind, 8 * BAR + 700)!; // inside bar 9
      expect(t, d.kind).not.toBeNull();
      // Placed by its anchor: a Riser ends on bar 9 (bars 1–8), the others start there.
      const pl = transitionPlace(8 * BAR + 700, d.bars, d.anchor);
      expect(pl).toEqual(d.anchor === 'end' ? { start: 0, bars: 8 } : { start: 8 * BAR, bars: d.bars });
      expect(s.p.history!.labels.undo).toBe(`Add ${d.label.toLowerCase()}`);
      // The track: named after the transition, its patch, selected.
      expect(t.name).toBe(d.label);
      expect(t.patchName).toBe(d.patch.name);
      expect(s.p.selectedTrackId).toBe(t.id);
      // One pattern, named after it, d.bars long, with its notes.
      expect(t.patterns).toHaveLength(1);
      const pat = currentPattern(t);
      expect(pat.name).toBe(d.label);
      expect(pat.bars).toBe(pl.bars);
      expect(pat.notes.map(({ pitch, start, len, vel }) => ({ pitch, start, len, vel }))).toEqual(d.notes(pl.bars));
      // One clip where transitionPlace put it.
      expect(t.clips.map(({ start, len, offset, patternId }) => ({ start, len, offset, patternId }))).toEqual([
        { start: pl.start, len: pl.bars * BAR, offset: 0, patternId: pat.id },
      ]);
      // Lanes: one per spec, every point inside the clip's span and the param's range.
      expect(t.automation).toHaveLength(d.lanes.length);
      for (const l of t.automation) {
        const def = targetDef(s.p, t, l.target)!;
        expect(l.enabled).toBe(true);
        expect(l.points.length).toBeGreaterThanOrEqual(2);
        for (const x of l.points) {
          expect(x.tick).toBeGreaterThanOrEqual(pl.start);
          expect(x.tick).toBeLessThan(pl.start + pl.bars * BAR); // [start, end): it moves with the clip
          expect(x.value).toBeGreaterThanOrEqual(def.min);
          expect(x.value).toBeLessThanOrEqual(def.max);
        }
      }
      s.agrees();
      // One undo takes everything; redo brings it back.
      expect(s.p.history!.undo()).toBe(true);
      expect(s.p.history!.canUndo).toBe(false);
      expect(plain(serialize(s.p))).toEqual(before);
      s.agrees();
      expect(s.p.history!.redo()).toBe(true);
      const again = s.p.tracks.at(-1) as SynthTrack;
      expect(again.name).toBe(d.label);
      expect(again.clips).toHaveLength(1);
      expect(again.automation).toHaveLength(d.lanes.length);
      s.agrees();
    }
  });

  it('Riser: 8 bars ENDING at the playhead (clicked bar 17 → bars 9–16), cutoff ramps up, amp level −24 → 0 dB', () => {
    const s = rig();
    const t = addTransition(s.p, s.sink, 'riser', 16 * BAR + 500)!; // inside bar 17
    expect(t.clips[0]).toMatchObject({ start: 8 * BAR, len: 8 * BAR });
    expect(TRANSITION_PATCHES.noiseSweep.name).toBe('Noise Sweep');
    // One bar-long note per bar, back to back.
    expect(currentPattern(t).notes.map((n) => [n.start, n.len])).toEqual(Array.from({ length: 8 }, (_, i) => [i * BAR, BAR]));
    // Both lanes inside the rack: the fader has none, so it stays the user's to set the Riser's level.
    expect(t.automation.map((l) => l.target)).toEqual([
      { kind: 'rack', module: filterIdx(t), param: 'cutoff' },
      { kind: 'rack', module: vcaIdx(t), param: 'level' },
    ]);
    // The closing points one tick before the clip's end (they move with it).
    expect(pts(t, 0)).toEqual([[8 * BAR, SWEEP_LO_HZ], [16 * BAR - 1, SWEEP_HI_HZ]]);
    expect(pts(t, 1)).toEqual([[8 * BAR, dbLevel(RISER_FROM_DB)], [16 * BAR - 1, 1]]);
    expect(RISER_FROM_DB).toBe(-24);
    // The level ramp is bent to pass the dB midpoint (−12 dB) halfway: even in dB, slow then fast.
    const c = t.automation[1].points[0].curve;
    expect(c).toBeCloseTo(dbRampCurve(RISER_FROM_DB, 0), 9);
    expect(c).toBeLessThan(0);
    const lo = dbLevel(RISER_FROM_DB);
    expect(20 * Math.log10(lo + (1 - lo) * bendAt(0.5, c))).toBeCloseTo(-12, 6);
    expect(t.automation[0].points[0].curve).toBe(0); // the cutoff is exp already: even in octaves
  });

  it('Downlifter: 4 bars, cutoff ramps down, volume 0 → −30 dB', () => {
    const s = rig();
    const t = addTransition(s.p, s.sink, 'downlifter', 4 * BAR)!;
    expect(t.patchName).toBe('Noise Sweep');
    expect(t.clips[0]).toMatchObject({ start: 4 * BAR, len: 4 * BAR });
    expect(currentPattern(t).notes).toHaveLength(4);
    expect(pts(t, 0)).toEqual([[4 * BAR, SWEEP_HI_HZ], [8 * BAR - 1, SWEEP_LO_HZ]]);
    expect(pts(t, 1)).toEqual([[4 * BAR, 1], [8 * BAR - 1, dbLevel(DOWNLIFTER_TO_DB)]]);
    expect(DOWNLIFTER_TO_DB).toBe(-30);
    const c = t.automation[1].points[0].curve;
    expect(c).toBeGreaterThan(0); // fast, then slow
    const lo = dbLevel(DOWNLIFTER_TO_DB);
    expect(20 * Math.log10(1 - (1 - lo) * bendAt(0.5, c))).toBeCloseTo(-15, 6);
  });

  it('Impact: one 1/8 hit on beat 1 of a 1-bar clip, a reverb send, no lanes', () => {
    const s = rig();
    const t = addTransition(s.p, s.sink, 'impact', 0)!;
    expect(t.patchName).toBe('Impact');
    // C4: the sub lands two octaves under the note (C2, 65 Hz); a note under C3 would put it under ~33 Hz.
    expect(currentPattern(t).notes.map(({ pitch, start, len }) => [pitch, start, len])).toEqual([[60, 0, IMPACT_HIT_TICKS]]);
    expect(t.clips[0]).toMatchObject({ start: 0, len: BAR });
    expect(t.automation).toEqual([]);
    expect(s.p.mixer.channels[t.id].params[mixParam('send_a').id]).toBe(IMPACT_REVERB_SEND_DB);
    s.agrees();
  });

  it('a Riser near the song start is shortened to the bars before the playhead; at bar 1 it starts there', () => {
    const s = rig();
    const short = addTransition(s.p, s.sink, 'riser', 3 * BAR)!; // bar 4: 3 bars before it
    expect(short.clips[0]).toMatchObject({ start: 0, len: 3 * BAR });
    expect(currentPattern(short).notes).toHaveLength(3);
    expect(pts(short, 1)).toEqual([[0, dbLevel(RISER_FROM_DB)], [3 * BAR - 1, 1]]);
    const atStart = addTransition(s.p, s.sink, 'riser', 0)!;
    expect(atStart.clips[0]).toMatchObject({ start: 0, len: 8 * BAR });
    expect(transitionPlace(MAX_SONG_TICKS, 8, 'end')).toEqual({ start: MAX_SONG_TICKS - 8 * BAR, bars: 8 });
    expect(transitionPlace(5 * BAR, 4, 'start')).toEqual({ start: 5 * BAR, bars: 4 });
    s.agrees();
  });

  it('a second one gets a free name; the clip stays inside the song', () => {
    const s = rig();
    addTransition(s.p, s.sink, 'riser', 0);
    expect(addTransition(s.p, s.sink, 'riser', 0)!.name).toBe('Riser 2');
    expect(transitionStart(MAX_SONG_TICKS, 8)).toBe(MAX_SONG_TICKS - 8 * BAR);
    expect(transitionStart(NaN, 8)).toBe(0);
    expect(transitionStart(-5, 1)).toBe(0);
    const t = addTransition(s.p, s.sink, 'downlifter', MAX_SONG_TICKS)!;
    expect(t.clips[0]).toMatchObject({ start: MAX_SONG_TICKS - 4 * BAR, len: 4 * BAR });
    expect(t.automation[0].points.at(-1)!.tick).toBe(MAX_SONG_TICKS - 1);
    s.agrees();
  });

  it('the sweep follows its clip: moved, duplicated, and one undo each', () => {
    const s = rig();
    const t = addTransition(s.p, s.sink, 'riser', 16 * BAR)!; // bars 9–16
    const clip = t.clips[0];
    expect(moveClips(s.p, s.sink, [clip.id], 8 * BAR)).toBe(true); // bars 17–24
    expect(pts(t, 0)).toEqual([[16 * BAR, SWEEP_LO_HZ], [24 * BAR - 1, SWEEP_HI_HZ]]);
    expect(pts(t, 1)).toEqual([[16 * BAR, dbLevel(RISER_FROM_DB)], [24 * BAR - 1, 1]]);
    expect(t.automation[1].points[0].curve).toBeCloseTo(dbRampCurve(RISER_FROM_DB, 0), 9); // the bend goes along
    expect(s.p.history!.labels.undo).toBe('Move clips');
    s.agrees();
    // A copy right after it gets its own sweep; the original keeps its end (no shared tick).
    const [copy] = duplicateClips(s.p, s.sink, [clip.id]);
    expect(copy.start).toBe(24 * BAR);
    expect(pts(t, 0)).toEqual([
      [16 * BAR, SWEEP_LO_HZ], [24 * BAR - 1, SWEEP_HI_HZ], [24 * BAR, SWEEP_LO_HZ], [32 * BAR - 1, SWEEP_HI_HZ],
    ]);
    expect(s.p.history!.labels.undo).toBe('Duplicate clips');
    s.agrees();
    // One undo takes the copy and its points; another puts the clip and its sweep back.
    s.p.history!.undo();
    expect(t.clips).toHaveLength(1);
    expect(pts(s.p.tracks.at(-1) as SynthTrack, 0)).toEqual([[16 * BAR, SWEEP_LO_HZ], [24 * BAR - 1, SWEEP_HI_HZ]]);
    s.p.history!.undo();
    const back = s.p.tracks.at(-1) as SynthTrack;
    expect(back.clips[0].start).toBe(8 * BAR);
    expect(pts(back, 0)).toEqual([[8 * BAR, SWEEP_LO_HZ], [16 * BAR - 1, SWEEP_HI_HZ]]);
    s.agrees();
  });

  it('refuses while a project loads (nothing changed)', () => {
    const s = rig();
    s.p.loading = true;
    for (const d of TRANSITIONS) {
      expect(transitionBlocked(s.p, d.kind)).toMatch(/Loading/);
      expect(addTransition(s.p, s.sink, d.kind, 0)).toBeNull();
    }
    s.p.loading = false;
    expect(s.p.tracks).toHaveLength(1);
  });

  it('refuses with nothing changed when the tracks or the automation lanes are full', () => {
    const s = rig();
    // Fill the automation lanes but one: a sweep needs two, an Impact none.
    const params = ['fader', 'pan', 'eq_hp', 'eq_low', 'eq_high', 'send_a', 'send_b'];
    for (let i = 0; i < MAX_AUTO_LANES - 1; i++) {
      // A track takes each target once: spread over drum tracks.
      const owner = s.p.tracks[Math.floor(i / params.length)] ?? addDrumTrack(s.p, s.sink)!;
      expect(addLane(s.p, s.sink, owner.id, { kind: 'mix', param: params[i % params.length] }), `lane ${i}`).not.toBeNull();
    }
    const kinds: TransitionKind[] = ['riser', 'downlifter'];
    for (const k of kinds) {
      expect(transitionBlocked(s.p, k)).toMatch(/2 free automation lanes/);
      const snap = { json: JSON.stringify(serialize(s.p)), sent: s.sent.length, undo: s.p.history!.labels.undo };
      expect(addTransition(s.p, s.sink, k, 0)).toBeNull();
      expect({ json: JSON.stringify(serialize(s.p)), sent: s.sent.length, undo: s.p.history!.labels.undo }).toEqual(snap);
    }
    expect(transitionBlocked(s.p, 'impact')).toBeNull();
    // Tracks full: every kind is refused.
    while (s.p.tracks.length < MAX_TRACKS) addDrumTrack(s.p, s.sink);
    for (const k of ['riser', 'downlifter', 'impact'] as const) {
      expect(transitionBlocked(s.p, k)).toMatch(/maximum/);
      const json = JSON.stringify(serialize(s.p));
      expect(addTransition(s.p, s.sink, k, 0)).toBeNull();
      expect(JSON.stringify(serialize(s.p))).toBe(json);
    }
  });
});
