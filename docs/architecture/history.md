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
  them. At most **200** entries (oldest dropped). A new entry clears redo.
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
  "before" snapshot (the entry keeps its own). Before any undo/redo that has
  something to apply, the recorder closes its held notes (`beforeApply`), so
  they belong to the pass being undone. On a **redo** while a recorded note
  is held, that note becomes a new edit, which clears the redo stack: the
  redo then does nothing (release the key, then redo).

Undo/redo (⌘Z / ⇧⌘Z or Ctrl+Y, ignored while typing; the top bar's ↶ ↷
with "Undo Move notes" tooltips) first commit an open gesture, and are
refused while `p.loading`.

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
  a new edit, cap 200, nesting, coalesce keys, same-task merging.
- `gestures.test.ts`: lost pointerup, `<select>` change, context menu,
  blur, multi-pointer, undo mid-drag.
- `diffApply.test.ts`: every kind of edit is undone and redone, and after
  each the UI state serializes to the snapshot and the modelled engine
  (`engineModel.ts`) equals a fresh load of it; only the changed note is
  sent for a note edit.
- e2e `tests/e2e/history.spec.ts`: removing two tracks and undoing restores
  them (sound resumes, transport never stops); undo/redo while a note
  sounds; a fader drag is one step.
