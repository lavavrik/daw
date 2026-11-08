import { expect, test, type Page } from '@playwright/test';

// Step grid look (plan 20 Task 8, spec §4): velocity fill, accent ring, row
// colours. The rules themselves are unit-tested in app/src/ui/stepGrid.test.ts;
// this checks the component wires them up.

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByTestId('step-0-0')).toBeVisible(); // default drum track is selected
}

/** Fill height over cell height (0 when the cell has no fill). */
function fillRatio(page: Page, id: string) {
  return page.getByTestId(id).evaluate((el) => {
    const f = el.querySelector('.fill');
    return f ? f.getBoundingClientRect().height / el.getBoundingClientRect().height : 0;
  });
}

test('a cell fill is as tall as its velocity; 110 and up gets the accent ring', async ({ page }) => {
  await start(page);
  // Click = velocity 100 (full); Alt+click = the 60 ghost.
  await page.getByTestId('step-0-0').click();
  await page.getByTestId('step-0-1').click({ modifiers: ['Alt'] });
  await expect(page.getByTestId('step-0-1')).toHaveAttribute('aria-pressed', 'true');
  expect(await fillRatio(page, 'step-0-0')).toBeCloseTo(1, 2);
  expect(await fillRatio(page, 'step-0-1')).toBeCloseTo(0.6, 2);
  expect(await fillRatio(page, 'step-0-2')).toBe(0);
  await expect(page.getByTestId('step-0-0')).not.toHaveClass(/\baccent\b/); // 100 reads plain

  // No grid gesture writes 110+ (recording does): set it in state.
  await page.evaluate(() => {
    const t = (window as any).__daw.project.tracks[0];
    const pat = t.patterns.find((x: { id: string }) => x.id === t.currentPatternId);
    pat.steps[0][2] = 120;
  });
  await expect(page.getByTestId('step-0-2')).toHaveClass(/\baccent\b/);
  expect(await fillRatio(page, 'step-0-2')).toBeCloseTo(1, 2);
});

test('rows walk the palette from the track slot', async ({ page }) => {
  await start(page);
  const rows = await page.locator('[data-testid^="row-"][role="group"]').count();
  expect(rows).toBeGreaterThan(1);
  const colors = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const slot = (window as any).__daw.project.tracks[0].slot as number;
    const out: { want: string; got: string }[] = [];
    document.querySelectorAll<HTMLElement>('[data-testid^="row-"][role="group"]').forEach((row, r) => {
      out.push({
        want: css.getPropertyValue(`--track-${(slot + r) % 8}`).trim().toLowerCase(),
        got: row.style.getPropertyValue('--c').trim().toLowerCase(),
      });
    });
    return out;
  });
  for (const c of colors) expect(c.got).toBe(c.want);
  expect(new Set(colors.map((c) => c.got)).size).toBe(Math.min(rows, 8));
});
