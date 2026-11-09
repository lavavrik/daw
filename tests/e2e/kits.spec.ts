import { expect, test, type Page } from '@playwright/test';
import { openAddTrack } from './addTrack';
import { startApp } from './startApp';

// The built-in drum kits (plan 25 Task 1; state/kits.ts, state/kit-actions.ts):
// the Browser's Kits tab lists the Starter kit and the four generated kits,
// each previewable and loadable onto the selected drum track by role (one
// undo entry, steps kept); Add track ▸ Drum track offers each kit too.

type Daw = {
  engine: { telemetry(): Float32Array } | null;
  project: {
    sampleFiles: Map<number, { name: string }>;
    tracks: { kind: string; rows?: { name: string; sampleId: number | null }[]; patterns?: { id: string; steps: number[][] }[]; currentPatternId?: string }[];
  };
};

const ROLES = ['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc'];
const STARTER = ['kick-punch.wav', 'clap.wav', 'hat-closed.wav', 'hat-open.wav', 'snare.wav', 'rim.wav', 'shaker.wav', 'perc-tom.wav'];
const FILES = ['kick.wav', 'clap.wav', 'closed-hat.wav', 'open-hat.wav', 'snare.wav', 'rim.wav', 'shaker.wav', 'perc.wav'];
const KITS = [
  { id: 'starter', name: 'Starter kit', files: STARTER },
  { id: 'drum-machine', name: 'Drum Machine', files: FILES.map((f) => `drum-machine-${f}`) },
  { id: 'deep', name: 'Deep', files: FILES.map((f) => `deep-${f}`) },
  { id: 'garage', name: 'Garage', files: FILES.map((f) => `garage-${f}`) },
  { id: 'dusty', name: 'Dusty', files: FILES.map((f) => `dusty-${f}`) },
];

/** Track `i`'s row names and the file each row's sample came from. */
function rowFiles(page: Page, i = 0) {
  return page.evaluate((i) => {
    const p = (window as unknown as { __daw: Daw }).__daw.project;
    const t = p.tracks[i];
    return t?.rows?.map((r) => [r.name, r.sampleId === null ? null : (p.sampleFiles.get(r.sampleId)?.name ?? null)]) ?? null;
  }, i);
}
const expected = (files: string[]) => ROLES.map((r, i) => [r, files[i]]);

/** Track `i`'s current-pattern velocity at row `r`, step `s`. */
function step(page: Page, r: number, s: number, i = 0) {
  return page.evaluate(({ r, s, i }) => {
    const t = (window as unknown as { __daw: Daw }).__daw.project.tracks[i];
    return t.patterns!.find((x) => x.id === t.currentPatternId)!.steps[r][s];
  }, { r, s, i });
}

/** Max master peakL seen over `ms` (as tests/e2e/kit.spec.ts). */
function maxPeak(page: Page, ms = 1500) {
  return page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        const eng = (window as unknown as { __daw: Daw }).__daw.engine!;
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

/** A fresh start, the default kit's samples in. */
async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  await expect.poll(() => rowFiles(page)).toEqual(expected(STARTER));
  await page.getByTestId('lib-tab-kits').click();
}

test('the Kits tab lists the five kits; each kit sample previews', async ({ page }) => {
  test.setTimeout(30_000);
  await start(page);
  await expect(page.locator('[data-kit]')).toHaveCount(5);
  await expect(page.locator('[data-kit]')).toHaveText(KITS.map((k) => new RegExp(k.name)));
  for (const k of KITS) {
    const starter = k.id === 'starter';
    if (!starter) await page.getByTestId(`kit-${k.id}-toggle`).click(); // the generated kits start closed
    const sample = page.getByTestId(starter ? 'kit-sample-kick-punch.wav' : `kit-sample-${k.id}/clap.wav`);
    await expect(sample).toBeVisible();
    await expect(page.getByTestId('preview-stop')).toBeDisabled();
    await sample.click();
    await expect(page.getByTestId('preview-stop')).toBeEnabled();
    await expect(sample).toHaveClass(/\bon\b/);
    if (!starter) await expect(page.getByTestId('preview-bar')).toContainText(`${k.name} Clap`);
    await page.getByTestId('preview-stop').click();
    await expect(sample).not.toHaveClass(/\bon\b/);
  }
  await page.screenshot({ path: 'test-results/kits-tab.png' });

  // A generated kit's sound drags in like a starter one: onto "+ Add row", named after its kit file.
  await page.evaluate(() => {
    const src = document.querySelector('[data-testid="kit-sample-garage/clap.wav"]')!;
    const dst = document.querySelector('[data-testid="add-row"]')!;
    const dt = new DataTransfer();
    const ev = (el: Element, t: string) => el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    ev(src, 'dragstart');
    for (const t of ['dragenter', 'dragover', 'drop']) ev(dst, t);
    ev(src, 'dragend');
  });
  await expect(page.getByTestId('row-8').getByTestId('row-name')).toHaveText('garage-clap');
  await expect(page.getByTestId('banner')).toBeHidden();
});

test('Load Garage onto the default drum track: every row gets its Garage sound, steps kept, one undo restores the starter', async ({ page }) => {
  test.setTimeout(30_000);
  await start(page);
  await page.getByTestId('step-0-0').click();
  await page.getByTestId('step-4-4').click();
  await page.getByTestId('kit-load-garage').click();
  await expect.poll(() => rowFiles(page)).toEqual(expected(KITS[3].files));
  await expect(page.getByTestId('row-8')).toHaveCount(0); // every role had its row: none added
  expect([await step(page, 0, 0), await step(page, 4, 4)]).toEqual([100, 100]);
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Load kit Garage/);
  await expect(page.getByTestId('project-name')).toContainText('● unsaved');

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => rowFiles(page)).toEqual(expected(STARTER));
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Set step/); // the load was one entry
  expect([await step(page, 0, 0), await step(page, 4, 4)]).toEqual([100, 100]);

  // The header's context menu offers the same load.
  await page.getByTestId('kit-deep').locator('.khead').click({ button: 'right' });
  await expect(page.getByTestId('kit-menu-load')).toHaveText('Load onto "Drums"');
  await page.getByTestId('kit-menu-load').click();
  await expect.poll(() => rowFiles(page)).toEqual(expected(KITS[2].files));
});

test('Load is off until a drum track is selected', async ({ page }) => {
  await start(page);
  await openAddTrack(page);
  await page.getByTestId('add-synth-track').click();
  await expect(page.getByTestId('kit-load-garage')).toBeDisabled();
  await expect(page.getByTestId('kit-load-garage')).toHaveAttribute('title', 'Select a drum track to load a kit onto');
  await page.getByTestId('track-0').click();
  await expect(page.getByTestId('kit-load-garage')).toBeEnabled();
});

test('Add track ▸ Drum track ▸ Deep makes a track of the Deep sounds', async ({ page }) => {
  await start(page);
  await openAddTrack(page);
  await expect(page.getByTestId('add-track-menu')).toContainText('Drum Machine');
  await page.screenshot({ path: 'test-results/kits-add-track.png' });
  await page.getByTestId('add-drum-kit-deep').click();
  await expect(page.getByTestId('track-1')).toBeVisible();
  await expect(page.getByTestId('track-1')).toContainText('Deep');
  await expect.poll(() => rowFiles(page, 1)).toEqual(expected(KITS[2].files));
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Add drum track/);
});

test('sound check: the Kick row of every kit peaks above 0.1', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await page.getByTestId('step-0-0').click();
  for (const k of KITS) {
    await page.getByTestId(`kit-load-${k.id}`).click();
    await expect.poll(() => rowFiles(page)).toEqual(expected(k.files));
    await page.getByTestId('pattern-play').click();
    // Polled while it plays: under a loaded machine the first hit can come late.
    await expect.poll(() => maxPeak(page, 1000), { message: k.name, timeout: 10_000 }).toBeGreaterThan(0.1);
    await page.getByTestId('pattern-stop').click();
  }
});
