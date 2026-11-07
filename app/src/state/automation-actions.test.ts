import { describe, expect, it } from 'vitest';
import { MAX_AUTO_LANES, MAX_AUTO_POINTS, MIX_MASTER, Op, autoPoint, packAutoParam } from '../audio/protocol';
import { moduleDef, paramIndex } from '../audio/catalog';
import { mixParam } from '../audio/mixerCatalog';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { blankModel, run, view } from '../history/engineModel';
import { projectCommands } from '../project/commands';
import { serialize } from '../project/serialize';
import type { ProjectJson } from '../project/schema';
import { fromPos } from '../ui/rack/knobMath';
import { addDrumTrack, removeTrack } from './actions';
import { addAudioTrack } from './audio-actions';
import {
  addLane, addPoint, deletePoints, drawPoints, movePoints, overrideLane, removeLane, setLaneEnabled, setPointShape,
} from './automation-actions';
import { commandEdits } from './edits';
import { STARTER_PATCHES } from './patches';
import { Project } from './project.svelte';
import type { AutomationLane } from './project.svelte';
import { addModule, addSynthTrack, loadPatch, removeModule, rollbackRefusedAdd } from './rack-actions';

const ids = (json: ProjectJson) => new Map(json.samples.map((s) => [s.id, s.id]));
/** The engine state a fresh load of `json` builds. */
const loaded = (json: ProjectJson) => view(run(blankModel(), projectCommands(json, ids(json)).commands), json);

/** A project whose commands run into a modelled engine (and mark edits, as App's onCommand does). */
function rig(o: { history?: boolean } = {}) {
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
  if (o.history) p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
  /** The modelled engine matches a fresh load of the project, and refused nothing. */
  const agrees = () => {
    expect(m.errors).toEqual([]);
    const json = serialize(p);
    expect(view(m, json)).toEqual(loaded(json));
  };
  return { p, m, sent, sink, agrees };
}

/** Points as [tick, value, hold], in model (tick) order. */
const pts = (l: AutomationLane) => l.points.map((x) => [x.tick, x.value, x.hold]);
/** The model's invariants: sorted by tick, unique ticks, engine idx 0..n-1. */
function invariants(l: AutomationLane) {
  for (let i = 1; i < l.points.length; i++) expect(l.points[i].tick).toBeGreaterThan(l.points[i - 1].tick);
  expect(l.points.map((x) => x.idx).sort((a, b) => a - b)).toEqual(l.points.map((_, i) => i));
}

describe('automation actions', () => {
  it('addLane takes the lowest free engine lane and sends AUTO_LANE_SET', () => {
    const { p, sent, sink, agrees } = rig();
    const d = addDrumTrack(p, sink)!;
    const s = addSynthTrack(p, sink, 'Bass', STARTER_PATCHES[0])!;
    sent.length = 0;
    const a = addLane(p, sink, d.id, { kind: 'mix', param: 'fader' })!;
    expect(a).toMatchObject({ lane: 0, target: { kind: 'mix', param: 'fader' }, enabled: true, points: [] });
    expect(d.automation).toEqual([a]);
    expect(sent).toEqual([[Op.AUTO_LANE_SET, 0, 1, d.slot, mixParam('fader').id]]);
    const filter = s.modules.find((x) => x.kind === moduleDef('filter').kind)!;
    sent.length = 0;
    const b = addLane(p, sink, s.id, { kind: 'rack', module: filter.idx, param: 'cutoff' })!;
    expect(b.lane).toBe(1);
    expect(sent).toEqual([[Op.AUTO_LANE_SET, 1, 2, s.slot, packAutoParam(filter.idx, paramIndex(moduleDef('filter'), 'cutoff'))]]);
    const c = addLane(p, sink, 'master', { kind: 'mix', param: 'limiter_ceiling' })!;
    expect(c.lane).toBe(2);
    expect(p.mixer.automation).toEqual([{ channel: 'master', lane: c }]);
    expect(sent.at(-1)).toEqual([Op.AUTO_LANE_SET, 2, 1, MIX_MASTER, mixParam('limiter_ceiling').id]);
    // A freed engine lane is the next one taken.
    expect(removeLane(p, sink, a.id)).toBe(true);
    expect(sent.at(-1)).toEqual([Op.AUTO_LANE_CLEAR, 0, 0, 0, 0]);
    expect(d.automation).toEqual([]);
    expect(addLane(p, sink, d.id, { kind: 'mix', param: 'pan' })!.lane).toBe(0);
    setLaneEnabled(p, sink, b.id, false);
    expect(sent.at(-1)).toEqual([Op.AUTO_LANE_ENABLE, 1, 0, 0, 0]);
    expect(b.enabled).toBe(false);
    agrees();
  });

  it('lane and point caps refuse cleanly', () => {
    const { p, sent, sink, agrees } = rig({ history: true });
    const tracks = Array.from({ length: 5 }, () => addDrumTrack(p, sink)!);
    const audio = addAudioTrack(p, sink)!;
    const before = () => ({ json: JSON.stringify(serialize(p)), sent: sent.length, undo: p.history!.canUndo, version: p.version });
    // Refused targets: nothing changes, nothing is sent, no undo entry.
    p.history!.clear();
    const s0 = before();
    expect(addLane(p, sink, tracks[0].id, { kind: 'mix', param: 'mute' })).toBeNull(); // integer
    expect(addLane(p, sink, tracks[0].id, { kind: 'mix', param: 'nope' })).toBeNull();
    expect(addLane(p, sink, tracks[0].id, { kind: 'mix', param: 'rev_size' })).toBeNull(); // not on a track strip
    expect(addLane(p, sink, tracks[0].id, { kind: 'rack', module: 0, param: 'cutoff' })).toBeNull(); // no rack on drums
    expect(addLane(p, sink, audio.id, { kind: 'rack', module: 0, param: 'cutoff' })).toBeNull(); // nor on Audio
    expect(addLane(p, sink, 'nobody', { kind: 'mix', param: 'fader' })).toBeNull();
    expect(addLane(p, sink, 'master', { kind: 'mix', param: 'pan' })).toBeNull();
    expect(before()).toEqual(s0);

    // 64 lanes over 5 tracks; the 65th, and a second lane on one target, are refused.
    const targets = tracks.flatMap((t) =>
      ['fader', 'pan', 'eq_hp', 'eq_low', 'eq_mid_freq', 'eq_mid_gain', 'eq_mid_q', 'eq_high', 'comp_threshold', 'comp_ratio', 'comp_attack', 'comp_release', 'comp_makeup', 'send_a', 'send_b']
        .map((param) => ({ t, param })));
    for (const { t, param } of targets.slice(0, MAX_AUTO_LANES - 1)) expect(addLane(p, sink, t.id, { kind: 'mix', param })).not.toBeNull();
    const s1a = before();
    expect(addLane(p, sink, tracks[0].id, { kind: 'mix', param: 'fader' })).toBeNull(); // that target has a lane
    expect(before()).toEqual(s1a);
    const t63 = targets[MAX_AUTO_LANES - 1];
    expect(addLane(p, sink, t63.t.id, { kind: 'mix', param: t63.param })).not.toBeNull();
    const s1 = before();
    const extra = targets[MAX_AUTO_LANES];
    expect(addLane(p, sink, extra.t.id, { kind: 'mix', param: extra.param })).toBeNull();
    expect(addLane(p, sink, 'master', { kind: 'mix', param: 'fader' })).toBeNull();
    expect(before()).toEqual(s1);
    const lanes = tracks.flatMap((t) => t.automation);
    expect(new Set(lanes.map((l) => l.lane)).size).toBe(MAX_AUTO_LANES);

    // 512 points; the 513th, and a tick already used, are refused.
    const lane = lanes[0];
    for (let i = 0; i < MAX_AUTO_POINTS; i++) expect(addPoint(p, sink, lane.id, { tick: i * 7, value: -i / 10 })).not.toBeNull();
    invariants(lane);
    const s2 = before();
    expect(addPoint(p, sink, lane.id, { tick: 99999, value: 0 })).toBeNull();
    expect(drawPoints(p, sink, lane.id, [{ tick: 99999, value: 0 }, { tick: 100500, value: -30 }])).toBe(false);
    expect(before()).toEqual(s2);
    deletePoints(p, sink, lane.id, [lane.points[5].id]);
    expect(addPoint(p, sink, lane.id, { tick: 7, value: 0 })).toBeNull(); // tick 7 is used
    const last = addPoint(p, sink, lane.id, { tick: 99999, value: 100 })!; // clamped to the range
    expect(last.value).toBe(6);
    expect(last.idx).toBe(MAX_AUTO_POINTS - 1); // the freed idx (dense)
    invariants(lane);
    agrees();
  });

  it('point edits keep engine idx dense and send what changed', () => {
    const { p, sent, sink, agrees } = rig();
    const d = addDrumTrack(p, sink)!;
    const l = addLane(p, sink, d.id, { kind: 'mix', param: 'fader' })!;
    sent.length = 0;
    const a = addPoint(p, sink, l.id, { tick: 960, value: -6 })!;
    expect(sent).toEqual([[Op.AUTO_POINT_SET, autoPoint(l.lane, 0), 960, -6, 0]]);
    addPoint(p, sink, l.id, { tick: 0, value: -60, hold: true });
    addPoint(p, sink, l.id, { tick: 1920, value: 0 });
    addPoint(p, sink, l.id, { tick: 2880.4, value: -3 }); // ticks are whole
    expect(pts(l)).toEqual([[0, -60, true], [960, -6, false], [1920, 0, false], [2880, -3, false]]);
    expect(l.points.map((x) => x.idx)).toEqual([1, 0, 2, 3]);
    sent.length = 0;
    setPointShape(p, sink, l.id, [a.id], true);
    expect(sent).toEqual([[Op.AUTO_POINT_SET, autoPoint(l.lane, 0), 960, -6, 1]]);
    // Deleting idx 0 and 1 moves the points at idx 2 and 3 down into them.
    deletePoints(p, sink, l.id, [l.points[0].id, a.id]);
    expect(pts(l)).toEqual([[1920, 0, false], [2880, -3, false]]);
    invariants(l);
    agrees();
  });

  it('movePoints never reorders', () => {
    const { p, sink, agrees } = rig();
    const d = addDrumTrack(p, sink)!;
    const l = addLane(p, sink, d.id, { kind: 'mix', param: 'fader' })!;
    for (const [tick, value] of [[0, -60], [960, -12], [1920, -6], [2880, 0]]) addPoint(p, sink, l.id, { tick, value });
    const id = (tick: number) => l.points.find((x) => x.tick === tick)!.id;
    const ids0 = l.points.map((x) => x.id);
    // One point: stops one tick short of its right neighbour.
    movePoints(p, sink, l.id, [id(960)], 5000, 0);
    expect(l.points.map((x) => x.tick)).toEqual([0, 1919, 1920, 2880]);
    // Two together: the group keeps its shape and stops at the next neighbour.
    movePoints(p, sink, l.id, [id(1919), id(1920)], 5000, 0);
    expect(l.points.map((x) => x.tick)).toEqual([0, 2878, 2879, 2880]);
    // Left: never below 0; never past the left neighbour.
    movePoints(p, sink, l.id, [id(0)], -100, 0);
    expect(l.points[0].tick).toBe(0);
    movePoints(p, sink, l.id, [id(2878), id(2879)], -10000, 0);
    expect(l.points.map((x) => x.tick)).toEqual([0, 1, 2, 2880]);
    // All of them: the song start and end bound the group.
    movePoints(p, sink, l.id, l.points.map((x) => x.id), 3000, 0);
    expect(l.points.map((x) => x.tick)).toEqual([3000, 3001, 3002, 5880]);
    expect(l.points.map((x) => x.id)).toEqual(ids0); // same points, same order
    invariants(l);
    // Values move in knob position (dValue: a fraction of the travel), clamped to the range.
    const before = l.points.map((x) => x.value);
    movePoints(p, sink, l.id, [l.points[3].id], 0, 0.5);
    expect(l.points[3].value).toBe(6);
    movePoints(p, sink, l.id, [l.points[0].id, l.points[1].id], 0, -2);
    expect(l.points.map((x) => x.value)).toEqual([-60, -60, before[2], 6]);
    movePoints(p, sink, l.id, [l.points[2].id], 0, 6 / 66); // the travel is 66 dB: -6 dB + 6 dB
    expect(l.points[2].value).toBeCloseTo(0, 9);
    agrees();
  });

  it('movePoints from a gesture origin loses no movement', () => {
    const { p, sink, agrees } = rig();
    const d = addDrumTrack(p, sink)!;
    const l = addLane(p, sink, d.id, { kind: 'mix', param: 'fader' })!;
    for (const [tick, value] of [[0, -60], [960, -12], [1920, 0], [2880, -30]]) addPoint(p, sink, l.id, { tick, value });
    const group = [l.points[1].id, l.points[2].id];
    const origin = new Map(l.points.map((x) => [x.id, { tick: x.tick, value: x.value }]));
    const shape = pts(l);
    // A drag past the top edge (cumulative deltas, as each pointermove sends them) squashes the group there ...
    for (const dv of [0.05, 0.1, 0.2, 0.4]) movePoints(p, sink, l.id, group, 0, dv, origin);
    expect(l.points[1].value).toBe(6);
    expect(l.points[2].value).toBe(6);
    // ... and back to the start restores its shape exactly (the squash is not baked in).
    for (const dv of [0.2, 0.05, 0]) movePoints(p, sink, l.id, group, 0, dv, origin);
    expect(pts(l)).toEqual(shape);
    // Ticks likewise: cumulative from the origin, clamped against the unmoved neighbours.
    movePoints(p, sink, l.id, group, 5000, 0, origin);
    expect(l.points.map((x) => x.tick)).toEqual([0, 1919, 2879, 2880]);
    movePoints(p, sink, l.id, group, 100, 0, origin);
    expect(l.points.map((x) => x.tick)).toEqual([0, 1060, 2020, 2880]);
    invariants(l);
    agrees();

    // An exp param with min 0 (glide): a point at 0 dragged up in steps smaller than the zero zone leaves 0.
    const s = addSynthTrack(p, sink, 'Bass', STARTER_PATCHES[0])!;
    const midi = s.modules.find((x) => x.kind === moduleDef('midi_in').kind)!;
    const g = addLane(p, sink, s.id, { kind: 'rack', module: midi.idx, param: 'glide' })!;
    addPoint(p, sink, g.id, { tick: 0, value: 0 });
    const o2 = new Map(g.points.map((x) => [x.id, { tick: x.tick, value: x.value }]));
    for (let k = 1; k <= 20; k++) movePoints(p, sink, g.id, [g.points[0].id], 0, k * 0.005, o2);
    expect(g.points[0].value).toBeGreaterThan(0);
    expect(g.points[0].value).toBeCloseTo(fromPos(moduleDef('midi_in').params[paramIndex(moduleDef('midi_in'), 'glide')], 0.1), 9);
    agrees();
  });

  it('drawPoints replaces the drawn range', () => {
    const { p, sink, agrees } = rig({ history: true });
    const s = addSynthTrack(p, sink, 'Bass', STARTER_PATCHES[0])!;
    const filter = s.modules.find((x) => x.kind === moduleDef('filter').kind)!;
    const l = addLane(p, sink, s.id, { kind: 'rack', module: filter.idx, param: 'cutoff' })!;
    for (const [tick, value] of [[0, 20000], [960, 500], [1920, 800], [3840, 100]]) addPoint(p, sink, l.id, { tick, value });
    p.history!.clear();
    // A freehand stroke from right to left over 800..2000: a straight line in knob space (exp: a log ramp in Hz).
    const samples = Array.from({ length: 121 }, (_, i) => ({ tick: 2000 - i * 10, value: 100 * Math.pow(10, (i / 120) * 2) }));
    expect(drawPoints(p, sink, l.id, samples)).toBe(true);
    // 960 and 1920 are gone, the ends of the stroke are points, the rest is thinned away.
    expect(l.points.map((x) => x.tick)).toEqual([0, 800, 2000, 3840]);
    expect(l.points[1].value).toBeCloseTo(10000, 6);
    expect(l.points[2].value).toBeCloseTo(100, 9);
    invariants(l);
    // One gesture, one undo entry.
    expect(p.history!.undo()).toBe(true);
    expect(p.history!.canUndo).toBe(false);
    expect(l.points.map((x) => x.tick)).toEqual([0, 960, 1920, 3840]);
    agrees();
    p.history!.redo();
    // A wiggle keeps more points, each within 0.5 % of the knob travel of the stroke.
    const wiggle = Array.from({ length: 200 }, (_, i) => ({ tick: 400 + i * 5, value: 1000 * Math.pow(2, Math.sin(i / 10)) }));
    drawPoints(p, sink, l.id, wiggle);
    expect(l.points.length).toBeGreaterThan(8);
    expect(l.points.filter((x) => x.tick >= 400 && x.tick <= 1395).length).toBe(l.points.length - 3); // 0, 2000 and 3840 kept
    invariants(l);
    agrees();
    // Nothing to draw: refused.
    expect(drawPoints(p, sink, l.id, [])).toBe(false);
  });

  it('overrideLane is not an edit', () => {
    const { p, sent, sink } = rig({ history: true });
    const d = addDrumTrack(p, sink)!;
    const l = addLane(p, sink, d.id, { kind: 'mix', param: 'fader' })!;
    addPoint(p, sink, l.id, { tick: 0, value: -10 });
    p.history!.clear();
    const v = p.version;
    sent.length = 0;
    expect(overrideLane(p, sink, l.id)).toBe(true);
    expect(sent).toEqual([[Op.AUTO_OVERRIDE, l.lane, 0, 0, 0]]);
    expect(p.version).toBe(v);
    expect(p.history!.canUndo).toBe(false);
    expect(overrideLane(p, sink, 'nope')).toBe(false);
  });

  it('removeModule, a patch load and removeTrack drop the lanes the engine drops', () => {
    const { p, sink, agrees } = rig({ history: true });
    const s = addSynthTrack(p, sink, 'Bass', STARTER_PATCHES[0])!;
    const filter = s.modules.find((x) => x.kind === moduleDef('filter').kind)!;
    const rev = addModule(p, sink, s.id, 'reverb')!;
    const cut = addLane(p, sink, s.id, { kind: 'rack', module: filter.idx, param: 'cutoff' })!;
    addPoint(p, sink, cut.id, { tick: 0, value: 300 });
    const size = addLane(p, sink, s.id, { kind: 'rack', module: rev, param: 'size' })!;
    const fader = addLane(p, sink, s.id, { kind: 'mix', param: 'fader' })!;
    const master = addLane(p, sink, 'master', { kind: 'mix', param: 'fader' })!;
    removeModule(p, sink, s.id, filter.idx);
    expect(s.automation.map((l) => l.id)).toEqual([size.id, fader.id]);
    agrees();
    // Undo brings the module and its lane back (same engine lane, same points).
    p.history!.undo();
    expect(s.automation.map((l) => [l.lane, l.target])).toEqual([[cut.lane, cut.target], [size.lane, size.target], [fader.lane, fader.target]]);
    expect(pts(s.automation[0])).toEqual([[0, 300, false]]);
    agrees();
    // A patch load clears the rack (RACK_CLEAR): every rack lane goes, the mixer lanes stay.
    loadPatch(p, sink, s.id, STARTER_PATCHES[1]);
    expect(s.automation.map((l) => l.id)).toEqual([fader.id]);
    agrees();
    // A refused (rolled back) module add takes its lanes along.
    const extra = addModule(p, sink, s.id, 'chorus')!;
    addLane(p, sink, s.id, { kind: 'rack', module: extra, param: 'rate' });
    rollbackRefusedAdd(p, s.slot, extra, moduleDef('chorus').kind);
    expect(s.automation.map((l) => l.id)).toEqual([fader.id]);
    // removeTrack: the track's lanes go with it; the Master row's stay.
    removeTrack(p, sink, s.id);
    expect(p.mixer.automation.map((x) => x.lane.id)).toEqual([master.id]);
    p.history!.undo();
    expect(p.tracks[0].automation.map((l) => l.lane)).toEqual([fader.lane]);
    agrees();
  });
});
