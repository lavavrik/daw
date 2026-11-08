# House DAW

A personal browser DAW for making house music: drum step grids, modular synth
racks, a piano roll with recording, patterns arranged on a song timeline, a
mixer with sends, sidechain and a master limiter, projects saved to folders,
undo/redo and WAV export. A Rust audio engine compiled to WASM runs in an
AudioWorklet; the UI is Svelte 5. Design:
[docs/superpowers/specs/2026-11-06-daw-design.md](docs/superpowers/specs/2026-11-06-daw-design.md);
architecture notes per area in [docs/architecture/](docs/architecture/).

**Contents:** [Getting started](#getting-started) ·
[The first loop](#the-first-loop) · [Synth and rack](#synth-and-rack) ·
[Recording](#recording) · [Piano roll](#piano-roll) · [Acid steps](#acid-steps) ·
[Patterns and song](#patterns-and-song) · [Mixer](#mixer) ·
[Save, open and export](#save-open-and-export) · [Library](#library) ·
[Undo and redo](#undo-and-redo) · [Shortcuts](#shortcuts) ·
[Troubleshooting](#troubleshooting) · [Development](#development)

## Getting started

You need:

- rustup (the toolchain is pinned in `rust-toolchain.toml` and installs on first build);
- Node 26 and npm;
- desktop Chrome (the app uses Web MIDI, the File System Access API and
  `SharedArrayBuffer`; other browsers are not supported).

```sh
npm install
npm run dev        # builds the engine, serves http://localhost:5174
```

Open http://localhost:5174 and click **Click to start audio** (browsers only
start audio from a click). The screen has four parts:

- the **top bar**: the Project menu (the project name, "Untitled" at first),
  undo/redo, transport, recording, tempo and status;
- the **Browser** on the left: your sample library and saved patches, and the
  built-in **Starter kit**;
- the **timeline** at the top: one lane per track, with **+ Drum track** and
  **+ Synth track** under the track list. Each track header has **M** (mute
  the track) and **S** (solo: play only this track, plus any other soloed
  ones) — the same switches as the track's mixer strip;
- the **bottom panel**: the selected track's editor (**Step grid** for drums;
  **Piano roll**, **Acid** or **Instrument** for synths) and the **Mixer** tab.

A new project starts at 124 BPM with one drum track that is already a
playable kit: eight rows (Kick, Clap, Closed hat, Open hat, Snare, Rim,
Shaker, Perc) loaded from the built-in starter kit, no steps yet. The rows
fill a moment after start; that is the starting point, not an edit (no
"● unsaved", nothing to undo). Project ▸ New starts the same way; restoring
the last session or opening a project does not add it.

## The first loop

1. The kit is already there: skip to step 3, or swap sounds. Drag a kick
   from Finder (or from the Browser, see [Library](#library)) onto the Kick
   row: dropping on a row that already has a sample replaces it, and the row
   takes the file's name. An empty row says "drop sample".
2. Dropping on **+ Add row** makes a new row. Drop several files at once and
   each gets its own row. The Browser's **Starter kit** section has more
   sounds (a second kick, a sub hit, two chord stabs) to drag in.
3. Click cells to place steps; click-drag paints; right-click a step clears
   it. **Alt**-click places a quiet ghost note (drawn dimmer). A focused cell
   also toggles with **Enter**. For
   four-on-the-floor, put the kick on steps 1, 5, 9 and 13 and the hat on 3,
   7, 11 and 15.
4. Press **Space** (a clicked cell keeps the focus in the bottom panel, so
   Space plays the pattern) or the **▶** in the bottom panel's header. The
   outlined column is the playhead. Change the
   tempo in **BPM** (type a value, then Enter) and try **Metro** (the
   metronome).

Click a row's name to hear its sample (the Browser's preview bar shows it,
with **■ Stop**; click the name again to stop). Each row has **M** (mute),
gain and pan. **≈** next to the name opens that row's waveform under the
grid (one row at a time; zoom like the Clip tab's). Under the grid: **Steps** (16, 32 or
64) and **Swing**. Up to 16 rows per drum track and 32 tracks per project (the
add buttons grey out at 32).

Accepted audio files: wav, aiff, mp3, flac, ogg and m4a. A failed drop shows a
red banner and changes nothing. A very large sample dropped while playing
loads when you stop (a yellow notice says so). Each sample's last 2 ms are
faded out, so a sample that doesn't end at zero never clicks.

## Synth and rack

Click **+ Synth track**: it gets the *Deep Bass* patch and opens the **Piano
roll**. Play it with the computer keyboard (the home row A S D F G H J K L are
white keys, W E T Y U O the black keys; **Z** / **X** change the octave, shown
as **Oct** in the top bar) or a MIDI keyboard. The top bar's **Keys →** shows
which track the keys play: the selected synth or drum track (with an audio
track selected, the synth track selected last). A selected drum track takes
the keys: MIDI notes 36–51 (C2 and up) play its rows 1–16, and on the
computer keyboard the octave's C (**A**) is row 1 and the keys up from it
(W S E D F T G Y H U J K O L) rows 2–15.

The **Instrument** tab shows the track's rack: module panels joined by cables.
Design notes: [docs/architecture/modular.md](docs/architecture/modular.md).

- **Patch** loads a built-in patch or one you saved to the library,
  replacing the rack. The menu lists the built-ins by group, then your
  library. After any edit **(edited)** appears; **revert** reloads the patch.
  Loading over edits asks first (an inline "Discard your edits…?" under the
  control). Built-in patches:
  - *Starter*: Deep Bass, Chord Stab, Pad, Lead, Pluck (the basics; Deep
    Bass is the default for a new track).
  - *House · Leads & Stabs*: **Sax** (breathy alto-like mono hook lead with
    delayed vibrato, velocity brightness and legato glide), **Brass Stab**
    (bright disco-house hit that blooms), **Arp Pluck** (short, bright, for
    1/16 arps).
  - *House · Keys*: **Tine Keys** (FM electric piano for deep-house chords;
    play harder for more bell), **Piano Stab** (the classic house piano
    chord stab), **Garage Organ** (percussive UK-garage organ with a wah
    bounce).
  - *House · Bass*: **Organ Bass** (hollow 90s organ bass), **Reese Bass**
    (detuned, phasing Reese), **Acid Line** (squelchy; velocity is the
    accent, overlapping notes slide), **Sub Bass** (clean deep-house sub).
  - *House · Pads*: **Strings** (string-machine section with a slow swell),
    **Warm Pad** (a pad that moves, with a 2-bar filter sweep).
  Built-in names can't be used for **Save patch**. Tip: the **mod wheel**
  (a MIDI keyboard's) opens the Sax (brighter, "pushed") and the Reese (up
  to four octaves of filter), and rides the Acid Line's cutoff.
- **Save patch** stores the rack in the library folder's `patches/` (it needs
  a library folder, see [Library](#library)); it then shows in **Patch**.
- **Knobs:** drag up or down (Shift = fine), double-click for the default, or
  focus and use the arrow keys. The value is shown under the label. To type
  an exact value, click the value (or press **Enter** on a focused knob),
  type it and press **Enter** (**Esc** cancels): `440`, `1.2k`, `250 ms`,
  `-6`, `45%`, `L30`. A bare number is in the unit on screen ("2" on a
  "1.2 kHz" knob is 2 kHz); out-of-range values are clamped. Mixer knobs
  work the same way. Choice
  parameters (wave, filter mode…) are segmented buttons.
- **Cables** are coloured by signal: audio blue, pitch orange, gate green,
  CV purple. Drag from an output to an input to patch; an input takes one
  cable, so a new one replaces the old. Grab a cable by its *input* end to
  move it to another input, or drop it anywhere else to unplug it. **Esc**
  cancels a cable or knob drag.
- **From the keyboard:** Tab to a jack and press **Enter** (or Space) to pick
  it up, Tab to another jack and press **Enter** to connect. On a connected
  input, Enter picks up its cable: Enter on another input moves it, **Delete**
  unplugs it. **Esc** cancels.
- **+ Add module** (grouped by category; arrow keys move through it) and the
  × on a module header. Up to 32 modules per rack.

**Effects in the rack.** Besides the sources and shapers, + Add module lists
**Delay** (tempo-synced, up to 2 s), **Reverb**, **Chorus**, **EQ**,
**Compressor** (with a sidechain input), **Saturator**, **Attenuator** (level
and offset, handy for scaling a CV), **Formant** (three resonant peaks that
give a sound a vowel-like or horn-like body; they can follow the note and
take a CV, as in the Sax's body and the Garage Organ's "wah") and the
**Sample Player** (plays a project
sample, optionally pitched from the keys; follow it with an ADSR and a VCA for
gated notes; drop a sample on its panel). Delay, Reverb and Chorus share
memory across the project: at most 8 delays, 8 reverbs and 16 choruses over
all tracks. When a bank is full the menu greys the module out ("All 8 delays
in use").

The starter poly patches (Chord Stab, Pad, Pluck) are about 9 dB quieter
than the starter mono ones (Deep Bass, Lead) so chords don't clip: raise
their faders in the mixer. The house patches are levelled instead: each
reads about −15 dBFS (momentary loudness, within ±3 dB) on its typical
phrase at velocity 100, so they sit at similar levels without touching the
faders. The ADSR also has **Delay** and **Velocity** knobs now, and MIDI In
a **Glide mode** (Always, or Legato for slides on overlapping notes only).

## Recording

1. Select a synth or drum track (its name shows after **Keys →**).
2. Arm with **R** or **● Rec** (it turns red). **1-2** (Count-in) gives one
   bar of clicks before recording starts. Both are in the bottom panel's
   header, in the pattern transport.
3. Press the pattern transport's **▶** (or **Space** while the bottom panel
   has focus). What you play is recorded into the track's current
   pattern, which loops; each loop overdubs. A note with the same pitch and
   start as one already in the pattern is not written again, so playing a
   part twice never stacks hidden duplicates. The sustain pedal works.
   On a drum track each hit (MIDI 36–51 or the keys, see above) switches on
   the nearest step of its row, at the hit's velocity; a hit just before the
   pattern's end lands on step 1.
4. **↶ Take** undoes the last recording pass (one pass is one undo step).

Recording works with the pattern transport only (Pattern mode): while the
song plays, Rec can't arm; stopped, arming switches back to Pattern mode.
Switching the Keys track or the pattern
mid-pass ends held notes there and records on into the new target.

Recording places notes where you *heard* the beat, using the browser's output
timestamp, so even Bluetooth headphones (150–250 ms late) record on the beat.
If notes still land early or late, set **Offset** in the top bar (−200 to 200
ms; positive = earlier). Design notes:
[docs/architecture/sequencer.md](docs/architecture/sequencer.md).

## Piano roll

The **Piano roll** tab edits the synth track's current pattern.

- **Mouse:** click empty space to add a note one grid cell long (keep
  dragging to place it); drag a note to move it, its last few pixels to
  resize; **Shift**-drag box-selects, **Shift**-click toggles a note in the selection;
  **Alt** turns snapping off. Click a key on the keyboard at the left to hear
  it. The lane at the bottom sets velocity: drag a stem up or down.
- **Keys** (while the roll has focus): **Delete**/Backspace removes the
  selection, **Q** quantizes (the selection, or every note), **Cmd/Ctrl+A**
  selects all, **←/→** move by a grid cell, **↑/↓** by a semitone (**Shift**:
  an octave), **Esc** cancels a drag or clears the selection. Every other key
  still plays the keyboard piano.
- **Wheel** scrolls, **Shift+wheel** scrolls time, **Cmd/Ctrl+wheel** zooms.
- **Toolbar:** **Grid** (snap and new-note length), **Length** (pattern bars;
  notes past the end are kept but silent, drawn hatched), **Quantize** and
  **Clear** (asks first).
- **Examples ▾:** a short phrase for every house patch (the ones its demo
  renders played): stabs and keys on a Cm9 → Fm9 → Abmaj7 → Gm7 loop, pad
  chords, an arp, basslines, an acid line and a Sax hook. The example for
  the track's patch is listed first. Click one to add it as a new pattern of
  this track; **+ track** adds a new synth track with that patch and the
  example instead. Either is one undo step. Notes only: the renders' mod-wheel
  sweeps are not included (ride the wheel or draw automation). On the
  Instrument tab, **Add example roll** next to **Patch** does the same for the
  loaded house patch and opens the Piano roll.

## Acid steps

The **Acid** tab (next to Piano roll, **Alt+3**) shows the same pattern as
steps: 16 per row, one row per bar (1 to 4 bars). Nothing new is saved: the
steps are the pattern's notes, so the piano roll, recording, clips and export
all see them.

- **A step** is a note (its name; ▲/▼ an octave up or down), a rest (—) or a
  tie (~, holds the note before). **A** marks an accent (velocity 120 instead
  of 80), **⤳** a slide into the next note (the note overlaps it, so a mono
  patch with legato glide, like *Acid Line*, glides; the tab says so when the
  patch can't). A slide needs a note right after it.
- **Click a step** to select it, then click a key of the octave strip, or
  play a note (keyboard piano or MIDI): it lands on the step and the next
  step is selected. **Accent / Slide / Rest / Tie** and **▲/▼** change the
  selected step. Keys while the tab has focus: **←/→** (**↑/↓**: a row) move
  the selection, **A** accent, **S** slide, **R** rest, **T** tie, **Esc**
  deselects.
- **Toolbar:** the base octave (**−** C2 **+**: the keys' octave), **Root**
  and **Scale** for **Randomize** (a new pattern) and **Mutate** (re-rolls a
  few steps), **←/→** rotate the pattern a step, **Transpose** ±1/±12 and
  **Clear**. Each is one undo step.
- A pattern with notes the steps can't show (off the 1/16 grid, chords,
  overlaps, too wide a range, longer than 4 bars) shows why and offers
  **Convert to steps** (one undo step).

## Patterns and song

Design notes: [docs/architecture/arrangement.md](docs/architecture/arrangement.md).

- **Patterns.** Each track has up to 16 patterns. The picker above the editor
  has **+ New**, **Duplicate**, **Rename** and **Delete** (a pattern used by
  clips, or a track's last one, can't be deleted). The selected one is the
  track's *current* pattern.
- **Two transports.** The top bar's **▶ Play** plays the song (the
  timeline). The **pattern transport** in the bottom panel's header (▶, ■,
  Rec, Count-in and the position "beat / bars", e.g. "1.3 / 2") loops each
  track's current pattern. Starting one stops the other. **Space** plays /
  stops the pattern while the bottom panel has focus, the song otherwise.
- **Clips.** Click an empty spot in a track's lane to place its current
  pattern there. Drag a clip's body to move it (beat snap, **Alt** = free),
  its right edge to repeat or cut it (dashed lines mark repeats), its left
  edge to trim. **Double-click** a clip to edit its pattern below.
  **Right-click** for **Make unique** (its own copy of a shared pattern) and
  Delete. Clips stay on their own track.
- **Split.** **Cmd/Ctrl+E** splits the selected clips at the playhead (or at
  the song position while stopped); **Split here** in a clip's right-click
  menu splits at that beat. The right half plays on from where the left one
  stopped.
- **Timeline keys** (lanes focused): **Delete** removes, **Cmd/Ctrl+D**
  duplicates, **Cmd/Ctrl+E** splits, **Cmd/Ctrl+A** selects all, **←/→** nudge a beat (**Shift**: a
  bar), **Esc** cancels a drag or clears the selection; **Shift**-drag box
  selects. Wheel scrolls tracks, Shift+wheel scrolls time, Cmd/Ctrl+wheel
  zooms; the slider under the lanes scrolls time too.
- **Ruler.** Click it to set the song position. Drag on it to set a loop of
  whole bars (it turns **Loop** on); the top bar's **Loop** toggles it. While
  playing, the new loop takes effect when you release. Stop returns to the
  loop start, else to where you started.
- After the last clip, the song keeps playing (silence) until you stop.
- Each track's **×** (on hover) removes it after an inline confirmation.

Limits: 16 patterns and 256 clips per track, 999 bars.

## Audio tracks

Vocals, loops, breaks, whole stems: audio files play on **audio tracks**, in
Song mode (the song transport), at their recorded speed.

- **Drop audio on the timeline.** Drag files from Finder, a library sample
  or a starter-kit sound onto the timeline. Below the last lane (where it
  says *Drop audio files here*) makes a new audio track; on an audio track's
  lane it lands at the beat under the pointer (**Alt**: exactly there).
  Several files go one after another. A drum or synth lane only says *Drop
  audio on an audio track or below the tracks*. **+ Audio track** in the
  footer adds an empty one. One undo takes a whole drop back.
- **Clips** show the waveform in the track colour, with their sample's name.
  They move (also onto another audio track), trim from the left (the audio
  stays where it was), split, duplicate and delete like pattern clips. A
  clip's right edge stops at the end of its file, unless **Loop to fill** is
  on (right-click menu or the Clip tab): then the file repeats, with a notch
  where each repeat starts. A clip whose sample is still loading (dropped
  while playing) is striped until you stop; "missing sample" means the file
  was not in the project folder.
- **Tempo.** Clips are never stretched. After a tempo change a clip keeps
  its length in bars: the file then ends early (a yellow mark, silence
  after it) or is cut at the clip end.
- **Clip tab** (**Alt+6**, or click / double-click a clip): the clip's sample,
  length and channels; **Gain** (−∞ to +12 dB; double-click resets),
  **Fade in** / **Fade out** in beats (type the exact value, Enter), and
  **Loop to fill**. Above them the clip's waveform with a beat grid, the gain
  and fades as a yellow line, dashed lines where a loop repeats, and the
  playhead while it plays. **⌘/Ctrl-wheel** or a pinch zooms, down to single
  samples (dots); the wheel scrolls; double-click shows the whole clip. The
  corner says how much is visible ("2.6 ms · 125 samples"); samples that hit
  full scale are marked red. Click it and use **+**/**−**, **←**/**→** and
  **0** from the keyboard. Every file you can load zooms down to single
  samples (up to 256 MB decoded, the same limit as a sample: ~11 min of
  48 kHz stereo).
  An audio track has no Step grid, Piano roll or Instrument.
- Audio tracks are silent in Pattern mode (the pattern transport). Each has its own mixer strip (fader,
  sends, inserts, sidechain key).
- **Sample memory** is 1 GB (about 46 minutes of stereo at 48 kHz); the
  Browser footer shows what is used ("Samples 412 MB / 1 GB"). One file can
  be up to 256 MB (about 11 minutes of stereo). A file that doesn't fit is
  refused with a message saying what it needs. Removed samples keep their
  memory until the project is reopened.

## Automation

Draw parameter changes over the song: filter sweeps, volume rides, build-ups
and drops. Design notes:
[docs/architecture/automation.md](docs/architecture/automation.md).

- **Lanes.** Click **A** on a track header to show its automation lanes under
  its clips (click again to hide them; this is not saved). Pick what a lane
  drives from **+ Lane**: the track's mixer strip (Fader, Pan, sends, EQ,
  compressor) and, on a synth track, any continuous knob of its rack
  ("Filter · Cutoff"). Switches and choices (mute, solo, on/off, the delay
  division, wave, mode) can't be automated. Each lane header has an on/off
  dot (off: the knob's own value plays) and **×** to remove the lane.
- **Master row.** **+ Master row** (under the timeline) adds a row below the
  last track for the master and the two returns (e.g. "Master · Ceiling",
  "Reverb · Size"). It stays once it has had a lane; **×** hides it.
- **Editing.**
  - Click empty lane space to add a point (snapped to 1/16, **Alt** = free);
    keep the mouse down to drag it into place.
  - Drag a point (or the selection) to move it. Points never pass their
    neighbours and stay in the range.
  - **Shift**-click toggles a point; **Shift**-drag box-selects.
  - **Cmd/Ctrl-drag** draws freehand. The stroke is thinned to a few points
    and replaces the points in the range you drew over.
  - **Double-click** a point to delete it. **Right-click** it for **Linear**
    (a straight ramp to the next point) or **Hold** (keep the value, then
    jump: drops and stutters), or Delete.
  - A tooltip shows the value under the pointer in the knob's units.
  - Lane keys (lane focused): **Delete** removes the selected points,
    **Cmd/Ctrl+A** selects all, **←/→** nudge a 1/16 (**Shift**: a beat),
    **Esc** cancels a drag or clears the selection.
  - Each gesture (a click, a drag, a stroke) is one undo step.
- **Song mode only.** Lanes play in Song mode (the song playing, or stopped
  at the song position after it ran). In Pattern mode you can still edit them (the header says
  "SONG only"), but the knobs keep their own values.
- **Knobs and faders follow.** In Song mode an automated knob's ring (a
  fader's cap) moves with its lane; a small tick shows the knob's own value
  and an **A** badge marks it. Grab it to take over: your move is heard at
  once and holds until the lane's next point (the knob and its lane turn
  grey meanwhile), and it changes the knob's own value (undoable). While the
  lane plays, the value readout shows what you hear in *italics*; the
  knob's own value is in its tooltip. Arrow keys step from what you hear. In
  Pattern mode a move is just a move.
- **Automate.** Right-click a knob or fader (or press the menu key /
  **Shift+F10** on it) for **Automate** (adds its lane) or **Show
  automation**: the lane opens on the timeline (the Master row for
  the master and the returns). Switches and choices don't offer it.
- **MIDI learn.** The same menu has **MIDI learn**: then move a knob on your
  MIDI controller and it moves that control from now on (a small **CC** tag
  marks it; **Forget MIDI (CC 74)** in the menu unbinds it; Esc cancels
  learning). Saved with the project; a sweep is one undo step.
- Removing a rack module or a track removes its lanes too; undo brings them
  back.

Limits: 64 lanes per project, 512 points per lane.

## Mixer

The bottom panel's **Mixer** tab shows one strip per track, the **Reverb** and
**Delay** returns and the **Master**. Design notes:
[docs/architecture/mixer.md](docs/architecture/mixer.md).

1. **Strips.** Track colour and name (click to select the track; the mixer
   stays open), **M** / **S**, a fader with a dB readout (up to +6 dB), pan, a
   stereo peak meter (peak-hold line; click the clip light to reset) and
   collapsible **EQ** and **Comp** sections. Selecting a track in the timeline
   switches back to its editor.
2. **Sends.** Two send knobs per strip, **Reverb** and **Delay**. They tap
   after the fader; the **post/pre** button beside a send taps before it, so
   the send level stays when you pull the fader down. A muted or soloed-out
   track sends nothing new (tails still ring out). The Delay return's
   **Time** is a tempo-synced note length, at most 2 s; a longer one plays at
   2 s and the strip shows "(max 2 s)".
3. **Sidechain pumping.**
   1. Put a kick on a drum row with a four-on-the-floor pattern.
   2. Add a synth track playing a held chord (Pad or Chord Stab).
   3. Expand the synth strip's **Comp** and switch it on.
   4. In **Sidechain**, pick the kick row (shown as "SC: Drums · kick").
   5. Lower **Threshold** until the gain-reduction meter dips on every kick;
      raise **Ratio** (4–8) for a deeper duck; shorten **Release** to let the
      pad swell back before the next kick.
   Up to 8 distinct drum rows can be sidechain keys at once.
4. **Master limiter.** **Ceiling** (default −0.3 dB) and a **Limiter GR**
   readout; the output never goes above the ceiling. The master light turns
   amber (**LIMIT**) when the limiter takes more than 1 dB and red only when
   the output reaches the ceiling (click to reset).
5. **Gain staging.** Keep strips peaking around −12 to −6 dB and let the
   limiter catch only the odd peak; if Limiter GR sits above 3–4 dB, pull some
   faders down. Centre pan is unity; a hard pan is +3 dB on one side.

## Seeing the sound

Design notes and measured costs:
[docs/architecture/visuals.md](docs/architecture/visuals.md). Everything
here only looks: none of it changes what you hear or what is saved.

- **Scope** (a rack module: **+ Add module ▸ Utility ▸ Scope**). Patch
  anything into **A** (orange) and **B** (cyan): an oscillator, the VCA's
  output, an envelope, an LFO. Poly cables are summed, as the Out would hear
  them. **Time/div** sets the window (0.1–100 ms per division); **Trigger
  Auto** locks a periodic wave to its rising zero crossing (*no trig* in the
  corner means nothing crossed: it free-runs), **Free** just scrolls. For
  slow things (LFOs, envelopes, a whole bar) switch **Sync** on and pick a
  **Division**: while playing, the screen shows exactly one division, on the
  beat. **Gain A/B** scale the traces (▲/▼ when one goes off screen), **XY**
  plots A against B, and a click freezes the picture. Up to 8 Scopes in the
  whole project (the add menu says "All 8 scopes in use"); adding, cabling or
  removing one never clicks. Scopes live in synth racks; for a drum or
  audio track use the analyser.
- **Analyser** (Mixer tab, right of the Master). A spectrum of the Master
  with peak-hold dots, a goniometer (mono is a vertical line, wide stereo a
  cloud) and a correlation bar (+1 mono, 0 wide, −1 out of phase: trouble on
  a mono club system). **∿** on any strip shows that strip's spectrum
  instead; press it again (or **Master**) to go back. Hover the spectrum for
  the frequency, the nearest note and the level ("55 Hz · A1 · −8.2 dB"):
  handy for tuning a kick to the bass. Which strip is shown is not saved and
  not an edit.
- **Top bar spectrum.** A small Master spectrum beside the CPU pill; click
  it to open the mixer.
- **Waveforms.** The Clip tab shows the clip from the whole file down to
  single samples (see *Audio tracks*); **≈** on a drum row shows that row's
  sample under the grid (zoom the same way; no playhead or trim markers,
  rows have no such settings yet).
- **Shape previews.** ADSR and LFO modules draw their shape above the knobs
  and say the times ("5ms·200ms·70%·300ms", "2.00 Hz · 500 ms" or "1/4 ·
  500 ms" when synced). The ADSR's time axis is squeezed (√t) so a 1 ms
  attack is visible beside a 4 s release; the label has the real times. A
  dashed curve shows the softest note when **Velocity** is up. Automation
  moves them too.
- **Voice LEDs.** In the Instrument tab's bar, one LED per voice of the
  patch: lit with the voice's level, ringed while its key is held. Three
  notes of a chord light three LEDs; a voice still ringing after release
  stays lit until it fades.
- **Cost.** All of it together stays under 2 % of the main thread while a
  big mix plays, draws at most 60 times a second, stops in a hidden tab and
  off screen, and stops entirely once the app is stopped and silent.

## Save, open and export

Design notes: [docs/architecture/projects.md](docs/architecture/projects.md),
[docs/architecture/export.md](docs/architecture/export.md).

A project is a folder:

```
My Song/
  project.json      tracks, patterns, racks, mixer, tempo…
  samples/          the original sample files, byte for byte
```

Click the project name at the top left for the **Project** menu: **New**,
**Open…** (**Cmd/Ctrl+O**), **Save** (**Cmd/Ctrl+S**), **Save As…**
(**Shift+Cmd/Ctrl+S**) and **Export WAV…**. Chrome asks for a folder the first
time you save.

- **● unsaved** next to the name marks unsaved edits; it goes away on Save, or
  when undo brings the project back to the saved state.
- **New** and **Open…** ask in the menu before discarding unsaved changes.
  Save As into a folder that already holds a project asks "Replace the project
  in …?" first. Closing the tab with unsaved changes to a saved project asks
  too (Chrome's own "Leave site?").
- **Autosave** runs a few seconds after you stop editing, into the browser's
  private storage (not your folder). After a crash or a closed tab, the next
  start offers **Restore last session** or **Start fresh**. A restored session
  is still unsaved and has no folder until you save. Only one tab autosaves;
  a second one says "Autosave is off — this project is open in another tab".
- There is no Cmd/Ctrl+N (Chrome keeps it): use Project ▸ **New**.

**Export WAV…** renders the song (Song mode, from the start to the end of the
last clip plus a 2 s tail) to a 24-bit stereo WAV at the project's sample
rate, named `<project name> <YYYY-MM-DD>.wav`. Chrome asks where to save; a
banner shows progress with **Cancel**. The metronome is never in the export
and the loop is ignored. It renders in the background faster than real time
with the same engine you hear, so you can keep working (it exports the
project as it was when you clicked). A song without clips says so instead of
writing an empty file.

## Library

The **Browser** pane is one library for every project. Click **Choose library
folder…** once (any folder; sub-folders open as you browse them). **↻**
rescans the folder.

Below it, always, is the built-in **Starter kit** (read-only; click its
header to fold it): two kicks, clap, snare, rim, closed and open hats,
shaker, tom, two chord stabs and a sub hit, synthesised by
`scripts/make-starter-kit.mjs` and dedicated to the public domain (CC0 1.0,
`samples/starter/LICENSE.txt`). The sounds are part of the app (bundled
with the build), and a new project's drum track is made of them. They
preview and drag like library samples.

- Click a sample (folder or kit) to preview it. The preview bar under the
  library header is always there, so nothing moves; **■ Stop** stops. Big files
  stream instead of loading into memory. Up to 2000 entries per folder are
  listed.
- Drag a sample onto a drum row, onto **+ Add row**, onto a **Sample
  Player** module, or onto the timeline (an audio track, or below the
  tracks for a new one). It is copied into the project (Save writes it to
  `samples/`), so projects stay self-contained.
- **Patches** lists the patches saved with **Save patch**; load them from a
  synth track's **Patch** dropdown.
- After a browser restart Chrome may withdraw access to the folder: the pane
  shows **Reconnect folder**; one click grants it again. If the folder moved,
  use **Choose another folder…**.

## Undo and redo

**↶** / **↷** in the top bar (hover for what they undo, e.g. "Undo Move
notes"), **Cmd/Ctrl+Z** and **Shift+Cmd/Ctrl+Z** (or **Ctrl+Y**). Everything
saved in the project is undoable: steps, notes, clips, patterns, racks,
cables, knobs, mixer settings, tempo, adding and removing tracks. One drag is
one step; one recording pass is one step. Selecting a track or pattern is not
an edit. In a text field the keys undo the text instead. Up to 200 steps;
opening or starting a project clears the history. Design notes:
[docs/architecture/history.md](docs/architecture/history.md).

## Shortcuts

Global shortcuts are ignored while you type in a text field (Save and Open
still work there).

| Key | Action |
|---|---|
| **Space** | Play / Stop: the pattern while focus is in the bottom panel (a step cell, the piano roll, a panel button…), the song otherwise. In a text field or a select, Space types / opens it |
| **A S D F G H J K L** / **W E T Y U O** | Keyboard piano: white / black keys |
| **Z** / **X** | Octave down / up (also the top bar's **−** / **+** or the wheel over **Oct**; remembered) |
| **R** | Record arm |
| **Alt+1** … **Alt+6**, **F6** … **F9** | Bottom-panel tab: Alt+1..6 Step grid / Piano roll / Acid / Instrument / Mixer / Clip; F6..F9 Step grid / Piano roll / Instrument / Mixer (Acid and Clip have no F-key; F10 is the browser's menu key). A tab that doesn't fit the selected track shows a hint instead |
| **Cmd/Ctrl+Z** | Undo |
| **Shift+Cmd/Ctrl+Z**, **Ctrl+Y** | Redo |
| **Cmd/Ctrl+S** | Save |
| **Shift+Cmd/Ctrl+S** | Save As… |
| **Cmd/Ctrl+O** | Open… |
| **Esc** | Cancel a drag (cable, knob, note, clip, loop) or a keyboard cable pick-up; close a menu or confirmation |
| **Enter** | On a focused step cell: toggle it. On a focused jack: pick up / connect |
| **Delete** / Backspace | Piano roll, timeline: delete the selection. Picked-up cable: unplug |
| **Right-click** | Piano roll: delete that note. Step grid: clear that step |
| **Q** | Piano roll: quantize |
| **Cmd/Ctrl+A** | Piano roll, timeline: select all |
| **Cmd/Ctrl+D** | Timeline: duplicate the selection |
| **Cmd/Ctrl+E** | Timeline: split the selected clips at the playhead / song position |
| **← →** | Piano roll: move by a grid cell. Timeline: nudge a beat (**Shift**: a bar) |
| **↑ ↓** | Piano roll: transpose a semitone (**Shift**: an octave) |
| **Alt** (while dragging) | No snap (piano roll, clips); Alt-click a step: ghost note |
| **Shift**-drag | Box select (piano roll, timeline) |
| **Cmd/Ctrl+wheel** | Zoom (piano roll, timeline) |

## Troubleshooting

**Playing feels late with Bluetooth headphones.** Bluetooth adds 100–300 ms
that no setting can remove. The **⚙** button in the top bar shows the total
output latency (amber above 40 ms) and opens the audio settings, which say
"High output latency — Bluetooth headphones?" when that is likely. For playing
live, use wired headphones or speakers. Recording still lands on the beat (see
[Recording](#recording)); fine-tune with **Offset** if needed.

**Crackles or dropouts.** The top bar's **CPU** readout turns red when audio
blocks were missed. Open **⚙** and pick a larger **Latency**: **Balanced** or
**Playback (most stable)**, or **Custom…** with a buffer in ms, then
**Apply**. Applying restarts audio and stops playback; the project stays as it
is. The panel shows what the browser chose (sample rate, base and output
latency).

**MIDI keyboard does nothing.** Chrome asks for MIDI permission the first time;
the **MIDI:** pill in the top bar shows the state. If it says "blocked", allow
MIDI in Chrome's site settings (the icon left of the address bar ▸ Site
settings ▸ MIDI devices) and reload. "no device": plug the keyboard in; it is
picked up without a reload. "unsupported": use Chrome. Notes play the track
shown after **Keys →**; select a synth track first. All MIDI channels are
heard (omni).

**"Sample limit reached".** A session can load 256 samples (every drop uses
one, even a replacement). Save, then Project ▸ **Open…** the project again (or
reload) to start counting from what it uses.

**"Audio engine stopped".** The engine hit an error; click **reload** in the
red top-bar message. After the reload, autosave offers **Restore last
session** if there were unsaved edits.

**The library says "Reconnect folder".** Chrome withdrew folder access after a
restart; click it to grant access again.

## Development

- `npm test`: `svelte-check` (types and Svelte warnings, fails on either),
  Rust tests (`cargo test --workspace`), the engine build, then Vitest.
  Vitest also runs from `app/` (`app/vitest.config.ts` reuses the root
  config).
- `npm run build:engine`: builds `app/public/engine.wasm`.
- `npm run dev`: engine + Vite on http://localhost:5174 (cross-origin
  isolated: COOP/COEP headers set).
- `npm run preview`: production build + preview on the same port.
- `npm run test:e2e`: Playwright (`npx playwright install chromium` once). It
  reuses a server already on :5174, else starts `npm run preview`. The
  `serial` project (real-time and CPU assertions) runs after the rest, in one
  worker. Playwright runs dependency projects once, so `--repeat-each`
  repeats only `serial` (`chromium` is its dependency); to repeat everything
  run `--project=chromium --repeat-each=3` and then
  `--project=serial --no-deps --repeat-each=3`.
- Follow-ups and decisions per plan: [docs/followups/](docs/followups/).
- Sampler track: "+ Sampler track" on the timeline (drop a sample on it) makes a synth track on the Sampler patch; see [docs/architecture/modular.md](docs/architecture/modular.md#sampler-patch).
- Drum pads from the MIDI keyboard (or the computer keyboard, from the octave's C): select a drum track and MIDI notes 36 (C2) and up play its rows 1–16 live, velocity-scaled, and record into steps while armed; see [docs/architecture/sequencer.md](docs/architecture/sequencer.md#live-drum-input).
