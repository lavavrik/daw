import { expect, test, type Page } from '@playwright/test';

// Plan 13 Task 2: the Instrument rack wraps into rows (like VCV Rack) instead
// of one long horizontal rail, and the cables follow the jacks after a wrap and
// after a window resize.

async function loadSax(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
  await page.getByTestId('add-synth-track').click();
  await page.getByRole('button', { name: 'Instrument' }).click();
  await page.getByTestId('patch-select').selectOption('Sax');
  await expect(page.locator('[data-testid^="module-"]').nth(9)).toBeVisible();
}

/** Worst distance (px) from a cable plug circle to the nearest jack hole centre; and the plug count. */
async function plugError(page: Page) {
  return page.evaluate(() => {
    const centres = [...document.querySelectorAll('[data-jack]')].map((el) => {
      const r = (el.querySelector('.hole') ?? el).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const plugs = [...document.querySelectorAll('[data-testid="cables"] circle')].map((c) => {
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    let worst = 0;
    for (const p of plugs) worst = Math.max(worst, Math.min(...centres.map((c) => Math.hypot(c.x - p.x, c.y - p.y))));
    return { worst, n: plugs.length };
  });
}

test('cables follow wrapped rows', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await loadSax(page);

  // Panels wrap: at least two distinct rows.
  const tops = await page.locator('[data-testid^="module-"]').evaluateAll((els) =>
    new Set(els.map((e) => Math.round(e.getBoundingClientRect().top + (e.closest('[data-testid=rail]')!.scrollTop)))).size);
  expect(tops).toBeGreaterThanOrEqual(2);

  // No horizontal scroll.
  const noHScroll = () => page.getByTestId('rail').evaluate((r) => r.scrollWidth <= r.clientWidth + 1);
  expect(await noHScroll()).toBe(true);

  // Plugs sit on jacks (poll: measure() runs a frame after layout).
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 4; }).toBe(true);

  // Resize wider: rows re-flow, plugs follow.
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 4; }).toBe(true);
  expect(await noHScroll()).toBe(true);
});
