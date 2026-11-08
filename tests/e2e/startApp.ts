import { expect, type Page } from '@playwright/test';

// There is no "Click to start audio" splash any more (spec 2026-11-15 §10,
// docs/architecture/audio-path.md "Start-up"): the app builds its engine at
// page load and renders once it exists. Playwright's Chrome runs with
// --autoplay-policy=no-user-gesture-required (playwright.config.ts), so the
// AudioContext runs without any click. Call this after page.goto / reload in
// place of the old overlay click: it waits until the engine exists and runs,
// and the top bar has rendered (everything onstarted wires is in place then).
export async function startApp(page: Page) {
  await page.waitForFunction(() => {
    const e = (window as unknown as { __daw?: { engine?: { state?: string } | null } }).__daw?.engine;
    return !!e && e.state === 'running';
  });
  await expect(page.getByTestId('play')).toBeVisible();
}
