import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// The piano roll's chord stamp (plan 26 Task 2; docs/architecture/theory.md
// "Chord stamp"). The voicing maths is unit-tested in
// app/src/music/scales.test.ts and ui/pianoroll/prMath.test.ts
// (chordStampPitches), addNotes in state/pattern-actions.test.ts; here the
// real roll is driven with the mouse. The ghost is read off the canvas's
// data-ghost (the pitches it draws) and the readout.

type Note = { id: string; pitch: number; start: number; len: number };
type Daw = {
  project: { tracks: { id: string; kind: string; currentPatternId: string; patterns: { id: string; notes: Note[] }[] }[] };
  history: { labels: { undo: string | null } } | null;
  actions: { addNote: (trackId: string, o: { pitch: number; start: number; len: number }) => unknown };
};
// Inside page.evaluate reach it as `(window as unknown as W).__daw`.
type W = { __daw: Daw };
type PrView = { ticksPerPx: number; scrollTick: number; rowH: number; topPitch: number; keysW: number; rulerH: number };

const undoLabel = (page: Page) => page.evaluate(() => (window as unknown as W).__daw.history?.labels.undo ?? null);
/** The synth track's current pattern's notes. */
const notes = (page: Page) => page.evaluate(() => {
  const t = (window as unknown as W).__daw.project.tracks.find((x) => x.kind === 'synth')!;
  return JSON.parse(JSON.stringify(t.patterns.find((x) => x.id === t.currentPatternId)!.notes)) as Note[];
});
const pitches = async (page: Page) => (await notes(page)).map((n) => n.pitch).sort((a, b) => a - b);

async function openRoll(page: Page) {
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  await expect(page.getByRole('button', { name: 'Piano roll' })).toHaveClass(/active/);
  await expect(page.getByTestId('pr-canvas')).not.toHaveAttribute('data-view', '');
}

const view = async (page: Page) => JSON.parse((await page.getByTestId('pr-canvas').getAttribute('data-view'))!) as PrView;

/** Page coordinates of (tick, pitch), vertically mid-row. */
async function at(page: Page, tick: number, pitch: number) {
  const v = await view(page);
  const b = (await page.getByTestId('pr-canvas').boundingBox())!;
  return { x: b.x + v.keysW + (tick - v.scrollTick) / v.ticksPerPx, y: b.y + v.rulerH + (v.topPitch - pitch) * v.rowH + v.rowH / 2 };
}

/** Click the cell holding `tick` on `pitch`'s row. */
async function clickCell(page: Page, tick: number, pitch: number) {
  const p = await at(page, tick + 30, pitch);
  await page.mouse.click(p.x, p.y);
}

/** Pick a type / inversion in the ▾ card (each pick also turns chord mode on), then close it. */
async function pickChord(page: Page, type: string, inversion: number) {
  await page.getByTestId('pr-chord-opts').click();
  await expect(page.getByTestId('pr-chord-pop')).toBeVisible();
  await page.getByTestId('pr-chord-type').selectOption(type);
  await page.getByTestId('pr-chord-inv').selectOption(String(inversion));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pr-chord-pop')).toHaveCount(0);
  await expect(page.getByTestId('pr-chord')).toHaveAttribute('aria-pressed', 'true');
}

const A3 = 57;

test('In key at A3 places Am7 (A C E G), 4 notes in one undo entry; Esc leaves chord mode', async ({ page }) => {
  await openRoll(page);
  const chord = page.getByTestId('pr-chord');
  await expect(chord).toHaveAttribute('aria-pressed', 'false');
  await chord.click(); // default type: In key, root position
  await expect(chord).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pr-readout')).toContainText('Chord: In key, root position');

  await clickCell(page, 0, A3);
  await expect.poll(() => pitches(page)).toEqual([57, 60, 64, 67]);
  const placed = await notes(page);
  expect(placed.every((n) => n.start === 0 && n.len === 240)).toBe(true); // the grid cell (1/16)
  await expect.poll(() => undoLabel(page)).toBe('Add chord');
  await expect(page.getByTestId('pr-readout')).toContainText('In key'); // still in chord mode

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pitches(page)).toEqual([]); // one undo removes all 4

  // Esc leaves chord mode: a click draws one note again.
  await page.keyboard.press('Escape');
  await expect(chord).toHaveAttribute('aria-pressed', 'false');
  await clickCell(page, 960, A3);
  await expect.poll(() => pitches(page)).toEqual([57]);
});

test('m9 in first inversion on A3 places C4 E4 G4 A4 B4', async ({ page }) => {
  await openRoll(page);
  await pickChord(page, 'm9', 1);
  await expect(page.getByTestId('pr-chord-opts')).toHaveAttribute('aria-label', /m9, inversion 1/);
  await clickCell(page, 480, A3);
  await expect.poll(() => pitches(page)).toEqual([60, 64, 67, 69, 71]);
  expect((await notes(page)).every((n) => n.start === 480)).toBe(true);
});

test('hovering shows a ghost of the chord (N notes), none over a note or past the end', async ({ page }) => {
  await openRoll(page);
  const cv = page.getByTestId('pr-canvas');
  const hover = async (tick: number, pitch: number) => {
    const p = await at(page, tick + 30, pitch);
    await page.mouse.move(p.x, p.y);
  };
  await hover(0, A3);
  await expect(cv).toHaveAttribute('data-ghost', ''); // chord mode off: no ghost

  await page.getByTestId('pr-chord').click();
  await hover(240, A3);
  await expect(cv).toHaveAttribute('data-ghost', '57,60,64,67');
  await expect(page.getByTestId('pr-readout')).toContainText('In key · A3 C4 E4 G4 · click to place');

  await pickChord(page, 'm9', 0);
  await hover(240, A3);
  await expect(cv).toHaveAttribute('data-ghost', '57,60,64,67,71'); // 5 notes

  // Snap to key on: a fixed type's root snaps to the key (C#4 -> D4, ties up), then D minor... as m9 on D.
  await page.getByTestId('pr-snap-key').click();
  await hover(240, 61);
  await expect(cv).toHaveAttribute('data-ghost', '62,65,69,72,76');

  // Over a placed note: no ghost (a press there moves the note).
  await clickCell(page, 240, 61);
  await expect.poll(() => pitches(page)).toEqual([62, 65, 69, 72, 76]);
  await hover(240, 62);
  await expect(cv).toHaveAttribute('data-ghost', '');
  await page.mouse.move(2, 2);
  await expect(cv).toHaveAttribute('data-ghost', '');
});

test('a pattern near full refuses the whole chord with a message', async ({ page }) => {
  test.setTimeout(60_000);
  await openRoll(page);
  // 1021 of the 1024 slots used: an In key chord (4 notes) does not fit.
  await page.evaluate(() => {
    const d = (window as unknown as W).__daw;
    const t = d.project.tracks.find((x) => x.kind === 'synth')!;
    for (let i = 0; i < 1021; i++) d.actions.addNote(t.id, { pitch: 100 + (i % 20), start: (i * 3) % 3840, len: 10 });
  });
  await expect.poll(async () => (await notes(page)).length).toBe(1021);
  const before = await undoLabel(page);
  await page.getByTestId('pr-chord').click();
  await clickCell(page, 960, A3);
  await expect(page.getByTestId('pr-readout')).toContainText('Pattern is full: no room for this 4-note chord');
  expect((await notes(page)).length).toBe(1021); // nothing placed, not even part of it
  expect(await undoLabel(page)).toBe(before);

  // A 3-note chord still fits.
  await pickChord(page, 'maj', 0);
  await clickCell(page, 1920, A3);
  await expect.poll(async () => (await notes(page)).length).toBe(1024);
});

for (const width of [1280, 1440, 1680]) {
  test(`layout at ${width}: the toolbar stays one row with the chord controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await openRoll(page);
    await page.getByTestId('pr-chord').click(); // the longer chord-mode readout
    if (width === 1280) await page.getByTestId('pianoroll').locator('.bar').screenshot({ path: 'test-results/chord-toolbar-1280.png' });
    const bar = await page.getByTestId('pianoroll').locator('.bar').evaluate((el) => {
      const kids = [...el.children].map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0);
      const mid = (r: DOMRect) => r.top + r.height / 2;
      return { oneLine: kids.every((r) => Math.abs(mid(r) - mid(kids[0])) < 4), overflow: el.scrollWidth > el.clientWidth };
    });
    expect(bar).toEqual({ oneLine: true, overflow: false });
    for (const id of ['pr-key', 'pr-snap-key', 'pr-chord', 'pr-chord-opts', 'pr-transpose', 'pr-fit-key', 'pr-readout']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });
}
