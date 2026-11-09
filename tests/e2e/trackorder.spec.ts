import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// Reordering the song's tracks (plan 22 Task 4; TrackHeaders "TRACK ORDER",
// docs/architecture/arrangement.md "Track order"): drag a header, Alt+Up /
// Alt+Down on it, or its context menu. The order is p.tracks' order; slots
// (the engine's addresses) never change, so the clips keep playing their own
// track's patterns.

type Daw = {
  project: { tracks: { id: string; slot: number; name: string; clips: { patternId: string }[] }[] };
  autosave: { lastSaved: number | null; flush(): Promise<void> };
};
// (Inside page.evaluate, reach it as `(window as unknown as W).__daw`: evaluated code can't see this module.)
type W = { __daw: Daw };

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  await expect(page.getByTestId('track-0')).toBeVisible();
}

/** Track names in project order. */
const names = (page: Page) => page.evaluate(() => (window as unknown as W).__daw.project.tracks.map((t) => t.name));

/** The slots of the elements `testid(slot)`, sorted by their position on screen (`axis`). */
async function screenOrder(page: Page, slots: number[], testid: (s: number) => string, axis: 'x' | 'y'): Promise<number[]> {
  const at = await Promise.all(slots.map(async (s) => ({ s, v: (await page.getByTestId(testid(s)).boundingBox())![axis] })));
  return at.sort((a, b) => a.v - b.v).map((x) => x.s);
}
const headerOrder = (page: Page, slots: number[]) => screenOrder(page, slots, (s) => `track-${s}`, 'y');
const laneOrder = (page: Page, slots: number[]) => screenOrder(page, slots, (s) => `tl-lane-${s}`, 'y');
const clipOrder = (page: Page, slots: number[]) => screenOrder(page, slots, (s) => `clip-${s}-0`, 'y');
const stripOrder = (page: Page, slots: number[]) => screenOrder(page, slots, (s) => `strip-${s}`, 'x');

/** Each track's slot, id and the patterns its clips play: none of it may change in a reorder. */
const bySlot = (page: Page) =>
  page.evaluate(() => Object.fromEntries((window as unknown as W).__daw.project.tracks.map((t) => [t.slot, { id: t.id, name: t.name, clips: t.clips.map((c) => c.patternId) }])));

/** A strip meter's shown peak (dBFS, -Infinity when silent). */
async function meterDb(page: Page, slot: number) {
  const v = await page.getByTestId(`strip-${slot}`).getByTestId('meter').getAttribute('data-peak-db');
  return v === null || v === '-inf' ? -Infinity : Number(v);
}

/** Press header `slot`, drag it to page y `toY` (in steps), optionally release. */
async function dragHeader(page: Page, slot: number, toY: number, release = true) {
  const b = (await page.getByTestId(`track-${slot}`).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, toY, { steps: 10 });
  if (release) await page.mouse.up();
}

async function clearAutosave(page: Page) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const n of ['autosave', 'autosave.tmp']) await root.removeEntry(n, { recursive: true }).catch(() => {});
    localStorage.removeItem('daw.lastExplicitSave');
  });
}

test('drag track 3 above track 1: headers, clips and strips follow, slots keep playing, undo, autosave', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  // The kit drum track (slot 0, samples loaded) plays a kick; a synth and an empty drum track join it.
  await page.getByTestId('step-0-0').click();
  await addTrack(page, 'synth');
  await addTrack(page, 'drum');
  await expect(page.getByTestId('track-2')).toBeVisible();
  expect(await names(page)).toEqual(['Drums', 'Synth', 'Drums 2']);
  // One clip on each lane (a click on a lane places its track's current pattern).
  for (const s of [0, 1, 2]) {
    const b = (await page.getByTestId(`tl-lane-${s}`).boundingBox())!;
    await page.mouse.click(b.x + 20, b.y + b.height / 2);
    await expect(page.getByTestId(`clip-${s}-0`)).toBeVisible();
  }
  const slotsBefore = await bySlot(page);

  // Mid-drag: the ghost follows, the drop line shows; Escape drops nothing.
  const top = (await page.getByTestId('track-0').boundingBox())!;
  await dragHeader(page, 2, top.y + 3, false);
  await expect(page.getByTestId('track-drag-ghost')).toBeVisible();
  await expect(page.getByTestId('track-drop-line')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('track-drag-ghost')).toBeHidden();
  await page.mouse.up();
  expect(await names(page)).toEqual(['Drums', 'Synth', 'Drums 2']);

  // The drag: track 3 (slot 2) above track 1.
  await dragHeader(page, 2, top.y + 3);
  await expect.poll(() => names(page)).toEqual(['Drums 2', 'Drums', 'Synth']);
  await expect(page.getByTestId('track-drag-ghost')).toBeHidden();
  await expect(page.getByTestId('track-order-status')).toHaveText('Moved Drums 2 to position 1 of 3');
  expect(await headerOrder(page, [0, 1, 2])).toEqual([2, 0, 1]);
  expect(await laneOrder(page, [0, 1, 2])).toEqual([2, 0, 1]);
  expect(await clipOrder(page, [0, 1, 2])).toEqual([2, 0, 1]);
  // Nothing else changed: same slots, ids and clips per slot.
  expect(await bySlot(page)).toEqual(slotsBefore);
  await page.getByTestId('mixer-tab').click();
  expect(await stripOrder(page, [0, 1, 2])).toEqual([2, 0, 1]);

  // The clips still play their own track's pattern: slot 0's kick sounds on strip 0, the empty kit stays silent.
  await page.getByTestId('play').click();
  await expect.poll(() => meterDb(page, 0), { timeout: 5000 }).toBeGreaterThan(-40);
  expect(await meterDb(page, 2)).toBe(-Infinity);
  await page.getByTestId('play').click(); // stop

  // One undo puts the order back; redo moves it again.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => names(page)).toEqual(['Drums', 'Synth', 'Drums 2']);
  expect(await stripOrder(page, [0, 1, 2])).toEqual([0, 1, 2]);
  expect(await headerOrder(page, [0, 1, 2])).toEqual([0, 1, 2]);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => names(page)).toEqual(['Drums 2', 'Drums', 'Synth']);

  // The autosave keeps the order across a reload.
  await expect
    .poll(() => page.evaluate(async () => {
      await (window as unknown as W).__daw.autosave.flush();
      return (window as unknown as W).__daw.autosave.lastSaved;
    }), { timeout: 15_000 })
    .not.toBeNull();
  await start(page);
  const offer = page.getByTestId('restore');
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: 'Restore last session' }).click();
  await expect.poll(() => names(page)).toEqual(['Drums 2', 'Drums', 'Synth']);
  expect(await headerOrder(page, [0, 1, 2])).toEqual([2, 0, 1]);
  await clearAutosave(page);
});

test('Alt+Up/Down and the context menu move a track; M / S / A clicks never reorder', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  await addTrack(page, 'drum');
  await expect(page.getByTestId('track-2')).toBeVisible();
  expect(await names(page)).toEqual(['Drums', 'Synth', 'Drums 2']);

  // Alt+Down on the focused header: one place down, focus stays on it, the live region says where.
  // The add's entry is committed by its pointer gesture a task after the release: wait for it, or the
  // move below is folded into that still-open gesture.
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Add drum track/);
  const undoBefore = await page.getByTestId('undo').getAttribute('title');
  await page.getByTestId('track-0').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => names(page)).toEqual(['Synth', 'Drums', 'Drums 2']);
  await expect(page.getByTestId('track-order-status')).toHaveText('Moved Drums to position 2 of 3');
  await expect(page.getByTestId('track-0')).toBeFocused();
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Move track/);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => names(page)).toEqual(['Drums', 'Synth', 'Drums 2']);
  // Down then Up in one burst nets to nothing: no dead "Move track" entry (settled after each press).
  await expect(page.getByTestId('undo')).toHaveAttribute('title', undoBefore!);
  await page.keyboard.press('Alt+ArrowUp'); // already first: nothing
  expect(await names(page)).toEqual(['Drums', 'Synth', 'Drums 2']);
  // Quick presses (after a pause: a new burst) are one undo entry: one undo goes back to where they started.
  await page.waitForTimeout(1100);
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => names(page)).toEqual(['Synth', 'Drums 2', 'Drums']);
  await expect(page.getByTestId('track-0')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => names(page)).toEqual(['Drums', 'Synth', 'Drums 2']);

  // M / S / A still toggle on a click, and nothing moves.
  for (const id of ['track-mute-1', 'track-solo-1', 'track-auto-1']) {
    await page.getByTestId(id).click();
    await expect(page.getByTestId(id)).toHaveAttribute('aria-pressed', 'true');
  }
  expect(await names(page)).toEqual(['Drums', 'Synth', 'Drums 2']);
  // A click on the name selects it (no reorder either).
  await page.getByTestId('track-0').click();
  await expect(page.getByTestId('track-0')).toHaveAttribute('aria-pressed', 'true');
  expect(await names(page)).toEqual(['Drums', 'Synth', 'Drums 2']);

  // The context menu: Move up is off on the first track; Move down moves it.
  await page.getByTestId('track-0').click({ button: 'right' });
  const menu = page.getByTestId('track-menu');
  await expect(menu).toBeVisible();
  // The menus' padding (plan 22 "Menus": right >= 16 px, bottom >= 8 px), every item the full inner width.
  const box = await menu.evaluate((m) => {
    const cs = getComputedStyle(m);
    const inner = m.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { right: parseFloat(cs.paddingRight), bottom: parseFloat(cs.paddingBottom), inner, widths: [...m.querySelectorAll('button')].map((b) => b.getBoundingClientRect().width) };
  });
  expect(box.right).toBeGreaterThanOrEqual(16);
  expect(box.bottom).toBeGreaterThanOrEqual(8);
  for (const w of box.widths) expect(Math.abs(w - box.inner)).toBeLessThan(0.5);
  await expect(menu.getByTestId('track-menu-up')).toBeDisabled();
  await menu.getByTestId('track-menu-down').click();
  await expect(menu).toBeHidden();
  await expect.poll(() => names(page)).toEqual(['Synth', 'Drums', 'Drums 2']);
  await expect(page.getByTestId('track-order-status')).toHaveText('Moved Drums to position 2 of 3');
  // Synth's open lane row (its A was lit above) travels with it: right under its header, above Drums.
  const ys = await Promise.all(['track-1', 'auto-head-1-new', 'track-0', 'track-2'].map(async (id) => (await page.getByTestId(id).boundingBox())!.y));
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  await page.getByTestId('track-2').click({ button: 'right' });
  await expect(menu.getByTestId('track-menu-up')).toBeEnabled();
  await expect(menu.getByTestId('track-menu-down')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('track-2')).toBeFocused();
});

test('the window losing focus mid-drag drops the track drag (nothing moves)', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  await expect(page.getByTestId('track-1')).toBeVisible();
  const b1 = (await page.getByTestId('track-1').boundingBox())!;
  await dragHeader(page, 0, b1.y + b1.height + 10, false);
  await expect(page.getByTestId('track-drag-ghost')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); // Cmd+Tab away: the release may never come
  await expect(page.getByTestId('track-drag-ghost')).toBeHidden();
  await page.mouse.up();
  expect(await names(page)).toEqual(['Drums', 'Synth']);
});
