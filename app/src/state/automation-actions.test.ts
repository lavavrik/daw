import { describe, expect, it } from 'vitest';
import { BAR_TICKS, MAX_AUTO_LANES, MAX_AUTO_POINTS, MAX_SONG_TICKS, MIX_MASTER, Op, autoPoint, packAutoParam } from '../audio/protocol';
import { moduleDef, paramIndex } from '../audio/catalog';
import { mixParam } from '../audio/mixerCatalog';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { blankModel, run, view } from '../history/engineModel';
import { projectCommands } from '../project/commands';
import { serialize } from '../project/serialize';
import type { ProjectJson } from '../project/schema';
import { fromPos, toPos } from '../ui/rack/knobMath';
import { addDrumTrack, removeTrack } from './actions';
import { addAudioTrack } from './audio-actions';
import {
  DUCK_CURVE, DUCK_DIP_TICKS, SHAPE_PRESETS, SINE_BACK_CURVE, SINE_OUT_CURVE,
  addLane, addPoint, deletePoints, drawPoints, insertShape, movePoints, overrideLane, removeLane, setLaneEnabled, setPointCurve,
  setPointShape, shapePoints, shapeRange,
} from './automation-actions';
import type { AutoShape } from './automation-actions';
import { laneValueAt } from './automation';
import { commandEdits, edit } from './edits';
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
    // The fader's travel is its law (plan 19): -6 dB sits at 0.63, 0 dB at 0.75.
    movePoints(p, sink, l.id, [l.points[2].id], 0, 0.12);
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
    // (-12 dB is at 0.516 of the fader travel: half the travel takes it past the top.)
    for (const dv of [0.05, 0.1, 0.2, 0.5]) movePoints(p, sink, l.id, group, 0, dv, origin);
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

  it('setPointCurve: one edit, SET-proof, undoable (plan 16)', () => {
    const { p, sent, sink, agrees } = rig({ history: true });
    const d = addDrumTrack(p, sink)!;
    const l = addLane(p, sink, d.id, { kind: 'mix', param: 'fader' })!;
    for (const [tick, value] of [[0, -60], [960, -12], [1920, 0]]) addPoint(p, sink, l.id, { tick, value });
    const a = l.points[0];
    p.history!.clear();
    const v = p.version;
    sent.length = 0;
    expect(setPointCurve(p, sink, d.id, l.id, a.id, 0.5)).toBe(true);
    expect(sent).toEqual([[Op.AUTO_POINT_CURVE, autoPoint(l.lane, a.idx), 0.5, 0, 0]]);
    expect(a.curve).toBe(0.5);
    expect(p.version).toBeGreaterThan(v);
    expect(p.history!.labels.undo).toBe('Curve');
    agrees();
    // Saved as the point's 4th element; a straight point stays [tick, value, hold].
    const saved = () => serialize(p).tracks.find((t) => t.slot === d.slot)!.automation[0].points;
    expect(saved()).toEqual([[0, -60, 0, 0.5], [960, -12, 0], [1920, 0, 0]]);
    // Clamped to -1..1; refused when nothing changes, for NaN, or no such point / lane / owner.
    expect(setPointCurve(p, sink, d.id, l.id, a.id, 3)).toBe(true);
    expect(a.curve).toBe(1);
    sent.length = 0;
    expect(setPointCurve(p, sink, d.id, l.id, a.id, 1)).toBe(false);
    expect(setPointCurve(p, sink, d.id, l.id, a.id, NaN)).toBe(false);
    expect(setPointCurve(p, sink, d.id, l.id, 'nope', 0.2)).toBe(false);
    expect(setPointCurve(p, sink, d.id, 'nope', a.id, 0.2)).toBe(false);
    expect(setPointCurve(p, sink, 'master', l.id, a.id, 0.2)).toBe(false);
    expect(sent).toEqual([]);
    // A move sends SET (which resets the engine's curve), then the CURVE again.
    movePoints(p, sink, l.id, [a.id], 0, 0.1);
    expect(sent.map((c) => c[0])).toEqual([Op.AUTO_POINT_SET, Op.AUTO_POINT_CURVE]);
    expect(a.curve).toBe(1);
    agrees();
    // Hold, and back: the curve is kept (a hold point ignores it).
    setPointShape(p, sink, l.id, [a.id], true);
    setPointShape(p, sink, l.id, [a.id], false);
    expect(a.curve).toBe(1);
    agrees();
    // Undo, step by step, back to the straight point; redo brings the curve back.
    for (let k = 0; k < 4; k++) p.history!.undo();
    expect(l.points[0].curve).toBe(0.5);
    p.history!.undo();
    expect(p.tracks[0].automation[0].points[0].curve).toBe(0);
    expect(saved()).toEqual([[0, -60, 0], [960, -12, 0], [1920, 0, 0]]);
    agrees();
    p.history!.redo();
    expect(p.tracks[0].automation[0].points[0].curve).toBe(0.5);
    agrees();
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

  // ---- Shapes (plan 28 Task 2) ----------------------------------------------------------
  const BAR = BAR_TICKS;
  const BEAT = BAR / 4;
  const preset = (id: string): AutoShape => SHAPE_PRESETS.find((x) => x.id === id)!.shape;
  const cutoff = moduleDef('filter').params.find((d) => d.name === 'cutoff')!; // exp, 20..20000 Hz
  const glide = moduleDef('midi_in').params.find((d) => d.name === 'glide')!; // exp from 0: a zero zone
  const defs = { cutoff, glide, fader: mixParam('fader'), pan: mixParam('pan') };
  const FOUR = { start: 0, end: 4 * BAR };

  it('shapePoints: point counts and values over 4 bars', () => {
    const d = defs.cutoff;
    const at = (shape: AutoShape) => shapePoints(shape, d, FOUR);
    const pos = (x: { value: number }) => toPos(d, x.value);
    // Ramps: two points, a straight line (in knob position: logarithmic in Hz).
    expect(at(preset('ramp-up'))).toEqual([
      { tick: 0, value: d.min, hold: false, curve: 0 }, { tick: 4 * BAR, value: d.max, hold: false, curve: 0 },
    ]);
    expect(at(preset('ramp-down')).map((x) => [x.tick, x.value])).toEqual([[0, d.max], [4 * BAR, d.min]]);
    // Duck: every beat the top, a fast dip, a curved recovery; the end back at the top.
    const duck = at(preset('duck'));
    expect(duck).toHaveLength(33);
    for (let b = 0; b < 16; b++) {
      expect(duck[2 * b]).toEqual({ tick: b * BEAT, value: d.max, hold: false, curve: 0 });
      expect(duck[2 * b + 1]).toEqual({ tick: b * BEAT + DUCK_DIP_TICKS, value: d.min, hold: false, curve: DUCK_CURVE });
    }
    expect(duck[32]).toEqual({ tick: 4 * BAR, value: d.max, hold: false, curve: 0 });
    // Sines: mid, top, mid, bottom per cycle, curved; a whole number of cycles ends on the mid line.
    for (const [id, period, n] of [['sine-4', BAR / 4, 65], ['sine-2', BAR / 2, 33], ['sine-1', BAR, 17]] as const) {
      const s = at(preset(id));
      expect(s).toHaveLength(n);
      expect(s.map((x) => x.tick)).toEqual(Array.from({ length: n }, (_, i) => (i * period) / 4));
      s.forEach((x, i) => {
        expect(pos(x)).toBeCloseTo([0.5, 1, 0.5, 0][i % 4], 9);
        expect(x.hold).toBe(false);
        expect(x.curve).toBe(i === n - 1 ? 0 : i % 2 === 0 ? SINE_OUT_CURVE : SINE_BACK_CURVE);
      });
      expect(s.filter((x) => x.value === d.max)).toHaveLength((4 * BAR) / period); // one top per cycle
    }
    // Gates: hold points, open (max) for the first half of each step, closed (min) for the second.
    for (const [id, period, n] of [['gate-8', BAR / 8, 65], ['gate-16', BAR / 16, 129]] as const) {
      const g = at(preset(id));
      expect(g).toHaveLength(n);
      g.slice(0, -1).forEach((x, i) => expect(x).toEqual({ tick: (i * period) / 2, value: i % 2 ? d.min : d.max, hold: true, curve: 0 }));
      expect(g.at(-1)).toEqual({ tick: 4 * BAR, value: d.max, hold: false, curve: 0 });
    }
  });

  it('shapePoints: values stay in the range; lo / hi; a cycle cut short; the sine is a sine', () => {
    for (const d of Object.values(defs)) {
      for (const { shape } of SHAPE_PRESETS) {
        for (const range of [FOUR, { start: 1000, end: 5555 }]) {
          const s = shapePoints(shape, d, range);
          expect(s[0].tick).toBe(range.start);
          expect(s.at(-1)!.tick).toBe(range.end);
          for (let i = 0; i < s.length; i++) {
            expect(s[i].value).toBeGreaterThanOrEqual(d.min);
            expect(s[i].value).toBeLessThanOrEqual(d.max);
            if (i) expect(s[i].tick).toBeGreaterThan(s[i - 1].tick);
            expect(Math.abs(s[i].curve)).toBeLessThanOrEqual(1);
          }
        }
        // Out-of-range lo / hi are clamped.
        for (const x of shapePoints({ ...shape, lo: -1e9, hi: 1e9 }, d, FOUR)) expect([d.min <= x.value, x.value <= d.max]).toEqual([true, true]);
      }
    }
    // lo / hi in the param's units (Task 3's riser: a fader from −24 dB to 0 dB).
    expect(shapePoints({ kind: 'ramp-up', lo: -24, hi: 0 }, defs.fader, FOUR).map((x) => x.value)).toEqual([-24, 0]);
    // A range that cuts a cycle: the last point is on the cut segment's own line.
    const d = defs.pan; // lin, −1..1
    const cut = shapePoints({ kind: 'sine', period: 960 }, d, { start: 0, end: 1000 });
    expect(cut.map((x) => x.tick)).toEqual([0, 240, 480, 720, 960, 1000]);
    const last = cut.at(-1)!;
    expect(last.value).toBeCloseTo(laneValueAt(shapePoints({ kind: 'sine', period: 960 }, d, { start: 0, end: 1920 }), 1000, d)!, 9);
    expect([last.hold, last.curve]).toEqual([false, 0]);
    // The curved quarters stay within 4.5 % of the travel of a true sine (what the lane plays).
    const sine = shapePoints({ kind: 'sine', period: BAR }, d, { start: 0, end: BAR });
    let worst = 0;
    for (let t = 0; t <= BAR; t += 8) worst = Math.max(worst, Math.abs(laneValueAt(sine, t, d)! - Math.sin((2 * Math.PI * t) / BAR)) / 2);
    expect(worst).toBeLessThan(0.045);
    // Empty range: nothing.
    expect(shapePoints(preset('duck'), d, { start: 10, end: 10 })).toEqual([]);
  });

  it('shapeRange: the loop when it is on, else 4 bars from the playhead bar', () => {
    const p = new Project();
    expect(shapeRange(p, 5 * BAR + 100)).toEqual({ start: 5 * BAR, end: 9 * BAR });
    expect(shapeRange(p, 0)).toEqual({ start: 0, end: 4 * BAR });
    expect(shapeRange(p, MAX_SONG_TICKS)).toEqual({ start: MAX_SONG_TICKS - BAR, end: MAX_SONG_TICKS });
    expect(shapeRange(p, MAX_SONG_TICKS - 2 * BAR)).toEqual({ start: MAX_SONG_TICKS - 2 * BAR, end: MAX_SONG_TICKS });
    p.loop = { on: true, start: 2 * BAR, end: 6 * BAR + 480 };
    expect(shapeRange(p, 0)).toEqual({ start: 2 * BAR, end: 6 * BAR + 480 });
  });

  it('insertShape replaces the range, keeps the rest: one undo entry', () => {
    const { p, sink, agrees } = rig({ history: true });
    const s = addSynthTrack(p, sink, 'Bass', STARTER_PATCHES[0])!;
    const filter = s.modules.find((x) => x.kind === moduleDef('filter').kind)!;
    const l = addLane(p, sink, s.id, { kind: 'rack', module: filter.idx, param: 'cutoff' })!;
    for (const [tick, value] of [[0, 300], [BAR, 500], [2 * BAR, 800], [4 * BAR, 900], [6 * BAR, 1000]]) addPoint(p, sink, l.id, { tick, value });
    p.history!.clear();
    const before = pts(l);
    const outside = l.points.filter((x) => x.tick < BAR || x.tick >= 4 * BAR).map((x) => x.id);
    // Bars 2-4 ([BAR, 4 BAR): the end is exclusive): the points at BAR and 2 BAR go; the one ON 4 BAR
    // stays, so the shape's closing point is not written and its last quarter leads into it.
    const r = insertShape(p, sink, l.id, preset('sine-4'), { start: BAR, end: 4 * BAR });
    expect(r).toEqual({ ok: true, points: 48 });
    expect(l.points.map((x) => x.id).filter((id) => outside.includes(id))).toEqual(outside); // same objects
    expect(l.points.map((x) => x.tick)).toEqual([0, ...Array.from({ length: 48 }, (_, i) => BAR + i * 240), 4 * BAR, 6 * BAR]);
    expect(l.points.find((x) => x.tick === 4 * BAR)!.value).toBe(900);
    expect(l.points.map((x) => x.curve).slice(1, 4)).toEqual([SINE_OUT_CURVE, SINE_BACK_CURVE, SINE_OUT_CURVE]);
    invariants(l);
    agrees();
    expect(p.history!.labels.undo).toBe('Insert shape');
    expect(p.history!.undo()).toBe(true);
    expect(p.history!.canUndo).toBe(false);
    expect(pts(l)).toEqual(before);
    agrees();
    p.history!.redo();
    expect(l.points).toHaveLength(51);
    agrees();
  });

  it('insertShape at the range edges: hold points, chaining', () => {
    const { p, sink, agrees } = rig();
    const t = addDrumTrack(p, sink)!;
    const l = addLane(p, sink, t.id, { kind: 'mix', param: 'pan' })!;
    // A hold point just before the range keeps its hold (it steps onto the shape's first point);
    // one ON start is replaced; a hold point ON end is kept, hold and all.
    addPoint(p, sink, l.id, { tick: BAR - 240, value: 0.5, hold: true });
    addPoint(p, sink, l.id, { tick: BAR, value: -0.5, hold: true });
    addPoint(p, sink, l.id, { tick: 2 * BAR, value: 0.25, hold: true });
    const before = l.points.find((x) => x.tick === BAR - 240)!;
    const atEnd = l.points.find((x) => x.tick === 2 * BAR)!;
    expect(insertShape(p, sink, l.id, preset('ramp-up'), { start: BAR, end: 2 * BAR })).toEqual({ ok: true, points: 1 });
    expect(pts(l)).toEqual([[BAR - 240, 0.5, true], [BAR, -1, false], [2 * BAR, 0.25, true]]);
    expect([l.points[0], l.points[2]]).toEqual([before, atEnd]); // same objects
    expect(laneValueAt(l.points, BAR - 1, defs.pan)).toBe(0.5); // still holds up to the shape
    expect(laneValueAt(l.points, 1.5 * BAR, defs.pan)).toBeCloseTo(-0.375, 9); // the ramp leads into the kept point
    // A gate whose range starts on that kept hold point replaces it; its own hold points step.
    expect(insertShape(p, sink, l.id, preset('gate-8'), { start: 2 * BAR, end: 3 * BAR })).toEqual({ ok: true, points: 17 });
    expect(l.points.find((x) => x.tick === 2 * BAR)).toMatchObject({ value: 1, hold: true });
    expect(laneValueAt(l.points, 2 * BAR + 239, defs.pan)).toBe(1);
    expect(laneValueAt(l.points, 2 * BAR + 240, defs.pan)).toBe(-1);
    // Chained shapes: the next range starts on the previous closing point and replaces it.
    expect(l.points.at(-1)).toMatchObject({ tick: 3 * BAR, value: 1, hold: false });
    expect(insertShape(p, sink, l.id, preset('ramp-down'), { start: 3 * BAR, end: 4 * BAR })).toEqual({ ok: true, points: 2 });
    expect(pts(l).slice(-2)).toEqual([[3 * BAR, 1, false], [4 * BAR, -1, false]]);
    invariants(l);
    agrees();
  });

  it('shapes on a bipolar param (pan) and the duck depth on a fader', () => {
    const d = defs.pan; // lin −1..1: the mid line is 0
    const sine = shapePoints(preset('sine-1'), d, FOUR);
    expect(sine.slice(0, 5).map((x) => x.value)).toEqual([0, 1, 0, -1, 0]);
    // Symmetric about the centre: half a cycle later the value is negated.
    for (let t = 0; t < BAR / 2; t += 60) expect(laneValueAt(sine, t + BAR / 2, d)! + laneValueAt(sine, t, d)!).toBeCloseTo(0, 9);
    const duck = shapePoints(preset('duck'), d, FOUR);
    expect(duck.slice(0, 3).map((x) => x.value)).toEqual([1, -1, 1]); // not a fader: max → min
    // The duck's recovery is a release: past halfway back by a quarter of the way, then easing into the top.
    const q = laneValueAt(duck, DUCK_DIP_TICKS + (BEAT - DUCK_DIP_TICKS) / 4, d)!;
    expect((q + 1) / 2).toBeCloseTo(0.5, 6); // (1/4)^(1/2)
    expect(DUCK_CURVE).toBeGreaterThan(0);
    // A fader-law lane ducks from 0 dB to −12 dB by default (not +6 dB to Off); lo / hi still win.
    for (const f of [defs.fader, mixParam('send_a')]) {
      expect(shapePoints(preset('duck'), f, FOUR).slice(0, 3).map((x) => x.value)).toEqual([0, -12, 0]);
      expect(shapePoints({ kind: 'duck', lo: -30, hi: 3 }, f, FOUR).slice(0, 2).map((x) => x.value)).toEqual([3, -30]);
      expect(shapePoints(preset('ramp-up'), f, FOUR).map((x) => x.value)).toEqual([f.min, f.max]); // other shapes: the full range
    }
  });

  it('insertShape nests in an outer edit (no entry of its own) and refuses past the cap', () => {
    const { p, sent, sink, agrees } = rig({ history: true });
    const t = addDrumTrack(p, sink)!;
    p.history!.clear();
    // Task 3's use: one edit makes the lane and writes its shape; one undo takes both.
    const lane = edit(p, 'Add transition', () => {
      const l = addLane(p, sink, t.id, { kind: 'mix', param: 'fader' })!;
      expect(insertShape(p, sink, l.id, { kind: 'ramp-up', lo: -24, hi: 0 }, { start: 8 * BAR, end: 16 * BAR })).toEqual({ ok: true, points: 2 });
      return l;
    });
    expect(pts(lane)).toEqual([[8 * BAR, -24, false], [16 * BAR, 0, false]]);
    expect(p.history!.labels.undo).toBe('Add transition');
    agrees();
    p.history!.undo();
    expect(p.history!.canUndo).toBe(false);
    expect(t.automation).toEqual([]);
    p.history!.redo();
    const l = t.automation[0];
    // 447 points outside bars 1-4 (the ramp's 2 and 445 more); a 1/16 gate (129 points) would make 576: refused, not truncated.
    for (let i = 0; i < 445; i++) addPoint(p, sink, l.id, { tick: 5 * BAR + i * 10, value: -6 });
    const s0 = { json: JSON.stringify(serialize(p)), sent: sent.length, undo: p.history!.labels.undo, version: p.version };
    const r = insertShape(p, sink, l.id, preset('gate-16'), FOUR);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/129 points.*576.*512/);
    expect({ json: JSON.stringify(serialize(p)), sent: sent.length, undo: p.history!.labels.undo, version: p.version }).toEqual(s0);
    // Exactly the cap is fine: a 1/8 gate (65 points) makes 512.
    expect(insertShape(p, sink, l.id, preset('gate-8'), FOUR)).toEqual({ ok: true, points: 65 });
    expect(l.points).toHaveLength(MAX_AUTO_POINTS);
    invariants(l);
    agrees();
    // Other refusals: nothing changes either.
    const s1 = JSON.stringify(serialize(p));
    expect(insertShape(p, sink, 'nope', preset('duck'), FOUR).ok).toBe(false);
    expect(insertShape(p, sink, l.id, preset('duck'), { start: BAR, end: BAR }).ok).toBe(false);
    expect(insertShape(p, sink, l.id, { kind: 'duck', lo: NaN }, FOUR).ok).toBe(false);
    expect(insertShape(p, sink, l.id, { kind: 'sine', period: 4 }, FOUR).ok).toBe(false);
    expect(JSON.stringify(serialize(p))).toBe(s1);
  });
});
