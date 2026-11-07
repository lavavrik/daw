// Guard: the spec says "no modal dialogs". Every confirmation is the inline
// popover (InlineConfirm.svelte); a native confirm() call anywhere else in
// app/src fails this test. Comments and test files are ignored; beforeunload
// (the browser's own close-tab prompt) is not a confirm() call.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) return files(f);
    return /\.(ts|svelte)$/.test(n) && !/\.test\.ts$/.test(n) ? [f] : [];
  });
}

/** Source without comments (block, line and HTML) -- good enough for a grep. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('no native confirm()', () => {
  it('app/src has no confirm( call outside InlineConfirm', () => {
    const bad = files(SRC)
      .filter((f) => !f.endsWith('InlineConfirm.svelte'))
      .filter((f) => /(^|[^\w$])confirm\s*\(/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(SRC.length + 1));
    expect(bad).toEqual([]);
  });

  it('the scan sees the code (sanity: it would catch window.confirm)', () => {
    expect(/(^|[^\w$])confirm\s*\(/.test(stripComments('x = window.confirm("a")'))).toBe(true);
    expect(/(^|[^\w$])confirm\s*\(/.test(stripComments('// confirm(x)\nonconfirm(x)'))).toBe(false);
  });
});
