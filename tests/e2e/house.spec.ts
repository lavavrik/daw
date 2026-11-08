import { expect, test, type Page } from '@playwright/test';

// The menu's contract, in order (app/src/state/patches.ts BUILTIN_GROUPS and
// housePatches.ts HOUSE_GROUPS; app code is not importable here because of
// catalog.json's import attribute, so the lists are spelled out: adding a
// patch means updating this list, as patches.test.ts also pins the names).
const BUILTIN_GROUPS = [
  { label: 'Starter', patches: ['Deep Bass', 'Chord Stab', 'Pad', 'Lead', 'Pluck'] },
  { label: 'House · Leads & Stabs', patches: ['Sax', 'Brass Stab', 'Arp Pluck'] },
  { label: 'House · Keys', patches: ['Tine Keys', 'Piano Stab', 'Garage Organ'] },
  { label: 'House · Bass', patches: ['Organ Bass', 'Reese Bass', 'Acid Line', 'Sub Bass'] },
  { label: 'House · Pads', patches: ['Strings', 'Warm Pad'] },
];

// Plan 11: the patch menu's groups, every built-in patch loading and sounding,
// the Sax's Formant panel, and Save patch refusing a built-in name. Timing-free
// (peaks are polled, not budgeted), so this file runs in the parallel project;
// the four-house-tracks CPU case lives in serial.spec.ts.

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
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

async function addSynth(page: Page) {
  await page.getByTestId('add-synth-track').click();
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByTestId('patch-select')).toBeVisible();
}

/** Max peak (L, R) seen over `ms`, sampled every 4 ms. */
function peaks(page: Page, ms: number) {
  return page.evaluate(
    (ms) =>
      new Promise<[number, number]>((resolve) => {
        const eng = (window as unknown as DawWindow).__daw!.engine!;
        let l = 0;
        let r = 0;
        const t0 = performance.now();
        const id = setInterval(() => {
          const t = eng.telemetry();
          l = Math.max(l, t[5]);
          r = Math.max(r, t[6]);
          if (performance.now() - t0 > ms) {
            clearInterval(id);
            resolve([l, r]);
          }
        }, 4);
      }),
    ms,
  );
}

const status = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as DawWindow).__daw!.engine!;
    return { drop: e.dropouts(), err: e.telemetry()[7] };
  });

test('patch menu groups starter then house', async ({ page }) => {
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

test('every house patch loads and sounds', async ({ page }) => {
  test.setTimeout(90_000);
  await startAudio(page);
  await addSynth(page);
  const house = BUILTIN_GROUPS.slice(1).flatMap((g) => g.patches);
  expect(house).toHaveLength(12);
  const before = await status(page);
  for (const p of house) {
    await page.getByTestId('patch-select').selectOption(p);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as DawWindow).__daw!.project.tracks[1].patchName))
      .toBe(p);
    // A chord (A, D, G = C4, E4, G4) works for mono patches too: last note wins.
    for (const k of ['KeyA', 'KeyD', 'KeyG']) await page.keyboard.down(k);
    const [l, r] = await peaks(page, 700);
    for (const k of ['KeyA', 'KeyD', 'KeyG']) await page.keyboard.up(k);
    expect(l, `${p} peak L`).toBeGreaterThan(0);
    expect(r, `${p} peak R`).toBeGreaterThan(0);
    // Let the release die out (the longest, Garage Organ's, is 0.45 s) before
    // loading the next patch, so the load is not an edit while sounding and
    // the dropout check below does not measure queued-edit bursts.
    await expect
      .poll(async () => Math.max(...(await peaks(page, 100))), { timeout: 5_000, intervals: [50] })
      .toBeLessThan(1e-4);
  }
  const after = await status(page);
  expect(after.err).toBe(before.err);
  expect(after.drop).toBe(before.drop);
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
  await expect(panel.locator(`[data-testid^="knob-${fi}-"]`)).toHaveCount(10);
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
