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
import { MAX_AUTO_LANES, MAX_AUTO_POINTS, MAX_SONG_TICKS, Op } from '../audio/protocol';
import { clampParam } from '../audio/catalog';
import { fromPos, toPos } from '../ui/rack/knobMath';
import type { CommandSink } from './actions';
import {
  DRAW_TOLERANCE, freeLane, isMasterChannel, laneCount, laneSetCommand, pointCommands, pointMap, projectLanes, sameTarget,
  targetDef, thin,
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
  const to = new Map<number, PointTuple>(sorted.map((w) => [idxOf.get(w)!, [w.tick, w.value, w.hold ? 1 : 0]]));
  for (const c of pointCommands(lane.lane, pointMap(lane), to)) sink.send(c[0], c[1], c[2], c[3], c[4]);
  lane.points = sorted.map((w) => {
    const fields = { idx: idxOf.get(w)!, tick: w.tick, value: w.value, hold: w.hold };
    return w.old ? Object.assign(w.old, fields) : { id: crypto.randomUUID(), ...fields };
  });
}

const keep = (x: AutoPoint): Want => ({ old: x, tick: x.tick, value: x.value, hold: x.hold });
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
    commitPoints(sink, lane, [...lane.points.map(keep), { old: null, tick, value: clampParam(def, pt.value), hold: pt.hold ?? false }]);
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
    return { old: x, tick: o.tick + dt, value, hold: x.hold };
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
    ...kept.map((k): Want => ({ old: null, tick: k.tick, value: k.raw, hold: false })),
  ];
  if (want.length > MAX_AUTO_POINTS) return false;
  return edit(p, 'Draw automation', () => {
    commitPoints(sink, lane, want);
    return true;
  });
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
