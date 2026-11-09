import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// The key, the scale highlight, Snap to key, Transpose… and Fit to key
// (plan 26 Task 1; docs/architecture/theory.md). The maths (every scale,
// ties, edges) is unit-tested in app/src/music/scales.test.ts and the
// actions in app/src/state/key-actions.test.ts; here the real roll is
// driven with the mouse, and the highlight is read off the canvas pixels.

type Note = { id: string; pitch: number; start: number };
type Daw = {
  project: {
    key: { root: number; scale: string };
    tracks: { kind: string; currentPatternId: string; patterns: { id: string; notes: Note[] }[] }[];
  };
  history: { labels: { undo: string | null } } | null;
  autosave: { lastSaved: number | null; flush(): Promise<void> };
};
// Inside page.evaluate reach it as `(window as unknown as W).__daw`.
type W = { __daw: Daw };
type PrView = { ticksPerPx: number; scrollTick: number; rowH: number; topPitch: number; keysW: number; rulerH: number };

const key = (page: Page) => page.evaluate(() => ({ ...(window as unknown as W).__daw.project.key }));
const undoLabel = (page: Page) => page.evaluate(() => (window as unknown as W).__daw.history?.labels.undo ?? null);
/** The synth track's current pattern's notes. */
const notes = (page: Page) => page.evaluate(() => {
  const t = (window as unknown as W).__daw.project.tracks.find((x) => x.kind === 'synth')!;
  return JSON.parse(JSON.stringify(t.patterns.find((x) => x.id === t.currentPatternId)!.notes)) as Note[];
});
const pitches = async (page: Page) => (await notes(page)).map((n) => n.pitch).sort((a, b) => a - b);

async function openRoll(page: Page) {
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  await expect(page.getByRole('button', { name: 'Piano roll' })).toHaveClass(/active/);
  await expect(page.getByTestId('pr-canvas')).not.toHaveAttribute('data-view', '');
}

const view = async (page: Page) => JSON.parse((await page.getByTestId('pr-canvas').getAttribute('data-view'))!) as PrView;

/** Page coordinates of (tick, pitch), vertically mid-row. */
async function at(page: Page, tick: number, pitch: number) {
  const v = await view(page);
  const b = (await page.getByTestId('pr-canvas').boundingBox())!;
  return { x: b.x + v.keysW + (tick - v.scrollTick) / v.ticksPerPx, y: b.y + v.rulerH + (v.topPitch - pitch) * v.rowH + v.rowH / 2 };
}

/** Click to draw a note in the cell holding `tick`. */
async function draw(page: Page, tick: number, pitch: number) {
  const p = await at(page, tick + 30, pitch);
  await page.mouse.click(p.x, p.y);
}

/**
 * The canvas colour [r, g, b] of `pitch`'s row in an empty spot: half a
 * sixteenth into bar 1 (between grid lines), the pointer parked off the grid
 * (no hover highlight).
 */
async function rowColor(page: Page, pitch: number): Promise<number[]> {
  await page.mouse.move(2, 2);
  const v = await view(page);
  const x = v.keysW + (120 - v.scrollTick) / v.ticksPerPx;
  const y = v.rulerH + (v.topPitch - pitch) * v.rowH + v.rowH / 2;
  return page.getByTestId('pr-canvas').evaluate((cv: HTMLCanvasElement, [x, y]) => {
    const dpr = cv.width / cv.getBoundingClientRect().width;
    const d = cv.getContext('2d')!.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
}
const lum = (c: number[]) => c[0] + c[1] + c[2];

/** Pick a key in the "Key ▾" popover (each pick is one "Key" entry), then close it. */
async function pickKey(page: Page, root: number, scale: string) {
  await page.getByTestId('pr-key').click();
  await expect(page.getByTestId('pr-key-pop')).toBeVisible();
  await page.getByTestId('pr-key-root').selectOption(String(root));
  await page.getByTestId('pr-key-scale').selectOption(scale);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pr-key-pop')).toHaveCount(0);
  await expect.poll(() => key(page)).toEqual({ root, scale });
}

async function clearAutosave(page: Page) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const n of ['autosave', 'autosave.tmp']) await root.removeEntry(n, { recursive: true }).catch(() => {});
    localStorage.removeItem('daw.lastExplicitSave');
  });
}

test('A minor (the default) dims C# and tints A; D major dims F and C, not F# or C#; chromatic shows neither', async ({ page }) => {
  await openRoll(page);
  expect(await key(page)).toEqual({ root: 9, scale: 'minor' });
  await expect(page.getByTestId('pr-key')).toContainText('A min');
  const C4 = 60, Cs4 = 61, D4 = 62, E4 = 64, F4 = 65, Fs4 = 66, A3 = 57, A4 = 69, D3 = 50;

  // A minor: C#4 dimmed (darker than the in-key D4), the A rows tinted alike, in-key rows alike.
  const amin = { cs: await rowColor(page, Cs4), d: await rowColor(page, D4), e: await rowColor(page, E4), a3: await rowColor(page, A3), a4: await rowColor(page, A4) };
  expect(lum(amin.cs)).toBeLessThan(lum(amin.d) - 15);
  expect(amin.d).toEqual(amin.e);
  expect(amin.a3).toEqual(amin.a4);
  expect(amin.a3).not.toEqual(amin.d);
  expect(await rowColor(page, Fs4)).toEqual(amin.cs); // every out-of-key row the same

  // D major (F# and C# in key, F and C out): C# is no longer dimmed, F is; D is the root now, A plain.
  await pickKey(page, 2, 'major');
  await expect(page.getByTestId('pr-key')).toContainText('D maj');
  const dmaj = { cs: await rowColor(page, Cs4), fs: await rowColor(page, Fs4), f: await rowColor(page, F4), c: await rowColor(page, C4), e: await rowColor(page, E4), d: await rowColor(page, D4), a3: await rowColor(page, A3) };
  expect(dmaj.cs).toEqual(dmaj.e);
  expect(dmaj.fs).toEqual(dmaj.e);
  expect(lum(dmaj.f)).toBeLessThan(lum(dmaj.e) - 15);
  expect(dmaj.c).toEqual(dmaj.f);
  expect(dmaj.d).toEqual(await rowColor(page, D3));
  expect(dmaj.d).not.toEqual(dmaj.e);
  expect(dmaj.a3).toEqual(dmaj.e);
  await expect.poll(() => undoLabel(page)).toBe('Key');

  // Chromatic: no key shading; the black keys get the classic (lighter) shading back.
  await pickKey(page, 2, 'chromatic');
  const chrom = { cs: await rowColor(page, Cs4), d: await rowColor(page, D4), e: await rowColor(page, E4) };
  expect(chrom.d).toEqual(chrom.e); // the root is not tinted
  expect(lum(chrom.cs)).toBeLessThan(lum(chrom.e)); // a black key
  expect(lum(chrom.cs)).toBeGreaterThan(lum(amin.cs)); // but not dimmed as out of key
  await expect(page.getByTestId('pr-fit-key')).toBeDisabled(); // nothing is out of a chromatic key

  // Each pick was one undo entry: back through chromatic, D major (scale, root) to A minor.
  for (const want of [{ root: 2, scale: 'major' }, { root: 2, scale: 'minor' }, { root: 9, scale: 'minor' }]) {
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => key(page)).toEqual(want);
  }
});

test('Snap to key: drawing on C#4 places D4 (the tie goes up); a drag down one row lands on C4; the toggle is remembered', async ({ page }) => {
  await openRoll(page);
  const snap = page.getByTestId('pr-snap-key');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  // Off: C#4 is drawn as is.
  await draw(page, 0, 61);
  await expect.poll(() => pitches(page)).toEqual([61]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pitches(page)).toEqual([]);

  await snap.click();
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
  await draw(page, 0, 61);
  await expect.poll(() => pitches(page)).toEqual([62]);

  // Drag the new note (from D4) down one row: C#4 is skipped downward, to C4.
  const from = await at(page, 960 + 30, 62);
  await draw(page, 960, 61); // a second D4, at beat 2
  await expect.poll(() => pitches(page)).toEqual([62, 62]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const to = await at(page, 960 + 30, 61);
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await notes(page)).find((n) => n.start === 960)?.pitch).toBe(60);

  // Remembered (localStorage daw.snapToKey).
  await page.reload();
  await startApp(page);
  await addTrack(page, 'synth');
  await expect(page.getByTestId('pr-snap-key')).toHaveAttribute('aria-pressed', 'true');
});

test('Transpose +3 moves the selected notes only; one undo restores them', async ({ page }) => {
  await openRoll(page);
  await draw(page, 0, 60);
  await draw(page, 960, 64);
  await draw(page, 1920, 67);
  await expect.poll(() => pitches(page)).toEqual([60, 64, 67]);
  // Select the first two (Shift-click adds to the selection).
  const a = await at(page, 30, 60);
  const b = await at(page, 960 + 30, 64);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  await expect(page.getByTestId('pr-readout')).toContainText('2 notes selected');

  await page.getByTestId('pr-transpose').click();
  await expect(page.getByTestId('transpose-pop')).toBeVisible();
  await expect(page.getByTestId('transpose-pop')).toContainText('the 2 selected notes');
  await expect(page.getByTestId('transpose-apply')).toBeDisabled(); // 0 st
  await page.getByTestId('transpose-amount').fill('3');
  await expect(page.getByTestId('transpose-value')).toHaveText('+3 st');
  await page.getByTestId('transpose-apply').click();
  await expect(page.getByTestId('transpose-pop')).toHaveCount(0);
  await expect.poll(() => pitches(page)).toEqual([63, 67, 67]);
  await expect.poll(() => undoLabel(page)).toBe('Transpose');

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pitches(page)).toEqual([60, 64, 67]);
});

test('Fit to key moves an out-of-key note to the nearest in-key pitch, in one undo; disabled when all are in key', async ({ page }) => {
  await openRoll(page);
  const fit = page.getByTestId('pr-fit-key');
  await draw(page, 0, 64); // E4: in A minor
  await expect.poll(() => pitches(page)).toEqual([64]);
  await expect(fit).toBeDisabled();
  await draw(page, 960, 66); // F#4: out (F and G both one away: up to G4)
  await draw(page, 1920, 68); // G#4: out (G / A: up to A4)
  await expect(fit).toBeEnabled();
  await fit.click();
  await expect.poll(() => pitches(page)).toEqual([64, 67, 69]);
  await expect.poll(() => undoLabel(page)).toBe('Fit to key');
  await expect(page.getByTestId('pr-readout')).toContainText('Moved 2 notes into the key');
  await expect(fit).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pitches(page)).toEqual([64, 66, 68]);
});

test('the key survives a reload (autosave restore)', async ({ page }) => {
  test.setTimeout(60_000);
  await openRoll(page);
  await pickKey(page, 2, 'dorian');
  await expect
    .poll(() => page.evaluate(async () => {
      await (window as unknown as W).__daw.autosave.flush();
      return (window as unknown as W).__daw.autosave.lastSaved;
    }), { timeout: 15_000 })
    .not.toBeNull();
  await page.reload();
  await startApp(page);
  expect(await key(page)).toEqual({ root: 9, scale: 'minor' }); // a fresh session until Restore
  const offer = page.getByTestId('restore');
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: 'Restore last session' }).click();
  await expect.poll(() => key(page)).toEqual({ root: 2, scale: 'dorian' });
  await page.getByRole('button', { name: 'Piano roll' }).click();
  await expect(page.getByTestId('pr-key')).toContainText('D dor');
  await clearAutosave(page);
});

test('layout at 1280: the piano-roll toolbar stays one row with the key controls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openRoll(page);
  await page.getByTestId('pianoroll').locator('.bar').screenshot({ path: 'test-results/theory-toolbar-1280.png' });
  const bar = await page.getByTestId('pianoroll').locator('.bar').evaluate((el) => {
    const kids = [...el.children].map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0);
    const mid = (r: DOMRect) => r.top + r.height / 2;
    return { oneLine: kids.every((r) => Math.abs(mid(r) - mid(kids[0])) < 4), overflow: el.scrollWidth > el.clientWidth };
  });
  expect(bar).toEqual({ oneLine: true, overflow: false });
  for (const id of ['pr-key', 'pr-snap-key', 'pr-transpose', 'pr-fit-key']) await expect(page.getByTestId(id)).toBeVisible();
});
