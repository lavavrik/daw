# Undo / redo

Code: `app/src/history/` — `history.ts` (the stacks, transactions,
gestures, coalescing), `diffApply.ts` (restore a snapshot with minimal
commands), `engineModel.ts` (test helper: a model of the engine state a
command stream builds). Wiring: `state/edits.ts` `edit()`, `App.svelte`,
`ui/TopBar.svelte` (↶ ↷), `input/shortcuts.ts`, `state/recorder.ts`.

## Snapshot model

An undo entry is `{ label, before, after }`, two **project snapshots**:
`serialize(p)` (`project/serialize.ts`), the same JSON a save writes, minus
sample bytes (immutable, keyed by session id in `p.sampleFiles`, so a
snapshot only names them). There are no per-action inverse commands: any
edit is undoable as long as it is in the saved project.

- Snapshots store engine addresses (track `slot`, pattern `engineIdx`, note
  and clip `idx`, module `idx`), so a restore puts everything back in the
  same engine slots.
- An entry whose before/after differ only in the track selection is dropped
  (`fingerprintOf` ignores `selection`, like the unsaved mark): selecting is
  not an edit. The project name is never restored (Save As sets it).
- The mode (`project.mode`, which transport ran last; plan 20) is saved but
  never undone, like the selection: `setMode` (the transports, Rec) is not
  wrapped in `edit()` and calls `settle()` first; `sameUndoState` ignores
  `mode` and `selection`, and `diffApply` does not restore it, so Cmd+Z never
  switches what is playing. SET_MODE still marks the project unsaved.
- Selecting a pattern is not an entry either (`selectPattern` is not
  wrapped), but the current pattern is saved, so it is part of the next
  entry's "before": undoing an edit made before a pattern switch also
  switches back.
- Consecutive entries share a snapshot object when nothing happened between
  them, and every snapshot shares each unchanged subtree with the previous
  one (see **Cost**). At most **200** entries (oldest dropped). A new entry
  clears redo.
- History is cleared when the session is replaced: `load.ts` `blankState`
  (Open, restore, New) and after New's default drum track.

## Transactions, gestures, coalescing

- **`edit(p, label, fn)`** (`state/edits.ts`) wraps the body of every
  user-level action in `state/*-actions.ts` (and the Rack's "save as library
  patch" rename). It calls `history.transact`; nested actions (an action
  calling another) run inside the outer one, whose label names the entry.
  While a load runs (`p.loading`) or a snapshot is being applied, it just
  runs `fn`.
- **Gestures** (`history/gestures.ts`, installed by App): every pointer
  gesture (window `pointerdown` … last `pointerup`/`pointercancel`,
  committed one task later so the editors' own `pointerup` flush and the
  following `click` land inside) is bracketed with `begin()`/`commit()`.
  A pointerup can be lost (a native `<select>` popup, a context menu), so a
  primary press forgets stale pointer ids and `begin()` closes a gesture
  still open; a `<select>` `change` and a `contextmenu` (capture phase)
  and window `blur` end the gesture at once. A text field's `change` does
  not: it fires when a press elsewhere blurs the field, mid-gesture. A knob,
  fader, note, clip
  or step-paint drag is one entry; the "before" snapshot is taken lazily at
  the first edit, so a click that edits nothing costs nothing, and a drag
  that ends where it started (Escape) leaves no entry.
- **Undo / redo during a drag cancels the drag** (plan 16 Task 5). Every
  component with a pointer drag (`Knob`, `Fader`, `AutoLane` points /
  curves / draw / box, `ClipPanel` fade and trim handles, `SampleStrip`
  markers, `PianoRoll`, `Timeline`, `Rack` cables) registers its Escape
  cancel with `registerDragCancel(() => boolean)` (`history/gestures.ts`:
  a module registry, like `inlineConfirms.ts`; true = "I was dragging and
  put the pre-drag values back"; a guard test fails for any `.svelte` that
  calls `setPointerCapture` without registering). App's undo/redo (⌘Z,
  ⇧⌘Z / Ctrl+Y, ↶ ↷) first call `gestures.cancelDrag()`: with a pointer
  down it asks every registered cancel; if one was dragging, the key does
  nothing else. *Why it leaves no entry:* the cancel restores through the
  same actions as the drag, inside the still-open gesture, so the gesture
  ends where it began and its `commit()` at the release pushes nothing
  (`sameProject(before, after)`); no explicit "discard" is needed (a
  restore that missed a field would show up as an entry, not as a silent
  loss). *Why nothing older is undone:* the key never reaches
  `history.undo()`, and until that gesture ends (release, blur, context
  menu, a new primary press) further undo/redo keys are swallowed too, so a
  held ⌘Z's auto-repeat does not undo the entry before the drag. A drag
  with nothing to put back (the step grid's paint, plan 16 ruling Q: each
  crossed cell already holds its value) registers a "cancel" that only
  answers true while painting: the key is swallowed, the paint goes on and
  stays one entry. While a pointer is down, ⌘⌥Z / Ctrl+Alt+Z count as undo
  too (`input/shortcuts.ts` `pointerDown`), so an Alt-drag (an automation
  curve bend) cancels without letting go of Alt; with no pointer down Alt
  keeps them off undo. A `ClipPanel` handle cancel restores all five
  grabbed fields (start, len, offset, both fades) through
  `restoreAudioClip` (no file-end `len` cap, which could leave it short of
  the grab). A widget that can unmount mid-drag removes its registration
  on destroy (`Rack`'s cable drag runs its cleanup in `onDestroy`). With a
  pointer down on something that is not a cancellable drag (a button), the
  old rule holds: the undo commits the gesture and `afterApply` re-opens
  one for the rest of the press. While a recording
  pass holds its entry open the drag's edits and the restore merge into it
  (net nothing; the absorbed count may say 1).
- **Same task:** App sets `coalesceTask`: one-shot edits made in the same
  task merge into one entry (a key press or paste that runs several
  actions).
- **Recording:** each recording pass gets a number; the recorder writes
  every note with `edit(p, 'Record', …, { coalesce: 'rec:<pass>' })`, so the
  whole pass is one entry (across retargets). "Undo take" undoes the newest
  entry when it is a pass: the history's `undoKey` (the newest entry's
  coalesce key) starts with `rec:`. A note merged into the pass takes no
  snapshot at all: its "after" is taken lazily (see **Cost**). Before any undo/redo that has
  something to apply, the recorder closes its held notes (`beforeApply`), so
  they belong to the pass being undone. On a **redo** while a recorded note
  is held, that note becomes a new edit, which clears the redo stack: the
  redo then does nothing (release the key, then redo).
- **A pass absorbs mid-pass edits** (plan 9; decision: *merge, not split*).
  From a pass's first recorded note until the pass ends (Stop, disarm or
  Undo take), **every other edit**, a gesture's included, merges into the
  pass's entry. *Why:* ⌘Z after a jam should remove the take, not a third
  of it; a knob tweak made while jamming belongs to that take.
  - API: `History.holdOpen(key)` / `release()`. The recorder holds
    `rec:<pass>` at each written note (idempotent; so at the first one) and
    releases at the pass end (`RecorderDeps.endPass`).
  - While held (the newest entry has the key and nothing was undone
    since), every transact merges into it **lazily** (marks it stale, like a
    note: no snapshot), and `begin()`/`commit()` neither open nor close an
    entry (`commit` still settles). A drag still running when the hold is
    released continues as a gesture of its own; a gesture already open when
    the hold starts (the first note landed in it) gets the key, so its
    entry becomes the pass's.
  - After an undo mid-pass the hold waits: the pass's next note makes a new
    entry, which edits then join. `clear()` drops the hold.
  - The label stays "Record". `undoAbsorbed` counts the absorbed edits (a
    gesture, or a same-task group with `coalesceTask`, counts once; an edit
    that changed nothing may count, since a lazy merge takes no snapshot):
    the Undo take tooltip says "Undo take (also undoes N edits made during
    it)" when N > 0 (`recorder.ts` `undoTakeTitle`, `RecStatus.takeEdits`).
  - An edit made before the pass's first note is its own entry, as before.

Undo/redo (⌘Z / ⇧⌘Z or Ctrl+Y, ignored while typing; the top bar's ↶ ↷
with "Undo Move notes" tooltips) first commit an open gesture, and are
refused while `p.loading`.

- **Inline confirms close first** (plan 9). An open `InlineConfirm`
  ("Remove track X?") asks about the state on screen; an undo replaces that
  state, so the question never stays open over a different one. App's
  undo/redo (shortcut and ↶ ↷) call `cancelOpenConfirms()`
  (`ui/inlineConfirms.ts`: every InlineConfirm registers its `oncancel` on
  mount) and `flushSync()` **before** applying: the confirm closes exactly
  as its Cancel would (focus back to its anchor if still there), then the
  undo applies. The popover lets ⌘Z / ⇧⌘Z / Ctrl+Y through to the
  shortcuts (every other key stays inside it).

- **Starting-point changes** (plan 8 Task 4): the default kit's samples land
  in a fresh session asynchronously (state/defaultKit.ts), maybe after the
  user's first edits. They run with `p.baselining` (`edit` just runs `fn`:
  no entry), then `history.rebase(fn)` maps every stored snapshot (both
  stacks, an open gesture's "before", the sharing base) through the same
  pure patch, sharing and freezing the new nodes like any snapshot. Each
  entry still differs only by its own edit, so undoing an early edit keeps
  the kit.

## Cost

A snapshot is a full `serialize` (~1.5 ms on a 32-track project); before
plan 8 every recorded note took one, plus a fingerprint string, and every
entry kept two whole-project snapshots and two fingerprint strings.

- **Lazy "after" (recording).** A transact that merges into the newest
  entry under the same coalesce key (a recorded note) only marks that entry
  *stale*: no snapshot, no stringify. `settle()` takes the "after" when it
  is next needed: before the "before" of any other transact (the next
  entry), before an undo/redo (after the recorder closed its held notes into
  the pass), at a gesture's `commit()`, and right before a saved change that
  is not an edit: `selectPattern` (after the recorder wrote into the old
  pattern), `selectTrack`, Save As renaming the project. So the "after" is
  the state at the pass's last note, exactly as when it was eager. A pass
  that settles back to its "before" is dropped then; when an undo is what
  settles it, that undo is the pass's (the ↶ named it): nothing is applied
  and the entry before it stays. Undo applies from settle's own snapshot
  (no second serialize). Other
  merges (same-task one-shots) stay eager.
- **Structural sharing.** Every snapshot goes through `shareSnapshot(prev,
  next)` (`project/serialize.ts`) against the previous one taken or applied:
  any subtree equal to its counterpart (tracks and mixer strips matched by
  slot, everything else by index/key) is replaced by the previous object, so
  an edit of one track keeps one new track subtree (and inside it, only the
  changed patterns / rows / patch). Unchanged tracks, the mixer, strips are
  the same objects across all entries.
- **No fingerprint strings.** "Did this edit change anything" and "did the
  pass end where it began" use `sameUndoState(a, b)` (fingerprint equality
  with the selection and the mode ignored) and the before/after sharing check uses `jsonEqual`;
  both skip identical subtrees, so with sharing they cost O(changed part).
  `diffApply`'s per-track compare short-circuits on identity too.
- **Immutable, frozen in dev/test.** Snapshots are never written; with
  `freeze` (default `import.meta.env.DEV`, so in vitest and `vite dev`)
  every node is `Object.freeze`d, so an accidental write to a shared subtree
  throws instead of silently changing other entries. `serialize` returns
  fresh objects (nothing aliases the live project), which `shareSnapshot`
  completes in place.
- **Correctness first.** Sharing is content-checked (never assumed from a
  revision counter), so a missed mutation path can cost memory, never an
  undo. `history.property.test.ts` runs 200 seeded random sequences of
  mixed edits (gestures, recording passes, pattern/track switches,
  add/remove track, undo/redo in between, same-task merging on even seeds),
  then undoes everything (equal to the state before the first entry) and
  redoes it all (equal to the final state), with the modelled engine equal
  to a fresh load at both ends. Every single undo and redo is also checked
  against a shadow of each entry's expected before/after, recorded from
  outside (serialize at op boundaries; entries identified through the
  ids and merge counts of the test-only `debugStacks(h)`, a module export
  kept off the History interface), and half the passes are followed by a
  pattern switch, so a wrong intermediate snapshot fails.

Measured (`MEASURE=1 npx vitest run src/history/history.measure.test.ts
--pool=forks --execArgv=--expose-gc`, from `app/`): 16 drum + 16 synth
tracks (200 notes each), ~210 KB of JSON; Apple M5 Pro, Node 26.

| | before | after |
|---|---|---|
| snapshots (`serialize`) while recording 500 notes | 501 (1.00 / note) | 2 (0.004 / note) |
| main-thread history cost per recorded note | 0.83 ms | 0.02 ms |
| retained heap per entry (100 one-track fader edits) | 756 KiB | 2.0 KiB |
| one-shot edit (2 snapshots) | 1.50 ms | 1.55 ms |
| undo of the 500-note pass | 1.6 ms | 2.5 ms (takes the lazy "after" first, then applies from it) |

## diffApply

`diffApply(p, sink, from, to)` makes the live project (`from` is a fresh
snapshot of it) and the engine match `to`, sending only what differs, through
the normal command sink: `p.version` / dirty marking and autosave see it
(`state/edits.ts`). No `RESET_ALL`, no `STOP`: the transport keeps playing.
Matched objects are edited in place, so their UI ids (editor selections)
survive.

Order:

1. **Tracks** gone, or whose slot changed kind: `REMOVE_TRACK` (keys that
   pointed at them fall back to none, as in the engine); then every rack
   module that goes, on **every** track, before any module is added: pooled
   effects (Delay, Reverb, Chorus) share one FX pool, so an effect moved
   between tracks must leave its old track first or its add is refused.
   The engine clears the automation lanes of a removed track or module
   itself; the state drops them here too, so it still mirrors the engine.
2. **Per track**, in `to` order:
   - a slot the live project lacks is rebuilt **whole** with the plan-6 load
     builders (`project/commands.ts` `trackState` + `trackCommands`: the
     same command order as a load);
   - otherwise (skipped when its JSON is unchanged): name/colour; drum rows
     (a removed row is reset in the engine); **patterns** — new ones, then the
     data of changed ones (the engine edits its *current* pattern, so each
     is selected in turn; `p.beforePatternSwitch` first if the current
     pattern changes), then the current pattern, then **clips**, then
     `CLEAR_PATTERN_DATA` for patterns that are gone; the **rack** — modules
     added (a different kind at an idx was removed in step 1), params, then
     cables by input port;
   - an **Audio track** (plan 9): name/colour, then its audio clips by idx:
     `CLIP_REMOVE` for every clip that goes first, then `AUDIO_CLIP_SOURCE`
     → `AUDIO_CLIP_GAIN` → `AUDIO_CLIP_SET` for each new or changed clip
     (always the three: the first two only stage). An unchanged clip is not
     re-sent and keeps its UI id. A clip moved between Audio lanes is a
     removal on one track and an add on the other, and the added clip takes
     the leaving one's UI id (matched by sample, length, offset, loop, gain
     and fades), so a selection survives the undo (a slot that changed kind
     was removed in step 1 and is rebuilt whole).
3. **Mixer** params by name, then sidechain **keys** (sources exist now;
   keys going to none first, so drum-row key slots are free).
3b. **Automation lanes** (plan 10; automation.md), matched by **engine
   lane**, after every track and module they can target exists. The
   engine's lanes are the live state's as it stood after step 1 (a track
   rebuilt whole in step 2 brings lanes the engine does not have yet).
   - **Clear, then re-target** (explicit order): every lane that goes, or
     whose owner or target changes, gets `AUTO_LANE_CLEAR` first; only then
     is any lane set. So two lanes that trade targets never meet "a second
     lane on one target", and a re-targeted lane never keeps points from
     its old range.
   - A new or re-targeted lane is then sent whole, as a load does
     (`commands.ts laneCommands`: `AUTO_LANE_SET`, its points,
     `AUTO_LANE_ENABLE`).
   - A kept lane gets its point difference **by idx**, like notes
     (`state/automation.ts pointCommands`): `AUTO_POINT_REMOVE` for every
     idx that goes or whose tick changes, **all before** any
     `AUTO_POINT_SET` (ticks are unique per lane and the engine refuses a
     SET on a tick another point still holds), then a SET per new or
     changed idx; and `AUTO_LANE_ENABLE` if the flag changed. Point idx are
     dense in the app (point i of the saved list is idx i), so the snapshot
     carries them.
   - The state: each owner's lanes as in `to`; a lane kept on its engine
     lane and target keeps its UI id. Its points keep theirs matched by
     **tick** first (a delete compacts idx, so a kept point can come back at
     another idx), then by idx for a point whose old tick is gone (moved in
     place); unchanged owners are not touched.
4. **Transport** (tempo, metronome, loop; not the mode), selection, and
   `SET_INPUT_TRACK` only if the live input changed; while the pattern
   transport plays, `SET_PATTERN_FOCUS` for the restored selection
   (`syncPatternFocus`, plan 20 task 12; not an edit).

**No stuck notes:** the engine releases a note that is removed or changed
(`NOTE_REMOVE`/`NOTE_SET`), a clip that is removed or changed, a pattern
switch and a removed track (2 ms fade) by its own rules, so a restore while
playing never leaves a note hanging (e2e `undo while playing releases
removed notes`).

## Tests

- `history.test.ts`: step toggle undo/redo, drag coalescing, redo cleared by
  a new edit, cap 200, nesting, coalesce keys, same-task merging; lean
  history: 500 recorded notes take no per-note snapshot or stringify, undo
  of a never-settled pass mid-playback restores the pre-pass state exactly,
  a pattern switch after a pass is not part of its "after", a pass that
  ends where it began is dropped, unchanged tracks / mixer / patch are `===`
  across snapshots, snapshots are frozen; recording pass hold: `edit
  mid-pass joins the pass` (notes, a fader drag, notes: one entry; undo
  restores the pre-pass fader and removes every note, redo restores both),
  one-shots merge and count once per task, held merges are lazy, a gesture
  open at the hold's start becomes the pass and a drag that outlives the
  pass stays one entry, an undo mid-pass makes the hold wait.
- `history.property.test.ts`: the randomized round-trip above (`SEED=n`
  reruns one sequence); recorded notes hold their pass open until a
  `newPass` op releases it, so the random gestures and one-shots in between
  join it, and a `jam` op (notes, a gesture, a one-shot, notes) forces that
  mix. Audio edits (plan 9): every odd seed starts with two Audio tracks
  (`addAudioFixture`), track adds include Audio tracks, and ops add, edit
  (gain/fades, loop/length, sample/offset, a left trim), move (in time and
  between lanes), split and delete audio clips. Automation (plan 10): two
  thirds of the seeds start with `addAutomationFixture`'s four lanes, and
  ops add lanes (any owner, any automatable target), remove, enable and
  disable them, add points (several in one gesture), move, reshape, delete
  and draw them, and remove rack modules and load patches (their lanes go
  with them). A redo onto an empty undo stack resets the expected bottom
  state.
- `state/recorder.test.ts`: `undo take undoes edits made during it` (the
  tooltip count is 1; Stop and Undo take end the hold).
- `ui/inlineConfirms.test.ts`: `undo cancels an open inline confirm`.
- `project/serialize.share.test.ts`: `jsonEqual` agrees with
  `JSON.stringify`; sharing by slot; `sameProject` is fingerprint equality.
- `history.measure.test.ts`: the numbers above (skipped unless `MEASURE=1`).
- `gestures.test.ts`: lost pointerup, `<select>` change, context menu,
  blur, multi-pointer, undo mid-drag; plan 16: undo/redo during a drag
  cancels it (no history call, held key swallowed until the release,
  normal again after), Cmd+Z with no drag is a normal undo, the registry,
  a cancelled fader drag on a real history leaves no entry and undoes
  nothing older, and the guard that every drag component registers.
- `diffApply.test.ts`: every kind of edit is undone and redone, and after
  each the UI state serializes to the snapshot and the modelled engine
  (`engineModel.ts`) equals a fresh load of it; only the changed note is
  sent for a note edit. `undo/redo audio clip edits`: a whole Audio track
  added and removed, per-clip edits (gain/fade/loop, a trim, a move between
  audio lanes, a split, a delete, an add, the strip's key) and an Audio
  slot taken by a drum track; only the changed audio clip is re-sent (its
  UI id kept). The engine model stages SOURCE / GAIN and commits on SET, so
  a missing stage or fades longer than the clip show up as errors. Plan 10:
  `undo restores a removed module and its lane` (also a whole patch and a
  whole track), `undo/redo lane edits` (point edits, lanes added on a track
  and the Master row, a lane removed and its engine lane re-used for
  another target, two lanes trading targets, points rewritten over the old
  ticks), `diffApply sends point removals before point sets and keeps
  point ids` and `undo keeps each point's UI id on its own point`. The engine model validates lane targets (existing,
  automatable, one lane each), point ranges and unique ticks, and clears
  lanes with their track, module or rack like the engine.
- `state/automation.test.ts` `pointCommands: random lane diffs never hit a
  taken tick`: random lane states (moves that swap or overlap ticks,
  removals, inserts) applied to the engine model: nothing refused, the
  lane ends exactly as wanted.
- e2e `tests/e2e/history.spec.ts`: removing two tracks and undoing restores
  them (sound resumes, transport never stops); undo/redo while a note
  sounds; a fader drag is one step; `undo closes an open confirm` (↶ and
  ⌘Z with "Remove track?" open: popover gone, track kept, previous edit
  undone, focus back on the ×); `undo during a knob or fader drag cancels
  the drag` (⌘Z on a pan knob and ⇧⌘Z on a fader with the mouse down:
  value back, the dead drag moves nothing, no entry, the track add not
  undone; released, ⌘Z undoes normally). Also `automation.spec.ts` `undo
  during a point drag cancels the drag` and the end of `audioclips.spec.ts`
  `Clip tab drag handles` (a fade-out handle).
- e2e `tests/e2e/settings.spec.ts` `undo audible after restart`: a row-gain
  edit undone after an audio restart is heard through the new engine.
