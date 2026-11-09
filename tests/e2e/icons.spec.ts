import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// Plan 21 Task 8: the icon pass must leave no button without an accessible
// name (icon-only buttons carry aria-label / title); the mixer's analyser
// keeps its plan-12 size (the 3x spectrum is the top bar's).

async function start(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await startApp(page);
}

/** Visible buttons whose name (aria-label, text or title) is empty. */
async function unnamed(page: Page): Promise<string[]> {
  return page.locator('button').evaluateAll((els) =>
    (els as HTMLButtonElement[])
      .filter((b) => b.getClientRects().length > 0)
      .filter((b) => !((b.getAttribute('aria-label') || b.textContent || '').trim() || (b.getAttribute('title') || '').trim()))
      .map((b) => b.outerHTML.slice(0, 120)),
  );
}

test('every button has an accessible name across the main views', async ({ page }) => {
  await start(page);
  expect(await unnamed(page), 'song view / step grid').toEqual([]);
  // The song pane's add button opens a list (Task 5); older builds have the button itself.
  if (!(await page.getByTestId('add-synth-track').isVisible())) await page.getByTestId('add-track').click();
  await addTrack(page, 'synth');
  const tabs = page.locator('.tabs .tab');
  await tabs.nth(1).click(); // Piano roll
  await expect(page.getByTestId('pianoroll')).toBeVisible();
  expect(await unnamed(page), 'piano roll').toEqual([]);
  await page.getByTestId('tab-acid').click();
  await expect(page.getByTestId('acid-step-0')).toBeVisible();
  expect(await unnamed(page), 'acid').toEqual([]);
  await tabs.nth(3).click(); // Instrument
  await expect(page.getByTestId('rack-tidy')).toBeVisible();
  expect(await unnamed(page), 'instrument').toEqual([]);
  await page.getByTestId('mixer-tab').click();
  await expect(page.getByTestId('mixer')).toBeVisible();
  expect(await unnamed(page), 'mixer').toEqual([]);
});

test('the mixer analyser keeps its 340 px panel: 320 px spectrum, goniometer stacked under it', async ({ page }) => {
  // The owner's "master spectrum 3x" meant the top bar's (TopBar, 3x); the
  // mixer analyser stays as plan 12 drew it.
  await start(page);
  await page.getByTestId('mixer-tab').click();
  const spec = page.getByTestId('analyser-spectrum');
  await expect(spec).toBeVisible();
  const box = await spec.evaluate((c: HTMLCanvasElement) => ({ css: c.getBoundingClientRect().width, px: c.width, dpr: window.devicePixelRatio }));
  expect(box.css).toBeCloseTo(320, 0);
  expect(box.px).toBe(Math.round(box.css * Math.max(1, Math.round(box.dpr))));
  const s = (await spec.boundingBox())!;
  const gon = (await page.getByTestId('goniometer').boundingBox())!;
  expect(gon.width).toBeCloseTo(120, 0);
  expect(gon.y).toBeGreaterThan(s.y + s.height - 1); // under the spectrum, not beside it
});
