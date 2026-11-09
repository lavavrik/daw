import { expect, test, type Page } from '@playwright/test';
import { openMenu, type MenuName } from './topbar';
import { startApp } from './startApp';

// The menu bar (plan 21 Task 3; ui/MenuBar.svelte): File · Edit · Add ·
// Patterns · View · Options · Help in the top bar's left block. topbar.spec.ts
// covers the items that moved in from plan 20's ⋯ menu; export.spec.ts runs
// File ▸ Export WAV…; midi.spec.ts checks that the Esc closing a menu leaves
// MIDI learn on.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const MENUS: MenuName[] = ['File', 'Edit', 'Add', 'Patterns', 'View', 'Options', 'Help'];
const btn = (page: Page, m: MenuName) => page.getByTestId(`menu-${m.toLowerCase()}`);
const panel = (page: Page, m: MenuName) => page.getByTestId(`menu-${m.toLowerCase()}-panel`);
/** Run `fn` on window.__daw in the page (its source is sent: it must not close over test variables). */
const daw = (page: Page, fn: (d: Any) => unknown) => page.evaluate(`(${fn.toString()})(window.__daw)`);

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  await expect(page.getByTestId('play')).toBeVisible();
}

test('each menu opens (one at a time); Esc returns the focus to its button; a press outside closes it', async ({ page }) => {
  await start(page);
  for (const m of MENUS) {
    await btn(page, m).click();
    await expect(panel(page, m)).toBeVisible();
    await expect(btn(page, m)).toHaveAttribute('aria-expanded', 'true');
    await expect(btn(page, m)).toHaveAttribute('aria-controls', `menu-${m.toLowerCase()}-panel`);
    await expect(page.locator('[data-testid^="menu-"][data-testid$="-panel"]:visible')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(panel(page, m)).toBeHidden();
    await expect(btn(page, m)).toBeFocused();
    await expect(btn(page, m)).toHaveAttribute('aria-expanded', 'false');
  }
  // Opening one closes the other; a press outside closes it.
  await btn(page, 'File').click();
  await btn(page, 'Help').click();
  await expect(panel(page, 'File')).toBeHidden();
  await expect(panel(page, 'Help')).toBeVisible();
  await page.getByTestId('timer').click();
  await expect(panel(page, 'Help')).toBeHidden();
  // While one is open, pointing at another menu opens that one.
  await btn(page, 'Edit').click();
  await btn(page, 'View').hover();
  await expect(panel(page, 'View')).toBeVisible();
  await expect(panel(page, 'Edit')).toBeHidden();
  // The items show their shortcut.
  await btn(page, 'File').click();
  await expect(page.getByTestId('project-save')).toContainText(/(⌘|Ctrl\+)S/);
});

test('keyboard: ↓ opens on the first item, ↑ ↓ Home End move, ← → go to the neighbouring menu', async ({ page }) => {
  await start(page);
  await btn(page, 'File').focus();
  await page.keyboard.press('ArrowDown');
  await expect(panel(page, 'File')).toBeVisible();
  await expect(page.getByTestId('project-new')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('project-open')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByTestId('undo-take')).toBeFocused(); // inert (no take), but reachable
  await page.keyboard.press('ArrowDown'); // wraps
  await expect(page.getByTestId('project-new')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('undo-take')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('project-new')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(panel(page, 'Edit')).toBeVisible();
  await expect(panel(page, 'File')).toBeHidden();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft'); // File → Help (wraps)
  await expect(panel(page, 'Help')).toBeVisible();
  await expect(page.getByTestId('menu-shortcuts')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(btn(page, 'Help')).toBeFocused();
  // On a closed menu's button ← → only move the focus.
  await page.keyboard.press('ArrowRight');
  await expect(btn(page, 'File')).toBeFocused();
  await expect(panel(page, 'File')).toBeHidden();
});

test('File ▸ Save still saves (a picked folder)', async ({ page }) => {
  await start(page);
  // The folder picker answers with an OPFS folder (no native dialog in a test).
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('Menu Save', { create: true });
    (window as Any).showDirectoryPicker = async () => dir;
  });
  await daw(page, (d) => d.actions.addSynthTrack('Lead'));
  await expect(page.getByTestId('project-name')).toContainText('unsaved');
  await openMenu(page, 'File');
  await page.getByTestId('project-save').click();
  await expect(panel(page, 'File')).toBeHidden();
  await expect(page.getByTestId('project-name')).toHaveText('Menu Save');
  const saved = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('Menu Save');
    return JSON.parse(await (await (await dir.getFileHandle('project.json')).getFile()).text()).name;
  });
  expect(saved).toBe('Menu Save');
});

test('Edit ▸ Undo / Redo show the history labels and run them', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Edit');
  await expect(page.getByTestId('menu-undo')).toBeDisabled();
  await expect(page.getByTestId('menu-undo')).toHaveText(/^Undo/);
  await page.keyboard.press('Escape');
  await daw(page, (d) => d.actions.addSynthTrack('Lead'));
  await openMenu(page, 'Edit');
  await expect(page.getByTestId('menu-undo')).toContainText('Undo Add synth track');
  await page.getByTestId('menu-undo').click();
  await expect(panel(page, 'Edit')).toBeHidden();
  await expect.poll(() => daw(page, (d) => d.project.tracks.length)).toBe(1);
  await openMenu(page, 'Edit');
  await expect(page.getByTestId('menu-redo')).toContainText('Redo Add synth track');
  await page.getByTestId('menu-redo').click();
  await expect.poll(() => daw(page, (d) => d.project.tracks.length)).toBe(2);
});

test('Add ▸ a synth track (one undo entry); Patterns ▸ New, Rename, Delete on the selected track', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Add');
  await page.getByTestId('menu-add-synth').click();
  await expect.poll(() => daw(page, (d) => d.project.tracks.map((t: Any) => t.kind))).toEqual(['drum', 'synth']);
  await expect.poll(() => daw(page, (d) => d.history.labels.undo)).toBe('Add synth track');
  // Patterns act on the selected track's current pattern.
  await page.getByTestId('track-0').click(); // the drum track
  await expect.poll(() => daw(page, (d) => d.project.selectedTrackId === d.project.tracks[0].id)).toBe(true);
  await openMenu(page, 'Patterns');
  await expect(page.getByTestId('menu-pattern-delete')).toBeDisabled(); // the last pattern
  await page.getByTestId('menu-pattern-new').click();
  await expect.poll(() => daw(page, (d) => d.project.tracks[0].patterns.length)).toBe(2);
  await openMenu(page, 'Patterns');
  await page.getByTestId('menu-pattern-rename').click();
  await page.getByTestId('menu-pattern-rename-input').fill('Break');
  await page.getByTestId('menu-pattern-rename-input').press('Enter');
  await expect(panel(page, 'Patterns')).toBeHidden();
  await expect(page.getByTestId('pattern-picker')).toHaveValue(await daw(page, (d) => d.project.tracks[0].currentPatternId) as string);
  await expect(page.getByTestId('pattern-picker').locator('option:checked')).toHaveText('Break');
  await openMenu(page, 'Patterns');
  await page.getByTestId('menu-pattern-delete').click();
  await expect.poll(() => daw(page, (d) => d.project.tracks[0].patterns.length)).toBe(1);
  // No pattern track selected: disabled, with the reason.
  await daw(page, (d) => (d.project.selectedTrackId = null));
  await openMenu(page, 'Patterns');
  await expect(page.getByTestId('menu-pattern-new')).toBeDisabled();
  await expect(page.getByTestId('menu-pattern-new')).toHaveAttribute('title', 'Select a drum or synth track');
});

test('View ▸ Mixer toggles the mixer; a tab the track cannot show is disabled', async ({ page }) => {
  await start(page);
  await openMenu(page, 'View');
  await expect(page.getByTestId('menu-view-pianoroll')).toBeDisabled(); // the drum track is selected
  await page.getByTestId('menu-view-mixer').click();
  await expect(page.getByTestId('mixer-tab')).toHaveClass(/active/);
  await openMenu(page, 'View');
  await expect(page.getByTestId('menu-view-mixer')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('menu-view-step').click();
  await expect(page.getByTestId('mixer-tab')).not.toHaveClass(/active/);
});

test('Options ▸ Keyboard: octave − / + change the octave; Keys play names the track', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Options');
  await expect(page.getByTestId('menu-keys-target')).toContainText('Keys play: Drums');
  await expect(page.getByTestId('keys-target')).toHaveText('Drums'); // the old pill's id: the track name
  const oct = Number(await page.getByTestId('menu-octave').textContent());
  await page.getByTestId('menu-octave-up').click();
  await expect(page.getByTestId('menu-octave')).toHaveText(String(oct + 1));
  await expect(page.getByTestId('octave')).toHaveText(`Octave ${oct + 1}`); // the old pill's id: the menu's readout
  await expect(panel(page, 'Options')).toBeVisible(); // a setting keeps the menu open
  await page.getByTestId('menu-octave-down').click();
  await page.getByTestId('menu-octave-down').click();
  await expect(page.getByTestId('octave')).toHaveText(`Octave ${oct - 1}`);
  // The Z / X keys play on the new octave (the shortcuts were told), also
  // with the focus on the menu button Esc returned it to.
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyX');
  await expect(page.getByTestId('octave')).toHaveText(`Octave ${oct}`);
});

test('Options ▸ MIDI… opens the MIDI panel under Options; Esc gives the focus back to Options', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Options');
  await expect(page.getByTestId('midi-status')).toHaveText(/^MIDI: (blocked|no device|unsupported|.+)$/); // the status is the label
  await page.getByTestId('menu-midi').click();
  await expect(page.getByTestId('midi-popover')).toBeVisible();
  const o = (await btn(page, 'Options').boundingBox())!;
  const pop = (await page.getByTestId('midi-popover').boundingBox())!;
  expect(Math.abs(pop.x - o.x)).toBeLessThan(2); // left-aligned under the Options button
  expect(pop.y).toBeGreaterThan(o.y + o.height);
  await expect(panel(page, 'Options')).toBeHidden();
  await expect(page.getByTestId('midi-popover')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('midi-popover')).toBeHidden();
  await expect(btn(page, 'Options')).toBeFocused();
});

test('Options: Audio settings… opens Settings; Metronome and Count-in toggle (Count-in shared with the pattern transport)', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Options');
  await page.getByTestId('menu-audio-settings').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.keyboard.press('Escape'); // a modal: close it before using the page again
  await expect(page.getByTestId('settings')).toBeHidden();
  await expect(btn(page, 'Options')).toBeFocused();
  await openMenu(page, 'Options');
  await page.getByTestId('menu-metronome').click();
  await expect(page.getByTestId('menu-metronome')).toHaveAttribute('aria-pressed', 'true');
  expect(await daw(page, (d) => d.project.metronome)).toBe(true);
  const before = await page.getByTestId('count-in').getAttribute('aria-pressed');
  await page.getByTestId('menu-count-in').click();
  const after = before === 'true' ? 'false' : 'true';
  await expect(page.getByTestId('menu-count-in')).toHaveAttribute('aria-pressed', after);
  await expect(page.getByTestId('count-in')).toHaveAttribute('aria-pressed', after);
  expect(await daw(page, (d) => d.recorder.countIn)).toBe(after === 'true');
});

test('Help ▸ Keyboard shortcuts lists Space; Esc closes it; About shows the version', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Help');
  await page.getByTestId('menu-shortcuts').click();
  const sheet = page.getByTestId('shortcuts-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('kbd', { hasText: /^Space$/ })).toBeVisible();
  await expect(sheet).toContainText('Play / stop the song');
  // Keys inside the modal stay there: R does not arm recording behind it.
  await page.keyboard.press('KeyR');
  await expect(page.getByTestId('rec-button')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(btn(page, 'Help')).toBeFocused();
  await openMenu(page, 'Help');
  await page.getByTestId('menu-about').click();
  await expect(page.getByTestId('about-dialog')).toContainText('House DAW');
  await expect(page.getByTestId('about-version')).toHaveText(/^\d+\.\d+\.\d+/);
  await page.getByTestId('about-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('about-dialog')).toBeHidden();
});

test('keys typed in an open menu stay there: Space presses the item, not the song; letters play nothing', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Options');
  const met = page.getByTestId('menu-metronome');
  const was = await met.getAttribute('aria-pressed');
  await met.focus();
  await page.keyboard.press('Space');
  await expect(met).toHaveAttribute('aria-pressed', was === 'true' ? 'false' : 'true');
  expect(await daw(page, (d) => d.project.playing)).toBe(false);
  // R does not arm recording, Z does not move the octave.
  const octave = await page.getByTestId('menu-octave').textContent();
  await page.keyboard.press('KeyR');
  await page.keyboard.press('KeyZ');
  await expect(page.getByTestId('rec-button')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('menu-octave')).toHaveText(octave!);
  // Escape still closes it (it reaches the document listener).
  await page.keyboard.press('Escape');
  await expect(panel(page, 'Options')).toBeHidden();
  await expect(btn(page, 'Options')).toBeFocused();
});

test('after a command chosen with the mouse, the shortcuts work again: Space starts the song, X moves the octave', async ({ page }) => {
  await start(page);
  await openMenu(page, 'View');
  await page.getByTestId('menu-view-mixer').click(); // closes the menu, the focus back on View
  await expect(btn(page, 'View')).toBeFocused();
  const oct = Number((await page.getByTestId('octave').textContent())!.replace(/\D/g, ''));
  await page.keyboard.press('KeyX');
  await expect(page.getByTestId('octave')).toHaveText(`Octave ${oct + 1}`);
  await page.keyboard.press('Space');
  await expect.poll(() => daw(page, (d) => d.project.playing)).toBe(true);
  await expect(panel(page, 'View')).toBeHidden(); // Space did not also press the button
  await page.keyboard.press('Space');
  await expect.poll(() => daw(page, (d) => d.project.playing)).toBe(false);
});

test('an item that cannot run is inert, not disabled: focusable, with its reason as description', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Edit');
  const undo = page.getByTestId('menu-undo');
  await expect(undo).toBeDisabled(); // aria-disabled (nothing edited yet)
  await expect(undo).toHaveAttribute('aria-disabled', 'true');
  await expect(undo).toHaveAccessibleDescription('Nothing to undo');
  // Still reachable from the keyboard (↓ from the button lands on it).
  await btn(page, 'Edit').focus();
  await page.keyboard.press('ArrowDown');
  await expect(undo).toBeFocused();
  // Enter does nothing: the menu stays open.
  await page.keyboard.press('Enter');
  await expect(panel(page, 'Edit')).toBeVisible();
});

test('the About dialog closes on its backdrop, not on a press inside its padding', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Help');
  await page.getByTestId('menu-about').click();
  const dlg = page.getByTestId('about-dialog');
  await expect(dlg).toBeVisible();
  // The left padding beside a paragraph: the <dialog> itself is the target.
  const box = (await dlg.boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + box.height - 6);
  await expect(dlg).toBeVisible();
  await page.mouse.click(box.x - 20, box.y + 10); // the backdrop
  await expect(dlg).toBeHidden();
});

// Plan 22 Task 1 (the owner: "more breathing room on the right and bottom";
// "the highlighted item should have full width").
test('every item spans the popover\'s inner width; 16 px padding at the sides, 8 px at the bottom', async ({ page }) => {
  await start(page);
  for (const m of MENUS) {
    await openMenu(page, m);
    const out = await panel(page, m).evaluate((p) => {
      const cs = getComputedStyle(p);
      const inner = p.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const items = [...p.querySelectorAll<HTMLElement>('.it')].filter((i) => !i.closest('.sub') && i.getClientRects().length);
      return { right: parseFloat(cs.paddingRight), bottom: parseFloat(cs.paddingBottom), inner, widths: [...new Set(items.map((i) => i.getBoundingClientRect().width))] };
    });
    expect(out.right, m).toBeGreaterThanOrEqual(16);
    expect(out.bottom, m).toBeGreaterThanOrEqual(8);
    for (const w of out.widths) expect(Math.abs(w - out.inner), `${m}: an item ${w} px in ${out.inner}`).toBeLessThan(0.5);
  }
  // The hovered item's highlight is that full band (the Options entries once sat in a narrower wrapper).
  await openMenu(page, 'Options');
  const item = page.getByTestId('note-names');
  await item.hover();
  const hl = await item.evaluate((i) => ({ bg: getComputedStyle(i).backgroundColor, w: i.getBoundingClientRect().width, inner: i.parentElement!.parentElement!.clientWidth - 32 }));
  expect(hl.bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(Math.abs(hl.w - hl.inner)).toBeLessThan(0.5);
});

test('no tooltip on an item whose title equals its text (and no native one either)', async ({ page }) => {
  await start(page);
  await openMenu(page, 'View');
  // A View item with a title that only repeats its label (the rule is global, in Tooltip.svelte).
  const item = page.getByTestId('menu-view-mixer');
  await item.evaluate((b) => b.setAttribute('title', (b as HTMLElement).innerText.trim()));
  const text = await item.innerText();
  await item.hover();
  await page.waitForTimeout(500); // past the 250 ms delay
  await expect(page.getByRole('tooltip')).toBeHidden();
  expect(await item.getAttribute('title')).toBeNull(); // claimed: the native tip can't fire
  expect(await item.getAttribute('aria-describedby')).toBeNull(); // nothing to add to the name
  // A title that says more does show.
  const perf = page.getByTestId('settings-button');
  await perf.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(page.getByRole('tooltip')).toContainText('Click for audio settings');
  await page.mouse.move(700, 600);
  await expect(item).toHaveAttribute('title', text.trim()); // put back on release
});

// Fix round 1: submenus follow the pointer (MenuBar.svelte SUBMENUS).
test('submenus follow the pointer: hover opens, a sibling or leaving closes, a diagonal into it does not', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Options');
  const item = page.getByTestId('note-names');
  const solfege = page.getByTestId('menu-notenames-solfege');
  await item.hover();
  await expect(item).toHaveAttribute('aria-expanded', 'true'); // after ~150 ms
  // The click that follows a hover-open keeps it open.
  await item.click();
  await expect(item).toHaveAttribute('aria-expanded', 'true');
  // A sibling item closes it (~200 ms).
  await page.getByTestId('menu-metronome').hover();
  await expect(item).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page, 'Options')).toBeVisible();
  // Diagonal: from the item's left end down-right to Solfège (the second
  // entry), across the items under Note names on the way: it stays open.
  await item.hover({ position: { x: 20, y: 6 } });
  await expect(item).toHaveAttribute('aria-expanded', 'true');
  const ib = (await item.boundingBox())!;
  const sb = (await solfege.boundingBox())!;
  await page.mouse.move(ib.x + 20, ib.y + ib.height - 2);
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2, { steps: 6 });
  await page.waitForTimeout(300); // past the close delay
  await expect(item).toHaveAttribute('aria-expanded', 'true');
  await solfege.click();
  await expect(solfege).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('menu-notenames-letters').click();
  // Leaving the menu closes the submenu (the menu itself stays open).
  await page.mouse.move(1000, 600);
  await expect(item).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page, 'Options')).toBeVisible();
  // The library submenu does the same.
  await openMenu(page, 'Patterns');
  const lib = page.getByTestId('menu-pattern-load');
  await lib.hover();
  await expect(lib).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('menu-pattern-save').hover();
  await expect(lib).toHaveAttribute('aria-expanded', 'false');
});

test('a submenu opened with the mouse: Esc and ← close only it and focus its item; → inside it does nothing', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Options');
  const item = page.getByTestId('note-names');
  await item.click();
  await expect(item).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('menu-metronome').focus(); // the focus anywhere but in the submenu
  await page.keyboard.press('Escape');
  await expect(item).toHaveAttribute('aria-expanded', 'false');
  await expect(item).toBeFocused();
  await expect(panel(page, 'Options')).toBeVisible();
  await item.click();
  await page.getByTestId('menu-metronome').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(item).toHaveAttribute('aria-expanded', 'false');
  await expect(item).toBeFocused();
  await expect(panel(page, 'Options')).toBeVisible(); // not the neighbouring menu
  // → inside the submenu: nothing (no jump to Help).
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('menu-notenames-letters')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('menu-notenames-letters')).toBeFocused();
  await expect(panel(page, 'Options')).toBeVisible();
  await expect(panel(page, 'Help')).toBeHidden();
});

test('the wheel over Options ▸ Keyboard\'s octave row steps the octave', async ({ page }) => {
  await start(page);
  await openMenu(page, 'Options');
  const oct = Number(await page.getByTestId('menu-octave').textContent());
  await page.getByTestId('octave').hover();
  await page.mouse.wheel(0, -100); // up: one octave higher
  await expect(page.getByTestId('menu-octave')).toHaveText(String(oct + 1));
  await page.mouse.wheel(0, 200);
  await expect(page.getByTestId('menu-octave')).toHaveText(String(oct - 1));
});
