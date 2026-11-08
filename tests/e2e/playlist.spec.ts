import { expect, test, type Page } from '@playwright/test';

// The playlist look (plan 20 Task 7): the track header's volume slider is the
// track's mixer fader (same value, same action, one undo entry per drag), and
// a pattern clip draws a mini preview of its pattern.

const BAR = 3840;
const undoKey = 'ControlOrMeta+z';

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

/** The drum track's (slot 0) fader as its mixer strip shows it (dB). */
const stripDb = async (page: Page) => Number(await page.getByTestId('strip-0').getByTestId('fader').getAttribute('aria-valuenow'));

/**
 * Page x of the header slider's thumb centre at fader position `pos` (0..1).
 * The thumb (10 px) travels the input's width minus itself.
 */
async function thumbX(page: Page, pos: number) {
  const b = (await page.getByTestId('track-vol-0').boundingBox())!;
  return { x: b.x + 5 + pos * (b.width - 10), y: b.y + b.height / 2 };
}

test('the track header volume slider drives the mixer fader: one undo entry per drag, Escape cancels', async ({ page }) => {
  await start(page);
  await page.getByTestId('mixer-tab').click();
  await expect(page.getByTestId('strip-0')).toBeVisible();
  const vol = page.getByTestId('track-vol-0');
  expect(await stripDb(page)).toBe(0);
  await expect(vol).toHaveAttribute('aria-valuetext', '0.0 dB');
  // 0 dB sits at 3/4 of the travel (the fader law), as on the strip.
  expect(Number(await vol.inputValue())).toBeCloseTo(0.75, 3);

  // Drag the thumb from 0 dB down to about a third of the travel.
  const from = await thumbX(page, 0.75);
  const to = await thumbX(page, 0.3);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => stripDb(page)).toBeLessThan(-10);
  const db = await stripDb(page);
  // The header and the strip show the same value.
  await expect(page.getByTestId('strip-0').getByTestId('fader-readout')).toHaveText((await vol.getAttribute('aria-valuetext'))!);
  expect(db).toBeGreaterThan(-60);

  // One undo takes the whole drag back.
  await page.keyboard.press(undoKey);
  await expect.poll(() => stripDb(page)).toBe(0);
  await expect(vol).toHaveAttribute('aria-valuetext', '0.0 dB');

  // Escape mid-drag puts the value from before the press back; the rest of that press is ignored.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await expect.poll(() => stripDb(page)).toBeLessThan(-10);
  await page.keyboard.press('Escape');
  await expect.poll(() => stripDb(page)).toBe(0);
  await page.mouse.move(to.x - 10, to.y, { steps: 3 });
  await page.mouse.up();
  expect(await stripDb(page)).toBe(0);
  expect(Number(await vol.inputValue())).toBeCloseTo(0.75, 3);

  // Keys step like the fader (±1 dB); and the strip's fader moves the header slider.
  await vol.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => stripDb(page)).toBe(-1);
  await page.getByTestId('strip-0').getByTestId('fader').focus();
  await page.keyboard.press('ArrowDown');
  await expect(vol).toHaveAttribute('aria-valuetext', '−2.0 dB');
  // The Master row has no slider.
  await page.getByTestId('tl-master-toggle').click();
  await expect(page.getByTestId('master-head')).toBeVisible();
  await expect(page.getByTestId('master-head').locator('input[type="range"]')).toHaveCount(0);
});

test('a drum clip previews its pattern: a mark per hit under the name', async ({ page }) => {
  await start(page);
  // Place the drum pattern at bar 1.
  const v = JSON.parse((await page.getByTestId('timeline').getAttribute('data-view'))!) as { ticksPerPx: number; scrollTick: number };
  const lane = (await page.getByTestId('tl-lane-0').boundingBox())!;
  await page.mouse.click(lane.x + (BAR / 2 - v.scrollTick) / v.ticksPerPx, lane.y + lane.height / 2);
  const clip = page.getByTestId('clip-0-0');
  await expect(clip).toBeVisible();

  /** Pixels in the clip's preview band (under the name) much darker than its track-colour body. */
  const marks = async () => {
    const box = (await clip.boundingBox())!;
    const cv = (await page.getByTestId('tl-canvas').boundingBox())!;
    const color = await page.evaluate(() => (window as unknown as { __daw: { project: { tracks: { color: string }[] } } }).__daw.project.tracks[0].color);
    return page.evaluate(
      ({ x, y, w, color }) => {
        const c = document.querySelector('[data-testid="tl-canvas"]') as HTMLCanvasElement;
        const k = c.width / c.getBoundingClientRect().width;
        // The band: 15..19 px below the clip's top (PREVIEW_TOP 14, 6 px tall), inside its edges.
        const d = c.getContext('2d')!.getImageData(Math.round((x + 4) * k), Math.round((y + 15) * k), Math.round((w - 8) * k), Math.round(4 * k)).data;
        const body = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)).reduce((a, b) => a + b);
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < body - 120) n++;
        return n;
      },
      { x: box.x - cv.x, y: box.y - cv.y, w: box.width, color },
    );
  };
  expect(await marks()).toBe(0); // an empty pattern: nothing under the name
  await page.getByTestId('step-0-0').click();
  await page.getByTestId('step-0-8').click();
  await expect.poll(marks).toBeGreaterThan(0);
});

test('the header volume slider follows the fader lane in Song mode, and an edit overrides it', async ({ page }) => {
  await start(page);
  // A fader lane on the drum track: −40 dB at bar 1 to −20 dB at bar 2.
  await page.evaluate((bar) => {
    const d = (window as unknown as { __daw: { project: { tracks: { id: string }[] }; actions: Record<string, (...a: unknown[]) => unknown> } }).__daw;
    const lane = d.actions.addLane(d.project.tracks[0].id, { kind: 'mix', param: 'fader' });
    d.actions.drawLane(lane, [{ tick: 0, value: -40 }, { tick: bar, value: -20 }]);
  }, BAR);
  const vol = page.getByTestId('track-vol-0');
  // Pattern mode (nothing ran yet): the lane does not apply; the slider shows the base.
  await expect(vol).not.toHaveAttribute('data-auto', 'on');
  expect(Number(await vol.inputValue())).toBeCloseTo(0.75, 3);
  // Song mode (the song transport ran last), parked half way: about −29 dB (the lane interpolates on the fader law).
  await page.getByTestId('play').click();
  await page.getByTestId('play').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: { project: { mode: string; playing: boolean } } }).__daw.project.mode)).toBe('song');
  await page.evaluate((t) => (window as unknown as { __daw: { actions: { seek(t: number): void } } }).__daw.actions.seek(t), BAR / 2);
  await expect(vol).toHaveAttribute('data-auto', 'on');
  const heard = async () => Number(await vol.getAttribute('data-auto-value'));
  await expect.poll(heard).toBeLessThan(-27);
  expect(await heard()).toBeGreaterThan(-32);
  const v = await heard();
  const pos = Number(await vol.inputValue());
  expect(pos).toBeLessThan(0.6); // well below 0 dB's 3/4
  expect(pos).toBeGreaterThan(0.05);
  await expect(vol).toHaveAttribute('aria-valuetext', /, automated \(base 0\.0 dB\)$/);
  // Its strip fader draws the same heard value.
  await page.getByTestId('mixer-tab').click();
  const fader = page.getByTestId('strip-0').getByTestId('fader');
  await expect.poll(async () => Number(await fader.getAttribute('data-auto-value'))).toBeCloseTo(v, 3);
  // An arrow on the slider steps from the heard value and overrides the lane until its next point.
  await vol.focus();
  await page.keyboard.press('ArrowUp');
  await expect(vol).toHaveAttribute('data-auto', 'suspended');
  await expect(fader).toHaveAttribute('data-auto', 'suspended');
  const want = Math.round((v + 1) * 10) / 10;
  await expect(vol).toHaveAttribute('aria-valuetext', `−${(-want).toFixed(1)} dB`);
});
