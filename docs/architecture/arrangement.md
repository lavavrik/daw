# Arrangement (patterns, clips, Song mode)

The engine-level details (op codes, event order, wrap splitting) live in
`sequencer.md` ("Song timeline") and `audio-path.md`. This page is the model
in one place: what the user can build and what the engine guarantees.

## Patterns
- Every track owns up to `MAX_PATTERNS = 16` patterns (both kinds). A drum
  pattern holds the steps of all rows plus its step count and swing; rows
  (sample, gain, pan, mute) stay per track. A synth pattern is the plan-3 note
  pattern (notes plus bars).
- Pattern 0 always exists, and a track always keeps at least one.
- Each track has a **current pattern** (default 0): the one the step grid /
  piano roll edits, Pattern mode loops, and recording writes to. The bottom
  panel header reads `<track> · <pattern name>`.
- The UI owns the lists; the engine holds indexed slots written by index.

## Clips and the time mapping
- A clip is `{pattern, start, len, offset}` in song ticks (960 PPQ, bar =
  3840). Up to `MAX_CLIPS = 256` per track; the song is at most 999 bars
  (`MAX_SONG_TICKS = 999 * 3840`). All limits are `pub const` in
  `engine/src/lib.rs`, mirrored in TS (parity test).
- At song tick `t`, with `start <= t < start + len`, the clip plays its
  pattern at position `(offset + t - start) mod patternLength`. So a clip
  *repeats* its pattern when longer than the pattern and *cuts* it when
  shorter. Dragging the left edge moves `start` and `offset` together so the
  music stays put.
- Overlapping clips on one track both play (drums merge hits, synths merge
  note events).
- A clip never changes track: its pattern belongs to its track (no
  cross-track copy yet). **Make unique** gives a clip its own copy of a
  pattern shared with other clips.

## Song mode, loop and seek
- **PAT** (default): unchanged from plans 1-3. Each track loops its current
  pattern from tick 0; recording targets the live-input track's pattern.
- **SONG** (Shift+L, top bar): the transport plays song time from the seek
  position (ruler click, default 0). Recording is disabled; the count-in is
  ignored.
- **Loop** (ruler drag sets whole bars and turns it on; the Loop button
  toggles; Song mode only): with `start < end`, playback wraps from end to
  start exactly. The block is split at the wrap, so nothing double-fires or
  skips, and synced LFOs stay phase-continuous (they follow song ticks).
- **Stop**: Pattern mode resets to 0; Song mode returns to the loop start with
  the loop on, else to where playback last started (FL-like).
- No note chase: after a jump (wrap, seek, mode switch) a note that began
  earlier does not sound until its next On.

## Note ownership and release
Each clip slot of a synth track has its own voicing, so every sounding
sequenced note belongs to one clip (or, in Pattern mode, to its pattern). Its
`Off` is sent at the clip's end, whenever the clip stops playing in a block,
when it is edited, removed or cleared, when song time jumps, and when its
pattern is edited. Overlapping clips share the rack's per-pitch MIDI In, so one
clip's `Off` can cut the same pitch from another (accepted, FL-like) but never
strands a note. Drums have nothing to release: hits stop retriggering and ring
out.

## Limits
| What | Limit |
|---|---|
| Patterns per track | 16 |
| Clips per track | 256 |
| Song length | 999 bars |
| Drum hits per track per rendered piece | 32 (extra hits dropped) |
| Synth events per track per piece | 256 (Offs never lost) |
| Pattern length | 16 bars (synth), 64 steps (drum) |

Known gaps are tracked in `docs/followups/plan-3.md` (Song-mode perf with many
clips, `set_bars` releasing every pitch).
