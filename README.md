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
