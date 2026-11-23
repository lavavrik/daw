# UI theme (tokens, depth, native-control skins)

This page says where the theme values live in code and how to use them.

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
| Type | `--font-ui --font-mono --fs-body` 13 · `--fs-ctl` 12 · `--fs-lbl` 10 · `--fs-xs` 9 · `--fs-tag` 8 · `--fs-head` 11 | `THEME.fontUi` … |
| Data | `--track-0..7`, `--return-0..7`, `--cat-<category>`, `--sig-<signal>` | `TRACK_COLORS`, `RETURN_COLORS`, `CATEGORY_COLORS`, `SIGNAL_COLORS` |
| Mechanical (rack and mixer only) | `--mech-*` (below, "Mechanical faceplates") | `THEME.mechPanel` … `THEME.mechLedHot` |

`THEME` keys map to CSS names by `tokenName` (`textDim` → `--text-dim`,
`text2` → `--text-2`). Change a value in both files; the test fails otherwise.
Keep the `:root` block to custom properties only, and keep it the only
`:root` block (`theme.test.ts` checks both: it reads only the first).

Beyond the spec's values (plan 20 Task 11, for the literals the review found):
- `--r-xs` (tags and badges, ~10 px tall) and `--r-menu` (menus, popovers and
  the select picker: the spec's 10 px). A radius that is half the element's
  height (a pill end, a 6 px groove's 3 px, a circle) is geometry and stays
  a literal.
- `--fs-xs` (captions: jack names, meter scales, step values), `--fs-tag`
  (the A / CC badges) and `--fs-head` 11 (the mechanical faceplates'
  `.mech-head` strip: 800, uppercase, tracked). Sizes outside the five (the 11 px in older toolbars,
  the 18 px tempo, the 32 px timer) are still literals in their components.
- `--drop` (`0 2px 4px rgba(0,0,0,.3)`): the board's small drop under an on
  step cell, for a raised thing that has no recipe of its own.

Rules of use:
- `--text-dim` only on `--well` and `--lcd`; on `--panel` use `--text-2`.
- Text on any vivid colour (accent, play, a track colour) is `--on-color`.
- Never `--play`, `--accent` or `--rec` as text or an icon on `--raised`
  (1.7–2.8:1, under WCAG's 4.5:1 for text and 3:1 for icons). A warning or
  status puts the colour in a fill instead: the vivid colour under
  `--on-color` text (the top bar's red dropout / MIDI-blocked badge, the
  orange latency badge, View ▸ Performance's red dropout readout, an armed
  Rec, a playing ▶), a light mix of the colour
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
- Return colours (plan 29) are `--return-0..7`, one per engine **slot**, not
  per return: `state/returns.ts` `returnColor(slot)` gives
  `var(--return-<slot>)`, so a colour is derived, never saved, and undoing a
  delete brings the same one back. The mixer uses it for a return strip's
  header dot and knobs, and on the track strips for the send knob rings, the
  pre LEDs and the Sends section's mini bars (`docs/architecture/mixer.md`
  "Returns and sends on the strips"). Canvas code (the analyser) reads
  `RETURN_COLORS[slot]` from `theme.ts`. The return headers stay on
  `--raised`: the colour is a dot, so a return never passes for a track.
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

## Focus and other rings (no CSS outlines)
The app draws no `outline`. An outline paints outside the element's box, over
its neighbours and into the edges of clipping parents, so a focused field or
button looked like it grew or pushed things (the mixer strips were the worst).
Every ring is drawn **inside** the box instead:
- **Keyboard focus**: `box-shadow: var(--focus-ring)` (an inset 2 px
  `--accent` ring), listed **first** so it sits over the element's own inset
  shadows: `box-shadow: var(--focus-ring), var(--raised-shadow)`. A state
  that changes the shadow (`.on`, `.lit`) needs its own `:focus-visible` rule
  with the same composition, or the focus rule drops its glow.
- On an `--accent` (or `--rec` / `--play`) surface, the ring is
  `inset 0 0 0 2px var(--text)`: an accent ring would vanish.
- When children cover the box (a canvas, a fill, a header strip), the ring is
  an `::after` overlay: `content: ''; position: absolute; inset: 0;
  border-radius: inherit; box-shadow: …; pointer-events: none` on a positioned
  host (WaveformView, ScopeView, Wheels, step cells, the selected mixer strip,
  the MIDI-learn pulse on knobs and faders).
- Bare text buttons (the project name, Rack's links) underline in `--accent`
  instead of a ring that would cover the text.
- Dashed drop targets (step rows, a sampler panel) are an `::after` with a
  dashed `border`.
Set `outline: none` when replacing a browser default ring.

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
  inset accent focus ring (`--focus-ring`). Every number input is `NumberField.svelte`'s core, which
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

## Mechanical faceplates (plan 21 Task 10)
The rack modules and the mixer strips are drawn as hardware (spec
2026-11-15 §11, the owner-approved board
`.superpowers/design/boards/RackMechanical.dc.html`). Everywhere else keeps
the flat look. The recipes are `--mech-*` tokens (mirrored in `THEME`,
checked by `theme.test.ts`) and zero-specificity classes in `theme.css`:

| Class / token | What |
|---|---|
| `.mech-panel` (`--mech-panel`, `--mech-panel-shadow`) | the faceplate: a vertical gradient with an inset top light, a dark lower lip and a drop shadow; 8 px corners; `position: relative` for the screws |
| `.mech-head` (`--mech-head-gloss`, `--mech-head-shadow`) | the header strip: `--c` (category or track colour) under a stronger gloss, 800 11 px uppercase, `.1em` tracking, `--on-color` text |
| `.screw` (`--mech-screw`, `--mech-screw-shadow`) | a 7 px corner screw; the owner places it (`left/right/top/bottom`) |
| `.engr` (`--mech-label`, `--mech-label-shadow`) | an engraved label: 9 px, 700, uppercase, `.09em`, dark text shadow |
| `.mech-chip` (`--mech-recess`, `--mech-chip-text`, `--mech-chip-shadow`) | the mono value chip under a control (Knob styles its own readout with the same tokens) |
| `.mech-btn` (`--mech-btn`, `--mech-btn-on`, their shadows, `--mech-btn-text`) | a raised push-button; pressed (`aria-checked`/`aria-pressed="true"`, `.on`) it drops 1 px with a short shadow |
| `.led` / `.led.lit` (`--mech-led-off`, `--mech-led-off-shadow`, `--mech-led-hot`) | the LED above a push-button; lit it is `--c` with a `0 0 6px var(--c)` glow and a white core |
| `.mech-slot` (`--mech-slot`, `--mech-slot-shadow`) | the recessed well a fader cap runs in |
| `--mech-tick`, `--mech-tick-minor` | a dial's tick ring and a fader's scale (the minor ticks, and the dial cap's rim) |
| `--mech-cap`, `--mech-cap-top`, `--mech-cap-shadow`, `--mech-pointer` | the dial's cap (two radial gradients) and its white pointer |
| `--mech-fader-cap`, `--mech-fader-cap-shadow` | the grooved metal fader cap (28×16) |
| `--mech-jack`, `--mech-jack-shadow` | the metal jack socket (18 px); its ring is the signal colour, per use |
| `--mech-divider` | the engraved line over a footer or a strip row (an inset box-shadow, no border) |

Rules: the class name `.led` is the LED dot — don't use it as a modifier on
anything else (a `class:led` on a container turns the container into a
7 px dot). Gradients sized in px (`--mech-jack`) are for their element's
size only.

The controls: `Knob.svelte` `variant="mech"` (sizes `lg` 86 / `md` 58 /
`sm` 46 px) and `variant="vfader"`, `ChoiceSeg`/`ChoiceParam` `look="led"`,
`Jack.svelte`, `mixer/Fader.svelte`. Which param gets which control:
`rack/controlMap.ts` (`docs/architecture/modular.md`). The mixer strip:
`docs/architecture/mixer.md` "Strip look".

## Controls that move every frame
A control that follows automation or a drag repaints up to 60 times a
second, so its moving parts change only paint-time properties, never layout:
- `Knob` (slider variant): the fill is full width and clipped to its span by
  `clip-path: inset(… round 3px)` (a `scaleX` would squash the round ends);
  the handle moves by `transform: translateX(<pos × 100>cqi)`: the rail is
  an inline-size container, so `cqi` is a percent of the rail.
- `Knob` (mech variant): the value arc's `stroke-dasharray` and the
  pointer's `transform` attribute (an SVG rotate about 50,50), as the flat
  dial.
- `Knob` (vfader variant): the lit strip is the slot's full height under
  `transform: translateY(-from%) scaleY(to − from)` from its foot (no
  clip-path: it would clip the glow); the cap rises by
  `transform: translateY(-<pos × 100>cqb)`: the slot is a size container.
- `Fader` (mixer): the fill is the slot's full height under
  `transform: scaleY(pos)` from its foot; the cap sits at the bottom and rises
  by `translateY`.

## Selects and the piano keys
Letters are the QWERTY piano, so every `<select>` takes
`onkeydown={selectKey}` (`ui/selectKey.ts`): no type-ahead on printable keys
(Cmd/Ctrl/Alt chords and the navigation keys pass). That is the rack's patch
and sample pickers, choice params, the mixer's sidechain picker, the pattern
picker, the step grid's step count, the piano roll's grid and length, the
Acid tab's length / root / scale and Settings'
latency. After a pick, `releaseSelect(sel)` gives the keys back (except in
the modal Settings dialog: no key reaches the piano behind a modal, so its
select keeps the focus):
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
- The bottom panel's tabs are 20 px (`padding: 2px 8px` on a 2 px `--work`
  tray), not the board's 30 px: the header must stay one row under 40 px at
  1280 px beside the pattern transport (`layout.spec.ts`). Since plan 30 they
  are 16 px Phosphor icons (Step grid `GridFour`, Piano roll `PianoKeys`,
  Acid `Flask`, Instrument `PlugsConnected`, Mixer `Faders`, Clip
  `Waveform`); the name is the button's aria-label and leads its tooltip.
- The bottom panel header's title is a fixed slot (140–260 px by window width only) (ellipsized, the
  whole text as its tooltip) and the pattern picker a fixed 150 px (its
  name fields too), so switching tracks or patterns never moves a control
  (plan 30).
- The song area / bottom panel split is draggable (plan 30): a horizontal
  `Splitter` (`axis="y"`) on the bottom panel's top edge, saved as
  `daw.paneWidth.song` (0 = the default 1 : 3 split); the CSS keeps the
  song area >= 100 px and the bottom panel >= 200 px.
- Popovers with their own controls are a `--panel` card with the lift (the
  Rack's add-module menu, the piano roll's Examples, `InlineConfirm`, the
  precise-entry card below, whose lower half is the Automate / MIDI learn
  items, `AutoMenu`). They use `--r-menu` / `--r-md` and `--lift`. (A
  light, select-like floating AutoMenu existed until plan 24 folded it into
  the card.)
- The rack and the mixer strips are mechanical faceplates (plan 21 Task
  10, above), reversing plan 20 §3's "sliders instead of dials" there only.
  Every mixer strip knob (EQ, Comp, the returns' effects, sends, pan, the
  limiter ceiling) is a compact mech dial; the Delay's 12-way division is a
  skinned select (`ChoiceParam`). The top bar's Master stays a flat slider.

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

## Resizable panes

The library sidebar and the song timeline's track header column are
resizable: `ui/Splitter.svelte`, a focusable `role="separator"` strip over
the pane's edge (drag; ←/→ 8 px, Shift 1 px; double-click: the default;
Escape / Cmd+Z mid-drag: back). Widths live in `ui/paneWidths.svelte.ts`
(`PANES`: library 220 px, 180..480; track headers 176 px, 150..360), a UI
preference in localStorage (`daw.paneWidth.<pane>`), never the project.
The header strip sits inside the column's last 5 px, so a click at the very
start of a lane still reaches the lane.

## Bottom panel header heights

Every control in the bottom panel header is 24 px tall: the pattern
transport's well (20 px buttons in 2 px), the pattern picker's select,
buttons and name field, and the tab tray (20 px tabs in 2 px), so the row
reads as one line of equal pills.

## Popover menus

The main menus' popover (`MenuBar .pop`) is the look for menus: a `--panel`
card with a 1 px `--raised` outline, `--lift` + `--drop`, a 6 px frame
(8 px at the bottom), 26 px items with 10 px side padding, and small
uppercase `--text-2` section heads. The rack's Add module menu follows it
(one column per category; the category colour is a swatch by its head).

## Top bar

`ui/TopBar.svelte` (plan 20 Task 5; spec §4; the canvas board "Song view"),
one 64 px `--top` row. The header comment has the details; in short:

| Part | What | Test id |
|---|---|---|
| Menu bar | `ui/MenuBar.svelte` (plan 21): File · Edit · Add · Patterns · View · Options · Help, 12 px text buttons on top of the left block. Each is a button (`aria-expanded`, `aria-controls`) over a popover of plain buttons (no ARIA menu): ↓ / ↑ open it on the first / last item, ↑ ↓ Home End move inside, ← → open the neighbour, Esc closes it and returns the focus to its opener (a document listener that stops the key: MIDI learn stays on), a press outside or Tab out closes it; one open at a time, pointing at another menu button switches. Items show their shortcut and an icon; the popover has 16 px of padding at the sides and 8 px at the bottom, and every item is the popover's full inner width (one highlight band). The song's context menus (track header `track-menu`, timeline `tl-menu`, automation lane `auto-menu`) follow the same rule (`6px 16px 8px`, full-width items). Opening or closing a menu clears any pending submenu hover timer (`cancelHover`), so it never acts on the next menu. Submenus (Patterns ▸ Load from library, Options ▸ Note names ▸ Letters / Solfège) fly out to the right: → / Enter / Space open one on its first entry, ← / Esc close only it and focus its item (wherever the focus is), → inside does nothing; hovering the item opens it after 150 ms, hovering a sibling or leaving the menu closes it after 200 ms (that delay is the grace for a diagonal move into it). Options ▸ Keyboard's octave row also takes the wheel (`wheelOctaveSteps`). plan 20's ⋯ items live in File (New … Export WAV…, Undo take, the discard question) and Options (Rec offset) under their old test ids; plan 22 moved the top bar's pills in (below). Help ▸ Keyboard shortcuts is `ui/ShortcutsSheet.svelte`, built from `input/shortcutList.ts` (a unit test keeps it in sync with `shortcuts.ts`). Every popover stays in the DOM, `hidden` while closed (a submenu's entries only exist while it is open) | `menu-file` … `menu-help`, `menu-<name>-panel` (+ the old ids); e2e helpers `openMenu(page, 'File')`, `openAudioSettings(page)` (`tests/e2e/topbar.ts`) |
| Name + hint line | under the menus: project name, `●` when unsaved (a click opens File); under it the flashed hint (`banners.hint`), else the title / aria-label of the control last pointed at anywhere in the app (one `mouseover` listener on the document, `bigTimer.ts` `hintText`), else a static tip | `project-menu`, `project-name`, `hint-line` |
| ↶ ↷ | 32 px raised icon buttons beside the name, under the menus (18 px in the short bar) | `undo`, `redo` |
| Song transport | "Play song" (an aria-pressed toggle, like Space; pressed and glowing while the song plays), "Stop all" (stops either transport), Loop — 44 px, `--r-lg` | `play`, `song-stop`, `loop-toggle` |
| Tempo | `NumberField variant="lcd"`, aria-label "BPM", 0.1 BPM steps with Shift | `tempo` |
| Big timer | `ui/BigTimer.svelte`: bar:beat:tick (32 px mono) + seconds; the heard song position per frame while the song plays, the position inside the shown pattern (label "Pattern") while the pattern transport plays, else the parked song position | `timer`, `timer-pos`, `timer-seconds` |
| Metronome | 32 px icon toggle (`--accent` when on) | — |
| Master | Knob's slider variant on the master channel's `fader` param (curve `fader` = the fader law; `setMix`); automation, MIDI learn and undo as every Knob | `master-volume` |
| Mini spectrum | the master spectrum on an `--lcd` well; opens the Mixer | `topbar-spectrum` |
| Badge | Plan 22: the right end is empty while all is well. ONE badge when something needs attention: "Audio paused" / "Audio failed" (AudioStatusPill: resume / retry), then "N dropouts" (in the last 10 s), "MIDI blocked", "N ms latency" (over 40 ms) from `ui/topStatus.ts`; a click opens Audio settings or the MIDI popover. "MIDI blocked" has a × that hides it (localStorage) until MIDI is allowed and blocked again; Options ▸ MIDI still says "blocked". Red fill, orange for latency | `audio-status` (the slot, `data-state`), `topbar-warning` (`data-kind`), `topbar-warning-dismiss` |
| Moved into the menus (plan 22) | Options ▸ Keyboard: "Octave N" with − / +, "Keys play: ■ track"; Options ▸ MIDI: <status> (the MIDI popover); View ▸ Performance: live "CPU n% · n drop" and "n ms" (each a fixed `min-width` in `ch`, tabular, right-aligned: 19 ch / 6 ch, so the max-content View menu never changes width as the digits change; `menubar.spec.ts`), opens Audio settings (`ui/Settings.svelte`, a modal `<dialog>`). The pills' octave − / + merged into the menu's. Settings' Note names select became the Note names ▸ item | `octave`, `keys-target`, `midi-status`, `cpu`, `latency`, `settings-button`, `note-names` (+ `menu-octave-down` / `-up`) |

Fit: one row at ≥ 1280 px in the widest states (playing, unsaved, the
"123 dropouts" badge; the 228 px "Audio paused" pill), also with the web
fonts blocked (`tests/e2e/topbar.spec.ts`, `layout.spec.ts`,
`audiostart.spec.ts`; the menu row, 252 px, sets the left block's width).
The groups are 8 px apart (4 px below 1400 px) and the mini spectrum grows
from 66 to 360 px: it is the one flexible part and gives its room to the
badge. Text that changes has a fixed box (name, hint, timer digits up to
bar 999, the master readout). Below 1280 px the bar may wrap.
Windows under 740 px tall get a 40 px bar (36 px transport, tempo and
timer; the short badge keeps a 24 px hit area; the left block is two lines:
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
- **Size scale** (three steps, plus the transport):
  - **16, buttons** (the `Icon` default): the 32 px icon buttons, toolbar
    and header buttons (pattern New … Load, piano-roll and Acid tools, rack
    + Module / Save patch / Tidy), menu and popover items (menu bar, + Add
    track list, Examples);
  - **14, rows**: list rows (Browser folder / sample / patch / kit rows) and
    the small 11 px-text pills that sit in a row (+ Add track, the rack's
    "Add example roll" link);
  - **12, badges**: chevrons and carets (submenu ▸, AutoPicker groups),
    section and group headers (mixer EQ / Comp, the Keyboard menu header),
    status pills (audio paused, preview), the track header's Automate…
    chip, the small × dismiss buttons, and the 22 px pattern transport;
  - **20**: only the 44 px song transport (Play, Loop).
  Nothing else (no 10, no 18): pick the step of the element's role.
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
  layer, whose text is written then (still hidden), so a screen reader never
  hears the previous tip during the delay. When the tip hides, `title` and
  the old `aria-describedby` are put back, so code and tests that read
  `title` still work.
- **Top layer.** The layer is a `popover="manual"` shown with
  `showPopover()`, so it is drawn above modal `<dialog>`s (Settings, the
  shortcuts sheet), which no z-index can reach.
- **No echo.** When the tip (trimmed, whitespace squashed) equals the
  element's visible text (`innerText`; `tooltip.ts` `tipRepeatsText`), the
  element is still claimed (its `title` moves to `data-tip`, so no native
  tip either) but nothing shows and no `aria-describedby` is added. Checked
  again whenever the title changes.
- **Timing.** 250 ms delay; 0 ms while a tip is showing or within 600 ms of one
  hiding (moving along a toolbar). 13 px (`--fs-body`), `--lcd` background,
  max 320 px, flips above the element near the bottom edge, clamped to the
  viewport.
- **Hides on** pointerdown, Esc (not swallowed), scroll (capture), window blur,
  pointer leaving, focus leaving. After a click/Esc/scroll dismissal the same
  element does not re-show until the pointer has left it.
- **Live.** A `title`/`data-tip` change while shown updates the text; the
  element being removed or hidden (a menu closing, a re-rendered cell) hides
  the tip (a connected/visible check and re-place every 120 ms while shown,
  and on resize: not every frame, since measuring forces a layout).
- Touch pointers are ignored. `data-tip` alone (no `title`) also works.
- **Limits.** A reactive `title` that becomes absent mid-hover is not
  observable (removing an absent attribute fires no mutation), so the last
  title would be restored on hide until the next render. A title that comes
  and goes while hovered therefore uses `''` for "none" (MenuBar's undo /
  redo and View items): a real mutation, the tip hides, and an empty title
  shows nothing. Any scroll event, including
  programmatic ones (playhead follow), hides the tip. An authored `data-tip`
  is never overwritten or removed and wins over `title`. A tip opened by
  keyboard focus is not closed by the pointer leaving, only by focus leaving.
- **Hint line.** While hovered the `title` lives in `data-tip`, so
  `hintText` (bigTimer.ts) reads `title`, then `data-tip`, then `aria-label`.
  Anything else reading `title` of a hovered element must do the same.
- **Limits.** A reactive `title` that becomes absent mid-hover is not
  observable (removing an absent attribute fires no mutation), so the last
  title would be restored on hide until the next render. A title that comes
  and goes while hovered therefore uses `''` for "none" (MenuBar's undo /
  redo and View items): a real mutation, the tip hides, and an empty title
  shows nothing. Any scroll event, including
  programmatic ones (playhead follow), hides the tip. An authored `data-tip`
  is never overwritten or removed and wins over `title`. A tip opened by
  keyboard focus is not closed by the pointer leaving, only by focus leaving.
- **Hint line.** While hovered the `title` lives in `data-tip`, so
  `hintText` (bigTimer.ts) reads `title`, then `data-tip`, then `aria-label`.
  Anything else reading `title` of a hovered element must do the same.

## Precise entry

Plan 24: right-click a slider-like control (or press the ContextMenu key or
Shift+F10 on it) for a small card that sets an exact value.
`ui/ValuePopover.svelte` is the card, and its header documents the API.
There is one card for the app, rendered by `App.svelte`.
Callers call `openValuePopover`; opening another replaces the open one.

- **Anatomy.** A `--panel` card with `--lift`, `--r-lg` (12 px) and 12 px
  padding. It holds:
  - the control's name (`.lbl`, uppercase, 10 px);
  - a text field (`value-input`) with the value in display units and the
    unit as a suffix inside its right end ("-6.0" + dB, "220" + ms, "C4");
  - **Set** (`.btn.primary`, `value-set`; Enter does the same);
  - a quiet **Reset** to the default (`.btn.quiet`, `value-reset`);
  - the dim mono range hint "min … max".

  Under a `--line` rule come the control's menu items: `AutoMenu`, which
  renders only that list (`auto-ctl-menu`, `auto-ctl-automate`,
  `auto-ctl-midi`) with its arrow keys. With no items, the value part shows
  alone.
- **Text.** `knobMath.entryParts(def, v)` splits the readout into the field
  text and the suffix, with an ASCII minus so the text is easy to edit. The
  suffix is only ever a unit after a number: a unitless decimal stays whole
  ("0.7", never "0" + ".7"), and the minimum's label ("−∞", "Off", "off")
  shows as it reads, with no suffix.
  `parseValue(def, text, readout)` reads the text back:
  - a bare number is in the unit shown as the field's suffix, so "1.5" next
    to kHz is 1.5 kHz. With no suffix shown (the minimum's label), it is in
    the param's base unit (Hz, s, dB…): the EQ high-pass at "Off" reads
    "100" as 100 Hz. An explicit unit ("100 Hz", "1.5k") always wins;
  - it accepts "1.2k", "-6 dB", "C3", "50%", "L25", and the minimum's label
    in any case, alone or with a unit the param shows ("-inf dB", "Off kHz",
    "off s"), so retyping what is shown always works;
  - a bipolar unitless amount (pan, the attenuator) also takes "-0.25" or
    "-25%".

  The result is clamped, and an integer def rounds.
- **Behaviour.**
  - The field opens focused with its text selected.
  - Set or Enter calls the caller's `apply` once, only when the value
    changed. Knob passes its `change`, so the edit is one undo entry with
    the knob's usual label. A field left as it shows changes nothing.
  - The value is read live (the request's `value` is a function,
    `() => number`, so the type asks for it): until the user types,
    the field follows an undo, a MIDI CC or a lane, and Set / Reset compare
    with the value of the moment.
  - Text that doesn't parse gets a `--rec` outline and "Not a value"
    (`value-error`), and the card stays open. Each invalid Enter re-mounts
    the alert, so it is announced again; the field is described by the
    error and the range hint.
  - Tab past the last stop, or Shift+Tab out of the field, closes it and
    puts the focus back on the control.
  - Right-click in the field (and in a knob's typed entry) is the browser's
    own menu, for paste.
  - Esc, a press outside, a wheel outside or a resize closes the card with
    no change.
  - Focus returns to the control, except on an outside press, where the
    press keeps its own focus.
  - It closes on a wheel, not on every `scroll` event, because the
    playhead's follow scrolls the timeline by itself.
  - Keys in the card stop there (MenuBar's `keepKey`): Space presses a
    button and never starts the song. Only Cmd and Ctrl chords go on, and
    in the field the shortcuts already leave Cmd+Z to the text.
- **Placement.** The card sits beside the pointer. Near the right or bottom
  edge it flips to the pointer's other side, and it is clamped 8 px inside
  the window, again whenever its size changes (a ResizeObserver: the error
  line). The keyboard opens it under the control.
- **Layering.** `position: fixed`, z-index 60, not the top
  layer. The global tooltip is in the top layer, so tips for Set, Reset and
  the items show above the card. A press or focus moving into the card
  releases the control's own tip, so that tip never covers the field.
- **Who uses it.** Every control that sets a parameter value (plan 24,
  "all sliders"):
  - every `Knob` variant (knob, slider, mech, vfader): the rack, the mixer
    strips' knobs and the top bar's Master. The knob's own
    click-the-readout typed entry stays;
  - the mixer `Fader` and the song `TrackVol`: the catalog's `fader` def,
    so the field is in dB ("-6", "-inf" = silence) and Reset is 0 dB. Their
    right-click menu (Automate, MIDI learn) is the card's lower half (the
    floating menu, `openAutoMenu`, is gone);
  - the step grid's native ranges: row gain (a plain multiplier, 0..2,
    shown with two decimals like the row, "1.50"), row pan (L/C/R, the
    grid's own "L 25") and Swing (percent). Both texts come through the
    request's `format`. `StepGrid.svelte` builds their `KnobDef`s and snaps
    the value to the slider's 0.01 step, so the card never sets what the
    slider can't show. They have no items;
  - the Clip tab's gain (`cliptab-gain`, `ClipPanel.svelte`): dB, −∞ (−60)
    .. +12, snapped to the slider's 0.1 dB. No items.

  Native ranges spread `popoverHandlers(() => req)` (right-click and
  ContextMenu / Shift+F10, one request per slider) and `use:popoverOwner`
  (the card closes when the slider unmounts).

  A caller with no catalog param builds a `KnobDef`: label, min, max,
  default, `integer`, unit, `curve: 'lin'`, `choices: []`, plus `name:
  'pan'` for an L/C/R readout or `minLabel` for a labelled minimum. A
  unitless 0..1 def reads as a percent.

  Not covered, on purpose:
  - the timeline zoom (and the waveform zoom): view controls, not values;
  - choice / segmented params: not sliders;
  - the pitch and mod wheels (`Wheels.svelte`): live performance controls
    that mirror the hardware, and the pitch wheel springs back to centre.

  The Clip tab's fade and trim handles have exact `NumberField`s beside
  them.
