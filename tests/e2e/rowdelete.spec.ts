import { expect, test, type Page } from '@playwright/test';
import { startApp } from './startApp';

// Deleting a drum row (plan 21 task 7): the trash button at the end of each
// step-grid row, faded in on hover / focus but always focusable. One undo
// entry; the engine shifts the rows (OP_REMOVE_ROW) and stops playing the
// deleted one; undo brings it back with its steps. The state rules (every
// pattern, keys, diffApply) are unit-tested in app/src/history/diffApply.test.ts.

type Daw = {
  engine: { telemetry(): Float64Array } | null;
  project: { tracks: { kind: string; rows?: { name: string }[] }[] };
  history: { labels: { undo: string | null; redo: string | null } } | null;
};

const KIT = ['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc'];

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  // The starter kit lands asynchronously: wait for its samples.
  for (const [i, name] of KIT.entries()) await expect(page.getByTestId(`row-${i}`).getByTestId('row-name')).toHaveText(name);
}

const rowNames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks[0].rows!.map((r) => r.name));

/** Max master peak (telemetry[5]) seen over `ms`. */
function maxPeak(page: Page, ms = 1500) {
  return page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        const eng = (window as unknown as { __daw: Daw }).__daw.engine!;
        let max = 0;
        const t0 = performance.now();
        const id = setInterval(() => {
          max = Math.max(max, eng.telemetry()[5]);
          if (performance.now() - t0 > ms) {
            clearInterval(id);
            resolve(max);
          }
        }, 4);
      }),
    ms,
  );
}

test('the delete button shows on row hover and focus, and is labelled', async ({ page }) => {
  await start(page);
  const del = page.getByTestId('row-delete-1');
  await expect(del).toHaveAttribute('aria-label', 'Delete row Clap');
  await expect(del).toHaveAttribute('title', 'Delete row Clap');
  await page.mouse.move(0, 0);
  await expect(del).toHaveCSS('opacity', '0');
  await page.getByTestId('row-1').hover();
  await expect(del).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await expect(del).toHaveCSS('opacity', '0');
  // Keyboard: always in the tab order (Tab from the row's last cell reaches it).
  await page.getByTestId('step-1-15').focus();
  await page.keyboard.press('Tab');
  await expect(del).toBeFocused();
  await expect(del).toHaveCSS('opacity', '1');
});

test('delete the Clap row: it is gone and stops playing; undo brings it back', async ({ page }) => {
  test.setTimeout(30_000);
  await start(page);
  // Only the Clap has steps.
  for (const s of [0, 4, 8, 12]) await page.getByTestId(`step-1-${s}`).click();
  await page.keyboard.press('Space'); // the pattern transport (focus is in the grid)
  expect(await maxPeak(page)).toBeGreaterThan(0.02);

  await page.getByTestId('row-1').hover();
  await page.getByTestId('row-delete-1').click();
  // Gone, the rows below moved up, focus on the next row's delete button.
  await expect(page.getByTestId('row-1').getByTestId('row-name')).toHaveText('Closed hat');
  await expect(page.getByTestId('row-7')).toHaveCount(0);
  expect(await rowNames(page)).toEqual(KIT.filter((n) => n !== 'Clap'));
  await expect(page.getByTestId('row-delete-1')).toBeFocused();
  for (const s of [0, 4, 8, 12]) await expect(page.getByTestId(`step-1-${s}`)).toHaveAttribute('aria-pressed', 'false');
  // The click's gesture commits a task after release: poll, don't read once.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.history?.labels.undo)).toBe('Delete row');
  // Still playing, but nothing has steps any more: silence.
  await page.waitForTimeout(200);
  expect(await maxPeak(page)).toBeLessThan(0.001);

  // Undo (the transport keeps playing): the Clap is back with its steps, and heard.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('row-1').getByTestId('row-name')).toHaveText('Clap');
  expect(await rowNames(page)).toEqual(KIT);
  for (const s of [0, 4, 8, 12]) await expect(page.getByTestId(`step-1-${s}`)).toHaveAttribute('aria-pressed', 'true');
  expect(await maxPeak(page)).toBeGreaterThan(0.02);
  await page.keyboard.press('Space');
});
