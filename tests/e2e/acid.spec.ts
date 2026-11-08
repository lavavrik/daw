import { expect, test, type Page } from '@playwright/test';

// The Acid tab (plan 17 Task 4): a step view of a synth track's current
// pattern, stored as ordinary notes (docs/architecture/sequencer.md, "Acid
// tab"). Live notes come in through the injected-MIDI hook (window.__daw.midi).

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type N = { pitch: number; vel: number; start: number; len: number };

async function openAcid(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await page.waitForFunction(() => !!(window as Any).__daw?.midi);
  await page.getByTestId('add-synth-track').click();
  await page.getByTestId('tab-acid').click();
  await expect(page.getByTestId('tab-acid')).toHaveClass(/active/);
  await expect(page.getByTestId('acid-step-0')).toBeVisible();
}

/** The selected track's current-pattern notes, sorted by start (plain data). */
const notes = (page: Page) =>
  page.evaluate(() => {
    const p = (window as Any).__daw.project;
    const t = p.tracks.find((x: Any) => x.id === p.selectedTrackId);
    const pat = t.patterns.find((x: Any) => x.id === t.currentPatternId);
    return (pat.notes as N[])
      .map(({ pitch, vel, start, len }) => ({ pitch, vel, start, len }))
      .sort((a, b) => a.start - b.start);
  });

/** Note-on then note-off for each pitch, as a MIDI keyboard would send them. */
async function play(page: Page, pitches: number[]) {
  for (const n of pitches) {
    await page.evaluate((n) => {
      (window as Any).__daw.midi.inject([0x90, n, 100]);
      (window as Any).__daw.midi.inject([0x80, n, 0]);
    }, n);
  }
}

const ENTERED = [
  { pitch: 36, vel: 80, start: 0, len: 120 },
  { pitch: 39, vel: 80, start: 240, len: 120 },
  { pitch: 43, vel: 80, start: 480, len: 120 },
  { pitch: 48, vel: 80, start: 720, len: 120 },
];

async function enterFour(page: Page) {
  await page.getByTestId('acid-step-0').click();
  await expect(page.getByTestId('acid-step-0')).toHaveAttribute('aria-pressed', 'true');
  await play(page, [36, 39, 43, 48]);
  await expect(page.getByTestId('acid-step-4')).toHaveAttribute('aria-pressed', 'true');
}

test('step entry writes notes', async ({ page }) => {
  await openAcid(page);
  expect(await notes(page)).toEqual([]);
  await enterFour(page);
  expect(await notes(page)).toEqual(ENTERED);
  await expect(page.getByTestId('acid-step-3')).toHaveAttribute('aria-label', 'Step 4: C3');
  await expect(page.getByTestId('acid-step-3')).toContainText('C');
  await expect(page.getByTestId('acid-step-4')).toContainText('—');
  // A fresh synth track's patch is poly: slides need a mono glide patch.
  await expect(page.getByTestId('acid-slide-hint')).toBeVisible();
});

test('accent and slide, one undo', async ({ page }) => {
  await openAcid(page);
  await enterFour(page);
  await page.getByTestId('acid-step-1').click();
  await page.getByTestId('acid-accent').click();
  await expect.poll(async () => (await notes(page))[1].vel).toBe(120);
  await page.getByTestId('acid-slide').click();
  await expect.poll(async () => (await notes(page))[1].len).toBe(300);
  await expect(page.getByTestId('acid-step-1')).toHaveAttribute('aria-label', 'Step 2: D#2, accent, slide');
  // The last entered step has nothing after it: no slide there.
  await page.getByTestId('acid-step-3').click();
  await expect(page.getByTestId('acid-slide')).toBeDisabled();
  await expect(page.getByTestId('acid-slide')).toHaveAttribute('title', 'Slide needs a next note');
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => notes(page)).toEqual(ENTERED);
});

test('unshowable shows convert', async ({ page }) => {
  await openAcid(page);
  await page.evaluate(() => {
    const d = (window as Any).__daw;
    d.actions.addNote(d.project.selectedTrackId, { pitch: 40, vel: 100, start: 100, len: 120 });
  });
  await expect(page.getByTestId('acid-unshowable')).toContainText("This pattern has notes the Acid tab can't show");
  await expect(page.getByTestId('acid-step-0')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.history.labels.undo)).toBe('Add note');
  await page.getByTestId('acid-convert').click();
  await expect(page.getByTestId('acid-step-0')).toBeVisible();
  // Canonical: snapped to step 0, a plain gate; vel 100 (the app's default
  // velocity) is below the accent threshold 110, so it is written as 80.
  expect(await notes(page)).toEqual([{ pitch: 40, vel: 80, start: 0, len: 120 }]);
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.history.labels.undo)).toBe('Convert to steps');
  // One entry: a single undo brings back the off-grid note (and the notice).
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('acid-unshowable')).toBeVisible();
  expect(await page.evaluate(() => (window as Any).__daw.history.labels.undo)).toBe('Add note');
});

test('alt digits follow tab order', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await page.getByTestId('add-synth-track').click();
  await page.keyboard.press('Alt+3');
  await expect(page.getByTestId('tab-acid')).toHaveClass(/active/);
  await expect(page.getByTestId('acid-step-0')).toBeVisible();
  await page.keyboard.press('Alt+4');
  await expect(page.getByRole('button', { name: 'Instrument' })).toHaveClass(/active/);
  await page.keyboard.press('Alt+2');
  await expect(page.getByRole('button', { name: 'Piano roll' })).toHaveClass(/active/);
});

test('keyboard edits the selected step', async ({ page }) => {
  await openAcid(page);
  await enterFour(page);
  await page.getByTestId('acid-step-0').click();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('acid-step-1')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+A'); // accent, not the QWERTY piano (nothing is entered)
  await expect.poll(async () => (await notes(page))[1]).toEqual({ pitch: 39, vel: 120, start: 240, len: 120 });
  await expect(page.getByTestId('acid-step-2')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+T'); // step 2 ties step 1's note
  await expect.poll(async () => (await notes(page)).map((n) => [n.start, n.len])).toEqual([[0, 120], [240, 360], [720, 120]]);
  await expect(page.getByTestId('acid-step-2')).toContainText('~');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete'); // step 3 becomes a rest
  await expect.poll(async () => (await notes(page)).map((n) => n.start)).toEqual([0, 240]);
  await expect(page.getByTestId('acid-step-3')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('acid-step-3')).toHaveAttribute('aria-pressed', 'false');
});

test('the toolbar Length sets the pattern bars; the grid follows', async ({ page }) => {
  // Its own test, with no step clicks before it: a click's gesture commits
  // one task after pointerup, and under load an edit can land inside it.
  await openAcid(page);
  // 2 bars = 32 steps, in rows of 16; one undo entry.
  await page.getByTestId('acid-length').selectOption('2');
  await expect(page.getByTestId('acid-step-31')).toBeVisible();
  await expect(page.getByTestId('acid-step-32')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.history.labels.undo)).toBe('Pattern length');
  // A 3-bar pattern (set elsewhere) shows its own length in the menu.
  await page.evaluate(() => {
    const d = (window as Any).__daw;
    d.actions.setPatternBars(d.project.selectedTrackId, 3);
  });
  await expect(page.getByTestId('acid-step-47')).toBeVisible();
  await expect(page.getByTestId('acid-length')).toHaveValue('3');
  await expect(page.getByTestId('acid-length').locator('option')).toHaveText(['1 bar', '2 bars', '3 bars', '4 bars']);
  // Undo both lengths (focus off the select: it keeps its own keys), back
  // to a new track's 4 bars.
  await page.getByTestId('acid').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('acid-step-47')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('acid-step-63')).toBeVisible();
  await expect(page.getByTestId('acid-length')).toHaveValue('4');
});

test('QWERTY step entry: plain letters are piano keys, Shift+letters toggle', async ({ page }) => {
  await openAcid(page);
  await page.getByTestId('acid-step-0').click();
  // KeyA is the piano's C (octave 4 = MIDI 60): clamped to the base's octave
  // up, so C3 (48) at step 0, and step 1 is selected.
  await page.keyboard.press('KeyA');
  await expect.poll(() => notes(page)).toEqual([{ pitch: 48, vel: 80, start: 0, len: 120 }]);
  await expect(page.getByTestId('acid-step-1')).toHaveAttribute('aria-pressed', 'true');
  // S (D) and T (F#) enter too.
  await page.keyboard.press('KeyS');
  await page.keyboard.press('KeyT');
  await expect.poll(async () => (await notes(page)).map((n) => n.pitch)).toEqual([48, 50, 54]);
  await expect(page.getByTestId('acid-step-3')).toHaveAttribute('aria-pressed', 'true');
  // Shift+A toggles the accent and plays nothing (no step is entered).
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+A');
  await expect.poll(async () => (await notes(page))[2].vel).toBe(120);
  await expect(page.getByTestId('acid-step-2')).toHaveAttribute('aria-pressed', 'true');
  expect(await notes(page)).toHaveLength(3);
  // Shift+R makes the step a rest (and doesn't arm recording).
  await page.keyboard.press('Shift+R');
  await expect.poll(async () => (await notes(page)).map((n) => n.pitch)).toEqual([48, 50]);
  await expect(page.getByTestId('rec-button')).toHaveAttribute('aria-pressed', 'false');
});

test('a key strip click sets the step and auditions it, entering nothing more', async ({ page }) => {
  await openAcid(page);
  // Spy the engine's NOTE_ON / NOTE_OFF (the live-note bus sends through it).
  await page.evaluate(() => {
    const d = (window as Any).__daw;
    const e = d.engine;
    const send = e.send.bind(e);
    d.sent = [];
    e.send = (op: number, a: number, ...rest: number[]) => {
      if (op === d.Op.NOTE_ON || op === d.Op.NOTE_OFF) d.sent.push([op === d.Op.NOTE_ON ? 'on' : 'off', a]);
      return send(op, a, ...rest);
    };
  });
  await page.getByTestId('acid-step-0').click();
  await page.getByTestId('acid-key-4').click();
  await expect.poll(() => notes(page)).toEqual([{ pitch: 40, vel: 80, start: 0, len: 120 }]);
  // E2 sounded and was released (pointerup or the 150 ms timer).
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.sent)).toEqual([['on', 40], ['off', 40]]);
  // The audition's note-on is no step entry: step 0 stays selected, step 1 stays a rest.
  await page.waitForTimeout(250); // past the 150 ms audition
  await expect(page.getByTestId('acid-step-0')).toHaveAttribute('aria-pressed', 'true');
  expect(await notes(page)).toHaveLength(1);
});

test('no step entry while recording (armed and playing)', async ({ page }) => {
  await openAcid(page);
  await page.getByTestId('acid-step-0').click();
  await page.keyboard.press('KeyR'); // record arm (plain R isn't the tab's)
  await expect(page.getByTestId('rec-button')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.project.playing)).toBe(true);
  await play(page, [40]);
  await page.waitForTimeout(100);
  // The note goes to the recorder only: the selection stays on step 0.
  await expect(page.getByTestId('acid-step-0')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyR');
  await expect(page.getByTestId('rec-button')).toHaveAttribute('aria-pressed', 'false');
  // Disarmed and stopped: entry works again.
  await play(page, [43]);
  await expect(page.getByTestId('acid-step-1')).toHaveAttribute('aria-pressed', 'true');
});

test('the selection clears when the current pattern changes; Slide on a rest says it has no note', async ({ page }) => {
  await openAcid(page);
  await page.getByTestId('acid-step-2').click();
  await expect(page.getByTestId('acid-slide')).toHaveAttribute('title', 'Slide: this step has no note');
  await page.getByTestId('pattern-new').click();
  await expect(page.locator('[data-testid^="acid-step-"][aria-pressed="true"]')).toHaveCount(0);
  await expect(page.getByTestId('acid-key-0')).toBeDisabled();
});
