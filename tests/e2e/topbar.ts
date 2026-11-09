import type { Page } from '@playwright/test';

// The top bar's menu bar (plan 21 Task 3, ui/MenuBar.svelte): File · Edit ·
// Add · Patterns · View · Options · Help. Plan 20's ⋯ items moved into it
// under their old test ids (File: project-new / -open / -save / -save-as /
// -export, undo-take; Options: rec-offset). Every popover stays in the DOM
// (hidden while closed), so a test can read an item's state before opening
// it; click it after openMenu().

export type MenuName = 'File' | 'Edit' | 'Add' | 'Patterns' | 'View' | 'Options' | 'Help';

const button = (page: Page, m: MenuName) => page.getByTestId(`menu-${m.toLowerCase()}`);
const isOpen = async (page: Page, m: MenuName) => (await button(page, m).getAttribute('aria-expanded')) === 'true';

/** Open menu `m` (no-op when it is open). */
export async function openMenu(page: Page, m: MenuName) {
  if (!(await isOpen(page, m))) await button(page, m).click();
}

/** Close menu `m` (no-op when it is closed). */
export async function closeMenu(page: Page, m: MenuName) {
  if (await isOpen(page, m)) await button(page, m).click();
}

/**
 * Open the Audio settings dialog (Settings.svelte, modal since plan 22)
 * through View ▸ Performance (`settings-button`, the old ⚙ pill's id).
 * Options ▸ Audio settings… (`menu-audio-settings`) opens the same dialog.
 */
export async function openAudioSettings(page: Page) {
  await openMenu(page, 'View');
  await page.getByTestId('settings-button').click();
}
