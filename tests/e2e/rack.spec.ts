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

/**
 * Worst distance (px) from each cable plug to the jack of ITS OWN cable (plug
 * 2k is cable k's output end, 2k+1 its input end: the SVG draws track.cables
 * in order); and the plug count, which must be 2 per cable (n = 0 otherwise,
 * so the callers' n > 0 check also catches a missing or extra plug).
 */
async function plugError(page: Page) {
  return page.evaluate(() => {
    type Cable = { from: { m: number; port: number }; to: { m: number; port: number } };
    const tracks = (window as unknown as { __daw: { project: { tracks: { cables?: Cable[] }[] } } }).__daw.project.tracks;
    const cables = tracks[1].cables ?? [];
    const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const jack = (m: number, dir: string, port: number) => {
      const el = document.querySelector(`[data-jack][data-m="${m}"][data-dir="${dir}"][data-port="${port}"]`);
      return el ? centre((el.querySelector('.hole') ?? el).getBoundingClientRect()) : null;
    };
    const plugs = [...document.querySelectorAll('[data-testid="cables"] circle')].map((c) => centre(c.getBoundingClientRect()));
    if (plugs.length !== cables.length * 2) return { worst: Infinity, n: 0 };
    let worst = 0;
    cables.forEach((c, k) => {
      const ends = [jack(c.from.m, 'out', c.from.port), jack(c.to.m, 'in', c.to.port)];
      ends.forEach((j, e) => {
        const p = plugs[2 * k + e];
        worst = Math.max(worst, j ? Math.hypot(j.x - p.x, j.y - p.y) : Infinity);
      });
    });
    return { worst, n: plugs.length };
  });
}

/** Distinct panel rows (top edges, scroll-corrected). */
const rowCount = (page: Page) =>
  page.locator('[data-testid^="module-"]').evaluateAll((els) =>
    new Set(els.map((e) => Math.round(e.getBoundingClientRect().top + e.closest('[data-testid=rail]')!.scrollTop))).size);

test('cables follow wrapped rows', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await loadSax(page);

  // Panels wrap: at least two distinct rows.
  const rows = await rowCount(page);
  expect(rows).toBeGreaterThanOrEqual(2);

  // No horizontal scroll.
  const noHScroll = () => page.getByTestId('rail').evaluate((r) => r.scrollWidth <= r.clientWidth + 1);
  expect(await noHScroll()).toBe(true);

  // Plugs sit on jacks (poll: measure() runs a frame after layout).
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 4; }).toBe(true);

  // Resize wider: rows re-flow, plugs follow.
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect.poll(() => rowCount(page)).toBeLessThan(rows); // it really re-flowed
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 4; }).toBe(true);
  expect(await noHScroll()).toBe(true);
});
