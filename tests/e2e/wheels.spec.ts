import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';

// The on-screen Pitch / Mod wheels (ui/Wheels.svelte, input/wheels.svelte.ts):
// they follow the hardware wheels (fed through window.__daw.midi.inject, the
// same handler a real MIDI input uses) and drive the engine like them. The
// wheels show what was sent to the engine (AudioEngine.onCommand), so their
// aria-valuenow is the engine's value.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await page.waitForFunction(() => !!(window as Any).__daw?.midi);
  await addTrack(page, 'synth');
  await expect(page.getByTestId('wheels')).toBeVisible();
}

const inject = (page: Page, bytes: number[]) => page.evaluate((b) => (window as Any).__daw.midi.inject(b), bytes);
const now = async (page: Page, k: 'pitch' | 'mod') => Number(await page.getByTestId(`wheel-${k}`).getAttribute('aria-valuenow'));
const undoLabel = (page: Page) => page.evaluate(() => (window as Any).__daw.history.labels.undo);

test('the wheels follow the hardware pitch and mod wheels', async ({ page }) => {
  await start(page);
  await inject(page, [0xe0, 0x7f, 0x7f]); // bend fully up
  await expect.poll(() => now(page, 'pitch')).toBeGreaterThan(0.99);
  await expect(page.getByTestId('wheel-pitch-value')).toHaveText(/^\+\d+\.\d st$/);
  await inject(page, [0xb0, 1, 127]); // mod wheel (CC 1) fully up
  await expect.poll(() => now(page, 'mod')).toBe(1);
  await expect(page.getByTestId('wheel-mod-value')).toHaveText('127');
  await inject(page, [0xe0, 0x00, 0x40]); // bend back to the centre
  await expect.poll(() => now(page, 'pitch')).toBe(0);
  await expect(page.getByTestId('wheel-pitch-value')).toHaveText('0 st');
  // The wheels are global: they stay put on another synth tab.
  await page.keyboard.press('Alt+4');
  await expect.poll(() => now(page, 'mod')).toBe(1);
});

test('dragging: pitch springs back, mod stays, double-click resets; no undo entries', async ({ page }) => {
  await start(page);
  await expect.poll(() => undoLabel(page)).toBe('Add synth track');
  const drag = async (k: 'pitch' | 'mod', dy: number) => {
    const box = (await page.getByTestId(`wheel-${k}`).boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - dy, { steps: 4 });
  };
  // Pitch: half the track's height up is the full bend (the range is -1..1).
  await drag('pitch', 52);
  await expect.poll(() => now(page, 'pitch')).toBeGreaterThan(0.95);
  await page.mouse.up();
  await expect.poll(() => now(page, 'pitch')).toBe(0);
  // Mod: half the height is half the range; it stays after release.
  await drag('mod', 52);
  await page.mouse.up();
  const m = await now(page, 'mod');
  expect(m).toBeGreaterThan(0.45);
  expect(m).toBeLessThan(0.55);
  await page.getByTestId('wheel-mod').dblclick();
  await expect.poll(() => now(page, 'mod')).toBe(0);
  expect(await undoLabel(page)).toBe('Add synth track');
});

test('keyboard: arrows step, pitch springs back on key up', async ({ page }) => {
  await start(page);
  await page.getByTestId('wheel-mod').focus();
  await page.keyboard.press('PageUp');
  await expect.poll(() => now(page, 'mod')).toBe(0.25);
  await page.getByTestId('wheel-pitch').focus();
  await page.keyboard.down('ArrowDown');
  await expect.poll(() => now(page, 'pitch')).toBeLessThan(0);
  await page.keyboard.up('ArrowDown');
  await expect.poll(() => now(page, 'pitch')).toBe(0);
});

test('Cmd/Ctrl+Z during a mod drag cancels it and undoes nothing', async ({ page }) => {
  await start(page);
  await expect.poll(() => undoLabel(page)).toBe('Add synth track');
  const box = (await page.getByTestId('wheel-mod').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 52, { steps: 4 });
  await expect.poll(() => now(page, 'mod')).toBeGreaterThan(0.4);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => now(page, 'mod')).toBe(0);
  await page.mouse.up();
  expect(await undoLabel(page)).toBe('Add synth track');
});

const engineWheels = (page: Page) => page.evaluate(() => ({ ...(window as Any).__daw.wheels }));

test('leaving the synth tabs mid-drag springs the pitch back', async ({ page }) => {
  await start(page);
  const box = (await page.getByTestId('wheel-pitch').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 40, { steps: 3 });
  await expect.poll(async () => (await engineWheels(page)).bend).toBeGreaterThan(0.5);
  await page.keyboard.press('Alt+5'); // the Mixer tab: the strip unmounts
  await expect(page.getByTestId('wheels')).toHaveCount(0);
  await expect.poll(async () => (await engineWheels(page)).bend).toBe(0);
  await page.mouse.up();
});

test('blur mid-drag ends the drag; a held hardware bend is never re-centred by the screen', async ({ page }) => {
  await start(page);
  const box = (await page.getByTestId('wheel-pitch').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 30, { steps: 3 });
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect.poll(() => now(page, 'pitch')).toBe(0);
  await page.mouse.move(x, y - 50, { steps: 3 }); // the drag is over: no re-bend
  expect(await now(page, 'pitch')).toBe(0);
  await page.mouse.up();
  // The hardware holds a bend; focusing and leaving the wheel leaves it alone.
  await inject(page, [0xe0, 0x00, 0x60]);
  await expect.poll(() => now(page, 'pitch')).toBeGreaterThan(0.4);
  await page.getByTestId('wheel-pitch').focus();
  await page.getByTestId('wheel-pitch').blur();
  expect(await now(page, 'pitch')).toBeGreaterThan(0.4);
});

test('wheel keys: Home resets, arrows step, Escape without a drag does nothing', async ({ page }) => {
  await start(page);
  await page.getByTestId('wheel-mod').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => now(page, 'mod')).toBe(0.05);
  // Escape with no drag does nothing to the wheels.
  await page.keyboard.press('Escape');
  expect(await now(page, 'mod')).toBe(0.05);
});
