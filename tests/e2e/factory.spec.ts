import { expect, test, type Page } from '@playwright/test';
import { startApp } from './startApp';

// Factory patterns (plan 25 Task 2; app/src/state/factoryPatterns.ts): the
// pattern header's Load popover (ui/LibraryList.svelte) lists the built-in
// patterns of the selected track's kind under "Factory" (Drums for a drum
// track; Bass and Chords for a synth track). A load makes a NEW pattern as
// one undo entry; drum rows map by role. The data itself (A minor, ranges,
// every kit) is unit-tested in factoryPatterns.test.ts and the load path in
// pattern-library.test.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
/** Run `fn` on window.__daw in the page (its source is sent: it must not close over test variables). */
const daw = (page: Page, fn: (d: Any, arg?: Any) => unknown, arg?: unknown) => page.evaluate(`(${fn.toString()})(window.__daw, ${JSON.stringify(arg)})`);

const KIT = ['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc'];

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  // The starter kit lands asynchronously: wait for its rows.
  for (const [i, name] of KIT.entries()) await expect(page.getByTestId(`row-${i}`).getByTestId('row-name')).toHaveText(name);
}

const undoLabel = (page: Page) => daw(page, (d) => d.history?.labels.undo ?? null);
/** Step indices that are on in row `row` of the selected track's current pattern. */
const onSteps = (page: Page, row: number) =>
  daw(page, (d: Any, row: number) => {
    const t = d.project.tracks.find((x: Any) => x.id === d.project.selectedTrackId);
    const pat = t.patterns.find((x: Any) => x.id === t.currentPatternId);
    return pat.steps[row].flatMap((v: number, i: number) => (v > 0 ? [i] : []));
  }, row);

/** Opens the header's Load popover; returns it. */
async function openLoad(page: Page) {
  await page.getByTestId('pattern-load').click();
  const pop = page.getByTestId('pattern-library-pop');
  await expect(pop).toBeVisible();
  return pop;
}

test('Load ▸ Factory ▸ Garage 2-step on the drum track: a new pattern with the kick and snare by role, in one undo', async ({ page }) => {
  await start(page);
  const pop = await openLoad(page);
  // A drum track: Drums only.
  await expect(pop.getByTestId('factory-heading')).toHaveText('Factory');
  await expect(pop.getByTestId('factory-drums')).toBeVisible();
  await expect(pop.getByTestId('factory-bass')).toHaveCount(0);
  await expect(pop.getByTestId('factory-chords')).toHaveCount(0);
  await expect(pop.getByTestId('factory-drums').getByTestId('factory-load')).toHaveCount(12);

  await pop.getByTestId('factory-load').filter({ hasText: 'Garage 2-step' }).click();
  await expect(pop).toBeHidden(); // a load closes the popover
  await expect(page.getByTestId('pattern-picker').locator('option:checked')).toHaveText('Garage 2-step');
  await expect(page.getByTestId('pattern-picker').locator('option')).toHaveCount(2);
  expect(await onSteps(page, 0)).toEqual([0, 10, 16, 26, 29]); // Kick
  expect(await onSteps(page, 4)).toEqual([4, 7, 12, 14, 20, 26, 28, 31]); // Snare (ghosts on 7, 14, 26, 31)
  expect(await onSteps(page, 1)).toEqual([]); // no clap in a 2-step
  for (const s of [0, 10, 29]) await expect(page.getByTestId(`step-0-${s}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('step-4-12')).toHaveAttribute('aria-pressed', 'true');
  expect(await daw(page, (d) => {
    const t = d.project.tracks.find((x: Any) => x.id === d.project.selectedTrackId);
    const pat = t.patterns.find((x: Any) => x.id === t.currentPatternId);
    return [pat.stepCount, pat.swing, d.project.patternLibrary.length];
  })).toEqual([32, 0.5, 0]); // the project's library is not touched
  await expect.poll(() => undoLabel(page)).toBe('Load factory pattern');

  // One undo: the loaded pattern is gone, Pattern 1 is current again.
  await page.locator('body').click({ position: { x: 5, y: 400 } }); // the focus off any field
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('pattern-picker').locator('option')).toHaveCount(1);
  await expect(page.getByTestId('pattern-picker').locator('option:checked')).toHaveText('Pattern 1');
  expect(await onSteps(page, 0)).toEqual([]);
});

test('a synth track lists Bass and Chords, no Drums; "Offbeat" on a bass patch makes notes and plays', async ({ page }) => {
  await start(page);
  // A synth track on the Sub Bass patch (house patches; it is selected).
  await daw(page, (d) => d.actions.addSynthTrack('Sub Bass'));
  await expect.poll(() => daw(page, (d) => d.project.tracks.find((x: Any) => x.id === d.project.selectedTrackId)?.patchName)).toBe('Sub Bass');

  const pop = await openLoad(page);
  await expect(pop.getByTestId('factory-drums')).toHaveCount(0);
  await expect(pop.getByTestId('factory-bass').getByTestId('factory-load')).toHaveCount(8);
  await expect(pop.getByTestId('factory-chords').getByTestId('factory-load')).toHaveCount(8);
  await pop.getByTestId('factory-bass').getByTestId('factory-load').filter({ hasText: 'Offbeat' }).click();
  await expect(pop).toBeHidden();
  await expect(page.getByTestId('pattern-picker').locator('option:checked')).toHaveText('Offbeat');
  const notes = await daw(page, (d) => {
    const t = d.project.tracks.find((x: Any) => x.id === d.project.selectedTrackId);
    const pat = t.patterns.find((x: Any) => x.id === t.currentPatternId);
    return { bars: pat.bars, pitches: pat.notes.map((n: Any) => n.pitch) };
  });
  expect(notes).toEqual({ bars: 2, pitches: [33, 33, 33, 33, 33, 33, 36, 31] });
  await expect.poll(() => undoLabel(page)).toBe('Load factory pattern');

  // It plays: the pattern transport loops it; the master peak rises above 0.02.
  await page.getByTestId('pattern-play').click();
  const peak = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const eng = (window as unknown as { __daw: { engine: { telemetry(): Float64Array } } }).__daw.engine;
        let peak = 0;
        const id = setInterval(() => {
          const t = eng.telemetry();
          peak = Math.max(peak, t[5], t[6]);
        }, 20);
        setTimeout(() => (clearInterval(id), resolve(peak)), 2500);
      }),
  );
  await page.getByTestId('pattern-stop').click();
  expect(peak).toBeGreaterThan(0.02);
});

test('factory rows are read-only: no rename or delete controls, beside the project library rows that have them', async ({ page }) => {
  await start(page);
  // One saved entry, so the list has both kinds of row.
  await page.getByTestId('pattern-save').click();
  await page.getByTestId('pattern-save-input').press('Enter');
  const pop = await openLoad(page);
  await expect(pop.getByTestId('library-entry')).toHaveCount(1);
  await expect(pop.getByTestId('library-entry').getByTestId('library-rename')).toHaveCount(1);
  await expect(pop.getByTestId('library-entry').getByTestId('library-delete')).toHaveCount(1);
  const rows = pop.getByTestId('factory-entry');
  await expect(rows).toHaveCount(12);
  await expect(rows.getByTestId('library-rename')).toHaveCount(0);
  await expect(rows.getByTestId('library-delete')).toHaveCount(0);
  await expect(rows.locator('input')).toHaveCount(0);
  // Each factory row is one button: its load.
  for (let i = 0; i < 12; i++) await expect(rows.nth(i).locator('button')).toHaveCount(1);
});
