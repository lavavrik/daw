import { expect, test, type Locator, type Page } from '@playwright/test';
import { startApp } from './startApp';

// Step grid look (plan 20 Task 8, spec §4): velocity fill, accent ring, row
// colours. The rules themselves are unit-tested in app/src/ui/stepGrid.test.ts;
// this checks the component wires them up.

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  await expect(page.getByTestId('step-0-0')).toBeVisible(); // default drum track is selected
}

/** Fill height over cell height (0 when the cell has no fill). */
function fillRatio(page: Page, id: string) {
  return page.getByTestId(id).evaluate((el) => {
    const f = el.querySelector('.fill');
    return f ? f.getBoundingClientRect().height / el.getBoundingClientRect().height : 0;
  });
}

test('a cell fill is velocity / 127 of its height; 110 and up gets the accent ring', async ({ page }) => {
  await start(page);
  // Click = velocity 100; Alt+click = the 60 ghost. Fill = velocity / 127.
  await page.getByTestId('step-0-0').click();
  await page.getByTestId('step-0-1').click({ modifiers: ['Alt'] });
  await expect(page.getByTestId('step-0-1')).toHaveAttribute('aria-pressed', 'true');
  expect(await fillRatio(page, 'step-0-0')).toBeCloseTo(100 / 127, 2);
  expect(await fillRatio(page, 'step-0-1')).toBeCloseTo(60 / 127, 2); // ~47 %
  expect(await fillRatio(page, 'step-0-2')).toBe(0);
  await expect(page.getByTestId('step-0-0')).not.toHaveClass(/\baccent\b/); // 100 reads plain

  // No grid gesture writes 110+ (recording does): set it in state.
  await page.evaluate(() => {
    const t = (window as any).__daw.project.tracks[0];
    const pat = t.patterns.find((x: { id: string }) => x.id === t.currentPatternId);
    pat.steps[0][2] = 120;
  });
  await expect(page.getByTestId('step-0-2')).toHaveClass(/\baccent\b/);
  expect(await fillRatio(page, 'step-0-2')).toBeCloseTo(120 / 127, 2);
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

/**
 * A range's fill edges in px, from the --fill / --fill-pos custom properties
 * it carries (ui/rangeFill.ts), resolved by the browser: --fill as a width
 * in a box as wide as the groove, --fill-pos as a margin in a box as wide as
 * the room beside the fill (CSS's background-position rule). Also where the
 * handle's centre is for the input's value (Chrome: 7.5 px to W − 7.5 px).
 */
function fillEdges(input: Locator) {
  return input.evaluate((el: HTMLInputElement) => {
    const w = el.getBoundingClientRect().width;
    const resolve = (box: number, prop: 'width' | 'marginLeft', v: string) => {
      const outer = document.createElement('div');
      outer.style.cssText = `position:absolute;visibility:hidden;width:${box}px`;
      const inner = document.createElement('div');
      inner.style[prop] = v;
      outer.append(inner);
      document.body.append(outer);
      const px = prop === 'width' ? inner.getBoundingClientRect().width : inner.getBoundingClientRect().left - outer.getBoundingClientRect().left;
      outer.remove();
      return px;
    };
    const cs = getComputedStyle(el);
    const size = resolve(w, 'width', cs.getPropertyValue('--fill').trim() || '0px');
    const left = resolve(w - size, 'marginLeft', cs.getPropertyValue('--fill-pos').trim() || '0px');
    const f = (el.valueAsNumber - Number(el.min)) / (Number(el.max) - Number(el.min));
    return { left, right: left + size, centre: 7.5 + f * (w - 15), mid: w / 2 };
  });
}

test('gain and pan fills end under the handle; pan fills from the centre', async ({ page }) => {
  await start(page);
  const pan = page.getByTestId('row-0').getByRole('slider', { name: /^Pan / });
  for (const v of ['0.6', '-0.35']) {
    await pan.fill(v);
    await expect.poll(() => page.evaluate(() => (window as any).__daw.project.tracks[0].rows[0].pan)).toBeCloseTo(Number(v), 5);
    const e = await fillEdges(pan);
    // From the groove's centre to the handle's centre, on either side.
    expect(Math.min(e.left, e.right)).toBeCloseTo(Math.min(e.mid, e.centre), 0);
    expect(Math.max(e.left, e.right)).toBeCloseTo(Math.max(e.mid, e.centre), 0);
  }
  // Gain fills from the left end to the handle's centre.
  const gain = page.getByTestId('row-0').getByRole('slider', { name: /^Gain / });
  await gain.fill('1.5');
  await expect.poll(() => page.evaluate(() => (window as any).__daw.project.tracks[0].rows[0].gain)).toBeCloseTo(1.5, 5);
  const g = await fillEdges(gain);
  expect(g.left).toBeCloseTo(0, 0);
  expect(g.right).toBeCloseTo(g.centre, 0);
});
