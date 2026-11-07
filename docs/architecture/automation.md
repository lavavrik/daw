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

The UI removes the same lanes in the same `edit()`, so undo restores both.
That is plan 10, Task 2.

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
