// theme.ts is the canvas code's copy of the tokens in theme.css. This test
// parses theme.css's :root block and checks the two agree in both
// directions, so a colour changed in one file and not the other fails here
// instead of drifting on screen.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../audio/catalog';
import {
  CATALOG_CATEGORIES, CATALOG_SIGNALS, CATEGORY_COLORS, RADII, SIGNAL_COLORS, THEME, TRACK_COLORS, catalogCategoryColor, jackColor, jackSignal,
  moduleColor, rackCategory, tokenName,
} from './theme';
import { TRACK_COLORS as STATE_TRACK_COLORS } from '../state/palette';
import { TRACK_COLORS as PROJECT_TRACK_COLORS } from '../state/project.svelte';

const CSS = readFileSync(join(__dirname, 'theme.css'), 'utf8');

/** The custom properties declared in the first top-level `:root { … }` block. */
function rootTokens(css: string): Map<string, string> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = /(^|\})\s*:root\s*\{([^}]*)\}/.exec(noComments);
  if (!m) throw new Error('theme.css has no :root block');
  const out = new Map<string, string>();
  for (const decl of m[2].split(';')) {
    const d = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
    if (d) out.set(d[1], d[2].replace(/\s+/g, ' '));
  }
  return out;
}

/** What theme.ts says the :root block holds, keyed by custom-property name. */
function expected(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(THEME)) out.set(`--${tokenName(k)}`, v);
  for (const [k, v] of Object.entries(RADII)) out.set(`--r-${k}`, `${v}px`);
  TRACK_COLORS.forEach((c, i) => out.set(`--track-${i}`, c));
  for (const [k, v] of Object.entries(CATEGORY_COLORS)) out.set(`--cat-${k}`, v);
  for (const [k, v] of Object.entries(SIGNAL_COLORS)) out.set(`--sig-${k}`, v);
  return out;
}

describe('theme tokens', () => {
  const css = rootTokens(CSS);
  const ts = expected();

  it('every theme.ts value matches theme.css', () => {
    const mismatched = [...ts].filter(([k, v]) => css.get(k) !== v).map(([k, v]) => `${k}: ts=${v} css=${css.get(k)}`);
    expect(mismatched).toEqual([]);
  });

  it('theme.css has exactly one :root block (rootTokens reads only the first)', () => {
    const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(noComments.match(/:root\b/g)).toHaveLength(1);
  });

  it('every :root token in theme.css is in theme.ts', () => {
    expect([...css.keys()].filter((k) => !ts.has(k))).toEqual([]);
  });

  it('pins the spec §2 values', () => {
    expect(THEME.top).toBe('#56626e');
    expect(THEME.work).toBe('#3e4954');
    expect(THEME.text2).toBe('#d2d9e0');
    expect(THEME.accent).toBe('#ffb347');
    expect(THEME.onColor).toBe('#1d242b');
    expect(TRACK_COLORS).toEqual(['#ff7a6b', '#ffc145', '#a6e06a', '#4fd6c4', '#5cc8ff', '#9b8cff', '#f47cc3', '#e0d45a']);
    expect(RADII).toEqual({ xs: 3, sm: 6, md: 8, lg: 12, menu: 10 }); // spec §2's 6/8/12, plus xs and menu (ui-theme.md)
  });

  it('state and ui share one track palette', () => {
    expect(STATE_TRACK_COLORS).toBe(TRACK_COLORS);
    expect(PROJECT_TRACK_COLORS).toBe(TRACK_COLORS);
  });

  it('the font stacks fall back to system fonts', () => {
    expect(THEME.fontUi).toMatch(/system-ui, sans-serif$/);
    expect(THEME.fontMono).toMatch(/ui-monospace, monospace$/);
  });

  it('tokenName maps camelCase keys to the css names', () => {
    expect(tokenName('text2')).toBe('text-2');
    expect(tokenName('textDim')).toBe('text-dim');
    expect(tokenName('raisedShadow')).toBe('raised-shadow');
    expect(tokenName('fsBody')).toBe('fs-body');
  });
});

describe('catalog -> spec colours (rack)', () => {
  const cats = Object.keys(CATEGORY_COLORS);
  const sigs = Object.keys(SIGNAL_COLORS);

  it('every catalog category maps onto a spec category', () => {
    const used = [...new Set(CATALOG.modules.map((m) => m.category))];
    expect(used.filter((c) => !(c in CATALOG_CATEGORIES))).toEqual([]);
    for (const c of used) expect(cats).toContain(CATALOG_CATEGORIES[c]);
  });

  it('every catalog module has a header colour from the spec palette', () => {
    for (const m of CATALOG.modules) {
      expect(cats, m.id).toContain(rackCategory(m));
      expect(moduleColor(m), m.id).toBe(CATEGORY_COLORS[rackCategory(m)]);
    }
  });

  it('follows the design board for the modules it shows', () => {
    const cat = (id: string) => rackCategory(CATALOG.modules.find((m) => m.id === id)!);
    expect(['midi_in', 'osc', 'noise', 'sample_player'].map(cat)).toEqual(['source', 'source', 'source', 'source']);
    expect(['filter', 'formant'].map(cat)).toEqual(['filter', 'filter']);
    expect(['adsr', 'lfo', 'accent'].map(cat)).toEqual(['modulation', 'modulation', 'modulation']);
    expect(['vca', 'mixer', 'scope', 'attenuator'].map(cat)).toEqual(['utility', 'utility', 'utility', 'utility']);
    expect(['saturator', 'delay', 'reverb'].map(cat)).toEqual(['effect', 'effect', 'effect']);
    expect(cat('out')).toBe('output');
    expect(rackCategory({ id: 'new_thing', category: 'mystery' })).toBe('utility');
    expect(catalogCategoryColor('shaping')).toBe(CATEGORY_COLORS.filter);
    expect(catalogCategoryColor('mystery')).toBe(CATEGORY_COLORS.utility);
  });

  it('every catalog port has a jack colour', () => {
    const kinds = new Set<string>();
    for (const m of CATALOG.modules) {
      for (const p of [...m.inputs, ...m.outputs]) {
        kinds.add(p.signal);
        expect(sigs, `${m.id}.${p.name}`).toContain(jackSignal(p));
      }
    }
    expect([...kinds].filter((k) => !(k in CATALOG_SIGNALS))).toEqual([]);
  });

  it('pitch is cv, a vel port is vel', () => {
    expect(jackColor({ name: 'pitch', signal: 'pitch' })).toBe(SIGNAL_COLORS.cv);
    expect(jackColor({ name: 'vel', signal: 'cv' })).toBe(SIGNAL_COLORS.vel);
    expect(jackColor({ name: 'env', signal: 'cv' })).toBe(SIGNAL_COLORS.cv);
    expect(jackColor({ name: 'gate', signal: 'gate' })).toBe(SIGNAL_COLORS.gate);
    expect(jackColor({ name: 'out', signal: 'audio' })).toBe(SIGNAL_COLORS.audio);
  });
});
