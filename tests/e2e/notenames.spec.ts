import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';
import { openMenu } from './topbar';

// Solfège note names (plan 21 Task 11, spec §12): Options ▸ Note names ▸
// (a submenu since plan 22; no longer in Audio settings) switches every
// displayed note name (piano roll, Acid) between letters and solfège; the
// choice survives a reload.

/** Options ▸ Note names ▸ <style> (the submenu opens on a click on its item). */
async function pickNames(page: Page, style: 'letters' | 'solfege') {
  await openMenu(page, 'Options');
  if ((await page.getByTestId('menu-notenames').getAttribute('aria-expanded')) !== 'true') await page.getByTestId('menu-notenames').click();
  await page.getByTestId(`menu-notenames-${style}`).click();
}

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

  // Options ▸ Note names ▸ Solfège (the menu stays open: a setting), then Esc.
  await pickNames(page, 'solfege');
  await expect(page.getByTestId('menu-notenames-solfege')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('menu-notenames')).toContainText('Do Re Mi'); // the item shows the current style
  await page.keyboard.press('Escape'); // closes the submenu
  await page.keyboard.press('Escape'); // closes the menu
  await expect(page.locator('#menu-options-panel')).toBeHidden();
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

  // Options ▸ Note names ▸ switches back.
  await openMenu(page, 'Options');
  await page.getByTestId('menu-notenames').click();
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

test('Options ▸ Note names ▸ is a submenu: → / Enter open it on its first entry, ← / Esc go back to its item', async ({ page }) => {
  await page.goto('/');
  await startApp(page);
  await openMenu(page, 'Options');
  const item = page.getByTestId('menu-notenames');
  const letters = page.getByTestId('menu-notenames-letters');
  const solfege = page.getByTestId('menu-notenames-solfege');
  await expect(item).toHaveAttribute('aria-expanded', 'false');
  await expect(letters).toHaveCount(0); // closed: not in the menu's arrow-key list
  await item.focus();
  await page.keyboard.press('ArrowRight');
  await expect(item).toHaveAttribute('aria-expanded', 'true');
  await expect(letters).toBeFocused();
  await expect(letters).toHaveAttribute('aria-pressed', 'true');
  await expect(solfege).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ArrowDown');
  await expect(solfege).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(solfege).toHaveAttribute('aria-pressed', 'true');
  await expect(item).toContainText('Do Re Mi');
  await page.keyboard.press('ArrowLeft');
  await expect(item).toBeFocused();
  await expect(item).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#menu-options-panel')).toBeVisible();
  // Enter on the item opens it too; Esc closes only the submenu.
  await page.keyboard.press('Enter');
  await expect(letters).toBeFocused();
  await page.keyboard.press('Space'); // presses Letters, never the song
  await expect(letters).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(item).toBeFocused();
  await expect(letters).toHaveCount(0);
  await expect(page.locator('#menu-options-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-options-panel')).toBeHidden();
  await expect(page.getByTestId('menu-options')).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __daw: { project: { playing: boolean } } }).__daw.project.playing)).toBe(false);
});
