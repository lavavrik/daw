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
| Depth | `--raised-shadow --gloss --well-shadow --lift --handle --handle-shadow` | `THEME.raisedShadow` … |
| Radii | `--r-sm` 6 · `--r-md` 8 · `--r-lg` 12 | `RADII.sm/md/lg` (numbers) |
| Type | `--font-ui --font-mono --fs-body` 13 · `--fs-ctl` 12 · `--fs-lbl` 10 | `THEME.fontUi` … |
| Data | `--track-0..7`, `--cat-<category>`, `--sig-<signal>` | `TRACK_COLORS`, `CATEGORY_COLORS`, `SIGNAL_COLORS` |

`THEME` keys map to CSS names by `tokenName` (`textDim` → `--text-dim`,
`text2` → `--text-2`). Change a value in both files; the test fails otherwise.
Keep the `:root` block to custom properties only.

Rules of use:
- `--text-dim` only on `--well` and `--lcd`; on `--panel` use `--text-2`.
- Text on any vivid colour (accent, play, a track colour) is `--on-color`.
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
- **Lift** (cards: rack modules, mixer strips): `box-shadow: var(--lift)`.
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
  colour of what the slider belongs to) up to `--fill` (0..100%) with the gloss
  on it; the handle recipe; focus is a 4 px accent glow on the handle. The
  component sets both variables, e.g.
  `style:--fill="{(value - min) / (max - min) * 100}%" style:--c={trackColor}`.
  Unset, they default to `--accent` and 50%. A `--c` set on an ancestor also
  applies (it inherits). A fill that does not start at the left (bipolar,
  from the centre) also sets `--fill-pos`, the fill layer's
  `background-position` (default `0%`). CSS reads that percentage of the
  groove left over beside the layer, so a fill whose left edge is at `at`%
  with width `w`% needs `at / (100 − w) * 100`%; `ui/stepGrid.ts` `panFill`
  computes it. Set `--fill`/`--fill-pos` on the input itself: they inherit,
  so on an ancestor they would reach every slider inside.
- **checkbox**: a 34×20 switch (`--well` off, `--play` on, the handle as the
  knob, drawn with `::before`).
- **text, search, number, url, email, textarea**: `--well` fields, 8 px radius,
  accent focus ring. Number inputs keep their native spinners until
  `NumberField.svelte` replaces them.
- **scrollbars**: `scrollbar-color: var(--raised) transparent` on `html`, with
  `color-scheme: dark` for the native bits we don't skin.

### Skinning a new control
1. Start from the tokens: surface, depth recipe, radius, font size.
2. Global skin for a native element → add it to `theme.css` inside `:where()`.
   One-off component styling → the component's own `<style>`, using `var(--…)`.
3. Colour that depends on data → read it from state/`theme.ts` and pass it as
   a custom property (`--c`), never as a literal.
4. Check it in Chrome, including focus-visible and disabled states.

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

## Transition notes (until every component is on the theme)
- `html, body` inherit `--fs-ctl` (12 px), not `--fs-body` (13 px): the
  existing components inherit the body size and are tuned for 12 px; at 13 px
  the top bar wraps at 1400 px and the piano roll loses a row at 1280×720.
  Body text opts into `--fs-body` as each component is restyled.
- The skinned `<select>` drops base-select's 24 px minimum height
  (`min-block-size: 0`): dense toolbars would otherwise grow.
- `TopBar.svelte`'s old undo/redo group uses the class `.seg`;
  it resets the theme's well padding until the top-bar task replaces it.

## The hex guard
`noHexColors.test.ts` fails when a `.svelte` file outside its `ALLOWED` list
contains a hex colour literal (`#abc`, `#abcd`, `#aabbcc`, `#aabbccdd`;
comments ignored). `ALLOWED` started as every component that had literals when
the theme landed. A task that moves a file onto tokens removes it from the
list in the same commit; the test also fails if a listed file is already
clean, so the list only shrinks. Hex values belong in `theme.css`,
`theme.ts` and `state/palette.ts` only.

## NumberField

`ui/NumberField.svelte` replaces bare `<input type="number">` (spec §3). It keeps a real number input (with the `id` / `data-testid`, so `fill` works) and adds steppers and a vertical scrub. `variant="plain"` is a `--well` field with − and +; `variant="lcd"` is the tempo readout (label above, stacked ▲▼). The maths lives in `ui/numberField.ts`.

- A scrub starts after 3 px of vertical travel (a click still focuses the input), moves 1 step per 4 px, Shift = step / 10. Only the display moves; `onchange` fires once on release, so a scrub is one undo entry. Esc or Cmd/Ctrl+Z mid-scrub drops it (`registerDragCancel`).
- Arrows step; the wheel steps only while the field is focused (so scrolling a panel never edits a field under the cursor). Enter/blur commits, Esc reverts. `oninput` reports the raw text for live validation (Settings' buffer field).
- Do not wrap a NumberField in a `<label>`: a click on label text would forward to the first button (the − step). Use a `div`.
