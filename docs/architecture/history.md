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
  not: it fires when a press elsewhere blurs the field, mid-gesture. Undo /
  redo while a pointer is still down commits the gesture and then re-opens
  one (`afterApply`) for the rest of the drag. A knob, fader, note, clip
  or step-paint drag is one entry; the "before" snapshot is taken lazily at
  the first edit, so a click that edits nothing costs nothing, and a drag
  that ends where it started (Escape) leaves no entry.
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

Undo/redo (⌘Z / ⇧⌘Z or Ctrl+Y, ignored while typing; the top bar's ↶ ↷
with "Undo Move notes" tooltips) first commit an open gesture, and are
refused while `p.loading`.

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
  pass end where it began" use `sameProject(a, b)` (fingerprint equality,
  selection ignored) and the before/after sharing check uses `jsonEqual`;
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
  test-only `debugStacks()` ids and merge counts), and half the passes are
  followed by a pattern switch, so a wrong intermediate snapshot fails.

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
     cables by input port.
3. **Mixer** params by name, then sidechain **keys** (sources exist now;
   keys going to none first, so drum-row key slots are free).
4. **Transport** (tempo, metronome, loop, mode), selection, and
   `SET_INPUT_TRACK` only if the live input changed.

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
  across snapshots, snapshots are frozen.
- `history.property.test.ts`: the randomized round-trip above (`SEED=n`
  reruns one sequence).
- `project/serialize.share.test.ts`: `jsonEqual` agrees with
  `JSON.stringify`; sharing by slot; `sameProject` is fingerprint equality.
- `history.measure.test.ts`: the numbers above (skipped unless `MEASURE=1`).
- `gestures.test.ts`: lost pointerup, `<select>` change, context menu,
  blur, multi-pointer, undo mid-drag.
- `diffApply.test.ts`: every kind of edit is undone and redone, and after
  each the UI state serializes to the snapshot and the modelled engine
  (`engineModel.ts`) equals a fresh load of it; only the changed note is
  sent for a note edit.
- e2e `tests/e2e/history.spec.ts`: removing two tracks and undoing restores
  them (sound resumes, transport never stops); undo/redo while a note
  sounds; a fader drag is one step.
