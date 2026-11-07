import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// Undo/redo (plan 7 Task 1): every edit is an undo step, restored by a
// minimal diff while the transport keeps playing. Sound is read from the
// engine's strip meters (engine.meters(): peak L/R + GR per channel).

type Daw = {
  engine: { telemetry(): Float64Array; meters(): Float32Array } | null;
  project: {
    playing: boolean;
    tracks: { id: string; slot: number; kind: string; name: string; rows?: { id: string }[] }[];
    mixer: { channels: Record<string, { params: number[]; key: unknown }> };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, (...args: any[]) => any>;
  history: { labels: { undo: string | null; redo: string | null } } | null;
};

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

async function dropFile(page: Page, testid: string, name: string, bytes: number[]) {
  await page.evaluate(
    ({ testid, name, bytes }) => {
      const el = document.querySelector(`[data-testid="${testid}"]`)!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'audio/wav' }));
      for (const t of ['dragenter', 'dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    { testid, name, bytes },
  );
}

/** Max meter peak per strip (track slots) over `ms`. */
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

/**
 * The strips go silent (below −60 dBFS; the meters fall at 60 dB/s) and stay
 * silent for a further second: a stuck note would keep them up.
 */
async function expectSilent(page: Page, slots: number[]) {
  await expect.poll(async () => Math.max(...(await stripPeaks(page, slots, 100))), { timeout: 5_000 }).toBeLessThan(0.001);
  expect(Math.max(...(await stripPeaks(page, slots, 1_000)))).toBeLessThan(0.001);
}

/** Everything the restore must bring back, without the UI ids (fresh on a rebuild). */
const summary = (page: Page) =>
  page.evaluate(() => {
    const { project } = (window as unknown as { __daw: Daw }).__daw;
    const strip = (id: string) => project.mixer.channels[id];
    return JSON.parse(
      JSON.stringify(project.tracks.map((t) => ({ ...t, mixer: strip(t.id) })), (k, v) =>
        k === 'id' || k === 'trackId' || k === 'patternId' || k === 'currentPatternId' ? undefined : v,
      ),
    );
  });

const playingTicks = (page: Page) => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.engine!.telemetry()[2]);

test('undo remove track restores everything (sound resumes)', async ({ page }) => {
  test.setTimeout(60_000);
  await startAudio(page);
  await dropFile(page, 'row-0', 'kick.wav', [...makeWav(80, 120)]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as { __daw: Daw }).__daw;
    const d = project.tracks[0];
    for (const s of [0, 4, 8, 12]) a.setStep(d.id, d.rows![0].id, s, 120);
    a.setMix(d.id, 'fader', -3);
    const synth = a.addSynthTrack('Pad');
    for (const pitch of [48, 52, 55]) a.addNote(synth.id, { pitch, start: 0, len: 15360, vel: 100 });
    a.setMix(synth.id, 'pan', 0.4);
    a.setSidechain(synth.id, { trackId: d.id, row: 0 });
    a.addClip(synth.id, { start: 0 });
  });
  const want = await summary(page);
  await page.keyboard.press('Space');
  await expect.poll(async () => Math.min(...(await stripPeaks(page, [0, 1], 600))), { timeout: 5_000 }).toBeGreaterThan(0.01);

  // Two separate edits (separate tasks): remove the drums (sample, steps, the
  // synth's sidechain source), then the synth (rack, notes, clip, mixer).
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.removeTrack((window as unknown as { __daw: Daw }).__daw.project.tracks[0].id));
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.removeTrack((window as unknown as { __daw: Daw }).__daw.project.tracks[0].id));
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.length)).toBe(0);
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Remove track/);
  await expectSilent(page, [0, 1]);

  await page.keyboard.press('ControlOrMeta+z');
  await page.getByTestId('undo').click(); // the button does the same
  // Next back: the set-up (one task, so one entry, named by its first edit).
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Set step/);
  await expect(page.getByTestId('redo')).toHaveAttribute('title', /^Redo Remove track/);
  expect(await summary(page)).toEqual(want);
  // The transport never stopped, and both tracks play again.
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.playing)).toBe(true);
  const t0 = await playingTicks(page);
  await expect.poll(async () => Math.min(...(await stripPeaks(page, [0, 1], 600))), { timeout: 10_000 }).toBeGreaterThan(0.01);
  expect(await playingTicks(page)).not.toBe(t0);
  // The sidechain key (the kick row keys the pad) came back with both tracks.
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.mixer.channels[(window as unknown as { __daw: Daw }).__daw.project.tracks[1].id].key)).not.toBeNull();
  await page.keyboard.press('Space');
});

test('undo while playing releases removed notes', async ({ page }) => {
  test.setTimeout(60_000);
  await startAudio(page);
  const slot = await page.evaluate(() => {
    const s = (window as unknown as { __daw: Daw }).__daw.actions.addSynthTrack('Lead'); // release 0.2 s
    return s.slot as number;
  });
  await page.evaluate(() => {
    const s = (window as unknown as { __daw: Daw }).__daw.project.tracks.find((t) => t.kind === 'synth')!;
    (window as unknown as { __daw: Daw }).__daw.actions.addNote(s.id, { pitch: 60, start: 0, len: 15359, vel: 110 }); // held for the whole 4-bar loop
  });
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Add note/);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await stripPeaks(page, [slot], 300))[0], { timeout: 5_000 }).toBeGreaterThan(0.01);

  // Undo while the note sounds: released at once, nothing left hanging.
  await page.keyboard.press('ControlOrMeta+z');
  await expectSilent(page, [slot]);
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.engine!.telemetry()[1])).toBe(1); // still playing
  // Redo while playing: the note is back and sounds from the next pass over it.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await stripPeaks(page, [slot], 300))[0], { timeout: 10_000 }).toBeGreaterThan(0.01);
  // And undo again: silent again.
  await page.keyboard.press('ControlOrMeta+z');
  await expectSilent(page, [slot]);
  await page.keyboard.press('Space');
});

test('a fader drag is one undo step', async ({ page }) => {
  await startAudio(page);
  await page.getByTestId('add-synth-track').click();
  await page.getByTestId('mixer-tab').click();
  const strip = page.getByTestId('strip-1');
  const fader = strip.getByTestId('fader');
  const b = (await fader.boundingBox())!;
  const capY = b.y + b.height * 0.25; // 0 dB
  await page.mouse.move(b.x + b.width / 2, capY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width / 2, capY + i * 6);
  await page.mouse.up();
  await expect(strip.getByTestId('fader-readout')).not.toHaveText('0.0 dB');
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Set Volume/);
  await page.getByTestId('undo').click();
  await expect(strip.getByTestId('fader-readout')).toHaveText('0.0 dB');
  // One step back is the track add, not an earlier point of the drag.
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Add synth track/);
  await page.getByTestId('redo').click();
  await expect(strip.getByTestId('fader-readout')).not.toHaveText('0.0 dB');
  await expect(page.getByTestId('redo')).toBeDisabled();
});
