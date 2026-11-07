# Sequencer and recording

How synth-track note patterns are stored, turned into audio-thread events,
counted in, and how recording maps your key presses onto the beat you *heard*.
Code: `engine/src/` (pattern + transport), `app/src/state/recorder.ts`,
`app/src/audio/audioClock.ts`.

## Pattern storage and opcodes
Each synth track owns a preallocated note table of `MAX_NOTES = 1024` entries
(`pub const` in `lib.rs`, mirrored in TS; the parity test enforces it). All
storage is created in `Engine::new`; no command allocates. Ticks are 960 PPQ,
1 bar = 3840 ticks (4/4); pattern length is 1..16 bars (default 4).

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

## Event generation and wrapping
Each block, the engine finds the pattern events whose tick falls in the block's
tick range and fires them at their sample offset. A note's off lands at
`(start + len) mod period`; a note longer than the period is cut at the period,
so a note never overlaps itself. At equal offsets Offs run before Ons (so a
repeated pitch retriggers). A per-pitch sounding set tracks what is held.
Sequenced and live notes share the track's MIDI In voices. Stop releases
*sequenced* notes only; switching the input track releases only live-held
pitches. Editing, moving or removing a sounding note releases it.

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
land earlier), and converts to a tick with the latest telemetry:
`tick = tele.ticks + (c*sr - tele.frame) / framesPerTick`.

`TELEMETRY_FRAME` (slot 8) is the context frame at which the published
`TELEMETRY_TICKS` (slot 2) applies (the start of the next block), so the main
thread can extrapolate at constant tempo. If `getOutputTimestamp()` is
unusable (`contextTime <= 0`, early or headless), the clock falls back to
`currentTime - (baseLatency + outputLatency)`. Playheads draw the same heard
tick. Details that matter: pedal (sustain) aware; the 60-tick grace window covers ticks in [-60, 0) (see Count-in); length is at least 1
(jitter-safe); notes overdub (identical pitch and start in a pass is not
duplicated); "Undo take" removes exactly the notes the last pass added.
Switching the live-input track mid-pass (selecting, adding or removing a
synth track) ends every held recorded note at that heard tick on the old track
-- where the engine cuts the live pitches -- and later notes record on the new
input track as a new take (`Recorder.onInputChanged`, called from an App
`$effect` on `liveInputTrack()`). A UI Play starts the recording pass at once;
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
