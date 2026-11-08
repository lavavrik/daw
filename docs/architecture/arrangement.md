# Arrangement (patterns, clips, Song mode)

The engine-level details (op codes, event order, wrap splitting) live in
`sequencer.md` ("Song timeline") and `audio-path.md`. This page is the model
in one place: what the user can build and what the engine guarantees.

## Patterns
- Every track owns up to `MAX_PATTERNS = 16` patterns (both kinds). A drum
  pattern holds the steps of all rows plus its step count and swing; rows
  (sample, gain, pan, mute) stay per track. A synth pattern is the plan-3 note
  pattern (notes plus bars).
- A track always has at least one pattern; a new track starts on engine
  slot 0 (any pattern no clip uses, slot 0 included, can be deleted while
  others remain).
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
The engine has one transport and two modes; the UI has two transports
(plan 20), and the mode is whichever ran last (`project.mode`, saved). There
is no PAT/SONG switch (and no Shift+L) any more.
- **Pattern mode** (the **pattern transport**: ▶ / ■ / Rec / Count-in and
  the "beat / bars" readout in the bottom panel's header,
  `ui/PatternTransport.svelte`; the default): unchanged from plans 1-3. Each
  track loops its current pattern from tick 0; recording targets the
  live-input track's pattern.
- **Song mode** (the **song transport**: the top bar's Play / Stop): the
  transport plays song time from the seek position (ruler click, default
  0). Recording is disabled; the count-in is ignored.
- `state/song-actions.ts` `playSong` / `playPattern` start one: the other
  one, if running, is stopped first (the App's `beforeStop` hook closes held
  recorded notes at the heard tick), then `setMode` (saved, so it marks the
  project unsaved, but never an undo entry and never restored by undo, like
  the selection: Cmd+Z can't switch what plays), then PLAY (the count-in
  is asked once the mode is set). `stopTransport` stops either;
  `toggleTransport` is the default the shortcuts fall back to without an
  App. The App wraps them with the recorder hooks: `toggleSong` (the top
  bar's Play / Stop), `startTransport('pattern')` / `stopAny` (the panel's
  ▶ / ■) and `togglePattern`.
- **Space** (`input/shortcuts.ts`): while either transport plays, it stops
  it, wherever the focus is. Stopped, it starts the pattern transport when the
  key belongs to the bottom panel (App's `inBottomPanel`: the key's target or
  `document.activeElement` is inside the panel's wrapper, or, with the focus
  on `<body>` because a panel control gave it back (the pattern picker, rack
  selects, number fields blur after use), the panel was where the last
  pointerdown / focusin happened), else the song transport. Text fields, contenteditable and `<select>` keep Space. A step
  cell cancels its pointerdown (no text selection while painting), so the
  grid focuses the cell itself: a clicked step puts the focus in the panel.
- **Rec** and **R**: with no drum or synth track selected, R only flashes
  why (the disabled Rec's tooltip, `ui/patternReadout.ts noPatternReason`).
  Arming while the song plays is refused with a hint; stopped in Song mode
  (the song ran last), arming switches to Pattern mode first (no undo entry),
  so the next pattern Play records and counts in.
- **Loop** (ruler drag sets whole bars and turns it on; the top bar's Loop
  button toggles it, whatever ran last; it plays in Song mode only): with `start < end`, playback wraps from end to
  start exactly. The block is split at the wrap, so nothing double-fires or
  skips, and synced LFOs stay phase-continuous (they follow song ticks).
  Setting a loop behind the playing playhead jumps to its start at once.
- **Stop**: Pattern mode resets to 0; Song mode returns to the loop start with
  the loop on, else to where playback last started (FL-like).
- No note chase: after a jump (wrap, seek, mode switch) a note that began
  earlier does not sound until its next On.

## Note ownership and release
Each clip slot of a synth track has its own voicing, so every sounding
sequenced note belongs to one clip (or, in Pattern mode, to its pattern). Its
`Off` is sent at the clip's end, whenever the clip stops playing in a block,
when it is edited, removed or cleared, when song time jumps, and when its
pattern is edited. Resizing a clip under the playhead (same start, offset
and pattern, playhead still inside it, e.g. dragging its right edge) is not
an edit of what sounds: its notes keep sounding (cut at the new end if that
is earlier). Overlapping clips share the rack's per-pitch MIDI In, so one
clip's `Off` can cut the same pitch from another (accepted, FL-like) but never
strands a note. Drums have nothing to release: hits stop retriggering and ring
out.

## Audio tracks
Plan 9 (spec addendum §3.1); engine side in `engine/src/audio_track.rs`.

- **Model.** An Audio track (`SlotKind::Audio`, `OP_ADD_AUDIO_TRACK` = 45)
  uses one of the 32 track slots, so it has its own mixer strip, meters and
  can be a whole-track sidechain key. It has no patterns, rows or rack:
  pattern, drum, note, rack and pattern-clip commands on it return
  `BAD_INDEX`. Its lane holds up to 256 audio clips
  `{sample, start, len, offset, loop, gain, fadeIn, fadeOut}`: `start`,
  `len` and the fades are ticks, `offset` is the trim start (seconds on the
  wire, frames in the engine at its own rate), `gain` is linear 0..4.
- **Edits apply as a whole.** `AUDIO_CLIP_SOURCE` (46: sample, offset, loop)
  and `AUDIO_CLIP_GAIN` (47: gain, fades) only stage; `AUDIO_CLIP_SET` (48:
  start, len) commits both with the position. `CLIP_REMOVE` / `CLIP_CLEAR`
  remove audio clips; every `ADD_*_TRACK` and `REMOVE_TRACK` clears a
  slot's audio clips with a 2 ms fade.
- **Playback.** Song mode only (silent in Pattern mode; a mode switch fades
  the voices out). At tick `t` the file plays frame
  `offset + (t − start) × framesPerTick`, modulo the file length with
  `loop` on; a one-shot clip is silent after the file ends. Native speed, no
  interpolation; a mono file plays on L and R; overlapping clips all play.
- **A voice advances by frames, never by ticks**, so a tempo change never
  makes it jump (a clip keeps its length in ticks: its audio ends early or
  is cut at the clip end). A one-shot file that ended stays silent until a
  jump, an edit that changes the clip's mapping (sample, offset, loop or
  start) or a replacement of its sample, even if a faster tempo maps the
  playhead back inside it.
- **Chase.** On Play, a seek, a loop wrap, a loop set behind the playhead, a
  mode switch, an edit that changes the sample, offset, loop or start, and a
  sample that becomes ready (or is replaced) while the playhead is inside the
  clip, the voice restarts at the file frame for the current tick; this
  includes a one-shot that already finished. Changing only the length, gain
  or fades keeps the voice; the gain and the user-fade factor ramp from the
  old value to the new one over 5 ms (a fade handle or the end dragged across
  the playhead never steps). `CLIP_REMOVE` also resets the slot's staged
  edit.
- **Fades** (2 ms, `CLIP_FADE_SECONDS`):
  - a start at file position 0 is unfaded (keeps the transient); any other
    start (chase, trimmed clip, late sample) fades in;
  - every clip end fades out, ending exactly at the clip end; a one-shot
    file's last 2 ms fade out too. The end fade always runs in full: an end
    that a resize or a tempo change puts less than 2 ms ahead (before its
    fade began), or one moved while its fade runs, cuts the voice instead
    (the hold-and-fade may run up to 2 ms past the clip end), and a chased
    start inside a clip's last 2 ms stays silent;
  - a cut voice (jump, Stop, removal, a new sample generation, its clip moved
    off the playhead) holds its last sample and fades it out; a chase into
    the same clip fades in meanwhile (a linear cross-over);
  - the user's fade-in / fade-out are linear and multiply with all of these;
  - a loop clip's repeat seam is not faded.
- **Safety.** A voice plays only while the sample keeps the generation it
  captured, so a replaced, reset or late sample is never read stale (see
  `audio-path.md`, "Sample generations").

### Audio lanes in the UI
Plan 9 Task 5: `ui/song/Timeline.svelte` (AUDIO LANES comment),
`ui/song/tlMath.ts` (`dropTarget`, `audioEdges`, `audioMarks`),
`ui/ClipPanel.svelte`, `audio/peaks.ts`.

- **Drops** are resolved by `dropTarget(rows, y)`: an Audio lane places
  the files, below the last lane makes a new Audio track, a drum / synth
  lane (or the ruler) only shows "Drop audio on an audio track or below the
  tracks". Every file is imported first (`sampleImport.ts`: decode, budget,
  peaks, upload); the track and all clips are then placed inside one
  `edit()`, so one undo removes the whole drop (`state/audioDrop.ts`). A
  DEFERRED load (dropped while playing) is registered with `sampleLoads.ts`
  right after its own import (a Stop during a later file's import settles
  it), placed at once on its sample id (the engine chases it in when it
  lands) and drawn hatched while `pendingSampleIds()` has it. If it fails,
  the clip keeps its id but `sampleFailed(id)` marks it: drawn red-hatched,
  "sample failed to load" (lane, overlay `data-state`, Clip tab), and the
  banner names the track that went silent.
- **Waveforms.** `computePeaks` keeps Int8 min/max per 256 frames per
  channel plus 4× coarser levels down to one pair; `peaksLevel` picks the
  coarsest level with at least one pair per pixel. Computed after decode and
  before the upload transfers the channels (import and project load; the
  autosave restore loads the same way; the audio restart keeps them), in a
  Worker past 2^22 floats (frames × channels) with the buffers transferred
  both ways, cached by content hash. A Worker failure never loses the
  sample: `peaksFor` returns no peaks (and no channels if the worker took
  them), and the import or load decodes the kept bytes again (flat
  placeholder). While playing, only the playhead canvas over the lanes and
  the ruler redraw each frame. The lane maps a pixel to file time (`offset + (tick −
  start) / ticksPerSecond`, wrapped for a loop clip) and peaks to file
  fractions, so peaks made at one sample rate draw right at another.
- **Edges.** A one-shot clip's right edge stops at `audioEdges(...).maxEnd`
  (its file's end at the current tempo; `setAudioClip` caps the same way);
  the left edge goes through `trimAudioClipStart` (start and offset move
  together). Loop clips draw a notch every file length; a one-shot whose
  file ends before the clip (a tempo change) gets an end-of-file mark and a
  dimmed silent rest (`audioMarks`).
- **Lane moves.** A drag of only audio clips follows the pointer onto
  another Audio lane (`moveClips` with the lane delta to that lane; over a
  non-audio lane they stay where they are); Escape moves them back.
- **Split** (`splitClips`): Cmd/Ctrl+E at the heard playhead (playing in
  Song mode) or the parked song position, and "Split here" at the beat
  under the right-click. Works on note clips too.
- **Clip tab** (Alt+6, the sixth tab; no F-key, F10 is the browser's menu
  key): the clip in `clipFocus` (set by clicking, placing or selecting one
  audio clip; clicking also selects its track). Gain fader in dB, fades in
  beats typed exactly, Loop to fill; every change is one `setAudioClip`.
  Above the controls a 120 px waveform (`ui/vis/WaveformView`; visuals.md
  *Waveforms*): x = clip time 0..len with a beat grid, the file through the
  clip's offset and loop drawn pre-gain, the gain × fades envelope as a line
  (`waveMath.clipEnvelope`, the engine's `user_fades`), dashed loop seams,
  and a DOM playhead while the song playhead is inside the clip. It zooms
  from the whole clip to single samples. Drag handles sit on it (plan 16;
  each a `role="slider"`, test ids `cliptab-handle-fade-in|fade-out|trim`): a
  Fade in flag and a Fade out flag at the top, a Trim start bar on the left
  edge. A drag runs the field's own action, so the clamps are the fields':
  fades through `setAudioClip` (a fade never leaves the clip; the fade-out
  wins over the fade-in), the trim through `trimAudioClipStart` (the end
  stays, the offset follows). Pixels become ticks through the view at the
  grab (`waveMath.dragDeltaTicks`); the handles are placed from the view
  `WaveformView` reports (`onview`; hidden until the first draw). Escape,
  pointercancel or a lost capture mid-drag restores the grabbed values; keys
  on a focused handle move it a quarter beat (Shift: a beat,
  `waveMath.handleKeyDelta`). A pointer drag is one undo entry
  (history/gestures.ts), each key press its own.
  `shortcuts.ts tabFor` says which tab fits which track kind.

## The playlist look (plan 20)
Spec `docs/superpowers/specs/2026-11-14-redesign.md` §4 *Playlist*; code in
`ui/song/Timeline.svelte` (LOOK comment: what is drawn when),
`clipDraw.ts` (the clip drawing: body, previews and their bitmap cache,
waveform, repeats, hatch), `TrackHeaders.svelte` (LOOK), `TrackVol.svelte`
(the volume slider), `AutoLane.svelte`, `tlMath.ts` (preview marks).

- **Colours.** The canvases read the theme tokens from `ui/theme.ts`
  (`theme.css` for the HTML); a shade between tokens is a token under a
  white or black veil. Track colours are data. No `.svelte` file here has a
  hex literal (`noHexColors.test.ts`).
- **Clips.** A rounded body in the track colour with the `--gloss` recipe
  drawn on canvas (white 30 % → 0 over the top 60 %, a 1 px top highlight, a
  2 px darker bottom edge), the name in `--on-color`, and a mini preview in
  `--on-color` under the name: a mark per drum hit (one band per row that
  has hits, `drumPreview`), a dash per note at its pitch (`notePreview`), or
  for audio the waveform from the peaks. A missing or failed sample's clip
  is dark (`--well`) with a `--rec` hatch and a light (`--text`) name. The selection is a light outline with grips.
- **Preview cost.** The marks are a `$derived` per used pattern, normalised
  to one period, so a scroll or zoom never recomputes them; only visible
  clips draw, only the periods in view are placed (`periodStarts`), and a
  period up to 2048 device px wide is rendered once per pattern and zoom
  into a cached bitmap and stamped (one `drawImage` per period). Periods
  under 8 px get no preview; wider than the cap (deep zoom: a few in view)
  draw their marks directly.
- **Ruler and playhead.** The loop range is an `--accent` bar along the
  ruler's top over a faint band (dim while the loop is off or in Pattern
  mode); bar numbers are in the mono font. The playhead is white (`--text`)
  with a soft glow; the parked song position a dim line.
- **Track headers.** A 6 px colour bar, the name (and kind) over a thin
  volume slider, raised M / S / A (lit: `--accent`, `--play`, the track
  colour). The slider (`TrackVol.svelte`, `track-vol-<slot>`) is a skinned
  range input bound to the track's mixer fader: `setMix('fader')` like the
  strip's Fader, its travel on the fader law (`mixMath.faderPos` /
  `faderDb`), one undo entry per drag (the window gesture bracket), Escape
  or Cmd/Ctrl+Z mid-drag restores the value from before the press
  (`registerDragCancel`; the press also ends on window blur or the next
  pointerdown, so a lost release leaves nothing stale), arrows ±1 dB from
  the heard value, double-click 0 dB. Like the Fader it registers on the
  auto bus: while the fader's lane applies (Song mode) the thumb rides at
  the heard value (`data-auto`, `data-auto-value`, aria "automated (base
  …)"), and an edit overrides the lane (`autoBus.touch`). The Master row
  has no slider.

## Limits
| What | Limit |
|---|---|
| Patterns per track | 16 |
| Clips per track | 256 (pattern clips, or audio clips on an Audio track) |
| Song length | 999 bars |
| Drum hits per track per rendered piece | 32 (extra hits dropped) |
| Synth events per track per piece | 256 (Offs never lost) |
| Pattern length | 16 bars (synth), 64 steps (drum) |
| Audio-clip gain | 0..4 linear (`MAX_CLIP_GAIN`, +12 dB) |
| Audio-clip fades | `fadeIn + fadeOut <= len` (ticks) |
| Audio-clip offset | clamped to `MAX_SAMPLE_FLOATS` frames (at the engine rate) |
| Declick fade / gain ramp | 2 ms / 5 ms |
| Sample memory | 1 GiB (`MAX_ARENA_FLOATS`), 256 MB per file |

Known gaps are tracked in `docs/followups/plan-3.md` (Song-mode perf with many
clips, `set_bars` releasing every pitch).
