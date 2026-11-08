// Guard: every colour in a component comes from a theme.css custom property
// (spec §2), so the palette lives in one file and can't drift. A hex colour
// literal (#abc, #abcd, #aabbcc, #aabbccdd) in a .svelte file outside
// ALLOWED fails this test. Comments are ignored. Track and category colours
// are data: they come from state/palette.ts or ui/theme.ts, not literals.
//
// ALLOWED is every .svelte file that had hex literals when the theme landed
// (plan 20 task 1). LATER TASKS: when you move a file onto tokens, delete it
// from this list in the same commit. The last test fails if a listed file is
// already clean, so the list only ever shrinks.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

const ALLOWED: string[] = [
  'App.svelte',
  'ui/AutoMenu.svelte',
  'ui/BottomPanel.svelte',
  'ui/ClipPanel.svelte',
  'ui/InlineConfirm.svelte',
  'ui/MidiPopover.svelte',
  'ui/PatternPicker.svelte',
  'ui/Settings.svelte',
  'ui/SongArea.svelte',
  'ui/StartOverlay.svelte',
  'ui/StepGrid.svelte',
  'ui/TopBar.svelte',
  'ui/Wheels.svelte',
  'ui/acid/AcidSteps.svelte',
  'ui/pianoroll/PianoRoll.svelte',
  'ui/rack/Jack.svelte',
  'ui/rack/Knob.svelte',
  'ui/rack/ModulePanel.svelte',
  'ui/rack/Rack.svelte',
  'ui/rack/SampleStrip.svelte',
  'ui/rack/ScopeView.svelte',
  'ui/rack/ShapePreview.svelte',
  'ui/rack/VoiceLeds.svelte',
  'ui/song/AutoLane.svelte',
  'ui/song/Timeline.svelte',
  'ui/song/TrackHeaders.svelte',
];

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n: string) => {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) return svelteFiles(f);
    return n.endsWith('.svelte') ? [f] : [];
  });
}

/**
 * Source without comments (block, HTML and line). A `//` is a line comment
 * only at a line start or after whitespace, so a URL in a string stays code.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/**
 * A hex colour: `#` plus 3, 4, 6 or 8 hex digits, not part of a longer word.
 * `&#123;` (an HTML entity) and Svelte blocks (`{#each}`, `{#if}`) don't match.
 */
const HEX = /(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/;
const hasHex = (src: string) => HEX.test(stripComments(src));

const rel = (f: string) => f.slice(SRC.length + 1);

describe('no hex colours in components', () => {
  const withHex = svelteFiles(SRC)
    .filter((f) => hasHex(readFileSync(f, 'utf8')))
    .map(rel)
    .sort();

  it('only allow-listed .svelte files have hex literals', () => {
    expect(withHex.filter((f) => !ALLOWED.includes(f))).toEqual([]);
  });

  it('the allow list has no clean files (remove a file once it uses tokens)', () => {
    expect(ALLOWED.filter((f) => !withHex.includes(f))).toEqual([]);
  });

  it('the scan sees colours and skips non-colours (sanity)', () => {
    expect(hasHex('.a { color: #fff; }')).toBe(true);
    expect(hasHex('.a { background: #2d364080 }')).toBe(true);
    expect(hasHex("const c = '#ff7a6b';")).toBe(true);
    expect(hasHex('<path fill="#abcd" />')).toBe(true);
    expect(hasHex('{#each xs as x}{#if y}{/if}{/each}')).toBe(false);
    expect(hasHex('<span>&#123;</span>')).toBe(false);
    expect(hasHex('/* was #fff */ .a { color: var(--text) }')).toBe(false);
    expect(hasHex('<!-- #fff --><p>x</p>')).toBe(false);
    expect(hasHex('x(); // #fff')).toBe(false);
    expect(hasHex('<a href="#top">')).toBe(false);
    expect(hasHex('#12345')).toBe(false);
  });
});
