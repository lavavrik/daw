# Projects

A project is a folder. Code: `app/src/project/` — `schema.ts` (the JSON
shape + `validate`), `migrate.ts` (older schema versions → the current
one), `serialize.ts` (pure `serialize`, `projectFingerprint`),
`load.ts` (`loadProject`: reset + command replay), `commands.ts`
(`projectCommands`: the pure replay-order builder), `fsFolder.ts` (folder
I/O), `session.ts` (Project menu: New / Open… / Save / Save As…, banners),
`autosave.ts` (OPFS autosave + restore on start).

```
My Song/
  project.json            schemaVersion 4
  samples/0-1a2b3c4d-kick.wav   original bytes, never re-encoded
  samples/1-9f8e7d6c-snare.wav  ("<id>-<content hash>-<name>")
```

Any `FileSystemDirectoryHandle` works: a folder from `showDirectoryPicker`
(Project menu, Cmd/Ctrl+S, Shift for Save As, Cmd/Ctrl+O) or OPFS (the e2e
tests through `__daw.saveTo(dir)` / `__daw.openFrom(dir)`; the autosave).

## project.json (schemaVersion 4)

```jsonc
{
  "schemaVersion": 4, "name": "My Song", "tempo": 124, "metronome": false,
  "mode": "pattern",                       // or "song"
  "loop": { "on": false, "start": 0, "end": 15360 },
  "tracks": [                              // track-list order
    { "kind": "drum", "slot": 0, "name": "Drums", "color": "#ff6b6b",
      "rows": [{ "name": "kick", "sample": 0, "gain": 1, "pan": 0, "mute": false }],
      "patterns": [{ "engineIdx": 0, "name": "Pattern 1", "stepCount": 16, "swing": 0,
                     "hits": [[0, 0, 100], [0, 4, 100]] }],   // [row, step, velocity]
      "currentPattern": 0,                 // an engineIdx
      "clips": [{ "idx": 0, "pattern": 0, "start": 0, "len": 3840, "offset": 0 }],
      "automation": [                      // plan 10: the track's lanes (every kind)
        { "lane": 0, "enabled": true,      // engine lane 0..63, unique in the project
          "target": { "mix": "send_a" },   // a param of the track's own strip, by name
          "points": [[0, -60, 0], [7680, 0, 0]] } ] },  // [tick, value, 0 linear | 1 hold], idx order
    { "kind": "synth", "slot": 1, "name": "Bass", "color": "#ffa94d",
      "patch": { "name": "Deep Bass",       // state/patches.ts Patch: by name
                 "modules": [{ "idx": 0, "id": "midi_in", "params": { "mode": 1, ... } }],
                 "cables": [{ "from": [0, "pitch"], "to": [1, "pitch"] }] },
      "patterns": [{ "engineIdx": 0, "name": "Pattern 1", "bars": 4,
                     "notes": [{ "idx": 0, "pitch": 36, "vel": 100, "start": 0, "len": 480 }] }],
      "currentPattern": 0, "clips": [],
      "automation": [{ "lane": 1, "enabled": true,
                       "target": { "rack": [4, "cutoff"] },   // [module idx, param name]: synth tracks only
                       "points": [[0, 200, 0], [7680, 8000, 0]] }] },
    { "kind": "audio", "slot": 2, "name": "Vox", "color": "#ffd43b",   // plan 9
      "clips": [{ "idx": 0, "sample": 1, "start": 3840, "len": 7680,
                  "offset": 0.25,           // seconds into the file (rate-independent)
                  "loop": false, "gain": -3, // dB, -60 (= -inf) .. +12
                  "fadeIn": 240, "fadeOut": 480 }],   // ticks, fadeIn + fadeOut <= len
      "automation": [] }                   // mixer-strip lanes only
  ],
  "mixer": {
    "tracks": [{ "slot": 0, "params": { "fader": 0, "pan": 0, ... }, "key": null },
               { "slot": 1, "params": { ... }, "key": { "track": 0, "row": 0 } }],
    "reverb": { "rev_size": 0.6, ... }, "delay": { "delay_time": 6, ... },
    "master": { "fader": 0, "limiter_ceiling": -0.3, ... },
    "automation": [{ "channel": "master", "lane": 2, "enabled": false,   // the Master row's lanes
                     "target": { "mix": "limiter_ceiling" }, "points": [[0, 0, 0], [7680, -3, 0]] }]
  },
  "samples": [{ "id": 0, "name": "kick.wav", "type": "audio/wav", "file": "samples/0-1a2b3c4d-kick.wav" }],
  "selection": { "track": 0, "synth": 1 }, // selected track, Keys → target (slots)
  "midiMap": [                             // plan 14: MIDI CC mappings, learning order
    { "cc": 74, "track": 1, "target": { "rack": [4, "cutoff"] } },  // a track by slot
    { "cc": 7, "track": 0, "target": { "mix": "fader" } },
    { "cc": 10, "channel": "reverb", "target": { "mix": "rev_size" } } ]  // Master row channel by name
}
```

- **By name, not index:** rack module kinds (`id`), rack and mixer params,
  port names. Catalog growth never shifts a value.
- **Engine slots are kept** (`slot`, `engineIdx`, clip/note `idx`) and
  references use them, so a restore (load, plan 7's undo snapshots) puts
  everything back in the same engine slot. UUIDs are not stored.
- **Audio tracks** (plan 9, spec addendum §3.1) have no patterns, rows or
  rack: just clips, each `{idx, sample, start, len, offset, loop, gain,
  fadeIn, fadeOut}` (see `state/audio-actions.ts` for the units). A clip
  whose sample is missing (not in `samples`, its file absent, or it failed
  to decode) is **kept** with `sample: null` — drawn as "missing sample",
  silent — with a warning, so its place in the song survives.
- **Samples:** only those used by a drum row, a SamplePlayer `sample` param
  or an audio clip whose original file the session holds (`Project.sampleFiles`, filled on
  drop and load); any other use is written as none. The content hash in the
  file name is the first 8 hex digits of SHA-256 (`crypto.subtle`, async,
  computed once per drop / load — never a synchronous loop over the bytes).
  Older projects named their files with FNV-1a of the same width: they still
  load (a load reads the listed path and never checks the hash).
- **Drops racing a load:** a sample import re-checks `p.loading` and
  `Project.generation` (bumped by `blankState`) after its engine upload, so
  an upload from a session that New / Open / Restore replaced never lands
  in the new one.
- **Automation lanes** (plan 10, spec addendum §3.4; automation.md) live
  inside their owner: a track's in its `automation`, the Master row's
  (Reverb, Delay, master) in `mixer.automation` with their `channel`. A
  target is a non-integer catalog param, by name: `{mix: name}` on the
  owner's channel, or `{rack: [moduleIdx, name]}` on a synth track's rack.
  `lane` is the engine lane. A lane's `points` are listed in **engine idx
  order**: the app keeps each lane's idx dense (point i is idx i), so the
  position is the address and undo can match points by idx. The values are
  the base-independent breakpoints; what the knobs are set to (the mixer
  params, the rack params) is each target's **base value**, which plays
  wherever a lane does not apply (Pattern mode, a disabled lane). A point
  is `[tick, value, 0 linear | 1 hold]`, with a 4th element, its segment's
  **curve** (−1..1), only when that is not 0 (plan 16; no version bump:
  files without curves are byte-identical; automation.md, *Evaluation*).
  Which tracks show their lanes is UI state, not saved.
- **MIDI mappings** (plan 14, spec addendum §2; [midi.md](midi.md)):
  top-level `midiMap`, because a mapping names project tracks. Each maps a
  CC number (0..119, omni) to one control, named like an automation target:
  a track by `slot` with `{mix: name}` (its strip) or `{rack: [moduleIdx,
  name]}` (its rack: synth tracks only), or a Master-row `channel`
  (`reverb` / `delay` / `master`) with `{mix: name}`. Unlike a lane target,
  an integer param may be mapped. One mapping per CC and per control. A
  load turns the slots into the new track ids (`commands.ts`
  `midiMapState`); no engine command (the engine knows nothing of MIDI CC).
- **Not saved:** the master headroom gain (a fixed engine constant, see
  mixer.md), the song position, panel/tab state.
- `serialize` is pure. `projectFingerprint` (the JSON minus `selection`) is
  what a save / load / New records as the saved state.
- **Session-only sample data** (never saved): `Project.sampleMeta` (each
  sample's length in seconds, channels and waveform peaks; filled on import,
  load, restore and restart; a non-reactive Map, with `p.peaksVersion`
  bumped so the lanes redraw) and `Project.arenaFloats` (see *Sample
  memory* below).

## Schema versions and migration (`migrate.ts`)

Each schema change bumps `schemaVersion`. `migrate(json)` brings an older
file up to the current version one step at a time and runs **before**
`validate` (validate calls it first, so open, autosave restore and the
folder's sample list all get it). It is pure (the input is not changed).

| From → to | Plan | Change |
|---|---|---|
| 1 → 2 | 9 | Audio tracks. A v1 project has none, so only the version moves: lossless. |
| 2 → 3 | 10 | Automation. A v2 project has none: every track object and the mixer object get an empty `automation`; nothing else changes, so it is lossless. |
| 3 → 4 | 14 | MIDI CC mappings. A v3 project has none: a top-level `midiMap: []` is added; nothing else changes, so it is lossless. |

A version newer than the build knows stays an error ("saved by a newer
version of the app"); a save always writes the current version.
`migrate.test.ts` pins v1 → v4 (through v2, v3) on a frozen genuine v1 save
(`project/testdata/v1-fixture.json`) and minimal v1 files, v2 → v4 on a
frozen genuine v2 save with Audio tracks (`project/testdata/v2-fixture.json`,
the plan-9 save of `buildFixture` + `addAudioFixture`), and v3 → v4 on a
frozen genuine v3 save with lanes (`project/testdata/v3-fixture.json`, the
plan-13 save of `buildFixture` + `addAudioFixture` + `addAutomationFixture`);
`load.test.ts` `a v2 project loads and saves as v4` opens the v2 one and
checks the save.

## Sample memory (spec addendum §3.3)

The engine's sample arena is a bump allocator capped at 1 GiB
(`MAX_ARENA_FLOATS`): every upload since the last load (`RESET_ALL`) or
audio restart (a new engine) keeps its space, samples replaced or no longer
used included. `Project.arenaFloats` mirrors that count
(`state/sampleBudget.ts`): `importSample` checks the decoded file
**before uploading it** and refuses one that would not fit — "long.wav
needs 230 MB of sample memory; 120 MB is free (1 GB limit). Removed
samples are freed when the project is reopened." — with no id taken,
nothing uploaded and no clip placed. It reserves the floats when it takes
the id and gives them back if the engine refuses the upload (or a load
deferred until Stop fails then: `sampleLoads.ts`). A load starts
the count over from the samples it uploads (only the used ones, compact
ids), the audio restart from the ones it re-uploads (its late uploads add
theirs). The engine's own `ERR_OUT_OF_MEMORY` stays the backstop.
`budgetText(p)` is the Browser footer's "412 MB / 1 GB".

## Unsaved changes and `Project.version`

Every edit sends an engine command, so `AudioEngine.onCommand` →
`commandEdits` (`state/edits.ts`) marks the project dirty and bumps
`Project.version` for every op except transport (including the mode,
`SET_MODE`: which transport ran last), live notes and selection
(`NON_EDIT_OPS`; `fingerprintOf` also ignores the selection and the mode,
which are saved, silently, with the next save); the two command-free edits (add row, rename pattern) call
`markEdited` themselves. O(1) per command. `project/dirtyCheck.ts` then,
500 ms after edits pause and in an idle callback, compares
`projectFingerprint` with the saved one and clears `dirty` if the project is
back to its saved state. **The autosave subscribes to `p.version`** (below).
Nothing is marked while `p.loading`, nor while `p.baselining` (a change to
the session's starting point, below).

## The default kit (`state/defaultKit.ts`, plan 8 Task 4)

A fresh session — first start, New, and Start fresh (which keeps the first
start's session) — gets one drum track whose eight rows (Kick, Clap, Closed
hat, Open hat, Snare, Rim, Shaker, Perc; the first `MAX_ROWS`) are created
synchronously with the session, empty, before `markSaved` /
`history.clear()`, with `p.baselining` on (New runs with the engine's
`onCommand` wired: without it the track would bump `p.version` and the
untouched New session would autosave and be offered back on the next
start). New also drops the replaced session's pending autosave and deletes
its autosave (App `onFresh`, owner tab only), like Start fresh. Their samples are then fetched from the bundled starter
kit and imported in row order through `importSample` (original bytes in
`p.sampleFiles`, so Save, export and an audio restart have them), not
awaited: the UI is usable at once and rows fill as samples land; a failure
is the normal error banner and leaves that row empty. Restore and Open never
add the kit. A landing sample is part of the **starting point**, not an
edit (`attachKitSample`): set with `p.baselining` (no dirty, no version bump
— so nothing autosaves and the next start offers no restore of an untouched
session — no undo entry), then the undo history (`history.rebase`) and the
saved fingerprint are patched with the same change, so an edit the user
made while the kit loaded stays one undo step whose undo keeps the kit, and
undoing back to the start clears "● unsaved" (snapshots are patched by row
*name* within the track, `withRowSample`, not by the live row's index). If
the session was saved to a folder meanwhile, the sample is an ordinary
unsaved change instead; a save still writing when it lands sees
`p.baselineEpoch` move and leaves the project unsaved (and keeps a pending
autosave). If the user already edited the session (its version moved since
the load began), `KitDeps.landedAfterEdit` (App: `autosave.markDirty()`,
no version bump) makes the autosave include the sample; an untouched
session still never autosaves. A row the user filled first is left alone; a
New / Open / Restore (`p.generation`) ends the load. An import that failed
only because the project was busy — an audio restart, or an autosave
restore still reading (`importSample` `busy`) — is retried once that is
over (so a restart never leaves kit rows asking to "drop it again"); if
the retry is refused too, the banner says to drag it in from the Browser's
Starter kit.

The wait is a signal, not a timer (`state/idle.ts`): `p.loading` /
`p.restarting` change only through `markBusy` / `markIdle` (load.ts
`loadProject`, the restore read in `session.ts`, `restartAudio`), and the
kit awaits `whenIdle(p)`, which resolves on the next transition to idle (at
once if already idle) and never if `p.generation` moved meanwhile — the kit
load then just ends. A restore stays busy from its read straight through
its load, so the kit never retries into the gap between them.

## Validation (`validate`)

Never throws, never lets an out-of-range value through. Unknown fields are
ignored. The file is migrated first (see above). A missing/non-integer
`schemaVersion` or one greater than the current one (4) is an
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
  file path (anything but `samples/<one name>`) → cleared/dropped;
- an audio clip: a sample not in `samples` → `null` (the clip is kept);
  gain, offset (0..`MAX_SAMPLE_FLOATS` frames at 8 kHz, a sanity bound),
  start, length and fades clamped; fades that together exceed the clip
  shorten the fade-in; `gain: null` (what JSON makes of −∞) is −∞ (−60 dB).
  The engine clamps an offset its rate cannot address to
  `MAX_SAMPLE_FLOATS` frames (never a refusal, which would let the GAIN and
  SET after it commit a stale source); edits keep a one-shot's offset
  inside its file, and within `MAX_SAMPLE_FLOATS` frames at 192 kHz when
  the length is unknown.
- an automation lane (plan 10) is dropped when it is malformed, its target
  is missing, unknown, integer, not on its channel (or a rack target off a
  synth track, or on a module the validated rack lacks), its target already
  has a lane of that owner, its engine `lane` is out of 0..63 or taken, or
  it would be the 65th; a Master row lane of an unknown `channel` too. Its
  points: malformed ones dropped, ticks (0..`MAX_SONG_TICKS`, whole) and
  values (the target's range) clamped, a repeated tick dropped (the first
  kept), at most 512 kept; the kept points keep their order (= their idx).
  A point is malformed unless it has 3 or 4 finite numbers; a curve is
  clamped to −1..1, and a curve of 0 is written as none.
  `enabled` defaults to true.
- a MIDI mapping (plan 14) is dropped when it is malformed, its `cc` is not
  an integer 0..119, its `track` slot has no track or its `channel` is
  unknown, its target is missing, unknown or not on its channel (or a rack
  target off a synth track, or on a module the validated rack lacks), the
  target is not learnable (a choice or a 0..1 on/off flag: midiMap.ts
  `learnableDef`), its CC is already mapped, or its control already has a CC (the first entry
  wins either way). `projectCommands`' normalize also drops one whose module
  the FX pool dropped.

## Load order (`loadProject`)

1. `validate` (error → throw, nothing touched). From here `p.loading` is set
   (App shows "Loading…"; shortcuts, transport and drops are ignored).
2. Decode every listed sample (a missing or undecodable file → warning; its
   rows/players load without it). Then `engine.ensureRunning()`: a
   suspended AudioContext would never ack the reset, so if it cannot be
   resumed the load fails here — "Audio is paused — click to start audio,
   then open again" — with the session untouched (App resumes the context on
   any click or key press; there is no start splash, see audio-path.md
   "Start-up", so the click on Open / Restore itself has usually resumed it).
3. `beforeLoad` (App: stop via the recorder's path, release keys), `STOP`,
   blank the UI state, `RESET_ALL`; **await the worklet's `reset-done`**
   (audio-path.md): uploads must not overtake the reset. Any failure from
   here on also sets `p.folder = null`, so a later Save cannot write the
   blank session over the folder it came from.
4. Upload the samples with **compact ids 0..n−1** (fixes id burning);
   drum rows, SamplePlayer `sample` params and audio clips are remapped
   old → new (a sample that did not load: none / `null`). Each upload's
   length and channels go to `p.sampleMeta`, its floats to
   `p.arenaFloats` (counted from zero: `blankState` reset it).
5. Replay synchronously. The command list comes from the pure
   `projectCommands(json, sampleIds)` (`commands.ts`, no Project, no
   engine): the one place that knows this order, shared with undo's
   whole-track restore (`docs/architecture/history.md`), the export Worker
   and the audio restart. It also returns the normalized project the UI
   state is built from (`projectState`), so the two cannot disagree.
   - per track: `ADD_*_TRACK`; per pattern `SET_CURRENT_PATTERN` + its
     lengths + `SET_STEP` / `NOTE_SET`; the current pattern; row
     sample/gain/pan/mute; the rack via `patchRack` (as `loadPatch`; its FX-pool budget counts
     the tracks already loaded: extra Delays/Reverbs/Choruses are dropped with
     "All 8 … in use"); clips;
   - an Audio track: `ADD_AUDIO_TRACK`, then per clip `AUDIO_CLIP_SOURCE`
     → `AUDIO_CLIP_GAIN` → `AUDIO_CLIP_SET` (stage, stage, commit: always
     the three together, `commands.ts audioClipCommands`);
   - `MIX_SET` by name (non-defaults; RESET_ALL set the rest), then
     `MIX_SET_KEY` (keys need their source tracks and rows);
   - **automation lanes** (plan 10), the tracks' in track order, then the
     Master row's: per lane `AUTO_LANE_SET`, its `AUTO_POINT_SET`s (idx =
     position in `points`; a curved point's `AUTO_POINT_CURVE` right after
     its SET, which resets the curve), `AUTO_LANE_ENABLE` (always sent). After every
     track and module they target; the bases were already set by the
     `RACK_SET_PARAM` / `MIX_SET` commands, and `AUTO_LANE_SET` captures
     them. A rack lane whose module the FX-pool check dropped is dropped
     with it (a warning). `load.ts units()` keeps a lane's commands
     (its CURVEs included) together as one unit (like an audio clip's triple), so the late-upload
     rebind (`bindingCommands`) never splits one (`load.test.ts`: `units()
     keeps each lane whole`, and `bindingCommands re-sends a SamplePlayer's
     sample, never the lanes on its track`);
   - `SET_TEMPO`, `SET_METRONOME`, `SET_MODE`, `SET_LOOP`, `SET_INPUT_TRACK`
     — always, because RESET_ALL put the engine back to 124 BPM / Pattern /
     loop off / metronome off / no input.

After every New / Open that reached step 3 the session's `afterLoad` runs
(App: the recorder retargets the new live input; Song mode disarms). Load
warnings go to their own banner (`banners.load`).

`load.test.ts` replays every load through a model of the engine's checks
(`testFixture.ts` `checkLog`): no out-of-range command, nothing addressed to a
missing track/module/sample (an audio clip's SOURCE included), every audio
clip staged before its commit with fades that fit, every lane target
existing and automatable, unique point ticks with values in range, nothing
after the keys but lanes and transport, nothing after a lane but lanes and
transport. `projectCommands includes audio tracks` runs it on the
fixture plus two Audio tracks (`addAudioFixture`); `projectCommands emits
lanes after keys` adds the automation lanes (`addAutomationFixture`).

## Saving (`writeProject`)

`samples/` first (names carry a content hash, so an existing file is never
overwritten with other bytes, and a file of the right size is reused without
being read back — the same rule as the autosave pool), then
`project.json.tmp`, then the tmp is moved over `project.json` (or, where the
handle cannot move, `project.json` is written from it — Chrome's writable
streams replace a file atomically on close). Only then are the samples
removed that the **previous** `project.json` listed and the new one does
not; nothing else in the folder is ever deleted. A failure at any step
leaves the previous project readable. `readProject` reads `project.json` and
only the sample files it lists.

Save As names the project after the chosen folder. A folder that already
holds a `project.json` or anything in `samples/` (and is not this project's
own folder) is written only after an inline "Replace the project in …?
Its project.json and the samples it lists will be replaced." (`banners.ask`,
never `confirm()`; the samples that folder's old project.json listed are
swept as above, everything else stays).

**One operation at a time, one discard guard.** New, Open, Save, Save As and
Restore run one at a time (`session.ts` `once`; a second one is ignored —
`restore` resolves `null` then). Restore reads the autosave *inside* that
guard with `p.loading` set, so ⌘O cannot start an Open while big samples are
read. New, Open… and ⌘O / Ctrl+O all go through the menu bar's File menu
(`MenuBar.request` via `TopBar.request`; the project name opens it too), which asks inline "Discard and start new / open…"
whenever `discardWarning` (`project/discard.ts`) says something would be
lost: unsaved changes, or an open "Restore last session" offer ("Discard
the unrestored session …? Its autosave will be deleted." — the fresh session
is not dirty, but answering the offer this way deletes that autosave, App
`beforeLoad`). ⌘N is the
browser's own and is not taken over.

**Closing the tab.** While a project with a folder has unsaved changes
(`warnOnUnload`), App's `beforeunload` handler asks for the browser's own
"Leave site?" prompt — the one native dialog allowed, as nothing else can
stop an unload and the autosave's last flush on `visibilitychange` is async.
A project without a folder is left to the autosave (a restored session
stays "unsaved" until saved and would otherwise prompt on every close).

## Autosave (`autosave.ts`)

A crash, a reload or a closed tab loses at most the last few seconds.

**When:** App calls `markDirty` on every `Project.version` change (the same
O(1) edit signal as the unsaved mark; a load never bumps it). A write runs
**5 s after the last change** (debounced; continuous editing still writes at
least every 30 s) and at once on `visibilitychange` → hidden (`flush`). One
write at a time; a change during a write is written after it. Never while
`p.loading` (retried after). A Save / Save As drops the pending write only
if no edit landed while its files were written (below).

**Snapshot cost:** a write's `serialize` + `JSON.stringify` is synchronous
(a consistent snapshot). For a maximal project (32 drum tracks × 16 patterns,
16 rows × 64 steps all filled) it measured **~37 ms** in the unit test
(`autosave.test.ts`, node); typical projects are a small fraction of that.
Sample bytes are never copied or compared on the UI thread.

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

**Several tabs** (one OPFS per browser profile):

- every write, read and discard runs under the Web Lock `daw-autosave`, so
  one tab's sweep can never remove a sample another tab's write is about to
  list;
- only the tab holding `daw-autosave-owner` (requested with `ifAvailable`
  at App mount — `createOwnerClaim`, while the engine is still being built:
  Web Locks need no audio — and kept for the tab's lifetime) autosaves,
  offers a restore or deletes the autosave. Its outcome is therefore
  settled before any New can run, so a New clicked right after start still
  deletes the discarded session's autosave. Any other tab shows the line
  "Autosave is off — this project is open in another tab" from mount on
  (a banner under the top bar, for as long as it is not the owner) and
  never writes, so it cannot offer (or "Start fresh" away) the first tab's
  live session. Without Web Locks a tab assumes it is alone.

**Failures** (e.g. `QuotaExceededError`): one error banner "Autosave failed:
<reason>" (not repeated until a write succeeds, which clears it). The write
is retried on its own with a backoff — 5, 10, 20, 40 s, then every 60 s —
and edits meanwhile do not bring it forward, so a full disk never means a
full rewrite on every edit.

**Explicit saves** (`session.saveTo`): the snapshot `{ version, t }` and the
fingerprint are taken before `serialize`; the files are written async, so
edits can land meanwhile. `savedFingerprint` is the written state (those
edits stay "● unsaved"), the last explicit save is recorded as `t`, and
the pending autosave is dropped only if `p.version` is unchanged.

**Restore on start:** after audio starts (a restore needs the engine) and
once the owner claim settled, App peeks the marker; a New / Open that ran
meanwhile (`p.generation` moved) answered the question, so nothing is
offered. If it is
newer than the **last explicit save** (Save / Save As record `Date.now()` in
`localStorage["daw.lastExplicitSave"]`; none recorded = any autosave
counts), an inline banner above the editors offers **Restore last session**
or **Start fresh** (never `confirm()`). Until it is answered the autosave is
**held**, so new edits cannot overwrite the session on offer (they are
written once it is answered). A New / Open while it is open asks "Discard
the unrestored session …?" first; confirmed, it answers the offer (that
project replaces the session, and the autosave on offer is deleted).

- **Restore last session** → `session.restore(read)` (`read` = the
  autosave read under the autosave lock, run inside the session guard): the same
  `loadProject` as Open (validation, `beforeLoad` / `afterLoad`, the
  warnings banner). The project keeps its name, has **no folder**
  (`p.folder = null`: a directory handle is not stored in the autosave; the
  next Save asks for a folder) and stays **"● unsaved"**
  (`savedFingerprint = NEVER_SAVED`, which no fingerprint matches).
- **Start fresh** → `discardAutosave`: the marker is removed first, then
  `autosave/` and `autosave.tmp/`.

## Library (`app/src/library/`)

The Browser pane (`ui/Browser.svelte`) shows one **library** in every
project — a folder the user picks once — and, below it, always, the
built-in **Starter kit** (not a library source; plan 8 Task 4).

```
My Sounds/                any layout; every audio file below is listed
  drums/kick.wav          (wav aif aiff mp3 flac ogg m4a, the plan-1 list)
  patches/Acid.json       saved rack patches (a Patch, by catalog name)
```

- **Handle + permission** (`handles.ts`): the `FileSystemDirectoryHandle`
  is stored in IndexedDB `daw-library` / `library` / `current` as
  `{ kind: 'folder', handle }` (an older `{ kind: 'starter' }` reads as
  nothing chosen). On start
  `queryPermission({ mode: 'readwrite' })` — never a prompt — and, unless
  it says `granted` (after a browser restart it usually says `prompt`), the
  library is **lost** and the pane offers **Reconnect folder**, whose click
  calls `requestPermission` (Chrome needs the gesture).
- **State** (`library.svelte.ts`): `none` / `loading` / `ready` / `lost`.
  Every access failure — scan, preview, drag, patch save; `NotAllowedError`,
  `NotFoundError`, `SecurityError`, `InvalidStateError` — becomes **one**
  switch to `lost` with one message in the pane, and the read throws
  `LibraryLostError`, which callers never report again (plan 6 review focus
  4: no error spam). A read that fails while the root is still listable
  (one file renamed or deleted) is not `lost`: it re-lists and reports that
  file once. The pane refreshes when the tab becomes visible again, which is
  also when a revoked permission or a deleted folder shows.
- **Listing** (`scan.ts`): **lazy, one folder level at a time** — the root
  when the library opens, a sub-folder when it is expanded
  (`library.expand` / `collapse`; `state.listings` by path). Names and
  `/`-paths only (no handles kept); hidden entries and non-audio files
  (e.g. Ableton `.asd` beside every sample) are skipped and never count;
  folders and samples are each sorted by name and capped at 2000 per
  folder, with "N more not shown". A refresh re-lists only the root, the
  expanded folders and `patches/` (an expanded folder that vanished just
  closes). `patches/*.json` (not nested) is listed eagerly under Patches.
- **Starter kit** (`starter.ts`): `samples/starter/*` (CC0) through Vite
  (`import.meta.glob(…, { query: '?url' })`: `/@fs/` in dev, emitted assets
  in a build), read with `fetch` (`starterSample`). Read-only, its own
  foldable section; previews keyed `kit:<file>`; dragged with its own type
  `application/x-daw-starter-sample` (so no library path is mistaken for
  it). The default kit (above) is made of it.
- **Preview** (`preview.ts`): never through the engine; one at a time;
  work that was superseded never starts. The library hands over the disk
  `File` unread (`sampleBlob`), and its size decides: up to 50 MB (5 MB for
  compressed mp3/ogg/m4a/flac/aac, which expand ~10x) it is decoded and
  played by an `AudioBufferSourceNode` to the context's destination;
  bigger files stream through an `HTMLAudioElement` on an object URL
  (revoked on stop/end), so a 1 h WAV never becomes 1.4 GB of floats.
  Decoded buffers are cached by memory — at most 32M floats (128 MB) in
  all, least recently used out first, nothing longer than 30 s — and the
  cache is cleared on every re-list.
- **Into the project** (`drag.ts`, `state/sampleImport.ts`): a library
  sample is dragged with the private type `application/x-daw-library-sample`
  (its path). Rows, "+ Add row" and Sample Player panels read it with
  `droppedFiles` and import it exactly like a Finder file: decoded, loaded
  into the next sample id, its **original bytes** kept in `p.sampleFiles`
  (so Save copies the file into the project's `samples/`: projects stay
  self-contained). Dropped while playing (`DEFERRED`): attached when the load
  settles (`deferSampleLoad` for rows, `deferSampleAssign` for any target).
- **Patches**: Save patch (Instrument tab) writes
  `patches/<name>.json` (`patchFileName`: reserved characters → spaces, no
  leading dot, ≤ 64 chars; starter names refused) with `trackPatch(t, () =>
  -1)` — a Sample Player's `sample` is a session id, so a library patch keeps
  none. An existing file is replaced only after an inline "Replace it?".
  The patch dropdown lists library patches after the starters (value
  `lib:<path>`; the file name is the patch name). The Rack remembers the
  option each track's patch was loaded or saved from (`patchSource.ts`), so
  a hand-made library "Pad" stays selected — and is what revert reloads —
  rather than the starter Pad. The Replace prompt names the file as saved
  (sanitised), not as typed. Loading goes through
  `loadPatch` → `validatePatch`: unknown modules, bad cables, out-of-range
  params and pooled effects beyond the FX pool are dropped or clamped, and
  what was dropped shows in the Rack's inline banner.
