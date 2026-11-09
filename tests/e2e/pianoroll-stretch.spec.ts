import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// Draw and stretch (owner request pr-drag; docs/architecture/theory.md
// "Draw and stretch"): a press on empty grid creates the note (or the
// chord stamp's notes) and dragging on stretches it, one undo entry. The
// length maths is unit-tested in app/src/ui/pianoroll/prMath.test.ts
// (stretchLen, stretchReadout); here the real roll is driven with the mouse.

type Note = { id: string; pitch: number; start: number; len: number };
type Daw = {
  project: { tracks: { kind: string; currentPatternId: string; patterns: { id: string; notes: Note[] }[] }[] };
  history: { labels: { undo: string | null } } | null;
};
type W = { __daw: Daw };
type PrView = { ticksPerPx: number; scrollTick: number; rowH: number; topPitch: number; keysW: number; rulerH: number };

const SIXTEENTH = 240;
const C3 = 48;
const A3 = 57;

const undoLabel = (page: Page) => page.evaluate(() => (window as unknown as W).__daw.history?.labels.undo ?? null);
/** The synth track's current pattern's notes, by pitch. */
const notes = (page: Page) => page.evaluate(() => {
  const t = (window as unknown as W).__daw.project.tracks.find((x) => x.kind === 'synth')!;
  const ns = JSON.parse(JSON.stringify(t.patterns.find((x) => x.id === t.currentPatternId)!.notes)) as Note[];
  return ns.sort((a, b) => a.pitch - b.pitch);
});
/** [pitch, start, len] of every note, by pitch. */
const shape = async (page: Page) => (await notes(page)).map((n) => [n.pitch, n.start, n.len]);
const readout = (page: Page) => page.getByTestId('pr-readout');

async function openRoll(page: Page) {
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  await expect(page.getByRole('button', { name: 'Piano roll' })).toHaveClass(/active/);
  await expect(page.getByTestId('pr-canvas')).not.toHaveAttribute('data-view', '');
}

/** Page coordinates of (tick, pitch), vertically mid-row. */
async function at(page: Page, tick: number, pitch: number) {
  const canvas = page.getByTestId('pr-canvas');
  const v = JSON.parse((await canvas.getAttribute('data-view'))!) as PrView;
  const b = (await canvas.boundingBox())!;
  return {
    x: b.x + v.keysW + (tick - v.scrollTick) / v.ticksPerPx,
    y: b.y + v.rulerH + (v.topPitch - pitch) * v.rowH + v.rowH / 2,
    px: (ticks: number) => ticks / v.ticksPerPx,
  };
}

/**
 * Press in the cell holding `tick` on `pitch`'s row (30 % into it) and drag
 * `dTicks` sideways and `dRows` rows up; the button stays down (the caller
 * releases or cancels). The pointer lands 30 % into a cell, so the nearest
 * grid line is the one `dTicks / 240` sixteenths from the start.
 */
async function pressAndDrag(page: Page, tick: number, pitch: number, dTicks: number, dRows = 0) {
  const p = await at(page, tick + 0.3 * SIXTEENTH, pitch);
  const to = await at(page, tick + 0.3 * SIXTEENTH + dTicks, pitch + dRows);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move((p.x + to.x) / 2, (p.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
}

async function snapToKeyOn(page: Page) {
  await page.getByTestId('pr-key').click();
  await page.getByTestId('pr-snap-key').click();
  await expect(page.getByTestId('pr-snap-key')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pr-key-pop')).toHaveCount(0);
}

test('a drag of 3 grid steps draws a note 3 steps long, the readout following; one undo removes it', async ({ page }) => {
  await openRoll(page);
  await pressAndDrag(page, 0, C3, 3 * SIXTEENTH);
  await expect(readout(page)).toHaveText('C3 · 1.1.1 · 3×1/16'); // live, before the release
  await page.mouse.up();
  await expect.poll(() => shape(page)).toEqual([[C3, 0, 3 * SIXTEENTH]]);
  await expect.poll(() => undoLabel(page)).toBe('Add note');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => shape(page)).toEqual([]);
});

test('a click with no drag keeps the default length (one grid cell)', async ({ page }) => {
  await openRoll(page);
  const p = await at(page, 960 + 30, C3);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => shape(page)).toEqual([[C3, 960, SIXTEENTH]]);
  await expect(readout(page)).toContainText('C3 · 1.2.1 · 1/16');
});

test('dragging left of the start, or straight up, keeps the minimum length and the pitch', async ({ page }) => {
  await openRoll(page);
  await pressAndDrag(page, 960, C3, -2 * SIXTEENTH);
  await page.mouse.up();
  await expect.poll(() => shape(page)).toEqual([[C3, 960, SIXTEENTH]]);
  // Vertical: three rows up, no reach sideways. The pitch stays C3.
  await pressAndDrag(page, 1920, C3, 0, 3);
  await page.mouse.up();
  await expect.poll(() => shape(page)).toEqual([[C3, 960, SIXTEENTH], [C3, 1920, SIXTEENTH]]);
});

test('Esc mid-drag leaves no note; Cmd+Z mid-drag removes only the new one', async ({ page }) => {
  await openRoll(page);
  await pressAndDrag(page, 0, C3, 2 * SIXTEENTH);
  await expect.poll(() => shape(page)).toEqual([[C3, 0, 2 * SIXTEENTH]]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => shape(page)).toEqual([]);
  await expect.poll(() => undoLabel(page)).toBe('Add synth track'); // no entry of its own

  const p = await at(page, 960 + 30, C3);
  await page.mouse.click(p.x, p.y); // one note to keep
  await expect.poll(() => shape(page)).toEqual([[C3, 960, SIXTEENTH]]);
  await pressAndDrag(page, 1920, C3, 2 * SIXTEENTH);
  await expect.poll(async () => (await notes(page)).length).toBe(2);
  await page.keyboard.press('ControlOrMeta+z'); // cancels the drag, undoes nothing older
  await page.mouse.up();
  await expect.poll(() => shape(page)).toEqual([[C3, 960, SIXTEENTH]]);
});

test('chord mode: the press places the chord and the drag stretches all its notes (one entry)', async ({ page }) => {
  await openRoll(page);
  await page.getByTestId('pr-chord').click(); // In key, root position: Am7 on A3
  await pressAndDrag(page, 0, A3, 4 * SIXTEENTH);
  await expect(readout(page)).toHaveText('In key · A3 C4 E4 G4 · 1.1.1 · 1/4');
  await page.mouse.up();
  const len = 4 * SIXTEENTH;
  await expect.poll(() => shape(page)).toEqual([[57, 0, len], [60, 0, len], [64, 0, len], [67, 0, len]]);
  await expect.poll(() => undoLabel(page)).toBe('Add chord');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => shape(page)).toEqual([]);
  // Esc mid-drag removes the whole chord and stays in chord mode.
  await pressAndDrag(page, 960, A3, 2 * SIXTEENTH);
  await expect.poll(async () => (await notes(page)).length).toBe(4);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => shape(page)).toEqual([]);
  await expect(page.getByTestId('pr-chord')).toHaveAttribute('aria-pressed', 'true');
});

test('Snap to key: the pitch is snapped at the press and the length stretched', async ({ page }) => {
  await openRoll(page);
  await snapToKeyOn(page); // A minor: C#4 (61) is out of key, the tie goes up to D4
  await pressAndDrag(page, 0, 61, 3 * SIXTEENTH, -2); // and down two rows: the pitch stays put
  await expect(readout(page)).toHaveText('D4 · 1.1.1 · 3×1/16');
  await page.mouse.up();
  await expect.poll(() => shape(page)).toEqual([[62, 0, 3 * SIXTEENTH]]);
  await expect.poll(() => undoLabel(page)).toBe('Add note');
});
