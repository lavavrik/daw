# Sequencer and recording

How synth-track note patterns are stored, turned into audio-thread events,
counted in, and how recording maps your key presses onto the beat you *heard*.
Code: `engine/src/` (pattern + transport), `app/src/state/recorder.ts`,
`app/src/audio/audioClock.ts`.

## Pattern storage and opcodes
Each synth track owns `MAX_PATTERNS = 16` note patterns, each a preallocated
note table of `MAX_NOTES = 1024` entries (`pub const`s in `lib.rs`, mirrored
in TS; the parity test enforces them). All storage is created in
`Engine::new`; no command allocates. Ticks are 960 PPQ, 1 bar = 3840 ticks
(4/4); pattern length is 1..16 bars (default 4).

Memory: a note pattern is ~12.3 KB, so 32 tracks x 16 patterns ~6.3 MB (drum
patterns add ~0.6 MB). Song mode adds a 272-byte note voicing per clip slot of
each synth track (~2.2 MB) plus the clips (~128 KB). `Engine::new` holds
~155 MB of heap in all (128 MB sample arena, ~18 MB racks, the patterns and
clips), inside the 256 MB initial WASM memory.

### Current pattern
Every drum and synth track has a *current* pattern (0 for a new track). In
Pattern mode it is the one that loops from tick 0, and the step / swing /
step-count / note / bars opcodes edit it. The UI selects it before editing.

| Op | # | Fields |
|---|---|---|
| `OP_SET_CURRENT_PATTERN` | 32 | `a = slot`, `b` = pattern 0..15 |
| `OP_COPY_PATTERN` | 33 | `a = slot`, `b = from`, `c = to` |
| `OP_CLEAR_PATTERN_DATA` | 34 | `a = slot`, `b` = pattern |

- They take a drum or synth slot; an empty slot, a bad slot or a pattern
  outside 0..15 is `ERR_BAD_INDEX`.
- Switching (synth) sends `Off` for the old pattern's sounding notes; the new
  pattern continues at `ticks mod newPeriod` (a note that started before the
  switch point does not sound). Selecting the current pattern is a no-op.
- Copy replaces everything in `to` (steps or notes, step count / swing or
  bars); copying into a sounding pattern releases its notes first. `from ==
  to` is a no-op that returns OK.
- Clear empties the steps / notes and keeps step count, swing and bars; it
  releases the notes if that pattern is sounding.
- `ADD_DRUM_TRACK` / `ADD_SYNTH_TRACK` reset all 16 patterns and select 0.

| Op | # | Fields |
|---|---|---|
| `OP_NOTE_SET` | 28 | `a = slot*1024 + idx`, `b = pitch*128 + vel`, `c = start`, `d = len` |
| `OP_NOTE_REMOVE` | 29 | `a = slot*1024 + idx` |
| `OP_NOTE_CLEAR` | 30 | `a = slot` |
| `OP_SET_PATTERN_BARS` | 31 | `a = slot`, `b` = bars 1..16 |
| `OP_PLAY` | 3 | `a` = count-in ticks, 0 or 3840 |

Every command is validated (pitch 0..127, vel 1..127, start 0..61439, len
1..61440; 61440 = 16 bars, the longest pattern). Start is *not* checked
against the current pattern length: notes starting at or after it are kept
(stored and shown) but silent, and play again if the pattern grows. The UI
keeps the authoritative note list and writes slots by index.

### UI state (app/src/state)
The UI keeps the authoritative pattern and clip lists (`project.svelte.ts`)
and every edit sends its engine command (`pattern-actions.ts`,
`song-actions.ts`).
- Each pattern has a stable `engineIdx`: the lowest free 0..15 when it is
  created. It is never renumbered, so clips never need re-sending.
  `deletePattern` is refused while a clip uses the pattern or when it is the
  track's last one; it sends `CLEAR_PATTERN_DATA` and frees the index.
- `selectPattern` is the only sender of `SET_CURRENT_PATTERN` and the only
  writer of `currentPatternId`. Step, swing, step-count, note and bars edits
  act on `currentPattern(track)`, which is then always the engine's current
  pattern. No action switches it implicitly.
- `newPattern` selects the new pattern, then sends the copied lengths.
  `duplicatePattern` and `makeUnique` use `COPY_PATTERN` and name the copy
  "<name> copy" (then "<name> copy 2", …).
- Clips move only in time for now: every move to another lane is refused.
  Patterns belong to tracks and the engine cannot copy one across tracks,
  so any mapping would silently change what the clip plays. Once a real
  cross-track copy exists, lane moves can be allowed between tracks of the
  same kind.

### Step grid look (ui/StepGrid.svelte)
Plan 20, spec §4. The rules are pure functions in `ui/stepGrid.ts`
(unit-tested in `stepGrid.test.ts`); the component turns them into classes
and custom properties, and its CSS draws them with theme tokens.
- **Row colour** = `TRACK_COLORS[(track.slot + row) % 8]` (`rowColor`). UI
  only, never saved. The slot, not the track's list index: a slot is fixed
  for the life of a track, so a row keeps its colour when other tracks come
  and go, and row 0 matches a default-coloured track. Old projects whose
  tracks carry old palette colours still get palette row colours. The row's
  tag, gain/pan fills, cells and waveform strip use it; the footer's swing
  uses the track colour.
- **Cells** (`stepCellStyle(vel, step, playing)`): the fill is velocity /
  127 of the cell (the stored range; a click writes 100, ~79 %, an
  Alt-click 60, ~47 %, a full-scale recorded hit 127 fills it); off cells are
  recessed, every other group of four a shade lighter; velocity ≥
  `ACCENT_MIN_VEL` (110, shared with the Acid tab, `state/acidSteps.ts`)
  adds the `accent` class: a 2 px ring in the row colour and a glow. The
  playing step (`playhead` class, from the grid's heard-position loop) gets
  a white outline and a brighter fill. Groups of four sit 10 px apart.
  Every cell is one fixed width (30 px, `--cell-w`; plan 30): the cells
  never stretch with the panel, and 32 / 64 steps scroll the panel
  sideways (the footer stays put: `position: sticky`).
- **Gain and pan** stay native `<input type="range">` with the theme skin
  (`--fill`, `--c` from the row). They are not rack params (no MIDI-learn or
  automation for the Knob slider variant to keep), and a native drag is one
  undo entry through the pointer gesture. Pan fills from the centre
  (`panFill` → `--fill` and `--fill-pos`, see `ui-theme.md`).
- **Mute** (plan 30) is a speaker toggle (`row-mute-<i>`): plain while the
  row plays, lit `--accent` with a slashed speaker while it is muted, and the
  row's cells dim. The old LED was lit while the row *played*, which read as
  "mute is on". `aria-pressed` = muted, as before.
- The sample name button previews the row; its Play / Stop glyph is a
  Phosphor icon (plan 30), not CSS text.
- **Kit** (plan 30): the footer's Kit menu (`kit-menu`, items
  `kit-pick-<kit id>`) loads a built-in kit onto the track
  (`loadKitOntoTrack`, see `projects.md`), so changing kits keeps the track
  and its steps.
- **Pattern settings** (plan 30): Steps (16 / 32 / 64 chips,
  `step-count-<n>`), Swing (slider + MPC preset chips) and Humanize live in
  one popover (`pattern-settings`; its trigger reads "16 steps · swing 0%")
  instead of across the footer.
- **Delete row** (plan 21): a trash icon button at the row's end
  (`row-delete-<i>`, aria-label and tooltip "Delete row <name>"), faded in
  on row hover and while focus is in the row; opacity only, so it is always
  in the tab order. After a delete, focus moves to the delete button now at
  that index (else the previous row's, else "+ Add row"). Rows have no
  context menu (right-click on a cell clears it), so there is no menu entry.

### Step velocity (plan 23)
A drum step's velocity (1..127; 0 = off) scales its hit by
`row.gain * vel / 127` in the engine (`engine/src/drums.rs`), so editing it
needs no engine change: every write is `setStep` / `SET_STEP`. A click
writes 100, Alt+click the 60 ghost, right-click clears; those are
unchanged. On top of them, a **lit** cell can be re-levelled in place
(Task 1):
- **Wheel**: ±5 per notch, ±1 with Shift. Only a lit cell takes the wheel
  (`preventDefault`); over an off cell the page scrolls as before, and so
  does Ctrl/Cmd+wheel (the browser's zoom). Travel accumulates per cell and
  steps once per 40 px, at most once per event, so a trackpad's small
  deltas add up and a mouse notch (~100 px) is one step (`wheelPx`,
  `wheelNotch`). Shift+wheel reads `deltaX` when `deltaY` is 0 (browsers
  move a Shift-wheel there). Without Shift, a mostly horizontal swipe
  (|deltaX| > |deltaY|, Y jitter and all) is not an edit and is not
  prevented: it stays the grid's scroll or the browser's back swipe.
  Partial travel is forgotten after 300 ms without a wheel event
  (`wheelCarry`), so a stray touch later never finishes an old notch.
- **Shift-drag** from a lit cell: vertical and relative, 1 velocity per
  2 px (truncated), up is louder (`dragVel`). The pointer is captured, so
  nothing is painted and the step stays lit. Shift + press on an off cell
  paints like a plain press; nothing else on the cells uses Shift.
- **Keys** on a focused lit cell: Shift+↑ / Shift+↓ ±5, Alt+Shift+↑ / ↓ ±1
  (`velKeyStep`). Plain arrows still mean nothing on a cell. The grid's
  live region (`step-vel-status`) says "Velocity 96" after each change.
  This is the keyboard path for velocity (the lane, Task 2, is
  pointer-only). The shortcut layer ignores Shift+arrows and anything with
  Alt, so the keys never reach the piano.
- **Range**: every edit clamps to 1..127 (`clampStepVel`): it never turns
  a step on or off, and an edit on an off step is refused. Accent stays
  `>= ACCENT_MIN_VEL` (110); the ring and glow follow live.
- **Feedback**: while editing, a chip ("vel 96", JetBrains Mono, tabular
  figures; `step-vel-chip`) floats above the cell: for the whole drag, and
  for 1 s after the last wheel notch or key. A lit cell's `data-tip` is
  "Velocity 96 — wheel or Shift-drag to change"; an off cell has none.

**Undo**: one entry per gesture, labelled "Step velocity".
- Wheel and key bursts: `setStepVelocity(..., { coalesce })`, with an
  idle-aware sweep key per cell (`stepvel:<track>:<row>:<step>`,
  `history/sweep.ts`, 1 s). The grid settles after each write, so a burst
  that nets to nothing (up, then down) leaves no entry. A click's gesture
  commits one task after its release, so a key or notch straight after a
  click would land in the click's "Set step" entry (one undo would turn
  the step off). With no pointer button held, it is committed first: App's
  keydown capture calls `gestures.commitReleased()`, and the grid's wheel
  handler calls `history.commit()` when `e.buttons === 0`. (A notch while
  the button is still held is the same gesture, and stays one entry.)
- A drag runs inside the App's pointer gesture (one entry per press,
  `history/gestures.ts`) through `stepVelocityGesture(p, sink, trackId)`.
  It remembers each touched step's value from before its first write, and
  `cancel()` puts them all back. Esc (a window capture listener while
  dragging), a lost pointer capture and Cmd/Ctrl+Z mid-drag
  (`registerDragCancel`) cancel, so the gesture ends where it began and
  leaves no entry.

The pure maths is in `ui/stepGrid.ts` and the writes are in
`state/actions.ts`, so the velocity lane (Task 2) shares the clamp, the
writes and the gesture's begin, commit and cancel.

### Swing presets (plan 25)
Code: `app/src/state/groove.ts` (`SWING_PRESETS`, `mpcToSwing`,
`swingToMpc`, `activeSwingPreset`), the popover in `ui/StepGrid.svelte`.

The engine's `swing` (0..1) pushes every odd 16th late by
`swing * 0.5 * 240` ticks (`drums.rs` `step_tick`). A pair of 16ths is 480
ticks, so the off-16th sounds at `240 + 120 * swing`, which is
`0.5 + 0.25 * swing` of the pair. MPC swing % is that same fraction:

| MPC % | swing | off-16th in the pair |
|---|---|---|
| 50 (Straight) | 0 | 240 / 480 |
| 54 | 0.16 | 259.2 / 480 |
| 58 | 0.32 | 278.4 / 480 |
| 62 | 0.48 | 297.6 / 480 |
| 66 | 0.64 | 316.8 / 480 |

`mpc = 50 + 25 * swing` and `swing = (mpc - 50) / 25`. The slider's top
(swing 1) is MPC 75 %. 66 % is just short of a true 16th triplet (2/3 of the
pair: 66.7 %, swing 0.667). Every preset falls on the slider's 1 % grid, so
the slider, its readout and the right-click ValuePopover show it exactly.

The preset chips sit under the swing slider in the pattern settings
popover (plan 30; shared `ui/PopButton.svelte`: Esc, a press outside and
Tab out close it). A chip calls `setSwing` with the preset's value, so it
is one "Swing" undo entry, like a slider drag. The chip whose value matches
the current swing (at the slider's 1 % resolution) is pressed; none is when
the swing is off the presets.

### Humanize (plan 25)
Code: `app/src/state/groove.ts` (the jitter and the bounds),
`humanizeDrum` in `state/actions.ts`, `humanizeNotes` in
`state/pattern-actions.ts`, and the shared `ui/HumanizeCard.svelte`
(amount 0–100 %, Apply) in the step grid's pattern settings popover
(plan 30) and behind the piano roll toolbar's **Humanize…** button.

- **Drums:** every lit step in the current pattern's first `stepCount`
  steps gets a velocity moved by up to ±`HUMANIZE_VEL` (20) × amount,
  rounded and clamped to 1..127. Off steps stay off and lit steps stay
  lit. Steps past the step count, which are hidden, are not touched.
- **Notes:** each note's velocity moves the same way, and its start moves
  by up to ±`HUMANIZE_TICKS` (12) × amount ticks (spec §1), kept inside the
  pattern: the start stays ≥ 0, and the end (start + len) stays at or before
  the pattern end. A note that already overhangs the end may only move
  earlier, so its end never grows. Notes past the end (kept, silent) are
  skipped, as Quantize skips them. The piano roll humanizes the selection,
  or every note when nothing is selected, as Quantize does.
- **Deterministic:** each value's offset is
  `jitter(seed, key) × max × amount`, with `jitter` in [-1, 1) from a hash
  (FNV-1a, then murmur3's finaliser). `key` is the item's own identity:
  `row:step` for a step, the note id for a note. This makes the result
  independent of iteration order. `seed = humanizeSeed(patternId, counter)`,
  where the counter counts that pattern's Humanizes in this session
  (`nextHumanizeCounter`). The counter is not saved and not undone, so the
  same pattern and counter always give the same result, and a second
  Humanize gives a new one. Redo replays the entry's snapshot, so it
  matches exactly.
- **Undo:** one entry, "Humanize": the whole pass runs in one `edit()`, as
  SET_STEP or NOTE_SET commands. Amount 0 (or NaN) returns before `edit()`
  and does not use the counter, so it makes no entry and writes nothing. A
  pass that would change nothing (an empty pattern, no selected note that
  moves) is computed first (`peekHumanizeCounter`) and returns the same
  way: no entry, no write, and the counter stays unused, so the next
  Humanize still gets that counter. Both actions return how many steps /
  notes changed.
- The amount (default 50 %) is remembered for the session and shared by
  both editors; only a nonzero Apply sets it, so the card never opens at 0.
  Moving the slider is not an edit: only Apply (or Enter on the slider,
  which does nothing at 0) writes.

### Deleting a row (plan 21 task 7)
Engine rows are **slot-indexed** (`DrumTrack::rows[MAX_ROWS]`, and every
pattern's `steps[row][step]`), so deleting a row in the middle means every
later row moves up one, in every pattern. *Choice: an engine op, not the
existing row/step setters.* Re-sending the shifted rows through
`SET_ROW_*` / `SET_STEP` would need a `SET_CURRENT_PATTERN` round trip per
pattern (steps only address the current pattern) and up to 16 x 64 x 16
commands: not atomic for the audio thread (the backlog can spread it over
blocks, so a few ms of another pattern or half-shifted rows could play) and
not cheap. So:

| Op | # | Fields |
|---|---|---|
| `OP_REMOVE_ROW` | 58 | `a = slot`, `b = row`: later rows move up one; the last row is empty |
| `OP_INSERT_ROW` | 59 | `a = slot`, `b = row`: an empty row there, rows from it move down one; the last row is dropped |

- Both shift, in place (`copy_within` on fixed arrays, allocation-free; in
  `no_alloc.rs`): the row settings, the steps of **all 16 patterns**, the row
  voices and queued live hits (`Drums::remove_row` / `insert_row`), and the
  sidechain keys on that track's rows (`Mixer::row_removed` /
  `row_inserted`, mixer.md). The removed row's voice moves to the empty
  last slot and fades over 2 ms, so a ringing hit is never hard-cut.
- A drum or empty slot (like the row setters); a synth or audio slot is
  `BAD_INDEX`. They are edits (not in `NON_EDIT_OPS`).
- No automation lane or MIDI mapping can point at a row (row gain / pan are
  native ranges, not params), so none moves or is dropped.
- **What shifts with the index** (by design, not stored per row): each
  later row's MIDI input note (`36 + r`, *Live drum input* below) drops by
  one semitone, so the pad that played row 5 now plays the row that was
  row 6; and each later row takes the colour of the row above it
  (`rowColor`, `slot + row`). Both follow the row's position.

The app (`state/actions.ts`):
- `removeDrumRow(p, sink, trackId, rowId)`: one undo entry "Delete row":
  `REMOVE_ROW`, then `rowRemovedState` mirrors it (the row object out, each
  pattern's step row spliced out and an empty one appended, keys on the row
  to none and on later rows up one). The last row can be deleted: the track
  is then just empty, with "+ Add row".
- **Undo** goes through the normal snapshot path. `diffApply`'s `diffDrum`
  spots one row more or fewer with every other row the same, in order
  (`shiftedRow`: name and settings): it sends `INSERT_ROW` (undo) or
  `REMOVE_ROW` (redo) and shifts the state the same way
  (`rowInsertedState` / `rowRemovedState`), so the kept rows keep their UI
  ids; then the ordinary by-index row and pattern diff sends only the
  restored row's sample, settings and cells (each pattern selected in turn),
  and step 3 its keys. Anything else (an add or removal at the end, several
  rows at once) falls back to rows by index, which is exact too.

## Pattern library (plan 21 Task 4)
Patterns can be saved into the project and loaded into any track of their
kind (spec 2026-11-15-redesign-round-2 §5). Code: `state/pattern-library.ts`
(actions, mapping, the saved form), `ui/LibraryList.svelte` (the list),
Patterns ▸ *Save to project library…* / *Load from library ▸* (a submenu,
`ui/MenuBar.svelte`) and the pattern header's Save (bookmark) / Load
(books) icon buttons (a popover, `ui/PatternPicker.svelte`; not the project's floppy / folder).

- **An entry is a copy by value** (`Project.patternLibrary`,
  `LibraryPattern`): drum — step count, swing, and per row its name, its
  sample's **file name** (`sampleName`, absent when the row had none) and
  its 64 velocities; synth — bars and the notes `{pitch, vel, start, len}`.
  It does not refer to the track it came from, so it survives that track's
  removal or a sample swap. Saved as `patternLibrary` (projects.md, schema 5).
- **Save** stores the current pattern under a name (default
  "*track* · *pattern*"); a name already in the library is numbered
  ("Groove 2"). No engine command: `markEdited` marks the change.
- **Load never overwrites.** It makes a **new** pattern in the selected track
  (`newPattern`: lowest free engine slot, selected), names it after the
  entry (unique in the track: `freeName`), then sends the entry's length,
  swing and steps (`SET_STEP` on the fresh, empty current pattern) or bars
  and notes (`NOTE_SET`, engine idx 0..n-1; notes past the end are kept, as
  a copy keeps them). A full track (16 patterns) or another kind is refused
  (`loadBlocked`: the list shows that entry greyed, with "drum pattern" /
  "synth pattern", inert with the reason).
- **Drum row mapping** (`mapLibraryRows`): an entry row with steps goes to
  the first free target row with the **same role name** when the entry row
  is named after a role (`DRUM_ROLES`: Kick, Clap, Closed hat, Open hat,
  Snare, Rim, Shaker, Perc, as `DEFAULT_KIT` and every kit name their rows),
  else to the first free target row whose sample has the **same file name**,
  else to the target row with the **same index** if that one is still free,
  else nowhere: its steps are dropped and the UI flashes "*N* rows not in
  this kit". Role first (plan 25): factory entries have no sample names, and
  across kits the role is what a row means even when the files differ. A
  row without steps maps by role or sample only (it never takes an index
  another row needs); "steps" means steps within the entry's step count
  (hits past it are copied where the row lands but claim nothing). Other
  row names are not compared: a renamed row ("Bd") is a label the user
  chose; the sample is what plays. So a kit with reordered, deleted or added
  rows gets every step on the same sound, and a kit of other sounds gets
  them by role, else by position.
- **Factory patterns** (plan 25 Task 2, `state/factoryPatterns.ts`): 28
  read-only built-in entries in the same `LibraryPatternJson` shape — 12
  drum grooves (rows named by role, all eight rows in kit order, no sample
  names; 16 or 32 steps; swing written in MPC %, taking the swing preset's
  exact value from `state/groove.ts` `SWING_PRESETS` where there is one, so
  a loaded Garage 2-step shows "62 %"), 8 basslines and 8 chord parts
  (A minor, so plan 26 can transpose them; bass around A1–A2, chords around
  A3–E5, Disco strings an octave up; 1, 2 or 4 bars). Basslines are mono
  lines with no overlapping notes (the house bass patches glide on an
  overlap), except Acid 303 line, whose overlaps are its slides. Chords are
  built from named `VOICINGS`, each holding its root. The Load popover / Load from library ▸ list (`LibraryList.svelte`)
  shows them under **Factory**, grouped Drums / Bass / Chords, only the
  groups of the selected track's kind; the rows have no Rename / Delete.
  `loadFactoryPattern` runs the library load (`loadEntry`, shared with
  `loadPatternFromLibrary`) on the built-in entry: a new pattern, one undo
  entry ("Load factory pattern"). They are never part of
  `Project.patternLibrary` and never saved; a loaded pattern is an ordinary
  pattern. `factoryPatterns.test.ts` pins the content (A minor, ranges,
  bounds, every drum entry onto every kit with no dropped row).
- **Undo:** save, load (library or factory), rename and delete are one entry each (`edit`). The
  library is in the snapshot (serialize), so diffApply restores it
  (history.md, step 4).

## Acid tab (step view of a note pattern)
Plan 17 (spec addendum §2). The **Acid** tab (`ui/acid/AcidSteps.svelte`,
the third bottom-panel tab, Alt+3, no F-key) shows a synth track's current
pattern as steps. There is **no stored step format and no schema change**:
the steps are *read* from `NotePatternState.notes` and every edit is
*written* back as ordinary notes, so the piano roll, recording, clips, undo
and export see nothing new. Pure code: `state/acidSteps.ts` (mapping and
rewrite rule), `state/acidTools.ts` (randomize, mutate, shift),
`state/acid-actions.ts` (applies a step list as one undo entry).

**Mapping.** One step = `STEP_TICKS` = 240 ticks (1/16), 16 per bar; a
pattern of 1..4 bars (at most 64 steps) can be shown, in rows of 16. A step
is a note (key 0..11 and octave −1/0/+1 around the *base*, a MIDI C chosen in
the tab, default 36 = C2: pitch = base + key + 12·oct, so the window is
base−12 .. base+23), a rest, or a tie (holds the previous note on), plus an
accent and a slide flag.

| Steps | Note |
|---|---|
| note, accent | start 240·i, vel 120 (80 without accent) |
| note + k ties | len (1+k)·240 − 120 (a plain note is 120: half a step) |
| slide on the run's last step | len = next note's start − start + 60 (the overlap makes a mono legato patch glide) |

Reading is the reverse: a note covers ceil(len/240) steps, capped before the
next note's step; it is a slide when it runs past the next note's start; vel
≥ 110 reads as an accent (the Accent module's default threshold, 110/127;
not 100, the app's default velocity for QWERTY and drawn notes, which would
make every ordinary note an accent). Notes starting at/after the pattern end are
ignored (kept, never shown). A slide before a rest or at the end can't be
stored, so the Slide toggle is disabled there ("Slide needs a next note"); a
tie after a rest is a rest. When the pattern doesn't read at the tab's base
but fits one an octave around its lowest note, `readSteps` picks that base
and the tab adopts it; the base −/+ buttons only offer bases the pattern
reads at exactly. Every base (−/+, auto-fit, Convert) is a C in 12..96
(`MIN_BASE`..`MAX_BASE`), so the window stays inside MIDI 0..127; a pattern
that would need a base above 96 is unshowable (`range`).

**Unshowable patterns** (a start off the grid, two starts on a step, a note
reaching past the note after next, a pitch outside every candidate window,
more than 4 bars) show "This pattern has notes the Acid tab can't show
(<reason>)" and **Convert to steps**: one undo entry that cuts a longer
pattern to 4 bars, snaps starts, keeps a chord's highest note and folds
pitches into a window.

**The tab is disabled** for a pattern it can't show (`acidUnavailable` in
`state/acid-actions.ts`; the tab's tooltip and Alt+3's hint give the
reason): picking such a track or pattern while Acid is the remembered tab
shows the Piano roll instead. An edit that breaks the pattern while the Acid
tab is open (a recorded note, an undo) keeps it open with the notice above,
so it never jumps away. **Patterns ▸ Convert to steps** does the same
conversion from anywhere and opens Acid.

**Rewrite rule. Reading never edits.** An edit (`planEdit`) compares the old
reading with the new steps run by run and touches only what changed: a new
run adds a canonical note, a run whose note step went away removes its note,
and a kept run updates only the fields whose inputs changed (pitch ← key/oct;
vel ← accent; len ← its tie count, its slide, and, only with a slide,
whether a note follows). So piano-roll lengths (240, 480, a 30-tick slide
overlap) survive edits that don't concern them: a held 480-tick note keeps
its length when a note is entered at the step after it, since without a
slide a length never reaches the next step. Turning the step after a slide
into a rest shrinks the slid note back to its plain length.

**Undo.** Every edit is one entry (`edit()`). Single-step edits pass a
coalesce key `acid:<trackId>:<kind>` (kind pitch / oct / accent / slide /
kind / entry), which rolls over after 1 s idle (`history/sweep.ts`), so
keyboard toggles and step entry merge like MIDI CC sweeps. A mouse click is a
pointer gesture (`history/gestures.ts`) and always its own entry. Tools
(Randomize, Mutate, Shift, Transpose, Clear, Convert) never coalesce;
Transpose that would take a pitch outside 0..127 is refused (the button is
disabled).

**Step entry.** With a step selected, each live note-on (QWERTY or MIDI;
`input/lastNote.svelte.ts` counts them in `lastLive.seq`) sets that step:
key = note mod 12, oct = clamp(floor(note/12) − base/12, −1, 1), accent and
slide kept, coalesce kind `entry`; then the next step (wrapping) is
selected. The note still sounds. No step entry while the recorder captures
(armed and playing): the note is recorded instead. While the tab has focus
and a step is selected, the arrows move the selection, Shift+A / Shift+S /
Shift+R / Shift+T toggle accent / slide / rest / tie, Delete or Backspace
makes the step a rest and Esc deselects; only those keys are kept from
`input/shortcuts.ts`. Plain letters are QWERTY piano keys (A = C, S = D,
T = F# …), so they reach the piano and enter notes; the piano ignores Shift,
which is why the four Shift combos are stopped (Shift+R would also toggle
record arm). Clicking a key of the key strip sets the step and auditions
the pitch (a 150 ms note on the live-note bus, ended early by pointerup);
that note-on enters no step. The selection clears when the track's current
pattern changes.

**Length.** The toolbar's Length menu (1, 2, 4 bars, plus the current length
when it is another) sets the pattern's `bars` like the piano roll's, one
"Pattern length" undo entry; notes past the end are kept, silent.

**Slides depend on the patch:** the tab shows "Slides need a mono patch with
glide, e.g. Acid Line" unless the track's MIDI In is Mono with glide > 0 and
glide mode Legato. The playhead step is highlighted like the step grid's.

## Event generation and wrapping
Each block, the engine finds the pattern events whose tick falls in the block's
tick range and fires them at their sample offset. A note's off lands at
`(start + len) mod period`; a note longer than the period is cut at the period,
so a note never overlaps itself. At equal offsets Offs run before Ons (so a
repeated pitch retriggers). A per-pitch sounding set tracks what is held.
Sequenced and live notes share the track's MIDI In voices. Stop releases
*sequenced* notes only; switching the input track releases only live-held
pitches. Editing, moving or removing a sounding note releases it.

## Pattern focus (plan 20 task 12)
Owner's note: "when playing the grid/roll, nothing else should be playing".
While the **pattern transport** plays, only the track shown in the bottom
panel (the selected drum or synth track) is heard; every other track's steps
and notes are silent. The song transport is unchanged.

| Op | # | Fields |
|---|---|---|
| `OP_SET_PATTERN_FOCUS` | 57 | `a` = slot `0..MAX_TRACKS-1`, or 255 = none (every track plays) |

**Engine** (`engine.rs` "Pattern focus", `Transport::focus`,
`Timeline::Pattern { focus }`): in Pattern mode an unfocused track schedules
nothing (`Timeline::pattern_plays`): a drum track just latches its swing, a
synth track builds no events. A *new* focus sends `Off` for every note the
pattern of any other track holds (`Synths::release_patterns_except`), so
nothing sticks, and fades every other drum track's ringing hits over 2 ms
(`Drums::fade_all_except`, the fade track removal uses): only the focused
track is heard from the switch on. The same focus again changes nothing.
Live input (the input track), the metronome and the
count-in are unaffected. Song mode ignores the focus, so export (which
renders the song) does too. The focus is transport state: `RESET_ALL` (project
load) puts it back to none, the engine default (= the old every-track
behaviour). No allocation (`no_alloc.rs` switches it while playing).

**App** (`state/song-actions.ts startTransport`, `state/actions.ts
patternFocusSlot` / `syncPatternFocus`):
- `playPattern` sends `SET_PATTERN_FOCUS(selected track's slot)` after
  `SET_MODE` and before `PLAY`; with an Audio track or nothing selected (the
  pattern transport is disabled then, but Space can still start it) it sends
  255. `playSong` sends 255.
- While the pattern transport plays, the focus follows the selection: every
  path that changes it sends the new slot (`selectTrack`, `removeTrack` when
  the selection moves, undo/redo restoring it in `diffApply`). Selecting an
  Audio track (or the selection becoming none) keeps the last focus. Stopped
  or in Song mode nothing is sent. `p.patternFocus` remembers the slot sent
  (`sendPatternFocus`; transport state, not saved): removing the focused
  track while the selection ends on an Audio track or none **stops** the
  pattern transport (nothing of it is left to play, and the slot could be
  reused by the next new track).
- `SET_PATTERN_FOCUS` is in `NON_EDIT_OPS`: not saved, not undoable, never
  marks the project dirty, never in `projectCommands`.
- No chase (see "No note chase" below): a synth focused mid-note is silent
  until its next On; a long chord that started before the switch waits for
  the next pattern loop. Drums hit on their next step.

## Live drum input
Code: `engine/src/drums.rs` (`Drums::live_hit`, "Live hits"), `engine.rs`
(`live`), `app/src/state/actions.ts` (`liveInputTrack`),
`app/src/project/commands.ts` (`inputSlot`).

The live-input track is the *selected* synth or drum track; with an Audio
track (or nothing) selected it is the last-selected synth
(`lastSynthTrackId`, which a drum track never becomes). Loading a project
picks it the same way from the saved selection (`inputSlot`).

On a drum input track a `NOTE_ON` of MIDI note `36 + r` (C2 = row 0, up to
row 15) queues a hit of row `r`; other notes, `NOTE_OFF`, bend, mod wheel
and sustain are ignored. Queued hits live in a fixed per-row buffer on the
track (one velocity per row: a repeat inside one block keeps the latest
instead of stacking) and fire at offset 0 of the next block (at most one
block, ~2.7 ms, late) through the same trigger as a step hit: gain
`row.gain * vel / 127`, equal-power pan, retrigger fades the old voice over
2 ms. They play whether or not the transport runs, in either mode. A muted
row or a row without a sample ignores them. Hits are one-shots: switching
the input away releases nothing (a ringing hit rings out) and switching to
a drum track replays nothing. Removing the track, or adding another kind
over it, drops its queued hits and unsets the input (as for a synth);
re-adding a drum track over it drops the queue and keeps it the input.

The computer keyboard plays rows too: while the input is a drum track,
`input/shortcuts.ts` maps a QWERTY note `n` at octave `o` to
`36 + (n - 12 * (o + 1))` (`qwertyPiano.ts` `qwertyDrumNote`), so the
octave's C key (KeyA) is row 1 at any octave and the 14 keys above it rows
2–15: rows 1–15 from QWERTY (the piano has 15 keys), row 16 MIDI-only. The mapping happens
where QWERTY notes enter, so the engine and the recorder both see the drum
note, and the held-key map keeps the mapped pitch for its release.

### Recording drum hits
Code: `app/src/state/recorder.ts` (`Recorder.#hit`, `recorderFor` `setStep`).
The recorder's target is `liveInputTrack`, so a drum input track records
hits into its current pattern. A note-on of `36 + r` (row `r + 1`, one the
track has; velocity > 0) sets that row's nearest step to the note's
velocity through `setStep`, overwriting what was there. Nearest is on the
*swung* grid the engine plays (`drums.rs` `step_tick`; plan 15 ruling I):
step `j` sounds at `j * 240` ticks, odd steps late by
`swing * 0.5 * 240`. Of `k - 1`, `k`, `k + 1` (`k = round(tick / 240)`)
the step sounding nearest the hit wins (`nearestSwungStep`), then wraps
`mod stepCount`, so a hit just before the pattern's end lands on the first
step. Step indices here are 0-based: with swing 0.5 a hit at tick 370 is
step index 1 (sounding at 300), at 420 index 2 (480). Step count and swing are read from the track's current pattern at
each hit (the app's `swing`; the engine latches a swing change at the next
step pair, so a hit right after a swing edit may use the new value a pair
early). Other pitches and rows the track lacks are
ignored; note-offs and the pedal do nothing (there is no note to hold
open).

A hit *before* its step (plan 15 ruling J: the step's swung, unwrapped tick
is ahead of the hit's heard tick, by at most half a step) is held, not
written: written at once, the engine would also play the freshly set step
a moment later, a flam with the live hit just heard. It is written (same
pass, same undo entry) once the heard clock reaches that tick:
`Recorder.onHeard`, called by App's per-frame `transportSync` while the
engine plays (so at most a frame after the step, when the engine's
playhead, ahead by the output latency, is past it). A later hit first
writes the held ones due by its tick, so writes keep step order. Stop,
disarm, Undo take, an input switch and a pattern switch (before the
engine switches: into the old pattern) write every held hit at once. A
late hit (step already sounded) is written at once. The gates are the
note recorder's: armed,
playing, Pattern mode, heard tick >= 0 with the 60-tick grace window. Every
hit of a pass goes through the history with that pass's coalesce key, so a
pass is one "Record" entry and **Undo take** (File ▸ Undo take) undoes its hits (and its absorbed
edits) like notes.

## Song timeline (arrangement)
Code: `engine/src/arrangement.rs` (clips), `transport.rs` (mode, loop,
split), `engine.rs` (commands, pieces), `synth.rs` / `drums.rs` (playback).

Every track slot has `MAX_CLIPS = 256` clip slots (preallocated, ~4 KB per
track) and the UI keeps the authoritative clip list, writing slots by index
like notes. `MAX_SONG_TICKS = 999 * 3840` (999 bars). Both are mirrored in TS.
A drum track triggers at most `MAX_EVENTS = 32` hits per rendered piece
(block, or block part at a loop wrap) across all its overlapping clips; extra
hits in that piece are dropped (drums have nothing to release). A synth
track's events share one 256-event buffer per piece (see Event order above;
Offs are never lost).

| Op | # | Fields |
|---|---|---|
| `OP_CLIP_SET` | 35 | `a = slot*256 + idx`, `b = offset*16 + pattern`, `c = start`, `d = len` |
| `OP_CLIP_REMOVE` | 36 | `a = slot*256 + idx` |
| `OP_CLIP_CLEAR` | 37 | `a = slot` |
| `OP_SET_MODE` | 38 | `a` = 0 pattern / 1 song |
| `OP_SET_LOOP` | 39 | `a = start`, `b = end` (`b <= a`: loop off) |
| `OP_SEEK` | 40 | `a` = song ticks (Song mode only; ignored in Pattern mode) |

Validation: integral ticks, `len >= 1`, `start + len <= MAX_SONG_TICKS`,
offset `0..61439` (`ERR_BAD_VALUE`); a bad address is `ERR_BAD_INDEX`, and so
is a clip op on an empty slot. Loop and seek values lie in
`0..=MAX_SONG_TICKS`. Adding or removing a track clears its clips.

**Playback.** A clip `{pattern, start, len, offset}` plays its pattern at song
tick `t` for `start <= t < start + len`, at pattern position
`(offset + t - start) mod patternLength`: the pattern repeats inside the clip
and is cut at the clip end. `Clip::pattern_window` maps a block window to
*unwrapped* pattern time (one piece; the pattern scanners already take it mod
the length, so the repeat wrap needs no split). Overlapping clips on a track
all play; a drum track merges their hits, a synth track merges their note
events into one offset-sorted buffer (Offs first at equal offsets).

**Note ownership.** Each clip slot of a synth track has its own voicing
(sounding set + holders), so every sounding sequenced note belongs to one clip
(or, in Pattern mode, to its pattern). A clip's notes get an `Off` at the
clip end (at its sample offset), whenever the clip is not playing in a block,
when the clip is edited / removed / cleared, when song time jumps (loop wrap,
seek, mode switch, Stop), and when its pattern is edited (length, copy, clear:
all; a moved or removed note: that note if this clip holds it). Overlapping
clips share the rack, whose MIDI In is per pitch: an `Off` from one clip can
cut the same pitch from another (accepted, FL-like) but never strands one.
Drums have nothing to release: hits stop retriggering and ring out.

**No note chase.** Notes are only started by their On. After a jump of song
time (loop wrap, seek, Play from the middle, mode switch) a note that began
before the new position does not sound: e.g. a note that started before
`loop_start` and is still sounding at the wrap is released there and stays
silent until its next On. A note that starts exactly at `loop_start` gets the
wrap's Off and its own On on the wrap frame (a retrigger).

**Transport.** In Song mode the playhead is the song position (telemetry
`TICKS`, the timeline playhead).
- Play remembers the position as the song start. The count-in is
  Pattern-mode only: Song mode ignores it (and recording is Pattern-mode only).
- Stop: Song mode returns to the loop start with the loop on, else to the song
  start (where playback last started, or the last seek). Stop with the loop on
  also overwrites the song start with the loop start (the song start is "where
  Song mode is parked"). Pattern mode: tick 0.
- Seek sets the playhead and the song start; while playing it releases the
  clip notes.
- Loop: with `start < end`, playback wraps from end to start. The block is
  split at the wrap and each piece rendered with its own window (see
  `audio-path.md`); the wrap frame plays exactly the loop start, so every pass
  has the same whole number of frames. A playhead exactly at the loop end
  wraps at once. A loop set *behind* the playhead while playing (the user
  drags bars 1-4 while bar 6 plays) jumps to the loop start at once, like a
  wrap (clip notes released, swings re-latched); a playhead seeked after the
  loop end plays on. Synced LFOs follow song time, so after a wrap they are
  back at their loop-start phase.
- Mode switch releases every sequenced note. Pattern -> Song jumps to the song
  start; Song -> Pattern goes to 0 when stopped and keeps the playhead while
  playing (patterns continue at `ticks mod period`).
- Pattern mode with a pattern focus plays only the focused track (see
  "Pattern focus" above); Song mode ignores the focus.

## Count-in
`OP_PLAY` with `a = 3840` starts the transport at tick -3840. Until tick 0 no
drum or synth pattern events fire and the metronome clicks even if it is off.
The recorder records only at tick >= 0; a note played up to 60 ticks (the
grace window) before tick 0, i.e. just before recording starts or the count-in
ends, is pulled to tick 0 instead of being lost.

## Recording uses heard time
Audio output has latency (about 250 ms on Bluetooth), so "now" in the engine is
not what you hear. The recorder therefore timestamps each key event, maps the
timestamp through `AudioContext.getOutputTimestamp()` to the *context time that
is audible*, subtracts the user "Rec offset" (-200..+200 ms, positive = notes
land earlier), and converts to a tick with telemetry:
`tick = tele.ticks + (c*sr - tele.frame) / framesPerTick`.

The heard frame `c*sr` lies one output latency *behind* the newest telemetry,
and the playhead can jump in between (loop wrap, seek, mode switch). So the
clock (`audioClock.ts`, `createTelemetryHistory`) keeps a ring of the last 256
telemetry snapshots `{frame, ticks, playing, bpm}`, sampled on every query
(each playhead queries every rAF), and extrapolates from the newest snapshot
at or before the heard frame: right after a wrap the heard tick stays at the
loop end until the wrap is actually audible. It falls back to the next
snapshot (back-extrapolating, the old behaviour) when none is that old, the
chosen one was stopped, or it is more than 0.1 s older than the next one
(nobody polled, e.g. a hidden tab).

`TELEMETRY_FRAME` (slot 8) is the context frame at which the published
`TELEMETRY_TICKS` (slot 2) is output (the start of the next block plus the
engine's latency, `engine_latency`: the 1.5 ms limiter lookahead), so the main
thread can extrapolate at constant tempo. If `getOutputTimestamp()` is
unusable (`contextTime <= 0`, early or headless), the clock falls back to
`currentTime - (baseLatency + outputLatency)`. Playheads draw the same heard
tick. Details that matter: pedal (sustain) aware; the 60-tick grace window covers ticks in [-60, 0) (see Count-in); length is at least 1
(jitter-safe); notes overdub (a note with the same pitch and start as one
already in the pattern -- from any pass, or drawn -- is not written again); "Undo take" removes exactly the notes the last pass added.
Switching the live-input track mid-pass (selecting, adding or removing a
synth track) ends every held recorded note at that heard tick on the old track
-- where the engine cuts the live pitches -- and later notes record on the new
input track as a new take (`Recorder.onInputChanged`, called from an App
`$effect` on `liveInputTrack()`). Recording targets the input track's *current pattern*. A pattern switch on
that track mid-pass works the same way: `selectPattern` calls
`Project.beforePatternSwitch` *before* the engine switches, so held notes are
written into the old pattern. The take is keyed by (track, pattern); the
overdub duplicate check reads that pattern's notes, so an undone note may be
recorded again.
"Undo take" for a pattern that is not current first selects that pattern
(a visible switch that is never undone), then deletes. A take whose track or
pattern was removed is dropped, and Undo is disabled. Recording is
disabled in Song mode: `Recorder.toggleArm` is a no-op there. The UI (plan
20): while the song plays, R / Rec flash "Recording works with the pattern
transport: stop the song first" in the bottom panel's header status line;
stopped in Song mode, they switch to Pattern mode first and then arm.
Entering Song mode closes held notes. Rec and Count-in are in the pattern
transport (bottom panel header, `ui/PatternTransport.svelte`).
A UI Play starts the recording pass at once;
the 60 Hz telemetry watcher (`transportSync`) only catches transport changes
the UI did not make.
The e2e test `record from the keyboard, notes land on the heard beat`
mocks a 250 ms latency and asserts the note lands within 60 ticks of the heard
beat, not ~480 ticks late.

## Limits
- 1024 notes per synth track (extra recorded notes are dropped with a banner).
- Note timing resolves to `RACK_BLOCK = 32` frames (0.67 ms at 48 kHz): events
  are applied at sub-block boundaries, not sample-exact.
- Live monitoring latency cannot be removed in software; only recording is
  compensated.
