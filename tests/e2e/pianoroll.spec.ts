import { expect, test, type Page } from '@playwright/test';

// Piano roll (plan 3, Task 5), driven through the UI with the real mouse.
// The canvas publishes its view in data-view (prMath View + rulerH), so the
// tests can aim at "bar 1 beat 1, C3" instead of hard-coded pixels.

type DawWindow = { __daw?: { engine: { telemetry(): Float64Array } | null } };
type PrView = { ticksPerPx: number; scrollTick: number; rowH: number; topPitch: number; keysW: number; rulerH: number };

const C3 = 48; // C4 = 60
const SIXTEENTH = 240;
const BEAT = 960;

async function openRoll(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await page.getByTestId('add-synth-track').click();
  await expect(page.getByRole('button', { name: 'Piano roll' })).toHaveClass(/active/);
  await expect(page.getByTestId('pr-canvas')).not.toHaveAttribute('data-view', '');
}

/** Page coordinates of (tick, pitch): `tick` inside the cell, vertically mid-row. */
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

/** Click to draw a note in the cell that holds `tick`. */
async function draw(page: Page, tick: number, pitch: number) {
  const p = await at(page, tick + 30, pitch); // a little inside the cell
  await page.mouse.click(p.x, p.y);
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

/** Max peakL over `ms`, sampled every 4 ms. */
function maxPeak(page: Page, ms: number) {
  return page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        const eng = (window as unknown as DawWindow).__daw!.engine!;
        let max = 0;
        const t0 = performance.now();
        const id = setInterval(() => {
          max = Math.max(max, eng.telemetry()[5]);
          if (performance.now() - t0 > ms) {
            clearInterval(id);
            resolve(max);
          }
        }, 4);
      }),
    ms,
  );
}

const readout = (page: Page) => page.getByTestId('pr-readout');

test('draw a note, it plays in the loop', async ({ page }) => {
  await openRoll(page);
  await draw(page, 0, C3);
  await expect(readout(page)).toContainText('C3 · 1.1.1 · 1/16');
  // The roll has focus; Space still reaches the transport.
  await page.keyboard.press('Space');
  // 4 bars at 124 bpm is ~7.7 s; the note sits on the downbeat.
  expect(await maxPeak(page, 8000)).toBeGreaterThan(0.05);
  await page.keyboard.press('Space');
});

test('drag resizes and moves', async ({ page }) => {
  await openRoll(page);
  await draw(page, 0, C3);
  await expect(readout(page)).toContainText('C3 · 1.1.1 · 1/16');
  // Resize: grab the last px of the note, pull one cell right -> 1/8.
  let p = await at(page, SIXTEENTH, C3);
  await drag(page, { x: p.x - 2, y: p.y }, { x: p.x - 2 + p.px(SIXTEENTH), y: p.y });
  await expect(readout(page)).toContainText('C3 · 1.1.1 · 1/8');
  // Move: grab the body, one beat right and two semitones up -> D3 at 1.2.1.
  p = await at(page, 60, C3);
  const to = await at(page, 60 + BEAT, C3 + 2);
  await drag(page, p, to);
  await expect(readout(page)).toContainText('D3 · 1.2.1 · 1/8');
  // Escape mid-drag puts the note back.
  const from = await at(page, 60 + BEAT, C3 + 2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + from.px(BEAT), from.y - 30, { steps: 5 });
  await expect(readout(page)).not.toContainText('D3 · 1.2.1');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(readout(page)).toContainText('D3 · 1.2.1 · 1/8');
  // Arrow keys nudge the selection (roll focused): one grid cell left, an octave down.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(readout(page)).toContainText('D2 · 1.1.4 · 1/8');
});

test('quantize snaps a drawn-off-grid note', async ({ page }) => {
  await openRoll(page);
  await draw(page, 0, C3);
  const p = await at(page, 60, C3);
  await page.keyboard.down('Alt'); // Alt-drag = no snap
  await drag(page, p, { x: p.x + p.px(100), y: p.y });
  await page.keyboard.up('Alt');
  await expect(readout(page)).toContainText(/C3 · 1\.1\.1 \+\d+t · 1\/16/);
  await page.keyboard.press('KeyQ'); // goes to the roll, not the piano
  await expect(readout(page)).toContainText('C3 · 1.1.1 · 1/16');
  // Off-grid again, then the toolbar button (nothing selected = all notes).
  await page.keyboard.down('Alt');
  await drag(page, p, { x: p.x + p.px(150), y: p.y });
  await page.keyboard.up('Alt');
  await expect(readout(page)).toContainText(/C3 · 1\.1\.1 \+1\d\dt/); // nearer 1.1.2
  await page.keyboard.press('Escape'); // clears the selection
  await expect(readout(page)).toContainText('1 note ·');
  await page.getByTestId('pr-quantize').click();
  await page.mouse.click((await at(page, SIXTEENTH + 60, C3)).x, p.y); // select it again
  await expect(readout(page)).toContainText('C3 · 1.1.2 · 1/16');
});

test('delete removes it and playback is silent', async ({ page }) => {
  await openRoll(page);
  await draw(page, 0, C3);
  await draw(page, BEAT, C3);
  await page.keyboard.press('ControlOrMeta+a');
  await expect(readout(page)).toContainText('2 notes selected');
  await page.keyboard.press('Delete');
  await expect(readout(page)).toContainText('0 notes');
  await page.keyboard.press('Space');
  expect(await maxPeak(page, 2500)).toBeLessThan(0.001);
  await page.keyboard.press('Space');
  // Letter keys still play the QWERTY piano while the roll has focus.
  await expect(page.getByTestId('pr-canvas').locator('..')).toBeFocused();
  await page.keyboard.down('KeyA');
  await expect.poll(() => maxPeak(page, 300), { timeout: 2_000 }).toBeGreaterThan(0.05);
  await page.keyboard.up('KeyA');
});

test('length change keeps notes past the end; tab choice is remembered', async ({ page }) => {
  await openRoll(page);
  await draw(page, 3 * 3840, C3); // bar 4
  await expect(readout(page)).toContainText('C3 · 4.1.1 · 1/16');
  await page.getByTestId('pr-length').selectOption('2');
  await expect(readout(page)).toContainText('past the end (silent)');
  // Editing a silent note keeps it where it is (never pulled into the loop).
  await page.getByTestId('pr-canvas').locator('..').focus();
  await page.keyboard.press('ArrowUp');
  await expect(readout(page)).toContainText('C#3 · 4.1.1 · 1/16 · vel 100 · past the end (silent)');
  await page.getByTestId('pr-quantize').click(); // quantize skips it too
  await expect(readout(page)).toContainText('C#3 · 4.1.1');
  // Tabs: pick Instrument, visit the drums, come back: still Instrument.
  await page.getByRole('button', { name: 'Instrument' }).click();
  await page.getByTestId('track-0').click();
  await page.getByTestId('track-1').click();
  await expect(page.getByRole('button', { name: 'Instrument' })).toHaveClass(/active/);
  await expect(page.getByTestId('rack')).toBeVisible();
});

test('screenshot: a house bassline with one note selected', async ({ page }) => {
  await openRoll(page);
  await page.getByTestId('pr-length').selectOption('2');
  // Off-beat bass, two bars (16ths: 2, 6, 10, 14).
  const line: [number, number][] = [
    [2, 48], [6, 48], [10, 51], [14, 48],
    [18, 46], [22, 46], [26, 43], [30, 46],
  ];
  for (const [s, pitch] of line) await draw(page, s * SIXTEENTH, pitch);
  const p = await at(page, 10 * SIXTEENTH + 60, 51);
  await page.mouse.click(p.x, p.y);
  await expect(readout(page)).toContainText('D#3 · 1.3.3 · 1/16');
  await page.mouse.move(p.x + 200, p.y + 40); // hover a row: its key shows its name
  await page.screenshot({ path: 'test-results/pianoroll.png' });
});

test('layout at 1280×720: C2..C5 at >= 9 px rows, top bar on one line', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openRoll(page);
  const v = JSON.parse((await page.getByTestId('pr-canvas').getAttribute('data-view'))!) as PrView & { velTop: number };
  expect(v.rowH).toBeGreaterThanOrEqual(9);
  const noteH = v.velTop - 4 - v.rulerH;
  expect(v.topPitch).toBeGreaterThanOrEqual(72); // C5 visible
  expect(v.topPitch - Math.floor(noteH / v.rowH) + 1).toBeLessThanOrEqual(36); // C2 visible
  const bar = await page.locator('header.bar').evaluate((el) => {
    const kids = [...el.children].map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0); // not the spacer
    const mid = (r: DOMRect) => r.top + r.height / 2;
    return {
      overflow: el.scrollWidth > el.clientWidth,
      oneLine: kids.every((r) => Math.abs(mid(r) - mid(kids[0])) < 4 && r.height < 34), // nothing wrapped
    };
  });
  expect(bar).toEqual({ overflow: false, oneLine: true });
  await expect(page.getByTestId('latency')).toHaveText(/^\d+ ms/);
  await page.locator('header.bar').screenshot({ path: 'test-results/topbar.png' });
});

test('Clear asks inline: Cancel keeps the notes, Confirm clears them in one undo step', async ({ page }) => {
  await openRoll(page);
  await draw(page, 0, C3);
  await draw(page, BEAT, C3);
  await page.keyboard.press('Escape'); // clears the selection: the readout counts the notes
  await expect(readout(page)).toContainText('2 notes');
  await page.getByTestId('pr-clear').click();
  const ask = page.getByTestId('inline-confirm');
  await expect(ask).toContainText('Clear all 2 notes');
  await expect(page.getByTestId('inline-confirm-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(page.getByTestId('pr-clear')).toBeFocused(); // focus returned to the trigger
  await expect(readout(page)).toContainText('2 notes');
  await page.getByTestId('pr-clear').click();
  await page.getByTestId('inline-confirm-ok').click();
  await expect(ask).toHaveCount(0);
  await expect(readout(page)).not.toContainText('2 notes');
  await page.keyboard.press('ControlOrMeta+z'); // one undo entry brings both back
  await expect(readout(page)).toContainText('2 notes');
});

test('bottom-panel tab shortcuts: Alt+2 Piano roll, a disabled tab only hints, F9 Mixer', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await page.getByTestId('add-synth-track').click();
  await page.keyboard.press('Alt+Digit3');
  await expect(page.getByRole('button', { name: 'Instrument' })).toHaveClass(/active/);
  await page.keyboard.press('Alt+Digit2');
  await expect(page.getByRole('button', { name: 'Piano roll' })).toHaveClass(/active/);
  await expect(page.getByTestId('pr-canvas')).toBeVisible();
  // Step grid is disabled for a synth track: a hint, same tab.
  await page.keyboard.press('Alt+Digit1');
  await expect(page.getByTestId('flash-hint')).toHaveText('Select a drum track');
  await expect(page.getByRole('button', { name: 'Piano roll' })).toHaveClass(/active/);
  await page.keyboard.press('F9');
  await expect(page.getByTestId('mixer-tab')).toHaveClass(/active/);
});
