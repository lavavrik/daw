# Projects

A project is a folder. Code: `app/src/project/` — `schema.ts` (the JSON
shape + `validate`), `serialize.ts` (pure `serialize`, `projectFingerprint`),
`load.ts` (`loadProject`: reset + command replay), `fsFolder.ts` (folder
I/O), `session.ts` (Project menu: New / Open… / Save / Save As…, banners),
`autosave.ts` (OPFS autosave + restore on start).

```
My Song/
  project.json            schemaVersion 1
  samples/0-1a2b3c4d-kick.wav   original bytes, never re-encoded
  samples/1-9f8e7d6c-snare.wav  ("<id>-<content hash>-<name>")
```

Any `FileSystemDirectoryHandle` works: a folder from `showDirectoryPicker`
(Project menu, Cmd/Ctrl+S, Shift for Save As, Cmd/Ctrl+O) or OPFS (the e2e
tests through `__daw.saveTo(dir)` / `__daw.openFrom(dir)`; the autosave).

## project.json (schemaVersion 1)

```jsonc
{
  "schemaVersion": 1, "name": "My Song", "tempo": 124, "metronome": false,
  "mode": "pattern",                       // or "song"
  "loop": { "on": false, "start": 0, "end": 15360 },
  "tracks": [                              // track-list order
    { "kind": "drum", "slot": 0, "name": "Drums", "color": "#ff6b6b",
      "rows": [{ "name": "kick", "sample": 0, "gain": 1, "pan": 0, "mute": false }],
      "patterns": [{ "engineIdx": 0, "name": "Pattern 1", "stepCount": 16, "swing": 0,
                     "hits": [[0, 0, 100], [0, 4, 100]] }],   // [row, step, velocity]
      "currentPattern": 0,                 // an engineIdx
      "clips": [{ "idx": 0, "pattern": 0, "start": 0, "len": 3840, "offset": 0 }] },
    { "kind": "synth", "slot": 1, "name": "Bass", "color": "#ffa94d",
      "patch": { "name": "Deep Bass",       // state/patches.ts Patch: by name
                 "modules": [{ "idx": 0, "id": "midi_in", "params": { "mode": 1, ... } }],
                 "cables": [{ "from": [0, "pitch"], "to": [1, "pitch"] }] },
      "patterns": [{ "engineIdx": 0, "name": "Pattern 1", "bars": 4,
                     "notes": [{ "idx": 0, "pitch": 36, "vel": 100, "start": 0, "len": 480 }] }],
      "currentPattern": 0, "clips": [] }
  ],
  "mixer": {
    "tracks": [{ "slot": 0, "params": { "fader": 0, "pan": 0, ... }, "key": null },
               { "slot": 1, "params": { ... }, "key": { "track": 0, "row": 0 } }],
    "reverb": { "rev_size": 0.6, ... }, "delay": { "delay_time": 6, ... },
    "master": { "fader": 0, "limiter_ceiling": -0.3, ... }
  },
  "samples": [{ "id": 0, "name": "kick.wav", "type": "audio/wav", "file": "samples/0-1a2b3c4d-kick.wav" }],
  "selection": { "track": 0, "synth": 1 }  // selected track, Keys → target (slots)
}
```

- **By name, not index:** rack module kinds (`id`), rack and mixer params,
  port names. Catalog growth never shifts a value.
- **Engine slots are kept** (`slot`, `engineIdx`, clip/note `idx`) and
  references use them, so a restore (load, plan 7's undo snapshots) puts
  everything back in the same engine slot. UUIDs are not stored.
- **Samples:** only those used by a drum row or a SamplePlayer `sample` param
  whose original file the session holds (`Project.sampleFiles`, filled on
  drop and load); any other use is written as none.
- **Not saved:** the master headroom gain (a fixed engine constant, see
  mixer.md), the song position, panel/tab state.
- `serialize` is pure. `projectFingerprint` (the JSON minus `selection`) is
  what a save / load / New records as the saved state.

## Unsaved changes and `Project.version`

Every edit sends an engine command, so `AudioEngine.onCommand` →
`commandEdits` (`state/edits.ts`) marks the project dirty and bumps
`Project.version` for every op except transport, live notes and selection
(`NON_EDIT_OPS`); the two command-free edits (add row, rename pattern) call
`markEdited` themselves. O(1) per command. `project/dirtyCheck.ts` then,
500 ms after edits pause and in an idle callback, compares
`projectFingerprint` with the saved one and clears `dirty` if the project is
back to its saved state. **The autosave subscribes to `p.version`** (below).
Nothing is marked while `p.loading`.

## Validation (`validate`)

Never throws, never lets an out-of-range value through. Unknown fields are
ignored. A missing/non-integer `schemaVersion` or one greater than 1 is an
**error** (nothing changes). Everything else becomes a **warning**, shown in a
notice banner after the load (all of them in the console):

- wrong type → default; out of range → clamped (catalog ranges, protocol.rs
  limits);
- a track/pattern/clip/note whose slot is out of range or already taken, an
  unknown track kind, a clip of a missing pattern → dropped;
- the rack goes through `validatePatch` (state/patches.ts; shared with
  `loadPatch` and the patch library): unknown module kinds, bad idx, unknown
  params, dangling cables dropped; params clamped;
- mixer params: unknown names and params on the wrong channel (`rev_*` not
  on Reverb, `delay_*` not on Delay, the `setMix` rule) dropped; sidechain
  keys whose track/row does not exist dropped;
- a row/SamplePlayer using a sample not in `samples`, or a sample with a bad
  file path (anything but `samples/<one name>`) → cleared/dropped.

## Load order (`loadProject`)

1. `validate` (error → throw, nothing touched). From here `p.loading` is set
   (App shows "Loading…"; shortcuts, transport and drops are ignored).
2. Decode every listed sample (a missing or undecodable file → warning; its
   rows/players load without it).
3. `beforeLoad` (App: stop via the recorder's path, release keys), `STOP`,
   blank the UI state, `RESET_ALL`; **await the worklet's `reset-done`**
   (audio-path.md): uploads must not overtake the reset. Any failure from
   here on also sets `p.folder = null`, so a later Save cannot write the
   blank session over the folder it came from.
4. Upload the samples with **compact ids 0..n−1** (fixes id burning);
   drum rows and SamplePlayer `sample` params are remapped old → new.
5. Replay synchronously:
   - per track: `ADD_*_TRACK`; per pattern `SET_CURRENT_PATTERN` + its
     lengths + `SET_STEP` / `NOTE_SET`; the current pattern; row
     sample/gain/pan/mute; the rack via `loadPatch` (its FX-pool budget counts
     the tracks already loaded: extra Delays/Reverbs/Choruses are dropped with
     "All 8 … in use"); clips;
   - `MIX_SET` by name (non-defaults; RESET_ALL set the rest), then
     **`MIX_SET_KEY` last** (keys need their source tracks and rows);
   - `SET_TEMPO`, `SET_METRONOME`, `SET_MODE`, `SET_LOOP`, `SET_INPUT_TRACK`
     — always, because RESET_ALL put the engine back to 124 BPM / Pattern /
     loop off / metronome off / no input.

After every New / Open that reached step 3 the session's `afterLoad` runs
(App: the recorder retargets the new live input; Song mode disarms). Load
warnings go to their own banner (`banners.load`).

`load.test.ts` replays every load through a model of the engine's checks
(`testFixture.ts` `checkLog`): no out-of-range command, nothing addressed to a
missing track/module/sample, nothing after the keys but transport.

## Saving (`writeProject`)

`samples/` first (unchanged files are not rewritten; names carry a content
hash, so an existing file is never overwritten with other bytes), then
`project.json.tmp`, then the tmp is moved over `project.json` (or, where the
handle cannot move, `project.json` is written from it — Chrome's writable
streams replace a file atomically on close). Only then are the samples
removed that the **previous** `project.json` listed and the new one does
not; nothing else in the folder is ever deleted. A failure at any step
leaves the previous project readable. `readProject` reads `project.json` and
only the sample files it lists.

Save As names the project after the chosen folder. A folder that already
holds a `project.json` or anything in `samples/` (and is not this project's
own folder) is written only after an inline "Replace the project in …?"
(`banners.ask`, never `confirm()`).

## Autosave (`autosave.ts`)

A crash, a reload or a closed tab loses at most the last few seconds.

**When:** App calls `markDirty` on every `Project.version` change (the same
O(1) edit signal as the unsaved mark; a load never bumps it). A write runs
**5 s after the last change** (debounced; continuous editing still writes at
least every 30 s) and at once on `visibilitychange` → hidden (`flush`). One
write at a time; a change during a write is written after it. Never while
`p.loading` (retried after). A Save / Save As drops the pending write
(`cancel`): that state is in the folder.

**Where:** OPFS (`navigator.storage.getDirectory()`), per browser profile:

```
autosave/autosave.json        the marker: { format: 1, savedAt, project }   ← the only file read
autosave/samples/<id>-<hash>-<name>   sample pool shared by successive autosaves
autosave.tmp/autosave.json    the next marker while it is being written
```

**Atomic swap** (`writeAutosave`), so an interrupted write always leaves the
previous autosave readable and never a half-written one:

1. every listed sample missing from the pool is written into it. Names carry
   the content hash, so a file that exists **with the right size** is reused
   (no bytes read back); an interrupted sample write leaves an empty or
   short file, which the next write redoes. Files are written in **1 MiB
   chunks** (`fsFolder.writeFile`), each its own awaited `write()`, so a
   large sample never holds the UI thread in one long copy;
2. the marker (`savedAt` + the `serialize`d project.json) goes to
   `autosave.tmp/`;
3. it is **moved over `autosave/autosave.json`** — the commit. Where the
   handle cannot move (or will not replace), the marker is written whole
   instead: Chrome's writable streams replace a file atomically on close;
4. pool files the new marker does not list are removed — after the commit,
   so the committed marker never lists a missing sample.

`readAutosave` reads only `autosave/autosave.json` (an empty, unparsable or
other-format marker counts as none) and the pool samples it lists;
`autosave.tmp/` is never read. The `serialize` snapshot is taken
synchronously at the start of a write, so no edit can interleave with it.

**Restore on start:** after audio starts, App peeks the marker. If it is
newer than the **last explicit save** (Save / Save As record `Date.now()` in
`localStorage["daw.lastExplicitSave"]`; none recorded = any autosave
counts), an inline banner above the editors offers **Restore last session**
or **Start fresh** (never `confirm()`). Until it is answered the autosave is
**held**, so new edits cannot overwrite the session on offer (they are
written once it is answered). A New / Open while it is open answers it
(that project replaces the session).

- **Restore last session** → `session.restore(json, files)`: the same
  `loadProject` as Open (validation, `beforeLoad` / `afterLoad`, the
  warnings banner). The project keeps its name, has **no folder**
  (`p.folder = null`: a directory handle is not stored in the autosave; the
  next Save asks for a folder) and stays **"● unsaved"**
  (`savedFingerprint = NEVER_SAVED`, which no fingerprint matches).
- **Start fresh** → `discardAutosave`: the marker is removed first, then
  `autosave/` and `autosave.tmp/`.

A failed write shows one error banner ("Autosave failed — …"; not repeated
until a write succeeds, which clears it) and is retried on the next change.

