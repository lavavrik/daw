// The design tokens (spec §2) as values, for code that can't use CSS custom
// properties: canvas drawing, SVG built in script, colour maths. Components
// use var(--…) from theme.css instead. theme.test.ts parses theme.css and
// checks every value here matches its :root token, in both directions:
//   THEME.<camelKey>     <-> --<kebab-key>   (tokenName below)
//   RADII.<k>            <-> --r-<k>  (px)
//   TRACK_COLORS[i]      <-> --track-<i>
//   CATEGORY_COLORS.<k>  <-> --cat-<k>
//   SIGNAL_COLORS.<k>    <-> --sig-<k>
// See docs/architecture/ui-theme.md.

export { TRACK_COLORS } from '../state/palette';

export const THEME = {
  // Surfaces
  top: '#56626e',
  panel: '#4a5662',
  work: '#3e4954',
  raised: '#6a7783',
  well: '#2d3640',
  lcd: '#232b33',
  line: '#5d6a77',
  grid: '#4b5763',
  // Text: text2 is secondary (>= 4.5:1 on panel); textDim only on well/lcd.
  text: '#eef2f5',
  text2: '#d2d9e0',
  textDim: '#9fb0bf',
  // Accents
  play: '#7ee081',
  accent: '#ffb347',
  rec: '#ff6b6b',
  /** Text on any vivid colour (accent, play, a track colour). */
  onColor: '#1d242b',
  // Depth: the only shadow and gradient recipes.
  raisedShadow: 'inset 0 1px 0 rgba(255,255,255,.22), inset 0 -2px 0 rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.3)',
  gloss: 'linear-gradient(rgba(255,255,255,.3), rgba(255,255,255,0) 60%)',
  wellShadow: 'inset 0 2px 5px rgba(0,0,0,.5), inset 0 -1px 0 rgba(255,255,255,.06)',
  lift: 'inset 0 1px 0 rgba(255,255,255,.1), 0 6px 14px rgba(0,0,0,.28), 0 1px 2px rgba(0,0,0,.3)',
  /** Slider handle fill and shadow. */
  handle: 'linear-gradient(#fff, #cfd8df)',
  handleShadow: '0 1px 3px rgba(0,0,0,.5)',
  // Type. The stacks end in system fonts so a blocked font degrades cleanly.
  fontUi: "'Inter Variable', Inter, system-ui, sans-serif",
  fontMono: "'JetBrains Mono', ui-monospace, monospace",
  fsBody: '13px',
  fsCtl: '12px',
  fsLbl: '10px',
} as const;

/** Corner radii in px: sm cells/small buttons, md buttons/inputs, lg cards/transport. */
export const RADII = { sm: 6, md: 8, lg: 12 } as const;

/**
 * Rack module header colour per category (spec §2), written verbatim.
 * The catalog's categories today are source/shaping/utility/effect; mapping
 * them onto these keys is the rack task's job (ui/rack/cables.ts).
 */
export const CATEGORY_COLORS = {
  source: '#ffb347',
  filter: '#5cc8ff',
  modulation: '#9b8cff',
  utility: '#a6e06a',
  effect: '#f47cc3',
  output: '#e6ebef',
} as const;

/**
 * Jack and cable colour per signal type (spec §4 "Jacks"), written verbatim.
 * The spec names `vel`; the catalog's SignalKind has `pitch` instead and no
 * `vel`, so the rack task decides which key a pitch jack reads.
 */
export const SIGNAL_COLORS = {
  audio: '#ff9f43',
  cv: '#5cc8ff',
  gate: '#7ee081',
  vel: '#9b8cff',
} as const;

/** The CSS custom-property name (without `--`) for a THEME key: textDim -> text-dim, text2 -> text-2. */
export const tokenName = (key: string) => key.replace(/([A-Z])/g, '-$1').replace(/(\d+)/g, '-$1').toLowerCase();
