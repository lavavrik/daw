import { expect, test, type Page } from '@playwright/test';
import { startApp } from './startApp';

// Step velocity (plan 23): in-cell editing on a lit drum step (Task 1) — the
// wheel (±5 a notch, ±1 with Shift), Shift-drag (1 per 2 px, up is louder)
// and Shift+↑ / ↓ (±5; Alt+Shift ±1), clamped to 1..127, one undo entry per
// gesture. The maths and the undo rules are unit-tested in
// app/src/ui/stepGrid.test.ts and app/src/state/actions.test.ts.

type Daw = {
  engine: { telemetry(): Float64Array } | null;
  project: { tracks: { currentPatternId: string; patterns: { id: string; steps: number[][] }[] }[] };
  history: { labels: { undo: string | null; redo: string | null } } | null;
};

const KIT = ['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc'];

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  // The starter kit lands asynchronously: wait for its samples (the sound check needs the Kick).
  for (const [i, name] of KIT.entries()) await expect(page.getByTestId(`row-${i}`).getByTestId('row-name')).toHaveText(name);
}

/** Stored velocity of row `r`, step `s` in the drum track's current pattern. */
const vel = (page: Page, r: number, s: number) =>
  page.evaluate(([r, s]) => {
    const t = (window as unknown as { __daw: Daw }).__daw.project.tracks[0];
    return t.patterns.find((x) => x.id === t.currentPatternId)!.steps[r][s];
  }, [r, s] as const);

const undoLabel = (page: Page) =>
  page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.history?.labels.undo ?? null);

/** Fill height over cell height (0 when the cell has no fill). */
const fillRatio = (page: Page, id: string) =>
  page.getByTestId(id).evaluate((el) => {
    const f = el.querySelector('.fill');
    return f ? f.getBoundingClientRect().height / el.getBoundingClientRect().height : 0;
  });

async function center(page: Page, id: string) {
  const b = (await page.getByTestId(id).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** One mouse-wheel notch (100 px; up = negative) over the pointer. */
async function notch(page: Page, dir: 'up' | 'down', n = 1) {
  for (let i = 0; i < n; i++) await page.mouse.wheel(0, dir === 'up' ? -100 : 100);
}

/** Max master peak (telemetry[5]) seen over `ms` (rowdelete.spec.ts). */
function maxPeak(page: Page, ms = 1500) {
  return page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        const eng = (window as unknown as { __daw: Daw }).__daw.engine!;
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

test('the wheel on a lit cell: +5 a notch, the fill grows, capped at 127, never off', async ({ page }) => {
  await start(page);
  await page.getByTestId('step-0-0').click();
  expect(await vel(page, 0, 0)).toBe(100);
  await expect(page.getByTestId('step-0-0')).toHaveAttribute('data-tip', 'Velocity 100 — wheel or Shift-drag to change');
  await expect(page.getByTestId('step-0-1')).not.toHaveAttribute('data-tip', /./); // off: no velocity tip
  const before = await fillRatio(page, 'step-0-0');

  const c = await center(page, 'step-0-0');
  await page.mouse.move(c.x, c.y);
  await notch(page, 'up');
  await expect.poll(() => vel(page, 0, 0)).toBe(105);
  expect(await fillRatio(page, 'step-0-0')).toBeGreaterThan(before);
  expect(await fillRatio(page, 'step-0-0')).toBeCloseTo(105 / 127, 2);
  await expect(page.getByTestId('step-vel-chip')).toHaveText('vel 105');
  await expect(page.getByTestId('step-0-0')).toHaveAttribute('data-tip', 'Velocity 105 — wheel or Shift-drag to change');
  expect(await undoLabel(page)).toBe('Step velocity');

  // 105 -> 125, then the cap.
  await notch(page, 'up', 4);
  await expect.poll(() => vel(page, 0, 0)).toBe(125);
  await expect(page.getByTestId('step-0-0')).toHaveClass(/\baccent\b/); // the ring follows live
  await notch(page, 'up');
  await expect.poll(() => vel(page, 0, 0)).toBe(127);
  await notch(page, 'up');
  expect(await vel(page, 0, 0)).toBe(127);
  // Shift: fine steps of 1.
  await page.keyboard.down('Shift');
  await notch(page, 'down');
  await page.keyboard.up('Shift');
  await expect.poll(() => vel(page, 0, 0)).toBe(126);

  // All the way down: it clamps at 1 and stays lit.
  await notch(page, 'down', 30);
  await expect.poll(() => vel(page, 0, 0)).toBe(1);
  await expect(page.getByTestId('step-0-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('step-vel-chip')).toHaveText('vel 1');
  await expect(page.getByTestId('step-vel-chip')).toBeHidden({ timeout: 3000 }); // gone after the burst
});

test('Shift-drag up 40 px -> 120 with the accent ring; one undo; Esc and Cmd+Z mid-drag cancel', async ({ page }) => {
  await start(page);
  await page.getByTestId('step-0-0').click();
  await expect.poll(() => undoLabel(page)).toBe('Set step'); // the click's gesture commits a task after the release
  const c = await center(page, 'step-0-0');

  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(c.x, c.y - 20, { steps: 2 });
  await page.mouse.move(c.x, c.y - 40, { steps: 2 });
  await expect(page.getByTestId('step-vel-chip')).toHaveText('vel 120');
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(await vel(page, 0, 0)).toBe(120);
  await expect(page.getByTestId('step-0-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('step-0-0')).toHaveClass(/\baccent\b/);
  await expect(page.getByTestId('step-vel-chip')).toBeHidden();
  // Nothing was painted on the way (the pointer is captured).
  expect(await vel(page, 0, 1)).toBe(0);
  await expect.poll(() => undoLabel(page)).toBe('Step velocity');

  // One undo entry for the whole drag.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => vel(page, 0, 0)).toBe(100);
  await expect(page.getByTestId('step-0-0')).not.toHaveClass(/\baccent\b/);
  expect(await undoLabel(page)).toBe('Set step');

  // Esc mid-drag: back to 100, no entry.
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(c.x, c.y - 40, { steps: 4 });
  await expect.poll(() => vel(page, 0, 0)).toBe(120);
  await page.keyboard.press('Escape');
  await expect.poll(() => vel(page, 0, 0)).toBe(100);
  await expect(page.getByTestId('step-vel-chip')).toBeHidden();
  await page.mouse.move(c.x, c.y - 80, { steps: 2 }); // the drag is over: no more changes
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(50); // the gesture commits a task after the release
  expect(await vel(page, 0, 0)).toBe(100);
  expect(await undoLabel(page)).toBe('Set step');

  // Cmd/Ctrl+Z mid-drag cancels the same way (and undoes nothing older).
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(c.x, c.y + 40, { steps: 4 });
  await expect.poll(() => vel(page, 0, 0)).toBe(80);
  await page.keyboard.up('Shift');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => vel(page, 0, 0)).toBe(100);
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await undoLabel(page)).toBe('Set step');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => vel(page, 0, 0)).toBe(0); // the stack under it is intact

  // Shift + press on an OFF cell still paints, as a plain press does.
  await page.getByTestId('step-0-3').click({ modifiers: ['Shift'] });
  expect(await vel(page, 0, 3)).toBe(100);
});

test('Shift+Up on a focused lit cell: +5, announced; Alt+Shift: fine; plain arrows do nothing', async ({ page }) => {
  await start(page);
  const cell = page.getByTestId('step-0-0');
  await cell.click();
  await expect(cell).toBeFocused();
  await expect.poll(() => undoLabel(page)).toBe('Set step'); // the click's own entry is closed
  await page.keyboard.press('Shift+ArrowUp');
  expect(await vel(page, 0, 0)).toBe(105);
  await expect(page.getByTestId('step-vel-status')).toHaveText('Velocity 105');
  await expect(page.getByTestId('step-vel-status')).toHaveAttribute('aria-live', 'polite');
  await expect(page.getByTestId('step-vel-chip')).toHaveText('vel 105');
  await page.keyboard.press('Alt+Shift+ArrowDown');
  expect(await vel(page, 0, 0)).toBe(104);
  await expect(page.getByTestId('step-vel-status')).toHaveText('Velocity 104');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  expect(await vel(page, 0, 0)).toBe(104);
  // One burst on the cell: one entry.
  await page.keyboard.press('ControlOrMeta+z');
  expect(await vel(page, 0, 0)).toBe(100);
  // An off cell: Shift+arrows change nothing (it stays off).
  await page.getByTestId('step-0-1').focus();
  await page.keyboard.press('Shift+ArrowUp');
  expect(await vel(page, 0, 1)).toBe(0);
});

test('the wheel over an off cell is left to the page (it scrolls)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 }); // short: the bottom panel's body scrolls
  await start(page);
  await page.getByTestId('step-0-0').click();
  // Record whether a wheel reached the window cancelled (a lit cell takes it, an off one must not).
  await page.evaluate(() => {
    const w = window as unknown as { __wheels: boolean[] };
    w.__wheels = [];
    window.addEventListener('wheel', (e) => w.__wheels.push(e.defaultPrevented));
  });
  const cancelled = () => page.evaluate(() => (window as unknown as { __wheels: boolean[] }).__wheels);

  const off = await center(page, 'step-0-2');
  const scroller = page.getByTestId('step-0-2').evaluateHandle((el) => {
    let e: HTMLElement | null = el.parentElement;
    while (e && !(e.scrollHeight > e.clientHeight && /(auto|scroll)/.test(getComputedStyle(e).overflowY))) e = e.parentElement;
    return e;
  });
  const top = () => scroller.then((h) => h.evaluate((e) => (e as HTMLElement | null)?.scrollTop ?? -1));
  expect(await top()).toBe(0); // there is room to scroll
  await page.mouse.move(off.x, off.y);
  await page.mouse.wheel(0, 100);
  await expect.poll(cancelled).toEqual([false]);
  await expect.poll(top).toBeGreaterThan(0);
  expect(await vel(page, 0, 2)).toBe(0);

  // Over the lit cell the wheel is the velocity's (and nothing scrolls).
  const s0 = await top();
  const lit = await center(page, 'step-0-0');
  await page.mouse.move(lit.x, lit.y);
  await page.mouse.wheel(0, -100);
  await expect.poll(cancelled).toEqual([false, true]);
  expect(await vel(page, 0, 0)).toBe(105);
  expect(await top()).toBe(s0);
});

test('sound: a velocity-30 hit peaks quieter than a 127 hit on the same row', async ({ page }) => {
  test.setTimeout(30_000);
  await start(page);
  const steps = [0, 4, 8, 12];
  for (const s of steps) await page.getByTestId(`step-0-${s}`).click(); // Kick, 100
  /** Re-level every lit Kick step with the keys (Shift+↑/↓ = ±5). */
  async function press(key: string, n: number) {
    for (const s of steps) {
      await page.getByTestId(`step-0-${s}`).focus();
      for (let i = 0; i < n; i++) await page.keyboard.press(key);
    }
  }
  await press('Shift+ArrowDown', 14); // 100 -> 30
  for (const s of steps) expect(await vel(page, 0, s)).toBe(30);
  await page.keyboard.press('Space'); // the pattern transport (focus is in the grid)
  const soft = await maxPeak(page);
  await page.keyboard.press('Space');
  await press('Shift+ArrowUp', 20); // 30 -> 127 (capped)
  for (const s of steps) expect(await vel(page, 0, s)).toBe(127);
  await page.keyboard.press('Space');
  const loud = await maxPeak(page);
  await page.keyboard.press('Space');
  expect(soft).toBeGreaterThan(0.001);
  expect(loud).toBeGreaterThan(soft * 2); // gain * vel / 127 (engine/src/drums.rs): ~4x
});
