import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

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

/** Max peakL seen over `ms` (sampled every 4 ms): a short hit is easy to miss with a single read. */
function maxPeak(page: Page, ms = 2000) {
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

/** Dispatch a file drop onto the element with `testid` (bytes passed as a number array). */
async function dropFile(page: Page, testid: string, name: string, type: string, bytes: number[]) {
  await page.evaluate(
    ({ testid, name, type, bytes }) => {
      const el = document.querySelector(`[data-testid="${testid}"]`)!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
      for (const t of ['dragenter', 'dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    { testid, name, type, bytes },
  );
}

async function loadKickOnRow0(page: Page) {
  await dropFile(page, 'row-0', 'kick.wav', 'audio/wav', [...makeWav()]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
}

test('drop sample, program steps, hear it', async ({ page }) => {
  await startAudio(page);
  await loadKickOnRow0(page);
  for (const s of [0, 4, 8, 12]) await page.getByTestId(`step-0-${s}`).click();
  await page.keyboard.press('Space');
  expect(await maxPeak(page)).toBeGreaterThan(0.1); // peakL
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        const cls = await page.locator('[data-testid^="step-0-"].playhead').first().getAttribute('data-testid');
        if (cls) seen.add(cls);
        return seen.size;
      },
      { timeout: 4_000 },
    )
    .toBeGreaterThan(1);
  await page.screenshot({
    path: '.superpowers/sdd/2026-11-06-plan-1-engine-and-step-grid/task-12-screenshot.png',
  });
});

test('bad file drop shows error', async ({ page }) => {
  await startAudio(page);
  await loadKickOnRow0(page);
  await page.getByTestId('step-0-0').click();
  await dropFile(page, 'row-1', 'notes.txt', 'text/plain', [...Buffer.from('hello')]);
  await expect(page.getByTestId('banner')).toContainText('Couldn\'t load "notes.txt"');
  await expect(page.getByTestId('row-1').getByTestId('row-name')).toHaveText('drop sample');
  await page.keyboard.press('Space');
  expect(await maxPeak(page)).toBeGreaterThan(0);
});
