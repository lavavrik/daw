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

Validation:
- A bad lane, point address, channel or slot is `ERR_BAD_INDEX`.
- A bad kind, a non-automatable or missing target, or a duplicate target is
  `ERR_BAD_VALUE`.
- So is a point that has a value out of range, a tick another point of the
  lane uses, or a lane without a target.

Re-targeting (`AUTO_LANE_SET` on a lane that has points) keeps the points
and checks them against the new range; if one does not fit, nothing changes.
Kind 0 (none) keeps the points too. Setting the lane's own target again is a
no-op: the base it captured stays.

## Evaluation

`Lane::value_at(t)` in the engine and `laneValueAt` in the app follow the
same rules. They are pinned by `auto_eval.json`, compared in knob space to
1e-6.

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
  sub-block, which never clicks.
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
- `AutoPoint = {id, idx, tick, value, hold}`. `idx` is the engine point
  slot, and a lane's idx are always **dense** (0..n−1): the saved points are
  listed in idx order without an idx field (projects.md), and undo matches
  them by idx.
- What a knob is set to (`ChannelState.params`, a module's `params`) is the
  target's **base value**, as in the engine.

### Pure functions (`automation.ts`)

- `laneValueAt(points, tick, param)`: the engine's `Lane::value_at`, in
  float64. Lin params interpolate the values; exp params the knob position
  through `knobMath` `toPos` / `fromPos` (zero zone included); clamped to
  the range; null without points. Pinned by `auto_eval.json` (`laneValueAt
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
- `pointCommands(lane, from, to)`: the commands from one point set (idx →
  `[tick, value, hold]`) to another. **All `AUTO_POINT_REMOVE`s first** (an
  idx that goes, or whose tick changes), **then the `AUTO_POINT_SET`s** (new
  or changed idx). The engine refuses a SET on a tick another point of the
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
| `movePoints(p, sink, laneId, ids, dTick, dValue)` | the difference | nothing moves. `dTick` is clamped so no moved point reaches an unmoved neighbour or leaves the song: the order never changes. **`dValue` is in knob position** (a fraction of the travel, as the lane is drawn), and each value is clamped to the range |
| `deletePoints`, `setPointShape(…, ids, hold)` | the difference | nothing changes |
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
  `[tick, value, 0|1]` in idx order. `validate` drops what the engine would
  refuse.
- **Replay** (`projectCommands`): after `MIX_SET_KEY`, before the
  transport: per lane `AUTO_LANE_SET`, its points, `AUTO_LANE_ENABLE`. So
  load, export, the audio restart and undo's whole-track rebuilds have no
  automation path of their own. `load.ts units()` keeps a lane's commands
  in one unit.
- **Undo** (history.md, `diffApply` step 3b): lanes by engine lane; clear,
  then re-target; points by idx with `pointCommands`.

