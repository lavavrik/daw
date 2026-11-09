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
import type { SynthTrack } from './project.svelte';
import {
  DOWNLIFTER_TO_DB, IMPACT_HIT_TICKS, IMPACT_REVERB_SEND_DB, RISER_FROM_DB, SWEEP_HI_HZ, SWEEP_LO_HZ, TRANSITIONS,
  addTransition, transitionBlocked, transitionStart,
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
/** A lane's points as [tick, value]. */
const pts = (t: SynthTrack, i: number) => t.automation[i].points.map((x) => [x.tick, x.value]);

describe('transitions', () => {
  it('each transition is one undo entry: track, patch, pattern, clip, lanes; undo removes all of it', () => {
    for (const d of TRANSITIONS) {
      const s = rig();
      const before = plain(serialize(s.p));
      const t = addTransition(s.p, s.sink, d.kind, 8 * BAR + 700)!;
      expect(t, d.kind).not.toBeNull();
      expect(s.p.history!.labels.undo).toBe(`Add ${d.label.toLowerCase()}`);
      // The track: named after the transition, its patch, selected.
      expect(t.name).toBe(d.label);
      expect(t.patchName).toBe(d.patch.name);
      expect(s.p.selectedTrackId).toBe(t.id);
      // One pattern, named after it, d.bars long, with its notes.
      expect(t.patterns).toHaveLength(1);
      const pat = currentPattern(t);
      expect(pat.name).toBe(d.label);
      expect(pat.bars).toBe(d.bars);
      expect(pat.notes.map(({ pitch, start, len, vel }) => ({ pitch, start, len, vel }))).toEqual(d.notes);
      // One clip at the playhead's bar (bar 9), d.bars long.
      expect(t.clips.map(({ start, len, offset, patternId }) => ({ start, len, offset, patternId }))).toEqual([
        { start: 8 * BAR, len: d.bars * BAR, offset: 0, patternId: pat.id },
      ]);
      // Lanes: one per spec, every point inside the clip's span and the param's range.
      expect(t.automation).toHaveLength(d.lanes.length);
      for (const l of t.automation) {
        const def = targetDef(t, l.target)!;
        expect(l.enabled).toBe(true);
        expect(l.points.length).toBeGreaterThanOrEqual(2);
        for (const x of l.points) {
          expect(x.tick).toBeGreaterThanOrEqual(8 * BAR);
          expect(x.tick).toBeLessThanOrEqual((8 + d.bars) * BAR);
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

  it('Riser: 8 bars, cutoff ramps up, volume −24 → 0 dB', () => {
    const s = rig();
    const t = addTransition(s.p, s.sink, 'riser', 8 * BAR)!;
    expect(TRANSITION_PATCHES.noiseSweep.name).toBe('Noise Sweep');
    // One bar-long note per bar, back to back.
    expect(currentPattern(t).notes.map((n) => [n.start, n.len])).toEqual(Array.from({ length: 8 }, (_, i) => [i * BAR, BAR]));
    expect(t.automation.map((l) => l.target)).toEqual([
      { kind: 'rack', module: filterIdx(t), param: 'cutoff' },
      { kind: 'mix', param: 'fader' },
    ]);
    expect(pts(t, 0)).toEqual([[8 * BAR, SWEEP_LO_HZ], [16 * BAR, SWEEP_HI_HZ]]);
    expect(pts(t, 1)).toEqual([[8 * BAR, RISER_FROM_DB], [16 * BAR, 0]]);
    expect(RISER_FROM_DB).toBe(-24);
  });

  it('Downlifter: 4 bars, cutoff ramps down, volume 0 → −30 dB', () => {
    const s = rig();
    const t = addTransition(s.p, s.sink, 'downlifter', 4 * BAR)!;
    expect(t.patchName).toBe('Noise Sweep');
    expect(t.clips[0]).toMatchObject({ start: 4 * BAR, len: 4 * BAR });
    expect(currentPattern(t).notes).toHaveLength(4);
    expect(pts(t, 0)).toEqual([[4 * BAR, SWEEP_HI_HZ], [8 * BAR, SWEEP_LO_HZ]]);
    expect(pts(t, 1)).toEqual([[4 * BAR, 0], [8 * BAR, DOWNLIFTER_TO_DB]]);
    expect(DOWNLIFTER_TO_DB).toBe(-30);
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

  it('a second one gets a free name; the clip stays inside the song', () => {
    const s = rig();
    addTransition(s.p, s.sink, 'riser', 0);
    expect(addTransition(s.p, s.sink, 'riser', 0)!.name).toBe('Riser 2');
    expect(transitionStart(MAX_SONG_TICKS, 8)).toBe(MAX_SONG_TICKS - 8 * BAR);
    expect(transitionStart(NaN, 8)).toBe(0);
    expect(transitionStart(-5, 1)).toBe(0);
    const t = addTransition(s.p, s.sink, 'downlifter', MAX_SONG_TICKS)!;
    expect(t.clips[0]).toMatchObject({ start: MAX_SONG_TICKS - 4 * BAR, len: 4 * BAR });
    expect(t.automation[0].points.at(-1)!.tick).toBe(MAX_SONG_TICKS);
    s.agrees();
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
