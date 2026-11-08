# UI theme (tokens, depth, native-control skins)

The redesign spec (`docs/superpowers/specs/2026-11-14-redesign.md` §2–§3) holds
the approved values; this page says where they live in code and how to use
them.

## Files
- `app/src/ui/theme.css`: the `:root` tokens, the native-control skins and the
  shared classes. Imported once from `main.ts`, after the fonts.
- `app/src/ui/theme.ts`: the same tokens as values (`THEME`, `RADII`,
  `TRACK_COLORS`, `CATEGORY_COLORS`, `SIGNAL_COLORS`) for code that can't read
  a CSS variable: canvas drawing, SVG built in script, colour maths.
- `app/src/state/palette.ts`: the track palette. It lives in `state/` because
  new tracks take their colour from it and state must not import `ui/`;
  `ui/theme.ts` and `state/project.svelte.ts` re-export it.
- `app/src/ui/theme.test.ts`: parses `theme.css`'s `:root` block and checks it
  against `theme.ts` in both directions.
- `app/src/ui/noHexColors.test.ts`: the hex guard (below).

## Tokens

| Group | CSS | `theme.ts` |
|---|---|---|
| Surfaces | `--top --panel --work --raised --well --lcd --line --grid` | `THEME.top` … `THEME.grid` |
| Text | `--text --text-2 --text-dim` | `THEME.text`, `.text2`, `.textDim` |
| Accents | `--play --accent --rec --on-color` | `THEME.play`, `.accent`, `.rec`, `.onColor` |
| Depth | `--raised-shadow --gloss --well-shadow --lift --drop --handle --handle-shadow` | `THEME.raisedShadow` … |
| Radii | `--r-xs` 3 · `--r-sm` 6 · `--r-md` 8 · `--r-lg` 12 · `--r-menu` 10 | `RADII.xs/sm/md/lg/menu` (numbers) |
| Type | `--font-ui --font-mono --fs-body` 13 · `--fs-ctl` 12 · `--fs-lbl` 10 · `--fs-xs` 9 · `--fs-tag` 8 | `THEME.fontUi` … |
| Data | `--track-0..7`, `--cat-<category>`, `--sig-<signal>` | `TRACK_COLORS`, `CATEGORY_COLORS`, `SIGNAL_COLORS` |

`THEME` keys map to CSS names by `tokenName` (`textDim` → `--text-dim`,
`text2` → `--text-2`). Change a value in both files; the test fails otherwise.
Keep the `:root` block to custom properties only, and keep it the only
`:root` block (`theme.test.ts` checks both: it reads only the first).

Beyond the spec's values (plan 20 Task 11, for the literals the review found):
- `--r-xs` (tags and badges, ~10 px tall) and `--r-menu` (menus, popovers and
  the select picker: the spec's 10 px). A radius that is half the element's
  height (a pill end, a 6 px groove's 3 px, a circle) is geometry and stays
  a literal.
- `--fs-xs` (captions: jack names, meter scales, step values) and `--fs-tag`
  (the A / CC badges). Sizes outside the five (the 11 px in older toolbars,
  the 18 px tempo, the 32 px timer) are still literals in their components.
- `--drop` (`0 2px 4px rgba(0,0,0,.3)`): the board's small drop under an on
  step cell, for a raised thing that has no recipe of its own.

Rules of use:
- `--text-dim` only on `--well` and `--lcd`; on `--panel` use `--text-2`.
- Text on any vivid colour (accent, play, a track colour) is `--on-color`.
- Never `--play`, `--accent` or `--rec` as text or an icon on `--raised`
  (1.7–2.8:1, under WCAG's 4.5:1 for text and 3:1 for icons). A warning or
  status puts the colour in a fill instead: the vivid colour under
  `--on-color` text (the top bar's red dropout / MIDI-blocked pill, the
  orange latency pill, an armed Rec, a playing ▶), a light mix of the colour
  with `--text` for an icon (an idle ▶: `--play` 55% / `--text`, 3.3:1), or
  an LED dot beside a `--text` label (Rec; the dot's `--on-color` ring keeps
  it 3:1 from the button).
- Idle, active, disabled (both transports, the icon buttons): **idle**
  (enabled, not running) is a normal raised button (`--raised`, gloss,
  raised shadow) with a coloured or `--text` icon, never dimmed; **active**
  is the vivid fill with an `--on-color` icon and a glow; **disabled** is
  flat (no gloss, no shadow), 40% opacity, `cursor: not-allowed`. A Stop
  stays enabled while nothing plays (a no-op) so the idle transport reads
  as ready. (`--text` on
  `--raised` itself is 4.07:1, a palette question raised with the owner.)
- Track, category and signal colours are **data**: a component gets them from
  state or `theme.ts` and passes them in as `--c` (`style:--c={color}`).
- `CATEGORY_COLORS` and `SIGNAL_COLORS` use the spec's keys verbatim. The
  catalog's categories (`source/shaping/utility/effect`) and signal kinds
  (`audio/cv/gate/pitch`) map onto them in `theme.ts`: `moduleColor(def)`
  (category map plus per-module overrides) and `jackColor(port)` (pitch is
  cv; a port named `vel` is vel). `docs/architecture/modular.md` ("Look and
  param controls") has the table's reasoning; `theme.test.ts` checks every
  catalog module, category and port gets a colour.
- Canvas code reads colours from `THEME`; a faint shade is a token drawn at
  a low `globalAlpha`, not a new literal (the rack's scope and sample strip).

## Depth recipes
These are the only shadows and gradients. Pick one:
- **Raised** (buttons, pills): `box-shadow: var(--raised-shadow)`, background
  `var(--raised) var(--gloss)` or a vivid colour with the gloss on top:
  `background: var(--c) var(--gloss)`.
- **Well** (slider tracks, inputs, recessed areas): `background: var(--well);
  box-shadow: var(--well-shadow)`, or the `.well` class.
- **Lift** (cards: rack modules, mixer strips; menus and popovers): `box-shadow: var(--lift)`.
- **Drop** (an on step cell): `box-shadow: var(--drop)`.
- **Glow** (on toggles, Play, accents): there is no token, because CSS has no
  variable functions; write it per use as
  `0 0 10px color-mix(in srgb, <colour> 40%, transparent)` (the spec's `<c>66`).
- **Handle** (slider thumb, switch knob): `background: var(--handle);
  box-shadow: var(--handle-shadow)`.

## Fonts
Inter (variable) and JetBrains Mono (400/500/700) are self-hosted through
`@fontsource-variable/inter` and `@fontsource/jetbrains-mono`, imported in
`main.ts`: COEP blocks cross-origin fonts that lack CORP. Both stacks end in
system fonts (`system-ui, sans-serif`; `ui-monospace, monospace`), so a font
that fails to load degrades to the system face. Numbers and readouts use
`--font-mono` (the `.mono` class also turns on tabular figures).

## Native-control skins
Controls stay native (`select`, `input[type=range|checkbox|text|number]`), so
keyboard handling, accessibility and Playwright's `selectOption`/`fill`/`check`
keep working. `theme.css` skins them globally.

**Every rule outside `:root` is wrapped in `:where()`**, pseudo-classes
included (`:where(select:disabled)`, not `:where(select):disabled`), so it has
zero specificity (pseudo-elements add one element's worth). A component's
scoped style wins over a skin property by property, and a component can opt
out of a skin with `appearance: auto`.

- **select**: Chrome's customizable select (`appearance: base-select` on the
  element and on `::picker(select)`). Closed: a `--well` field with the
  `::picker-icon` chevron (rotates while open). Open: a light (`--text`) menu,
  10 px radius, `--lift` shadow; hover is `--text-2`; the checked option is
  `--accent` with `--on-color` text and its `::checkmark` at the row end.
- **range**: `appearance: none`; a 6 px `--well` groove; the fill is `--c` (the
  colour of what the slider belongs to) with the gloss on it; the handle
  recipe (15 px); focus is a 4 px accent glow on the handle. The fill is two
  custom properties the component sets from `ui/rangeFill.ts`:
  `--fill` (the fill layer's width) and `--fill-pos` (its
  `background-position`).
  - `rangeFill(f)` fills from the left end, `rangeFillBipolar(f)` from the
    centre (pan, gains), `rangeFillSpan(a, b)` any span; `f` is the value as a
    fraction of the range. Each returns `{ fill, pos }` as `calc(<a>% + <b>px)`
    strings: `style:--fill={r.fill} style:--fill-pos={r.pos}`.
  - Why not a plain percentage: Chrome moves the handle's centre from 7.5 px
    to `W − 7.5 px`, not 0 to `W`, so `f·W` ends up to 7.5 px off the centre.
    CSS can't multiply a length by a percentage, so the helper does it. A
    restyled thumb passes its width (`TrackVol`'s 10 px).
  - Every range in the app sets `--fill`; unset it is 0 (an empty groove,
    never a misleading half). `--fill-pos` defaults to 0 (a left fill).
  - `--c` defaults to `--accent`; set on an ancestor it applies (it inherits).
    Set `--fill`/`--fill-pos` on the input itself: they inherit too, so on an
    ancestor they would reach every slider inside.
- **checkbox**: a 34×20 switch (`--well` off, `--play` on, the handle as the
  knob, drawn with `::before`).
- **text, search, number, url, email, textarea**: `--well` fields, 8 px radius,
  accent focus ring. Every number input is `NumberField.svelte`'s core, which
  hides the native spinners (its steppers and the vertical scrub replace them).
- **scrollbars**: `scrollbar-color: var(--raised) transparent` on `html`, with
  `color-scheme: dark` for the native bits we don't skin.

### Skinning a new control
1. Start from the tokens: surface, depth recipe, radius, font size.
2. Global skin for a native element → add it to `theme.css` inside `:where()`.
   One-off component styling → the component's own `<style>`, using `var(--…)`.
3. Colour that depends on data → read it from state/`theme.ts` and pass it as
   a custom property (`--c`), never as a literal.
4. Check it in Chrome, including focus-visible and disabled states.

## Controls that move every frame
A control that follows automation or a drag repaints up to 60 times a
second, so its moving parts change only paint-time properties, never layout:
- `Knob` (slider variant): the fill is full width and clipped to its span by
  `clip-path: inset(… round 3px)` (a `scaleX` would squash the round ends);
  the handle moves by `transform: translateX(<pos × 100>cqi)`: the rail is
  an inline-size container, so `cqi` is a percent of the rail.
- `Fader` (mixer): the fill is the slot's full height under
  `transform: scaleY(pos)` from its foot; the cap sits at the bottom and rises
  by `translateY`.

## Selects and the piano keys
Letters are the QWERTY piano, so every `<select>` takes
`onkeydown={selectKey}` (`ui/selectKey.ts`): no type-ahead on printable keys
(Cmd/Ctrl/Alt chords and the navigation keys pass). That is the rack's patch
and sample pickers, choice params, the mixer's sidechain picker, the pattern
picker, the step grid's step count, the piano roll's grid and length, the
Acid tab's length / root / scale, the track headers' "+ Lane" and Settings'
latency. After a pick, `releaseSelect(sel)` gives the keys back:
base-select's picker hands focus back to its select as it closes, after the
change event, so besides the blur a one-shot `focus` listener blurs it again
for 200 ms, plus a check on the next frame. `releaseSelect(sel, to)` focuses
`to` instead (the piano roll's stage, which takes the keys itself).
`ChoiceParam` releases only after pointer picks: a keyboard pick (arrows,
Enter) keeps focus.

## Shared classes
- `.btn` (raised), `.btn.primary` (`--accent`, dark text, glow), `.btn.quiet`
  (outline in `--line`).
- `.seg` (a segmented control on a `--well`), `.tabs` (the bottom panel's
  tabs). The selected child is light (`--text`) with `--on-color` text; it is
  marked by any of `aria-checked="true"`, `aria-pressed="true"`,
  `aria-selected="true"`, `.on` or `.active`.
- `.lbl` (10 px uppercase label), `.mono` (mono, tabular figures), `.well`.

Sizes come from padding and a 16 px line (`.btn` 30 px, `.seg`/`.tabs`
children 26 px), never a fixed `height`, so older markup that already used one
of these class names keeps its own box when it sets its own padding and font.

## Deviations kept on purpose
- `html, body` use `--fs-ctl` (12 px), not `--fs-body` (13 px): the dense
  editors (step grid, piano roll, rack) are laid out for 12 px; at 13 px the
  piano roll loses a row at 1280×720. Titles and body copy opt into
  `--fs-body` where they are (the bottom panel's title, the clip name).
- The skinned `<select>` drops base-select's 24 px minimum height
  (`min-block-size: 0`): dense toolbars would otherwise grow.
- The bottom panel's tabs are 20 px (`padding: 2px 9px` on a 2 px `--work`
  tray), not the board's 30 px: the header must stay one row under 40 px at
  1280 px beside the pattern transport (`layout.spec.ts`).
- Menus come in two looks: a light one like the open select (`AutoMenu`,
  the right-click Automate / MIDI learn menu: `--text`, dark text) and a
  `--panel` card with the lift for popovers with their own controls (the
  Rack's add-module menu, the piano roll's Examples, `InlineConfirm`). Both
  use `--r-menu` / `--r-md` and `--lift`.
- Mixer returns' effect params (Reverb, Delay) stay dials; the Delay's
  12-way division is a skinned select (`ChoiceParam`).

## The hex guard
`noHexColors.test.ts` fails when a `.svelte` file outside its `ALLOWED` list
contains a hex colour literal (`#abc`, `#abcd`, `#aabbcc`, `#aabbccdd`;
comments ignored). `ALLOWED` started as every component that had literals when
the theme landed and shrank with each task of plan 20; the test also fails if
a listed file is already clean, so the list only shrinks. It is empty since
Task 5's fix round moved `App.svelte`, the last one, onto tokens: no
component holds a hex literal. Hex values belong in `theme.css`, `theme.ts` and
`state/palette.ts` only; canvas code reads `THEME` (the piano roll's `C`
palette, the clip tab's waveform overlay) and draws faint shades with
`globalAlpha`.

## The look check
`tests/e2e/look.spec.ts` builds a small song (a drum beat, a bass line, both
on the playlist) and:
- saves the song view, rack, mixer (Delay section open) and piano roll at
  1440×900 to `test-results/look-<view>.png`, for a person to compare with
  the design boards. They are for human review only: nothing compares them
  to a baseline, so a look change never fails the test. Playwright empties
  `test-results/` at the start of a run, so they are this run's;
- asserts the layout invariants, not pixels: no horizontal page scroll at
  1280×800 in any of the four views, and the top bar is one row there (no
  part of it starts below the bottom of the shortest, and it is under
  80 px tall).

`layout.spec.ts` covers the widest top-bar and bottom-panel states at
1024–1440 px.

## NumberField

`ui/NumberField.svelte` replaces bare `<input type="number">` (spec §3). It keeps a real number input (with the `id` / `data-testid`, so `fill` works) and adds steppers and a vertical scrub. `variant="plain"` is a `--well` field with − and +; `variant="lcd"` is the tempo readout (label above, stacked ▲▼). The maths lives in `ui/numberField.ts`.

- A scrub starts after 3 px of vertical travel (a click still focuses the input), moves 1 step per 4 px, Shift = step / 10. Only the display moves; `onchange` fires once on release, so a scrub is one undo entry. Esc or Cmd/Ctrl+Z mid-scrub drops it (`registerDragCancel`).
- In a field that already has focus a press is usually a text selection (`numberField.ts` `pressIntent`):
  - the **select** rule: if the pointer's first clear move is sideways (3 px or more, at least as far sideways as vertical), the press is a text selection: the scrub is dropped for the rest of that press and the browser's own selection carries on;
  - otherwise it scrubs only after 6 px of vertical travel (3 px when the field was not focused).
- Shift+arrow / Shift+button steps by step / 10, but at least the smallest unit the field keeps (`fineStep`: 1 on an integer field, where step / 10 would round back to nothing).
- Arrows step; the wheel steps only while the field is focused (so scrolling a panel never edits a field under the cursor). Enter/blur commits, Esc reverts. `oninput` reports the raw text for live validation (Settings' buffer field).
- Do not wrap a NumberField in a `<label>`: a click on label text would forward to the first button (the − step). Use a `div`.

## Top bar

`ui/TopBar.svelte` (plan 20 Task 5; spec §4; the canvas board "Song view"),
one 64 px `--top` row. The header comment has the details; in short:

| Part | What | Test id |
|---|---|---|
| Menu bar | `ui/MenuBar.svelte` (plan 21): File · Edit · Add · Patterns · View · Options · Help, 12 px text buttons on top of the left block. Each is a button (`aria-expanded`, `aria-controls`) over a popover of plain buttons (no ARIA menu): ↓ / ↑ open it on the first / last item, ↑ ↓ Home End move inside, ← → open the neighbour, Esc closes it and returns the focus to its opener (a document listener that stops the key: MIDI learn stays on), a press outside or Tab out closes it; one open at a time, pointing at another menu button switches. Items show their shortcut and an icon. plan 20's ⋯ items live in File (New … Export WAV…, Undo take, the discard question) and Options (Rec offset) under their old test ids. Help ▸ Keyboard shortcuts is `ui/ShortcutsSheet.svelte`, built from `input/shortcutList.ts` (a unit test keeps it in sync with `shortcuts.ts`). Every popover stays in the DOM, `hidden` while closed | `menu-file` … `menu-help`, `menu-<name>-panel` (+ the old ids); e2e helper `openMenu(page, 'File')` (`tests/e2e/topbar.ts`) |
| Name + hint line | under the menus: project name, `●` when unsaved (a click opens File); under it the flashed hint (`banners.hint`), else the title / aria-label of the control last pointed at anywhere in the app (one `mouseover` listener on the document, `bigTimer.ts` `hintText`), else a static tip | `project-menu`, `project-name`, `hint-line` |
| ↶ ↷ | 32 px raised icon buttons beside the name, under the menus (18 px in the short bar) | `undo`, `redo` |
| Song transport | "Play song" (an aria-pressed toggle, like Space; pressed and glowing while the song plays), "Stop all" (stops either transport), Loop — 44 px, `--r-lg` | `play`, `song-stop`, `loop-toggle` |
| Tempo | `NumberField variant="lcd"`, aria-label "BPM", 0.1 BPM steps with Shift | `tempo` |
| Big timer | `ui/BigTimer.svelte`: bar:beat:tick (32 px mono) + seconds; the heard song position per frame while the song plays, the position inside the shown pattern (label "Pattern") while the pattern transport plays, else the parked song position | `timer`, `timer-pos`, `timer-seconds` |
| Metronome | 32 px icon toggle (`--accent` when on) | — |
| Master | Knob's slider variant on the master channel's `fader` param (curve `fader` = the fader law; `setMix`); automation, MIDI learn and undo as every Knob | `master-volume` |
| Mini spectrum | the master spectrum on an `--lcd` well; opens the Mixer | `topbar-spectrum` |
| Pills | Keys → track and octave; MIDI, CPU, ⚙ latency (opens Settings) | `keys-target`, `octave`, `midi-status`, `cpu`, `settings-button` |

Fit: one row at ≥ 1280 px in the widest state (playing, unsaved, 123
dropouts) with ~25 px to spare (~13 px with the web fonts blocked; the
menu row, 252 px, sets the left block's width), also with the web fonts blocked
(`tests/e2e/topbar.spec.ts`, `layout.spec.ts`). Text that changes has a
fixed box (name, hint, timer digits up to bar 999, the master
readout) or ellipsizes (Keys, MIDI). Below 1280 px the bar may wrap.
Windows under 740 px tall get a 40 px bar (36 px transport, tempo and
timer; the short pills keep 24 px hit areas; the left block is two lines:
the 16 px menu row, then the name, the hint and 18 px ↶ ↷ on one line): the piano roll must still
show C2..C5 at 9 px rows at 1280×720 (`pianoroll.spec.ts`).

Sizing hooks for other components (custom properties, not `:global`):
NumberField's LCD takes `--nf-lcd-h`, `--nf-lcd-w`, `--nf-lcd-pad`; Knob's
slider takes `--slider-min-w` (default 112 px).

## Icons (Phosphor)
Icons come from `phosphor-svelte` (MIT, Svelte 5), drawn through
`app/src/ui/Icon.svelte`.

- **Add one:** import the per-icon component and hand it to `Icon`:
  `import Play from 'phosphor-svelte/lib/Play';` then
  `<Icon icon={Play} />`. Never import from the package root
  (`'phosphor-svelte'`): the barrel would pull the whole set into the bundle.
  Names are Phosphor's PascalCase (`ArrowCounterClockwise`); browse them at
  phosphoricons.com. (Measured: six icons cost about 3 KB raw each, the
  weights are in the component.)
- **Props:** `size` (px, default 16), `weight` (default `regular`; `fill` for
  the solid transport glyphs Play / Stop), `label`. Colour is always
  `currentColor`: set `color` on the button, never a fill on the icon, and
  the Idle / active / disabled rules above apply unchanged.
- **Sizes:** 16 in the 32 px icon buttons, 20 in the 44 px transport
  buttons, 12 inside the 22 px pattern transport.
- **Icon-only buttons:** the button needs an `aria-label` (or visually hidden
  text, as the song Play's `.sr-only` "Play song") and a tooltip (a plain `title`;
  the global layer below shows it). The icon itself stays decorative
  (`aria-hidden`, no `label`). Give `Icon` a `label` only when it stands
  alone with no labelled control around it (`role="img"`).
- Tests find controls by test id or accessible name, never by a glyph.

## Tooltips

One global layer, `ui/Tooltip.svelte`, mounted once in `App.svelte`. Components
do nothing special: any element with a `title` (or `data-tip`) gets the custom
tip. Timing and placement live in `ui/tooltip.ts` (pure, unit-tested).

- **Claim / release.** When the pointer enters such an element (or it gets
  keyboard focus, `:focus-visible` only) the layer moves `title` into
  `data-tip` (so the native tip never fires) and sets `aria-describedby` to the
  layer. When the tip hides, `title` and the old `aria-describedby` are put
  back, so code and tests that read `title` still work.
- **Timing.** 250 ms delay; 0 ms while a tip is showing or within 600 ms of one
  hiding (moving along a toolbar). 13 px (`--fs-body`), `--lcd` background,
  max 320 px, flips above the element near the bottom edge, clamped to the
  viewport.
- **Hides on** pointerdown, Esc (not swallowed), scroll (capture), window blur,
  pointer leaving, focus leaving. After a click/Esc/scroll dismissal the same
  element does not re-show until the pointer has left it.
- **Live.** A `title`/`data-tip` change while shown updates the text; the
  element being removed or hidden (a menu closing, a re-rendered cell) hides
  the tip (one connected/visible check per animation frame while shown).
- Touch pointers are ignored. `data-tip` alone (no `title`) also works.
- **Limits.** A reactive `title` that becomes absent mid-hover is not
  observable (removing an absent attribute fires no mutation), so the last
  title is restored on hide until the next render. Any scroll event, including
  programmatic ones (playhead follow), hides the tip. An authored `data-tip`
  is never overwritten or removed and wins over `title`. A tip opened by
  keyboard focus is not closed by the pointer leaving, only by focus leaving.
- **Hint line.** While hovered the `title` lives in `data-tip`, so
  `hintText` (bigTimer.ts) reads `title`, then `data-tip`, then `aria-label`.
  Anything else reading `title` of a hovered element must do the same.
- **Limits.** A reactive `title` that becomes absent mid-hover is not
  observable (removing an absent attribute fires no mutation), so the last
  title is restored on hide until the next render. Any scroll event, including
  programmatic ones (playhead follow), hides the tip. An authored `data-tip`
  is never overwritten or removed and wins over `title`. A tip opened by
  keyboard focus is not closed by the pointer leaving, only by focus leaving.
- **Hint line.** While hovered the `title` lives in `data-tip`, so
  `hintText` (bigTimer.ts) reads `title`, then `data-tip`, then `aria-label`.
  Anything else reading `title` of a hovered element must do the same.
