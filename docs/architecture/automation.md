# Automation

Drawn parameter changes over the song: filter sweeps, volume rides,
build-ups and drops (plan 10; spec addendum §3.4). This page covers the
engine. Code: `engine/src/automation.rs` (lanes, evaluation, the per-block
frame), `engine/src/engine.rs` (commands, base values, lifecycle),
`engine/src/mixer/mod.rs` (`Mixer::automate`), `engine/src/rack/mod.rs`
(`Rack::automate`). Tests: `engine/src/engine/auto_tests.rs`, the fixture
`engine/tests/fixtures/auto_eval.json`, `no_alloc.rs`
(`automation_does_not_allocate`) and `perf.rs`.

## Model

- **Lanes.** The engine has `MAX_AUTO_LANES` = 64 lanes for the whole
  project (tracks, returns and master together). Each lane has
  `MAX_AUTO_POINTS` = 512 point slots, so 32,768 points in all, about
  0.5 MB, allocated in `Engine::new`.
- **Addressing.** A point is `lane * 512 + idx`, like note slots. There is no
  shared pool and nothing is ever compacted or moved; every edit is one
  command.
- **Order.** A lane keeps the indices of its active points sorted by tick
  (`order`). The command phase keeps it sorted with an insertion sort: at
  most 512 entries, no allocation. Ticks are unique within a lane, so an
  instant change is a hold point followed by the next point.
- **Targets.** A lane drives one of:
  - `Mix { ch, id }`: a continuous mixer param of a track strip (0..31), the
    Reverb (32) or Delay (33) return, or the master (34);
  - `Rack { slot, module, param }`: a continuous param of a module in a synth
    track's patch.

  Integer, choice and flag params are never automatable. That rules out
  mute, solo, EQ and compressor on/off, the delay division, ping-pong, wave,
  mode, voices and the like. The engine checks that the target exists:
  - a track channel needs a track in its slot;
  - a rack target needs a synth slot and a module there, queued edits
    included.

  Audio slots take mixer targets only; a rack target there is
  `ERR_BAD_VALUE`. A second lane on the same target is `ERR_BAD_VALUE` too.

### Opcodes

| Op | # | Fields |
|---|---|---|
| `AUTO_LANE_SET` | 49 | `a` lane, `b` kind 0 none / 1 mix / 2 rack, `c` mix channel or rack slot, `d` mix param id or `module * 16 + param` |
| `AUTO_POINT_SET` | 50 | `a` `lane * 512 + idx`, `b` tick 0..`MAX_SONG_TICKS`, `c` value (param units, catalog range), `d` 0 linear / 1 hold |
| `AUTO_POINT_REMOVE` | 51 | `a` `lane * 512 + idx` (an inactive point is a no-op) |
| `AUTO_LANE_CLEAR` | 52 | `a` lane: no points, no target; the param goes back to its base |
| `AUTO_LANE_ENABLE` | 53 | `a` lane, `b` 0/1 |
| `AUTO_OVERRIDE` | 54 | `a` lane: suspend until the next breakpoint (not an edit) |
| `AUTO_POINT_CURVE` | 56 | `a` `lane * 512 + idx`, `b` curve −1..1 of the segment from that point to the next (0 straight). An inactive point is `ERR_BAD_VALUE`. `AUTO_POINT_SET` resets a point's curve to 0, so a curved point is sent SET, then CURVE (plan 16; 55 was `VIS_TAP` already) |

Validation:
- A bad lane, point address, channel or slot is `ERR_BAD_INDEX`.
- A bad kind, a non-automatable or missing target, or a duplicate target is
  `ERR_BAD_VALUE`, and so is a curve outside −1..1 or on an inactive point.
- So is a point that has a value out of range, a tick another point of the
  lane uses, or a lane without a target.

Re-targeting (`AUTO_LANE_SET` on a lane that has points) keeps the points
and checks them against the new range; if one does not fit, nothing changes.
Kind 0 (none) keeps the points too. Setting the lane's own target again is a
no-op: the base it captured stays.

## Evaluation

`Lane::value_at(t)` in the engine and `laneValueAt` in the app follow the
same rules. They are pinned by `auto_eval.json`, compared in knob space to
1e-6. Its points are `[tick, value, hold, curve?]` (the curve only when
not 0), and three cases are curved: a rising / falling S, an exp cutoff,
and curves on a hold point and on the last point. `curves_match_the_formula`
(engine) and `laneValueAt bends a segment by its left point's curve` (app)
check `f` itself at x = 0.25 / 0.5 / 0.75 for curves −1, −0.5, 0.5, 1
(1e-5).

- **Before and after the points.** Before the first point the lane holds the
  first point's value. After the last point it holds the last point's value.
- **Hold.** A hold point keeps its value up to the next point.
- **Linear.** A linear point interpolates to the next point in **knob
  space**, through the catalog `curve`:
  - `lin`: plain linear interpolation of the values. A fader ride is linear
    in dB.
  - `exp`: linear in the knob position `ln(v / min) / ln(max / min)`, which
    is logarithmic in the value. An EQ sweep from 200 Hz to 2 kHz is at
    632 Hz halfway.
  - `exp` with a minimum of 0 (MIDI In glide): the knob's zero zone. The
    bottom 2 % of travel is exactly 0; the rest is logarithmic from
    `max / 1000`. This is `ZERO_ZONE` / `EXP_FLOOR_RATIO`, the same mapping
    as `app/src/ui/rack/knobMath.ts`.
- **Curve** (plan 16). A linear point's `curve` (−1..1, 0 by default) bends
  its segment in that same knob space: at fraction `x` of the segment's
  time the value is `f(x) = x^(2^(−3·curve))` of the way (`bend` in both
  `automation.rs` and `automation.ts`). Curve 1 is `x^(1/8)` (fast, then
  slow), −1 is `x^8` (slow, then fast), ±0.5 is `x^(2^∓1.5)`. The exponent
  is always positive, so the ends stay put and nothing is NaN.
  - A hold point keeps its curve but ignores it (the hold wins).
  - The last point keeps its curve but has no segment to bend: after it the
    lane holds its value.
  - The per-block frame is unchanged: values at sub-block starts, mixer
    gains ramped linearly between them, so a steep curve (±1 near its fast
    end) is followed in 32-frame chords.
- **Cursor.** Each lane keeps a segment cursor (points at or before the last
  evaluated tick). Steady playback costs O(1) per lane per value: the cursor
  or its successor still fits. A jump re-seeks with a binary search.

### The per-block frame

`Engine::process` splits the block into its loop-wrap pieces once
(`transport::Piece`). It then evaluates the lanes over those pieces
(`Automation::frame`) and renders the same pieces. So a loop wrap re-seeks
lanes, notes and audio clips in one place.

- **When values are taken.** Every applying lane is evaluated in song time
  at each 32-frame sub-block start of the block (`RACK_BLOCK`), and at the
  block end. That is at most `MAX_BLOCK / RACK_BLOCK + 1` = 33 values.
- **Stopped.** While stopped, every value is taken at the parked position.
- **Line or step.** Each sub-block is flagged one of two ways:
  - a **line**: the lane follows a continuous stretch to the next value;
  - a **step**: anything else. That covers a lane starting to apply, a jump
    of song time (Play, Stop, seek, loop wrap, mode switch, a loop set
    behind the playhead), the end of a hold segment, and an edit of the
    lane since the last block.

  A step on the block's last value is carried into the next block's first
  sub-block.

## Smoothing

- **Mixer gains** (fader, pan, sends) follow a line with a linear ramp to
  the next sub-block value over the sub-block (`Ramp::line`). So a line is
  followed exactly at every sub-block start, and a breakpoint is off by at
  most one sub-block (0.67 ms at 48 kHz). A step uses the usual 5 ms gain
  glide.
  - **Steps are never cut short.** A line that starts while a step's glide
    still runs keeps the glide's end time and aims at the moving target. So
    after a jump the gain reaches the lane within one sub-block plus 5 ms,
    without sweeping from the old position.
- **Other mixer params** (EQ, compressor, reverb, delay feedback and high
  cut, limiter ceiling) get their DSP target once per sub-block. The DSP
  glides them as it glides a knob move.
- **Rack params** are written into the running module at its sub-block
  boundaries (`Rack::automate`). A `smooth` param glides over the module's
  5 ms one-pole. The others (tune, ADSR times, LFO rate) apply at the
  sub-block, which never clicks. On a silent rack (nothing heard for 50 ms,
  as at the start of a replayed song) the module's smoothers snap to the
  value instead, so the first automated block has no glide from the base.
- **The first block** of a freshly added track strip takes a step at once,
  and so do the returns and master before their first block after a reset.
  A replayed project (load, export, restart) therefore starts at its
  automated values, not with a 5 ms glide from the base.

Review bounds, pinned by tests:
- a −24 → 0 dB fader ride over a bar is within 0.1 dB of the line at every
  sub-block start (it measures under 0.005 dB);
- a hold step from 0 dB to −∞ on a constant 0.5 input has no
  sample-to-sample step above 0.02 (`linear_lane_follows_the_line`,
  `hold_step_is_declicked`).

## Base values and override

- **The base.** A lane remembers its target's **base value**: the value set
  by hand. It plays whenever the lane does not apply, and it is what the
  project saves.
  - `AUTO_LANE_SET` captures the target's current value as the base.
  - `MIX_SET` / `RACK_SET_PARAM` on an automated target update the base, and
    `MIX_RESET` resets it to the default.
  - While the lane drives the param, those edits are stored but not heard.
    The mixer keeps the base as its stored value (`Mixer::param`) and the
    automated value in an overlay (`Mixer::effective`). The rack param keeps
    the lane's value.
- **When a lane applies.** In Song mode, playing or stopped, when it has a
  target and points and is enabled and not suspended (`Lane::applies`). In
  Pattern mode, and for a disabled or suspended lane, the base plays.
- **Re-applying the base.** After every command, `Engine::command` re-applies
  the base of each lane that drove its target but no longer applies, with
  the normal smoothing (`Mixer::release_auto`, `Rack::set_param`).
- **Override.** `AUTO_OVERRIDE` suspends a lane:
  - while playing, until the playhead reaches the lane's next breakpoint
    after the current tick. This is checked at sub-block starts, and the
    lane comes back with a step;
  - also until any jump: Play, Stop, a seek, a loop wrap, a mode switch;
  - while stopped, until the next Play or seek.

  The UI sends it right before the manual edit's own `MIX_SET` /
  `RACK_SET_PARAM`. The override re-applies the base first, and the edit
  that follows is heard at once (`override_holds_until_next_point`). It is
  not an edit of the project: it is in `NON_EDIT_OPS`
  (`app/src/state/edits.ts`).

## Lifecycle

The engine clears a lane when its target goes away. Clearing has no fade:
the param just stops being driven, and its owner resets it anyway.

| Command | Lanes cleared |
|---|---|
| `REMOVE_TRACK`, `ADD_DRUM_TRACK`, `ADD_SYNTH_TRACK`, `ADD_AUDIO_TRACK` | every lane of the slot: its strip and its rack |
| `RACK_REMOVE_MODULE` | the module's lanes, at once, even when the removal is queued behind the rack's fade, so nothing ever drives a freed module slot |
| `RACK_CLEAR` (a patch load) | the rack's lanes; the strip's lanes stay |
| `RESET_ALL` | all lanes |

The UI removes the same lanes in the same `edit()`, so undo restores both
(see *App* below).

## Limits and cost

- 64 lanes × 512 points, preallocated (`lib.rs`, mirrored and parity-tested
  in `app/src/audio/protocol.ts`).
- Commands, the frame and the application never allocate, block or panic
  (`automation_does_not_allocate`: every op at the caps, with playback,
  wraps, a 1-tick loop, removals and a reset).
- With no lanes, nothing changes: the mixer runs each block in one chunk as
  before, and the golden `export_render.hash` and `export_audio.hash` stay
  bit-identical.
- Performance, native release (`perf.rs`): the spec §6 Song-mode mix with 4
  Audio tracks, plus all 64 lanes of 512 points, 32 of them applying (16
  mixer, 16 rack), costs 8.2 % of real time. The same mix without automation
  costs 8.1 %. The budget is 40 %.

## App (plan 10 Task 2)

Code: `app/src/state/automation.ts` (pure), `app/src/state/automation-actions.ts`
(edits), the model in `app/src/state/project.svelte.ts`. Tests:
`automation.test.ts`, `automation-actions.test.ts`, and the project / history /
export tests named in projects.md, history.md and export.md.

### Model

- `AutomationLane = {id, lane, target, enabled, points}`. `lane` is the
  engine lane, unique in the project; `points` are kept **sorted by tick**.
- `AutoTarget` is `{kind: 'mix', param}` or `{kind: 'rack', module, param}`,
  by catalog name. The channel is implied by the owner.
- **Owners.** Every `Track` has `automation: AutomationLane[]`: lanes on its
  own strip, and on synth tracks also on its own rack (Audio and drum tracks
  have no rack). The Master row's lanes (Reverb, Delay, master) are in
  `MixerState.automation` as `{channel, lane}`.
- `AutoPoint = {id, idx, tick, value, hold, curve}` (`curve` −1..1, 0 a
  straight segment; plan 16). `idx` is the engine point
  slot, and a lane's idx are always **dense** (0..n−1): the saved points are
  listed in idx order without an idx field (projects.md), and undo matches
  them by idx.
- What a knob is set to (`ChannelState.params`, a module's `params`) is the
  target's **base value**, as in the engine.

### Pure functions (`automation.ts`)

- `laneValueAt(points, tick, param)`: the engine's `Lane::value_at`, in
  float64. Lin params interpolate the values; exp params the knob position
  through `knobMath` `toPos` / `fromPos` (zero zone included); the fraction
  bent by the left point's `curve` (`bend`); clamped to the range; null
  without points. Pinned by `auto_eval.json` (`laneValueAt
  matches the engine fixture`, knob space, 1e-6). The knob rings (Task 4)
  draw it at the heard playhead.
- `nextBreakpoint(points, tick)`: the first point after `tick`, where an
  override ends.
- `thin(samples, tolerance)`: Ramer–Douglas–Peucker with the **vertical**
  distance (value at the sample's tick: ticks and values are not one unit).
  The ends are kept; the result is a subset of the input.
- `automatableParams(owner)`: the mixer params the owner's channel takes,
  catalog order, then (synth) each module's, rack order. Non-integer only,
  which also rules out every choice and flag. `targetDef(owner, target)` is
  the same rule for one target.
- `laneCount(p)`, `freeLane(p)`, `projectLanes(p)`.
- `laneSet(lane, channel, target, moduleKind)`: the one `AUTO_LANE_SET`
  builder (`packAutoParam` for rack targets). `laneSetCommand` (live lanes)
  and `commands.ts laneCommands` (saved lanes) both use it.
- `pointCommands(lane, from, to)`: the commands from one point set (idx →
  `PointTuple` `[tick, value, hold, curve?]`, the curve only when not 0) to
  another. **All `AUTO_POINT_REMOVE`s first** (an idx that goes, or whose
  tick changes), **then the `AUTO_POINT_SET`s** (new or changed idx), each
  followed by its `AUTO_POINT_CURVE` when its curve is not 0 (the SET reset
  it). A point whose curve alone changes gets the CURVE only (to 0 too). The engine refuses a SET on a tick another point of the
  lane still holds, and after the removals the only held ticks are those of
  points that keep their idx and tick. A point whose value or shape alone
  changes is SET in place, since it holds its own tick. Every point edit and
  undo go through it; a random-diff test drives it against the engine
  model.

### Actions (`automation-actions.ts`)

Each runs in one `edit()` (one undo entry). A refusal returns null or false,
changes nothing and sends nothing.

| Action | Sends | Refused when |
|---|---|---|
| `addLane(p, sink, owner, target)` (owner: a track id, or `'reverb'` / `'delay'` / `'master'`) | `AUTO_LANE_SET` on the lowest free engine lane | the target is not automatable there, already has a lane on that owner, or 64 lanes exist |
| `removeLane` | `AUTO_LANE_CLEAR` | no such lane |
| `setLaneEnabled` | `AUTO_LANE_ENABLE` | no such lane, or no change |
| `addPoint(p, sink, laneId, {tick, value, hold?})` | one `AUTO_POINT_SET` | 512 points, a tick already used, NaN; the tick is rounded and kept in the song, the value clamped |
| `movePoints(p, sink, laneId, ids, dTick, dValue)` | the difference | nothing moves. `dTick` is clamped so no moved point reaches an unmoved neighbour or leaves the song: the order never changes. **`dValue` is in knob position** (a fraction of the travel, as the lane is drawn), and each value is clamped to the range. **`origin`** (optional, a drag): the moved points' positions at the gesture start, by id; the deltas are then cumulative and apply to it, so clamping on the way loses nothing (a group dragged past the top and back keeps its shape; a glide point at 0 leaves the zero zone in small steps) |
| `deletePoints`, `setPointShape(…, ids, hold)` | the difference | nothing changes |
| `setPointCurve(p, sink, owner, laneId, pointId, curve)` (plan 16) | `AUTO_POINT_CURVE` | no such lane on that owner or no such point, NaN, or no change. The curve is clamped to −1..1. A hold or last point takes it (and ignores it until it is linear with a next point). Moves, shape changes and undo keep a point's curve: their SET is followed by the CURVE again |
| `drawPoints(p, sink, laneId, samples)` | the difference | nothing usable drawn, or more than 512 points would result. The samples are rounded to whole ticks (the last on a tick wins), clamped, and thinned in knob position to `DRAW_TOLERANCE` (0.5 % of the travel); the result replaces every point between the first and last sample's tick. The stroke's ends are always kept |
| `overrideLane(p, sink, laneId)` | `AUTO_OVERRIDE` only | no such lane. **Not an edit**: no undo entry, no unsaved mark. The manual move's own `setMix` / `setParam` that follows is the edit, and it sets the base |

- **Dense idx.** A point edit computes the lane's new point set. Points keep
  their idx when it is below the new count; new points, and points above
  it, take the freed idx below it. The difference goes through
  `pointCommands`. Point objects, and so their UI ids, survive.
- **Lifecycle** (same `edit()` as the engine's clear):
  - `removeModule` drops that module's lanes;
  - `loadPatch` (`RACK_CLEAR`) drops every rack lane of the track;
  - `rollbackRefusedAdd` drops the lanes of a module the engine never added;
  - `removeTrack` takes the track's lanes with the track;
  - the Master row's lanes stay.

### Persistence, replay, undo

- **Schema v3** (projects.md): lanes inside their owner's JSON, points as
  `[tick, value, 0|1]` in idx order, plus an optional 4th element, the
  curve, when it is not 0 (plan 16; no schema bump: a file without curves
  is unchanged). `validate` drops what the engine would refuse and clamps
  a curve to −1..1 (a point of another length, or a non-number curve, is
  malformed and dropped).
- **Replay** (`projectCommands`): after `MIX_SET_KEY`, before the
  transport: per lane `AUTO_LANE_SET`, its points (each curved one SET,
  then CURVE), `AUTO_LANE_ENABLE`. So
  load, export, the audio restart and undo's whole-track rebuilds have no
  automation path of their own. `load.ts units()` keeps a lane's commands
  in one unit, its CURVEs included.
- **Undo** (history.md, `diffApply` step 3b): lanes by engine lane; clear,
  then re-target; points by idx with `pointCommands`. The point UI objects
  (ids) are matched by tick first, then by idx for a point whose old tick
  is gone, so a selection stays on its point when a delete had compacted
  the idx.

## Timeline (plan 10 Task 3)

- **Layout map.** `tlMath.rowLayout(tracks, open, masterRow)` lists the
  timeline's rows top to bottom: each track's clip row (`LANE_H` 28 px),
  then its lanes (`AUTO_H` 48 px unless resized, see *Lane height*) while
  it is open (the header's **A**; `ui/song/laneView.svelte.ts`, UI state,
  not saved), an open track without
  lanes showing one empty lane row (no `laneId`) for "+ Lane"; then the
  pinned Master row (28 px) and its lanes. Every y question goes through it
  (`rowAt`, `clipLaneAt`): drawing, clip hit tests and box selection,
  audio clips' cross-lane moves, drops, and the header column, which
  renders the same rows. There is no uniform lane height any more.
- **Rows.** `AutoLane.svelte` draws one lane on its own canvas (editing a
  lane never redraws the clips): the curve in the owner's colour (Master
  row: `MASTER_GREY`) at knob position (so a linear segment is a straight
  line, exp params included), hold points square, the selection white, a
  disabled lane dimmed, a suspended one grey (`laneView.suspended`, set by
  Task 4), an empty lane's base value dashed. Point hit tests:
  `tlMath.pointHit` / `pointBox`.
- **Only lanes in view draw** (plan 10 Task 5). Every lane redraws on each
  view change (a scroll or zoom step). With all 64 lanes open that was
  ~60 ms per wheel step, so an `IntersectionObserver` on the timeline's
  vertical scroll container (`root`, with a 2-row margin) sets `shown`
  (mirrored as `data-shown`).
  - An out-of-view lane skips `draw()` and frees its canvas backing store
    (width/height 0).
  - When it comes within the margin it draws at the current view.
  - Measured in the serial perf e2e (docs/architecture/mixer.md,
    *Performance*).
- **Curves** (plan 16). `lanePolyline` samples a curved segment every 2 px
  across and every px up (`curveSamples`: curve 1 rises most of the way in
  its first pixels), only within the view, so the drawn bend is within half
  a pixel of `laneValueAt` and a segment wider than the view costs no more
  than the view.
- **Gestures.** Alt-drag on a segment (within `SEGMENT_R` 5 px of its drawn
  line, strictly between its two points; not a hold point's flat run)
  bends it: `tlMath.curveDrag`, vertical only, `CURVE_PX` 100 px = the full
  −1..1, rounded to 0.01, and dragging **up bends the line up** (a positive
  curve on a rising segment, negative on a falling one; a flat segment
  counts as rising). `setPointCurve` on the left point at most once per
  frame; the tooltip shows "Curve +0.60"; one gesture, one undo entry;
  Escape puts the old curve back. Nothing bends before 3 px of vertical
  travel (`DRAG_SLOP`), and an Alt-press on a line that bent nothing is an
  Alt-click (Ruling P): a free point at that tick and the value under the
  pointer, added on release, in the same undo entry. Click adds a point (1/16, Alt free) and keeps dragging it;
  a point drag calls `movePoints` with the gesture's `origin` and the
  cumulative deltas, at most once per animation frame; Cmd/Ctrl-drag
  previews a stroke and calls `drawPoints` once on release; right-click:
  Linear / Hold / Delete. history/gestures.ts makes each gesture one undo
  entry. Keys on a focused lane: Delete, Cmd/Ctrl+A, Escape, ←/→ (1/16,
  Shift a beat); the rest bubble.
- **Play follow.** While a lane press is down, `laneView.gesture` is set,
  and the Song-mode follow loop (`tlMath.followPage`) does not page the
  view (as for a clip drag): a dragged point or a stroke would otherwise
  land a page away. The flip comes on the first frame after the release.
- **Curve = sound.** `tlMath.lanePolyline` gives the drawn vertices; a test
  samples `laneValueAt` against it (exact, and within 1 px in an exp
  param's zero zone).
- **Master row.** Once it has a lane (added, loaded or undone back),
  `laneView.master` is set, so removing its last lane keeps the row (its ×
  hides it).
- **Headers** (`TrackHeaders.svelte`, labels in `autoLabels.ts`): the
  target ("Filter · Cutoff", "Fader", "Master · Ceiling"; module titles as
  the rack shows them), the on/off dot, ×, and "+ Lane" on the owner's last
  lane row, listing `automatableParams` without a lane yet.

### Lane height (plan 19 Task 2)

- **UI state.** Each lane's row height lives in `laneView.heights`
  (`ui/song/laneView.svelte.ts`), a `Map` keyed by lane id, holding only
  heights other than the default. `laneHeight(id)` reads it (`AUTO_H`,
  48 px, when absent); `setLaneHeight(id, h)` rounds to whole px and clamps
  to `LANE_MIN_H` 32 .. `LANE_MAX_H` 240 (a non-finite `h` is 48). It is not
  part of the project: not saved, never an undo entry, never dirty. A stale
  id (a removed lane) matches nothing; undo brings a lane back with its old
  id, so it gets its height back.
- **Layout.** `rowLayout(tracks, open, masterRow, laneH)` asks `laneH(laneId)`
  for each lane row's `h` (the timeline passes `laneHeight`); the empty
  "+ Lane" row is always `AUTO_H`. The header column and the lane overlays
  render the same rows, so they stay aligned while a height changes.
- **Every lane-local helper takes the row's `h`** (`posToY`, `yToPos`,
  `pointHit`, `pointBox`, `segmentHit`, `lanePolyline`), with no default, so
  a forgotten height is a type error rather than a silent 48. `AutoLane`
  gets `h` (its `Row.h`) and uses it for drawing, point and segment hits,
  the rubber band, a click's value and a drag's value per px (the travel is
  `h - 2 * AUTO_PAD`). Only its view margin (`IntersectionObserver`) stays
  at `2 * AUTO_H`.
- **The grab strip** (`TrackHeaders.svelte`): 5 px on the bottom edge of
  each lane's header (not the empty row's), `role="separator"`,
  `aria-orientation="horizontal"`, `aria-valuenow` = the height, focusable,
  `cursor: row-resize`, `data-testid="lane-resize-<laneId>"`. A drag sets
  the height live (the height before the press plus the pointer's travel).
  Escape, a lost pointer capture, or Cmd/Ctrl+Z / redo mid-drag (it is
  registered with `registerDragCancel`) put back the height from before the
  drag. Double-click resets to 48. ArrowUp / ArrowDown change it by 8 px
  (Shift: 1 px). Below 40 px the header's two lines close up so they fit.
  The lane area on the right has no strip: the bottom few px of a lane are
  where its lowest points sit and are grabbed.

## UI: knobs and faders (plan 10 Task 4)

- **`ui/autoBus.ts`** works like the mixer's meterBus: ONE
  requestAnimationFrame loop for every automatable control on screen.
  - `Knob.svelte` (rack and mixer knobs) and `Fader.svelte` register their
    target (owner + `AutoTarget`, the `auto` prop: `ModulePanel` passes the
    track and module idx, `Strip` the channel) with a callback. App creates
    the bus and hands it down by context (`provideAutoBus` /
    `useAutoBus`).
  - Each frame the bus reads the tick once (the **heard** tick from
    `AudioClock` while playing; the parked `songPosition` while stopped, where
    the engine applies the lanes too), evaluates `laneValueAt` for every
    registered control whose target has a lane, and calls the callback only
    when what it shows changed. The controls write the ring / pointer / cap
    straight into the DOM (`paint()`): no reactive state per frame.
  - The loop runs only while the transport plays in Song mode and a control
    is registered (= mounted; a hidden tab gets no rAF), and evaluates at
    most ~60 times a second (frames closer than 12 ms are skipped: a 120 Hz
    display evaluates every other one). Otherwise App calls `refresh()` when
    something shown may have changed: `project.version` (every edit, undo),
    playing, mode, songPosition, loading, a new clock.
  - The owner|target → lane lookup is cached until `project.version` or the
    project's `tracks` / `mixer` / `mixer.automation` arrays (a load) change;
    each lane's points and on/off are read live every frame.
  - Status per control: `none` (no lane), `on` (the lane applies: the value
    shown is the lane's), `idle` (a lane that plays nothing: Pattern mode,
    disabled, no points), `suspended` (overridden). Only `on` shows the
    lane's value; the others show the control's own (base) value.
- **Display.** A control with a lane draws its ring (or fader cap) at the
  automated value, a small tick (fader: a notch beside the slot) at its base
  value, and an **A** badge (grey unless the lane applies). A suspended
  control's ring / cap is grey, and so is its timeline lane
  (`laneView.suspended`, which the bus sets only when a suspension starts or
  ends). The tooltip names the base and says "Automated — dragging
  overrides until the next point".
  - While the lane applies, the **readout** (the knob's, and the strip's
    fader readout, which registers on its own) shows the heard value in
    italics, written by the callback; otherwise the base. The typed entry
    edits the base (what is saved).
  - `aria-valuenow` / `aria-valuetext` ("−12.3 dB, automated (base 0.0
    dB)") follow the heard value through `ariaThrottle`: at most every
    250 ms (the latest value trailing), at once when the lane starts or
    stops applying. That is reactive state at 4 Hz, not 60.
  - `data-auto` (status) and `data-auto-pos` / `data-auto-value` on the
    control, `data-auto="on"` on a readout showing the lane, mirror the
    state for tests.
  - Integer (non-choice) knobs never register (no lane can target them).
- **Manual move.** A drag, arrow key, typed value or double-click on an
  automated control calls `bus.touch()` first, then the normal action
  (`setMix` / `setParam`: it changes the base and is one undoable edit).
  - In Song mode, with an enabled lane that has points, `touch` sends
    `overrideLane` (AUTO_OVERRIDE, not an edit) and suspends the lane in the
    UI too. Every send of a drag does this, so the hand keeps the param for
    as long as it moves (each override re-counts "the next point" from where
    the engine is).
  - In Pattern mode (or a disabled / empty lane) it is just the normal
    action.
  - A drag grabs the control where its ring / cap is (the lane's value), and
    the arrow keys step from it, so the hand takes over from what is heard;
    a plain click sends nothing.
  - Escape mid-drag (or a lost capture) puts the old base back WITHOUT a new
    override. The drag's own overrides still hold until the next point:
    the engine has no "un-override".
  - The UI's suspension is the engine's rule (`Automation::suspend`),
    recomputed from the same data: while playing, until the lane's next
    breakpoint after the tick the **engine** will be at when the command
    lands (telemetry `ticks`, where the next block starts, plus one
    128-frame block: `blockTicks`), ended when the **heard** tick reaches it
    (so the grey ends when the lane is heard again); while stopped, until
    the next jump. Any jump ends it: Play, Stop, a seek, a mode switch (a
    change of playing / mode / songPosition) or a loop wrap (the heard tick
    going back more than 120 ticks).
  - A touch made after the engine wrapped but before the wrap is heard (its
    engine tick is behind the heard one) belongs to the new pass: the heard
    wrap does not end it, and its point is checked only after that wrap.
- **"Automate".** Right-click a continuous knob or fader (or press the
  ContextMenu key / Shift+F10 on the focused control: the menu opens at the
  control, its item focused; Escape gives focus back): the in-app menu
  (`ui/AutoMenu.svelte`, one for the app) offers **Automate** (no lane yet:
  `addLane`, one undo entry) or **Show automation**. Either opens the
  owner's lanes (the track's A; the Master row for the returns and the
  master) and scrolls the lane into view (AutoLane's `data-lane`). At 64
  lanes it says so ("No free automation lane: a project has at most 64")
  and adds nothing. Integer
  and choice controls do not offer it (`bus.canAutomate` = `targetDef`).
- **Not done:** knobs have no mouse-wheel gesture (they never had one), so
  "a drag, wheel or typed value" is a drag, arrow keys, a typed value or a
  double-click here.
- Tests: `autoBus.test.ts` (`ring follows laneValueAt at the heard tick`,
  `suspended until the next breakpoint`, `pattern mode shows the base`, the
  loop's lifetime, the one-block count, wraps, the lane cache and the 60 fps
  cap), e2e `knob ring follows a cutoff lane while playing`, `manual move
  overrides until the next breakpoint`, `Automate on a fader opens its
  lane`, `automated readouts and arrow keys follow the heard value`,
  `Automate menu from the keyboard; the 64-lane cap`
  (tests/e2e/automation.spec.ts).
