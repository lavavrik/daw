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

// The Sample Player panel shows its sample (plan 15 Task 5): a 220×48
// waveform strip with Start / End / Loop start handles (drag or arrow
// keys; a drag is one undo entry), Root reads as a note name, and
// "Root ← last note" takes the last live note.
test('the Sample Player strip shows the sample and its handles edit start / end / root', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __daw?: { midi?: unknown } }).__daw?.midi);

  const bytes = [...makeWav(220, 600)];
  await page.evaluate((bytes) => {
    const el = document.querySelector('[data-testid="add-sampler-track"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'Strip Tone.wav', { type: 'audio/wav' }));
    for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, bytes);
  await expect.poll(async () => (await daw(page)).tracks.map((t) => t.name)).toContain('Strip Tone');
  await page.getByRole('button', { name: 'Instrument' }).click();

  // Sample Player params of the new track (module idx 1 in the Sampler patch).
  const sp = () => page.evaluate(() => {
    const d = (window as unknown as { __daw: { project: { tracks: { name: string; modules?: { idx: number; params: number[] }[] }[] } } }).__daw.project;
    return d.tracks.find((t) => t.name === 'Strip Tone')!.modules!.find((m) => m.idx === 1)!.params;
  });
  const strip = page.getByTestId('sample-strip-1');
  await expect(strip).toBeVisible();
  const box = (await strip.boundingBox())!;
  expect(Math.round(box.width)).toBe(220);
  expect(Math.round(box.height)).toBe(48);
  await expect(strip.locator('canvas')).toHaveAttribute('data-draw', 'peaks'); // the waveform, not the empty state
  await expect(strip).not.toContainText('Drop a sample here');
  await expect(strip.getByRole('slider', { name: 'Start' })).toBeVisible();
  await expect(strip.getByRole('slider', { name: 'Loop start' })).toHaveCount(0); // loop is off

  // Drag End left by ~a quarter: `end` drops from 1, one undo puts it back.
  expect((await sp())[5]).toBe(1);
  const end = strip.getByRole('slider', { name: 'End' });
  const eb = (await end.boundingBox())!;
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(eb.x + eb.width / 2 - i * 11, eb.y + eb.height / 2);
  await page.mouse.up();
  await expect.poll(async () => (await sp())[5]).toBeCloseTo(0.75, 1);
  await expect(end).toHaveAttribute('aria-valuenow', /^0\.7/);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await sp())[5]).toBe(1);

  // Arrow keys on a focused handle: ±0.01 (Shift ±0.001).
  await strip.getByRole('slider', { name: 'Start' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await sp())[2]).toBeCloseTo(0.01, 5);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => (await sp())[2]).toBeCloseTo(0.009, 5);

  // Loop on: the Loop start handle appears.
  await page.getByTestId('knob-1-loop').getByRole('radio', { name: 'On' }).click();
  await expect(strip.getByRole('slider', { name: 'Loop start' })).toBeVisible();

  // Root reads as a note; "Root ← last note" waits for a live note, then takes it.
  await expect(page.getByTestId('knob-1-root').getByTestId('knob-readout')).toHaveText('C4');
  const fromLast = page.getByTestId('root-from-last-1');
  await expect(fromLast).toBeDisabled();
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.midi.inject([0x90, 64, 100]));
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.midi.inject([0x80, 64, 0]));
  await expect(fromLast).toBeEnabled();
  await fromLast.click();
  await expect.poll(async () => (await sp())[4]).toBe(64);
  await expect(page.getByTestId('knob-1-root').getByTestId('knob-readout')).toHaveText('E4');
});
