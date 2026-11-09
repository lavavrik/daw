import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// Plan 22 Task 2: a module's width never depends on its current values. The
// value chips have a fixed width per control (knobMath widestValue), so
// sweeping a param (Attack's 1 ms .. 10 s changes unit and decimals) leaves
// the module, and so every module to its right, where it was.

const PANELS = '[data-testid^="module-"]:not([data-testid^="module-header-"])';

async function loadPatch(page: Page, patch: string) {
  await page.getByTestId('patch-select').selectOption(patch);
  await expect.poll(() => page.locator(PANELS).count()).toBeGreaterThan(2);
}

async function open(page: Page) {
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByTestId('patch-select')).toBeVisible();
}

/** Every module's rendered width, by its test id. */
const widths = (page: Page) =>
  page.locator(PANELS).evaluateAll((els) =>
    Object.fromEntries(els.map((e) => [e.getAttribute('data-testid')!, Math.round(e.getBoundingClientRect().width * 10) / 10])));

test('sweeping Attack across its range never changes the ADSR width', async ({ page }) => {
  await open(page);
  await loadPatch(page, 'Sax');
  const adsr = page.locator(PANELS).filter({ has: page.locator('[data-testid$="-attack"]') }).first();
  const attack = adsr.locator('[role=slider][data-testid$="-attack"]');
  const before = (await adsr.boundingBox())!.width;
  const readouts = new Set<string>();
  await attack.focus();
  await page.keyboard.press('Home');
  // 1% of travel per press: ~100 presses cover 1 ms .. 10 s, ms -> s and every decimal pattern.
  for (let i = 0; i <= 100; i++) {
    readouts.add((await attack.getByTestId('knob-readout').textContent()) ?? '');
    expect((await adsr.boundingBox())!.width, `at ${[...readouts].pop()}`).toBe(before);
    await page.keyboard.press('ArrowUp');
  }
  // The sweep really did cross units and decimals.
  expect([...readouts].some((t) => t.endsWith(' ms'))).toBe(true);
  expect([...readouts].some((t) => t.endsWith(' s') && !t.endsWith('ms'))).toBe(true);
  expect(new Set([...readouts].map((t) => t.length)).size).toBeGreaterThan(1);
});

test('every house patch module keeps its width when each param goes to min and max', async ({ page }) => {
  test.setTimeout(240_000);
  await open(page);
  const patches = await page.getByTestId('patch-select').evaluate((sel) =>
    [...sel.querySelectorAll('optgroup')].filter((g) => g.label.startsWith('House')).flatMap((g) => [...g.querySelectorAll('option')].map((o) => o.value)));
  expect(patches.length).toBe(12);
  for (const patch of patches) {
    await loadPatch(page, patch);
    const base = await widths(page);
    const sliders = await page.locator(`${PANELS} [role=slider][data-testid^="knob-"]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!));
    for (const id of sliders) {
      const knob = page.getByTestId(id);
      for (const key of ['Home', 'End', 'Home']) {
        await knob.focus();
        await page.keyboard.press(key);
        expect(await widths(page), `${patch} ${id} ${key}`).toEqual(base);
      }
    }
  }
});

test('a mixer strip keeps its width, and its chips stay inside it, at every knob extreme', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  await page.getByTestId('mixer-tab').click();
  const strip = page.getByTestId('strip-1');
  await strip.getByTestId('eq-expand').click();
  await strip.getByTestId('comp-expand').click();
  const base = (await strip.boundingBox())!.width;
  const ids = await strip.locator('[role=slider][data-testid]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!));
  expect(ids.length).toBeGreaterThan(8);
  for (const id of ids) {
    for (const key of ['Home', 'End', 'Home']) {
      await strip.getByTestId(id).first().focus();
      await page.keyboard.press(key);
      expect((await strip.boundingBox())!.width, `${id} ${key}`).toBe(base);
      const inside = await strip.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return [...el.querySelectorAll('.readout')].every((c) => { const b = c.getBoundingClientRect(); return b.left >= r.left - 0.5 && b.right <= r.right + 0.5; });
      });
      expect(inside, `${id} ${key}: a chip pokes out of the strip`).toBe(true);
    }
  }
});
