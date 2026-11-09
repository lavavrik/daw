import { expect, test, type Locator, type Page } from '@playwright/test';
import { pickAutomation } from './automate';
import { startApp } from './startApp';

// Resizable automation lanes (plan 19 Task 2): the grab strip on a lane
// header's bottom edge sets that lane's height (UI state: no undo entry,
// the project stays clean), and everything in the lane (adding, rubber-band
// selection, dragging and Alt-bending points) uses that height, not 48 px.
// A Pan lane (-1..1, linear) on the default drum track: knob position 0.25
// is -0.5 (knobMath.fromPos).

const BAR = 3840;
const PAD = 6;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('tl-lane-0')).toBeVisible();
}

type View = { ticksPerPx: number; scrollTick: number };
async function view(page: Page): Promise<View> {
  return JSON.parse((await page.getByTestId('timeline').getAttribute('data-view'))!);
}

/** Track 0's first lane, saved form (points sorted by tick: [tick, value, hold, curve?]). */
async function savedLane(page: Page) {
  const l: Any = await page.evaluate(() => (window as Any).__daw.snapshot().tracks[0].automation[0]);
  return { ...l, points: [...l.points].sort((a: number[], b: number[]) => a[0] - b[0]) };
}

/** Page point of song tick `tick` at knob position `pos` in lane `testid`, `h` px tall. */
async function lanePt(page: Page, lane: Locator, tick: number, pos: number, h: number) {
  const v = await view(page);
  const b = (await lane.boundingBox())!;
  return { x: b.x + (tick - v.scrollTick) / v.ticksPerPx, y: b.y + PAD + (1 - pos) * (h - 2 * PAD) };
}

/** Press the strip's middle, move `dy` px down (live), and return the release. */
async function dragStrip(page: Page, strip: Locator, dy: number) {
  await strip.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const b = (await strip.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 6 });
  return () => page.mouse.up();
}

test('drag a lane taller: header and lane follow, points use the new height, no undo entry', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-auto-0').click();
  await pickAutomation(page, 0, 'Pan', 'Pan');
  const lane = page.getByTestId('auto-lane-0-0');
  const head = page.getByTestId('auto-head-0-0');
  await expect(lane).toBeVisible();
  const laneId: string = await page.evaluate(() => (window as Any).__daw.project.tracks[0].automation[0].id);
  const strip = page.getByTestId(`lane-resize-${laneId}`);
  await expect(strip).toHaveAttribute('role', 'separator');
  await expect(strip).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(strip).toHaveAttribute('aria-valuenow', '48');
  await expect(strip).toHaveCSS('cursor', 'row-resize');
  expect((await strip.boundingBox())!.height).toBe(5);

  // From here on nothing is an edit: the undo button and the project's edit
  // counter (version) stay put. (Not `dirty`: the idle dirty check would
  // rightly set it again, since the project differs from its saved state.)
  // The pick is a click, so its "Add automation lane" entry is committed by
  // the pointer gesture one task after the pointerup (history/gestures.ts),
  // which can land frames after the lane is already drawn. Wait for it, or
  // the baseline is "Nothing to undo" and the undo loop below removes the lane.
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Add automation lane/);
  const undoTitle = await page.getByTestId('undo').getAttribute('title');

  // Drag the strip 112 px down: live while the button is down, 160 px after.
  const release = await dragStrip(page, strip, 112);
  await expect(strip).toHaveAttribute('aria-valuenow', '160');
  await release();
  await expect(strip).toHaveAttribute('aria-valuenow', '160');
  const hb = (await head.boundingBox())!;
  const lb = (await lane.boundingBox())!;
  expect(hb.height).toBe(160);
  expect(lb.height).toBe(160);
  expect(Math.abs(hb.y - lb.y)).toBeLessThan(0.5); // header and lane rows stay aligned
  // The strip sits on the header's bottom edge.
  const sb = (await strip.boundingBox())!;
  expect(Math.abs(sb.y + sb.height - (hb.y + hb.height))).toBeLessThan(0.5);

  // A click at 25 % of the tall lane's travel adds a point at fromPos(0.25) = -0.5
  // (48 px maths would read the bottom: -1).
  await lane.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const a = await lanePt(page, lane, BAR, 0.25, 160);
  await page.mouse.click(a.x, a.y);
  let l = await savedLane(page);
  expect(l.points).toHaveLength(1);
  expect(l.points[0][0]).toBe(BAR);
  expect(Math.abs(l.points[0][1] - -0.5)).toBeLessThan(2 / 148); // within a pixel of travel
  await expect(lane).toHaveAttribute('data-selected', '1');

  // Rubber band (Shift-drag) around it selects it again.
  await lane.press('Escape');
  await expect(lane).toHaveAttribute('data-selected', '0');
  await page.keyboard.down('Shift');
  await page.mouse.move(a.x - 15, a.y - 15);
  await page.mouse.down();
  await page.mouse.move(a.x + 15, a.y + 15, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(lane).toHaveAttribute('data-selected', '1');

  // Dragging it 37 px up is a quarter of the 148 px travel: -0.5 -> 0.
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y - 37, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await savedLane(page)).points[0][1])).toBeLessThan(2 / 148);

  // A second point at 75 %, then Alt-drag the middle of the line between them 30 px up: a curve.
  const b = await lanePt(page, lane, 2 * BAR, 0.75, 160);
  await page.mouse.click(b.x, b.y);
  await expect.poll(async () => (await savedLane(page)).points.length).toBe(2);
  l = await savedLane(page);
  const mid = await lanePt(page, lane, 1.5 * BAR, (0.5 + 0.75) / 2, 160);
  await page.keyboard.down('Alt');
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x, mid.y - 30, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const bent = await savedLane(page);
  expect(bent.points).toHaveLength(2); // a segment hit, not an Alt-click's new point
  expect(bent.points[0][3]).toBeCloseTo(0.6, 2);
  await page.screenshot({ path: 'test-results/lanes-tall.png' });
  // Those were edits; take them back so the height-only checks below see a clean slate.
  for (let i = 0; i < 8 && (await page.getByTestId('undo').getAttribute('title')) !== undoTitle; i++) {
    await page.keyboard.press('ControlOrMeta+z');
  }
  await expect.poll(async () => (await savedLane(page)).points.length).toBe(0);
  await expect(page.getByTestId('undo')).toHaveAttribute('title', undoTitle!);
  const version = await page.evaluate(() => (window as Any).__daw.project.version);

  // Double-click resets to 48.
  await strip.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await strip.dblclick();
  await expect(strip).toHaveAttribute('aria-valuenow', '48');
  expect((await lane.boundingBox())!.height).toBe(48);

  // Escape mid-drag puts back the height from before the drag; so does Cmd/Ctrl+Z.
  let up = await dragStrip(page, strip, 40);
  await expect(strip).toHaveAttribute('aria-valuenow', '88');
  await page.keyboard.press('Escape');
  await expect(strip).toHaveAttribute('aria-valuenow', '48');
  await up();
  await expect(strip).toHaveAttribute('aria-valuenow', '48');
  up = await dragStrip(page, strip, -10);
  await expect(strip).toHaveAttribute('aria-valuenow', '38');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(strip).toHaveAttribute('aria-valuenow', '48');
  await up();
  await expect(strip).toHaveAttribute('aria-valuenow', '48');
  // Below the minimum: clamped to 32.
  up = await dragStrip(page, strip, -40);
  await up();
  await expect(strip).toHaveAttribute('aria-valuenow', '32');

  // Keyboard on the focused strip: ArrowDown +8, Shift+ArrowDown +1, ArrowUp -8.
  await strip.focus();
  await page.keyboard.press('ArrowDown');
  await expect(strip).toHaveAttribute('aria-valuenow', '40');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(strip).toHaveAttribute('aria-valuenow', '41');
  await page.keyboard.press('ArrowUp');
  await expect(strip).toHaveAttribute('aria-valuenow', '33');
  expect((await head.boundingBox())!.height).toBe(33);
  expect((await lane.boundingBox())!.height).toBe(33);
  await page.screenshot({ path: 'test-results/lanes-short.png' });

  // None of it was an edit: no undo entry, no edit counted.
  await expect(page.getByTestId('undo')).toHaveAttribute('title', undoTitle!);
  expect(await page.evaluate(() => (window as Any).__daw.project.version)).toBe(version);
});
