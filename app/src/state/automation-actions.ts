// Automation lane edits (docs/architecture/automation.md, "App"). Like the
// other *-actions.ts: each one mutates the Project AND sends the matching
// engine commands, inside one edit() (one undo entry). A refusal changes
// nothing, sends nothing and returns null / false.
//
// Engine addressing: a lane has an engine lane (0..MAX_AUTO_LANES-1, unique in
// the project, the lowest free one when it is added); its points use engine
// idx 0..n-1, always DENSE. A point edit computes the lane's new point set,
// gives every point an idx below the new count (points keep theirs when they
// can; a point above it moves into a freed idx below), and sends the
// difference with pointCommands (removals first). Dense idx is what lets the
// saved file list the points in idx order without storing idx
// (schema.ts LaneJson), and undo (history/diffApply.ts) match them by idx.
//
// Lanes the engine drops on its own (its target goes away) are dropped from
// the state by the action that removes the target, in the same edit():
// removeModule, a patch load (RACK_CLEAR) and rollbackRefusedAdd in
// rack-actions.ts; removeTrack takes the track's lanes with the track.
import { BAR_TICKS, MAX_AUTO_LANES, MAX_AUTO_POINTS, MAX_SONG_TICKS, Op } from '../audio/protocol';
import { clampParam } from '../audio/catalog';
import { fromPos, toPos } from '../ui/rack/knobMath';
import type { CommandSink } from './actions';
import {
  DRAW_TOLERANCE, bend, freeLane, isMasterChannel, laneCount, laneSetCommand, pointCommands, pointMap, pointTuple, projectLanes,
  sameTarget, targetDef, thin,
} from './automation';
import type { AutoDef, AutoOwner, PointTuple } from './automation';
import { edit } from './edits';
import type { MixChannelTarget } from './mixer-actions';
import type { AutoPoint, AutoTarget, AutomationLane, Project } from './project.svelte';

/** The owner a lane belongs to, from a track id or a Master row channel name. */
function ownerOf(p: Project, owner: MixChannelTarget): AutoOwner | null {
  if (isMasterChannel(owner)) return owner;
  return p.tracks.find((t) => t.id === owner) ?? null;
}

/** A lane by id, with its owner and its param's def (null: no such lane). */
export function findLane(p: Project, laneId: string): { lane: AutomationLane; owner: AutoOwner; def: AutoDef } | null {
  for (const x of projectLanes(p)) {
    if (x.lane.id !== laneId) continue;
    const def = targetDef(x.owner, x.lane.target);
    return def ? { lane: x.lane, owner: x.owner, def } : null;
  }
  return null;
}

/**
 * A new, enabled lane without points on `owner` (a track id, or 'reverb' /
 * 'delay' / 'master' for the Master row) driving `target`; it takes the
 * lowest free engine lane. Refused (null) when the target is not
 * automatable there (targetDef), already has a lane on that owner, or all
 * MAX_AUTO_LANES are in use.
 */
export function addLane(p: Project, sink: CommandSink, owner: MixChannelTarget, target: AutoTarget): AutomationLane | null {
  const o = ownerOf(p, owner);
  if (!o || !targetDef(o, target)) return null;
  const lanes = isMasterChannel(o) ? p.mixer.automation.filter((x) => x.channel === o).map((x) => x.lane) : o.automation;
  if (lanes.some((l) => sameTarget(l.target, target))) return null;
  if (laneCount(p) >= MAX_AUTO_LANES) return null;
  const engineLane = freeLane(p);
  if (engineLane === null) return null;
  return edit(p, 'Add automation lane', () => {
    const lane: AutomationLane = { id: crypto.randomUUID(), lane: engineLane, target: { ...target }, enabled: true, points: [] };
    let live: AutomationLane;
    if (isMasterChannel(o)) {
      p.mixer.automation.push({ channel: o, lane });
      live = p.mixer.automation[p.mixer.automation.length - 1].lane; // reactive proxy
    } else {
      o.automation.push(lane);
      live = o.automation[o.automation.length - 1];
    }
    const c = laneSetCommand(engineLane, o, target);
    sink.send(c[0], c[1], c[2], c[3], c[4]);
    return live;
  });
}

/** Remove a lane (AUTO_LANE_CLEAR: its param goes back to its base value). */
export function removeLane(p: Project, sink: CommandSink, laneId: string): boolean {
  const f = findLane(p, laneId);
  if (!f) return false;
  return edit(p, 'Remove automation lane', () => {
    if (isMasterChannel(f.owner)) p.mixer.automation = p.mixer.automation.filter((x) => x.lane.id !== laneId);
    else f.owner.automation = f.owner.automation.filter((l) => l.id !== laneId);
    sink.send(Op.AUTO_LANE_CLEAR, f.lane.lane);
    return true;
  });
}

/** Enable or disable a lane (a disabled lane plays its target's base value). False if unchanged. */
export function setLaneEnabled(p: Project, sink: CommandSink, laneId: string, on: boolean): boolean {
  const f = findLane(p, laneId);
  if (!f || f.lane.enabled === on) return false;
  return edit(p, on ? 'Enable automation' : 'Disable automation', () => {
    f.lane.enabled = on;
    sink.send(Op.AUTO_LANE_ENABLE, f.lane.lane, on ? 1 : 0);
    return true;
  });
}

/** A wanted point: an existing one (its id and idx kept when possible) or a new one. */
interface Want {
  old: AutoPoint | null;
  tick: number;
  value: number;
  hold: boolean;
  curve: number;
}

/**
 * Make `lane`'s points `want` (unique ticks, at most MAX_AUTO_POINTS): dense
 * idx (see the top), the difference sent with pointCommands, the state
 * sorted by tick. Points keep their objects (and ids).
 */
function commitPoints(sink: CommandSink, lane: AutomationLane, want: Want[]) {
  const n = want.length;
  const taken = new Set<number>();
  for (const w of want) if (w.old && w.old.idx < n) taken.add(w.old.idx);
  const free: number[] = [];
  for (let i = n - 1; i >= 0; i--) if (!taken.has(i)) free.push(i);
  const sorted = [...want].sort((a, b) => a.tick - b.tick);
  const idxOf = new Map<Want, number>();
  for (const w of sorted) idxOf.set(w, w.old && w.old.idx < n ? w.old.idx : free.pop()!);
  const to = new Map<number, PointTuple>(sorted.map((w) => [idxOf.get(w)!, pointTuple(w)]));
  for (const c of pointCommands(lane.lane, pointMap(lane), to)) sink.send(c[0], c[1], c[2], c[3], c[4]);
  lane.points = sorted.map((w) => {
    const fields = { idx: idxOf.get(w)!, tick: w.tick, value: w.value, hold: w.hold, curve: w.curve };
    return w.old ? Object.assign(w.old, fields) : { id: crypto.randomUUID(), ...fields };
  });
}

const keep = (x: AutoPoint): Want => ({ old: x, tick: x.tick, value: x.value, hold: x.hold, curve: x.curve });
/** A tick as stored: whole, 0..MAX_SONG_TICKS; null when not a number. */
const tickOf = (t: number): number | null => (Number.isFinite(t) ? Math.min(MAX_SONG_TICKS, Math.max(0, Math.round(t))) : null);

/**
 * Add a point (value clamped to the param's range, tick rounded and kept in
 * the song). Refused (null) at MAX_AUTO_POINTS, on a tick the lane already
 * uses, or for a NaN tick or value.
 */
export function addPoint(
  p: Project, sink: CommandSink, laneId: string, pt: { tick: number; value: number; hold?: boolean },
): AutoPoint | null {
  const f = findLane(p, laneId);
  const tick = tickOf(pt.tick);
  if (!f || tick === null || Number.isNaN(pt.value)) return null;
  const { lane, def } = f;
  if (lane.points.length >= MAX_AUTO_POINTS || lane.points.some((x) => x.tick === tick)) return null;
  return edit(p, 'Add automation point', () => {
    commitPoints(sink, lane, [...lane.points.map(keep), { old: null, tick, value: clampParam(def, pt.value), hold: pt.hold ?? false, curve: 0 }]);
    return lane.points.find((x) => x.tick === tick)!;
  });
}

/**
 * Move points `ids` together by `dTick` ticks and `dValue` in KNOB POSITION
 * (a fraction of the travel, as the lane is drawn: an exp param moves
 * logarithmically). The order never changes: dTick is clamped so no moved
 * point reaches an unmoved neighbour (ticks stay unique) or leaves the song;
 * each value is clamped to the range. False when nothing moved.
 *
 * `origin` (a drag): the moved points' positions when the gesture started,
 * by point id. The deltas are then the gesture's CUMULATIVE ones and apply
 * to the origin, not to the current positions, so nothing is lost to the
 * clamping on the way: a group dragged past the top edge and back gets its
 * shape back, and a point in an exp param's zero zone (glide at 0) leaves
 * it however small each step is. Without it (a key nudge) the deltas apply
 * to the current positions. The tick clamp is against the unmoved points
 * either way (they are the same during a drag).
 */
export function movePoints(
  p: Project, sink: CommandSink, laneId: string, ids: string[], dTick: number, dValue: number,
  origin?: ReadonlyMap<string, { tick: number; value: number }>,
): boolean {
  const f = findLane(p, laneId);
  if (!f || !Number.isFinite(dTick) || !Number.isFinite(dValue)) return false;
  const { lane, def } = f;
  const sel = new Set(ids);
  const pts = lane.points;
  const from = (x: AutoPoint) => origin?.get(x.id) ?? x;
  let lo = -Infinity;
  let hi = Infinity;
  pts.forEach((x, k) => {
    if (!sel.has(x.id)) return;
    const t = from(x).tick;
    lo = Math.max(lo, -t, k > 0 && !sel.has(pts[k - 1].id) ? pts[k - 1].tick + 1 - t : -Infinity);
    hi = Math.min(hi, MAX_SONG_TICKS - t, k + 1 < pts.length && !sel.has(pts[k + 1].id) ? pts[k + 1].tick - 1 - t : Infinity);
  });
  if (lo === -Infinity) return false; // no point selected
  const dt = Math.min(hi, Math.max(lo, Math.round(dTick)));
  const want = pts.map((x): Want => {
    if (!sel.has(x.id)) return keep(x);
    const o = from(x);
    // dValue 0 keeps the value exactly (a position round trip could nudge it).
    const value = dValue === 0 ? o.value : fromPos(def, toPos(def, o.value) + dValue);
    return { old: x, tick: o.tick + dt, value, hold: x.hold, curve: x.curve };
  });
  if (want.every((w) => w.tick === w.old!.tick && w.value === w.old!.value)) return false;
  return edit(p, 'Move automation points', () => {
    commitPoints(sink, lane, want);
    return true;
  });
}

/** Delete points `ids`. False when none of them is in the lane. */
export function deletePoints(p: Project, sink: CommandSink, laneId: string, ids: string[]): boolean {
  const f = findLane(p, laneId);
  if (!f) return false;
  const gone = new Set(ids);
  const { lane } = f;
  if (!lane.points.some((x) => gone.has(x.id))) return false;
  return edit(p, 'Delete automation points', () => {
    commitPoints(sink, lane, lane.points.filter((x) => !gone.has(x.id)).map(keep));
    return true;
  });
}

/** Make points `ids` hold (true) or linear (false). False when none changes. */
export function setPointShape(p: Project, sink: CommandSink, laneId: string, ids: string[], hold: boolean): boolean {
  const f = findLane(p, laneId);
  if (!f) return false;
  const sel = new Set(ids);
  const { lane } = f;
  if (!lane.points.some((x) => sel.has(x.id) && x.hold !== hold)) return false;
  return edit(p, hold ? 'Hold' : 'Linear', () => {
    commitPoints(sink, lane, lane.points.map((x) => (sel.has(x.id) ? { ...keep(x), hold } : keep(x))));
    return true;
  });
}

/**
 * Bend the segment that starts at point `pointId` (plan 16): `curve` -1..1
 * (clamped; 0 a straight line), f(x) = x^(2^(-3 curve)) of the way at
 * fraction x (automation.ts bend). Sends AUTO_POINT_CURVE alone: the point
 * keeps its tick, value, shape and idx. `owner` (a track id or a Master row
 * channel) must own the lane. A hold point, or the last point, takes the
 * curve and keeps it, but plays it only once it is linear and has a next
 * point. False (nothing sent) when nothing changes, for NaN, or when there
 * is no such lane / point on that owner.
 */
export function setPointCurve(
  p: Project, sink: CommandSink, owner: MixChannelTarget, laneId: string, pointId: string, curve: number,
): boolean {
  const f = findLane(p, laneId);
  const o = ownerOf(p, owner);
  if (!f || !o || f.owner !== o || Number.isNaN(curve)) return false;
  const pt = f.lane.points.find((x) => x.id === pointId);
  const c = Math.min(1, Math.max(-1, curve)) || 0; // -0 is 0
  if (!pt || pt.curve === c) return false;
  return edit(p, 'Curve', () => {
    commitPoints(sink, f.lane, f.lane.points.map((x) => (x === pt ? { ...keep(x), curve: c } : keep(x))));
    return true;
  });
}

/**
 * A freehand stroke: `samples` ({tick, value in param units}, in drawing
 * order, either direction) are rounded to whole ticks in the song (the last
 * sample on a tick wins), clamped to the range and thinned with
 * Ramer–Douglas–Peucker to DRAW_TOLERANCE of the knob travel; the result
 * replaces every point in the drawn tick range (first..last sample). The
 * stroke's ends are always points. Refused (false) when nothing usable was
 * drawn or the lane would exceed MAX_AUTO_POINTS.
 */
export function drawPoints(p: Project, sink: CommandSink, laneId: string, samples: { tick: number; value: number }[]): boolean {
  const f = findLane(p, laneId);
  if (!f) return false;
  const { lane, def } = f;
  const byTick = new Map<number, number>();
  for (const s of samples) {
    const tick = tickOf(s.tick);
    if (tick !== null && !Number.isNaN(s.value)) byTick.set(tick, clampParam(def, s.value));
  }
  if (byTick.size === 0) return false;
  const stroke = [...byTick].sort((a, b) => a[0] - b[0]).map(([tick, value]) => ({ tick, value: toPos(def, value), raw: value }));
  const kept = thin(stroke, DRAW_TOLERANCE);
  const first = stroke[0].tick;
  const last = stroke[stroke.length - 1].tick;
  const want: Want[] = [
    ...lane.points.filter((x) => x.tick < first || x.tick > last).map(keep),
    ...kept.map((k): Want => ({ old: null, tick: k.tick, value: k.raw, hold: false, curve: 0 })),
  ];
  if (want.length > MAX_AUTO_POINTS) return false;
  return edit(p, 'Draw automation', () => {
    commitPoints(sink, lane, want);
    return true;
  });
}

// ---- Shapes (plan 28 Task 2) ----------------------------------------------------------
//
// "Insert shape ▸" writes a ready-made curve over a tick range: ramps, a
// per-beat duck, sine LFOs, square gates. Each shape is a few breakpoints
// per cycle with CURVED segments (the engine bends a segment by its left
// point's curve, f(x) = x^(2^(-3 curve)), in knob space: automation.rs),
// not a dense run of points, so a 4-bar shape stays far below the 512-point
// cap. shapePoints() is the pure generator; insertShape() is the action.

/** One beat (a quarter note) in ticks, 4/4. */
const BEAT_TICKS = BAR_TICKS / 4;
/** The duck's dip: from the top to the bottom in a 1/32 of a beat (~15 ms at 120 BPM). */
export const DUCK_DIP_TICKS = BEAT_TICKS / 32;
/** The duck's recovery curve: x^2 of the way back, so it stays low a moment, then swells back by the next beat. */
export const DUCK_CURVE = -1 / 3;
/**
 * A sine LFO is 4 breakpoints per cycle (mid, top, mid, bottom) and each
 * quarter is one curved segment. Leaving the mid line the sine covers
 * sin(πx/2) of the quarter's travel at fraction x; returning to it,
 * 1 − cos(πx/2). x^k fits these best (least max error) at k ≈ 0.6135 and
 * k ≈ 1.7435: curves +0.235 and −0.267. The fit is within 4.4 % (out) and
 * 0.7 % (back) of the full travel of a true sine.
 */
export const SINE_OUT_CURVE = 0.235;
export const SINE_BACK_CURVE = -0.267;
/** Shortest sine / gate cycle (ticks): its quarter (a sine's breakpoint step) stays at least 2 ticks. */
export const MIN_SHAPE_PERIOD = 8;

/**
 * A shape to insert. `lo` / `hi` are the ends of its travel in the param's
 * units (default: the param's min and max; clamped to the range): a ramp up
 * goes lo → hi, a duck dips from hi to lo, a sine swings between them, a
 * gate opens at hi and closes at lo. `period` is one cycle in ticks.
 */
export type AutoShape =
  | { kind: 'ramp-up' | 'ramp-down' | 'duck'; lo?: number; hi?: number }
  | { kind: 'sine' | 'gate'; period: number; lo?: number; hi?: number };

/** A tick range [start, end], both ends included. */
export interface ShapeRange {
  start: number;
  end: number;
}

/** A point a shape writes (the lane gives it an id and an engine idx). */
export interface ShapePoint {
  tick: number;
  value: number;
  hold: boolean;
  curve: number;
}

/** The shapes the lane menu offers ("Insert shape ▸"), in menu order; `id` names the test id auto-shape-<id>. */
export const SHAPE_PRESETS: readonly { id: string; label: string; shape: AutoShape }[] = [
  { id: 'ramp-up', label: 'Ramp up', shape: { kind: 'ramp-up' } },
  { id: 'ramp-down', label: 'Ramp down', shape: { kind: 'ramp-down' } },
  { id: 'duck', label: 'Duck per beat', shape: { kind: 'duck' } },
  { id: 'sine-4', label: 'Sine 1/4 bar', shape: { kind: 'sine', period: BAR_TICKS / 4 } },
  { id: 'sine-2', label: 'Sine 1/2 bar', shape: { kind: 'sine', period: BAR_TICKS / 2 } },
  { id: 'sine-1', label: 'Sine 1 bar', shape: { kind: 'sine', period: BAR_TICKS } },
  { id: 'gate-8', label: 'Gate 1/8', shape: { kind: 'gate', period: BAR_TICKS / 8 } },
  { id: 'gate-16', label: 'Gate 1/16', shape: { kind: 'gate', period: BAR_TICKS / 16 } },
];

/** Bars a shape covers when no loop is set. */
export const SHAPE_BARS = 4;

/**
 * Where a shape goes: the loop range while the loop is on, else SHAPE_BARS
 * bars from the bar the playhead is in (`playhead`: the heard song tick
 * while the song plays, else the parked song position), kept in the song.
 */
export function shapeRange(p: Project, playhead: number): ShapeRange {
  if (p.loop.on) return { start: p.loop.start, end: p.loop.end };
  // MAX_SONG_TICKS is whole bars: a playhead at the very end still gets its last bar.
  const start = Math.min(MAX_SONG_TICKS - BAR_TICKS, Math.max(0, Math.floor(playhead / BAR_TICKS) * BAR_TICKS));
  return { start, end: Math.min(MAX_SONG_TICKS, start + SHAPE_BARS * BAR_TICKS) };
}

/** A breakpoint in travel units: u 0 = lo, 1 = hi. */
interface Bp {
  tick: number;
  u: number;
  hold: boolean;
  curve: number;
}

/**
 * The breakpoints of `shape` from `start` until the first one past `end`
 * (the one after `end` is needed to cut the last segment there).
 */
function breakpoints(shape: AutoShape, start: number, end: number): Bp[] {
  const out: Bp[] = [];
  const bp = (tick: number, u: number, hold = false, curve = 0) => out.push({ tick: Math.round(tick), u, hold, curve });
  const past = () => out.length > 0 && out[out.length - 1].tick > end;
  switch (shape.kind) {
    case 'ramp-up':
    case 'ramp-down': {
      const up = shape.kind === 'ramp-up';
      bp(start, up ? 0 : 1);
      bp(end, up ? 1 : 0);
      break;
    }
    case 'duck':
      // Each beat: the top, a fast linear dip, a curved recovery that reaches the top at the next beat.
      for (let b = start; !past(); b += BEAT_TICKS) {
        bp(b, 1);
        bp(b + DUCK_DIP_TICKS, 0, false, DUCK_CURVE);
      }
      break;
    case 'sine': {
      // mid → top → mid → bottom → mid ..., starting on the rise.
      const q = shape.period / 4;
      const u = [0.5, 1, 0.5, 0];
      for (let i = 0; !past(); i++) bp(start + i * q, u[i % 4], false, i % 2 === 0 ? SINE_OUT_CURVE : SINE_BACK_CURVE);
      break;
    }
    case 'gate':
      // Open (hi) for the first half of each cycle, closed (lo) for the second: hold points, square steps.
      for (let i = 0; !past(); i++) bp(start + (i * shape.period) / 2, i % 2 === 0 ? 1 : 0, true);
      break;
  }
  return out;
}

/**
 * The points `shape` writes over `range` for a param `def` (pure). Values
 * are spread over the lo..hi travel in KNOB POSITION, as the lane is drawn
 * and the engine interpolates (an exp cutoff ramps logarithmically in Hz),
 * and always lie in the param's range. The first point is at range.start
 * and the last at range.end: a cycle cut short by the end gets a point
 * there on its own line (a power curve cut at any fraction is the same
 * curve, so the segment keeps its curve exactly). The last point is linear
 * with curve 0 (the segment after it leads to a point outside the shape).
 * Empty when end <= start.
 *
 * For a 4-bar range (16 beats): ramps 2 points; duck 33 (2 per beat + the
 * end); sine 1/4 bar 65, 1/2 bar 33, 1 bar 17 (4 per cycle + the end);
 * gate 1/8 65, 1/16 129 (2 per cycle + the end).
 */
export function shapePoints(shape: AutoShape, def: AutoDef, range: ShapeRange): ShapePoint[] {
  const { start, end } = range;
  if (!(end > start)) return [];
  const loV = clampParam(def, shape.lo ?? def.min);
  const hiV = clampParam(def, shape.hi ?? def.max);
  const p0 = toPos(def, loV);
  const p1 = toPos(def, hiV);
  // The ends map to lo / hi exactly (no position round trip).
  const valueOf = (u: number) => (u === 0 ? loV : u === 1 ? hiV : clampParam(def, fromPos(def, p0 + u * (p1 - p0))));
  const bps = breakpoints(shape, start, end);
  const kept = bps.filter((b) => b.tick <= end);
  const last = kept[kept.length - 1];
  if (last.tick < end) {
    // Cut the segment that crosses the end at the end.
    const next = bps[kept.length];
    const u = last.hold ? last.u : last.u + (next.u - last.u) * bend((end - last.tick) / (next.tick - last.tick), last.curve);
    kept.push({ tick: end, u, hold: false, curve: 0 });
  }
  // The last point is linear and straight: its segment, to a later point the lane keeps, is not the shape's.
  const n = kept.length - 1;
  return kept.map((b, i) => ({ tick: b.tick, value: valueOf(b.u), hold: i < n && b.hold, curve: i < n ? b.curve : 0 }));
}

/** insertShape's result: how many points the shape wrote, or why it was refused. */
export type InsertShapeResult = { ok: true; points: number } | { ok: false; message: string };

/**
 * Write `shape` over `range` (ticks, both ends included; rounded and kept in
 * the song) on lane `laneId`: its points REPLACE every point of the lane in
 * the range and the points outside it are kept. One edit() ("Insert
 * shape"): one undo entry on its own, and none of its own inside an outer
 * edit() (it then belongs to the caller's entry, as Task 3's transitions
 * do: they create a track, a clip and lanes and insert shapes in one edit).
 *
 * Refused, with a message for the user (nothing changes, nothing is sent):
 * no such lane, an empty range, a NaN lo / hi, a period under
 * MIN_SHAPE_PERIOD, or a lane that would pass MAX_AUTO_POINTS (the shape is
 * never truncated).
 */
export function insertShape(p: Project, sink: CommandSink, laneId: string, shape: AutoShape, range: ShapeRange): InsertShapeResult {
  const f = findLane(p, laneId);
  if (!f) return { ok: false, message: 'That automation lane is gone' };
  const start = tickOf(range.start);
  const end = tickOf(range.end);
  if (start === null || end === null || end <= start) return { ok: false, message: 'The shape needs a range at least a tick long' };
  if (Number.isNaN(shape.lo) || Number.isNaN(shape.hi)) return { ok: false, message: 'The shape has no value range' };
  if ('period' in shape && !(shape.period >= MIN_SHAPE_PERIOD)) return { ok: false, message: 'The shape repeats too fast' };
  const { lane, def } = f;
  const made = shapePoints(shape, def, { start, end });
  const want: Want[] = [
    ...lane.points.filter((x) => x.tick < start || x.tick > end).map(keep),
    ...made.map((m): Want => ({ old: null, ...m })),
  ];
  if (want.length > MAX_AUTO_POINTS) {
    return { ok: false, message: `The shape needs ${made.length} points: the lane would hold ${want.length}, over the ${MAX_AUTO_POINTS} a lane holds` };
  }
  edit(p, 'Insert shape', () => commitPoints(sink, lane, want));
  return { ok: true, points: made.length };
}

/**
 * A manual move of an automated knob is about to happen: suspend the lane
 * until its next breakpoint (AUTO_OVERRIDE). NOT an edit (no undo entry, no
 * unsaved mark: state/edits.ts NON_EDIT_OPS); the move's own MIX_SET /
 * RACK_SET_PARAM that follows is the edit, and stores the base value.
 */
export function overrideLane(p: Project, sink: CommandSink, laneId: string): boolean {
  const f = findLane(p, laneId);
  if (!f) return false;
  sink.send(Op.AUTO_OVERRIDE, f.lane.lane);
  return true;
}
