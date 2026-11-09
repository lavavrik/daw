import { expect, test, type Page } from '@playwright/test';
import { openMenu } from './topbar';
import { startApp } from './startApp';

// The project's pattern library (plan 21 Task 4; state/pattern-library.ts):
// Patterns ▸ Save to project library… / Load from library ▸ (a submenu) and
// the pattern header's Save / Load icon buttons (a popover). A load makes a
// NEW pattern in the selected track and selects it, as one undo entry; drum
// rows map by role name, then sample name, then by row index, and rows with no place are
// flashed as "N rows not in this kit". The mapping, undo and validation are
// unit-tested in app/src/state/pattern-library.test.ts and project/schema.test.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
/** Run `fn` on window.__daw in the page (its source is sent: it must not close over test variables). */
const daw = (page: Page, fn: (d: Any, arg?: Any) => unknown, arg?: unknown) => page.evaluate(`(${fn.toString()})(window.__daw, ${JSON.stringify(arg)})`);

const KIT = ['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc'];

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  // The starter kit lands asynchronously: wait for its samples.
  for (const [i, name] of KIT.entries()) await expect(page.getByTestId(`row-${i}`).getByTestId('row-name')).toHaveText(name);
}

/** The Undo label (a one-shot edit's entry is closed at the end of its task: poll it). */
const undoLabel = (page: Page) => daw(page, (d) => d.history?.labels.undo ?? null);
/** Step indices that are on in row `row` of the selected track's current pattern. */
const onSteps = (page: Page, row: number) =>
  daw(page, (d: Any, row: number) => {
    const t = d.project.tracks.find((x: Any) => x.id === d.project.selectedTrackId);
    const pat = t.patterns.find((x: Any) => x.id === t.currentPatternId);
    return pat.steps[row].flatMap((v: number, i: number) => (v > 0 ? [i] : []));
  }, row);

test('Patterns ▸ save to the library, then load into the kit after a row was deleted: by sample name; one undo entry', async ({ page }) => {
  await start(page);
  for (const s of [0, 4, 8, 12]) await page.getByTestId(`step-0-${s}`).click(); // Kick
  for (const s of [4, 12]) await page.getByTestId(`step-4-${s}`).click(); // Snare

  // Save: a name field with the default "<track> · <pattern>".
  await openMenu(page, 'Patterns');
  await page.getByTestId('menu-pattern-save').click();
  const name = page.getByTestId('menu-pattern-save-input');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Drums · Pattern 1');
  await name.fill('Groove');
  await name.press('Enter');
  await expect(page.getByTestId('menu-patterns-panel')).toBeHidden();
  await expect(page.getByTestId('flash-hint')).toContainText('Saved “Groove” to the pattern library');
  await expect.poll(() => undoLabel(page)).toBe('Save pattern to library');

  // Delete the Kick row: every row below moves up one (Snare is now row 3).
  await page.getByTestId('row-0').hover();
  await page.getByTestId('row-delete-0').click();
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('Clap');

  // Load ▸: a submenu listing the entry.
  await openMenu(page, 'Patterns');
  await page.getByTestId('menu-pattern-load').click();
  await expect(page.getByTestId('menu-pattern-load')).toHaveAttribute('aria-expanded', 'true');
  const entry = page.getByTestId('menu-library').getByTestId('library-load');
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('Groove');
  await entry.click();
  await expect(page.getByTestId('menu-patterns-panel')).toBeHidden();
  // A new pattern, selected; the snare's steps are on the Snare row; the kick had no row left.
  await expect(page.getByTestId('pattern-picker').locator('option:checked')).toHaveText('Groove');
  expect(await onSteps(page, 3)).toEqual([4, 12]);
  for (const s of [4, 12]) await expect(page.getByTestId(`step-3-${s}`)).toHaveAttribute('aria-pressed', 'true');
  expect(await onSteps(page, 0)).toEqual([]);
  await expect(page.getByTestId('flash-hint')).toHaveText('1 row not in this kit');
  await expect.poll(() => undoLabel(page)).toBe('Load library pattern');

  // One undo: the pattern is gone, Pattern 1 is current again.
  await page.locator('body').click({ position: { x: 5, y: 400 } }); // the focus off any field
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('pattern-picker').locator('option')).toHaveCount(1);
  await expect(page.getByTestId('pattern-picker').locator('option:checked')).toHaveText('Pattern 1');
  await expect.poll(() => undoLabel(page)).toBe('Delete row');
});

test('the header Save / Load buttons: a synth pattern into another synth track; other kinds are greyed', async ({ page }) => {
  await start(page);
  const save = page.getByTestId('pattern-save');
  const load = page.getByTestId('pattern-load');
  await expect(save).toHaveAttribute('aria-label', 'Save to library');
  await expect(load).toHaveAttribute('aria-label', 'Load from library');

  // A drum entry first (from the kit track, through the header).
  await save.click();
  await expect(page.getByTestId('pattern-save-input')).toHaveValue('Drums · Pattern 1');
  await page.getByTestId('pattern-save-input').press('Enter');

  // A synth track with two notes, saved as "Bassline".
  await openMenu(page, 'Add');
  await page.getByTestId('menu-add-synth').click();
  await daw(page, (d) => {
    const id = d.project.selectedTrackId;
    d.actions.addNote(id, { pitch: 36, start: 0, len: 480, vel: 110 });
    d.actions.addNote(id, { pitch: 43, start: 960, len: 240 });
  });
  await save.click();
  await page.getByTestId('pattern-save-input').fill('Bassline');
  await page.getByTestId('pattern-save-input').press('Enter');
  expect(await daw(page, (d) => d.project.patternLibrary.map((e: Any) => e.name))).toEqual(['Drums · Pattern 1', 'Bassline']);

  // A second synth track: Load lists both; the drum one is greyed and inert.
  await openMenu(page, 'Add');
  await page.getByTestId('menu-add-synth').click();
  await load.click();
  const pop = page.getByTestId('pattern-library-pop');
  await expect(pop).toBeVisible();
  const loads = pop.getByTestId('library-load');
  await expect(loads).toHaveCount(2);
  await expect(loads.nth(0)).toContainText('drum pattern');
  await expect(loads.nth(0)).toHaveAttribute('aria-disabled', 'true');
  await loads.nth(0).click({ force: true }); // inert: nothing happens
  await expect(pop).toBeVisible();
  // Esc closes only the popover, the focus back on Load.
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(load).toBeFocused();

  await load.click();
  await pop.getByTestId('library-load').nth(1).click();
  await expect(pop).toBeHidden();
  await expect(page.getByTestId('pattern-picker').locator('option:checked')).toHaveText('Bassline');
  const notes = await daw(page, (d) => {
    const t = d.project.tracks.find((x: Any) => x.id === d.project.selectedTrackId);
    return t.patterns.find((x: Any) => x.id === t.currentPatternId).notes.map((n: Any) => [n.pitch, n.vel, n.start, n.len]);
  });
  expect(notes).toEqual([[36, 110, 0, 480], [43, 100, 960, 240]]);
  await expect.poll(() => undoLabel(page)).toBe('Load library pattern');
});

test('library entries are renamed and deleted from the submenu, one undo entry each', async ({ page }) => {
  await start(page);
  await page.getByTestId('pattern-save').click();
  await page.getByTestId('pattern-save-input').fill('Groove');
  await page.getByTestId('pattern-save-input').press('Enter');

  await openMenu(page, 'Patterns');
  await page.getByTestId('menu-pattern-load').click();
  const lib = page.getByTestId('menu-library');
  await lib.getByTestId('library-rename').click();
  const field = lib.getByTestId('library-rename-input');
  await expect(field).toBeFocused();
  await field.fill('House groove');
  // Esc in the field ends only the rename: the submenu and the menu stay.
  await field.press('Escape');
  await expect(lib.getByTestId('library-load')).toContainText('Groove');
  await expect(page.getByTestId('menu-patterns-panel')).toBeVisible();
  await lib.getByTestId('library-rename').click();
  await lib.getByTestId('library-rename-input').fill('House groove');
  await lib.getByTestId('library-rename-input').press('Enter');
  await expect(lib.getByTestId('library-load')).toContainText('House groove');
  await expect.poll(() => undoLabel(page)).toBe('Rename library pattern');

  await lib.getByTestId('library-delete').click();
  await expect(lib.getByTestId('library-empty')).toBeVisible();
  await expect.poll(() => undoLabel(page)).toBe('Delete library pattern');
  // Esc closes the submenu first (the topmost layer), then the menu.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('menu-pattern-load')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('menu-pattern-load')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('menu-patterns-panel')).toBeHidden();

  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('ControlOrMeta+z');
  expect(await daw(page, (d) => d.project.patternLibrary.map((e: Any) => e.name))).toEqual(['House groove']);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await daw(page, (d) => d.project.patternLibrary.map((e: Any) => e.name))).toEqual(['Groove']);
});

test('header: an empty library popover still closes on Esc; after a save the focus is back on Save', async ({ page }) => {
  await start(page);
  const load = page.getByTestId('pattern-load');
  await load.click();
  const pop = page.getByTestId('pattern-library-pop');
  await expect(pop.getByTestId('library-empty')).toBeVisible();
  // No library entry: the focus goes to the first usable button, the first factory pattern (plan 25).
  await expect(pop.getByTestId('factory-load').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(load).toBeFocused();

  const save = page.getByTestId('pattern-save');
  await save.click();
  await page.getByTestId('pattern-save-input').press('Enter');
  await expect(save).toBeFocused();
  await save.click();
  await page.getByTestId('pattern-save-input').press('Escape');
  await expect(save).toBeFocused();
  expect(await daw(page, (d) => d.project.patternLibrary.length)).toBe(1);
});

test('header: the library popover closes when the focus Tabs out of it', async ({ page }) => {
  await start(page);
  await page.getByTestId('pattern-save').click();
  await page.getByTestId('pattern-save-input').press('Enter'); // one entry, so the popover has buttons
  const load = page.getByTestId('pattern-load');
  await load.click();
  const pop = page.getByTestId('pattern-library-pop');
  await expect(pop.getByTestId('library-load').first()).toBeFocused();
  // Shift+Tab onto Load keeps it open (Load is its own button) ...
  await page.keyboard.press('Shift+Tab');
  await expect(load).toBeFocused();
  await expect(pop).toBeVisible();
  // ... one more step leaves the pair: closed.
  await page.keyboard.press('Shift+Tab');
  await expect(pop).toBeHidden();
  await expect(load).not.toBeFocused();
});

test('keyboard: → opens the library submenu on its first entry, ← goes back', async ({ page }) => {
  await start(page);
  await page.getByTestId('pattern-save').click();
  await page.getByTestId('pattern-save-input').press('Enter');
  await openMenu(page, 'Patterns');
  await page.getByTestId('menu-pattern-load').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('menu-library').getByTestId('library-load')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('menu-library').getByTestId('library-rename')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('menu-pattern-load')).toBeFocused();
  await expect(page.getByTestId('menu-library')).toHaveCount(0);
  await expect(page.getByTestId('menu-patterns-panel')).toBeVisible();
});
