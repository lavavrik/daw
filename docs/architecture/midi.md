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
  latest value wins), so a dense CC stream costs one edit per frame.

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
  Whether a control offers "MIDI learn" at all is the UI's decision (knobs
  and faders; not choice radios or on/off buttons).
- **Value:** CC value `v` sets the param to `ccValue(def, v)` =
  `fromPos(def, v / 127)`: the knob's own taper (log for `exp` params, the
  zero zone for glide), then the action's clamp. The control jumps to the CC
  value (no soft takeover).
- **Applying:** `applyCc(p, sink, cc, v, touch?)` resolves the mapping (a
  rack target by module idx and param NAME, so it survives catalog growth)
  and calls `setParam` / `setMix` with `{ coalesce: 'midi:<cc>', label:
  'Set <param label> (MIDI)' }`, then `touch(owner, target)` (the UI
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
  CC 74 then CC 71 is two entries.
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
