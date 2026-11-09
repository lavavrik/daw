import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// Solfège note names (plan 21 Task 11, spec §12): Settings and Options ▸
// Keyboard switch every displayed note name (piano roll, Acid) between
// letters and solfège; the choice survives a reload.

async function open(page: Page) {
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  await expect(page.getByTestId('pr-canvas')).not.toHaveAttribute('data-view', '');
}

test('solfège: piano roll, Acid, reload, and back to letters', async ({ page }) => {
  await open(page);
  // Draw a C3 in the roll (the readout names it), and remember the canvas pixels.
  const canvas = page.getByTestId('pr-canvas');
  const v = JSON.parse((await canvas.getAttribute('data-view'))!);
  const b = (await canvas.boundingBox())!;
  await page.mouse.click(b.x + v.keysW + 30 / v.ticksPerPx, b.y + v.rulerH + (v.topPitch - 48) * v.rowH + v.rowH / 2);
  const readout = page.getByTestId('pr-readout');
  await expect(readout).toContainText('C3 ·');
  await page.mouse.move(b.x + b.width - 5, b.y + b.height - 5); // park the pointer off the notes
  const before = await page.screenshot({ clip: { x: b.x, y: b.y, width: Math.min(b.width, 120), height: b.height }, animations: 'allow' });

  // Settings select.
  await page.getByTestId('settings-button').click();
  await page.getByTestId('note-names').selectOption('solfege');
  await page.getByTestId('settings-button').click(); // close the popover
  await expect(page.getByTestId('settings')).toBeHidden();
  await page.mouse.move(b.x + b.width - 5, b.y + b.height - 5);
    await expect.poll(async () => !(await page.screenshot({ clip: { x: b.x, y: b.y, width: Math.min(b.width, 120), height: b.height }, animations: 'allow' })).equals(before)).toBe(true); // the canvas re-rendered
  // Select the note again: the readout shows the solfège name.
  await page.mouse.click(b.x + v.keysW + 30 / v.ticksPerPx, b.y + v.rulerH + (v.topPitch - 48) * v.rowH + v.rowH / 2);
  await expect(readout).toContainText('Do3');

  // Acid: step labels and the key row.
  await page.getByTestId('tab-acid').click();
  await expect(page.getByTestId('acid-base')).toHaveText(/^Do-?\d/);
  await expect(page.getByTestId('acid-key-7')).toHaveText('Sol');
  await expect(page.getByTestId('acid-key-1')).toHaveText('Do♯');

  // Reload keeps it.
  await page.reload();
  await startApp(page);
  await addTrack(page, 'synth'); // the project is not restored; the preference is
  await page.getByTestId('tab-acid').click();
  await expect(page.getByTestId('acid-key-0')).toHaveText('Do');

  // Options ▸ Keyboard switches back.
  await page.getByTestId('menu-options').click();
  await expect(page.getByTestId('menu-notenames-solfege')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('menu-notenames-letters').click();
  await expect(page.getByTestId('acid-key-0')).toHaveText('C');
  await expect(page.getByTestId('acid-key-1')).toHaveText('C#');
  await page.getByTestId('menu-notenames-solfege').click();
  await expect(page.getByTestId('acid-key-0')).toHaveText('Do');
  await page.getByTestId('menu-notenames-letters').click();
  await page.reload();
  await startApp(page);
  await addTrack(page, 'synth'); // the project is not restored; the preference is
  await page.getByTestId('tab-acid').click();
  await expect(page.getByTestId('acid-key-0')).toHaveText('C');
});
