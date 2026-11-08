# MIDI CC and MIDI learn

Plan 14, spec addendum §2 (`docs/superpowers/specs/2026-11-12-midi-learn-sampler-addendum.md`).
A knob or fader can be bound to a Control Change number on a MIDI controller;
moving that controller knob then moves the control exactly as dragging it
would.

## The CC path

```
Web MIDI input ─▶ input/midi.ts parseMidi ─▶ { t: 'cc', cc, v }  (CC 0..119)
                                         └▶ onCc(cc, v) ─▶ UI router (learn mode / per-frame batch)
                                                             └▶ state/midiMap.ts applyCc
                                                                  └▶ setParam / setMix (model + engine)
```

- `input/midi.ts` turns every CC 0..119 into a `cc` event (any channel, any
  device: omni). CC1 still sends `MOD_WHEEL` and CC64 still sends `SUSTAIN`
  (their built-in roles) **and** emits a `cc` event, so both are learnable
  too. CC120 / CC123 stay panic and never reach `onCc`; 120..127 are never
  learnable (`LEARNABLE_CC`).
- `window.__daw.midi.inject(bytes)` feeds raw bytes through the same handler
  (Playwright cannot drive Web MIDI).
- The UI applies at most one move per mapping per animation frame (the
  latest value wins), so a dense CC stream costs one edit per frame (see
  "UI" below).

## The mapping model (`state/midiMap.ts`)

`Project.midiMap: MidiMapping[]`, each `{ cc, owner, target }`. `owner` and
`target` name a control exactly as automation names a lane target: `owner`
is a track id or a Master-row channel (`'reverb' | 'delay' | 'master'`, the
`MixChannelTarget` of mixer-actions), `target` an `AutoTarget`
(`{kind:'mix', param}` on the owner's strip, `{kind:'rack', module, param}`
on a synth track's rack).

- **One CC → one control, one control → one CC.** `learnMidi(p, cc, owner,
  target)` first drops any mapping of that CC and any of that control.
- **Which targets:** `mappingDef` resolves the catalog def. It is
  automation's `targetDef` minus the "non-integer only" rule: an octave,
  unison or voices knob can be mapped (fromPos + clampParam round it).
  `learnableDef(def)` then rejects choice params (radio groups: wave, filter
  mode, delay division) and 0..1 integer flags (mute, solo, eq_on,
  comp_on, send_*_pre, delay_ping_pong). `learnMidi` refuses those,
  `validate` drops them with a warning, and the UI does not offer them.
- **Value:** CC value `v` sets the param to `ccValue(def, v)` =
  `fromPos(def, v / 127)`: the knob's own taper (log for `exp` params, the
  zero zone for glide), then the action's clamp. The control jumps to the CC
  value (no soft takeover).
- **Applying:** `applyCc(p, sink, cc, v, touch?, coalesce?)` resolves the
  mapping (a rack target by module idx and param NAME, so it survives
  catalog growth) and calls `setParam` / `setMix` with `{ coalesce, label:
  'Set <param label> (MIDI)' }` (`coalesce` defaults to `midi:<cc>`; the UI
  router passes `midi:<cc>:<sweep>`), then `touch(owner, target)` (the UI
  overrides an automated target in Song mode, like a drag). An unmapped CC,
  or a mapping whose control no longer resolves, does nothing and returns
  false.
- `mappingLabel` reads "Bass · Filter · Cutoff" / "Bass · Volume" /
  "Reverb · Size" for the mapping list.

## Lifetime

Removing a track drops its mappings (`removeTrack` → `dropTrackMappings`);
removing a rack module drops that module's (`removeModule` →
`dropModuleMappings`); loading a patch onto a track drops the track's rack
mappings, its mixer mappings stay (`loadPatch` → `dropRackMappings`). These
are plain mutations made inside the removal's own `edit`, so they share its
undo entry: one undo brings the track and its mappings back. A load (`blankState`) starts with none.

## Undo

- Learning and forgetting are edits: "MIDI learn CC 74", "Forget MIDI CC 74".
  They send no engine command, so they call `markEdited` themselves.
- A CC sweep on one control is one entry ("Set Cutoff (MIDI)"): consecutive
  edits with the same coalesce key merge while that entry is the newest
  (history.md). A sweep on another CC in between starts a new entry, so
  CC 74 then CC 71 is two entries. A sweep also ends after a pause: the UI
  router numbers sweeps per CC (`midi:<cc>:<n>`, `n` steps when a CC comes
  more than 1000 ms after the previous one on that number), so turning the
  same knob twice a few seconds apart is two entries.
- App's history merges one-shot edits made in the same task
  (`coalesceTask`). The router applies every waiting CC in ONE
  requestAnimationFrame callback, so moves of DIFFERENT mappings that land
  in the same frame (two controller knobs turned together) may merge into
  one entry. Accepted: undo takes back both. A learn runs in the MIDI
  message's own task and a move only ever in a later frame, so a learn and
  a move never merge.
- The CC that completes a learn only binds; it does not also move the
  control, so the learn entry is a pure "MIDI learn CC n".
- Undo snapshots carry `midiMap` (it is in the saved project). `diffApply`
  step 4 rebuilds `p.midiMap` from the target snapshot by track slot (no
  engine command), so a track that undo rebuilds under a fresh id gets its
  mappings back.

## Saved form (schema v4)

Top-level `midiMap: MidiMapJson[]` in project.json (projects.md); v3 → v4
adds `[]`:

```ts
type MidiMapJson =
  | { cc: number; track: number /* slot */; target: { mix: string } | { rack: [moduleIdx: number, name: string] } }
  | { cc: number; channel: 'reverb' | 'delay' | 'master'; target: { mix: string } };
```

`validate` drops (with a warning) a malformed entry, a cc outside 0..119, an
unknown slot or channel, a module idx not on that track, an unknown param
name or one the channel does not take, a duplicate cc and a duplicate
control (the first wins). A load's `normalize` also drops a mapping on a
module the FX pool dropped. Slots become the new track ids in
`commands.ts` `midiMapState` (load and undo share it).

## UI (`ui/midiLearn.svelte.ts`, AutoMenu, Knob, Fader)

- **The menu.** Right-click (or the ContextMenu key / Shift+F10) on a knob
  or fader opens `AutoMenu.svelte`: "Automate" / "Show automation" when
  `bus.canAutomate` (continuous params), then "MIDI learn", or "Forget MIDI
  (CC 74)" when the control has a CC, when `bus.canLearn` (continuous and
  integer: `canLearn` = `mappingDef` + `learnableDef`). The menu opens when
  either kind of item exists, so an integer knob (octave) opens it for learn
  only. ArrowUp / ArrowDown move between the items, Escape closes it.
  Controls without an `auto` identity (the scope's knobs) offer neither.
- **Learn mode.** `startLearn(owner, target, label)` sets the one learn
  target (a second "MIDI learn" replaces it), shows the hint "Move a knob on
  your MIDI controller (Esc cancels)" (`banners.hint`) and starts a 10 000 ms
  timer. The target knob / fader gets class `learning`: a pulsing outline
  (static under `prefers-reduced-motion`). App routes `onCc` to the router:
  the first learnable CC calls `learnMidi`, flashes "MIDI CC 74 → Filter
  Cutoff" and ends learn mode; CC 120..127 are ignored and learning goes on.
  Esc (App's window keydown, bubble phase: an Esc an open menu or a typed
  value consumes is theirs) or the timeout calls `cancelLearn`. If the
  control was removed meanwhile, the CC binds nothing and learn mode ends.
- **Moves.** Outside learn mode `createCcRouter` keeps the latest value of
  each mapped CC and applies them all in the next animation frame
  (`applyCc` with `touch` = `autoBus.touch`): in Song mode a CC on an
  automated target overrides its lane (AUTO_OVERRIDE) exactly like a drag;
  in Pattern mode only the base moves. Unmapped CCs cost no frame. A value
  still queued for a CC when that CC is re-learned is dropped. Moves ride
  `requestAnimationFrame`, so in a hidden tab they wait and apply when it
  becomes visible. While a project load / audio restart runs (`p.loading`)
  the router ignores CCs (learn mode stays on).
- **The badge.** A mapped control shows a small "CC" tag
  (`data-testid="<testid>-cc"`; the fader's is `fader-cc`) and its title
  (its accessible description) ends "— MIDI CC 74". Knob / Fader read
  `bus.midiCc(owner, target)` (reactive: `project.midiMap`).
- e2e: `tests/e2e/midi.spec.ts` (learn, sweep, undo, forget, a fader, Esc).

## The popover

- **Where.** The top bar's `midi-status` pill is a button (`aria-haspopup=
  "dialog"`) that toggles `ui/MidiPopover.svelte`
  (`data-testid="midi-popover"`, `role="dialog"`, `aria-label="MIDI"`),
  anchored under the pill in a `position: relative` wrapper (the bar is
  `overflow-x: clip`, so it can drop below). App passes `midiCc` (the last
  CC, any channel) to TopBar.
- **Non-modal**, like the piano roll's Examples popover: Esc (stopped, so
  it is not also "cancel learn"; focus returns to the pill), a pointer press
  outside it, or focus moving away (Tab out) closes it. Pressing the pill
  again is its own toggle.
- **Sections.** Devices: one line per device, or the status text for
  none / denied / unsupported. Last CC: `CC 74 = 100`
  (`data-testid="midi-last-cc"`), or "Move a knob on your controller".
  Mappings: `p.midiMap` sorted by CC, rows `CC <n> → <mappingLabel>`
  (`midi-map-<n>`) with a ✕ (`aria-label="Forget CC <n>"`) that calls
  `forgetMidi`: one undo entry "Forget MIDI CC n". Empty: "Right-click a
  knob → MIDI learn". The list is reactive, so a learn or an undo updates
  it while open.
- e2e: the "MIDI popover" test in `tests/e2e/midi.spec.ts`.

## Pitch and Mod wheels (`ui/Wheels.svelte`, `input/wheels.svelte.ts`)

The on-screen wheels sit in a narrow strip on the left of every synth tab
(Piano roll, Acid, Instrument), like the wheels beside a keyboard's keys.

- **What they control.** The same two values as the hardware wheels:
  `PITCH_BEND` (−1..1; the patch's MIDI In `bend` param sets the range in
  semitones) and `MOD_WHEEL` (0..1, CC 1). The engine keeps one global bend
  and one global mod, and applies them to the live input track (the selected
  synth track). It re-sends both when the input track changes, so the
  wheels are global and don't reset when you switch tracks.
- **One source of truth.** `wheels` holds what the engine was last sent.
  App forwards `AudioEngine.onCommand(op, a)` to `observeCommand`, so a
  hardware wheel (input/midi.ts), a drag on screen and a `RESET_ALL`
  (project load) all move the same state. A new engine (audio start or
  restart) starts at rest, so `wireEngine` calls `resetWheels`.
- **Behaviour.**
  - Pitch springs back to the centre on release (pointer up, cancel, lost
    capture, key up, blur); Mod stays where it is left.
  - A drag is relative: grab anywhere, and the wheel's full height is its
    full range, so grabbing doesn't jump the value.
  - Double-click resets either wheel.
  - Keys: Up/Down step 0.05, PageUp/PageDown step 0.25, Home resets. These
    keys don't reach the global shortcuts or the QWERTY piano.
- **The readout.** Pitch shows semitones from the patch's bend range ("+1.0
  st"), or the raw value when there is no MIDI In. Mod shows 0..127.
- **Not edits.** `PITCH_BEND` and `MOD_WHEEL` are in `NON_EDIT_OPS`: no
  undo entry, never saved, not recorded. To record a wheel, MIDI-learn CC 1
  onto a knob (the mod wheel also arrives as `cc 1`).
