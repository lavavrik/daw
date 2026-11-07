# Projects

A project is a folder. Code: `app/src/project/` — `schema.ts` (the JSON
shape + `validate`), `serialize.ts` (pure `serialize`, `projectFingerprint`),
`load.ts` (`loadProject`: reset + command replay), `fsFolder.ts` (folder
I/O), `session.ts` (Project menu: New / Open… / Save / Save As…, banners).

```
My Song/
  project.json            schemaVersion 1
  samples/0-kick.wav      original bytes, never re-encoded ("<id>-<name>")
  samples/1-snare.wav
```

Any `FileSystemDirectoryHandle` works: a folder from `showDirectoryPicker`
(Project menu, Cmd/Ctrl+S, Shift for Save As, Cmd/Ctrl+O) or OPFS (the e2e
tests through `__daw.saveTo(dir)` / `__daw.openFrom(dir)`; Task 4's autosave).

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
  "samples": [{ "id": 0, "name": "kick.wav", "type": "audio/wav", "file": "samples/0-kick.wav" }],
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
  what "● unsaved" compares against the last save / load / New (App effect).

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

1. `validate` (error → throw, nothing touched).
2. Decode every listed sample (a missing or undecodable file → warning; its
   rows/players load without it).
3. `STOP`, blank the UI state, `RESET_ALL`; **await the worklet's
   `reset-done`** (audio-path.md): uploads must not overtake the reset.
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

`load.test.ts` replays every load through a model of the engine's checks
(`testFixture.ts` `checkLog`): no out-of-range command, nothing addressed to a
missing track/module/sample, nothing after the keys but transport.

## Saving (`writeProject`)

`samples/` first (unchanged files are not rewritten), then
`project.json.tmp`, then the tmp is moved over `project.json` (or, where the
handle cannot move, `project.json` is written from it — Chrome's writable
streams replace a file atomically on close). Samples the new `project.json`
no longer lists are removed last. A failure at any step leaves the previous
project readable. Save As names the project after the chosen folder.
