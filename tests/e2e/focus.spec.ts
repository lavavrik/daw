import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';
import { startApp } from './startApp';

// Pattern focus (plan 20 task 12): the pattern transport plays only the track
// the bottom panel shows (the selected drum / synth track); selecting another
// track while it plays moves the focus there. Which track sounds is read from
// the engine's per-track meters (engine.meters(): peak L, peak R, GR per
// channel, MIX_METER_STRIDE = 3).

type DawWindow = {
  __daw: {
    engine: { meters(): Float32Array } | null;
    project: { tracks: { id: string; slot: number; rows: { id: string; sampleId: number | null }[] }[] };
    actions: {
      addDrumTrack(): { id: string } | null;
      setRowSample(trackId: string, rowId: string, sampleId: number, name: string): void;
      setStep(trackId: string, rowId: string, step: number, vel: number): void;
    };
  };
};

async function startAudio(page: Page) {
  await page.goto('/');
  await startApp(page);
}

/** Dispatch a file drop onto the element with `testid` (see smoke.spec.ts). */
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

/** The loudest meter peak (L or R, linear) of track `slot` over `ms`, sampled every frame. */
function loudest(page: Page, slot: number, ms: number) {
  return page.evaluate(
    ({ slot, ms }) =>
      new Promise<number>((resolve) => {
        const e = (window as unknown as DawWindow).__daw.engine!;
        let max = 0;
        const t0 = performance.now();
        const step = () => {
          const m = e.meters();
          max = Math.max(max, m[slot * 3], m[slot * 3 + 1]);
          if (performance.now() - t0 < ms) requestAnimationFrame(step);
          else resolve(max);
        };
        requestAnimationFrame(step);
      }),
    { slot, ms },
  );
}

test('the pattern transport plays only the selected track; selecting another moves it there', async ({ page }) => {
  await startAudio(page);
  // Drum track A (slot 0): a kick on row 0, four on the floor.
  await dropFile(page, 'row-0', 'kick.wav', 'audio/wav', [...makeWav(60, 120)]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  for (const s of [0, 4, 8, 12]) await page.getByTestId(`step-0-${s}`).click();
  // Drum track B (slot 1): the same kick, same steps.
  await page.evaluate(() => {
    const d = (window as unknown as DawWindow).__daw;
    const a = d.project.tracks[0];
    const b = d.actions.addDrumTrack()!;
    const row = d.project.tracks.find((t) => t.id === b.id)!.rows[0];
    d.actions.setRowSample(b.id, row.id, a.rows[0].sampleId!, 'kick');
    for (const s of [0, 4, 8, 12]) d.actions.setStep(b.id, row.id, s, 127);
  });

  // Play on A: only A is heard.
  await page.getByTestId('track-0').click();
  await expect(page.getByTestId('track-0')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('pattern-play').click();
  await expect.poll(() => loudest(page, 0, 600), { timeout: 4_000 }).toBeGreaterThan(0.05);
  expect(await loudest(page, 1, 1_200)).toBe(0);

  // Select B while it plays: B is heard, A goes silent.
  await page.getByTestId('track-1').click();
  await expect(page.getByTestId('track-1')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => loudest(page, 1, 600), { timeout: 4_000 }).toBeGreaterThan(0.05);
  // No new hits on A (a hit peaks near 0.6, every beat = 484 ms): only the
  // last one's tail, decaying through the strip, is left after 500 ms.
  await page.waitForTimeout(500);
  expect(await loudest(page, 0, 1_200)).toBeLessThan(0.01);
});
