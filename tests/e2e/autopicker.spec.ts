import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { pickAutomation } from './automate';
import { startApp } from './startApp';

// The grouped automation picker (plan 21 Task 6, ui/song/AutoPicker.svelte;
// spec §9): "Automate…" on an owner's last lane row opens a searchable,
// two-level list. Search filters across groups, the keys move through it,
// Enter picks (one undo entry), Esc closes and gives the focus back.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('tl-lane-0')).toBeVisible();
}

/** The last track's slot and its lanes' targets. */
async function lastTrack(page: Page): Promise<{ slot: number; targets: Any[] }> {
  return page.evaluate(() => {
    const t = (window as Any).__daw.project.tracks.at(-1);
    return { slot: t.slot, targets: t.automation.map((l: Any) => ({ ...l.target })) };
  });
}

/** The label of the row the search field points at (aria-activedescendant). */
async function activeRow(page: Page): Promise<string | null> {
  return page.getByTestId('auto-search').evaluate((el) => {
    const id = el.getAttribute('aria-activedescendant');
    const row = id ? document.getElementById(id) : null;
    return row ? `${row.dataset.group ? `${row.dataset.group} › ` : ''}${row.dataset.name}` : null;
  });
}

const picker = (page: Page) => page.getByTestId('auto-picker');
const item = (page: Page, group: string, name: string) =>
  picker(page).locator(`[data-testid="auto-pick-item"][data-group="${group}"][data-name="${name}"]`);
const head = (page: Page, group: string) => picker(page).locator(`[data-testid="auto-pick-group"][data-name="${group}"]`);

test('search "cut" shows Filter › Cutoff; Enter picks it as one undo entry; Esc closes and returns focus', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  const { slot } = await lastTrack(page);
  await page.getByTestId(`track-auto-${slot}`).click();
  const btn = page.getByTestId(`auto-add-${slot}`);
  await expect(btn).toHaveText(/Automate…/);

  // Esc closes and gives the focus back to the button.
  await btn.click();
  await expect(picker(page)).toBeVisible();
  await expect(page.getByTestId('auto-search')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toBeHidden();
  await expect(btn).toBeFocused();

  // Groups start collapsed: Mixer's five, then the rack's modules.
  await btn.click();
  const groups = await picker(page).locator('[data-testid="auto-pick-group"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name));
  expect(groups.slice(0, 5)).toEqual(['Volume', 'Pan', 'Sends', 'EQ', 'Comp']);
  expect(groups).toContain('Filter');
  await expect(picker(page).locator('[data-testid="auto-pick-item"]')).toHaveCount(0);

  // "cut" (any case) filters across groups and opens what is left.
  await page.keyboard.type('CUT');
  await expect(item(page, 'Filter', 'Cutoff')).toBeVisible();
  await expect(item(page, 'EQ', 'Low cut')).toBeVisible();
  await expect(head(page, 'Volume')).toHaveCount(0);
  expect(await activeRow(page)).toBe('Filter › Cutoff'); // the best match, not the first

  const undoBefore = await page.getByTestId('undo').getAttribute('title');
  await page.keyboard.press('Enter');
  await expect(picker(page)).toBeHidden();
  const after = await lastTrack(page);
  expect(after.targets).toHaveLength(1);
  expect(after.targets[0]).toMatchObject({ kind: 'rack', param: 'cutoff' });
  await expect(page.getByTestId(`auto-lane-${slot}-0`)).toBeVisible();
  await expect(page.getByTestId(`auto-head-${slot}-0`)).toContainText('Filter · Cutoff');

  // One undo entry: one undo takes the lane away, and the history is where it was.
  await page.getByTestId('undo').click();
  expect((await lastTrack(page)).targets).toHaveLength(0);
  await expect(page.getByTestId('undo')).toHaveAttribute('title', undoBefore!);
});

test('keys: Up/Down through rows, Right/Left expand and collapse, used params are disabled', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-auto-0').click();
  await pickAutomation(page, 0, 'Pan', 'Pan');
  const btn = page.getByTestId('auto-add-0');
  await btn.click();
  await expect(page.getByTestId('auto-search')).toBeFocused();
  expect(await activeRow(page)).toBe('Volume');
  await page.keyboard.press('ArrowDown');
  expect(await activeRow(page)).toBe('Pan');
  await page.keyboard.press('ArrowRight'); // expand
  await expect(head(page, 'Pan')).toHaveAttribute('aria-expanded', 'true');
  // Pan already has a lane: listed, disabled, never active.
  const pan = item(page, 'Pan', 'Pan');
  await expect(pan).toHaveAttribute('aria-disabled', 'true');
  await expect(pan).toContainText('already automated');
  await page.keyboard.press('ArrowRight'); // no pickable param: stays on the header
  expect(await activeRow(page)).toBe('Pan');
  await page.keyboard.press('ArrowDown'); // skips the used param
  expect(await activeRow(page)).toBe('Sends');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowLeft'); // collapse
  await expect(head(page, 'Pan')).toHaveAttribute('aria-expanded', 'false');
  await pan.waitFor({ state: 'detached' });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight'); // into the group
  expect(await activeRow(page)).toBe('Sends › Reverb');
  await page.keyboard.press('ArrowLeft'); // back to the header, collapsed
  expect(await activeRow(page)).toBe('Sends');
  await expect(head(page, 'Sends')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter'); // Enter on a header toggles it
  await expect(head(page, 'Sends')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await activeRow(page)).toBe('Sends › Delay');
  await page.keyboard.press('Enter');
  await expect(picker(page)).toBeHidden();
  const targets = await page.evaluate(() => (window as Any).__daw.project.tracks[0].automation.map((l: Any) => l.target.param));
  expect(targets).toEqual(['pan', 'send_b']);

  // A click on a used param does nothing; a press outside closes.
  await page.getByTestId('auto-add-0').click();
  await head(page, 'Pan').click();
  await pan.click({ force: true }); // force: Playwright waits forever on an aria-disabled element
  await expect(picker(page)).toBeVisible();
  await page.getByTestId('timeline').click({ position: { x: 600, y: 10 } });
  await expect(picker(page)).toBeHidden();
  expect(await page.evaluate(() => (window as Any).__daw.project.tracks[0].automation.length)).toBe(2);
});

test('the Master row groups by channel', async ({ page }) => {
  await start(page);
  await addTrack(page, 'master');
  const a = page.getByTestId('master-auto');
  if ((await a.getAttribute('aria-pressed')) !== 'true') await a.click(); // the Master row may open with its lanes shown
  await page.getByTestId('auto-add-m').click();
  const groups = await picker(page).locator('[data-testid="auto-pick-group"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name));
  expect(groups).toEqual(['Master', 'Reverb', 'Delay']);
  await page.keyboard.type('feedback');
  await expect(item(page, 'Delay', 'Feedback')).toBeVisible();
  await page.keyboard.press('Enter');
  const lanes = await page.evaluate(() => (window as Any).__daw.project.mixer.automation.map((x: Any) => `${x.channel}:${x.lane.target.param}`));
  expect(lanes).toEqual(['delay:delay_feedback']);
});

test('a 32-module rack stays usable: grouped, searchable, scrolls inside a max height', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  const { slot } = await lastTrack(page);
  const n = await page.evaluate(() => {
    const d = (window as Any).__daw;
    const t = d.project.tracks.at(-1);
    const kinds = ['osc', 'filter', 'lfo', 'adsr', 'vca', 'noise'];
    const modules = [{ idx: 0, id: 'midi_in' }, { idx: 1, id: 'out' }];
    for (let i = 2; i < 32; i++) modules.push({ idx: i, id: kinds[i % kinds.length] });
    d.actions.loadPatch(t.id, { name: 'Huge', modules, cables: [] });
    return d.project.tracks.at(-1).modules.length;
  });
  expect(n).toBe(32);
  await page.getByTestId(`track-auto-${slot}`).click();
  await page.getByTestId(`auto-add-${slot}`).click();
  const pop = picker(page);
  const box = (await pop.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(361);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  const list = pop.locator('[role="tree"]');
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // The last module is reachable: by the keys (the list scrolls to it) ...
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown');
  const last = pop.locator('[data-testid="auto-pick-group"]').last();
  await expect(last).toBeInViewport();
  expect(await activeRow(page)).toBe(await last.getAttribute('data-name'));
  // ... and by a search.
  await page.keyboard.type('filter 5');
  await expect(item(page, 'Filter 5', 'Cutoff')).toBeVisible();
  await expect(head(page, 'Filter 4')).toHaveCount(0);
  const first = await pop.locator('[data-testid="auto-pick-item"]').first().getAttribute('data-name');
  expect(await activeRow(page)).toBe(`Filter 5 › ${first}`); // a group search: its first param
});

/** A synth track whose rack has 32 modules (the list scrolls); returns its slot, picker open. */
async function hugeRackPicker(page: Page) {
  await addTrack(page, 'synth');
  const { slot } = await lastTrack(page);
  await page.evaluate(() => {
    const d = (window as Any).__daw;
    const t = d.project.tracks.at(-1);
    const kinds = ['osc', 'filter', 'lfo', 'adsr', 'vca', 'noise'];
    const modules = [{ idx: 0, id: 'midi_in' }, { idx: 1, id: 'out' }];
    for (let i = 2; i < 32; i++) modules.push({ idx: i, id: kinds[i % kinds.length] });
    d.actions.loadPatch(t.id, { name: 'Huge', modules, cables: [] });
  });
  await page.getByTestId(`track-auto-${slot}`).click();
  await page.getByTestId(`auto-add-${slot}`).click();
  await expect(page.getByTestId('auto-search')).toBeFocused();
  return slot;
}

test('a press on the list scrollbar keeps the focus in the search; a still pointer never steals the active row', async ({ page }) => {
  await start(page);
  await hugeRackPicker(page);
  const list = picker(page).locator('[role="tree"]');
  const b = (await list.boundingBox())!;
  // The scrollbar lane is the list's right edge (classic scrollbars) or empty list padding: either way not a row.
  await page.mouse.move(b.x + b.width - 3, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByTestId('auto-search')).toBeFocused();
  // Park the pointer over the list, then move with the keys: the list scrolls under the
  // pointer, which sends a pointermove with no movement; the key-chosen row stays active.
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
  const keyed = await activeRow(page);
  await page.waitForTimeout(100);
  expect(await activeRow(page)).toBe(keyed);
  // A real move does take it.
  await page.mouse.move(b.x + 40, b.y + 30);
  await expect.poll(() => activeRow(page)).not.toBe(keyed);
});

test('IME composition and modified arrows stay with the field', async ({ page }) => {
  await start(page);
  await hugeRackPicker(page);
  const before = await activeRow(page);
  // Shift+Down selects text (nothing to select: no-op), never moves the active row.
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Alt+ArrowDown');
  expect(await activeRow(page)).toBe(before);
  // A key event marked isComposing is ignored too.
  await page.getByTestId('auto-search').evaluate((el) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true, cancelable: true })));
  expect(await activeRow(page)).toBe(before);
  await page.keyboard.press('ArrowDown');
  expect(await activeRow(page)).not.toBe(before);
});

test('near the bottom of the window the picker opens above its button', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  const { slot } = await lastTrack(page);
  await page.getByTestId(`track-auto-${slot}`).click();
  const btn = page.getByTestId(`auto-add-${slot}`);
  // Pin the button 30 px above the window's bottom edge (its row is in the top half otherwise).
  await btn.evaluate((el) => Object.assign((el as HTMLElement).style, { position: 'fixed', left: '300px', bottom: '30px', top: 'auto', zIndex: '60' }));
  await btn.click();
  const pop = (await picker(page).boundingBox())!;
  const bb = (await btn.boundingBox())!;
  expect(pop.y + pop.height).toBeLessThanOrEqual(bb.y); // above, not under
  expect(pop.y).toBeGreaterThanOrEqual(0);
});
