# House DAW

A browser DAW: a Rust audio engine compiled to WASM and hosted in an
AudioWorklet, with a Svelte 5 UI. Design:
[docs/superpowers/specs/2026-11-06-daw-design.md](docs/superpowers/specs/2026-11-06-daw-design.md).

## Prerequisites

- Rust with the WASM target: `rustup target add wasm32-unknown-unknown`
- Node 26 and npm
- Chrome (desktop, macOS); e2e uses `npx playwright install chromium`

## Commands

- `npm install`
- `npm test` — Rust unit tests (`cargo test --workspace`) + Vitest
- `npm run build:engine` — builds `app/public/engine.wasm`
- `npm run dev` — builds the engine, serves on http://localhost:5174
  (cross-origin isolated: COOP/COEP headers set)
- `npm run preview` — production build + preview on the same port
- `npm run test:e2e` — Playwright

## First loop in 60 seconds

1. `npm run dev`, open http://localhost:5174, click **Click to start audio**.
2. Drag a kick from Finder onto the first row (it says "drop sample"; the row
   takes the file's name). No samples yet? Use the starter kit in
   `samples/starter/` (open it with `open samples/starter`): two kicks, clap,
   snare, rim, closed/open hats, shaker, tom, two chord stabs and a sub hit.
   It is synthesised by `scripts/make-starter-kit.mjs` (original sounds, CC0),
   so you can tweak the recipes and re-run the script. Drag a hat onto the second row. Dropping on a row
   that already has a sample replaces it; dropping on **+ Add row** makes a new
   row for it.
3. Click cells to place steps (click-drag paints; Alt-click = quiet ghost
   note, shown dimmer). For four-on-the-floor tick steps 1, 5, 9, 13 on the
   kick; put the hat on 3, 7, 11, 15 for off-beats.
4. Press **Space**. The white-outlined column is the playhead. Tempo defaults
   to 124 BPM; try the metronome and change tempo while playing (it should not
   click). Dropouts in the top bar should stay 0.

Notes: only audio files are accepted (wav, aif, mp3, flac, ogg, m4a); a
failed drop shows a dismissable red banner and changes nothing. If you drop a
very large sample while playing, it loads when you stop (yellow notice). Up to
256 sample loads per session (every drop uses one, even onto a row that already
has a sample; reload to start over). The 2 ms fade-out applied to each sample's tail
avoids clicks from samples that don't end at zero.

## Synth tracks: the rack (Instrument tab)

**Play a synth**: click **+ Synth track**, then play with the computer
keyboard (A-row = white keys, W/E/T/Y/U = black; **Z / X** change octave, shown
as "Oct" in the top bar) or a MIDI keyboard. Chrome asks for MIDI permission
the first time; the "MIDI:" pill shows the state. Notes go to the selected
synth track (selecting drums keeps the last synth). Design notes:
`docs/architecture/modular.md`.

**+ Synth track** adds a track with the *Deep Bass* patch; the bottom panel
shows its rack (code: `app/src/ui/rack/`).

- **Patch** dropdown loads a starter patch (Deep Bass, Chord Stab, Pad, Lead,
  Pluck), replacing the rack. After any edit "(edited)" appears; **revert**
  reloads the patch. Loading over edits asks before discarding them.
- **Knobs**: drag up/down (150 px = full range; Shift = fine), double-click =
  default, or focus and use the arrow keys (1% steps). The value is always
  shown under the label. Choice params (wave, filter mode…) are segmented
  buttons (arrow keys move the selection).
- **Cables** are coloured by signal: audio blue, pitch orange, gate green,
  CV purple. Drag from an output to an input to patch (an input takes one
  cable; a new one replaces it). Grab a cable by its *input* end to move it
  to another input, or drop it anywhere else to unplug it. You can also drag
  from an empty input to an output. Escape cancels a cable or knob drag.
- **+ Add module** (grouped by category; up to 32 modules) and the × on a
  module header to remove it.

## Record a bassline

1. Click **+ Synth track** (opens the piano roll). Play with the computer keys
   (A-row) or a MIDI keyboard.
2. Arm recording with **R** or the **● Rec** button (it turns red). Turn on
   **Count-in** for one bar of clicks before recording starts (off by default).
3. Press **Space**. Notes you play are recorded into the track's pattern, which
   loops; later passes overdub. **Undo take** removes exactly what the last
   pass added.
4. Edit in the piano roll: click to draw, drag to move, drag the right edge to
   resize, **Alt** turns snapping off, **Q** quantizes (selection, or all
   notes), Delete removes. Grid size and pattern length are in its toolbar.

**Bluetooth headphones** add ~150-250 ms of delay. Recording maps your key
presses to what you *heard* (via `getOutputTimestamp`), so notes land on the
beat anyway. If it still feels early or late, adjust **Rec offset** (ms, in the
top bar; positive = notes land earlier). Playing live still feels delayed;
wired headphones or speakers fix that. Design notes:
`docs/architecture/sequencer.md`.

## Mix

Design notes: `docs/architecture/mixer.md`.

1. **Mixer tab.** The bottom panel's **Mixer** tab shows one strip per track,
   the **Reverb** and **Delay** returns and the **Master**. Each strip has the
   track colour and name (click it to select the track; the mixer stays open),
   M / S, a fader with a dB readout, pan, a stereo peak meter (peak-hold line,
   clip light: click to reset) and collapsible **EQ** and **Comp** sections.
   Selecting a track from the timeline's track list leaves the mixer for that
   track's editor.
2. **Sends.** Each track has two send knobs, **Reverb** and **Delay**
   (Off .. 0 dB). They tap *after* the fader; the **post/pre** button beside a
   send makes it tap *before* the fader, so the send level stays when you pull
   the fader down. Muting or soloing out a track also stops its sends (the
   effect tails still ring out). The Delay return's **Time** is a note length
   synced to the tempo, at most 2 s: a longer one (1 bar below 120 bpm, 1/2
   below 60 bpm) plays at 2 s, and the strip shows "(max 2 s)".
3. **Sidechain pumping, step by step.**
   1. Put a kick on a drum track's row and make a four-on-the-floor pattern.
   2. Add a synth track (a pad or chord patch) playing a held chord.
   3. In the mixer, expand the synth strip's **Comp** and switch it **on**.
   4. In **Sidechain**, pick the drum track's kick row (shown as
      "SC: Drums · kick").
   5. Lower **Threshold** until the strip's gain-reduction meter dips on every
      kick; raise **Ratio** (4-8) for a deeper duck, shorten **Release** to
      let the pad swell back before the next kick.
   Up to 8 distinct drum rows can be sidechain keys at once.
4. **Master limiter.** The Master strip has a **Ceiling** knob (default
   -0.3 dB) and a **Limiter GR** readout: the output never goes above the
   ceiling. The master light turns amber (LIMIT) when the limiter works hard
   (more than 1 dB of reduction) and red only when the output actually
   reaches the ceiling; click it to reset. The limiter delays the output by
   1.5 ms; the playhead and recording take that into account.
5. **Gain-staging tips.** Poly patches (Chord Stab, Pad, Pluck) are about 9 dB
   quieter than the mono ones (Deep Bass, Lead): raise their faders (up to
   +6 dB) instead of lowering everything else. Keep meters peaking around
   -12 .. -6 dB on the strips and let the limiter only catch the occasional
   peak; if GR sits above 3-4 dB, turn some faders down. The pan law keeps
   centre at unity and gives +3 dB at a hard pan.

## Arrange a song

Design notes: `docs/architecture/arrangement.md`.

1. **Patterns.** Every track has patterns (up to 16): use the picker above the
   step grid / piano roll (**+ New**, **Duplicate**, **Rename**, **Delete**).
   The one selected is the track's *current* pattern; in **PAT** mode it simply
   loops, as before.
2. **Clips.** Click an empty spot in a track's lane in the timeline (top
   centre) to place its current pattern at that bar; drag the clip's right edge
   to repeat it (dashed lines mark each repeat) or cut it. Drag the body to
   move (beat snap, **Alt** = free), the left edge to trim. Clips stay on
   their own track. **Double-click** a clip to edit its pattern below.
   **Right-click** a clip for **Make unique** (own copy of a shared pattern, so
   edits don't change the other clips) and Delete.
3. **PAT / SONG.** The toggle in the top bar (or **Shift+L**) switches between
   looping each track's current pattern and playing the timeline. Click the
   ruler to set the song position; in SONG press **Space**. Recording is
   disabled in SONG.
4. **Loop.** Drag on the ruler to loop whole bars (turns **Loop** on); the
   Loop button toggles it (SONG only). Stop returns to the loop start, else to
   where you started.

Timeline keys (while its lanes are focused): **Delete** removes, **Cmd/Ctrl+D**
duplicates, **Cmd/Ctrl+A** selects all, **← / →** nudge a beat (**Shift**: a
bar), **Escape** cancels a drag / clears the selection, **Shift-drag** box
selects. Wheel scrolls tracks, **Shift+wheel** scrolls time, **Cmd/Ctrl+wheel**
zooms; the slider in the footer scrolls time too. Limits: 16 patterns and 256
clips per track, 999 bars.

## Save, open, autosave

Design notes: `docs/architecture/projects.md`.

A project is a folder. Click the project name at the top left (it starts as
"Untitled") for the menu: **New**, **Open…**, **Save**, **Save As…**
(**Cmd/Ctrl+S**, **Shift+Cmd/Ctrl+S**, **Cmd/Ctrl+O**). Chrome asks you to pick
a folder:

```
My Song/
  project.json      tracks, patterns, rack patches, mixer, tempo…
  samples/          the original sample files, byte for byte
```

A **● unsaved** mark appears next to the name after any edit and goes away on
Save (or when edits bring it back to the saved state). New and Open ask
before discarding unsaved changes. Save As into a folder that already holds a
project asks "Replace the project in …?" first.

**Autosave** runs on its own a few seconds after you stop editing, into the
browser's private storage (not your project folder). After a crash or a closed
tab, the next start shows **Restore last session** / **Start fresh** above the
editors. A restored session is still "● unsaved" and has no folder yet; Save
asks for one. Autosave works in one tab at a time: a second tab shows
"Autosave is off — this project is open in another tab".

## Your sample library

The **Browser** pane shows one library for every project. Click **Choose
library folder…** once (any folder; sub-folders are browsed lazily) or **Use
starter kit** for the bundled sounds. Click a sample to preview it; big files
stream instead of loading into memory. **↻** rescans the folder.

After a browser restart Chrome may withdraw access to the folder: the pane then
shows **Reconnect folder**; one click grants it again. Same if the folder was
moved or deleted (use **Change folder…**).

Drag a sample onto a drum row, onto **+ Add row**, or onto a **Sample Player**
module in the rack. It is copied into the project (the **Save** copies it into
`samples/`), so projects stay self-contained. **Save patch** in the Instrument
tab stores the rack as `patches/<name>.json` in the library; it then shows up
in the **Patch** dropdown.

## Effects in the rack

**+ Add module** in the Instrument tab lists the effects (grouped by category): **Delay**
(tempo-synced, up to 2 s), **Reverb**, **Chorus**; plus **EQ** and
**Compressor** (sidechain input included), **Saturator** (*Shaping*) and
**Attenuator** (*Utility*: level and offset, handy for scaling a CV), and the
**Sample Player** (*Source*: plays a project sample, optionally pitched from the
keys; follow it with an ADSR + VCA for gated notes).

Delay, Reverb and Chorus use memory shared by the whole project: at most **8
delays, 8 reverbs and 16 chorus** in total over all tracks. When a bank is full
the menu greys the module ("All 8 delays in use"). Design notes:
`docs/architecture/modular.md`.
