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
[Recording](#recording) · [Piano roll](#piano-roll) ·
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
  **Piano roll** or **Instrument** for synths) and the **Mixer** tab.

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
4. Press **Space** to play. The outlined column is the playhead. Change the
   tempo in **BPM** (type a value, then Enter) and try **Metro** (the
   metronome).

Click a row's name to hear its sample (the Browser's preview bar shows it,
with **■ Stop**; click the name again to stop). Each row has **M** (mute),
gain and pan. Under the grid: **Steps** (16, 32 or
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
which synth track the keys play: the selected synth track or, while a drum
track is selected, the synth track selected last.

The **Instrument** tab shows the track's rack: module panels joined by cables.
Design notes: [docs/architecture/modular.md](docs/architecture/modular.md).

- **Patch** loads a starter patch (Deep Bass, Chord Stab, Pad, Lead, Pluck)
  or one you saved to the library, replacing the rack. After any edit
  **(edited)** appears; **revert** reloads the patch. Loading over edits asks
  first (an inline "Discard your edits…?" under the control).
- **Save patch** stores the rack in the library folder's `patches/` (it needs
  a library folder, see [Library](#library)); it then shows in **Patch**.
- **Knobs:** drag up or down (Shift = fine), double-click for the default, or
  focus and use the arrow keys. The value is shown under the label. Choice
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
and offset, handy for scaling a CV) and the **Sample Player** (plays a project
sample, optionally pitched from the keys; follow it with an ADSR and a VCA for
gated notes; drop a sample on its panel). Delay, Reverb and Chorus share
memory across the project: at most 8 delays, 8 reverbs and 16 choruses over
all tracks. When a bank is full the menu greys the module out ("All 8 delays
in use").

Poly patches (Chord Stab, Pad, Pluck) are about 9 dB quieter than the mono
ones (Deep Bass, Lead) so chords don't clip: raise their faders in the mixer.

## Recording

1. Select a synth track (its name shows after **Keys →**).
2. Arm with **R** or **● Rec** (it turns red). **Count-in** gives one bar of
   clicks before recording starts.
3. Press **Space**. What you play is recorded into the track's current
   pattern, which loops; each loop overdubs. A note with the same pitch and
   start as one already in the pattern is not written again, so playing a
   part twice never stacks hidden duplicates. The sustain pedal works.
4. **↶ Take** undoes the last recording pass (one pass is one undo step).

Recording works in **PAT** mode only. Switching the Keys track or the pattern
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

## Patterns and song

Design notes: [docs/architecture/arrangement.md](docs/architecture/arrangement.md).

- **Patterns.** Each track has up to 16 patterns. The picker above the editor
  has **+ New**, **Duplicate**, **Rename** and **Delete** (a pattern used by
  clips, or a track's last one, can't be deleted). The selected one is the
  track's *current* pattern.
- **PAT / SONG** (top bar, or **Shift+L**): PAT loops each track's current
  pattern; SONG plays the timeline.
- **Clips.** Click an empty spot in a track's lane to place its current
  pattern there. Drag a clip's body to move it (beat snap, **Alt** = free),
  its right edge to repeat or cut it (dashed lines mark repeats), its left
  edge to trim. **Double-click** a clip to edit its pattern below.
  **Right-click** for **Make unique** (its own copy of a shared pattern) and
  Delete. Clips stay on their own track.
- **Timeline keys** (lanes focused): **Delete** removes, **Cmd/Ctrl+D**
  duplicates, **Cmd/Ctrl+A** selects all, **←/→** nudge a beat (**Shift**: a
  bar), **Esc** cancels a drag or clears the selection; **Shift**-drag box
  selects. Wheel scrolls tracks, Shift+wheel scrolls time, Cmd/Ctrl+wheel
  zooms; the slider under the lanes scrolls time too.
- **Ruler.** Click it to set the song position. Drag on it to set a loop of
  whole bars (it turns **Loop** on); **Loop** toggles it in SONG mode. While
  playing, the new loop takes effect when you release. Stop returns to the
  loop start, else to where you started.
- After the last clip, SONG keeps playing (silence) until you stop.
- Each track's **×** (on hover) removes it after an inline confirmation.

Limits: 16 patterns and 256 clips per track, 999 bars.

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

**Export WAV…** renders the song (SONG mode, from the start to the end of the
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
- Drag a sample onto a drum row, onto **+ Add row**, or onto a **Sample
  Player** module. It is copied into the project (Save writes it to
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
| **Space** | Play / Stop |
| **A S D F G H J K L** / **W E T Y U O** | Keyboard piano: white / black keys |
| **Z** / **X** | Octave down / up |
| **R** | Record arm |
| **Shift+L** | PAT / SONG |
| **Alt+1** … **Alt+4**, **F6** … **F9** | Bottom-panel tab: Step grid / Piano roll / Instrument / Mixer. A tab that doesn't fit the selected track shows a hint instead |
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
