import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// Pattern picker, the song and pattern transports (plan 20; the PAT/SONG
// toggle until then) and song-aware playheads (plan 4, Task 4).

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
  await page.getByTestId('pattern-play').click();
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

test('song and pattern transports: starting either stops the other; the readout follows the pattern', async ({ page }) => {
  await start(page);
  const state = () => page.evaluate(() => {
    const p = (window as any).__daw.project;
    return `${p.mode}:${p.playing ? 'playing' : 'stopped'}`;
  });
  const song = page.getByTestId('play');
  const patPlay = page.getByTestId('pattern-play');
  const pos = page.getByTestId('pattern-pos');
  await expect(page.getByTestId('mode-toggle')).toHaveCount(0); // the PAT/SONG switch is gone
  await expect(pos).toHaveText('– / 1'); // the default kit's pattern: 16 steps = 1 bar
  await expect(page.getByTestId('pattern-stop')).toBeEnabled(); // idle, not disabled (a no-op while stopped)

  // Pattern Play: Pattern mode, the readout runs (bar.beat / bars).
  await patPlay.click();
  await expect.poll(state).toBe('pattern:playing');
  await expect(patPlay).toHaveAttribute('aria-pressed', 'true');
  await expect(pos).toHaveText(/^1\.[1-4] \/ 1$/);
  await expect(song).toHaveAttribute('aria-pressed', 'false'); // the song transport is not the one running

  // Song Play stops the pattern, sets Song mode and plays.
  await song.click();
  await expect.poll(state).toBe('song:playing');
  await expect(song).toHaveAttribute('aria-pressed', 'true');
  await expect(patPlay).toHaveAttribute('aria-pressed', 'false');
  await expect(pos).toHaveText('– / 1');
  // While the song plays Rec can't arm (Song mode never records); R says why.
  await expect(page.getByTestId('rec-button')).toBeDisabled();
  await page.locator('body').press('r');
  await expect(page.getByTestId('flash-hint')).toHaveText('Recording works with the pattern transport: stop the song first');
  await expect(page.getByTestId('rec-button')).toHaveAttribute('aria-pressed', 'false');

  // Pattern Play stops the song.
  await patPlay.click();
  await expect.poll(state).toBe('pattern:playing');
  await expect(song).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('pattern-stop').click();
  await expect.poll(state).toBe('pattern:stopped');
  await page.getByTestId('pattern-stop').click(); // stopped: a no-op
  await expect.poll(state).toBe('pattern:stopped');

  // The song ran last (mode Song), stopped: arming switches to Pattern mode, so the next pattern Play records.
  await song.click();
  await song.click();
  await expect.poll(state).toBe('song:stopped');
  await expect(page.getByTestId('loop-toggle')).toBeEnabled(); // Loop belongs to the song transport, whatever ran last
  await page.getByTestId('rec-button').click();
  await expect(page.getByTestId('rec-button')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(state).toBe('pattern:stopped');
  await page.getByTestId('rec-button').click();

  // Shift+L is no longer a mode toggle.
  await page.locator('body').press('Shift+L');
  await expect.poll(state).toBe('pattern:stopped');
});

test('Space stops what plays; stopped, it plays the pattern with focus in the bottom panel, the song elsewhere; it types in a text field', async ({ page }) => {
  await start(page);
  const state = () => page.evaluate(() => {
    const p = (window as any).__daw.project;
    return `${p.mode}:${p.playing ? 'playing' : 'stopped'}`;
  });
  // Focus on a step cell (inside the bottom panel): the pattern transport.
  await page.getByTestId('step-0-3').focus();
  await page.keyboard.press('Space');
  await expect.poll(state).toBe('pattern:playing');
  await expect(page.getByTestId('step-0-3')).toHaveAttribute('aria-pressed', 'false'); // Space did not click the cell
  await page.keyboard.press('Space');
  await expect.poll(state).toBe('pattern:stopped');
  // Clicking a step cell puts focus there too (its pointerdown is cancelled, so the grid focuses it).
  await page.getByTestId('step-0-3').click();
  await expect(page.getByTestId('step-0-3')).toBeFocused();
  await page.getByTestId('step-0-3').click(); // back off
  // Focus outside the panel (the top bar's Play): the song transport.
  await page.getByTestId('play').focus();
  await page.keyboard.press('Space');
  await expect.poll(state).toBe('song:playing');
  // While a transport plays, Space stops it, wherever the focus is (here: in the panel).
  await page.getByTestId('step-0-3').focus();
  await page.keyboard.press('Space');
  await expect.poll(state).toBe('song:stopped');
  await page.keyboard.press('Space'); // stopped, in the panel: the pattern
  await expect.poll(state).toBe('pattern:playing');
  await page.getByTestId('play').focus();
  await page.keyboard.press('Space'); // the pattern plays: Space (from the top bar) stops it
  await expect.poll(state).toBe('pattern:stopped');

  // Controls that give the focus back (the pattern picker blurs after a pick)
  // leave it on the page: the panel, used last, still owns Space.
  await page.getByTestId('pattern-new').click(); // Pattern 2
  await page.getByTestId('play').focus(); // the top bar was used last
  const picker = page.getByTestId('pattern-picker');
  await picker.focus();
  await picker.selectOption({ label: 'Pattern 1' });
  await expect(picker).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(state).toBe('pattern:playing');
  await page.keyboard.press('Space');
  await expect.poll(state).toBe('pattern:stopped');
  // ... and once the top bar is used (a click there), the song again.
  await page.getByTestId('keys-target').click(); // a non-focusable pill: the focus stays on the page
  await page.keyboard.press('Space');
  await expect.poll(state).toBe('song:playing');
  await page.keyboard.press('Space');
  await expect.poll(state).toBe('song:stopped');

  // The pattern-name field (Rename) is inside the panel: Space types a space, no transport.
  await page.getByTestId('pattern-rename').click();
  const input = page.getByTestId('pattern-rename-input');
  await expect(input).toBeFocused();
  await input.fill('Main');
  await page.keyboard.press('Space');
  await page.keyboard.type('groove');
  await expect(input).toHaveValue('Main groove');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('panel-title')).toContainText('· Main groove');
  expect(await state()).toBe('song:stopped');
  // A select in the panel (the pattern picker) keeps Space too.
  await page.getByTestId('pattern-picker').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  expect(await state()).toBe('song:stopped');
});

test('the pattern transport is disabled, with a reason, on an audio track or with no track selected', async ({ page }) => {
  await start(page);
  await expect(page.getByTestId('pattern-play')).toBeEnabled();
  // Remove the only (drum) track: nothing is selected.
  await page.getByTestId('track-0').hover();
  await page.getByRole('button', { name: 'Remove track Drums' }).click();
  await page.getByTestId('inline-confirm-ok').click();
  await expect(page.getByTestId('track-0')).toHaveCount(0);
  for (const id of ['pattern-play', 'pattern-stop', 'rec-button', 'count-in']) await expect(page.getByTestId(id)).toBeDisabled();
  await expect(page.getByTestId('pattern-play')).toHaveAttribute('title', 'Select a drum or synth track');
  await expect(page.getByTestId('pattern-pos')).toHaveText('– / –');
  // R follows Rec's guard: nothing to record into, so it only says why.
  await page.locator('body').press('r');
  await expect(page.getByTestId('flash-hint')).toHaveText('Select a drum or synth track');
  await expect(page.getByTestId('rec-button')).toHaveAttribute('aria-pressed', 'false');
  // An audio track has no pattern.
  await page.getByTestId('add-audio-track').click();
  await expect(page.getByTestId('pattern-play')).toBeDisabled();
  await expect(page.getByTestId('pattern-play')).toHaveAttribute('title', 'An audio track has no pattern: select a drum or synth track');
  // Space in the panel then plays nothing (it says why); the song transport still works.
  await page.getByTestId('tab-clip').focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('flash-hint')).toHaveText('Select a drum or synth track to play its pattern');
  expect(await page.evaluate(() => (window as any).__daw.project.playing)).toBe(false);
});

test('Song mode playhead only shows while a clip of the pattern plays', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const d = (window as any).__daw;
    // Clip at bar 2 (song tick 3840) for one bar of the current pattern.
    d.actions.addClip(d.project.tracks[0].id, { start: 3840, len: 3840 });
  });
  // Song Play then Stop: Song mode, stopped.
  await page.getByTestId('play').click();
  await page.getByTestId('play').click();
  // Stopped, the hint never shows (it would overlay the editor's top for nothing).
  await expect(page.getByTestId('song-hint')).toBeHidden();
  // The hint is an overlay: toggling it must never move the editor.
  const gridTop = () => page.locator('.cell').first().evaluate((el) => el.getBoundingClientRect().top);
  const top = await gridTop();
  await page.getByTestId('play').click();
  // Bar 1 is empty: no column and the hint shows; then the clip starts and the playhead appears.
  await expect(page.getByTestId('song-hint')).toBeVisible();
  expect(await gridTop()).toBe(top);
  await expect(page.locator('.cell.playhead').first()).toBeVisible({ timeout: 6000 });
  await expect(page.getByTestId('song-hint')).toBeHidden();
  expect(await gridTop()).toBe(top);
  await expect(page.locator('.cell.playhead').first()).toBeHidden({ timeout: 6000 }); // after the clip ends
});
