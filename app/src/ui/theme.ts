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
  /** A small drop under a raised thing with no recipe of its own (an on step cell). */
  drop: '0 2px 4px rgba(0,0,0,.3)',
  /** Slider handle fill and shadow. */
  handle: 'linear-gradient(#fff, #cfd8df)',
  handleShadow: '0 1px 3px rgba(0,0,0,.5)',
  // Type. The stacks end in system fonts so a blocked font degrades cleanly.
  fontUi: "'Inter Variable', Inter, system-ui, sans-serif",
  fontMono: "'JetBrains Mono', ui-monospace, monospace",
  fsBody: '13px',
  fsCtl: '12px',
  fsLbl: '10px',
  /** Below the spec's sizes: captions (jack names, scales) and badges (A, CC). */
  fsXs: '9px',
  fsTag: '8px',
} as const;

/**
 * Corner radii in px: sm cells/small buttons, md buttons/inputs, lg
 * cards/transport (spec §2); xs tags and badges, menu menus and popovers.
 */
export const RADII = { xs: 3, sm: 6, md: 8, lg: 12, menu: 10 } as const;

/**
 * Rack module header colour per category (spec §2), written verbatim. The
 * catalog has only four categories (source/shaping/utility/effect), so a
 * module's colour comes from `rackCategory` below, not from its catalog
 * category alone.
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
 * The catalog's signal kinds map onto these through `jackSignal` below.
 */
export const SIGNAL_COLORS = {
  audio: '#ff9f43',
  cv: '#5cc8ff',
  gate: '#7ee081',
  vel: '#9b8cff',
} as const;

// ---- catalog -> spec colours (plan 20 Task 9) ------------------------------
// The spec has six rack categories and four jack colours; the catalog
// (engine/catalog.json) has four categories and the signal kinds
// audio/cv/gate/pitch. theme.test.ts checks every catalog module, category
// and port gets a colour.

export type RackCategory = keyof typeof CATEGORY_COLORS;
export type JackSignal = keyof typeof SIGNAL_COLORS;

/** The catalog's categories onto the spec's: `shaping` is mostly filters (Filter, Formant). */
export const CATALOG_CATEGORIES: Readonly<Record<string, RackCategory>> = {
  source: 'source',
  shaping: 'filter',
  utility: 'utility',
  effect: 'effect',
};

/**
 * Modules whose role on the design board ("Instrument rack") is not their
 * catalog category: envelopes, the LFO and Accent are modulation, the VCA is
 * a utility, the Saturator an effect, Out the output.
 */
export const MODULE_CATEGORIES: Readonly<Record<string, RackCategory>> = {
  lfo: 'modulation',
  adsr: 'modulation',
  accent: 'modulation',
  vca: 'utility',
  saturator: 'effect',
  out: 'output',
};

/** A module's rack category (unknown catalog categories fall back to utility). */
export const rackCategory = (m: { id: string; category: string }): RackCategory =>
  MODULE_CATEGORIES[m.id] ?? CATALOG_CATEGORIES[m.category] ?? 'utility';

/** A module's header colour. */
export const moduleColor = (m: { id: string; category: string }) => CATEGORY_COLORS[rackCategory(m)];

/** A catalog category's colour (the add-module menu's group headers). */
export const catalogCategoryColor = (category: string) => CATEGORY_COLORS[CATALOG_CATEGORIES[category] ?? 'utility'];

/** The catalog's signal kinds onto the spec's jack colours: pitch is a cv (1 V/oct). */
export const CATALOG_SIGNALS: Readonly<Record<string, JackSignal>> = {
  audio: 'audio',
  cv: 'cv',
  gate: 'gate',
  pitch: 'cv',
};

/**
 * A port's jack colour key. The catalog carries velocity as a plain `cv`
 * port named `vel` (MIDI In's output, the ADSR's and Accent's inputs); the
 * spec gives velocity its own colour, so the name decides.
 */
export const jackSignal = (port: { name: string; signal: string }): JackSignal =>
  port.name === 'vel' ? 'vel' : (CATALOG_SIGNALS[port.signal] ?? 'cv');

/** A port's jack and cable colour. */
export const jackColor = (port: { name: string; signal: string }) => SIGNAL_COLORS[jackSignal(port)];

/** The CSS custom-property name (without `--`) for a THEME key: textDim -> text-dim, text2 -> text-2. */
export const tokenName = (key: string) => key.replace(/([A-Z])/g, '-$1').replace(/(\d+)/g, '-$1').toLowerCase();
