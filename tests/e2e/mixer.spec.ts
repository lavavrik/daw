import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// Mixer view (plan 5, Task 4), driven through the UI. Meter values are read
// from the strip meters' data-peak-db (what the user sees, updated by the
// mixer's rAF loop) and, for the plumbing check, from engine.meters().

type DawWindow = {
  __daw?: {
    engine: { telemetry(): Float64Array; meters(): Float32Array } | null;
  };
};

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
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

/** Kick sample on row 0 of the default drum track, four on the floor. */
async function fourOnTheFloor(page: Page) {
  await dropFile(page, 'row-0', 'kick.wav', 'audio/wav', [...makeWav(60, 120)]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  for (const s of [0, 4, 8, 12]) await page.getByTestId(`step-0-${s}`).click();
}

const strip = (page: Page, id: string | number) => page.getByTestId(`strip-${id}`);

/** The strip meter's shown peak, dBFS (−Infinity when silent). */
async function meterDb(page: Page, id: string | number): Promise<number> {
  const v = await strip(page, id).getByTestId('meter').getAttribute('data-peak-db');
  return v === null || v === '-inf' ? -Infinity : Number(v);
}

/** Sample a strip meter's shown peak at every animation frame for `ms`; min/max in dB. */
function meterRange(page: Page, testid: string, ms: number) {
  return page.evaluate(
    ({ testid, ms }) =>
      new Promise<{ min: number; max: number; n: number }>((resolve) => {
        const el = document.querySelector(`[data-testid="${testid}"] [data-testid="meter"]`) as HTMLElement;
        let min = Infinity;
        let max = -Infinity;
        let n = 0;
        const t0 = performance.now();
        const step = () => {
          const s = el.dataset.peakDb ?? '-inf';
          const db = s === '-inf' ? -200 : Number(s);
          min = Math.min(min, db);
          max = Math.max(max, db);
          n++;
          if (performance.now() - t0 < ms) requestAnimationFrame(step);
          else resolve({ min, max, n });
        };
        requestAnimationFrame(step);
      }),
    { testid, ms },
  );
}

async function openMixer(page: Page) {
  await page.getByTestId('mixer-tab').click();
  await expect(page.getByTestId('mixer')).toBeVisible();
}

/** Add a synth track (slot 1) and hold a note on it from the computer keyboard. */
async function synthHoldingNote(page: Page) {
  await page.getByTestId('add-synth-track').click();
  await expect(page.getByTestId('track-1')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down('KeyA');
}

test('mixer shows strips for tracks + returns + master', async ({ page }) => {
  await startAudio(page);
  await page.getByTestId('add-synth-track').click();
  await openMixer(page);
  const ids = await page.locator('[data-testid="mixer"] > [data-testid^="strip-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid')),
  );
  expect(ids).toEqual(['strip-0', 'strip-1', 'strip-reverb', 'strip-delay', 'strip-master']);
  await expect(strip(page, 0).getByTestId('strip-name')).toContainText('Drums');
  await expect(strip(page, 1).getByTestId('strip-name')).toContainText('Synth');
  await expect(strip(page, 'reverb').getByTestId('strip-name')).toContainText('Reverb');
  await expect(strip(page, 'delay').getByTestId('strip-name')).toContainText('Delay');
  await expect(strip(page, 'master').getByTestId('strip-name')).toContainText('Master');
  // Values are visible: fader readouts, sends labelled by return, SC source, limiter.
  await expect(strip(page, 0).getByTestId('fader-readout')).toHaveText('0.0 dB');
  await expect(strip(page, 1).getByTestId('knob-send_a')).toContainText('Reverb');
  await expect(strip(page, 1).getByTestId('knob-send_a')).toContainText('Off');
  await expect(strip(page, 1).getByTestId('knob-send_b')).toContainText('Delay');
  await expect(strip(page, 1).getByTestId('knob-pan')).toContainText('C');
  await expect(strip(page, 1).getByTestId('sc-label')).toHaveText('SC: none');
  await expect(strip(page, 'master').getByTestId('knob-limiter_ceiling')).toContainText('−0.3 dB');
  await expect(strip(page, 'master').getByTestId('gr')).toHaveText('0.0 dB');
  // Returns have no solo; the master has neither mute nor solo.
  await expect(strip(page, 'reverb').getByTestId('solo')).toHaveCount(0);
  await expect(strip(page, 'master').getByTestId('mute')).toHaveCount(0);
  // EQ and Comp are collapsed, their on/off switch visible in the header.
  await expect(strip(page, 1).getByTestId('knob-eq_low')).toHaveCount(0);
  await expect(strip(page, 1).getByTestId('eq-on')).toHaveText('off');
  await strip(page, 1).getByTestId('eq-on').click();
  await expect(strip(page, 1).getByTestId('eq-on')).toHaveText('on');
  await strip(page, 1).getByTestId('eq-expand').click();
  await expect(strip(page, 1).getByTestId('knob-eq_low')).toContainText('0.0 dB');
  // Clicking a strip's name selects that track; the tab stays on the mixer.
  await strip(page, 0).getByTestId('strip-name').click();
  await expect(page.getByTestId('track-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mixer')).toBeVisible();
  await page.getByRole('button', { name: 'Step grid' }).click();
  await expect(page.getByTestId('mixer')).toBeHidden();
});

test('fader down lowers the track meter (meters plumbing end to end)', async ({ page }) => {
  await startAudio(page);
  await synthHoldingNote(page);
  await openMixer(page);
  // Plumbing: engine -> worklet -> shared meters -> engine.meters() -> strip meter.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.meters()[1 * 3]), { timeout: 3_000 })
    .toBeGreaterThan(0.01); // > −40 dBFS
  await expect.poll(() => meterDb(page, 1), { timeout: 3_000 }).toBeGreaterThan(-40);
  await page.waitForTimeout(1_000); // the note's envelope settles to its sustain level
  const before = await meterRange(page, 'strip-1', 500);

  // Drag the fader down with the mouse.
  const fader = strip(page, 1).getByTestId('fader');
  const b = (await fader.boundingBox())!;
  const capY = b.y + b.height * 0.25; // 0 dB sits at 3/4 of the travel
  await page.mouse.move(b.x + b.width / 2, capY);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, capY + 30, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, capY + 45, { steps: 5 });
  await page.mouse.up();
  const readout = (await strip(page, 1).getByTestId('fader-readout').textContent())!;
  const db = Number(readout.replace('−', '-').replace(' dB', ''));
  expect(db).toBeLessThan(-12);
  await page.waitForTimeout(400); // 60 dB/s meter fall
  const after = await meterRange(page, 'strip-1', 500);
  expect(after.max).toBeLessThan(before.max - 10);
  // ...by about the fader move.
  expect(after.max).toBeGreaterThan(before.max + db - 3);
  expect(after.max).toBeLessThan(before.max + db + 3);

  // Double-click: back to 0 dB. Home: −∞ (the meter goes silent).
  await fader.dblclick();
  await expect(strip(page, 1).getByTestId('fader-readout')).toHaveText('0.0 dB');
  await fader.focus();
  await page.keyboard.press('Home');
  await expect(strip(page, 1).getByTestId('fader-readout')).toHaveText('−∞');
  await expect.poll(() => meterDb(page, 1), { timeout: 3_000 }).toBeLessThan(-90);
  await page.keyboard.press('ArrowUp');
  await expect(strip(page, 1).getByTestId('fader-readout')).toHaveText('−59.0 dB');
  await page.keyboard.up('KeyA');
});

test('solo isolates', async ({ page }) => {
  await startAudio(page);
  await fourOnTheFloor(page);
  await synthHoldingNote(page);
  await page.keyboard.press('Space');
  await openMixer(page);
  await expect.poll(async () => (await meterRange(page, 'strip-0', 600)).max, { timeout: 4_000 }).toBeGreaterThan(-30);
  await expect.poll(() => meterDb(page, 1), { timeout: 3_000 }).toBeGreaterThan(-40);

  await strip(page, 1).getByTestId('solo').click();
  await expect(strip(page, 1).getByTestId('solo')).toHaveAttribute('aria-pressed', 'true');
  // The drums go silent; the soloed synth and the master keep playing.
  // (The meter falls at 60 dB/s, so give it 1.7 s to drop past −90 dBFS.)
  await page.waitForTimeout(1_700);
  expect((await meterRange(page, 'strip-0', 1_000)).max).toBeLessThan(-90);
  expect(await meterDb(page, 1)).toBeGreaterThan(-40);
  expect(await meterDb(page, 'master')).toBeGreaterThan(-40);

  // Unsolo: the drums come back.
  await strip(page, 1).getByTestId('solo').click();
  await expect.poll(async () => (await meterRange(page, 'strip-0', 600)).max, { timeout: 4_000 }).toBeGreaterThan(-30);
  await page.keyboard.up('KeyA');
});

test('sidechain from kick ducks the synth', async ({ page }) => {
  await startAudio(page);
  await fourOnTheFloor(page);
  await synthHoldingNote(page);
  await page.keyboard.press('Space');
  await openMixer(page);
  const synth = strip(page, 1);
  await expect.poll(() => meterDb(page, 1), { timeout: 3_000 }).toBeGreaterThan(-40);

  // Baseline: the held note alone reads steady (no pumping without a key),
  // once its envelope has settled (Deep Bass: decay 0.25 s to sustain).
  await page.waitForTimeout(1_000);
  const steady = await meterRange(page, 'strip-1', 1_000);
  expect(steady.max - steady.min).toBeLessThan(3);

  // Comp on, keyed from the kick row.
  await synth.getByTestId('comp-on').click();
  await expect(synth.getByTestId('comp-on')).toHaveAttribute('aria-pressed', 'true');
  await synth.getByTestId('comp-expand').click();
  await synth.getByTestId('sc-select').selectOption({ label: 'Drums · kick' });
  await expect(synth.getByTestId('sc-label')).toHaveText('SC: Drums · kick');
  await synth.getByTestId('sc-select').blur();

  // The synth meter pumps with the kick: >= 6 dB between ducked and released.
  await page.waitForTimeout(300);
  const pump = await meterRange(page, 'strip-1', 2_000);
  console.log(`MIXER sidechain pump: steady ${(steady.max - steady.min).toFixed(1)} dB, keyed ${(pump.max - pump.min).toFixed(1)} dB over ${pump.n} frames`);
  expect(pump.n).toBeGreaterThan(30);
  expect(pump.max - pump.min).toBeGreaterThanOrEqual(6);
  // The comp's GR readout shows the ducking too.
  await expect.poll(async () => Number(await synth.getByTestId('gr').getAttribute('data-gr-db')), { timeout: 3_000 }).toBeGreaterThan(3);

  // Collapsed, the Comp header still names the key and shows the ducking.
  await synth.getByTestId('comp-expand').click();
  await expect(synth.getByTestId('sc-label')).toHaveText('SC: Drums · kick');
  await expect(synth.getByTestId('knob-comp_threshold')).toHaveCount(0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/mixer.png' });
  await page.keyboard.up('KeyA');
});

test('timeline track headers switch the bottom panel from the mixer to that track\'s editor', async ({ page }) => {
  await startAudio(page);
  await page.getByTestId('add-synth-track').click(); // slot 1, Piano roll
  await openMixer(page);
  // Inside the mixer, a strip name selects the track but keeps the mixer open.
  await strip(page, 1).getByTestId('strip-name').click();
  await expect(page.getByTestId('track-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mixer')).toBeVisible();
  // The timeline's track header leaves the mixer for that track's editor.
  await page.getByTestId('track-0').click();
  await expect(page.getByTestId('mixer')).toBeHidden();
  await expect(page.getByTestId('row-0')).toBeVisible(); // the drum track's Step grid
  // Same for a synth track: back to the remembered Piano roll tab.
  await openMixer(page);
  await page.getByTestId('track-1').click();
  await expect(page.getByTestId('mixer')).toBeHidden();
  await expect(page.getByTestId('pianoroll')).toBeVisible();
});
