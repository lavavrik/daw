import { expect, test } from '@playwright/test';
import { addTrack } from './addTrack';

// The top bar degrades gracefully on narrow windows (plan 7 Task 5): nothing
// is clipped off the right edge; less important readouts get shorter first,
// and below that the bar wraps onto a second row (never at 1280 px and up,
// where a wrap would move the editors when playback starts). The essentials
// stay visible at every width.

// (Rec and Count-in moved to the bottom panel's pattern transport in plan 20;
// rec-button stands for it.)
const ESSENTIAL = ['project-menu', 'undo', 'redo', 'play', 'rec-button', 'settings-button'];

for (const width of [1440, 1280, 1024]) {
  test(`top bar fits at ${width} px: no control is clipped`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Click to start audio' }).click();
    await expect(page.getByTestId('play')).toBeVisible();
    // No tracks: Keys shows "(no track)" (synth or drum: a selected drum
    // track takes the keys since plan 15); plus an unsaved project (the
    // removal is an edit) and playing.
    await page.getByTestId('track-0').hover();
    await page.getByRole('button', { name: 'Remove track Drums' }).click();
    await page.getByTestId('inline-confirm-ok').click();
    await expect(page.getByTestId('track-0')).toHaveCount(0);
    await expect(page.getByTestId('keys-target')).toContainText('(no track)');
    await page.getByTestId('play').click();
    await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'true');
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
    await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'true');
    // An edit makes it unsaved (Play alone does not: a transport switch is no edit).
    await page.evaluate(() => {
      const d = window.__daw as unknown as { project: { tracks: { id: string }[] }; actions: { setMix: (t: string, p: string, v: number) => void } };
      d.actions.setMix(d.project.tracks[0].id, 'pan', 0.25);
    });
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


// The bottom panel's header (plan 20: the pattern transport made it wider):
// one row from 1280 px, wrapped below that, never wider than the panel.
for (const width of [1280, 1024]) {
  test(`bottom panel header fits at ${width} px: every tab reachable, no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Click to start audio' }).click();
    await addTrack(page, 'synth'); // the longer title ("Deep Bass · Pattern 1")
    await expect(page.getByTestId('pattern-play')).toBeEnabled();
    const out = await page.evaluate(() => {
      const head = document.querySelector('section.pane > .head') as HTMLElement;
      const tabs = [...head.querySelectorAll('.tabs > button')].map((b) => b.getBoundingClientRect());
      const h = head.getBoundingClientRect();
      return {
        docWidth: document.documentElement.scrollWidth,
        overflow: head.scrollWidth - head.clientWidth,
        tabsInside: tabs.every((r) => r.left >= h.left - 0.5 && r.right <= h.right + 0.5),
        height: h.height,
      };
    });
    expect(out.docWidth).toBeLessThanOrEqual(width);
    expect(out.overflow).toBeLessThanOrEqual(0);
    expect(out.tabsInside).toBe(true);
    if (width >= 1280) expect(out.height, 'one row at 1280 px').toBeLessThan(40);
    for (const name of ['Step grid', 'Piano roll', 'Acid', 'Instrument', 'Mixer', 'Clip']) {
      await expect(page.locator('section.pane > .head .tabs').getByRole('button', { name, exact: true })).toBeInViewport();
    }
    for (const id of ['pattern-play', 'pattern-stop', 'rec-button', 'count-in', 'pattern-pos', 'pattern-picker']) {
      await expect(page.getByTestId(id)).toBeInViewport();
    }
  });
}
