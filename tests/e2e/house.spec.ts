import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { BUILTIN_GROUPS, PLAN28_PATCHES as PLAN28 } from './builtinPatches';
import { startApp } from './startApp';

// The menu's contract (BUILTIN_GROUPS) and plan 28's patches: builtinPatches.ts.

// Plan 11: the patch menu's groups, the Sax's Formant panel, and Save patch refusing a built-in name. The
// every-patch-sounds and four-house-tracks cases are timing-sensitive and live
// in serial.spec.ts.

type DawWindow = {
  __daw?: {
    engine: { telemetry(): Float64Array; dropouts(): number } | null;
    project: { tracks: { patchName?: string; modules?: { idx: number; kind: number; params: number[] }[] }[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    library: { attach(dir: FileSystemDirectoryHandle): Promise<void> } & Record<string, any>;
  };
};

async function startAudio(page: Page) {
  await page.goto('/');
  await startApp(page);
}

async function addSynth(page: Page) {
  await addTrack(page, 'synth');
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByTestId('patch-select')).toBeVisible();
}

test('patch menu groups starter, sampler, then house', async ({ page }) => {
  await startAudio(page);
  await addSynth(page);
  const groups = await page.getByTestId('patch-select').evaluate((sel) =>
    [...sel.querySelectorAll('optgroup')].map((g) => ({
      label: g.label,
      names: [...g.querySelectorAll('option')].map((o) => o.textContent),
    })),
  );
  expect(groups).toEqual(BUILTIN_GROUPS.map((g) => ({ label: g.label, names: g.patches })));
});

test('Sax rack shows a Formant', async ({ page }) => {
  await startAudio(page);
  await addSynth(page);
  await page.getByTestId('patch-select').selectOption('Sax');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as DawWindow).__daw!.project.tracks[1].modules!.length))
    .toBe(19);
  const fi = 4; // the Sax's Formant (housePatches.ts idx 4; house_patches.rs checks the same)
  const panel = page.getByTestId(`module-${fi}`);
  await expect(panel).toBeVisible();
  // Ten param controls: knobs, faders, LED choices, selects (a fader's
  // `-track` part has no role and is not one; nor is the Formant's own
  // `track` param's track, `knob-4-track-track`).
  await expect(panel.locator(`:is([role=slider], [role=radiogroup], select)[data-testid^="knob-${fi}-"]`)).toHaveCount(10);
  // f1 reads the patch's value (520 Hz), in the knob's own format.
  await expect(page.getByTestId(`knob-${fi}-f1`)).toContainText('520');
});

test('save patch refuses a house name', async ({ page }) => {
  test.setTimeout(30_000);
  await startAudio(page);
  const lib = `e2e-house-lib-${test.info().workerIndex}`;
  await page.evaluate(async (lib) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(lib, { recursive: true }).catch(() => {});
    await root.getDirectoryHandle(lib, { create: true });
    const dir = await root.getDirectoryHandle(lib);
    await (window as unknown as DawWindow).__daw!.library.attach(dir);
  }, lib);
  await addSynth(page);
  await page.getByTestId('patch-save').click();
  await page.getByTestId('patch-save-name').fill('sAx');
  await page.getByTestId('patch-save-ok').click();
  await expect(page.getByRole('alert').filter({ hasText: 'built-in' })).toBeVisible();
  await page.evaluate(async (lib) => {
    await (await navigator.storage.getDirectory()).removeEntry(lib, { recursive: true }).catch(() => {});
    await new Promise((r) => {
      const req = indexedDB.deleteDatabase('daw-library');
      req.onsuccess = req.onerror = req.onblocked = r;
    });
  }, lib);
});

/** Max master peak (telemetry slot 5, peakL) over `ms`, sampled every 4 ms. */
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

// Plan 28 Task 1: each new patch is picked from the patch menu, its example
// roll added from the rack ("Add example roll"), and played: it sounds
// (master peak > 0.02). The roll's pattern is the selected one, so Space
// plays it.
test('plan 28: each new house patch loads and its example plays', async ({ page }) => {
  test.setTimeout(90_000);
  await startAudio(page);
  await addSynth(page);
  for (const name of PLAN28) {
    await page.getByRole('button', { name: 'Instrument' }).click();
    await page.getByTestId('patch-select').selectOption(name);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as DawWindow).__daw!.project.tracks[1].patchName))
      .toBe(name);
    await page.getByTestId('rack-example').click();
    await expect(page.getByTestId('panel-title')).toContainText(`${name} example`);
    await page.keyboard.press('Space');
    const peak = await maxPeak(page, 2500);
    await page.keyboard.press('Space');
    expect(peak, `${name} example peak`).toBeGreaterThan(0.02);
    // Let the tail die before the next patch loads.
    await expect.poll(() => maxPeak(page, 100), { timeout: 8_000, intervals: [50] }).toBeLessThan(1e-3);
  }
});

// The two transition patches have no example roll; a held key sounds.
test('plan 28: the transition patches load and sound', async ({ page }) => {
  await startAudio(page);
  await addSynth(page);
  for (const name of ['Noise Sweep', 'Impact']) {
    await page.getByTestId('patch-select').selectOption(name);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as DawWindow).__daw!.project.tracks[1].patchName))
      .toBe(name);
    await expect(page.getByTestId('rack-example')).toHaveCount(0);
    await page.getByTestId('patch-select').blur();
    await page.keyboard.down('KeyA');
    const peak = await maxPeak(page, 600);
    await page.keyboard.up('KeyA');
    expect(peak, `${name} peak`).toBeGreaterThan(0.02);
    await expect.poll(() => maxPeak(page, 100), { timeout: 8_000, intervals: [50] }).toBeLessThan(1e-3);
  }
});
