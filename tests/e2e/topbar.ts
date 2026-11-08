import type { Page } from '@playwright/test';

// The top bar's ⋯ menu (plan 20 Task 5): New, Open…, Save, Save As…,
// Export WAV…, Undo take and the Rec offset live in it, under their old test
// ids. Click them after openMore().

const isOpen = (page: Page) =>
  page.getByTestId('topbar-more').evaluate((s) => (s.parentElement as HTMLDetailsElement).open);

/** Open the ⋯ menu (no-op when it is open). */
export async function openMore(page: Page) {
  if (!(await isOpen(page))) await page.getByTestId('topbar-more').click();
}

/** Close the ⋯ menu (no-op when it is closed). */
export async function closeMore(page: Page) {
  if (await isOpen(page)) await page.getByTestId('topbar-more').click();
}
