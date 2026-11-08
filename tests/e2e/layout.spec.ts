import { expect, test } from '@playwright/test';

// The top bar degrades gracefully on narrow windows (plan 7 Task 5): nothing
// is clipped off the right edge; less important readouts get shorter first,
// and below that the bar wraps onto a second row (never at 1280 px and up,
// where a wrap would move the editors when playback starts). The essentials
// stay visible at every width.

// (Rec and Count-in moved to the bottom panel's pattern transport in plan 20.)
const ESSENTIAL = ['project-menu', 'undo', 'redo', 'play', 'settings-button'];

for (const width of [1440, 1280, 1024]) {
  test(`top bar fits at ${width} px: no control is clipped`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Click to start audio' }).click();
    await expect(page.getByTestId('play')).toBeVisible();
    // No tracks: Keys shows "(no track)" (synth or drum: a selected drum
    // track takes the keys since plan 15); plus an unsaved project (song
    // Play switches to Song mode, an edit) and playing (Stop is wider than Play).
    await page.getByTestId('track-0').hover();
    await page.getByRole('button', { name: 'Remove track Drums' }).click();
    await page.getByTestId('inline-confirm-ok').click();
    await expect(page.getByTestId('track-0')).toHaveCount(0);
    await expect(page.getByTestId('keys-target')).toContainText('(no track)');
    await page.getByTestId('play').click();
    await expect(page.getByTestId('play')).toContainText('Stop');
    await expect(page.getByTestId('project-name')).toContainText('unsaved');
    const out = await page.evaluate(() => {
      const bar = document.querySelector('header')!;
      const b = bar.getBoundingClientRect();
      const kids = [...bar.children].filter((el) => getComputedStyle(el).display !== 'none') as HTMLElement[];
      return {
        clipped: kids
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > b.right + 0.5 || r.left < b.left - 0.5); })
          .map((el) => el.dataset.testid ?? el.className),
        // One row: no control starts below the bottom of the shortest one.
        rows: (() => {
          const rs = kids.map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
          const minBottom = Math.min(...rs.map((r) => r.bottom));
          return rs.some((r) => r.top >= minBottom) ? 2 : 1;
        })(),
        docWidth: document.documentElement.scrollWidth,
      };
    });
    expect(out.clipped).toEqual([]);
    if (width >= 1280) expect(out.rows, 'one row at 1280 px and wider').toBe(1);
    expect(out.docWidth).toBeLessThanOrEqual(width);
    for (const id of ESSENTIAL) await expect(page.getByTestId(id)).toBeInViewport();
    await expect(page.getByLabel('BPM')).toBeInViewport();
  });
}

// The widest state also has the dropout tail ("· 123 drop": a 3-digit
// count): at 1440 and 1400 px (wide readouts) and at
// 1280 px (the narrow step), with the master spectrum in the bar, it must
// still fit on one row (a wrap mid-session would move everything below).
for (const width of [1440, 1400, 1280]) {
  test(`top bar fits at ${width} px with 123 dropouts, unsaved and playing`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Click to start audio' }).click();
    await expect(page.getByTestId('play')).toBeVisible();
    await page.getByTestId('play').click();
    await expect(page.getByTestId('play')).toContainText('Stop');
    await expect(page.getByTestId('project-name')).toContainText('unsaved');
    // The top bar polls engine.dropouts() at 4 Hz.
    await page.evaluate(() => {
      const e = window.__daw.engine as unknown as { dropouts: () => number };
      e.dropouts = () => 123;
    });
    await expect(page.getByTestId('cpu')).toContainText('123 drop');
    const out = await page.evaluate(() => {
      const bar = document.querySelector('header')!;
      const b = bar.getBoundingClientRect();
      const kids = [...bar.children].filter((el) => getComputedStyle(el).display !== 'none') as HTMLElement[];
      const rs = kids.map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
      const minBottom = Math.min(...rs.map((r) => r.bottom));
      return {
        clipped: kids
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > b.right + 0.5 || r.left < b.left - 0.5); })
          .map((el) => el.dataset.testid ?? el.className),
        rows: rs.some((r) => r.top >= minBottom) ? 2 : 1,
      };
    });
    expect(out.clipped).toEqual([]);
    expect(out.rows, 'one row').toBe(1);
    await expect(page.getByTestId('cpu')).toBeInViewport();
  });
}

