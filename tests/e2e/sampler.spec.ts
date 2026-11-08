import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// "+ Sampler track" (plan 15 Task 4): a sample dropped on the button makes a
// synth track on the Sampler patch named after the file, with the sample on
// its Sample Player; MIDI plays it.

type Daw = {
  engine: { telemetry(): Float32Array } | null;
  project: {
    selectedTrackId: string | null;
    tracks: { id: string; kind: string; name: string; patchName: string }[];
    sampleFiles: Map<number, { name: string }>;
  };
  midi: { inject(b: number[]): void };
};
const daw = (page: Page) => page.evaluate(() => {
  const d = (window as unknown as { __daw: Daw }).__daw.project;
  return { sel: d.selectedTrackId, tracks: d.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, patch: t.patchName })), samples: [...d.sampleFiles.values()].map((f) => f.name) };
});

test('a sample dropped on + Sampler track makes a playable sampler track', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __daw?: { midi?: unknown } }).__daw?.midi);
  await expect(page.getByTestId('add-sampler-track')).toHaveText('+ Sampler track');
  await expect(page.getByTestId('add-sampler-track')).toHaveAttribute('title', 'Add a sampler track: drop a sample here or on its Sample Player');

  const bytes = [...makeWav(220, 600)];
  await page.evaluate((bytes) => {
    const el = document.querySelector('[data-testid="add-sampler-track"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'Bell Tone.wav', { type: 'audio/wav' }));
    for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, bytes);

  await expect.poll(async () => (await daw(page)).tracks.map((t) => t.name)).toContain('Bell Tone');
  const s = await daw(page);
  const t = s.tracks.find((x) => x.name === 'Bell Tone')!;
  expect(t).toMatchObject({ kind: 'synth', patch: 'Sampler' });
  expect(s.sel).toBe(t.id); // selected: its editor (piano roll) shows
  expect(s.samples).toContain('Bell Tone.wav');
  await expect(page.getByRole('button', { name: 'Piano roll' })).toHaveClass(/active/); // its editor shows
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByTestId('patch-select')).toHaveValue('Sampler');

  // The patch menu lists Sampler under its own group.
  const groups = await page.getByTestId('patch-select').evaluate((sel) =>
    [...(sel as HTMLSelectElement).querySelectorAll('optgroup')].map((g) => g.label));
  expect(groups[1]).toBe('Sampler');

  // MIDI sounds: the master peak rises on a note.
  const peak = page.evaluate(() => new Promise<number>((resolve) => {
    const eng = (window as unknown as { __daw: Daw }).__daw.engine!;
    let max = 0;
    const t0 = performance.now();
    const id = setInterval(() => {
      max = Math.max(max, eng.telemetry()[5]);
      if (performance.now() - t0 > 1200) { clearInterval(id); resolve(max); }
    }, 4);
  }));
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.midi.inject([0x90, 60, 100]));
  expect(await peak).toBeGreaterThan(0.02);
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.midi.inject([0x80, 60, 0]));
});
