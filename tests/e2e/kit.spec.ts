import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';
import { openMore } from './topbar';

// The built-in starter kit (plan 8 Task 4): a fresh session — first start
// and Project ▸ New — starts with the default drum track filled from the
// bundled kit, untouched ("unsaved" off, nothing to undo); the Browser always
// shows the kit as its own section, beside a library folder.

type Daw = {
  engine: { telemetry(): Float32Array } | null;
  project: {
    dirty: boolean;
    version: number;
    sampleFiles: Map<number, { name: string; bytes: ArrayBuffer }>;
    tracks: { kind: string; rows?: { name: string; sampleId: number | null }[] }[];
  };
  history: { labels: { undo: string | null; redo: string | null } } | null;
  library: { attach(dir: FileSystemDirectoryHandle): Promise<void> };
};

const KIT = ['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc'];
const FILES = ['kick-punch.wav', 'clap.wav', 'hat-closed.wav', 'hat-open.wav', 'snare.wav', 'rim.wav', 'shaker.wav', 'perc-tom.wav'];

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

/** The default drum track holds the eight kit rows, each with its kit sample (original bytes kept). */
async function expectKit(page: Page) {
  for (const [i, name] of KIT.entries()) await expect(page.getByTestId(`row-${i}`).getByTestId('row-name')).toHaveText(name);
  await expect(page.getByTestId('row-8')).toHaveCount(0);
  const kept = await page.evaluate(() => {
    const p = (window as unknown as { __daw: Daw }).__daw.project;
    return p.tracks[0].rows!.map((r) => {
      const f = p.sampleFiles.get(r.sampleId!);
      return f ? [f.name, f.bytes.byteLength > 1000] : null;
    });
  });
  expect(kept).toEqual(FILES.map((f) => [f, true]));
  // A starting point, not an edit: nothing unsaved, nothing to undo.
  await expect(page.getByTestId('project-name')).toHaveText('Untitled');
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.dirty)).toBe(false);
  await expect(page.getByTestId('undo')).toBeDisabled();
}

/** Max peakL seen over `ms`. */
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

/** Tap Kick on the downbeat, play: the kit sounds. */
async function expectKickPlays(page: Page) {
  await page.getByTestId('step-0-0').click();
  await page.keyboard.press('Space');
  expect(await maxPeak(page)).toBeGreaterThan(0.05);
  await page.keyboard.press('Space');
}

test('a fresh start has the playable starter kit', async ({ page }) => {
  test.setTimeout(30_000);
  await startAudio(page);
  await expectKit(page);
  // Not an edit: no version bump, so the autosave has nothing to write (and
  // the next start offers no "Restore last session" for an untouched kit).
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.version)).toBe(0);
  await expectKickPlays(page);
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo /); // the tap is the first edit
});

test('Project ▸ New starts from the kit again', async ({ page }) => {
  test.setTimeout(30_000);
  await startAudio(page);
  await expectKit(page);
  await page.getByTestId('step-0-4').click(); // an edit, so New asks first
  await openMore(page);
  await page.getByTestId('project-new').click();
  await page.getByTestId('project-discard').click();
  await expectKit(page);
  // The kit samples of the old session were dropped; the new ones are fresh ids.
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.length)).toBe(1);
  await expectKickPlays(page);
});

test('clicking a row name previews its sample in the shared preview bar', async ({ page }) => {
  await startAudio(page);
  await expectKit(page);
  const name = page.getByTestId('row-0').getByTestId('row-name');
  await expect(name).toHaveText('Kick');
  await name.click();
  await expect(name).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('preview-bar')).toContainText('Kick');
  await expect(page.getByTestId('preview-stop')).toBeEnabled();
  // Previewing is not an edit: no undo entry, no unsaved mark.
  await expect(page.getByTestId('undo')).toBeDisabled();
  // Click again stops it.
  await name.click();
  await expect(name).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('preview-stop')).toBeDisabled();
});

test('the Browser always shows the starter kit, beside a library folder', async ({ page }) => {
  test.setTimeout(30_000);
  await startAudio(page);
  const kit = page.getByTestId('starter-kit');
  await expect(kit).toBeVisible(); // no folder chosen yet
  await expect(page.getByTestId('library-choose')).toBeVisible();

  const name = `e2e-kit-${test.info().workerIndex}`;
  await page.evaluate(async ({ name, bytes }) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name, { recursive: true }).catch(() => {});
    const lib = await root.getDirectoryHandle(name, { create: true });
    const w = await (await lib.getFileHandle('bass.wav', { create: true })).createWritable();
    await w.write(new Uint8Array(bytes));
    await w.close();
    await (window as unknown as { __daw: Daw }).__daw.library.attach(lib);
  }, { name, bytes: [...makeWav(55, 200)] });
  await expect(page.getByTestId('library-name')).toHaveText(name);
  await expect(page.getByTestId('lib-sample-bass.wav')).toBeVisible();
  await expect(kit).toBeVisible();
  await expect(page.getByTestId('kit-sample-kick-deep.wav')).toBeVisible();
  await expect(page.getByTestId('kit-sample-stab-cm9.wav')).toBeVisible();

  // Preview (one at a time, never in the project). The preview bar is always
  // there, so starting/stopping a preview never moves the list under it.
  const y = async () => (await page.getByTestId('kit-sample-kick-deep.wav').boundingBox())!.y;
  await expect(page.getByTestId('preview-bar')).toBeVisible();
  const before = await y();
  await page.getByTestId('kit-sample-kick-deep.wav').click();
  await expect(page.getByTestId('preview-stop')).toBeEnabled();
  expect(await y()).toBe(before);
  await page.getByTestId('preview-stop').click();
  await expect(page.getByTestId('preview-stop')).toBeDisabled();
  expect(await y()).toBe(before);

  // Drag onto "+ Add row": a ninth row with that sample, its bytes kept for Save.
  await expectKit(page);
  await page.evaluate(() => {
    const src = document.querySelector('[data-testid="kit-sample-kick-deep.wav"]')!;
    const dst = document.querySelector('[data-testid="add-row"]')!;
    const dt = new DataTransfer();
    const ev = (el: Element, t: string) => el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    ev(src, 'dragstart');
    for (const t of ['dragenter', 'dragover', 'drop']) ev(dst, t);
    ev(src, 'dragend');
  });
  await expect(page.getByTestId('row-8').getByTestId('row-name')).toHaveText('kick-deep');
  await expect(page.getByTestId('project-name')).toContainText('● unsaved'); // that one is an edit
  await expect(page.getByTestId('banner')).toBeHidden();
  await page.screenshot({ path: 'test-results/browser-kit.png' });

  // Collapsible.
  await page.getByTestId('starter-kit-toggle').click();
  await expect(page.getByTestId('kit-sample-kick-deep.wav')).toBeHidden();
  await page.getByTestId('starter-kit-toggle').click();
  await expect(page.getByTestId('kit-sample-kick-deep.wav')).toBeVisible();

  await page.evaluate(async (name) => {
    await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }).catch(() => {});
    await new Promise((r) => {
      const req = indexedDB.deleteDatabase('daw-library');
      req.onsuccess = req.onerror = req.onblocked = r;
    });
  }, name);
});

test('Project ▸ New deletes the old autosave and never autosaves the untouched kit session (final I1)', async ({ page }) => {
  test.setTimeout(45_000);
  type A = { autosave: { lastSaved: number | null; flush(): Promise<void> } };
  const hasAutosave = () =>
    page.evaluate(async () => (await navigator.storage.getDirectory()).getDirectoryHandle('autosave').then(() => true, () => false));
  await startAudio(page);
  await expectKit(page);
  await page.getByTestId('step-0-4').click(); // an edit: the old session autosaves
  await expect
    .poll(() => page.evaluate(async () => {
      const a = (window as unknown as { __daw: A }).__daw.autosave;
      await a.flush();
      return a.lastSaved;
    }), { timeout: 15_000 })
    .not.toBeNull();
  expect(await hasAutosave()).toBe(true);
  await openMore(page);
  await page.getByTestId('project-new').click();
  await page.getByTestId('project-discard').click();
  await expectKit(page);
  await expect.poll(hasAutosave).toBe(false); // the discarded session's autosave is deleted
  await page.waitForTimeout(6000); // past the 5 s autosave debounce: nothing is written
  expect(await hasAutosave()).toBe(false);
  await startAudio(page); // reload
  await page.waitForTimeout(300);
  await expect(page.getByTestId('restore')).toBeHidden();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const n of ['autosave', 'autosave.tmp']) await root.removeEntry(n, { recursive: true }).catch(() => {});
    localStorage.removeItem('daw.lastExplicitSave');
  });
});

test('a selected drum track plays its rows from the MIDI keyboard', async ({ page }) => {
  // Plan 15: MIDI note 36 + r triggers row r of the drum input track, live
  // (no transport), through the injected-MIDI hook (window.__daw.midi).
  test.setTimeout(30_000);
  type M = { midi?: { inject(bytes: number[]): void } };
  await startAudio(page);
  await expectKit(page);
  await page.waitForFunction(() => !!(window as unknown as { __daw: M }).__daw?.midi);
  // A synth takes the keys when added; selecting the drum track moves them.
  await page.getByTestId('add-synth-track').click();
  await expect(page.getByTestId('keys-target')).not.toContainText('Drums');
  await page.getByTestId('track-0').click();
  await expect(page.getByTestId('keys-target')).toContainText('Drums');
  /** Inject `bytes`, then the max master peak over `ms`. */
  const peakAfter = (bytes: number[], ms = 600) =>
    page.evaluate(
      ([bytes, ms]) =>
        new Promise<number>((resolve) => {
          const w = window as unknown as { __daw: Daw & M };
          const eng = w.__daw.engine!;
          w.__daw.midi!.inject(bytes as number[]);
          let max = 0;
          const t0 = performance.now();
          const id = setInterval(() => {
            max = Math.max(max, eng.telemetry()[5]);
            if (performance.now() - t0 > (ms as number)) {
              clearInterval(id);
              resolve(max);
            }
          }, 4);
        }),
      [bytes, ms] as const,
    );
  expect(await maxPeak(page, 300)).toBeLessThan(0.01); // stopped, nothing held
  expect(await peakAfter([0x90, 35, 127])).toBeLessThan(0.01); // below row 1: ignored
  expect(await peakAfter([0x90, 36, 127])).toBeGreaterThan(0.05); // C2: the Kick row
  await peakAfter([0x80, 36, 0], 400); // NoteOff: nothing to release (one-shots)
  expect(await peakAfter([0x90, 36, 100])).toBeGreaterThan(0.05); // ... and the row hits again after it
  expect(await maxPeak(page, 300)).toBeLessThan(0.01); // a one-shot: nothing stuck
});

test('a selected drum track plays its rows from the computer keyboard and records hits into steps', async ({ page }) => {
  // Plan 15 ruling G: on a drum input track the octave's C key (KeyA) is row
  // 1 (note 36), the keys up from it rows 2..15, at any octave. Armed and
  // playing, a hit sets the nearest step of its row; Undo take removes it.
  test.setTimeout(30_000);
  type P = { tracks: { patterns: { id: string; steps: number[][] }[]; currentPatternId: string }[] };
  const steps = () =>
    page.evaluate(() => {
      const t = ((window as unknown as { __daw: { project: P } }).__daw.project).tracks[0];
      return t.patterns.find((x) => x.id === t.currentPatternId)!.steps.map((r) => r.filter((v) => v > 0).length);
    });
  await startAudio(page);
  await expectKit(page);
  await page.getByTestId('add-synth-track').click();
  await page.getByTestId('track-0').click();
  await expect(page.getByTestId('keys-target')).toContainText('Drums');
  expect(await maxPeak(page, 300)).toBeLessThan(0.01);
  const peak = maxPeak(page, 600);
  await page.keyboard.down('KeyA'); // row 1: the Kick
  await page.keyboard.up('KeyA');
  expect(await peak).toBeGreaterThan(0.05);
  expect(await maxPeak(page, 600)).toBeLessThan(0.01); // rang out, nothing stuck
  const silent = maxPeak(page, 400);
  await page.keyboard.down('KeyK'); // row 13: the kit has 8 rows, ignored
  await page.keyboard.up('KeyK');
  expect(await silent).toBeLessThan(0.01);
  // Record: arm (R), play (the pattern transport), hit the Clap (KeyW = row 2), stop.
  expect((await steps()).every((n) => n === 0)).toBe(true); // the kit starts empty
  await page.keyboard.press('KeyR');
  await page.getByTestId('pattern-play').click();
  await expect(page.getByTestId('rec-button')).toContainText('REC');
  await page.keyboard.down('KeyW');
  await page.keyboard.up('KeyW');
  await page.getByTestId('pattern-stop').click();
  const after = await steps();
  expect(after[1]).toBe(1);
  expect(after.reduce((a, b) => a + b, 0)).toBe(1);
  await expect(page.getByTestId('undo-take')).toBeEnabled();
  await openMore(page);
  await page.getByTestId('undo-take').click();
  expect((await steps()).every((n) => n === 0)).toBe(true);
});
