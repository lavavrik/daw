import { expect, type Page } from '@playwright/test';

// The "Automate…" button on an owner's last lane row (plan 21 Task 6,
// ui/song/AutoPicker.svelte) replaced the "+ Lane" <select> and kept its test
// id `auto-add-<owner>` (the track's slot, or "m" for the Master row). Tests
// add lanes through pickAutomation(): open the picker, expand the group,
// click the param. The owner's lanes must be open (its A button), as the
// button only shows on a lane row.
//
// Groups (ui/song/autoPick.ts): a track's 'Volume', 'Pan', 'Sends', 'EQ',
// 'Comp', then each rack module by its title ('Filter', 'Oscillator 2');
// the Master row's 'Master', 'Reverb', 'Delay'. Params by their knob label
// ('Volume', 'Pan', 'Reverb', 'Low cut', 'Cutoff', 'Ceiling').

/** Add a lane on `owner`'s `group` › `param` through the picker. */
export async function pickAutomation(page: Page, owner: number | string, group: string, param: string) {
  const btn = page.getByTestId(`auto-add-${owner}`).last();
  const pop = page.getByTestId('auto-picker');
  if (!(await pop.isVisible())) await btn.click();
  await expect(page.getByTestId('auto-search')).toBeFocused();
  const head = pop.locator(`[data-testid="auto-pick-group"][data-name="${group}"]`);
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await pop.locator(`[data-testid="auto-pick-item"][data-group="${group}"][data-name="${param}"]`).click();
  await expect(pop).toBeHidden();
}
