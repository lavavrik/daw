import { expect, test, type Page } from '@playwright/test';

// Minimal shape of what App.svelte exposes on window for tests.
type DawWindow = {
  __daw?: {
    engine: {
      telemetry(): Float64Array;
      send(op: number, a?: number, b?: number, c?: number, d?: number): boolean;
      loadSample(id: number, channels: Float32Array[]): Promise<number>;
      dropouts(): number;
    } | null;
    Op: Record<string, number>;
  };
};

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

/** Reads telemetry slot `i` from the live engine (NaN until started). */
function slot(page: Page, i: number) {
  return () =>
    page.evaluate((i) => {
      const daw = (window as unknown as DawWindow).__daw;
      return daw?.engine ? daw.engine.telemetry()[i] : NaN;
    }, i);
}

test('cross-origin isolated', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test('engine renders', async ({ page }) => {
  await startAudio(page);
  await expect.poll(slot(page, 0), { timeout: 5_000 }).toBeGreaterThan(100); // blocks
});

test('test tone sounds', async ({ page }) => {
  await startAudio(page);
  const sent = await page.evaluate(() => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    return engine!.send(Op.NOTE_ON, 69, 127);
  });
  expect(sent).toBe(true);
  await expect.poll(slot(page, 5), { timeout: 5_000 }).toBeGreaterThan(0.05); // peakL
});

test('sample upload round-trips through the worklet', async ({ page }) => {
  await startAudio(page);
  const codes = await page.evaluate(async () => {
    const { engine } = (window as unknown as DawWindow).__daw!;
    const ch = new Float32Array(4800).fill(0.5);
    return [
      await engine!.loadSample(0, [ch, ch]), // stopped: alloc may grow, OK
      await engine!.loadSample(1_000_000, [ch]), // id out of range
      await engine!.loadSample(1, []), // no channels
      engine!.dropouts(),
    ];
  });
  expect(codes.slice(0, 3)).toEqual([0, -2, -3]); // Err.OK, BAD_INDEX, BAD_VALUE
  expect(typeof codes[3]).toBe('number');
});

test('oversized sample defers while playing, loads after stop (memory grows)', async ({ page }) => {
  await startAudio(page);
  await page.evaluate(() => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    engine!.send(Op.PLAY);
  });
  await expect.poll(slot(page, 1)).toBe(1); // playing
  const result = await page.evaluate(async () => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    const e = engine! as typeof engine & { onSampleLoaded?: (id: number) => void };
    const loaded = new Promise<number>((r) => (e.onSampleLoaded = r));
    // Larger than the pre-reserved 32 Mi-float arena: cannot fit while playing.
    const first = await e.loadSample(3, [new Float32Array(33 * 1024 * 1024)]);
    e.send(Op.STOP);
    return { first, loadedId: await loaded };
  });
  expect(result).toEqual({ first: -4, loadedId: 3 }); // Err.DEFERRED, then loaded
  // Audio keeps running after the heap grew (views were rebuilt, no trap).
  const blocks = await slot(page, 0)();
  await expect.poll(slot(page, 0)).toBeGreaterThan(blocks + 10);
});

test('space toggles transport and keyboard plays', async ({ page }) => {
  await startAudio(page);
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(1); // playing
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(0);
  await page.keyboard.down('KeyH'); // A4
  await expect.poll(slot(page, 5), { timeout: 5_000 }).toBeGreaterThan(0.05); // peakL
  await page.keyboard.up('KeyH');
});
