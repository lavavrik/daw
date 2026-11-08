import type { Page } from '@playwright/test';

// The playlist footer's one "+ Add track" button (plan 21 Task 5,
// ui/song/AddTrackMenu.svelte) opens a list whose items keep the test ids of
// the footer buttons they replaced. Tests add tracks through addTrack().

export type AddKind = 'drum' | 'synth' | 'sampler' | 'audio' | 'master';

/** Each item's test id (the old footer button's). */
export const ADD_ID: Record<AddKind, string> = {
  drum: 'add-drum-track',
  synth: 'add-synth-track',
  sampler: 'add-sampler-track',
  audio: 'add-audio-track',
  master: 'tl-master-toggle',
};

/** Open the add-track list (no-op when it is open). */
export async function openAddTrack(page: Page) {
  if (!(await page.getByTestId('add-track-menu').isVisible())) await page.getByTestId('add-track').click();
}

/** Close the add-track list (no-op when it is closed). */
export async function closeAddTrack(page: Page) {
  if (await page.getByTestId('add-track-menu').isVisible()) await page.getByTestId('add-track').click();
}

/** Add a track of `kind` (or show the Master row) through the list. */
export async function addTrack(page: Page, kind: AddKind) {
  await openAddTrack(page);
  await page.getByTestId(ADD_ID[kind]).click();
}
