import { expect, test, type Page } from '@playwright/test';
import { startApp } from './startApp';

// Resizable panes (ui/Splitter.svelte, ui/paneWidths.svelte.ts): the library
// sidebar and the track header column. A UI preference in localStorage.

async function dragBy(page: Page, testid: string, dx: number) {
  const b = (await page.getByTestId(testid).boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + Math.min(60, b.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y);
  await page.mouse.move(x + dx, y);
  await page.mouse.up();
}

test('library and track headers resize, clamp, persist and reset', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await startApp(page);
  const lib = page.getByTestId('library-resize');
  const hdr = page.getByTestId('headers-resize');
  await expect(lib).toHaveAttribute('aria-valuenow', '220');
  await expect(hdr).toHaveAttribute('aria-valuenow', '176');

  await dragBy(page, 'library-resize', 80);
  await expect(lib).toHaveAttribute('aria-valuenow', '300');
  // The timeline's corner follows the header width.
  await dragBy(page, 'headers-resize', 60);
  await expect(hdr).toHaveAttribute('aria-valuenow', '236');
  expect(Math.round((await page.getByTestId('tl-corner').boundingBox())!.width)).toBe(236);
  // Clamped at the minimum.
  await dragBy(page, 'library-resize', -400);
  await expect(lib).toHaveAttribute('aria-valuenow', '180');
  // Keys: 8 px a press.
  await lib.focus();
  await page.keyboard.press('ArrowRight');
  await expect(lib).toHaveAttribute('aria-valuenow', '188');

  // Remembered across a reload.
  await page.reload();
  await startApp(page);
  await expect(page.getByTestId('library-resize')).toHaveAttribute('aria-valuenow', '188');
  await expect(page.getByTestId('headers-resize')).toHaveAttribute('aria-valuenow', '236');

  // Double-click: the default.
  await page.getByTestId('headers-resize').dblclick();
  await expect(page.getByTestId('headers-resize')).toHaveAttribute('aria-valuenow', '176');
});

test('Escape mid-drag puts the width back', async ({ page }) => {
  await page.goto('/');
  await startApp(page);
  const b = (await page.getByTestId('library-resize').boundingBox())!;
  await page.mouse.move(b.x + 3, b.y + 100);
  await page.mouse.down();
  await page.mouse.move(b.x + 103, b.y + 100);
  await expect(page.getByTestId('library-resize')).toHaveAttribute('aria-valuenow', '320');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByTestId('library-resize')).toHaveAttribute('aria-valuenow', '220');
});
