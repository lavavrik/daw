import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// Plan 13 Task 2: the Instrument rack wraps into rows (like VCV Rack) instead
// of one long horizontal rail, and the cables follow the jacks after a wrap and
// after a window resize.

async function loadSax(page: Page) {
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
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
  await startApp(page);
  await addTrack(page, 'synth');
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
    // The row mate's header to the rail's middle too: rows are tall (the
    // mechanical faceplates, plan 21), so it may be scrolled out of view, and
    // a pointer past the rail's edge would auto-scroll it.
    await rail.evaluate((r, hdr) => {
      const h = document.querySelector(`[data-testid="${hdr}"]`)!.getBoundingClientRect();
      const rr = r.getBoundingClientRect();
      r.scrollTop += h.top + h.height / 2 - (rr.top + r.clientHeight / 2);
    }, `module-header-${rowMate}`);
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
  // ...exactly as it was drawn before the pinning drag.
  await expect.poll(async () => maxShift(rects, await panelRects(page))).toBeLessThanOrEqual(1);
});

/**
 * The largest |Δleft| + |Δtop| (px) of any module of `a` in `b`, except `skip`.
 * A module of `a` missing from `b` (and not skipped) is Infinity: a module that
 * vanished must fail the check, not pass it.
 */
function maxShift(a: Record<number, { left: number; top: number }>, b: Record<number, { left: number; top: number }>, skip: number[] = []) {
  let worst = 0;
  for (const [k, r] of Object.entries(a)) {
    const idx = Number(k);
    if (skip.includes(idx)) continue;
    if (!b[idx]) return Infinity;
    worst = Math.max(worst, Math.abs(b[idx].left - r.left) + Math.abs(b[idx].top - r.top));
  }
  return worst;
}

/** Waits until module `idx` is drawn somewhere else than in `before` (the DOM has the move). */
async function settled(page: Page, before: Record<number, { left: number; top: number }>, idx: number) {
  await expect.poll(async () => maxShift({ [idx]: before[idx] }, await panelRects(page))).toBeGreaterThan(1);
}

// ---- Plan 22 Task 3: free-spot-only placement --------------------------------

const NO_ROOM = 'No free spot there — the module stays';

test('a small drag moves only that module: no other module jumps; the grid shows while dragging', async ({ page }) => {
  // The owner's case: the last module of the first row (Out, in their rack) a bit to the right.
  await loadBrass(page);
  const before = await panelRects(page);
  const row0 = Object.entries(before).filter(([, r]) => Math.abs(r.top - before[0].top) < 1).sort((a, b) => a[1].left - b[1].left);
  const last = Number(row0[row0.length - 1][0]);
  const a = await headerGrip(page, last);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 15, a.y, { steps: 3 });
  await page.mouse.move(a.x + 30, a.y, { steps: 3 });
  // The grid (ticks + row bands) shows during the drag; the outline fits.
  await expect(page.getByTestId('rack-grid')).toBeVisible();
  await expect(page.getByTestId('rack-grid').locator('.band')).toHaveCount(new Set(Object.values(before).map((r) => Math.round(r.top))).size);
  await expect(page.getByTestId('rack-drop-outline')).not.toHaveAttribute('data-refused', 'true');
  await page.mouse.up();
  await expect(page.getByTestId('rack-grid')).toHaveCount(0);
  await expect.poll(() => undoLabel(page)).toBe('Move module');
  // The first drag pinned every module exactly where it was drawn: none moved but the dragged one (3 grid units).
  await expect.poll(async () => (await panelRects(page))[last].left).toBeCloseTo(before[last].left + 30, 0);
  const after = await panelRects(page);
  for (const [k, r] of Object.entries(before)) {
    if (Number(k) === last) continue;
    expect(Math.abs(after[Number(k)].left - r.left), `module ${k} left`).toBeLessThanOrEqual(1);
    expect(Math.abs(after[Number(k)].top - r.top), `module ${k} top`).toBeLessThanOrEqual(1);
  }
  expect(Object.values(await positions(page)).every((q) => q !== null)).toBe(true);
  await expect.poll(async () => { const e = await plugError(page); return e.n > 0 && e.worst <= 3; }).toBe(true);
});

test('a drop onto another module is refused: red outline, nothing moves, nothing written', async ({ page }) => {
  await loadBrass(page);
  const before = await panelRects(page);
  const was = await undoLabel(page);
  expect(Math.abs(before[1].top - before[0].top)).toBeLessThan(1); // 0 and 1 share the first row
  // Module 0's left onto module 1's left: deep inside 1 (no free spot within the snap reach).
  const a = await headerGrip(page, 0);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + (before[1].left - before[0].left), a.y, { steps: 6 });
  await expect(page.getByTestId('rack-drop-outline')).toHaveAttribute('data-refused', 'true');
  await expect(page.getByTestId('rack-drop-refusal')).toHaveText(NO_ROOM);
  await page.mouse.up();
  await expect(page.getByTestId('flash-hint')).toHaveText(NO_ROOM);
  expect(await anyPos(page)).toBe(false); // not even pinned
  expect(await undoLabel(page)).toBe(was);
  const after = await panelRects(page);
  for (const [k, r] of Object.entries(before)) expect(Math.abs(after[Number(k)].left - r.left) + Math.abs(after[Number(k)].top - r.top), `module ${k}`).toBeLessThanOrEqual(1);
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

  // Module 7 into the VCA's row, as close as it may go (one grid unit clear, rackLayout GAP): a nudge right
  // would leave no gap.
  const w7 = Math.ceil(rects[7].width / 10);
  await dragToGridX(page, 7, 1000 - w7 - 1, 6);
  pos = await positions(page);
  expect(pos[7]).toEqual({ row: pos[6]!.row, x: 1000 - w7 - 1 });
  await page.getByTestId('module-header-7').focus();
  await page.keyboard.press('Alt+ArrowRight');
  expect(await positions(page)).toEqual(pos); // refused, nothing written (the VCA is not pushed)
  await expect(page.getByTestId('jack-status')).toHaveText(NO_ROOM); // and says why

  // A drop onto the VCA is refused too (red outline + hint, no write).
  a = await headerGrip(page, 7);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 50, a.y, { steps: 4 });
  await expect(page.getByTestId('rack-drop-outline')).toHaveAttribute('data-refused', 'true');
  await expect(page.getByTestId('rack-drop-refusal')).toHaveText(NO_ROOM);
  await page.mouse.up();
  await expect(page.getByTestId('flash-hint')).toHaveText(NO_ROOM);
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

test('a near miss snaps to the free spot beside a neighbour; Alt+Left into it does nothing', async ({ page }) => {
  await loadBrass(page);
  const rects = await panelRects(page);
  expect(Math.abs(rects[2].top - rects[1].top)).toBeLessThan(1); // 1 and 2 share the first row, 2 last
  const x1 = (rects[1].left - 6) / 10;
  const end1 = x1 + Math.ceil(rects[1].width / 10); // module 1's right edge (grid units)
  // Pin with 2 moved 6 units right (free space), then 2 dropped 1 unit into 1: it snaps to one grid unit
  // (rackLayout GAP, 10 px) clear of 1's right edge.
  await dragHeader(page, 2, 60, 0);
  const x2 = (await positions(page))[2]!.x;
  expect(x2).toBe((rects[2].left - 6) / 10 + 6);
  await dragToGridX(page, 2, end1 - 1);
  let pos = await positions(page);
  expect(pos[2]).toEqual({ row: 0, x: end1 + 1 });
  expect(pos[1]).toEqual({ row: 0, x: x1 }); // module 1 never moves
  const r2 = await panelRects(page);
  expect(r2[2].left - (r2[1].left + r2[1].width)).toBeCloseTo(10, 0); // the gap on screen: exactly 10 px
  // Alt+Left into the one-unit gap (it would touch): nothing written, the live region says why.
  await page.getByTestId('module-header-2').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  expect(await positions(page)).toEqual(pos);
  await expect(page.getByTestId('jack-status')).toHaveText(NO_ROOM);
  // Alt+Right into free space moves it.
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(async () => (await positions(page))[2]).toEqual({ row: 0, x: end1 + 2 });
  pos = await positions(page);
  // A deep overlap (5 units into 1) is refused; Esc mid-drag writes nothing either.
  const a = await headerGrip(page, 2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x - 60, a.y, { steps: 5 });
  await expect(page.getByTestId('rack-drop-outline')).toHaveAttribute('data-refused', 'true');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await positions(page)).toEqual(pos);
});

/** Every module's natural height (without the stretch spacer) and drawn height, by idx. */
const heights = (page: Page) =>
  page.locator('[data-testid^="module-"]:not([data-testid^="module-header-"])').evaluateAll((els) => Object.fromEntries(els.map((e) => {
    const el = e as HTMLElement;
    const sp = el.querySelector<HTMLElement>(':scope > [data-stretch]');
    return [Number(el.dataset.testid!.slice('module-'.length)), { h: el.offsetHeight, natural: el.offsetHeight - (sp?.offsetHeight ?? 0) }];
  })));

test('every row is as tall as the tallest panel; removing it shrinks them (no ratchet)', async ({ page }) => {
  await loadBrass(page);
  // Flow and positioned alike: every panel is drawn as tall as the rack's tallest.
  let hs = await heights(page);
  const top = Math.max(...Object.values(hs).map((q) => q.natural));
  expect(Object.values(hs).every((q) => q.h === top)).toBe(true);
  await page.getByTestId('module-header-6').focus();
  await page.keyboard.press('Alt+ArrowRight'); // pin
  expect(await anyPos(page)).toBe(true);
  hs = await heights(page);
  expect(Object.values(hs).every((q) => q.h === top)).toBe(true);
  // Remove the tallest (every module that tall): the bands shrink to the next tallest.
  const tallOnes = Object.entries(hs).filter(([, q]) => q.natural === top).map(([k]) => Number(k));
  const rest = Math.max(...Object.entries(hs).filter(([k]) => !tallOnes.includes(Number(k))).map(([, q]) => q.natural));
  expect(rest).toBeLessThan(top);
  for (const i of tallOnes) await page.getByTestId(`module-header-${i}`).getByRole('button', { name: /^Remove / }).click();
  await expect.poll(async () => Object.values(await heights(page)).every((q) => q.h === rest)).toBe(true);
});

test('other modules never move up or down: a drag out of a row, Alt+Down, a removal in a middle row', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await loadBrass(page);
  const rowOf = async () => Object.fromEntries(Object.entries(await positions(page)).map(([k, q]) => [Number(k), q]));
  // 1. The tallest module of the second flow row to a new row (it was the row's height before plan 22's bands).
  let before = await panelRects(page);
  const rowTops = [...new Set(Object.values(before).map((r) => Math.round(r.top)))].sort((a, b) => a - b);
  const row1 = Object.entries(before).filter(([, r]) => Math.round(r.top) === rowTops[1]).map(([k]) => Number(k));
  const hs = await heights(page);
  const tall = row1.reduce((x, y) => (hs[y].natural > hs[x].natural ? y : x));
  const lastBottom = Math.max(...Object.values(before).map((r) => r.bottom));
  await dragHeader(page, tall, 0, lastBottom + 40 - before[tall].top);
  await expect.poll(() => undoLabel(page)).toBe('Move module');
  expect((await rowOf())[tall]!.row).toBe(rowTops.length); // a new row below the others
  await settled(page, before, tall); // the move is drawn: only now can "nothing else moved" be checked
  await expect.poll(async () => maxShift(before, await panelRects(page), [tall])).toBeLessThanOrEqual(1);

  // 2. Alt+Down out of a row: the first module that fits one row down at the same x (not a new row).
  before = await panelRects(page);
  const pos = await rowOf();
  const w = (i: number) => Math.ceil(before[i].width / 10);
  const free = (i: number) => {
    const r = pos[i]!.row + 1;
    // rackLayout fits: one grid unit (GAP) clear of every row neighbour.
    return Object.entries(pos).every(([k, q]) => Number(k) === i || q!.row !== r || q!.x + w(Number(k)) + 1 <= pos[i]!.x || pos[i]!.x + w(i) + 1 <= q!.x);
  };
  const lastRow = Math.max(...Object.values(pos).map((q) => q!.row));
  const down = Number(Object.keys(pos).find((k) => pos[Number(k)]!.row < lastRow - 1 && free(Number(k))));
  expect(Number.isNaN(down)).toBe(false);
  await page.getByTestId(`module-header-${down}`).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(async () => (await rowOf())[down]!.row).toBe(pos[down]!.row + 1);
  await settled(page, before, down);
  await expect.poll(async () => maxShift(before, await panelRects(page), [down])).toBeLessThanOrEqual(1);

  // 3. Remove a module of a middle row (not the rack's tallest: that would shrink every band).
  before = await panelRects(page);
  const now = await rowOf();
  const maxRow = Math.max(...Object.values(now).map((q) => q!.row));
  const h2 = await heights(page);
  const top = Math.max(...Object.values(h2).map((q) => q.natural));
  const gone = Number(Object.keys(now).find((k) => now[Number(k)]!.row > 0 && now[Number(k)]!.row < maxRow && h2[Number(k)].natural < top));
  expect(Number.isNaN(gone)).toBe(false);
  await page.getByTestId(`module-header-${gone}`).getByRole('button', { name: /^Remove / }).click();
  await expect(page.getByTestId(`module-${gone}`)).toHaveCount(0);
  await expect.poll(async () => maxShift(before, await panelRects(page), [gone])).toBeLessThanOrEqual(1);
});

test('a refused nudge flashes the module red and is announced again each time', async ({ page }) => {
  await loadBrass(page);
  const rects = await panelRects(page);
  expect(Math.abs(rects[1].top - rects[0].top)).toBeLessThan(1);
  // Module 1 touches module 0 in the flow (its footprint ends where 1 starts): Alt+Left is refused.
  await page.getByTestId('module-header-1').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.getByTestId('rack-bump-outline')).toBeVisible();
  await expect(page.getByTestId('jack-status')).toHaveText(NO_ROOM);
  // The second refusal clears the region first, then says it again (a polite region re-announces only a change).
  const seen = page.evaluate(() => new Promise<string[]>((resolve) => {
    const el = document.querySelector('[data-testid="jack-status"]')!;
    const texts: string[] = [];
    new MutationObserver(() => { texts.push(el.textContent ?? ''); if (texts.length >= 2) resolve(texts); })
      .observe(el, { childList: true, characterData: true, subtree: true });
  }));
  await page.keyboard.press('Alt+ArrowLeft');
  expect(await seen).toEqual(['', NO_ROOM]);
  expect(await anyPos(page)).toBe(false); // nothing written
  await expect(page.getByTestId('rack-bump-outline')).toHaveCount(0); // the flash ends
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

// ---- Plan 21 Task 10: mechanical faceplates — mech knobs, vertical faders, LED choices ----
// (Plan 20's horizontal slider is gone from the rack; it stays on the top
// bar's Master, covered in topbar.spec.ts. Its maths are unit-tested.)

/** The default synth track (Deep Bass: MIDI In 0, Filter 4, ADSR 5) with the rack open. */
async function loadDeepBass(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByTestId('knob-4-reso')).toBeVisible();
}

/** Scroll a control to the middle of the rail: the mouse helpers aim at boundingBox() points. */
const centreOn = (page: Page, testid: string) =>
  page.getByTestId(testid).evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));

const valueOf = async (page: Page, testid: string) => Number(await page.getByTestId(testid).getAttribute('aria-valuenow'));

/** Filter resonance: 0..1, lin, default 0.2 (engine/catalog.json); a mech knob. */
const RESO = 'knob-4-reso';
const RESO_DEFAULT = 0.2;
/** ADSR sustain: 0..1, lin, default 0.7; a vertical fader (controlMap VFADERS). */
const SUSTAIN = 'knob-5-sustain';
const SUSTAIN_DEFAULT = 0.7;

/** The centre of a mech knob's dial (viewport px). */
async function dialCentre(page: Page, testid: string) {
  const b = (await page.getByTestId(testid).locator('.mdial').boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** A point on the sustain fader's slot at `frac` of its height from the bottom (the live rect). */
async function onSlot(page: Page, frac: number) {
  const b = (await page.getByTestId(`${SUSTAIN}-track`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height * (1 - frac), h: b.height };
}

test('mech knob: drag, Shift-fine, typed entry, reset, keys, cancel; one undo entry each', async ({ page }) => {
  await loadDeepBass(page);
  await centreOn(page, RESO);
  const knob = page.getByTestId(RESO);
  await expect(knob).toHaveAttribute('role', 'slider');
  await expect(knob).toHaveAttribute('aria-label', 'Filter Resonance');
  await expect(knob).toHaveClass(/mech/);
  await expect(page.getByTestId(`${RESO}-track`)).toHaveCount(0); // a dial: no track
  // md: a 58 px dial (knobMath MECH_DIAL_PX); the hero (cutoff) is lg, 86 px.
  expect(Math.round((await knob.locator('.mdial').boundingBox())!.width)).toBe(58);
  expect(Math.round((await page.getByTestId('knob-4-cutoff').locator('.mdial').boundingBox())!.width)).toBe(86);

  // Typed entry through the value chip.
  await knob.getByTestId('knob-readout').click();
  await knob.getByTestId('knob-entry').fill('35');
  await knob.getByTestId('knob-entry').press('Enter');
  await expect(knob.getByTestId('knob-readout')).toHaveText('35%');
  expect(await valueOf(page, RESO)).toBeCloseTo(0.35, 5);

  // A click on the dial without moving changes nothing (no click-jump on a knob).
  const label0 = await undoLabel(page);
  let c = await dialCentre(page, RESO);
  await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(100);
  expect(await valueOf(page, RESO)).toBeCloseTo(0.35, 5);
  expect(await undoLabel(page)).toBe(label0);

  // Drag up 75 px (half of DRAG_PX = 150): +0.5, one entry.
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 3, c.y - 40, { steps: 4 });
  await page.mouse.move(c.x, c.y - 75, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => valueOf(page, RESO)).toBeCloseTo(0.85, 2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, RESO)).toBeCloseTo(0.35, 5);

  // Shift = 10x finer: 75 px moves 0.05.
  c = await dialCentre(page, RESO);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(c.x, c.y - 75, { steps: 6 });
  await page.keyboard.up('Shift');
  await page.mouse.up();
  await expect.poll(() => valueOf(page, RESO)).toBeCloseTo(0.4, 2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, RESO)).toBeCloseTo(0.35, 5);

  // Double-click resets to the default; one entry.
  await knob.locator('.mdial').dblclick();
  await expect.poll(() => valueOf(page, RESO)).toBeCloseTo(RESO_DEFAULT, 5);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, RESO)).toBeCloseTo(0.35, 5);

  // Cmd/Ctrl+Z mid-drag cancels the drag: the value from before it, no entry.
  c = await dialCentre(page, RESO);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y - 30, { steps: 4 });
  await expect.poll(() => valueOf(page, RESO)).toBeCloseTo(0.55, 2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, RESO)).toBeCloseTo(0.35, 5);
  await page.mouse.move(c.x, c.y - 60, { steps: 4 }); // the cancelled drag moves nothing
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await valueOf(page, RESO)).toBeCloseTo(0.35, 5);

  // Keys: ArrowUp +1 % of travel, ArrowDown back.
  await knob.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => valueOf(page, RESO)).toBeCloseTo(0.36, 5);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => valueOf(page, RESO)).toBeCloseTo(0.35, 5);
});

/**
 * The vertical fader's gestures, one undo entry each: typed entry, a
 * relative drag (pressing away from the cap does not jump), Shift-fine, a
 * click-jump, double-click reset, Cmd/Ctrl+Z mid-drag, keys. Ends at 0.35.
 */
async function vfaderGestures(page: Page) {
  const f = page.getByTestId(SUSTAIN);
  await expect(f).toHaveAttribute('role', 'slider');
  await expect(f).toHaveAttribute('aria-label', /Sustain$/);
  await expect(f).toHaveAttribute('aria-orientation', 'vertical');

  // Typed entry through the value chip.
  await f.getByTestId('knob-readout').click();
  await f.getByTestId('knob-entry').fill('35');
  await f.getByTestId('knob-entry').press('Enter');
  await expect(f.getByTestId('knob-readout')).toHaveText('35%');
  expect(await valueOf(page, SUSTAIN)).toBeCloseTo(0.35, 5);

  // Drag up 50 % of the slot, pressed at 80 % (away from the cap): relative, no jump at the press -> 0.85.
  let a = await onSlot(page, 0.8);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 4, a.y - a.h / 4, { steps: 4 });
  await page.mouse.move(a.x, a.y - a.h / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.85, 2);
  await page.keyboard.press('ControlOrMeta+z'); // one entry for the whole drag
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.35, 5);

  // Shift = 10x finer: 50 % of the slot moves 5 %.
  a = await onSlot(page, 0.35);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(a.x, a.y - a.h / 2, { steps: 6 });
  await page.keyboard.up('Shift');
  await page.mouse.up();
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.4, 2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.35, 5);

  // A click without travel jumps the value under the pointer: one entry.
  a = await onSlot(page, 0.1);
  await page.mouse.click(a.x, a.y);
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.1, 2);
  // Under 3 px of travel is still a click: it jumps to where the pointer is let go.
  a = await onSlot(page, 0.6);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y - 2);
  await page.mouse.up();
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.6 + 2 / a.h, 2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.1, 2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.35, 5);

  // Double-click (on the label) resets to the default; one entry.
  await f.getByText('Sustain', { exact: true }).dblclick();
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(SUSTAIN_DEFAULT, 5);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.35, 5);

  // Cmd/Ctrl+Z mid-drag cancels the drag: the value from before it, no entry.
  a = await onSlot(page, 0.35);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y - a.h / 4, { steps: 4 });
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.6, 2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.35, 5);
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await valueOf(page, SUSTAIN)).toBeCloseTo(0.35, 5);

  // Keys: ArrowUp +1 % of travel, ArrowDown back.
  await f.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.36, 5);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(0.35, 5);
}

test('vertical fader: drag, click-jump, typed entry, reset, keys, cancel; one undo entry each', async ({ page }) => {
  await loadDeepBass(page);
  await centreOn(page, SUSTAIN);
  await vfaderGestures(page);
  // The envelope's four stages are faders; its delay and velocity amount are compact knobs.
  for (const p of ['attack', 'decay', 'sustain', 'release']) await expect(page.getByTestId(`knob-5-${p}-track`)).toHaveCount(1);
  for (const p of ['delay', 'vel_amt']) {
    await expect(page.getByTestId(`knob-5-${p}`)).toHaveClass(/mech/);
    expect(Math.round((await page.getByTestId(`knob-5-${p}`).locator('.mdial').boundingBox())!.width)).toBe(46);
  }
});

test('vertical fader in a horizontally scrolled rack', async ({ page }) => {
  await loadDeepBass(page);
  // Pin the ADSR far right (a positioned rack scrolls sideways), then scroll it into view.
  await dragHeader(page, 5, 1600, 0);
  const rail = page.getByTestId('rail');
  await expect.poll(() => rail.evaluate((r) => r.scrollWidth > r.clientWidth + 100)).toBe(true);
  await centreOn(page, SUSTAIN);
  expect(await rail.evaluate((r) => r.scrollLeft)).toBeGreaterThan(300);
  await vfaderGestures(page);
});

test('vertical fader: a press on the cap never jumps; sideways wobble is still a click', async ({ page }) => {
  await loadDeepBass(page);
  await centreOn(page, SUSTAIN);
  const v0 = await valueOf(page, SUSTAIN);
  const label0 = await undoLabel(page);
  const cap = page.getByTestId(SUSTAIN).locator('.handle');

  // Pressed and let go on the cap, off its centre: nothing changes, no entry.
  let h = (await cap.boundingBox())!;
  await page.mouse.click(h.x + h.width / 2 + 6, h.y + h.height / 2 + 3);
  await page.waitForTimeout(100);
  expect(await valueOf(page, SUSTAIN)).toBe(v0);
  expect(await undoLabel(page)).toBe(label0);

  // Grabbed by the cap, a drag is relative from the first pixel: +25 % of the slot.
  const len = (await onSlot(page, 0)).h;
  h = (await cap.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2 + 6, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 6, h.y + h.height / 2 - len / 4, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(Math.min(1, v0 + 0.25), 2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(v0, 5);

  // A click that wobbles sideways (no vertical travel) is still a click: it jumps.
  const frac = v0 > 0.5 ? 0.1 : 0.9;
  const a = await onSlot(page, frac);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 8, a.y, { steps: 3 });
  await page.mouse.move(a.x - 5, a.y - 1, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(frac + 1 / a.h, 2);
  await page.keyboard.press('ControlOrMeta+z'); // one entry
  await expect.poll(() => valueOf(page, SUSTAIN)).toBeCloseTo(v0, 5);
});

/** Feed raw MIDI bytes (window.__daw.midi.inject, as midi.spec.ts), then wait two frames. */
async function inject(page: Page, bytes: number[]) {
  await page.evaluate(
    (b) =>
      new Promise<void>((resolve) => {
        (window as unknown as { __daw: { midi: { inject: (b: number[]) => void } } }).__daw.midi.inject(b);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
    bytes,
  );
}

type AutoDaw = {
  project: { tracks: { id: string; automation?: { id: string; target: { module?: number; param: string } }[] }[] };
  actions: {
    addLane: (owner: string, target: { kind: 'rack'; module: number; param: string }) => string | null;
    drawLane: (lane: string, samples: { tick: number; value: number }[]) => unknown;
    seek: (ticks: number) => unknown;
  };
};

test('mech knob and vertical fader: MIDI learn ring and CC tag, the control menu, automation follow', async ({ page }) => {
  await loadDeepBass(page);
  await page.waitForFunction(() => !!(window as unknown as { __daw: { midi?: unknown } }).__daw.midi);
  const cases = [
    { testid: RESO, module: 4, param: 'reso', cc: 21 },
    { testid: SUSTAIN, module: 5, param: 'sustain', cc: 22 },
  ];
  for (const { testid, cc } of cases) {
    await centreOn(page, testid);
    const ctl = page.getByTestId(testid);
    const before = await valueOf(page, testid);
    await ctl.click({ button: 'right' });
    await expect(page.getByTestId('auto-ctl-automate')).toHaveText('Automate');
    await expect(page.getByTestId('auto-ctl-midi')).toHaveText('MIDI learn');
    await page.getByTestId('auto-ctl-midi').click();
    await expect(ctl).toHaveClass(/learning/);
    await inject(page, [0xb0, cc, 64]); // binds only
    await expect(ctl).not.toHaveClass(/learning/);
    await expect(page.getByTestId(`${testid}-cc`)).toBeVisible();
    await expect(ctl).toHaveAttribute('title', new RegExp(`MIDI CC ${cc}`));
    expect(await valueOf(page, testid)).toBe(before);
    await inject(page, [0xb0, cc, 127]);
    await expect.poll(() => valueOf(page, testid)).toBe(1);
    await page.keyboard.press('ControlOrMeta+z'); // the sweep is one entry
    await expect.poll(() => valueOf(page, testid)).toBe(before);
  }

  // Automate from the vertical fader's menu: a lane for it, then "Show automation".
  await centreOn(page, SUSTAIN);
  const sus = page.getByTestId(SUSTAIN);
  await sus.click({ button: 'right' });
  await page.getByTestId('auto-ctl-automate').click();
  await expect(sus).toHaveAttribute('data-auto', 'idle');
  await expect(sus.getByTestId('auto-badge')).toBeVisible();
  await sus.click({ button: 'right' });
  await expect(page.getByTestId('auto-ctl-automate')).toHaveText('Show automation');
  await page.keyboard.press('Escape');

  // Ramps on both (the knob's lane added directly), then Song mode at 0: each follows its lane's first point.
  await page.evaluate(() => {
    const d = (window as unknown as { __daw: AutoDaw }).__daw;
    const t = d.project.tracks.at(-1)!;
    const sustain = t.automation!.find((l) => l.target.param === 'sustain')!.id;
    d.actions.drawLane(sustain, [{ tick: 0, value: 0.9 }, { tick: 3840, value: 0.2 }]);
    const reso = d.actions.addLane(t.id, { kind: 'rack', module: 4, param: 'reso' })!;
    d.actions.drawLane(reso, [{ tick: 0, value: 0.1 }, { tick: 3840, value: 0.8 }]);
  });
  await page.getByTestId('play').click(); // the song transport ran last: Song mode
  await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('play').click();
  await page.evaluate(() => (window as unknown as { __daw: AutoDaw }).__daw.actions.seek(0));
  const knob = page.getByTestId(RESO);
  await expect(knob).toHaveAttribute('data-auto', 'on');
  await expect(sus).toHaveAttribute('data-auto', 'on');
  expect(Number(await knob.getAttribute('data-auto-pos'))).toBeCloseTo(0.1, 2);
  expect(Number(await sus.getAttribute('data-auto-pos'))).toBeCloseTo(0.9, 2);
  // The heard value is drawn: the knob's pointer, the fader's cap; the chips show it in italics.
  await expect(knob.locator('.ptr')).toHaveAttribute('transform', 'rotate(-108.0 50 50)'); // -135 + 270 * 0.1
  await expect(sus.locator('.handle')).toHaveAttribute('style', /translateY\(-90(\.0+)?cqb\)/);
  await expect(knob.getByTestId('knob-readout')).toHaveAttribute('data-auto', 'on');
  await expect(knob.getByTestId('knob-readout')).toHaveText('10%');
  await expect(sus.getByTestId('knob-readout')).toHaveText('90%');
});

test('LED choice: click and arrow keys pick, one undo entry each', async ({ page }) => {
  await loadDeepBass(page);
  await centreOn(page, 'knob-4-mode');
  const group = page.getByTestId('knob-4-mode');
  await expect(group).toHaveAttribute('role', 'radiogroup');
  await expect(group).toHaveAttribute('aria-label', 'Filter Mode');
  const opts = group.getByRole('radio');
  await expect(opts).toHaveCount(6);
  await expect(opts.first()).toHaveClass(/mech-btn/); // LED push-buttons (6 or fewer choices)
  const checked = async () => (await opts.evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked')))).indexOf('true');
  /** Which LED is lit (the one above the picked button). */
  const lit = async () => (await group.locator('.led').evaluateAll((els) => els.map((e) => e.classList.contains('lit')))).indexOf(true);
  const start = await checked();
  expect(await lit()).toBe(start);
  const pick = start === 2 ? 3 : 2;

  await page.getByTestId(`knob-4-mode-${pick}`).click();
  await expect.poll(checked).toBe(pick);
  await expect.poll(lit).toBe(pick);
  await expect.poll(() => undoLabel(page)).toBe('Set Mode'); // a gesture's entry lands a task after the release
  await expect(page.getByTestId(`knob-4-mode-${pick}`)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(checked).toBe(pick + 1);
  await expect(page.getByTestId(`knob-4-mode-${pick + 1}`)).toBeFocused(); // roving focus follows
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(checked).toBe(pick - 1);

  // One entry per change: the three keys, then the click.
  for (const want of [pick, pick + 1, pick, start]) {
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(checked).toBe(want);
  }
});

test('integer mech knob: a drag steps whole values, one undo entry', async ({ page }) => {
  await loadDeepBass(page);
  const voices = page.getByTestId('knob-0-voices'); // MIDI In voices: 1..16, integer
  await centreOn(page, 'knob-0-voices');
  await expect(voices).toHaveAttribute('role', 'slider');
  await expect(voices).toHaveClass(/mech/);
  const v0 = await valueOf(page, 'knob-0-voices');
  // 15 steps over DRAG_PX (150 px): 10 px a voice. Up 21 px -> two more voices.
  const c = await dialCentre(page, 'knob-0-voices');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y - 21, { steps: 6 });
  await page.mouse.up();
  await expect(voices).toHaveAttribute('aria-valuenow', String(v0 + 2));
  await expect(voices.getByTestId('knob-readout')).toHaveText(String(v0 + 2));
  await page.keyboard.press('ControlOrMeta+z');
  await expect(voices).toHaveAttribute('aria-valuenow', String(v0));
});

test('a choice with more than 6 options is a select; the faceplate', async ({ page }) => {
  await loadDeepBass(page);
  await page.getByRole('button', { name: '+ Add module' }).click();
  await page.getByTestId('add-lfo').click(); // Deep Bass has 8 modules: the LFO is 8
  const div = page.getByTestId('knob-8-division');
  await div.scrollIntoViewIfNeeded();
  expect(await div.evaluate((e) => e.tagName)).toBe('SELECT');
  await expect(div).toHaveAttribute('aria-label', 'LFO Division');
  const checked = div.locator('option:checked');
  const t0 = (await checked.textContent())!;
  const pick = t0 === '1 bar' ? '2 bars' : '1 bar';
  await div.selectOption({ label: pick });
  await expect(checked).toHaveText(pick);
  await expect.poll(() => undoLabel(page)).toBe('Set Division');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(checked).toHaveText(t0);
  // Wave (4 choices) is LED buttons; Rate is the LFO's hero (lg) dial; Depth a mech knob.
  await expect(page.getByTestId('knob-8-wave')).toHaveAttribute('role', 'radiogroup');
  await expect(page.getByTestId('knob-8-rate')).toHaveAttribute('role', 'slider');
  expect(Math.round((await page.getByTestId('knob-8-rate').locator('.mdial').boundingBox())!.width)).toBe(86);
  await expect(page.getByTestId('knob-8-depth')).toHaveClass(/mech/);
  await expect(page.getByTestId('knob-8-depth-track')).toHaveCount(0);
  // The faceplate: four screws, the header strip, metal jack sockets.
  const panel = page.getByTestId('module-8');
  await expect(panel).toHaveClass(/mech-panel/);
  await expect(panel.locator('.screw')).toHaveCount(4);
  await expect(page.getByTestId('module-header-8')).toHaveClass(/mech-head/);
  const hole = (await panel.locator('[data-jack] .hole').first().boundingBox())!;
  expect(Math.round(hole.width)).toBe(18);
});

// ---- Plan 22 final fix D: cables under a hovered panel ------------------------

/**
 * A panel crossed by a cable that is not plugged into it, and a point (viewport
 * px) on that cable inside the panel, clear of the panel's edges. Prefers
 * `prefer` (aria-label), else the first panel that has one; the point is in
 * the rail's visible part (scrolled panels are out of reach) and clear of the
 * panel's own cables (those stay on top). Reads the main
 * cable layer's paths (data-cable = the input end's key "m:in:port"; the
 * cables in track order pair with the project's cables).
 */
async function crossedPanel(page: Page, prefer: string) {
  return page.evaluate((prefer) => {
    type Cable = { from: { m: number }; to: { m: number } };
    const tracks = (window as unknown as { __daw: { project: { tracks: { cables?: Cable[] }[] } } }).__daw.project.tracks;
    const cables = tracks[1].cables ?? [];
    const paths = [...document.querySelectorAll<SVGPathElement>('[data-testid="cables"] path.cable')];
    const panels = [...document.querySelectorAll<HTMLElement>('.mech-panel[data-testid^="module-"]')];
    const rail = document.querySelector('[data-testid="rail"]')!.getBoundingClientRect(); // visible part only
    panels.sort((a, b) => Number(b.getAttribute('aria-label') === prefer) - Number(a.getAttribute('aria-label') === prefer));
    for (const el of panels) {
      const idx = Number(el.dataset.testid!.slice('module-'.length));
      const r = el.getBoundingClientRect();
      // Points on its own cables (drawn above it when raised): the chosen point stays clear of them.
      const ownPts = paths.flatMap((path, k) => {
        const c = cables[k];
        if (!c || (c.from.m !== idx && c.to.m !== idx)) return [];
        const svg = path.ownerSVGElement!.getBoundingClientRect();
        const pts: { x: number; y: number }[] = [];
        for (let s = 0; s <= path.getTotalLength(); s += 2) {
          const p = path.getPointAtLength(s);
          pts.push({ x: svg.left + p.x, y: svg.top + p.y });
        }
        return pts;
      });
      for (const [k, path] of paths.entries()) {
        const c = cables[k];
        if (!c || c.from.m === idx || c.to.m === idx) continue;
        const svg = path.ownerSVGElement!.getBoundingClientRect();
        const len = path.getTotalLength();
        for (let s = 0; s <= len; s += 4) {
          const p = path.getPointAtLength(s);
          const x = svg.left + p.x;
          const y = svg.top + p.y;
          const inPanel = x > r.left + 12 && x < r.right - 12 && y > r.top + 40 && y < r.bottom - 12;
          const visible = x > rail.left + 4 && x < rail.right - 4 && y > rail.top + 4 && y < rail.bottom - 4;
          if (inPanel && visible && ownPts.every((q) => Math.hypot(q.x - x, q.y - y) > 8)) {
            return { idx, label: el.getAttribute('aria-label'), x, y, own: cables.filter((q) => q.from.m === idx || q.to.m === idx).length };
          }
        }
      }
    }
    return null;
  }, prefer);
}

/** What is hit at (x, y) with every cable stroke made hit-testable: a cable path, or the module panel the hit is in. */
const hitAt = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return 'nothing';
    if (el.closest('svg')) return `cable in ${el.closest('svg')!.getAttribute('data-testid')}`;
    return el.closest<HTMLElement>('.mech-panel[data-testid]')?.dataset.testid ?? el.tagName;
  }, [x, y]);

test('a hovered panel draws over the cables that are not plugged into it; its own stay on top', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  await page.getByRole('button', { name: 'Instrument' }).click();
  await page.getByTestId('patch-select').selectOption('Acid Line');
  await expect.poll(() => page.locator('[data-testid="cables"] path.cable').count()).toBeGreaterThan(3);
  // The cables are pointer-events: none (they never steal a click); to see what is DRAWN on top at a point, make
  // the main and own layers' strokes hit-testable (the veil fades to transparent and is left out).
  await page.addStyleTag({ content: '[data-testid="cables"] path, [data-testid="cables-own"] path { pointer-events: visibleStroke !important; }' });
  await page.mouse.move(2, 2); // nothing hovered
  const hit = await crossedPanel(page, 'Mixer 2');
  expect(hit, 'a cable crosses some panel it is not plugged into').not.toBeNull();
  const { idx, x, y, own, label } = hit!;
  test.info().annotations.push({ type: 'panel', description: `${label} (module-${idx})` });
  const panel = page.getByTestId(`module-${idx}`);
  // Not hovered: the cable is drawn over the panel (as in VCV).
  expect(await hitAt(page, x, y)).toBe('cable in cables');
  await expect(page.getByTestId('cables-own')).toHaveCount(0);

  // Hover the panel (its header, away from the point): the panel is over that cable now...
  await page.getByTestId(`module-header-${idx}`).hover();
  await expect.poll(() => hitAt(page, x, y)).toBe(`module-${idx}`);
  await expect(panel).toHaveClass(/\braised\b/);
  // ...the veil has faded out (120 ms)...
  await expect.poll(() => page.getByTestId('cables-veil').evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
  // ...and its own cables are still drawn, above it, out of the main layer.
  expect(own).toBeGreaterThan(0);
  await expect(page.getByTestId('cables-own').locator('path.cable')).toHaveCount(own);
  await expect(page.getByTestId('cables').locator('path.cable.up')).toHaveCount(own); // hidden there

  // Leave: the cable is over the panel again once the fade back is done.
  await page.mouse.move(2, 2);
  await expect.poll(() => hitAt(page, x, y)).toBe('cable in cables');
  await expect(page.getByTestId('cables-own')).toHaveCount(0);
  await expect(page.getByTestId('cables').locator('path.cable.up')).toHaveCount(0);

  // Keyboard focus inside the panel raises it too; focus leaving the rack lowers it.
  await page.getByTestId(`module-header-${idx}`).focus();
  await expect.poll(() => hitAt(page, x, y)).toBe(`module-${idx}`);
  await page.getByTestId('patch-select').focus();
  await expect.poll(() => hitAt(page, x, y)).toBe('cable in cables');

  // A module drag keeps every cable on top (as before).
  const hb = (await page.getByTestId(`module-header-${idx}`).boundingBox())!;
  await page.mouse.move(hb.x + 30, hb.y + hb.height / 2);
  await expect(panel).toHaveClass(/\braised\b/);
  await page.mouse.down();
  await page.mouse.move(hb.x + 60, hb.y + hb.height / 2 + 20, { steps: 4 });
  await expect(page.getByTestId('cables-own')).toHaveCount(0);
  await expect(panel).not.toHaveClass(/\braised\b/);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('reduced motion: a hovered panel rises at once, with no fading veil', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  await page.getByRole('button', { name: 'Instrument' }).click();
  await page.getByTestId('patch-select').selectOption('Acid Line');
  await expect.poll(() => page.locator('[data-testid="cables"] path.cable').count()).toBeGreaterThan(3);
  await page.getByTestId('module-header-0').hover();
  await expect(page.getByTestId('module-0')).toHaveClass(/\braised\b/);
  await expect(page.getByTestId('cables-veil')).toBeHidden();
  await page.mouse.move(2, 2);
  await expect(page.getByTestId('module-0')).not.toHaveClass(/\braised\b/); // no fade back to wait for
});
