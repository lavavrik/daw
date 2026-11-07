// Guard: the spec says "no modal dialogs". Every confirmation is the inline
// popover (InlineConfirm.svelte); a native confirm(), alert() or prompt()
// call anywhere else in app/src fails this test, and so does a reference to
// window/globalThis/self.confirm (an aliased call: `const c = window.confirm`).
// Comments and test files are ignored; beforeunload (the browser's own
// close-tab prompt) is not a confirm() call.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n: string) => {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) return files(f);
    return /\.(ts|svelte)$/.test(n) && !/\.test\.ts$/.test(n) ? [f] : [];
  });
}

/**
 * Source without comments (block, line and HTML) -- good enough for a grep.
 * A `//` is a line comment only at a line start or after whitespace, so a
 * URL in a string ('https://…') is code, not a comment that hides the rest.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** A native dialog: a confirm/alert/prompt call, or confirm read off a global. */
const NATIVE = /(^|[^\w$])(confirm|alert|prompt)\s*\(|\b(window|globalThis|self)\s*\.\s*(confirm|alert|prompt)\b/;
const hasNative = (src: string) => NATIVE.test(stripComments(src));

describe('no native dialogs', () => {
  it('app/src has no confirm/alert/prompt outside InlineConfirm', () => {
    const bad = files(SRC)
      .filter((f) => !f.endsWith('InlineConfirm.svelte'))
      .filter((f) => hasNative(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));
    expect(bad).toEqual([]);
  });

  it('the scan sees the code (sanity)', () => {
    expect(hasNative('x = window.confirm("a")')).toBe(true);
    expect(hasNative('alert("x")')).toBe(true);
    expect(hasNative('const n = prompt ("name")')).toBe(true);
    expect(hasNative('const c = globalThis.confirm; c("a")')).toBe(true);
    expect(hasNative('const u = "https://x"; confirm(u)')).toBe(true); // `//` in a string is not a comment
    expect(hasNative('// confirm(x)\nonconfirm(x)')).toBe(false);
    expect(hasNative('f(); // alert(1)\n/* prompt(2) */')).toBe(false);
    expect(hasNative('onalert(x); doPrompt(y)')).toBe(false);
  });
});
