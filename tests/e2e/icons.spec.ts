import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { openMenu } from './topbar';
import { makeWav } from './wav';
import { startApp } from './startApp';

// Plan 21 Task 8: the icon pass must leave no button without an accessible
// name (icon-only buttons carry aria-label / title); the mixer's analyser
// keeps its plan-12 size (the 3x spectrum is the top bar's).

async function start(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await startApp(page);
}

/**
 * Visible buttons without a proper accessible name: no aria-label /
 * aria-labelledby and no text. A `title` alone does not count for an
 * icon-only button (the tooltip layer moves it to data-tip while hovered,
 * and a title is a description, not a name, for many screen readers).
 */
async function unnamed(page: Page): Promise<string[]> {
  return page.locator('button').evaluateAll((els) =>
    (els as HTMLButtonElement[])
      .filter((b) => b.getClientRects().length > 0)
      .filter((b) => !((b.getAttribute('aria-label') || '').trim() || b.getAttribute('aria-labelledby') || (b.textContent || '').trim()))
      .map((b) => b.outerHTML.slice(0, 160)),
  );
}

test('every button has an accessible name across the main views', async ({ page }) => {
  await start(page);
  expect(await unnamed(page), 'song view / step grid').toEqual([]);
  await addTrack(page, 'synth');
  const tabs = page.locator('.tabs .tab');
  await tabs.nth(1).click(); // Piano roll
  await expect(page.getByTestId('pianoroll')).toBeVisible();
  expect(await unnamed(page), 'piano roll').toEqual([]);
  await page.getByTestId('examples-menu').click();
  await expect(page.getByTestId('examples-list')).toBeVisible();
  expect(await unnamed(page), 'piano roll examples').toEqual([]);
  await page.keyboard.press('Escape');
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

test('every button has a name in the drum, sampler and clip views, the settings and an open menu', async ({ page }) => {
  await start(page);
  // The drum track's step grid is the first test's song view (a drum track has no Instrument tab).
  // An open menu (every item of each).
  for (const m of ['File', 'Edit', 'Add', 'Patterns', 'View', 'Options', 'Help'] as const) {
    await openMenu(page, m);
    expect(await unnamed(page), `${m} menu`).toEqual([]);
  }
  await page.keyboard.press('Escape');
  // The audio settings panel (a <details>; its summary is the ⚙ pill).
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  expect(await unnamed(page), 'settings').toEqual([]);
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings')).toBeHidden();
  // A sampler track (dropped on + Add track) and its Instrument view.
  const wav = [...makeWav(220, 300)];
  await page.evaluate((bytes) => {
    const el = document.querySelector('[data-testid="add-track"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'Tone.wav', { type: 'audio/wav' }));
    for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, wav);
  // A sampler track is a synth track with the Sampler patch.
  await expect.poll(() => page.evaluate(() => (window as any).__daw.project.tracks.some((t: any) => t.patchName === 'Sampler'))).toBe(true);
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByTestId('patch-select')).toHaveValue('Sampler');
  expect(await unnamed(page), 'sampler instrument').toEqual([]);
  // An audio track with a clip: the Clip tab.
  await page.evaluate((bytes) => {
    const el = document.querySelector('[data-testid="tl-below"]')!;
    const r = el.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'Loop.wav', { type: 'audio/wav' }));
    for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 14) }));
  }, wav);
  await expect.poll(() => page.evaluate(() => (window as any).__daw.project.tracks.some((t: any) => t.kind === 'audio'))).toBe(true);
  const slot = await page.evaluate(() => (window as any).__daw.project.tracks.find((t: any) => t.kind === 'audio').slot);
  await page.getByTestId(`clip-${slot}-0`).click(); // selects the clip and its track
  await page.getByTestId('tab-clip').click();
  await expect(page.getByTestId('cliptab-panel')).toBeVisible();
  expect(await unnamed(page), 'clip tab').toEqual([]);
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

test('the Browser tab labels fit their buttons at the pane width (220 px)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await startApp(page);
  const fits = await page.locator('[data-testid^="lib-tab-"]').evaluateAll((els) =>
    els.map((b) => ({ id: b.getAttribute('data-testid'), w: b.clientWidth, sw: b.scrollWidth, h: b.clientHeight, sh: b.scrollHeight })));
  expect(fits).toHaveLength(4);
  for (const f of fits) {
    expect(f.sw, `${f.id} overflows`).toBeLessThanOrEqual(f.w);
    expect(f.sh, `${f.id} overflows`).toBeLessThanOrEqual(f.h);
  }
  // And the label is not clipped inside: the text node fits the button.
  const text = await page.locator('[data-testid^="lib-tab-"]').evaluateAll((els) =>
    els.map((b) => {
      const r = document.createRange();
      r.selectNodeContents(b);
      return { id: b.getAttribute('data-testid'), text: r.getBoundingClientRect().width, box: b.getBoundingClientRect().width };
    }));
  for (const t of text) expect(t.text, `${t.id} label`).toBeLessThanOrEqual(t.box);
});
