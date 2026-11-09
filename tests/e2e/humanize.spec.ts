import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// Swing presets and Humanize (plan 25 Task 3; docs/architecture/sequencer.md
// "Swing presets", "Humanize"). The maths (MPC % <-> swing, the jitter, the
// bounds, determinism, no-op at 0) is unit-tested in app/src/state/groove.test.ts.

type Note = { id: string; start: number; vel: number };
type Daw = {
  project: { tracks: { kind: string; currentPatternId: string; patterns: { id: string; swing: number; steps: number[][]; notes: Note[] }[] }[] };
  history: { labels: { undo: string | null } } | null;
};
const daw = (page: Page) => page.evaluate(() => {
  const d = (window as unknown as { __daw: Daw }).__daw;
  return { tracks: JSON.parse(JSON.stringify(d.project.tracks)) as Daw['project']['tracks'], undo: d.history?.labels.undo ?? null };
});
/** The current pattern of track `i`. */
const pat = async (page: Page, i = 0) => {
  const t = (await daw(page)).tracks[i];
  return t.patterns.find((x) => x.id === t.currentPatternId)!;
};
const undoLabel = async (page: Page) => (await daw(page)).undo;

async function home(page: Page) {
  await page.goto('/');
  await startApp(page);
  await expect(page.getByTestId('step-0-0')).toBeVisible();
}

test('the 58 % chip sets swing 0.32 and shows as active; one undo entry; the slider popover still works', async ({ page }) => {
  await home(page);
  await page.getByTestId('swing-presets').click();
  const pop = page.getByTestId('swing-presets-pop');
  await expect(pop).toBeVisible();
  await expect(pop.getByRole('button')).toHaveText(['Straight', '54 %', '58 %', '62 %', '66 %']);
  await expect(page.getByTestId('swing-preset-50')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('swing-preset-58').click();
  await expect.poll(async () => (await pat(page)).swing).toBe(0.32);
  await expect(page.getByTestId('swing')).toHaveValue('32');
  await expect(page.getByTestId('swing-preset-58')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('swing-preset-50')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('swing-presets')).toContainText('MPC 58 %');
  await expect.poll(async () => undoLabel(page)).toBe('Swing');

  // Esc closes it, back on its button; a value off the presets shows none.
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(page.getByTestId('swing-presets')).toBeFocused();
  // The swing slider's right-click ValuePopover (plan 24) is unchanged.
  await page.getByTestId('swing').click({ button: 'right' });
  await expect(page.getByTestId('value-input')).toBeFocused();
  await page.keyboard.type('33');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await pat(page)).swing).toBe(0.33);
  await expect(page.getByTestId('swing-presets')).toContainText('Presets');

  // One Cmd+Z per edit: the typed 33, then the chip.
  await page.getByTestId('swing-presets').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await pat(page)).swing).toBe(0.32);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await pat(page)).swing).toBe(0);
});

test('Humanize at 50 % changes some step velocities, never turns a step on or off, in one undo', async ({ page }) => {
  await home(page);
  for (const s of [0, 2, 4, 6, 8, 10, 12, 14]) await page.getByTestId(`step-0-${s}`).click();
  for (const s of [1, 5, 9, 13]) await page.getByTestId(`step-2-${s}`).click();
  const before = (await pat(page)).steps;
  const lit = before.flatMap((row, r) => row.map((v, s) => [r, s, v] as const)).filter(([, , v]) => v > 0);
  expect(lit.length).toBeGreaterThanOrEqual(12);

  await page.getByTestId('humanize').click();
  await expect(page.getByTestId('humanize-pop')).toBeVisible();
  await expect(page.getByTestId('humanize-pct')).toHaveText('50%'); // the default amount
  await page.getByTestId('humanize-apply').click();
  await expect(page.getByTestId('humanize-pop')).toHaveCount(0);
  await expect.poll(async () => undoLabel(page)).toBe('Humanize');

  const after = (await pat(page)).steps;
  const changed = lit.filter(([r, s, v]) => after[r][s] !== v);
  expect(changed.length).toBeGreaterThan(0);
  for (let r = 0; r < before.length; r++) {
    for (let s = 0; s < before[r].length; s++) {
      expect(after[r][s] > 0).toBe(before[r][s] > 0);
      if (before[r][s] > 0) expect(Math.abs(after[r][s] - before[r][s])).toBeLessThanOrEqual(10); // ±20 x 50 %
    }
  }

  // One Cmd+Z puts every velocity back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await pat(page)).steps).toEqual(before);
  expect(await undoLabel(page)).not.toBe('Humanize');

  // Enter at 0 % applies nothing and is not remembered: the card opens at the last nonzero amount.
  await page.getByTestId('humanize').click();
  await page.getByTestId('humanize-amount').fill('0');
  await expect(page.getByTestId('humanize-pct')).toHaveText('0%');
  await page.getByTestId('humanize-amount').press('Enter');
  await expect(page.getByTestId('humanize-pop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('humanize-pop')).toHaveCount(0);
  await page.getByTestId('humanize').click();
  await expect(page.getByTestId('humanize-pct')).toHaveText('50%');
});

test('the piano roll Humanize moves some note starts, inside the pattern, in one undo', async ({ page }) => {
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  const canvas = page.getByTestId('pr-canvas');
  await expect(canvas).not.toHaveAttribute('data-view', '');
  const synth = async () => {
    const tracks = (await daw(page)).tracks;
    const t = tracks.find((x) => x.kind === 'synth')!;
    return t.patterns.find((x) => x.id === t.currentPatternId)!;
  };

  // Draw 8 notes, one per beat at C4 (the view's data-view aims the clicks).
  const v = JSON.parse((await canvas.getAttribute('data-view'))!) as { ticksPerPx: number; scrollTick: number; rowH: number; topPitch: number; keysW: number; rulerH: number };
  const b = (await canvas.boundingBox())!;
  const pitch = v.topPitch - 6;
  for (let i = 0; i < 8; i++) {
    const tick = i * 480 + 30;
    await page.mouse.click(b.x + v.keysW + (tick - v.scrollTick) / v.ticksPerPx, b.y + v.rulerH + (v.topPitch - pitch) * v.rowH + v.rowH / 2);
  }
  await expect.poll(async () => (await synth()).notes.length).toBe(8);
  const before = (await synth()).notes;

  await page.getByTestId('pr-humanize').click();
  await expect(page.getByTestId('humanize-pop')).toBeVisible();
  await page.getByTestId('humanize-amount').fill('100');
  await expect(page.getByTestId('humanize-pct')).toHaveText('100%');
  await page.getByTestId('humanize-apply').click();
  await expect.poll(async () => undoLabel(page)).toBe('Humanize');

  const after = (await synth()).notes;
  const byId = new Map(before.map((n) => [n.id, n]));
  const moved = after.filter((n) => n.start !== byId.get(n.id)!.start);
  expect(moved.length).toBeGreaterThan(0);
  for (const n of after) {
    expect(n.start).toBeGreaterThanOrEqual(0);
    expect(Math.abs(n.start - byId.get(n.id)!.start)).toBeLessThanOrEqual(12);
  }

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await synth()).notes.map((n) => [n.id, n.start, n.vel])).toEqual(before.map((n) => [n.id, n.start, n.vel]));
});
