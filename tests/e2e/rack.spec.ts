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
  // Centred vertically: a header grabbed within 30 px of the rail's edge would
  // start the drag's edge auto-scroll and move the target row.
  await page.getByTestId(`module-header-${idx}`).evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'nearest' }));
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

const contentLeft = (page: Page) => page.locator('[data-testid="rail"] > .content').evaluate((c) => c.getBoundingClientRect().left);

/**
 * Drag module `idx` (same row) so its left lands on grid x `gx`, with the
 * pointer kept clear of the rail's auto-scroll edges: the held pointer goes to
 * the rail's middle, the rail is scrolled under it, then it moves to the spot.
 */
/**
 * Drag module `idx` to grid x `gx`, in its own row, or in `rowMate`'s row
 * (the flow layout's rows depend on the rack's width, so a test that needs
 * two modules in one row says so instead of assuming it).
 */
async function dragToGridX(page: Page, idx: number, gx: number, rowMate?: number) {
  const a = await headerGrip(page, idx);
  const rects = await panelRects(page);
  const grabX = a.x - (await contentLeft(page)) - rects[idx].left;
  const rail = page.getByTestId('rail');
  const rb = (await rail.boundingBox())!;
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width / 2, a.y, { steps: 5 });
  const target = 6 + gx * 10 + grabX; // `.content` px under the pointer at the drop
  await rail.evaluate((r, t) => { r.scrollLeft = t - r.clientWidth / 2; }, target);
  let y = a.y;
  if (rowMate !== undefined) {
    const m = (await page.getByTestId(`module-header-${rowMate}`).boundingBox())!;
    y = m.y + m.height / 2;
  }
  await page.mouse.move((await contentLeft(page)) + target, y, { steps: 3 });
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
  // Screen readers hear where it went (row 1-based, position in grid units).
  const row = (await positions(page))[6]!.row;
  await expect(page.getByTestId('jack-status')).toHaveText(`Moved VCA to row ${row + 1}, position ${x0 + 3}`);
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
  // At least 300: with the pointer past the rail's right edge, edge auto-scroll carries it further.
  expect((await positions(page))[6]?.x).toBeGreaterThanOrEqual(300);
  await expect.poll(() => rail.evaluate((r) => r.scrollWidth > r.clientWidth + 100)).toBe(true);
  await rail.evaluate((r) => (r.scrollLeft = r.scrollWidth));
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 3; }).toBe(true);
  // The moved VCA is on screen now: its cables' ends are among those checked above.
  await expect(page.getByTestId('module-6')).toBeInViewport();
});

test('drop back on its own spot is not an edit', async ({ page }) => {
  await loadBrass(page);
  const before = await undoLabel(page);
  const a = await headerGrip(page, 4);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 60, a.y + 30, { steps: 4 }); // past the 3 px slop: the outline shows
  await expect(page.getByTestId('rack-drop-outline')).toBeVisible();
  await page.mouse.move(a.x, a.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await anyPos(page)).toBe(false); // not even pinned
  expect(await undoLabel(page)).toBe(before);
});

test('x stays within 0..1000', async ({ page }) => {
  await loadBrass(page);
  // Drag the VCA (6) to grid x 1200: clamped to 1000.
  let a = await headerGrip(page, 6);
  const rects = await panelRects(page);
  const c = await contentLeft(page);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(c + 6 + 12000 + (a.x - c - rects[6].left), a.y, { steps: 10 });
  await page.mouse.up();
  let pos = await positions(page);
  expect(pos[6]?.x).toBe(1000);
  // Alt+Right at the bound writes nothing.
  await page.getByTestId('module-header-6').focus();
  await page.keyboard.press('Alt+ArrowRight');
  expect(await positions(page)).toEqual(pos);

  // Module 7 into the VCA's row, right up against it: a nudge would push it to 1001.
  const w7 = Math.ceil(rects[7].width / 10);
  await dragToGridX(page, 7, 1000 - w7, 6);
  pos = await positions(page);
  expect(pos[7]).toEqual({ row: pos[6]!.row, x: 1000 - w7 });
  await page.getByTestId('module-header-7').focus();
  await page.keyboard.press('Alt+ArrowRight');
  expect(await positions(page)).toEqual(pos); // refused, nothing written
  await expect(page.getByTestId('jack-status')).toHaveText('Too far right — move left or Tidy'); // and says why

  // A drop that would push the VCA past 1000 is refused too (red outline + hint, no write).
  a = await headerGrip(page, 7);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 50, a.y, { steps: 4 });
  await expect(page.getByTestId('rack-drop-outline')).toHaveAttribute('data-refused', 'true');
  await expect(page.getByTestId('rack-drop-refusal')).toHaveText('Too far right — move left or Tidy');
  await page.mouse.up();
  await expect(page.getByTestId('flash-hint')).toHaveText('Too far right — move left or Tidy');
  expect(await positions(page)).toEqual(pos);
});

test('a panel past x 1000 does not block other moves', async ({ page }) => {
  await loadBrass(page);
  // The VCA (6) to a new bottom row at x 1000 (the pointer far right and below: clamped).
  const rects = await panelRects(page);
  const a = await headerGrip(page, 6);
  const c = await contentLeft(page);
  const lastBottom = Math.max(...Object.values(rects).map((r) => r.bottom));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(c + 12000, a.y + lastBottom + 40 - rects[6].top, { steps: 10 });
  await page.mouse.up();
  let pos = await positions(page);
  expect(pos[6]).toEqual({ row: Math.max(...Object.values(pos).map((q) => q!.row)), x: 1000 });
  // A module added now is drawn at the end of the bottom row: past 1000.
  await page.getByRole('button', { name: '+ Add module' }).click();
  await page.getByTestId('add-menu').getByRole('menuitem', { name: 'Noise' }).click();
  await expect(page.getByTestId('module-10')).toBeVisible();
  const r = await panelRects(page);
  expect(r[10].left).toBeGreaterThanOrEqual(r[6].left + r[6].width - 1);
  // Moving another module still works; the added one is saved at 1000 (drawn where it was).
  await page.getByTestId('module-header-2').focus();
  await page.keyboard.press('Alt+ArrowRight');
  pos = await positions(page);
  expect(pos[2]!.x).toBe(Math.round((rects[2].left - 6) / 10) + 1);
  expect(pos[10]).toEqual({ row: pos[6]!.row, x: 1000 });
  await expect.poll(async () => (await panelRects(page))[10].left).toBeCloseTo(r[10].left, 0);
});

test('drop onto the left neighbour\'s right half does not swap', async ({ page }) => {
  await loadBrass(page);
  const rects = await panelRects(page);
  expect(Math.abs(rects[1].top - rects[0].top)).toBeLessThan(2); // 0 and 1 share the first row
  const x0 = Math.round((rects[0].left - 6) / 10);
  const w0 = Math.ceil(rects[0].width / 10);
  // Pin with B (1) moved 8 units right, then B dragged with its left edge 3/4
  // into A (0): it snaps to A's right edge, A stays.
  await dragHeader(page, 1, 80, 0);
  expect((await positions(page))[1]!.x).toBeGreaterThan(x0 + w0);
  const moved = await panelRects(page);
  await dragHeader(page, 1, moved[0].left + 0.75 * moved[0].width - moved[1].left, 0);
  let pos = await positions(page);
  expect(pos[0]).toEqual({ row: 0, x: x0 });
  expect(pos[1]).toEqual({ row: 0, x: x0 + w0 });
  // Alt+Left into the touching neighbour: no change, nothing written.
  await page.getByTestId('module-header-1').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  expect(await positions(page)).toEqual(pos);
  // In A's LEFT half A would be pushed: its new place is outlined during the drag.
  const a = await headerGrip(page, 1);
  pos = await positions(page);
  const now = await panelRects(page);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + now[0].left + 0.2 * now[0].width - now[1].left, a.y, { steps: 5 });
  await expect(page.getByTestId('rack-push-outline-0')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await positions(page)).toEqual(pos);
});

test('positioned rows keep their panels equally tall', async ({ page }) => {
  await loadBrass(page);
  /** Per row (by pos): every panel's height, and its natural height (without the stretch spacer). */
  const rows = () => page.evaluate(() => {
    const t = (window as unknown as { __daw: RackDaw }).__daw.project.tracks[1];
    const out: Record<number, { idx: number; h: number; natural: number }[]> = {};
    for (const m of t.modules ?? []) {
      const el = document.querySelector<HTMLElement>(`[data-testid="module-${m.idx}"]`)!;
      const s = el.querySelector<HTMLElement>(':scope > [data-stretch]')!;
      (out[m.pos!.row] ??= []).push({ idx: m.idx, h: el.offsetHeight, natural: el.offsetHeight - s.offsetHeight });
    }
    return out;
  });
  // Pin by a nudge, then every row's panels are as tall as the row (jacks line up as in flow).
  await page.getByTestId('module-header-6').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(async () => Object.values(await rows()).every((r) => new Set(r.map((q) => q.h)).size === 1)).toBe(true);
  // The tallest panel of a row whose panels differ leaves it: the row shrinks to the next tallest (no ratchet).
  const r0 = Object.values(await rows()).find((r) => new Set(r.map((q) => q.natural)).size > 1)!;
  const tallest = r0.reduce((x, y) => (y.natural > x.natural ? y : x));
  const rest = Math.max(...r0.filter((q) => q.idx !== tallest.idx).map((q) => q.natural));
  const rects = await panelRects(page);
  await dragHeader(page, tallest.idx, 0, Math.max(...Object.values(rects).map((r) => r.bottom)) + 40 - rects[tallest.idx].top);
  const left = r0.find((q) => q.idx !== tallest.idx)!.idx;
  await expect.poll(async () => (await page.getByTestId(`module-${left}`).evaluate((e) => (e as HTMLElement).offsetHeight))).toBe(rest);
});

test('dragging near the rail edge scrolls it', async ({ page }) => {
  await loadBrass(page);
  const rail = page.getByTestId('rail');
  const rb = (await rail.boundingBox())!;
  const a = await headerGrip(page, 4);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width - 10, a.y, { steps: 5 }); // inside the right edge zone
  await expect.poll(() => rail.evaluate((r) => r.scrollLeft)).toBeGreaterThan(50);
  await page.mouse.move(rb.x + rb.width / 2, a.y, { steps: 3 }); // out of the zone: it stops
  await page.waitForTimeout(100);
  const s = await rail.evaluate((r) => r.scrollLeft);
  await page.waitForTimeout(200);
  expect(await rail.evaluate((r) => r.scrollLeft)).toBe(s);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await anyPos(page)).toBe(false);
});
