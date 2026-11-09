import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// Precise value entry (plan 24 Task 1, ui/ValuePopover.svelte; docs/architecture/
// ui-theme.md "Precise entry"): right-click a rack or mixer knob, type a value,
// Set or Enter. The knob's AutoMenu items (Automate, MIDI learn) are the
// popover's lower half.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const CUTOFF = 'knob-4-cutoff';
const ATTACK = 'knob-5-attack';

const valueOf = async (page: Page, testid: string) => Number(await page.getByTestId(testid).getAttribute('aria-valuenow'));
const undoLabel = (page: Page) => page.evaluate(() => (window as Any).__daw.history?.labels.undo as string | null);

/** A new synth track, its rack open (the Filter is module 4, the envelope 5). */
async function synthRack(page: Page) {
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  const slot = await page.evaluate(() => (window as Any).__daw.project.tracks.at(-1).slot as number);
  await page.getByTestId(`track-${slot}`).click();
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByTestId(CUTOFF)).toBeVisible();
  return slot;
}

test('right-click the cutoff, "1.2k", Enter: 1200 Hz, one undo entry like a key edit', async ({ page }) => {
  await synthRack(page);
  const knob = page.getByTestId(CUTOFF);
  // Off the default (1.2 kHz) first, with a key: the label a knob edit gets.
  await knob.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => valueOf(page, CUTOFF)).toBe(20);
  await expect.poll(() => undoLabel(page)).not.toBeNull();
  const keyLabel = await undoLabel(page);

  await knob.click({ button: 'right' });
  const pop = page.getByTestId('value-popover');
  const input = page.getByTestId('value-input');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText(/filter cutoff/i);
  await expect(pop).toContainText('20 Hz … 20 kHz');
  // Focused, the text selected: typing replaces it.
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('20');
  await expect(pop.getByText('Hz', { exact: true })).toBeVisible();
  expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 2]);
  await page.keyboard.type('1.2k');
  await page.keyboard.press('Enter');
  await expect(pop).toHaveCount(0);
  await expect.poll(() => valueOf(page, CUTOFF)).toBe(1200);
  await expect(knob.getByTestId('knob-readout')).toHaveText('1.2 kHz');
  await expect(knob).toBeFocused();
  // One entry, labelled like the control's other edits.
  await expect.poll(() => undoLabel(page)).toBe(keyLabel);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, CUTOFF)).toBe(20);
  // Reset: back to the default (one entry), and closes.
  await knob.click({ button: 'right' });
  await page.getByTestId('value-reset').click();
  await expect(page.getByTestId('value-popover')).toHaveCount(0);
  await expect.poll(() => valueOf(page, CUTOFF)).toBe(1200);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, CUTOFF)).toBe(20);
});

test('the envelope attack (a vertical fader): "15", Set: 15 ms', async ({ page }) => {
  await synthRack(page);
  const f = page.getByTestId(ATTACK);
  await expect(f).toHaveClass(/vfader/);
  await f.click({ button: 'right' });
  await expect(page.getByTestId('value-input')).toHaveValue(/^\d+(\.\d+)?$/); // the preset's ms, the unit beside it
  await expect(page.getByTestId('value-popover').getByText('ms', { exact: true })).toBeVisible();
  await page.keyboard.type('15');
  await page.getByTestId('value-set').click();
  await expect(page.getByTestId('value-popover')).toHaveCount(0);
  await expect.poll(() => valueOf(page, ATTACK)).toBeCloseTo(0.015, 6);
  await expect(f.getByTestId('knob-readout')).toHaveText('15 ms');
});

test('the popover keeps Automate and MIDI learn, and they work', async ({ page }) => {
  const slot = await synthRack(page);
  const knob = page.getByTestId(CUTOFF);
  await knob.click({ button: 'right' });
  const pop = page.getByTestId('value-popover');
  await expect(pop.getByTestId('auto-ctl-automate')).toHaveText('Automate');
  await expect(pop.getByTestId('auto-ctl-midi')).toHaveText('MIDI learn');
  await pop.getByTestId('auto-ctl-automate').click();
  await expect(pop).toHaveCount(0);
  await expect(page.getByTestId(`track-auto-${slot}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(knob).toHaveAttribute('data-auto', /.+/);
  // Again: "Show automation"; MIDI learn makes the knob the learn target.
  await knob.click({ button: 'right' });
  await expect(pop.getByTestId('auto-ctl-automate')).toHaveText('Show automation');
  await pop.getByTestId('auto-ctl-midi').click();
  await expect(pop).toHaveCount(0);
  await expect(knob).toHaveClass(/learning/);
});

test('junk text: "Not a value", stays open; Esc closes with no change, focus back on the knob', async ({ page }) => {
  await synthRack(page);
  const knob = page.getByTestId(CUTOFF);
  const before = await valueOf(page, CUTOFF);
  const beforeLabel = await undoLabel(page);
  await knob.click({ button: 'right' });
  const input = page.getByTestId('value-input');
  await page.keyboard.type('abc');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('value-popover')).toBeVisible();
  await expect(page.getByTestId('value-error')).toHaveText('Not a value');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toBeFocused();
  // Set does the same.
  await page.getByTestId('value-set').click();
  await expect(page.getByTestId('value-error')).toBeVisible();
  await input.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('value-popover')).toHaveCount(0);
  await expect(knob).toBeFocused();
  expect(await valueOf(page, CUTOFF)).toBe(before);
  expect(await undoLabel(page)).toBe(beforeLabel);
  // An outside press closes it with no change too.
  await knob.click({ button: 'right' });
  await page.keyboard.type('300');
  await page.getByTestId('timeline').click({ position: { x: 600, y: 5 } });
  await expect(page.getByTestId('value-popover')).toHaveCount(0);
  expect(await valueOf(page, CUTOFF)).toBe(before);
});

test('Shift+F10 on a focused knob opens it; Space stays in it', async ({ page }) => {
  await synthRack(page);
  const knob = page.getByTestId(CUTOFF);
  await knob.focus();
  await page.keyboard.press('Shift+F10');
  const pop = page.getByTestId('value-popover');
  await expect(pop).toBeVisible();
  await expect(page.getByTestId('value-input')).toBeFocused();
  // Placed at the knob (keyboard: no pointer), not at the window's corner.
  const pb = (await pop.boundingBox())!;
  const kb = (await knob.boundingBox())!;
  expect(Math.abs(pb.x - kb.x)).toBeLessThan(40);
  // Space in the field types a space; the song does not start.
  await page.keyboard.press('Space');
  await expect(page.getByTestId('value-input')).toHaveValue(' ');
  // On a button in it, too (Space presses the button, never the transport):
  // Tab to Reset, Space resets and closes.
  await page.keyboard.press('Tab'); // Set
  await page.keyboard.press('Tab'); // Reset
  await expect(page.getByTestId('value-reset')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(pop).toHaveCount(0);
  expect(await page.evaluate(() => (window as Any).__daw.project.playing)).toBe(false);
});

test('it stays inside the window near the right and bottom edges', async ({ page }) => {
  await synthRack(page);
  const vp = page.viewportSize()!;
  // A right-click at the bottom-right corner (the event carries the point the card is placed from).
  for (const [x, y] of [[vp.width - 4, vp.height - 4], [vp.width - 4, 40], [30, vp.height - 4]]) {
    await page.getByTestId(CUTOFF).evaluate((el, [cx, cy]) => {
      el.dispatchEvent(new MouseEvent('contextmenu', { clientX: cx, clientY: cy, button: 2, bubbles: true, cancelable: true }));
    }, [x, y]);
    const pop = page.getByTestId('value-popover');
    await expect(pop).toBeVisible();
    await expect(page.getByTestId('value-input')).toBeFocused();
    const b = (await pop.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
    expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
    // Still next to the pointer: flipped to its other side, touching it.
    expect(Math.abs(Math.min(Math.abs(b.x - x), Math.abs(b.x + b.width - x)))).toBeLessThan(12);
    expect(Math.abs(Math.min(Math.abs(b.y - y), Math.abs(b.y + b.height - y)))).toBeLessThan(12);
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
  }
});
