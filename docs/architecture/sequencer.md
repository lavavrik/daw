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

## Event generation and wrapping
Each block, the engine finds the pattern events whose tick falls in the block's
tick range and fires them at their sample offset. A note's off lands at
`(start + len) mod period`; a note longer than the period is cut at the period,
so a note never overlaps itself. At equal offsets Offs run before Ons (so a
repeated pitch retriggers). A per-pitch sounding set tracks what is held.
Sequenced and live notes share the track's MIDI In voices. Stop releases
*sequenced* notes only; switching the input track releases only live-held
pitches. Editing, moving or removing a sounding note releases it.

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
  wraps at once; one already *after* the loop end when the loop is set (or
  seeked there) plays on. Synced LFOs follow song time, so after a wrap they
  are back at their loop-start phase.
- Mode switch releases every sequenced note. Pattern -> Song jumps to the song
  start; Song -> Pattern goes to 0 when stopped and keeps the playhead while
  playing (patterns continue at `ticks mod period`).

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
`$effect` on `liveInputTrack()`). Recording targets the input track's *current pattern*. A pattern switch on
that track mid-pass works the same way: `selectPattern` calls
`Project.beforePatternSwitch` *before* the engine switches, so held notes are
written into the old pattern. The take is keyed by (track, pattern), and so is
the overdub duplicate set, which is cleared only at pass start and on undo.
"Undo take" for a pattern that is not current first selects that pattern
(a visible switch that is never undone), then deletes. A take whose track or
pattern was removed is dropped, and Undo is disabled. Recording is
disabled in Song mode: arming is a no-op, and entering Song mode closes held
notes.
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
