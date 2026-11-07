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
//              dragged point or a stroke would land a page away).
// A stale id (a removed track or lane) just matches nothing.
export const laneView = $state<{ open: Set<string>; master: boolean; suspended: Set<string>; gesture: boolean }>({
  open: new Set(),
  master: false,
  suspended: new Set(),
  gesture: false,
});

/** Show (or hide) `owner`'s lanes. */
export function setOpen(owner: string, on: boolean) {
  if (laneView.open.has(owner) === on) return;
  const s = new Set(laneView.open);
  if (on) s.add(owner);
  else s.delete(owner);
  laneView.open = s;
}
