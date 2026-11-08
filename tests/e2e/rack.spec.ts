import { expect, test, type Page } from '@playwright/test';

// Plan 13 Task 2: the Instrument rack wraps into rows (like VCV Rack) instead
// of one long horizontal rail, and the cables follow the jacks after a wrap and
// after a window resize.

async function loadSax(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
  await page.getByTestId('add-synth-track').click();
  await page.getByRole('button', { name: 'Instrument' }).click();
  await page.getByTestId('patch-select').selectOption('Sax');
  await expect(page.locator('[data-testid^="module-"]:not([data-testid^="module-header-"])').nth(9)).toBeVisible();
}

/**
 * Worst distance (px) from each cable plug to the jack of ITS OWN cable (plug
 * 2k is cable k's output end, 2k+1 its input end: the SVG draws track.cables
 * in order); and the plug count, which must be 2 per cable (n = 0 otherwise,
 * so the callers' n > 0 check also catches a missing or extra plug).
 */
async function plugError(page: Page) {
  return page.evaluate(() => {
    type Cable = { from: { m: number; port: number }; to: { m: number; port: number } };
    const tracks = (window as unknown as { __daw: { project: { tracks: { cables?: Cable[] }[] } } }).__daw.project.tracks;
    const cables = tracks[1].cables ?? [];
    const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const jack = (m: number, dir: string, port: number) => {
      const el = document.querySelector(`[data-jack][data-m="${m}"][data-dir="${dir}"][data-port="${port}"]`);
      return el ? centre((el.querySelector('.hole') ?? el).getBoundingClientRect()) : null;
    };
    const plugs = [...document.querySelectorAll('[data-testid="cables"] circle')].map((c) => centre(c.getBoundingClientRect()));
    if (plugs.length !== cables.length * 2) return { worst: Infinity, n: 0 };
    let worst = 0;
    cables.forEach((c, k) => {
      const ends = [jack(c.from.m, 'out', c.from.port), jack(c.to.m, 'in', c.to.port)];
      ends.forEach((j, e) => {
        const p = plugs[2 * k + e];
        worst = Math.max(worst, j ? Math.hypot(j.x - p.x, j.y - p.y) : Infinity);
      });
    });
    return { worst, n: plugs.length };
  });
}

/** Distinct panel rows (top edges, scroll-corrected). */
const rowCount = (page: Page) =>
  page.locator('[data-testid^="module-"]:not([data-testid^="module-header-"])').evaluateAll((els) =>
    new Set(els.map((e) => Math.round(e.getBoundingClientRect().top + e.closest('[data-testid=rail]')!.scrollTop))).size);

test('cables follow wrapped rows', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await loadSax(page);

  // Panels wrap: at least two distinct rows.
  const rows = await rowCount(page);
  expect(rows).toBeGreaterThanOrEqual(2);

  // No horizontal scroll.
  const noHScroll = () => page.getByTestId('rail').evaluate((r) => r.scrollWidth <= r.clientWidth + 1);
  expect(await noHScroll()).toBe(true);

  // Plugs sit on jacks (poll: measure() runs a frame after layout).
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 4; }).toBe(true);

  // Resize wider: rows re-flow, plugs follow.
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect.poll(() => rowCount(page)).toBeLessThan(rows); // it really re-flowed
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 4; }).toBe(true);
  expect(await noHScroll()).toBe(true);
});

// ---- Plan 18 Task 3: dragging modules (free rack layout) -----------------------

type Pos = { row: number; x: number };
type RackDaw = {
  project: { tracks: { modules?: { idx: number; pos?: Pos }[] }[] };
  history: { labels: { undo: string | null; redo: string | null } } | null;
};

/** Brass Stab (a house patch, 10 modules; its VCA is module 6) on a new synth track. */
async function loadBrass(page: Page) {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
  await page.getByTestId('add-synth-track').click();
  await page.getByRole('button', { name: 'Instrument' }).click();
  await page.getByTestId('patch-select').selectOption('Brass Stab');
  await expect(page.getByTestId('module-9')).toBeVisible();
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 3; }).toBe(true);
}

/** The synth track's module positions by idx (undefined = no pos). */
const positions = (page: Page) =>
  page.evaluate(() => {
    const t = (window as unknown as { __daw: RackDaw }).__daw.project.tracks[1];
    return Object.fromEntries((t.modules ?? []).map((m) => [m.idx, m.pos ? { row: m.pos.row, x: m.pos.x } : null]));
  });
const anyPos = async (page: Page) => Object.values(await positions(page)).some((p) => p !== null);
const undoLabel = (page: Page) =>
  page.evaluate(() => (window as unknown as { __daw: RackDaw }).__daw.history?.labels.undo ?? null);

/** A point on module `idx`'s header, clear of its × button (viewport px; scrolled into view first). */
async function headerGrip(page: Page, idx: number) {
  await page.getByTestId(`module-header-${idx}`).scrollIntoViewIfNeeded();
  const b = (await page.getByTestId(`module-header-${idx}`).boundingBox())!;
  return { x: b.x + 12, y: b.y + b.height / 2 };
}

/** Real pointer drag of module `idx`'s header by (dx, dy) px. */
async function dragHeader(page: Page, idx: number, dx: number, dy: number) {
  const a = await headerGrip(page, idx);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + dx / 2, a.y + dy / 2, { steps: 5 });
  await page.mouse.move(a.x + dx, a.y + dy, { steps: 5 });
  await page.mouse.up();
}

/** Panel rects relative to the rail's `.content` (scroll-independent). */
const panelRects = (page: Page) =>
  page.locator('[data-testid^="module-"]:not([data-testid^="module-header-"])').evaluateAll((els) => {
    const c = els[0].parentElement!.getBoundingClientRect();
    return Object.fromEntries(els.map((e) => {
      const r = e.getBoundingClientRect();
      return [Number(e.getAttribute('data-testid')!.slice('module-'.length)), { left: r.left - c.left, top: r.top - c.top, width: r.width, bottom: r.bottom - c.top }];
    }));
  });

test('drag module to a new row', async ({ page }) => {
  await loadBrass(page);
  const flowRows = await rowCount(page);
  const rects = await panelRects(page);
  const lastBottom = Math.max(...Object.values(rects).map((r) => r.bottom));
  // Pointer to 40 px below the lowest panel: the "new row" band.
  await dragHeader(page, 6, 0, lastBottom + 40 - rects[6].top);
  const pos = await positions(page);
  expect(pos[6]?.row).toBe(flowRows); // the old last row is flowRows - 1
  expect(Object.values(pos).every((p) => p !== null)).toBe(true); // the first drag pinned them all
  await expect.poll(() => undoLabel(page)).toBe('Move module'); // a gesture's entry lands a task after the release
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 3; }).toBe(true);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => anyPos(page)).toBe(false); // flow again
});

test('drop pushes neighbour', async ({ page }) => {
  await loadBrass(page);
  const rects = await panelRects(page);
  // B: the first panel of the second flow row; A: module 0 (first row).
  const top0 = rects[0].top;
  const b = Number(Object.entries(rects).filter(([, r]) => r.top > top0 + 2).sort((x, y) => x[1].top - y[1].top || x[1].left - y[1].left)[0][0]);
  await dragHeader(page, 0, rects[b].left - rects[0].left, rects[b].top - rects[0].top);
  const pos = await positions(page);
  const wA = Math.ceil(rects[0].width / 10);
  expect(pos[0]!.row).toBe(pos[b]!.row);
  expect(pos[b]!.x).toBeGreaterThanOrEqual(pos[0]!.x + wA);
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 3; }).toBe(true);
});

test('click on header is not an edit', async ({ page }) => {
  await loadBrass(page);
  const before = await undoLabel(page);
  const a = await headerGrip(page, 3);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 2, a.y + 1); // under the 3 px travel threshold
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await anyPos(page)).toBe(false);
  expect(await undoLabel(page)).toBe(before);
});

test('tidy', async ({ page }) => {
  await loadBrass(page);
  await expect(page.getByTestId('rack-tidy')).toBeDisabled(); // already flow
  const rects = await panelRects(page);
  await dragHeader(page, 2, 0, Math.max(...Object.values(rects).map((r) => r.bottom)) + 40 - rects[2].top);
  expect(await anyPos(page)).toBe(true);
  await page.getByTestId('rack-tidy').click();
  expect(await anyPos(page)).toBe(false);
  await expect.poll(() => undoLabel(page)).toBe('Tidy rack');
  await expect(page.getByTestId('rack-tidy')).toBeDisabled();
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 3; }).toBe(true);
});

test('undo mid drag cancels', async ({ page }) => {
  await loadBrass(page);
  const before = await undoLabel(page);
  const a = await headerGrip(page, 6);
  const box0 = (await page.getByTestId('module-6').boundingBox())!;
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 150, a.y + 120, { steps: 6 });
  await expect(page.getByTestId('rack-drop-outline')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('rack-drop-outline')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await anyPos(page)).toBe(false);
  expect(await undoLabel(page)).toBe(before);
  const box1 = (await page.getByTestId('module-6').boundingBox())!;
  expect(Math.abs(box1.x - box0.x) + Math.abs(box1.y - box0.y)).toBeLessThan(1); // snapped back
});

test('keyboard move', async ({ page }) => {
  await loadBrass(page);
  const rects = await panelRects(page);
  const x0 = Math.round((rects[6].left - 6) / 10); // pinned x (content padding 6 px)
  await page.getByTestId('module-header-6').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Alt+ArrowRight');
  expect((await positions(page))[6]?.x).toBe(x0 + 3);
  await expect.poll(() => undoLabel(page)).toBe('Move module'); // a gesture's entry lands a task after the release
  await page.keyboard.press('ControlOrMeta+z'); // one entry: straight back to flow
  await expect.poll(() => anyPos(page)).toBe(false);
});

test('wide rack scrolls', async ({ page }) => {
  await loadBrass(page);
  const rail = page.getByTestId('rail');
  const a = await headerGrip(page, 6);
  const rects = await panelRects(page);
  const cx = await page.locator('[data-testid="rail"] > .content').evaluate((c) => c.getBoundingClientRect().left);
  // Drag far right, past the viewport (pointer capture keeps the moves coming).
  const toX = cx + 6 + 3000 + (a.x - cx - rects[6].left);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(toX, a.y, { steps: 10 });
  await page.mouse.up();
  expect((await positions(page))[6]?.x).toBe(300);
  await expect.poll(() => rail.evaluate((r) => r.scrollWidth > r.clientWidth + 100)).toBe(true);
  await rail.evaluate((r) => (r.scrollLeft = r.scrollWidth));
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 3; }).toBe(true);
  // The moved VCA is on screen now: its cables' ends are among those checked above.
  await expect(page.getByTestId('module-6')).toBeInViewport();
});
