import { expect, test, type Page } from '@playwright/test';
import { startApp } from './startApp';

// No "Click to start audio" splash (spec 2026-11-15 §10,
// docs/architecture/audio-path.md "Start-up"). The engine is built at page
// load; until the browser lets audio start, the top bar's badge slot
// (`audio-status`, plan 22: empty while all is well) holds the "Audio
// paused" pill; the first click resumes and still does what it was aimed at.
//
// This file runs Chrome WITHOUT --autoplay-policy=no-user-gesture-required
// (launchOptions is per worker, hence top level), so the page really starts
// with a suspended AudioContext, as a user's browser does.
test.use({ launchOptions: { args: [] } });

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
// page.evaluate / waitForFunction run as a user gesture (Playwright's CDP
// evaluate), so before the first real click or key the tests read state
// through locators only (the pill's data-state mirrors the context's state).
/** Telemetry slot 1 (TELEMETRY.playing): 1 while the transport plays. Only after the first gesture. */
const playing = (page: Page) => page.evaluate(() => (window as Any).__daw.engine.telemetry()[1]);
const ctxState = (page: Page) => page.evaluate(() => (window as Any).__daw.engine.state);

test('the app renders without a click; the pill says paused; clicking Play starts audio and plays', async ({ page }) => {
  await page.goto('/');
  // The whole UI, with no click at all.
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('tl-lane-0')).toBeVisible();
  await expect(page.getByTestId('play')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toHaveCount(0);
  // The engine exists, its context waits for a gesture.
  const pill = page.getByTestId('audio-status');
  await expect(pill).toHaveAttribute('data-state', 'paused');
  await expect(pill).toHaveText('Audio paused — click anywhere to start');
  await expect(pill.locator('svg')).toHaveCount(1); // the SpeakerSlash icon
  await expect(page.getByTestId('topbar-warning')).toHaveCount(0); // one badge: the audio state wins

  // The first click (on Play) both starts audio and plays.
  await page.getByTestId('play').click();
  await expect(pill).toHaveAttribute('data-state', 'running');
  expect(await ctxState(page)).toBe('running');
  await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => playing(page)).toBe(1);
  // The pill is gone (headless Chrome blocks Web MIDI, so the slot may hold
  // that badge instead); View ▸ Performance reads the running engine.
  await expect(pill).not.toContainText('Audio paused');
  await expect(page.getByTestId('latency')).toHaveText(/^\d+ ms$/);
  await expect(page.getByTestId('cpu')).toHaveText(/^CPU \d+% · \d+ drop$/);
  await page.getByTestId('song-stop').click();
});

test('Space as the first interaction starts audio and the song', async ({ page }) => {
  await page.goto('/');
  const pill = page.getByTestId('audio-status');
  await expect(pill).toHaveAttribute('data-state', 'paused');
  await page.keyboard.press('Space');
  await expect(pill).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => playing(page)).toBe(1);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'false');
});

test('a context the browser suspends later shows the pill again; clicking it resumes', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('timeline').click({ position: { x: 5, y: 5 } }); // any click starts audio
  await startApp(page);
  const pill = page.getByTestId('audio-status');
  await expect(pill).toHaveAttribute('data-state', 'running');
  await page.evaluate(() => (window as Any).__daw.engine.context.suspend());
  await expect(pill).toHaveAttribute('data-state', 'paused');
  await pill.getByRole('button').click();
  await expect(pill).toHaveAttribute('data-state', 'running');
  await expect(pill).not.toContainText('Audio paused');
  await expect(page.getByTestId('latency')).toHaveText(/^\d+ ms$/);
});

test('Options ▸ Audio settings… while paused resumes and opens Settings', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('menu-options').click(); // the first gesture: audio runs, the menu is open
  await startApp(page);
  await page.evaluate(() => (window as Any).__daw.engine.context.suspend());
  const pill = page.getByTestId('audio-status');
  await expect(pill).toHaveAttribute('data-state', 'paused');
  await page.getByTestId('menu-audio-settings').click();
  await expect(pill).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('settings')).toBeVisible();
});

test('the paused pill keeps the top bar on one row at 1280 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const pill = page.getByTestId('audio-status');
  await expect(pill).toHaveAttribute('data-state', 'paused');
  const bar = (await page.locator('header.bar').boundingBox())!;
  const p = (await pill.boundingBox())!;
  expect(bar.height).toBe(64); // one row (layout.spec.ts: the approved 64 px bar)
  expect(p.x + p.width).toBeLessThanOrEqual(1280);
});

test('a hanging start says "Starting audio…" instead of a blank page', async ({ page }) => {
  await page.route('**/engine.wasm', () => {}); // never answered
  await page.goto('/');
  const pill = page.getByTestId('audio-status');
  await expect(pill).toHaveAttribute('data-state', 'starting');
  await expect(pill).toHaveText('Starting audio…');
  await expect(page.getByTestId('play')).toHaveCount(0);
});

test('a failed start says so with the error; its retry builds the engine', async ({ page }) => {
  await page.route('**/engine.wasm', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  const pill = page.getByTestId('audio-status');
  const btn = page.getByRole('button', { name: 'Audio failed — retry' });
  await expect(btn).toBeVisible(); // in a bare bar: no engine, no top bar
  await expect(btn).toHaveAttribute('title', /engine\.wasm: HTTP 404/);
  await expect(pill).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('play')).toHaveCount(0);
  await page.unroute('**/engine.wasm');
  await btn.click(); // a gesture: the new context may run at once
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(pill).toHaveAttribute('data-state', 'running');
});
