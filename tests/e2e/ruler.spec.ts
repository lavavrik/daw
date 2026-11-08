import { expect, test, type Page } from '@playwright/test';
import { ADD_ID, addTrack, openAddTrack, type AddKind } from './addTrack';
import { startApp } from './startApp';

// Timeline readability (plan 21 Task 5, spec round 2 §6 and §8): the ruler's
// BAR and TIME rows and their labels in the corner cell, the hover readout,
// the playhead head and the "Loop" tab, the empty-playlist hint, and the one
// "+ Add track" list. The canvas mirrors its TIME labels in data-time-labels.

const BAR = 3840;

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('tl-lane-0')).toBeVisible();
}

async function setTempo(page: Page, bpm: number) {
  const input = page.getByLabel('BPM');
  await input.fill(String(bpm));
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__daw.project.tempo)).toBe(bpm);
}

type View = { ticksPerPx: number; scrollTick: number };
const view = async (page: Page): Promise<View> => JSON.parse((await page.getByTestId('timeline').getAttribute('data-view'))!);

/** Cmd/Ctrl+wheel over the lanes' left edge: zoom out by e^(0.002 * dy) per event. */
async function zoomOut(page: Page, dy: number) {
  await page.getByTestId('tl-canvas').evaluate((el, dy) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, ctrlKey: true, clientX: r.left + 1, clientY: r.top + 5, bubbles: true, cancelable: true }));
  }, dy);
}

test('the ruler has BAR and TIME rows, named in the corner; 1:00 sits at bar 32 at 124 BPM', async ({ page }) => {
  await start(page);
  const ruler = page.getByTestId('tl-ruler');
  expect((await ruler.boundingBox())!.height).toBe(32); // 18 px BAR over 14 px TIME
  const corner = page.getByTestId('tl-corner');
  await expect(corner).toContainText('Tracks');
  await expect(corner).toContainText('Bar');
  await expect(corner).toContainText('Time');
  // "Bar" sits beside the BAR row, "Time" beside the TIME row.
  const rb = (await ruler.boundingBox())!;
  const bar = (await corner.getByText('Bar', { exact: true }).boundingBox())!;
  const time = (await corner.getByText('Time', { exact: true }).boundingBox())!;
  expect(bar.y + bar.height / 2).toBeLessThan(rb.y + 18);
  expect(time.y + time.height / 2).toBeGreaterThan(rb.y + 18);

  // The default view (16 bars): TIME labels from 0:00, round seconds.
  await expect(ruler).toHaveAttribute('data-time-labels', /^0:00 0:0\d/);

  // 124 BPM, zoomed out so a minute is in view: bar 32 starts at 1:00.
  await setTempo(page, 124);
  await zoomOut(page, 500);
  await zoomOut(page, 500);
  const v = await view(page);
  const w = rb.width;
  expect(v.scrollTick + w * v.ticksPerPx).toBeGreaterThan(32 * BAR);
  await expect(ruler).toHaveAttribute('data-time-labels', /(^| )1:00( |$)/);
  // The canvas shows it there: TIME labels at bar 32's x are light text on the darker row.
  const x = (31 * BAR - v.scrollTick) / v.ticksPerPx;
  const lit = await ruler.evaluate((cv, x) => {
    const c = cv as HTMLCanvasElement;
    const dpr = c.width / c.getBoundingClientRect().width;
    const d = c.getContext('2d')!.getImageData(Math.round((x + 3) * dpr), Math.round(19 * dpr), Math.round(20 * dpr), Math.round(12 * dpr)).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i] + d[i + 1] + d[i + 2]);
    return max;
  }, x);
  expect(lit).toBeGreaterThan(450); // --text-2 glyph pixels, not just the row's grey
});

test('the hover readout shows bar.beat and m:ss.t over the lanes and the ruler, not while dragging', async ({ page }) => {
  await start(page);
  await setTempo(page, 120);
  const readout = page.getByTestId('tl-hover-readout');
  await expect(readout).toHaveCount(0);
  const v = await view(page);
  const lane = (await page.getByTestId('tl-lane-0').boundingBox())!;
  // Bar 5, beat 3 (+ a little) at 120 BPM: 18 beats = 9 s.
  const t = 4 * BAR + 2 * 960 + 200;
  const x = lane.x + (t - v.scrollTick) / v.ticksPerPx;
  await page.mouse.move(x, lane.y + lane.height / 2);
  await expect(readout).toBeVisible();
  await expect(readout).toContainText('Bar');
  await expect(readout).toContainText(':');
  await expect(readout).toHaveText(/^Bar 5\.3 · 0:09\.\d$/);

  // Over the ruler too.
  const rb = (await page.getByTestId('tl-ruler').boundingBox())!;
  await page.mouse.move(rb.x + (BAR - v.scrollTick) / v.ticksPerPx + 2, rb.y + 10);
  await expect(readout).toHaveText(/^Bar 2\.1 · 0:02\.\d$/);

  // Gone once the pointer leaves, and while a button is held (a place-and-drag).
  await page.mouse.move(rb.x - 60, rb.y + 10); // the corner cell
  await expect(readout).toHaveCount(0);
  await page.mouse.move(x, lane.y + lane.height / 2);
  await expect(readout).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(x + 40, lane.y + lane.height / 2, { steps: 4 });
  await expect(readout).toHaveCount(0);
  await page.mouse.up();
});

test('the playhead head and the Loop tab are drawn on the ruler', async ({ page }) => {
  await start(page);
  const ruler = page.getByTestId('tl-ruler');
  // Stopped: the parked song position (bar 1) is marked; a loop range 4 bars wide is labelled.
  await expect(ruler).toHaveAttribute('data-marker', 'parked');
  const v = await view(page);
  // Drag the ruler over bars 1-4 (whole bars): the range is ~4 bars wide, far over 40 px.
  const rb = (await ruler.boundingBox())!;
  await page.mouse.move(rb.x + 5, rb.y + 25);
  await page.mouse.down();
  await page.mouse.move(rb.x + (3.5 * BAR - v.scrollTick) / v.ticksPerPx, rb.y + 25, { steps: 5 });
  await page.mouse.up();
  await expect(ruler).toHaveAttribute('data-loop', `0,${4 * BAR},1`);
  await expect(ruler).toHaveAttribute('data-loop-label', '1');
  // The head: a downward triangle in the playhead colour (--text, light) at the top of the BAR row.
  // Park the song position at bar 8 (outside the loop bar) and compare the head with the ruler beside it.
  const x8 = (7 * BAR - v.scrollTick) / v.ticksPerPx;
  await page.mouse.click(rb.x + x8, rb.y + 25);
  await expect.poll(() => page.evaluate(() => (window as any).__daw.project.songPosition)).toBe(7 * BAR);
  const [head, beside] = await ruler.evaluate((cv, x) => {
    const c = cv as HTMLCanvasElement;
    const dpr = c.width / c.getBoundingClientRect().width;
    const px = (dx: number) => {
      const [r, g, b] = c.getContext('2d')!.getImageData(Math.round((x + dx) * dpr), Math.round(2 * dpr), 1, 1).data;
      return r + g + b;
    };
    return [px(2), px(12)];
  }, x8);
  expect(head - beside).toBeGreaterThan(150);
});

test('an empty playlist says how to start; the hint goes once a clip is placed', async ({ page }) => {
  await start(page);
  // A new project's tracks have no clips.
  expect(await page.evaluate(() => (window as any).__daw.project.tracks.every((t: { clips: unknown[] }) => !t.clips.length))).toBe(true);
  const hint = page.getByTestId('tl-empty-hint');
  await expect(hint).toHaveText('Drag a pattern from a track, or click a lane to place its current pattern');
  const lane = (await page.getByTestId('tl-lane-0').boundingBox())!;
  await page.mouse.click(lane.x + 20, lane.y + lane.height / 2);
  await expect(page.getByTestId('clip-0-0')).toHaveCount(1);
  await expect(hint).toHaveCount(0);
});

test('+ Add track lists every kind; each item adds one; Escape closes and returns focus', async ({ page }) => {
  await start(page);
  const kinds = () => page.evaluate(() => (window as any).__daw.project.tracks.map((t: { kind: string; patchName?: string }) => t.kind));
  const before = (await kinds()).length;
  const btn = page.getByTestId('add-track');
  await expect(btn).toHaveAccessibleName(/Add track/);
  await expect(btn).toHaveAttribute('aria-expanded', 'false');

  await openAddTrack(page);
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByTestId('add-track-menu');
  await expect(menu.getByRole('button')).toHaveText(['Drum track', 'Synth track', 'Sampler track', 'Audio track', 'Master row']);
  // Keyboard: the first item has the focus, ArrowDown moves, Escape closes and gives the focus back.
  await expect(page.getByTestId(ADD_ID.drum)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId(ADD_ID.synth)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(btn).toBeFocused();
  // A click outside closes it too.
  await openAddTrack(page);
  await page.getByTestId('tl-ruler').hover();
  await page.mouse.down();
  await page.mouse.up();
  await expect(menu).toHaveCount(0);

  const order: [AddKind, string][] = [['drum', 'drum'], ['synth', 'synth'], ['sampler', 'synth'], ['audio', 'audio']];
  for (const [k, kind] of order) {
    const n = (await kinds()).length;
    await addTrack(page, k);
    await expect.poll(async () => (await kinds()).length).toBe(n + 1);
    expect((await kinds()).at(-1)).toBe(kind);
    await expect(menu).toHaveCount(0); // picking closes the list
  }
  expect((await kinds()).length).toBe(before + 4);
  const sampler = await page.evaluate(() => (window as any).__daw.project.tracks.at(-2).patchName);
  expect(sampler).toBe('Sampler');

  // Master row: shows the row; while shown it can't be asked for again.
  await expect(page.getByTestId('tl-master-row')).toHaveCount(0);
  await addTrack(page, 'master');
  await expect(page.getByTestId('tl-master-row')).toBeVisible();
  await openAddTrack(page);
  await expect(page.getByTestId(ADD_ID.master)).toBeDisabled();
});
