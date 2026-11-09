# Modular rack

The synth-track engine: each synth track owns a rack (up to 32 modules) that
the audio thread renders in small sub-blocks. Code: `engine/src/rack/mod.rs` (graph, order, declick),
`engine/src/rack/catalog.rs` (module specs, golden generator),
`engine/src/rack/modules/*.rs` (the DSP); the generated module list is
`engine/catalog.json`.

## Layout (plan 18; plan 22 placement rule)

The Instrument tab's rack (`app/src/ui/rack/Rack.svelte`) has two layouts.
Spec: `docs/superpowers/specs/2026-11-13-acid-steps-rack-layout-addendum.md` §3;
the placement rule is plan 22's "Rack placement" (it supersedes plan 18's
push rule).

**The grid.** Everything sits on one grid: columns of 10 px (`GRID`) from
the content padding (6 px), and rows. A panel's `x` and width are in grid
units (its width rounded up). The pure layout is
`app/src/ui/rack/rackLayout.ts` (tests: `rackLayout.test.ts`).

- **Flow** (no module has a `pos`: house patches, older projects, after
  Tidy). `flowRack` places the panels by `idx`, left to right, each taking
  `ceil((width + 8 px) / 10)` units, and wraps when the next one would pass
  the rail's inner width (a panel wider than the rail gets a row of its
  own). It is on the same grid as a positioned rack, so the first drag pins
  every module exactly where it is drawn. (Plan 22 root cause: the flow
  used to be CSS flex with 8 px gaps, and the first drag re-derived
  positions from the on-screen rects by rounding to the grid. Each panel
  moved by up to 5 px, and a rounded overlap was then pushed right, so the
  whole row jumped.) Until every panel has been measured, `.content`'s CSS
  flex-wrap flow shows instead (one frame, before the first paint in
  practice).
- **Positioned** (any module has a `pos: {row, x}`). `layoutRack` draws the
  saved positions. Modules without a `pos` go at the end of the bottom row.
  Row numbers are kept as saved: a gap in them is an empty band.
- Both are drawn the same way:
  - The panels are absolutely positioned inside `.content` at
    `left = 6 + x·10`. Every row band is equally tall: the tallest panel's
    natural height in the whole rack, measured from the DOM. So row r's top
    is `6 + r·(band + 14 px)`, and it depends only on r. (Plan 22 fix round
    1: with each row as tall as its own tallest panel, moving a tall panel
    out of a row moved every row below it, measured at 110 px.)
  - Adding a taller module grows every band, and removing the rack's
    tallest shrinks them. This is accepted: it is the one thing that moves
    other modules vertically.
  - Every panel gets `min-height` = the band height (`box-sizing:
    border-box`), so the jacks of every row line up at the bottom. Panels
    keep `width: max-content`: far to the right, shrink-to-fit would squeeze
    them.
  - `.content` gets an explicit width (at least 100 %) and height, so the
    rail scrolls both ways.

**Placement rule (plan 22).** Only the module you move ever moves.

- `fits(placed, idx, row, x)` says whether the module fits at (row, x)
  without overlapping another module of that row. Touching is fine, and a
  new row below the last always fits.
- `moveTo` moves only that module, and returns null when it doesn't fit
  there. The caller then writes nothing and the module stays. There is no
  push and no swap.
- Overlap already in the saved data (an older project saved under the push
  rule with different widths, a panel that got wider) is resolved by
  `layoutRack`, deterministically: left to right in each row, each panel
  starts at or after the previous one's right edge. This cascades: one
  overlap can move several panels further along that row. A layout without
  overlap is
  drawn exactly as saved (`saved_layout_without_overlap_is_drawn_as_saved`).
  Every move saves the whole drawn layout (`toPositions`), so the
  resolution happens once and the next move writes it into the data.
  Drawing never pushes anything that the saved data doesn't already
  overlap. Plan 22 Task 2 makes a panel's width independent of its values,
  so a knob turn can't create an overlap.
- Rows are never renumbered. A row that a move, nudge or removal empties
  stays as an empty band, outlined like the rest while dragging (a free
  spot), until Tidy. Only trailing empty rows go: the row count is the last
  occupied row + 1, so trimming them moves nothing.
- "New row" is one below the last row any other module is in. So a module
  alone in the bottom row stays put when dropped below it, and a drop never
  leaves an empty row above the mover.

**Measuring.** `measure()` reads every panel's `offsetWidth` and natural
height (a transform doesn't change them) into `dims`. The layout is derived
from `dims`.

- The natural height is `offsetHeight` minus the panel's stretch spacer
  (`[data-stretch]` in ModulePanel, its only flex-grow child), which is
  what the band's `min-height` (or flow's stretch) adds. So the band height
  never feeds back into the measurement: when the rack's tallest panel is
  removed, the bands shrink to the next tallest.
- When a size changes, the layout changes, so measure runs again after the
  DOM update. This converges, because positions never change a panel's
  width or natural height.
- An effect on the derived geometry re-measures after a move that changed
  no size.
- Jack centres are measured relative to `.content`. The ResizeObserver
  watches the rail, `.content` and every panel.

**Dragging.** The panel header (`module-header-<idx>`, focusable) is the
handle. A press on its × is not a drag.

- While dragging:
  - `pointermove` stores only the client point; the rAF `measure()` derives
    the `.content` point from it (and from the release point on release),
    so there is no layout read per move;
  - the panel follows the pointer with a translate, and the cables
    re-measure every frame;
  - within 30 px of the rail's edge, or past it, the rail auto-scrolls
    toward that edge each frame (up to 16 px, faster deeper in). The
    scroll's `measure()` moves the drag point along. It stops when the
    pointer leaves the zone, the rail can't scroll further, or the drag
    ends;
  - the target row is the row band under the pointer (`geometry.bands` at
    the press, empty rows included), and below the last band a dashed "new
    row" band shows;
  - x is `round((pointer − grab offset − 6) / 10)`, then the nearest x
    within 2 units (20 px) where the module fits (`nearestFit`, ties to the
    left). A near miss beside a neighbour snaps against it instead of
    turning red;
  - a dashed outline (`rack-drop-outline`) shows where the module would
    land. Where it doesn't fit, the outline stays at the pointer's x and
    turns red, with "No free spot there — the module stays" under it
    (`rack-drop-refusal`, `data-refused`);
  - the grid is drawn faintly behind the panels (`rack-grid`). It has
    column lines every 10 px, stronger every 50 px, starting at the content
    padding, and each row band outlined. It reaches down through the new-row
    band. Colours are `--text-2` mixes. It is hidden otherwise.
- On release, with more than 3 px of travel and a changed placement that
  fits, there is one `setRackLayout(…, 'Move module')`. It runs inside the
  pointer gesture, so it makes one undo entry. A refused drop writes
  nothing, and the panel goes back. The status line (`flashHint`) and the
  live region say why.
- **Bounds.** The saved `pos` must stay within row 0..31 and x 0..1000
  (`patches.ts` drops a rack's whole layout otherwise). A drop's x is
  clamped to 1000. `inBounds(result, base)` holds only the panels whose x
  the move changes to x ≤ 1000, so a panel already drawn past 1000 (pushed
  by a grown neighbour, or a module added at the end of the bottom row)
  doesn't block other moves. `toPositions` saves such a panel at 1000, and
  `layoutRack` draws it back where it was (the overlap resolution above). A
  move out of bounds writes nothing, and is refused like a move that
  doesn't fit ("Too far right — move left or Tidy", "No more rows — move it
  up or Tidy"). `nearestFit` never offers an x past 1000. Empty bands are
  kept, so a module in row 31 can make a drop below it a 33rd row, which is
  refused.
- In a flow rack the base is the drawn flow (`flowRack`): the first drag
  pins every module where it is and moves this one, in the same entry.
- Esc, Cmd/Ctrl+Z or redo mid-drag cancel it through `registerDragCancel`,
  and nothing is written.

**Keyboard.** Alt+arrows on a focused header move the module by 1 grid unit,
or 1 row at the same x. A nudge moves only if the module fits there:

- A nudge into a neighbour, or Up/Down into a row where that x is taken,
  does nothing. There is no snapping to another x: a nudge goes exactly one
  step or nowhere.
- The module's outline flashes red for 400 ms (`rack-bump-outline`), and
  the live region says "No free spot there — the module stays". The region
  is cleared and set again a tick later, so a repeated refusal is announced
  each time. There is no status-line flash: bumping into a neighbour is
  routine.
- Down from the bottom row makes a new row (a module alone in the bottom
  row stays).

- Quick nudges are one entry: the coalesce key is
  `sweepKey('rackmove:<trackId>')` (`history/sweep.ts`), and it steps after
  1 s idle.
- The rack's polite live region (`jack-status`, shared with keyboard
  patching) announces each move: "Moved VCA to row 2, position 31" (row
  1-based, position in grid units). A refused nudge says why instead.

**Tidy** (toolbar, `rack-tidy`) removes every `pos` ("Tidy rack"). It is
disabled when the rack already flows.

**Tests.** The e2e tests are in `tests/e2e/rack.spec.ts`:

- `cables follow wrapped rows`;
- the plan 18 drag tests: new row (and undo back to the identical flow),
  click, Tidy, undo mid drag, keyboard (and its announcement), wide rack,
  own spot, x within 0..1000, a panel past 1000 not blocking others, edge
  auto-scroll;
- the plan 22 placement tests:
  - a small drag of the first row's last module moves only it, and every
    other module stays within 1 px, with the grid shown during the drag;
  - a drop onto another module is refused (red outline, hint, nothing
    written);
  - a near miss snaps against the neighbour, and Alt+Left into it does
    nothing;
  - a nudge or drop into the VCA at x 1000 is refused;
  - every band is as tall as the rack's tallest panel, and removing that
    panel shrinks them (no ratchet);
  - nothing moves vertically: a drag of row 1's tallest to a new row,
    Alt+Down out of a row, or removing a module from a middle row leaves
    every other rect within 1 px;
  - a refused nudge flashes red and is announced again each time.

### Look and param controls (plan 20 redesign; plan 21 mechanical faceplates)

The rack follows the design board "Instrument rack" (spec §2–§4), redrawn
as mechanical faceplates in plan 21. Every
colour, shadow, radius and font is a `theme.css` token; the rack files have
no hex literals (`noHexColors.test.ts`).

- **Faceplates** (`ModulePanel.svelte`; plan 21 Task 10, spec 2026-11-15
  §11, the board `.superpowers/design/boards/RackMechanical.dc.html`): a
  `.mech-panel` (gradient, 8 px corners) with four `.screw`s (under the
  header and in the bottom corners), a 30 px `.mech-head` strip in the
  module's category colour (uppercase, letter-spaced, `--on-color` text),
  the params, then a footer under an engraved divider (`--mech-divider`):
  inputs left, outputs right. Recipes: `docs/architecture/ui-theme.md`
  "Mechanical faceplates". Plan 20's boxed output plate and the vertical
  "in"/"out" labels are gone (the board has neither); the inputs/outputs are
  `role="group"`s named "<module> inputs/outputs".
- **Jacks** (`Jack.svelte`): an 18 px metal socket (`--mech-jack`) with a
  2 px ring in the signal colour; the engraved name sits ABOVE the socket
  (the board puts it below; cables sag down from the socket and would cross
  it). The Rack still measures the `.hole`'s centre.
- **Category colours** (`ui/theme.ts` `moduleColor`): the spec has six
  (source, filter, modulation, utility, effect, output) and the catalog four
  (`source/shaping/utility/effect`). `CATALOG_CATEGORIES` maps the catalog's
  (`shaping` → filter), and `MODULE_CATEGORIES` overrides per module as on
  the board: ADSR, LFO, Accent → modulation; VCA → utility; Saturator →
  effect; Out → output. The add-module menu still groups by the catalog
  category (its header in that colour); each item has a dot in the module's
  own colour.
- **Jack and cable colours** (`ui/theme.ts` `jackColor`): audio orange, cv
  blue, gate green, vel purple. The catalog's `pitch` is a cv (1 V/oct); its
  velocity ports are plain `cv` ports named `vel`, so the name gives them the
  vel colour. A cable takes its output's colour. `theme.test.ts` checks
  every catalog module, category and port gets one.
- **Widths and heights.** Cards are at least 180 px and as wide as their
  knob grid (`max-content` when positioned); with the mech controls a row of
  modules is ~420–440 px tall, so the rail scrolls vertically sooner. The
  positioned layout re-measures as before (`rackLayout`); tests that drop a
  module into another row scroll that row into view first (`rack.spec.ts`
  `dragToGridX`). The card has no negative margins: Chrome sizes them
  differently for a flex item (the CSS flow shown before the first measure)
  and a `width: max-content` panel (drawn), and the two widths must agree,
  or the grid layout would differ from what was measured.

- **Stable widths (plan 22).** No param value may change a module's
  width: that would shift every module to its right (a decimal appearing
  while dragging Attack did exactly that). Three rules keep it so:
  1. The value chip of every control has `min-width: <n>ch`, with `n` =
     `knobMath.widestValue(def)`: the widest string `formatValue` can show
     anywhere in the param's range (min, max, default, a dense position
     sweep, and every decade's widest 3-digit pattern, so ms -> s and
     near-zero decimals are covered), in the tabular-numeral mono font.
     `formatValue` itself reads a linear zero-crossing param's values under
     a thousandth of its range as 0, so that bound stays small.
     `knobMath.test.ts` checks it for every catalog and mixer param.
  2. The rest of a panel is value-independent: a mech knob's cell is a fixed
     `dial + 12 px` (`+ 10` compact), the knob grid has `knobColumns(n)`
     columns of those cells, labels are cut with an ellipsis (the title has
     the full name), the ports and header are static. So a module kind's
     width is its control layout (columns x cell width, the widest of the
     faders / knobs / choices / ports rows), never its values.
  3. A mixer strip is a fixed 132 px; its compact knobs sit in fixed 56 px
     cells, and their chips (rule 1) stay inside.
  `tests/e2e/rackwidths.spec.ts` sweeps Attack, and sends every param of
  every house-patch module (and of a strip) to min and max, asserting no
  width moves.

Which control draws each param is `app/src/ui/rack/controlMap.ts` (pure,
`controlMap.test.ts`); `ModulePanel` draws `panelControls(def)` in this
order, every control keeping the test id `knob-<m>-<param>`:
- **Choices** (`ChoiceParam look="led"`): 6 or fewer
  (`knobMath.SEG_MAX_CHOICES`) are LED push-buttons (`ChoiceSeg`: a
  `.mech-btn` per choice under an LED that glows in the module colour when
  picked; the radiogroup, its radios `<testid>-<i>`, the arrow keys and one
  undo entry per change are as before); more (Delay and LFO/Scope
  divisions) are a skinned `<select>` carrying the test id (letters are
  swallowed: they are the QWERTY piano). Full width, centred, the engraved
  label under the buttons.
- **Vertical faders** (`Knob variant="vfader"`), side by side in one row,
  for levels and envelope stages: `VFADERS` lists ADSR
  attack/decay/sustain/release, the Mixer's `lvl1..4`, Out `level`, VCA
  `level`, Noise `level`; a module not listed gets one for a continuous,
  linear, 0..1 param named `level` (the rule). Sample Player's gain (0..2)
  and Formant's g2/g3 stay knobs. The slot (110 px, CSS `--vf-h`) is the
  full range: a vertical drag is relative (Shift 10× finer); a release with
  under 3 px of *vertical* travel jumps to the pointer on the slot's live
  rect (`knobMath.sliderPosFromY`), so a sideways wobble is still a click; a
  press on the cap never jumps. Bipolar params would fill from zero.
- **Mech knobs** (`Knob variant="mech"`) for everything else, in a grid of
  `knobColumns(n)` columns (1–2 side by side, ≤ 4 in two, ≤ 9 in three,
  more in four). Sizes: the `HERO` param (`filter.cutoff`,
  `sample_player.root`, `lfo.rate`) is `lg` (86 px) and first; knobs that
  share the card with faders, or more than `COMPACT_OVER` (6) knobs
  (Oscillator, Formant), are `sm` (46 px); else `md` (58 px). Same
  behaviour as plan 20's dial: vertical drag (150 px = full range), typed
  entry by clicking the value chip, double-click reset, keys, automation
  follow, the control menu, MIDI learn, one undo entry per gesture.

The plan 20 slider (`variant="slider"`) is no longer used in the rack; it
stays in `Knob.svelte` for the top bar's Master.

Tests (`rack.spec.ts`, plan 21 Task 10): "mech knob: …", "vertical fader:
…" (also in a horizontally scrolled rack, and "a press on the cap never
jumps; …"), "mech knob and vertical fader: MIDI learn ring and CC tag, the
control menu, automation follow", "LED choice: …", "integer mech knob: …",
"a choice with more than 6 options is a select; the faceplate".


## Signals

All signals are f32 buffers; the kind only matters for cable colour and docs.

| Kind  | Range | Notes |
|-------|-------|-------|
| audio | about -1..1 | |
| pitch | V/oct, 0 = C4 | `midi_in` pitch includes bend and glide |
| gate  | 0 / 1 | |
| CV    | 0..1 or -1..1 | envelopes 0..1, LFO bipolar |

## Sub-blocks, order, feedback

The rack renders in `RACK_BLOCK` = 32-frame sub-blocks (a 128-frame quantum is
4 of them). Modules run in Kahn topological order. If the graph has a cycle it
is broken at the lowest-index module actually on the cycle; that cable
becomes a feedback edge and reads the previous sub-block (a 32-frame delay).
The rack output is guarded against NaN/inf, and modules flush DSP state
below 1e-20 to 0 (denormals).

## Polyphony

Cables are multichannel: channel count = max over the module's connected
inputs. `midi_in` emits one channel per voice (1 in mono mode); a mono signal
feeding a poly input is broadcast. An input takes one cable (connecting again
replaces it).

- **Poly**: a new note-on takes a free voice (never-used first, then the
  longest-released, so fresh release tails survive); with none free it steals
  the voice with the oldest note-on. Glide is ignored in poly. A reused voice gets a
  one-sub-block gate gap so envelopes retrigger.
- **Mono**: legato (overlapping notes do not retrigger) with optional glide (last-note priority);
  glide is the time to cover 99% of the interval (1% remains).
  `glide_mode` picks which notes glide: **Always** (the default, as before
  plan 11) glides every note, including one started from silence;
  **Legato** glides only a note pressed while another is held (the gate
  stays high), so a note from silence jumps to its pitch. That is the house
  "slide" (Acid Line, Sax). Poly ignores both modes.
- The ladder filter (LP24) is characterful on purpose: a saturator inside the
  feedback loop makes the resonant peak compress with input level (ruling
  R10; see `rack/modules/filter.rs`). Cutoff is smoothed in the log domain.
- The filter's **Diode** mode (plan 17, `mode` id 5, appended after Notch)
  is a 3-pole ladder for acid lines: each stage driven through a soft
  saturator, the feedback taken through a high-pass at half the stage
  frequency. Its resonance is softer and wider than LP24's and stops just
  short of self-oscillation at reso 1 (`k = 12.8 × reso`; the linear loop
  oscillates at ≈ 12.85), and it thins the bass as it rises: at reso 0.9
  and a 1 kHz cutoff the 30..200 Hz band sits ~3.5..6 dB down and the peak
  ~+10 dB. A makeup of `1 + 0.5·k` applies only to the high-passed part of
  the output, so the passband comes back up without boosting the
  sub-bass. It has its own state (three stages + the high-pass), and a
  switch to or from it uses the same 2 ms crossfade as every core change
  (the incoming core starts from zero). Tested stable (finite, bounded
  states, output under the limiter's ±3.5) at every cutoff and reso at
  44.1 and 96 kHz.
- **Voice LEDs** (plan 12; `app/src/ui/rack/VoiceLeds.svelte`): the
  Instrument tab's header shows "Voices" and one LED per voice of the
  first MIDI In (lowest module idx; its `voices`, 1 in Mono; none without a
  MIDI In). Brightness is the voice's level across the rack's Outs (−48..0
  dB → dark..full; the engine reports nothing below −60 dB), a ring means
  its gate is held. Read from visSab (want bit 4) by a 30 Hz frame-loop
  consumer that leaves the loop after 0.5 s stopped and dark (Play, a
  note-on or an edit wakes it); see [visuals.md](visuals.md#voice-leds).

## Envelopes

The ADSR (`rack/modules/adsr.rs`) runs Idle → Delay → Attack → Decay →
Sustain → Release per channel. Plan 11 appended (indices unchanged):

- `delay` (0..4 s, 0 = off): a rising gate holds the current level for
  `delay`, then attacks. A falling gate during it releases from that level;
  a retrigger restarts it; a held gate (legato) never does. Used for delayed
  vibrato (the Sax).
- input `vel` and `vel_amt`: `env = level × (1 − vel_amt + vel_amt × v)`,
  with `v` latched at the rising gate (unconnected = 1), so a note's dynamic
  holds through it; the latched value glides over 5 ms so a voice steal at a
  sounding level never steps. Patch MIDI In `vel` into it for velocity
  brightness or loudness. Mono MIDI In `vel` jumps to a note started from
  silence (so the ADSR latches that note's velocity) and glides 5 ms only
  on legato notes, which the ADSR ignores anyway (no new edge). Exception to
  "sounding level never steps": a mono patch that patches `vel` straight to
  an audio VCA (not through an ADSR) now steps the previous note's release
  tail to the new velocity when a note starts from silence.
- With `delay` 0, `vel_amt` 0 the output is bit-identical to the
  pre-plan-11 envelope (pinned by `adsr_defaults_are_bit_identical`), so old
  patches and export hashes are unchanged.

**Shape previews** (plan 12): the ADSR and LFO panels draw their shape
above the knobs (`app/src/ui/rack/ShapePreview.svelte`, curves in
`app/src/ui/vis/shapes.ts`): the ADSR as Delay → Attack → Decay → a
fixed-width sustain plateau → Release on a √t time axis (labels give the
real times, "+delay · A · D · S% · R"), drawn at full velocity with a
dashed softest-note curve when Velocity > 0; the LFO as one cycle × depth
from the engine's phase 0, labelled "2.00 Hz · 500 ms" or "1/4 · 500 ms".
They follow the knob values shown, automation lanes included. The curves
are checked against the real modules: `engine/tests/shapes.rs` writes
`engine/tests/fixtures/shapes.json` (`UPDATE_FIXTURES=1`) and
`shapes.test.ts` requires every engine point within 0.01 of the drawn
line. Change an envelope or LFO curve here → regenerate the fixture and
update `shapes.ts`. Details: [visuals.md](visuals.md#shape-previews).

## Declicked edits and smoothing

Structural edits (remove module, connect, disconnect, clear) made while the
rack is sounding are validated at once, queued (64 entries), and the output
fades out over 2 ms (`DECLICK_SECONDS`), the queue applies at a sub-block
boundary, then it fades in over 2 ms. On a silent rack the edit applies at
once but the output still ramps up from 0. Adding a module (it has no cables
yet) applies immediately unless edits are already queued.
**Scope edits never fade** (plan 12): a Scope has no outputs, so removing
it, plugging cables into its inputs or unplugging them and setting any of its params
(choices too) apply at once even while sounding and never ramp the output;
behind already-queued edits they queue in order without a fade of their
own (`EditClass::Sink`; see *Scope (18)*).
Parameters marked `smooth` in the catalog glide over 5 ms. Integer and
choice parameters (osc wave/octave/unison, filter mode, LFO wave/sync/
division, MIDI In voices/mode/bend/glide_mode) switch the signal in a step, so they are
declicked like structural edits: queued behind the 2 ms fade-out while
sounding, applied, faded back in (on a silent rack: applied at once, output
ramps up from 0). Re-sending the current value is a no-op and never dips the
output. The remaining non-`smooth` continuous params (tune, fine, ADSR times incl. delay,
glide, LFO rate) apply at once: they change a rate, not a level, so phase and
envelopes stay continuous, and fading them would dip the output on every step
of a knob drag.

## Automation (`Rack::automate`)

An automation lane on a rack param (`docs/architecture/automation.md`) is
applied by `Synths::render_add`. It passes the block's `AutoFrame` to
`Rack::render_add_auto`, and at each sub-block boundary every entry for this
slot calls `Rack::automate(module, param, value)`:

- **The normal path, never queued.** The value goes straight into the
  running module's param: a `smooth` param glides over its 5 ms one-pole,
  the others apply at the sub-block. It never queues behind a structural
  fade. That is why only non-integer params are automatable: a stepped one
  would need the fade.
- **Modules not driven.** A module whose add or removal is still queued is
  not driven, and neither is an integer param.
- **The base.** The lane keeps the hand-set value (the *base*). While the
  lane drives the param, `RACK_SET_PARAM` only stores the base, validated
  by `Rack::check_param`. When the lane stops applying (Pattern mode,
  disabled, overridden, cleared), the engine re-applies the base with
  `set_param`. `AUTO_LANE_SET` captures the base with
  `Rack::pending_param`: the value once queued edits apply.
- **Lifecycle.** `RACK_REMOVE_MODULE` clears the module's lanes at once,
  even when the removal is queued behind the fade. `RACK_CLEAR` (a patch
  load) and removing or replacing the track clear the rack's lanes.

## Levels

Two policies, side by side:

| | Starter patches | House patches (plan 11) |
|---|---|---|
| Rule | Out `level` set low on poly patches so a 4-note chord (5 for Pad) peaks below ~0.9 pre-limiter | Loudness −15 dBFS ± 3 dB on the patch's typical phrase at velocity 100, and a pre-limiter peak < 0.9 at velocity 127 |
| Where | `STARTER_PATCHES` (Chord Stab 0.4, Pad 0.25, Pluck 0.3) | `housePatches.ts` |
| Test | `engine/tests/starter_patches.rs` (fixture `starter_patches.txt`) | `engine/tests/house_patches.rs` (fixture `house_patches.txt`) |
| Consequence | Poly is ~9 dB quieter than mono | Patches sit at similar loudness without fader moves |

Out sums every poly channel unnormalised (8 voices at full level would be
8x one voice), times `level`. The starter patches are the default track
patch and the test fixtures, so they never change; that is why the house
set has its own rule instead of retuning them.

## House patches

Twelve built-in patches in `app/src/state/housePatches.ts`, grouped in the
patch menu after the starters (`BUILTIN_GROUPS` in `patches.ts`; the group
is not part of a `Patch`, so saved files don't carry it). Each has a purpose
comment and a comment per module.

| Group | Patch | Voice | Phrase | Role |
|---|---|---|---|---|
| Leads & Stabs | Sax | mono | lead | Breathy alto-like hook lead |
| Leads & Stabs | Brass Stab | poly | chord4 | Disco-house hit; Formant + filter bloom |
| Leads & Stabs | Arp Pluck | poly | arp | Short bright 1/16 pluck |
| Keys | Tine Keys | poly | chord4 | FM e-piano; velocity rings the bell |
| Keys | Piano Stab | poly | chord4 | Classic house piano stab |
| Keys | Garage Organ | poly | chord4 | Percussive UKG organ, Formant wah |
| Bass | Organ Bass | mono | bass | Hollow 90s organ bass |
| Bass | Reese Bass | mono | bass | Detuned Reese; mod wheel opens it |
| Bass | Acid Line | mono | bass | Velocity accent, legato slide |
| Bass | Sub Bass | mono | bass | Clean sub, a little saturation |
| Pads | Strings | poly | chord5 | String-machine swell + chorus |
| Pads | Warm Pad | poly | chord5 | 2-bar LFO-swept pad + chorus |

Phrases (`HOUSE_PHRASES`): chord4 = C4 E4 G4 B4, chord5 = C3 G3 C4 E4 B4,
bass = C2 then C3, lead = C4, arp = C4 E4 G4 B4 as 1/16 at 124 BPM, one bar.

**Rules** (checked for every built-in by `patches.test.ts`): one MIDI In and
one Out; MIDI In `pitch` feeds every Osc and `gate` every ADSR; at most 24
modules (room to edit under the 32 cap); unique names, case-insensitive,
and no trademarks. **No Delay or Reverb** in a patch: use the mixer sends,
so loading house patches never drains the 8-slot FX banks. Chorus (16
slots) is allowed where it defines the sound (Tine Keys, Strings, Warm
Pad). Built-in names are refused by Save patch (`isBuiltinName`).

**Sax signal flow** (19 modules, mono, glide Legato):

```
MIDI In  pitch -> Osc A (saw), Osc B (square, +5 ct), Formant.pitch
         gate  -> amp, filter, breath and vibrato ADSRs
         vel   -> amp, filter and breath ADSR .vel
         mod   -> Formant.cv      (mod wheel: formants up, brighter)
Osc A + Osc B -> Mixer -> Formant (3 peaks, track 0.15) -> LP12 (cv <- filter ADSR)
  -> Saturator -> VCA (amp ADSR) -> Mixer 2.in1
Noise -> BP 3.2 kHz -> VCA (breath ADSR: short chiff, quiet hiss) -> Mixer 2.in2
Mixer 2 -> Out
LFO 5.2 Hz -> VCA (vibrato ADSR: Delay, then fade-in) -> Osc A.fm, Osc B.fm
```

The Sax has no amplitude overshoot: the onset "push" is the filter
envelope's brightness overshoot plus the breath chiff. Its acceptance
numbers (formant body, chiff lead, delayed vibrato, velocity ratio, legato
vs separated notes, mod-wheel brightening) are measured in `house_patches.rs`.

**Loudness rule.** Momentary loudness = the maximum RMS of (L+R)/2 over
400 ms windows (100 ms hop), unweighted, pre-limiter at the default master
gain (the ×8 trick from `starter_patches.rs`). Unweighted RMS makes Sub
Bass sound quieter on small speakers at equal RMS; that is accepted.

**Retuning a patch.** Edit its `Out` `level` (or the sound) in
`housePatches.ts`, regenerate the fixture
(`UPDATE_FIXTURES=1 npx vitest run app/src/state/patches.fixture.test.ts`),
then run `cargo test -p daw-engine --test house_patches` and read the
numbers. Tune the patch, never the test band; any band change is recorded
in `docs/followups/plan-11.md`.

## Noise (2)

A *Source* with one mono `out` (one per voice) and params `level` (0..1,
smoothed) and `color` (appended in plan 16: White / Pink, default White).

- **White**: a fixed-seed xorshift32, uniform in −level..level (the same
  sequence every load, so renders are deterministic). Color White is the
  pre-plan-16 module sample for sample, so saved patches (the Sax's breath)
  are unchanged.
- **Pink**: the same white through Paul Kellet's refined pink filter
  (−3 dB/oct, six parallel one-poles plus a direct and a one-sample-delayed
  path). The coefficients are for 44.1 kHz; at other rates each positive
  pole `p` becomes `p^(44100/sr)` and its gain is scaled by
  `(1 − p')/(1 − p)`, so the corners stay put in Hz (the negative,
  near-Nyquist section and the delayed path are kept). The output is
  divided by the root of the filter's impulse-response energy (closed form,
  computed when the module is created), so pink's RMS equals white's at
  every rate (measured within 0.15 dB at 44.1/48/96 kHz). Pink is *not*
  bounded to ±level: its peaks run to about 4× its RMS (≈ ±2.3 at level 1).
- The filter state (six sections and the delayed sample) lives in the
  module, one per voice; nothing allocates. The sections run under White
  too (six one-poles a sample; White's output never reads them), so
  switching color mid-note just changes which sample is output: a switch to
  Pink continues exactly as a module that was Pink all along, with no stale
  state from before and no transient.
- Tests (`modules/noise.rs`): `pink_slope` (100 Hz–1 kHz vs 1–10 kHz within
  ±1 dB — white reads −10 dB — and one octave vs another, at 44.1 and
  96 kHz), `pink_rms_matches_white` (within 1 dB at 44.1/48/96 kHz),
  `white_is_unchanged_by_the_color_param`,
  `white_to_pink_mid_note_has_no_stale_state`.

## Effect modules and the FX pool

Plan 6 added Delay (9), Reverb (10), Chorus (11), EQ (12), Compressor (13),
Saturator (14) and Attenuator (15). They wrap the mixer's DSP
(`engine/src/dsp/`), with the mixer's defaults where they overlap.

- **Stereo effects** (Delay, Reverb, Chorus, EQ, Compressor; the pink
  *Effect* group): inputs `l` and `r` (`r` falls back to `l` when
  unconnected), outputs `l` and `r` of **one channel each**. A poly input is
  summed first, so one reverb serves a whole 16-voice patch. The
  Compressor's `sc` input is the key (summed to mono); unconnected, it keys
  on itself.
- **Delay** syncs to the transport tempo and uses the mixer delay's
  division table (`DELAY_DIVISIONS` in `mixer/catalog.rs`, default 3/16).
  Synced times over 2 s are clamped; the knob shows "(max 2 s)" then, as on
  the mixer delay.
- **Saturator** (*Shaping*) and **Attenuator** (*Utility*: `in × amount +
  offset`) are per channel (poly).
- **FX pool** (`engine/src/rack/fx_pool.rs`). The module enum is inline and
  fixed-size, so Delay (2 s stereo ring), Reverb (FDN lines + predelay) and
  Chorus (50 ms ring) never own memory. They hold a `u8` slot of an
  engine-owned pool, allocated once for the context sample rate and
  **shared by all tracks**: 8 delay, 8 reverb and 16 chorus slots (10.5 MiB
  at 48 kHz), plus the 8-slot scope bank (256 KiB; see *Scope (18)*). The dsp structs come as a `*Core` that takes the ring in
  `process(buf, l, r)`; the mixer's own Delay/Reverb wrap the same core with
  a `Vec`, bit-identically (`mixer_delay_reverb_unchanged`).
  - Adding one when its bank is full returns `ERR_OUT_OF_MEMORY` and adds
    nothing. The UI never sends it: the add menu greys the module with
    "All 8 delays in use" (counted over the project's tracks).
  - A slot returns to the pool only when its module is gone: when the removal
    or clear *applies*, after the 2 ms declick fade.
  - A reused slot is zeroed before its new module gets it, 32 KiB per
    sub-block (`CLEAR_CHUNK`; a reused delay is mute for about 21 ms), so it
    never replays the previous owner's echo. Worst case, every pooled slot
    zeroing in the same sub-block, is 1 MiB of memset per 0.67 ms sub-block.
  - **Handover on replace.** Because a slot is held through its module's
    removal fade, "remove (or clear) then add" in one batch on a sounding
    rack (a patch load) would find a full bank although the UI counts the
    slot free. So when the bank is full, `add_module` takes over the slot of
    a *queued* Remove/Clear in the same rack: the queue applies in order, so
    the old module is gone before the new one runs. The new module is reset
    when it applies, which restarts the slot's zeroing (`FxPool::reassign`),
    so it starts silent. A `handed` mask absorbs the old owner's release.
    Across tracks there is no handover (another track's fade is independent):
    if the engine still refuses an add, the worklet reports it and the UI
    rolls the add back with the same "All 8 delays in use" message.
  - `Module::reset` on a pooled effect also restarts its slot's zeroing (the
    ring is the pool's; the module only marks it).
  - The engine reset (`OP_RESET_ALL`) hard-clears every rack first
    (`Rack::reset_hard`: no fade, queued edits and pending releases
    forgotten) and only then frees the whole pool, so no stale release can
    free a slot a new module has claimed.

## Sample Player (16)

A *Source* that plays a sample of the project's sample pool (the samples
the drum rows use), one voice per channel. Inputs `pitch` and `gate`, output
`out` (one mono channel per voice; stereo samples play as `(L + R) / 2`).
Params: `sample` (pool id 0..255, −1 = none), `gain` (0..2, smoothed),
`start` (0..1 of the sample, read at trigger), `pitchTrack` (Off/On),
`root` (MIDI note, default 60) and, appended in plan 15, `end` (0..1,
default 1), `loop` (Off/On), `loopStart` (0..1) and `fine` (−100..+100 ct).

- A rising gate starts the voice at `s = floor(start · frames)`. Loop off it
  is a one-shot (follow it with an ADSR + VCA for gated notes); loop on, a
  falling gate also starts the loop's release window (below). A gate with
  no playable sample starts nothing.
- **Region** (`end`, `loop`, `loopStart` are read live, once per rack
  sub-block, so markers and automation act on sounding voices; `start`
  only at trigger): the voice plays `[s, e)`,
  `e = max(floor(end · frames), s + 1)` clamped to `frames` (so
  `start ≥ end` plays one frame; nothing outside the sample is ever read).
  Loop off: at `e` the last value is held and faded out over 2 ms.
- **Loop** on (a *sustain* loop with a release window, plan 15 ruling K):
  the loop region is `[ls, e)`, `ls = max(floor(loopStart · frames), s)`;
  the voice repeats it while its gate is high **and for
  `LOOP_RELEASE_SECONDS` = 10 s (the ADSR's longest release) after the
  gate falls**, so the ADSR/VCA after it is heard releasing on the loop
  rather than the sample running out under it. Then it stops looping,
  plays on to `e` and stops with the 2 ms fade, so a looping voice always
  ends (within 10 s + `e − ls` frames of the gate falling, at rate 1): CPU
  stays bounded. The end of the window (or `loop` off) during a seam
  crossfade finishes that seam first, so it never steps. The seam has a
  fixed 10 ms (`xf`) equal-power crossfade inside the region: over the
  last `xf` frames the tail fades out (cos) while the head `[ls, ls + xf)`
  fades in (sin), then the read jumps to `ls + xf` — so after the first
  pass a loop lasts `e − ls − xf` frames. A loop region shorter than
  `2 · xf` plays as loop off. Overshoot past `e` (high rates, `end` moved
  under the position) wraps modulo the loop, so the position stays in the
  region at any pitch.
- **Rate** `2^(pitch − (root − 60)/12 + fine/1200)` with `pitchTrack` on
  (per sample: bends follow), `2^(fine/1200)` off; exponent clamped to
  ±11 octaves. Reads use 4-point, 3rd-order Hermite (Catmull-Rom)
  interpolation with the points clamped to `[s, e)`; on whole frames it is
  the frame exactly.
- Declicked like the drum voices: a retrigger fades the sounding voice out
  over 2 ms under the new one. A voice captures the sample's *generation*
  (`engine/src/samples.rs`) at trigger; when the sample is replaced,
  un-readied or cleared by an engine reset, the voice never reads the slot
  again: it holds its last value and fades it to 0 over 2 ms.
- Modules get the pool read-only as a `SampleView`, passed next to the FX
  pool down `Synths::render_add` → `Rack::render_add` → `Module::process`.

### Panel (plan 15)

The Sample Player's panel (`app/src/ui/rack/ModulePanel.svelte`) shows its
sample under the sample dropdown in `SampleStrip.svelte` (maths in
`sampleStrip.ts`, unit-tested):

- **Strip**, 220 × 48 px (`data-testid="sample-strip-<module idx>"`): the
  whole file from its peaks (`waveMath.columns` over `waveBase`, the Clip
  tab's helpers; no zoom), redrawn only when the sample's `SampleMeta`
  changes. Outside `[start, end)` is dimmed, the loop region tinted while
  Loop is On — hatched, titled "Loop too short (< 20 ms): plays once",
  when it is shorter than the engine loops (`loopTooShort`). No sample
  assigned: "Drop a sample here" (the panel is the drop target); an
  assigned id the session does not know: "Sample not loaded".
- **Markers** as the engine plays them (see above): Start green, End red
  (never drawn left of Start + 1 px), Loop start yellow (only with Loop
  On, drawn inside [Start, End]). Each has a small flag that is a
  `role="slider"` (`aria-label` "Start" / "End" / "Loop start", value
  0..1): Start's and End's flags at the top (pointing right / left), Loop
  start's at the bottom, so coinciding markers stay grabbable. A drag
  moves the value by dx / 220 from where the marker is *drawn* when
  grabbed (`drawnValue`: on a degenerate region, e.g. End set left of
  Start from the knobs, no jump). Keys: arrows ±0.01 (Shift ±0.001),
  PageUp / PageDown ±0.1, Home / End the lowest / highest allowed value.
  Drags and keys keep `start ≤ end − 1 px`, `end ≥ start + 1 px` and
  `start ≤ loopStart ≤ end − loopMin`, where `loopMin` is two 10 ms seam
  crossfades plus a frame (the shortest loop the engine loops; from the
  file's frames and the sample rate). Dragging or stepping End left past
  `loopStart + loopMin` with Loop On pushes Loop start back with it (never
  before Start; if that is still too short, the tint is hatched). The
  knobs can still set anything; the engine copes. Every change goes
  through the panel's `onparam` → `setParam`, like the knobs (End + Loop
  start together through `onparams` → `setParams`: one undo entry); a
  drag is one undo entry (pointer gestures, `history/gestures.ts`);
  Escape / pointercancel mid-drag restores the grabbed values.
- **Root** reads and types as a note name (`knobMath.isNoteParam`: "C4" =
  60, "C#4", "C-1" = 0; "E4", "Db4" or the number typed).
  **Root ← last note** (`data-testid="root-from-last-<idx>"`) sets `root`
  to the last live note (QWERTY or MIDI note-on, kept by App from the note
  bus's `onNoteOn` in `input/lastNote.svelte.ts`); disabled until a note
  has arrived since the page loaded.

### Sampler patch

`SAMPLER_PATCH` (`app/src/state/patches.ts`, menu group "Sampler" after
Starter): `midi_in` (8 voices) -> `sample_player` (sample -1 = silent until
one is assigned) -> `vca` <- `adsr` (attack 2 ms, decay 0.2 s, sustain 1,
release 0.25 s, vel_amt 0.7), VCA to `out` l and r. The gate drives both the
Sample Player and the ADSR; velocity reaches the ADSR. It is not in the
engine patch fixtures: without a sample it renders silence; the engine test
`sampler_patch_sustains_a_short_loop_and_releases` (`engine.rs`) builds
the same rack with a looped 0.1 s sample: a held note outlasts the sample,
and after the note-off the ADSR release is heard and the track is silent
within 3 × release.
"+ Sampler track" (`state/sampler-actions.ts`, `addSamplerTrack`) adds a
synth track on it; a sample dropped on that button is imported first, then
the track is created named after the file and the sample assigned, in one
undo entry ("Add sampler track").

## Formant (17)

A *Shaping* module (`rack/modules/formant.rs`): three resonant band-pass
peaks with pitch tracking and a CV shift. It is the body of the Sax and
the "bloom"/"wah" of Brass Stab and Garage Organ. Inline (no FX pool).

- **Signal flow.** `in` → three band-passes in parallel →
  `wet = bp1 + g2·bp2 + g3·bp3` → `out = dry + mix·(wet − dry)` → the
  Filter's output soft limiter (linear to ±2, easing into ±3.5), so full-
  scale noise at q 20 stays within ±3.5.
- **Centres.** Peak *i* sits at `f_i × 2^(shift + track·pitch + cv_amt·cv)`,
  clamped to 20 Hz..0.45·sr; `pitch` and `cv` read 0 when unconnected. With
  `track` 1 the peaks follow the note; 0 keeps a fixed body (a real
  instrument's resonances do not move with the note); the Sax uses ≈ 0.15.
- **Unity-peak sum.** Each peak is the Filter's TPT SVF band-pass (`k·v1`,
  damping `k = 1/q`; the SVF step, its coefficients and `tan_fast` are
  shared with `filter.rs`, not copied), so every peak has unity gain at its
  centre and, with `g2 = g3 = 1`, the response peaks within 1.5 dB of 0 dB at
  each `f_i` (tested). No input saturation.
- **Stacked peaks.** Peaks that coincide add up: overlapping `f` ranges
  (`f1` up to 1500 Hz, `f2` from 500 Hz) or a large `shift`/`cv` that pushes
  several centres into the 20 Hz or 0.45·sr clamp put them on one frequency,
  for a gain of up to `1 + g2 + g3` there: about +7 dB at the default gains
  (2.2×), +9.5 dB at `g2 = g3 = 1`. Not normalised (that would make the
  usual, separated case quieter); the output limiter catches it.
- **Smoothing and channels.** Every param is smoothed over 5 ms (`f1..f3`
  and `q` in log2). Coefficients are computed per sample, shared across
  channels when `pitch` and `cv` are mono or unconnected (as in the Filter),
  per channel otherwise. Channels are the maximum over the connected inputs
  (a mono `in` is broadcast to a poly `pitch`). `pitch` and `cv` are not
  smoothed, and need not be: the TPT states stay continuous, so a 1-octave
  cv step and a 20 Hz ±4-oct sweep keep the output's curvature (max second
  difference) within 3× (measured ≤ 1.9×) that of the settled signal
  (`formant_cv_sweep_is_smooth`, q 6 and 20, mono and poly cv).
- **Defaults** are an alto-sax body: 500 / 1500 / 2600 Hz, q 6, gains 1 /
  0.7 / 0.5, so a fresh Formant is useful at once.
- **No vowel table.** Three explicit peaks plus a CV shift cover sax, brass
  and organ "wah" with 10 params (≤ 12). A vowel morph table (a/e/i/o/u
  presets interpolated by a knob) would need either more params or a fixed
  table that fits only one voice size; it is a follow-up if wanted.

## Scope (18)

A *Utility* module (`rack/modules/scope.rs`, plan 12): a patchable
two-input oscilloscope drawn live in its own panel (`ScopeView.svelte`).

- **What it shows.** Inputs `a` (orange) and `b` (cyan), each input's
  channels **summed unnormalised** (as Out sums voices, so a poly cable
  shows what an Out would get; Gain A/B scale the trace on screen). Free:
  `time` per division over 10 divisions (0.1..100 ms/div). Sync: one
  `division` (the LFO's 1/16 … 4 bars) at the current tempo. Trigger Auto
  locks to the latest rising zero crossing of A (a Schmitt trigger with 2 %
  hysteresis; none: free-running, tagged *no trig*); Free shows the latest
  entries; Sync while playing shows exactly the last whole division,
  between the engine's grid marks (copied out of the ring when its line
  passes and held until the next one: late in a division its start is no
  longer readable). Scope params are not automatable (view only). XY plots A against B. A click freezes
  the view (UI only, not saved).
- **The sink rule.** No outputs, so nothing can be cabled *from* a Scope
  and it can never change the sound. Its edits skip the declick (see
  *Declicked edits and smoothing*): `scope_edits_never_dip` (rack) and
  `scopes_never_change_the_sound` (Sax and Warm Pad, four Scopes added,
  edited and removed mid-note) pin every output sample bit-identical.
- **Engine side: record only.** Per sub-block it writes min/max entries
  (A min, A max, B min, B max) over `decim = max(1, ceil(window /
  VIS_SCOPE_WINDOW))` frames into its ring, so a long timebase draws the
  honest envelope rather than an aliased line; a `decim` change moves the
  header's `epoch` to the head (readers never mix timebases). In Sync while
  playing it also marks the head at each division line from `ctx.ticks`,
  exact to the entry; a stop, seek, loop wrap or division change clears
  *grid valid* until two new lines have passed. Triggering, XY, gain and
  freezing are UI maths (`ui/vis/scopeMath.ts`).
- **The bank of 8.** The rings and headers are a fourth FX-pool kind
  (`FxKind::Scope`, `VIS_SCOPES` slots of `VIS_SCOPE_RING` × 4 f32), claimed,
  released, handed over and zeroed exactly like the effects' (a scope ring
  is one `CLEAR_CHUNK`: one sub-block). The claim stamps the owner (the
  rack's track slot, the module idx) on the slot's header, a handover
  restamps it when the new Scope's add applies (until then the old one
  still writes the ring), a release writes −1; the view finds its slot by that owner.
  The ninth Scope is refused (`ERR_OUT_OF_MEMORY`) and greyed in the add
  menu with "All 8 scopes in use". The header's `head` lives beside the
  bank, so it keeps counting across owners. The worklet mirrors owned slots
  into `visSab` while a Scope is on screen (want bit 8; see
  `visuals.md`).
- **Idle.** A Scope runs only while its rack renders (the track is active
  or still sounding), like every module; when no new entries arrive for
  250 ms the view keeps the last frame, dimmed, tagged *idle*.
- **Tests in the app.** `tests/e2e/visuals.spec.ts` (*scope shows a
  triggered saw*: the head advances, "5 ms/div", no *no trig*, a trace over
  many rows; *a ninth scope is greyed out*) and `serial.spec.ts` (*scope
  edits while playing cause no dropouts*; 8 Scopes on screen cost ~1 % of
  the main thread). The view's UI side is in `visuals.md` *Scope*.

## Accent (19)

A *Shaping* module (`rack/modules/accent.rs`, plan 17): `gate` + `vel` in,
`cv` (0..1) out. It holds a charge that builds up across accented notes;
cabled to a Filter's `cv` it gives the acid "accent sweep" (a run of
accents opens the filter a little further each time, a rest lets it fall
back). Inline (no FX pool); one store per `gate` channel.

- **Charge.** A rising gate whose `vel` ≥ `threshold` (default 110/127:
  MIDI velocity 110 and up, which is what the Acid editor writes for an
  accent, 120, and not for a plain note, 80) does `store = min(1, store +
  0.6)`. Not 100: that is the app's default velocity (QWERTY piano, notes
  drawn in the piano roll), so every ordinary note would accent. The Acid
  tab reads the same 110 as an accent (`state/acidSteps.ts`). `vel` is latched at the edge like the ADSR's; unconnected it reads
  1 (every note accents). A slid (legato) note has no rising edge, so it
  never accents.
- **Decay.** `store ·= exp(−dt/decay)` (`decay` 0.05..2 s, default 0.25).
  Accents a 1/16 step apart at 120 BPM peak at 0.6, 0.96, 1.0; after 2 s of
  rest the next one peaks at 0.6 again (`stacked_accents_rise`,
  `rested_accent_matches_first`).
- **Output.** `cv = amount × level`; `level` follows the store, rising at
  most full scale per 1 ms (a 0.6 charge is a 0.6 ms ramp, so the cv never
  steps) and falling with it exactly; `amount` is smoothed over 5 ms. The
  plan first asked for a 5 ms one-pole on the store: because the store
  decays from the moment of the accent, that lag would cut a single
  accent's peak to ≈0.55 at decay 0.25 s and ≈0.47 at 0.05 s, so the ramp
  is used instead: a single accent peaks at 0.6 ± 0.01 at any decay and
  sample rate (`short_decay_96k`).

## Adding a module

Modules are enum-dispatched (no trait objects, no allocation):

1. Add `engine/src/rack/modules/<name>.rs` with the DSP struct (`new(sr)`,
   `process(...)`; follow the contract at the top of `rack/modules/mod.rs`).
   Declare it with `pub mod <name>;` in `rack/modules/mod.rs`.
2. Add the variant to `enum Module` and wire it into
   `Module::with_fx_slot`, `Module::kind`, `Module::process`,
   `Module::reset` and `Module::snap` (same file). A module that needs a big buffer borrows it
   from the FX pool instead (see above): give it a `FxKind` bank and
   `ModuleKind::fx_kind`.
3. Add the variant to `enum ModuleKind` in `rack/catalog.rs` with a **fixed
   id** (append only: ids are wire format and saved-project format), to
   `ModuleKind::ALL`, and add its `ModuleSpec` (ports, params with
   min/max/default/curve/choices/`smooth`) plus an arm in `spec()`.
4. Regenerate the golden file:
   `UPDATE_CATALOG=1 cargo test -p daw-engine catalog`, and review the diff
   to `engine/catalog.json`. The kind-id test in `catalog.rs` must be extended.
5. Nothing else in the UI has to change: it imports `engine/catalog.json`,
   so the module shows in "+ Add module", with knobs, faders, choices and
   cable colours, automatically. Its header colour comes from its catalog category
   (`ui/theme.ts` `CATALOG_CATEGORIES`); add a `MODULE_CATEGORIES` entry if
   its role differs (a `shaping` envelope is modulation, say), a `HERO`
   entry in `rack/controlMap.ts` if one param should be the big dial, and a
   `VFADERS` entry there for params that read as levels. A new
   catalog category or signal kind fails `theme.test.ts` until it is mapped.

## Live input routing

Keyboard and MIDI notes go to the *input track*: the selected synth or drum
track takes the keys (a drum track plays its rows from notes 36 + r; see
`docs/architecture/sequencer.md`); with an Audio track or nothing selected,
the last-selected synth track.
`SET_INPUT_TRACK` sends pedal-up, an Off per live-held pitch (keys down or
pedal-held) and bend 0 to the old track, never AllOff, so its sequenced notes
keep playing (a pitch held both live and by the pattern ends on the pattern's
Off); then it replays the cached bend, mod and sustain to the new one. Removing the input
track unsets it.

## Performance

Native (`cargo test --release -p daw-engine --test perf -- --ignored
--nocapture`): about 8.5% of the audio budget for 4 tracks x 13 modules x 8
voices, about 9% with each track also playing a 16-note pattern (plan 3). The e2e `four synth tracks stay under budget` runs four drone patches
(8 voices, 2 saw oscs with unison 2, LP24 + LFO, VCA) in Chromium and
requires CPU telemetry below 60%, audible output (peak L/R > 0), and no new
dropouts or errors; a single run measured about 7%.

Rack effects (plan 6, `fx_chain_track_renders_under_budget`): one track
running MIDI In → Osc → Filter (8 voices) → Chorus → Delay → Reverb → Out
measured 0.65% of real time natively. The effects run once, on the summed
stereo signal.
