import { AUTO_H, LANE_MAX_H, LANE_MIN_H } from './tlMath';

// Which automation lanes the timeline shows (plan 10). UI state only: never
// saved, never part of undo (spec: "which tracks are open is UI state").
//   open       owners whose lanes are shown under their row: track ids (the
//              header's A toggle) and tlMath.MASTER_ROW (the Master row's A);
//   master     the Master row was asked for (footer "+ Master row", Task 4's
//              "Automate" on a return or the master) although it has no lane
//              yet: it shows anyway once it has one;
//   suspended  lanes a manual move suspended (drawn grey). Set by the
//              knob-follow loop (Task 4) when a suspension starts or ends,
//              never per frame;
//   gesture    an AutoLane press is down (press .. release / cancel): the
//              timeline's play-follow must not page the view under it (a
//              dragged point or a stroke would land a page away);
//   heights    each resized lane's row height (px), by lane id (plan 19):
//              set by the grab strip on the lane header's bottom edge
//              (TrackHeaders), read by tlMath.rowLayout through laneHeight.
//              Only heights other than AUTO_H are stored. Not part of the
//              project, so a resize is never an undo entry and never makes
//              the project dirty.
// A stale id (a removed track or lane) just matches nothing; a lane that an
// undo brings back (same id) gets its height back.
export const laneView = $state<{ open: Set<string>; master: boolean; suspended: Set<string>; gesture: boolean; heights: Map<string, number> }>({
  open: new Set(),
  master: false,
  suspended: new Set(),
  gesture: false,
  heights: new Map(),
});

/** Show (or hide) `owner`'s lanes. */
export function setOpen(owner: string, on: boolean) {
  if (laneView.open.has(owner) === on) return;
  const s = new Set(laneView.open);
  if (on) s.add(owner);
  else s.delete(owner);
  laneView.open = s;
}

/** Lane `laneId`'s row height (px): AUTO_H unless it was resized. */
export function laneHeight(laneId: string): number {
  return laneView.heights.get(laneId) ?? AUTO_H;
}

/**
 * Set lane `laneId`'s row height: whole px, clamped to LANE_MIN_H..LANE_MAX_H;
 * a non-finite `h` (NaN) is the default, AUTO_H.
 */
export function setLaneHeight(laneId: string, h: number) {
  const v = Number.isFinite(h) ? Math.round(Math.min(LANE_MAX_H, Math.max(LANE_MIN_H, h))) : AUTO_H;
  if (laneHeight(laneId) === v) return;
  const m = new Map(laneView.heights);
  if (v === AUTO_H) m.delete(laneId);
  else m.set(laneId, v);
  laneView.heights = m;
}
