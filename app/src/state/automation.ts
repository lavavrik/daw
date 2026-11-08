// Automation lanes: the pure part (docs/architecture/automation.md, "App").
// No Project mutation here; the edits are in automation-actions.ts.
//
//   laneValueAt      the value a lane plays at a song tick: the SAME rules as
//                    the engine's Lane::value_at (engine/src/automation.rs),
//                    pinned by engine/tests/fixtures/auto_eval.json. The knob
//                    ring (Task 4) draws it, so it must never disagree.
//   nextBreakpoint   where an override ends (AUTO_OVERRIDE suspends a lane
//                    until the playhead passes the next point).
//   thin             Ramer–Douglas–Peucker for freehand drawing.
//   automatableParams / targetDef   what a lane may drive, by catalog name.
//   pointCommands    the engine commands that turn one lane's points into
//                    another set: removals first (see there).
//   bend             a curved segment's shape (plan 16): f(x) = x^(2^(-3c)).
import { AUTO_KIND, MAX_AUTO_LANES, MIX_DELAY, MIX_MASTER, MIX_REVERB, Op, autoPoint, packAutoParam } from '../audio/protocol';
import { moduleDef } from '../audio/catalog';
import type { ParamDef } from '../audio/catalog';
import { MIX_PARAMS, mixParam } from '../audio/mixerCatalog';
import type { MixParamDef, MixTarget } from '../audio/mixerCatalog';
import { fromPos, toPos } from '../ui/rack/knobMath';
import type { CurveDef } from '../ui/rack/knobMath';
import { accepts } from './mixer-actions';
import type { AutoTarget, AutomationLane, MasterChannel, Project, Track } from './project.svelte';

/** Freehand drawing is thinned to within this much of the knob travel (addendum §3.4: ½ %). */
export const DRAW_TOLERANCE = 0.005;

/** A param definition a lane can target (mixer or rack catalog entry). */
export type AutoDef = MixParamDef | ParamDef;

/** Whose lane: a track (its strip, or its rack) or a Master row channel. */
export type AutoOwner = Track | MasterChannel;

/**
 * A breakpoint as the engine sees it and the file saves it: [tick, value,
 * hold 0/1, curve?]. The curve (-1..1, of the segment to the next point) is
 * there only when it is not 0, so straight points keep their plan-10 form.
 */
export type PointTuple = readonly [tick: number, value: number, hold: 0 | 1, curve?: number];

/** A tuple's curve (0 when absent). */
export const tupleCurve = (t: PointTuple): number => t[3] ?? 0;

/**
 * The fraction of the way a segment of curve `c` (-1..1) is at fraction `x`
 * (0..1) of its time: x^(2^(-3c)), x itself for 0 (plan 16; the engine's
 * automation.rs `bend`). Curve 1 is x^(1/8) (fast, then slow), -1 is x^8
 * (slow, then fast). The exponent is always positive: 0 stays 0, 1 stays 1.
 */
export const bend = (x: number, c: number): number => (c === 0 ? x : x ** (2 ** (-3 * c)));

/** The engine mixer channel of a Master row channel. */
export const MASTER_CHANNEL_INDEX: Record<MasterChannel, number> = { reverb: MIX_REVERB, delay: MIX_DELAY, master: MIX_MASTER };
const MASTER_KIND: Record<MasterChannel, MixTarget> = { reverb: 'return', delay: 'return', master: 'master' };

export const isMasterChannel = (x: unknown): x is MasterChannel => x === 'reverb' || x === 'delay' || x === 'master';

/** Number of points with tick <= t (points sorted by tick). */
function upperBound(points: readonly { tick: number }[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].tick > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The value a lane plays at song tick `tick` (fractional ticks allowed);
 * null without points. `points` must be sorted by tick (the model keeps
 * them so). Same rules as the engine (engine/src/automation.rs Lane::eval):
 * before the first point, the first value; after the last, the last; a hold
 * point keeps its value up to the next point; a linear one interpolates to
 * it in KNOB space -- the values themselves for a `lin` param, the knob
 * position (knobMath toPos/fromPos, zero zone included) for an `exp` one --
 * bent by its `curve` (bend; absent = 0; a hold point and the last point
 * ignore theirs). The result is clamped to the range.
 */
export function laneValueAt(
  points: readonly { tick: number; value: number; hold: boolean; curve?: number }[], tick: number, param: CurveDef,
): number | null {
  const n = points.length;
  if (n === 0) return null;
  const c = upperBound(points, tick);
  let v: number;
  if (c === 0) v = points[0].value;
  else if (c >= n) v = points[n - 1].value;
  else {
    const a = points[c - 1];
    const b = points[c];
    if (a.hold) v = a.value;
    else {
      const span = b.tick - a.tick;
      const f = bend(span > 0 ? Math.min(1, Math.max(0, (tick - a.tick) / span)) : 1, a.curve ?? 0);
      if (param.curve === 'exp') {
        const pa = toPos(param, a.value);
        const pb = toPos(param, b.value);
        v = fromPos(param, pa + (pb - pa) * f);
      } else v = a.value + (b.value - a.value) * f;
    }
  }
  return Math.min(param.max, Math.max(param.min, v));
}

/** The first point after `tick` (where an override ends), or null. Points sorted by tick. */
export function nextBreakpoint<P extends { tick: number }>(points: readonly P[], tick: number): P | null {
  const c = upperBound(points, tick);
  return c < points.length ? points[c] : null;
}

/**
 * Ramer–Douglas–Peucker: the fewest of `samples` (sorted by tick, unique
 * ticks) whose polyline stays within `tolerance` of every sample, measured
 * vertically (value distance at the sample's tick: ticks and values are not
 * the same unit, so no Euclidean distance). The ends are always kept; the
 * kept samples are returned as they are (same objects), in order.
 */
export function thin<S extends { tick: number; value: number }>(samples: readonly S[], tolerance: number): S[] {
  const n = samples.length;
  if (n <= 2) return [...samples];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = samples[i];
    const b = samples[j];
    const span = b.tick - a.tick;
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const s = samples[k];
      const line = span > 0 ? a.value + ((b.value - a.value) * (s.tick - a.tick)) / span : a.value;
      const d = Math.abs(s.value - line);
      if (d > worst) {
        worst = d;
        at = k;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return samples.filter((_, k) => keep[k] === 1);
}

/** The mixer kind and channel index of an owner. */
function mixChannel(owner: AutoOwner): { kind: MixTarget; index: number } {
  return isMasterChannel(owner) ? { kind: MASTER_KIND[owner], index: MASTER_CHANNEL_INDEX[owner] } : { kind: 'track', index: owner.slot };
}

/**
 * The catalog def `target` refers to on `owner`, or null when the owner
 * cannot have that lane: an unknown param, an integer (choice, flag) one, a
 * mixer param the channel does not take (engine MixParam::accepts), or a
 * rack target off a synth track or on a module it does not have.
 */
export function targetDef(owner: AutoOwner, target: AutoTarget): AutoDef | null {
  if (target.kind === 'mix') {
    const def = MIX_PARAMS.find((d) => d.name === target.param);
    const ch = mixChannel(owner);
    return def && !def.integer && accepts(def, ch.kind, ch.index) ? def : null;
  }
  if (isMasterChannel(owner) || owner.kind !== 'synth') return null;
  const m = owner.modules.find((x) => x.idx === target.module);
  const def = m && rackAutomatable(m.kind) ? moduleDef(m.kind).params.find((d) => d.name === target.param) : undefined;
  return def && !def.integer ? def : null;
}

/** Can a module of `kind` have lanes at all? Not a Scope: its params only
 * change what it draws (plan 12; the engine's Shape::rack refuses them). */
function rackAutomatable(kind: number): boolean {
  return moduleDef(kind).id !== 'scope';
}

/**
 * Every target `owner` can automate, for the lane picker: the mixer params
 * its channel takes, in catalog order, then (synth tracks) each module's in
 * rack order, by catalog name. Non-integer params only: never mute, solo,
 * the on/off switches, the delay division, ping-pong, wave, mode, voices;
 * and none of a Scope's.
 */
export function automatableParams(owner: AutoOwner): { target: AutoTarget; def: AutoDef }[] {
  const out: { target: AutoTarget; def: AutoDef }[] = [];
  const ch = mixChannel(owner);
  for (const def of MIX_PARAMS) if (!def.integer && accepts(def, ch.kind, ch.index)) out.push({ target: { kind: 'mix', param: def.name }, def });
  if (!isMasterChannel(owner) && owner.kind === 'synth') {
    for (const m of [...owner.modules].sort((a, b) => a.idx - b.idx)) {
      if (!rackAutomatable(m.kind)) continue;
      for (const def of moduleDef(m.kind).params) if (!def.integer) out.push({ target: { kind: 'rack', module: m.idx, param: def.name }, def });
    }
  }
  return out;
}

export const sameTarget = (a: AutoTarget, b: AutoTarget): boolean =>
  a.kind === b.kind && a.param === b.param && (a.kind === 'mix' || a.module === (b as { module: number }).module);

/** Every lane of the project with its owner: the tracks' in track order, then the Master row's. */
export function projectLanes(p: Project): { owner: AutoOwner; lane: AutomationLane }[] {
  const out: { owner: AutoOwner; lane: AutomationLane }[] = [];
  for (const t of p.tracks) for (const lane of t.automation) out.push({ owner: t, lane });
  for (const x of p.mixer.automation) out.push({ owner: x.channel, lane: x.lane });
  return out;
}

/** Lanes in the project (at most MAX_AUTO_LANES: one engine lane each). */
export const laneCount = (p: Project): number =>
  p.tracks.reduce((n, t) => n + t.automation.length, 0) + p.mixer.automation.length;

/** The lowest engine lane no lane uses, or null when all MAX_AUTO_LANES are taken. */
export function freeLane(p: Project): number | null {
  const used = new Set(projectLanes(p).map((x) => x.lane.lane));
  for (let i = 0; i < MAX_AUTO_LANES; i++) if (!used.has(i)) return i;
  return null;
}

/**
 * THE AUTO_LANE_SET builder (live lanes here, saved ones in commands.ts
 * laneCommands): kind MIX = mixer channel `channel` and the param's id;
 * kind RACK = synth slot `channel` and packAutoParam(module, param index in
 * the catalog of module kind `moduleKind`, a catalog id or number).
 */
export function laneSet(
  lane: number, channel: number, target: AutoTarget, moduleKind: string | number | null,
): [number, number, number, number, number] {
  if (target.kind === 'mix') return [Op.AUTO_LANE_SET, lane, AUTO_KIND.MIX, channel, mixParam(target.param).id];
  const param = moduleDef(moduleKind!).params.findIndex((d) => d.name === target.param);
  return [Op.AUTO_LANE_SET, lane, AUTO_KIND.RACK, channel, packAutoParam(target.module, param)];
}

/** AUTO_LANE_SET for a lane of `owner` on `target` (which must be valid for it: targetDef). */
export function laneSetCommand(lane: number, owner: AutoOwner, target: AutoTarget): [number, number, number, number, number] {
  if (target.kind === 'mix') return laneSet(lane, mixChannel(owner).index, target, null);
  const t = owner as Track;
  const m = t.kind === 'synth' ? t.modules.find((x) => x.idx === target.module) : undefined;
  return laneSet(lane, t.slot, target, m!.kind);
}

/**
 * The commands that turn engine lane `lane`'s points `from` into `to` (each
 * a map engine idx -> [tick, value, hold, curve?]). Ticks are unique within a
 * lane and the engine refuses an AUTO_POINT_SET on a tick another point
 * still holds (Lane::set_point), so the ORDER matters:
 *   1. AUTO_POINT_REMOVE for every idx that goes, or whose tick changes;
 *   2. then AUTO_POINT_SET for every idx that is new or changed, each
 *      followed by its AUTO_POINT_CURVE when its curve is not 0 (a SET
 *      resets the engine's curve to 0); a point whose curve alone changes
 *      gets the CURVE only.
 * After step 1 the only ticks still held are those of points that keep
 * their idx and tick, and `to` holds each of those at that same idx, so no
 * SET can land on a held tick (a point whose value or shape alone changes
 * is SET in place: it holds its own tick). Used by every point edit
 * (automation-actions.ts) and by undo (history/diffApply.ts). Unchanged
 * points send nothing.
 */
export function pointCommands(
  lane: number, from: ReadonlyMap<number, PointTuple>, to: ReadonlyMap<number, PointTuple>,
): [number, number, number, number, number][] {
  const out: [number, number, number, number, number][] = [];
  for (const [idx, p] of from) {
    const q = to.get(idx);
    if (!q || q[0] !== p[0]) out.push([Op.AUTO_POINT_REMOVE, autoPoint(lane, idx), 0, 0, 0]);
  }
  for (const [idx, q] of to) {
    const p = from.get(idx);
    const c = tupleCurve(q);
    if (!p || p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2]) {
      out.push([Op.AUTO_POINT_SET, autoPoint(lane, idx), q[0], q[1], q[2]]);
      if (c !== 0) out.push([Op.AUTO_POINT_CURVE, autoPoint(lane, idx), c, 0, 0]);
    } else if (tupleCurve(p) !== c) out.push([Op.AUTO_POINT_CURVE, autoPoint(lane, idx), c, 0, 0]);
  }
  return out;
}

/** A point as its tuple: the curve only when it is not 0. */
export const pointTuple = (x: { tick: number; value: number; hold: boolean; curve?: number }): PointTuple =>
  x.curve ? [x.tick, x.value, x.hold ? 1 : 0, x.curve] : [x.tick, x.value, x.hold ? 1 : 0];

/** A lane's points as pointCommands takes them. */
export const pointMap = (lane: { points: readonly { idx: number; tick: number; value: number; hold: boolean; curve?: number }[] }): Map<number, PointTuple> =>
  new Map(lane.points.map((x) => [x.idx, pointTuple(x)]));
