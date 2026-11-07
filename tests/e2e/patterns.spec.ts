import { expect, test, type Page } from '@playwright/test';

// Pattern picker, PAT/SONG toggle and song-aware playheads (plan 4, Task 4).

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByTestId('pattern-picker')).toBeVisible(); // default drum track is selected
}

const on = (page: Page, id: string) => page.getByTestId(id).getAttribute('aria-pressed');

test('new pattern, edit, switch back', async ({ page }) => {
  await start(page);
  await expect(page.getByTestId('panel-title')).toContainText('· Pattern 1');
  await page.getByTestId('step-0-0').click();
  await expect(page.getByTestId('step-0-0')).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('pattern-new').click();
  await expect(page.getByTestId('panel-title')).toContainText('· Pattern 2');
  await expect(page.getByTestId('step-0-0')).toHaveAttribute('aria-pressed', 'false'); // empty
  await page.getByTestId('step-0-5').click();
  await expect(page.getByTestId('step-0-5')).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('pattern-picker').selectOption({ label: 'Pattern 1' });
  await expect(page.getByTestId('step-0-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('step-0-5')).toHaveAttribute('aria-pressed', 'false');

  // Playback follows the selection: the engine plays the current pattern, and
  // the playhead shows in the step grid in Pattern mode.
  await page.getByRole('button', { name: /Play/ }).click();
  await expect(page.locator('.cell.playhead').first()).toBeVisible();
  await page.getByTestId('pattern-picker').selectOption({ label: 'Pattern 2' });
  await expect(page.getByTestId('step-0-5')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cell.playhead').first()).toBeVisible();
  const errs = await page.evaluate(() => (window as any).__daw.engine.failure);
  expect(errs).toBeNull();
});

test('rename: Enter commits, Escape cancels, empty rejected; delete guards', async ({ page }) => {
  await start(page);
  await expect(page.getByTestId('pattern-delete')).toBeDisabled();
  await expect(page.getByTestId('pattern-delete')).toHaveAttribute('title', 'A track needs at least one pattern');
  await page.getByTestId('pattern-dup').click();
  await expect(page.getByTestId('panel-title')).toContainText('· Pattern 1 copy');

  await page.getByTestId('pattern-rename').click();
  const input = page.getByTestId('pattern-rename-input');
  await input.fill('Verse');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('panel-title')).toContainText('· Pattern 1 copy');

  await page.getByTestId('pattern-rename').click();
  await input.fill('   ');
  await page.keyboard.press('Enter');
  await expect(input).toBeVisible(); // rejected
  await input.fill('Verse');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('panel-title')).toContainText('· Verse');
  await expect(page.getByTestId('pattern-delete')).toBeEnabled();

  // Referenced by a clip: delete disabled with the count.
  await page.evaluate(() => {
    const d = (window as any).__daw;
    const t = d.project.tracks[0];
    d.engine.send(d.Op.CLIP_SET, t.slot * 256, t.patterns.find((x: any) => x.id === t.currentPatternId).engineIdx, 0, 3840);
    t.clips.push({ id: 'c1', idx: 0, patternId: t.currentPatternId, start: 0, len: 3840, offset: 0 });
  });
  await expect(page.getByTestId('pattern-delete')).toBeDisabled();
  await expect(page.getByTestId('pattern-delete')).toHaveAttribute('title', 'Used by 1 clip');
});

test('PAT/SONG toggle visible and switches mode', async ({ page }) => {
  await start(page);
  const mode = () => page.evaluate(() => (window as any).__daw.project.mode);
  await expect(page.getByTestId('mode-toggle')).toBeVisible();
  expect(await mode()).toBe('pattern');
  await expect(page.getByTestId('loop-toggle')).toBeDisabled();
  await page.getByTestId('mode-song').click();
  expect(await mode()).toBe('song');
  await expect(page.getByTestId('mode-song')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('loop-toggle')).toBeEnabled();
  await expect(page.getByTestId('rec-button')).toBeDisabled();
  await expect(page.getByTestId('rec-button')).toHaveAttribute('title', 'Recording works in Pattern mode');
  await page.getByTestId('mode-pat').click();
  expect(await mode()).toBe('pattern');

  // Shift+L toggles; plain L stays a piano key (no mode change).
  await page.keyboard.press('l');
  expect(await mode()).toBe('pattern');
  await page.keyboard.press('Shift+L');
  expect(await mode()).toBe('song');
  await page.keyboard.press('Shift+L');
  expect(await mode()).toBe('pattern');
});

test('Song mode playhead only shows while a clip of the pattern plays', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const d = (window as any).__daw;
    const t = d.project.tracks[0];
    // Clip at bar 2 (song tick 3840) for one bar of pattern 0.
    d.engine.send(d.Op.CLIP_SET, t.slot * 256, 0, 3840, 3840);
    t.clips.push({ id: 'c1', idx: 0, patternId: t.currentPatternId, start: 3840, len: 3840, offset: 0 });
  });
  await page.getByTestId('mode-song').click();
  await page.getByRole('button', { name: /Play/ }).click();
  // Bar 1 is empty: no column; then the clip starts and the playhead appears.
  await expect(page.locator('.cell.playhead').first()).toBeVisible({ timeout: 6000 });
  await expect(page.locator('.cell.playhead').first()).toBeHidden({ timeout: 6000 }); // after the clip ends
});
