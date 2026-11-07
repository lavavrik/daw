import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// Pattern picker, PAT/SONG toggle and song-aware playheads (plan 4, Task 4).

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByTestId('pattern-picker')).toBeVisible(); // default drum track is selected
}

/** Max peakL (telemetry slot 5) over `ms`: a short hit is easy to miss with one read. */
function maxPeak(page: Page, ms = 1500) {
  return page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        const eng = (window as any).__daw.engine;
        let max = 0;
        const t0 = performance.now();
        const id = setInterval(() => {
          max = Math.max(max, eng.telemetry()[5]);
          if (performance.now() - t0 > ms) {
            clearInterval(id);
            resolve(max);
          }
        }, 4);
      }),
    ms,
  );
}

async function loadKick(page: Page) {
  await page.evaluate(({ bytes }) => {
    const el = document.querySelector('[data-testid="row-0"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'kick.wav', { type: 'audio/wav' }));
    for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { bytes: [...makeWav()] });
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
}

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

  // Playback follows the selection, proven engine-side by audio: Pattern 1
  // has a kick on step 1, Pattern 2 is empty. Switching while playing must
  // silence / restore the track (fails if SET_CURRENT_PATTERN is never sent).
  await loadKick(page);
  // Start on Pattern 2 with its one step removed, so it is truly empty.
  await page.getByTestId('pattern-picker').selectOption({ label: 'Pattern 2' });
  await page.getByTestId('step-0-5').click();
  await expect(page.getByTestId('step-0-5')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: /Play/ }).click();
  await expect(page.locator('.cell.playhead').first()).toBeVisible();
  // Pattern 2 (current) is empty: a window of two bars (1.94 s each at 124 BPM)
  // must be silent whatever the phase of the loop.
  expect(await maxPeak(page, 4000)).toBeLessThan(0.001);
  // Switching is immediate (SET_CURRENT_PATTERN); a kick hits within one bar.
  await page.getByTestId('pattern-picker').selectOption({ label: 'Pattern 1' });
  expect(await maxPeak(page, 2500)).toBeGreaterThan(0.1);
  // Back to the empty pattern: the switch itself is immediate. Only the tail
  // of the kick already sounding lingers (a short sample), so after a moment
  // the output must stay silent for a whole bar-plus window.
  await page.getByTestId('pattern-picker').selectOption({ label: 'Pattern 2' });
  await page.waitForTimeout(800);
  expect(await maxPeak(page, 2500)).toBeLessThan(0.001);
  expect(await page.evaluate(() => (window as any).__daw.engine.failure)).toBeNull();
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
    d.actions.addClip(d.project.tracks[0].id, { start: 0 });
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
    // Clip at bar 2 (song tick 3840) for one bar of the current pattern.
    d.actions.addClip(d.project.tracks[0].id, { start: 3840, len: 3840 });
  });
  await page.getByTestId('mode-song').click();
  await expect(page.getByTestId('song-hint')).toBeVisible(); // stopped: nothing plays this pattern
  await page.getByRole('button', { name: /Play/ }).click();
  // Bar 1 is empty: no column; then the clip starts and the playhead appears.
  await expect(page.locator('.cell.playhead').first()).toBeVisible({ timeout: 6000 });
  await expect(page.getByTestId('song-hint')).toBeHidden();
  await expect(page.locator('.cell.playhead').first()).toBeHidden({ timeout: 6000 }); // after the clip ends
});
