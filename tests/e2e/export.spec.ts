import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// Project ▸ Export WAV… end to end: the real render Worker running
// engine.wasm. showSaveFilePicker is replaced (before the app loads) by a
// fake whose writable keeps the written Blob in window.__exported, so the
// test can decode it in the page with decodeAudioData.

type Daw = {
  engine: { sampleRate: number } | null;
  project: { tempo: number; tracks: { id: string; rows?: { id: string }[] }[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, (...args: any[]) => any>;
};
type Win = { __daw: Daw; __exported: Blob | null; __picks: string[] };

const EMPTY = 'Nothing to export — the song has no clips. Add clips to the timeline in Song mode first.';

async function fakeSavePicker(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Win & { showSaveFilePicker: unknown };
    w.__exported = null;
    w.__picks = [];
    w.showSaveFilePicker = async (o: { suggestedName: string }) => {
      w.__picks.push(o.suggestedName);
      return {
        name: o.suggestedName,
        createWritable: async () => ({
          write: async (b: Blob) => void (w.__exported = b),
          close: async () => {},
        }),
        getFile: async () => ({ size: w.__exported?.size ?? 0 }),
      };
    };
  });
}

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

/** Kick on row 0 (four on the floor) and one 1-bar clip of it at 0; the metronome on (the export ignores it). */
async function oneBarSong(page: Page) {
  await page.evaluate((bytes) => {
    const el = document.querySelector('[data-testid="row-0"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'kick.wav', { type: 'audio/wav' }));
    for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [...makeWav(80, 120)]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as Win).__daw;
    const d = project.tracks[0];
    for (const s of [0, 4, 8, 12]) a.setStep(d.id, d.rows![0].id, s, 120);
    a.addClip(d.id, { start: 0 }); // the pattern's length: 1 bar
  });
  await page.getByRole('button', { name: 'Metronome' }).click();
}

async function exportFromMenu(page: Page) {
  await page.getByTestId('project-menu').click();
  await page.getByTestId('project-export').click();
}

const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

test('export produces a non-silent WAV of the right length', async ({ page }) => {
  await fakeSavePicker(page);
  await startAudio(page);
  await oneBarSong(page);
  await exportFromMenu(page);
  await expect(page.getByTestId('notice')).toContainText(`Exported "Untitled ${today()}.wav"`, { timeout: 20_000 });
  await expect(page.getByTestId('export-progress')).toBeHidden();

  const r = await page.evaluate(async () => {
    const w = window as unknown as Win;
    const sr = w.__daw.engine!.sampleRate;
    const bytes = await w.__exported!.arrayBuffer();
    const buf = await new OfflineAudioContext(2, 1, sr).decodeAudioData(bytes.slice(0));
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) for (const x of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
    const bits = new DataView(bytes).getUint16(34, true);
    // 1 bar = 4 beats at the project tempo, plus the 2 s tail.
    const want = Math.round(4 * (60 / w.__daw.project.tempo) * sr) + 2 * sr;
    return { length: buf.length, want, channels: buf.numberOfChannels, peak, bits, picks: w.__picks };
  });
  expect(r.picks).toEqual([`Untitled ${today()}.wav`]);
  expect(r.bits).toBe(24);
  expect(r.channels).toBe(2);
  expect(r.length).toBe(r.want);
  expect(r.peak).toBeGreaterThan(0.05);
  // The live engine was never touched: the transport is still stopped and alive.
  await expect(page.getByTestId('play')).toHaveText('▶ Play');
  await expect(page.getByTestId('engine-error')).toHaveCount(0);
});

test('empty song shows message', async ({ page }) => {
  await fakeSavePicker(page);
  await startAudio(page);
  await exportFromMenu(page); // a drum track, but no clips
  await expect(page.getByTestId('banner')).toContainText(EMPTY);
  expect(await page.evaluate(() => (window as unknown as Win).__picks)).toEqual([]); // no file created
});

test('without a save picker the export is a download link', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await startAudio(page);
  await oneBarSong(page);
  await exportFromMenu(page);
  const link = page.getByTestId('export-download-link');
  await expect(link).toBeVisible({ timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe(`Untitled ${today()}.wav`);
});
