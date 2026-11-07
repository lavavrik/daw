import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// Project save/load through OPFS (an origin-private folder: no picker). The
// app's debug hooks __daw.saveTo(handle) / __daw.openFrom(handle) run the
// same code as Project ▸ Save / Open with a FileSystemDirectoryHandle.

type Daw = {
  engine: { telemetry(): Float64Array; meters(): Float32Array } | null;
  project: {
    name: string;
    dirty: boolean;
    playing: boolean;
    tracks: { id: string; slot: number; kind: string; name: string; rows?: { id: string; name: string; sampleId: number | null }[]; patterns: { notes?: unknown[] }[] }[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, (...args: any[]) => any>;
  saveTo(dir: FileSystemDirectoryHandle): Promise<void>;
  openFrom(dir: FileSystemDirectoryHandle): Promise<string[]>;
};
const daw = () => (window as unknown as { __daw: Daw }).__daw;

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

async function dropFiles(page: Page, testid: string, files: { name: string; bytes: number[] }[]) {
  await page.evaluate(
    ({ testid, files }) => {
      const el = document.querySelector(`[data-testid="${testid}"]`)!;
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'audio/wav' }));
      for (const t of ['dragenter', 'dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    { testid, files },
  );
}

/** Kick sample on row 0 (four on the floor) + a Chord Stab track with a held chord. */
async function makeBeat(page: Page) {
  await dropFiles(page, 'row-0', [{ name: 'kick.wav', bytes: [...makeWav(80, 120)] }]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as { __daw: Daw }).__daw;
    const d = project.tracks[0];
    for (const s of [0, 4, 8, 12]) a.setStep(d.id, d.rows![0].id, s, 120);
    const synth = a.addSynthTrack('Chord Stab');
    for (const pitch of [48, 52, 55]) a.addNote(synth.id, { pitch, start: 0, len: 15360, vel: 100 });
    a.addNote(synth.id, { pitch: 60, start: 1920, len: 480, vel: 100 });
  });
}

/** Max meter peak per strip (track slots) over `ms` of playback. */
function stripPeaks(page: Page, slots: number[], ms: number) {
  return page.evaluate(
    ({ slots, ms }) =>
      new Promise<number[]>((resolve) => {
        const eng = (window as unknown as { __daw: Daw }).__daw.engine!;
        const peak = slots.map(() => 0);
        const id = setInterval(() => {
          const m = eng.meters();
          slots.forEach((s, i) => (peak[i] = Math.max(peak[i], m[s * 3], m[s * 3 + 1])));
        }, 20);
        setTimeout(() => (clearInterval(id), resolve(peak)), ms);
      }),
    { slots, ms },
  );
}

/** A fresh OPFS folder for this test. */
async function opfsDir(page: Page, name: string) {
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name, { recursive: true }).catch(() => {});
    await root.getDirectoryHandle(name, { create: true });
  }, name);
}

const summary = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __daw: Daw }).__daw.project.tracks.map((t) => ({
      kind: t.kind,
      name: t.name,
      rows: t.rows?.map((r) => r.name),
      notes: t.patterns.map((p) => p.notes?.length ?? 0),
    })),
  );

test('save then load reproduces the beat', async ({ page }) => {
  test.setTimeout(60_000);
  await startAudio(page);
  await makeBeat(page);
  await expect(page.getByTestId('project-name')).toContainText('unsaved');
  await page.keyboard.press('Space');
  const before = await stripPeaks(page, [0, 1], 2000);
  await page.keyboard.press('Space');
  expect(before[0]).toBeGreaterThan(0.01);
  expect(before[1]).toBeGreaterThan(0.01);
  const want = await summary(page);

  const dirName = `e2e-save-${test.info().workerIndex}`;
  await opfsDir(page, dirName);
  await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    await (window as unknown as { __daw: Daw }).__daw.saveTo(dir);
  }, dirName);
  await expect(page.getByTestId('project-name')).not.toContainText('unsaved');
  const listing = await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    const s = await dir.getDirectoryHandle('samples');
    const names: string[] = [];
    for await (const [k] of s.entries()) names.push(k);
    const json = JSON.parse(await (await (await dir.getFileHandle('project.json')).getFile()).text());
    return { names, version: json.schemaVersion, tmp: await dir.getFileHandle('project.json.tmp').then(() => true, () => false) };
  }, dirName);
  expect(listing).toMatchObject({ version: 1, tmp: false });
  expect(listing.names).toHaveLength(1);
  expect(listing.names[0]).toMatch(/^0-[0-9a-f]{8}-kick\.wav$/); // <id>-<content hash>-<name>

  // A new session: reload, start audio, open the folder.
  await startAudio(page);
  const warnings = await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    return (window as unknown as { __daw: Daw }).__daw.openFrom(dir);
  }, dirName);
  expect(warnings).toEqual([]);
  expect(await summary(page)).toEqual(want);
  await expect(page.getByTestId('project-name')).not.toContainText('unsaved');
  await page.keyboard.press('Space');
  const after = await stripPeaks(page, [0, 1], 2000);
  await page.keyboard.press('Space');
  expect(after[0]).toBeGreaterThan(0.01);
  expect(after[1]).toBeGreaterThan(0.01);
  await expect(page.getByTestId('banner')).toBeHidden();
});

test('load while playing stops cleanly (no stuck notes)', async ({ page }) => {
  test.setTimeout(60_000);
  await startAudio(page);
  await makeBeat(page);
  const dirName = `e2e-playing-${test.info().workerIndex}`;
  await opfsDir(page, dirName);
  await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    await (window as unknown as { __daw: Daw }).__daw.saveTo(dir);
  }, dirName);
  await page.keyboard.press('Space');
  expect((await stripPeaks(page, [1], 1000))[0]).toBeGreaterThan(0.01); // the chord is sounding
  const result = await page.evaluate(async (n) => {
    const d = (window as unknown as { __daw: Daw }).__daw;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    const warnings = await d.openFrom(dir);
    // From the end of the load: the output must fall below 0.001 within 1 s.
    const t0 = performance.now();
    return new Promise<{ warnings: string[]; ms: number; playing: boolean; engPlaying: number }>((resolve) => {
      const id = setInterval(() => {
        const t = d.engine!.telemetry();
        const ms = performance.now() - t0;
        if ((t[5] < 0.001 && t[6] < 0.001) || ms > 1000) {
          clearInterval(id);
          resolve({ warnings, ms, playing: d.project.playing, engPlaying: t[1] });
        }
      }, 10);
    });
  }, dirName);
  expect(result.warnings).toEqual([]);
  expect(result.ms).toBeLessThan(1000);
  expect(result.playing).toBe(false);
  expect(result.engPlaying).toBe(0);
  // Still silent a moment later (nothing restarted, no hanging voice).
  await page.waitForTimeout(500);
  const peak = await page.evaluate(() => {
    const t = (window as unknown as { __daw: Daw }).__daw.engine!.telemetry();
    return Math.max(t[5], t[6]);
  });
  expect(peak).toBeLessThan(0.001);
  await expect(page.getByTestId('play')).toHaveText(/Play/);
});

test('dropping several files on "+ Add row" adds one row per file', async ({ page }) => {
  await startAudio(page);
  await dropFiles(page, 'add-row', [
    { name: 'a.wav', bytes: [...makeWav(100)] },
    { name: 'b.wav', bytes: [...makeWav(200)] },
    { name: 'c.wav', bytes: [...makeWav(300)] },
  ]);
  await expect(page.getByTestId('row-6').getByTestId('row-name')).toHaveText('c');
  await expect(page.getByTestId('row-4').getByTestId('row-name')).toHaveText('a');
  await expect(page.getByTestId('row-5').getByTestId('row-name')).toHaveText('b');
});

test('Project menu: New asks inline before discarding unsaved changes', async ({ page }) => {
  await startAudio(page);
  await expect(page.getByTestId('project-name')).toHaveText('Untitled');
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.addSynthTrack('Lead'));
  await expect(page.getByTestId('project-name')).toContainText('● unsaved');
  await page.getByTestId('project-menu').click();
  await page.getByTestId('project-new').click();
  await expect(page.getByTestId('project-discard')).toBeVisible();
  await page.getByTestId('project-discard').click();
  await expect(page.getByTestId('project-name')).toHaveText('Untitled');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.map((t) => t.kind))).toEqual(['drum']);
});
