import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

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
  await startApp(page);
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

/**
 * Every track in `slots` sounds while the pattern transport plays: it plays
 * only the selected track (plan 20 task 12), so each track header is clicked
 * in turn (the focus follows the selection). The synth goes first: a track
 * focused mid-note only sounds from its next note (the pad's chord starts at
 * tick 0 of a 4-bar pattern); the drums hit on every beat.
 */
async function eachSounds(page: Page, slots: number[], timeout: number) {
  for (const s of slots) {
    await page.getByTestId(`track-${s}`).click();
    await expect.poll(async () => (await stripPeaks(page, [s], 600))[0], { timeout }).toBeGreaterThan(0.01);
  }
}

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
  await page.getByTestId('pattern-play').click(); // Pattern mode (the synth's clip plays in Song mode only)
  await eachSounds(page, [1, 0], 5_000);

  // Two separate edits (separate tasks): remove the drums (sample, steps, the
  // synth's sidechain source), then the synth (rack, notes, clip, mixer).
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.removeTrack((window as unknown as { __daw: Daw }).__daw.project.tracks[0].id));
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.removeTrack((window as unknown as { __daw: Daw }).__daw.project.tracks[0].id));
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.length)).toBe(0);
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Remove track/);
  // The focused track went with nothing left selected: the pattern transport stopped (plan 20 final review).
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.playing)).toBe(false);
  await expectSilent(page, [0, 1]);

  await page.keyboard.press('ControlOrMeta+z');
  await page.getByTestId('undo').click(); // the button does the same
  // Next back: the set-up (one task, so one entry, named by its first edit).
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Set step/);
  await expect(page.getByTestId('redo')).toHaveAttribute('title', /^Redo Remove track/);
  expect(await summary(page)).toEqual(want);
  // Pattern Play again: both tracks play as before.
  await page.getByTestId('pattern-play').click();
  const t0 = await playingTicks(page);
  await eachSounds(page, [1, 0], 10_000);
  expect(await playingTicks(page)).not.toBe(t0);
  // The sidechain key (the kick row keys the pad) came back with both tracks.
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.mixer.channels[(window as unknown as { __daw: Daw }).__daw.project.tracks[1].id].key)).not.toBeNull();
  await page.getByTestId('pattern-stop').click();
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
  await page.getByTestId('pattern-play').click();
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
  await page.getByTestId('pattern-stop').click();
});

test('a fader drag is one undo step', async ({ page }) => {
  await startAudio(page);
  await addTrack(page, 'synth');
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

// Plan 16 Task 5: Cmd/Ctrl+Z (or redo) while a knob or fader is being
// dragged cancels the drag: the value from before it comes back, no entry is
// made, and no older entry is undone. Released, Cmd+Z is a normal undo.
test('undo during a knob or fader drag cancels the drag', async ({ page }) => {
  await startAudio(page);
  await addTrack(page, 'synth');
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Add synth track/);
  await page.getByTestId('mixer-tab').click();
  const strip = page.getByTestId('strip-1');

  // Slider (pan): drag along its track, Cmd+Z with the mouse still down, keep moving, release.
  const knob = strip.getByTestId('knob-pan');
  await expect(knob).toHaveAttribute('aria-valuenow', '0');
  const rail = (await knob.locator('.rail').boundingBox())!;
  const y = rail.y + rail.height / 2;
  const x0 = rail.x + rail.width / 2;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x0 + i * 8, y);
  await expect(knob).not.toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(knob).toHaveAttribute('aria-valuenow', '0');
  await page.mouse.move(x0 + 60, y, { steps: 4 }); // the cancelled drag moves nothing
  await page.mouse.up();
  await page.waitForTimeout(100);
  await expect(knob).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByTestId('track-1')).toHaveCount(1); // the add was not undone
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Add synth track/);
  await expect(page.getByTestId('redo')).toBeDisabled();

  // Fader: the same with redo (Shift+Cmd+Z).
  const fader = strip.getByTestId('fader');
  const b = (await fader.boundingBox())!;
  const capY = b.y + b.height * 0.25; // 0 dB
  await page.mouse.move(b.x + b.width / 2, capY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width / 2, capY + i * 6);
  await expect(strip.getByTestId('fader-readout')).not.toHaveText('0.0 dB');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(strip.getByTestId('fader-readout')).toHaveText('0.0 dB');
  await page.mouse.up();
  await page.waitForTimeout(100);
  await expect(strip.getByTestId('fader-readout')).toHaveText('0.0 dB');
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Add synth track/);

  // No drag in progress: Cmd+Z is the normal undo (the track goes).
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('track-1')).toHaveCount(0);
});

// Plan 16 ruling Q: the step grid's paint has no cancel (each cell it
// crossed is already its own value), so Cmd/Ctrl+Z (or redo) while painting
// does nothing: no older entry is undone, the paint goes on, and the whole
// paint is still one entry after the release.
test('undo during a step-grid paint is swallowed', async ({ page }) => {
  await startAudio(page);
  const cell = (s: number) => page.getByTestId(`step-0-${s}`);
  await cell(0).click();
  await expect(cell(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Set step/); // the click's gesture committed
  await expect(page.getByTestId('redo')).toBeDisabled();
  const title = await page.getByTestId('undo').getAttribute('title');
  for (const s of [2, 3, 4, 5, 6]) await expect(cell(s)).toHaveAttribute('aria-pressed', 'false');
  const at = async (s: number) => {
    const b = (await cell(s).boundingBox())!;
    return [b.x + b.width / 2, b.y + b.height / 2] as const;
  };
  await page.mouse.move(...(await at(2)));
  await page.mouse.down();
  await page.mouse.move(...(await at(3)), { steps: 3 });
  await page.mouse.move(...(await at(4)), { steps: 3 });
  await expect(cell(4)).toHaveAttribute('aria-pressed', 'true');
  for (const key of ['ControlOrMeta+z', 'ControlOrMeta+Shift+z']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(50);
    await expect(page.getByTestId('undo')).toHaveAttribute('title', title!);
    await expect(page.getByTestId('redo')).toBeDisabled(); // nothing undone
    await expect(cell(0)).toHaveAttribute('aria-pressed', 'true');
    for (const s of [2, 3, 4]) await expect(cell(s)).toHaveAttribute('aria-pressed', 'true');
  }
  await page.mouse.move(...(await at(5)), { steps: 3 }); // the paint goes on
  await page.mouse.move(...(await at(6)), { steps: 3 });
  await page.mouse.up();
  for (const s of [2, 3, 4, 5, 6]) await expect(cell(s)).toHaveAttribute('aria-pressed', 'true');
  // One entry: one undo clears the whole paint and leaves the click before it.
  await page.keyboard.press('ControlOrMeta+z');
  for (const s of [2, 3, 4, 5, 6]) await expect(cell(s)).toHaveAttribute('aria-pressed', 'false');
  await expect(cell(0)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+z'); // and the click is the entry before it
  await expect(cell(0)).toHaveAttribute('aria-pressed', 'false');
});

// Plan 9 Task 1: the question was about a state the undo replaces, so an
// undo (↶, ⌘Z) closes an open inline confirm (as its Cancel would) first.
test('undo closes an open confirm', async ({ page }) => {
  await startAudio(page);
  await addTrack(page, 'synth');
  // The click's gesture has ended (its entry is named), so the next edit is its own step.
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Add synth track/);
  await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as { __daw: Daw }).__daw;
    a.setMix(project.tracks[1].id, 'fader', -6);
  });
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Set Volume/);
  const fader = () => page.evaluate(() => {
    const { project } = (window as unknown as { __daw: Daw }).__daw;
    return project.mixer.channels[project.tracks[1].id].params[0];
  });
  const before = await fader();
  expect(before).toBe(-6);

  // ↶ while "Remove track?" is open: the popover goes, the track stays, the fader edit is undone.
  await page.getByTestId('track-1').hover();
  await page.getByRole('button', { name: 'Remove track Synth' }).click();
  const ask = page.getByTestId('inline-confirm');
  await expect(ask).toContainText('Remove track "Synth"');
  await page.getByTestId('undo').click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByTestId('track-1')).toHaveCount(1);
  expect(await fader()).toBe(0);
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Add synth track/);

  // ⌘Z with focus inside the popover (on Cancel): the same, and focus goes back to the ×.
  await page.getByTestId('redo').click();
  expect(await fader()).toBe(-6);
  await page.getByTestId('track-1').hover();
  await page.getByRole('button', { name: 'Remove track Synth' }).click();
  await expect(page.getByTestId('inline-confirm-cancel')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(ask).toHaveCount(0);
  await expect(page.getByTestId('track-1')).toHaveCount(1);
  expect(await fader()).toBe(0);
  await expect(page.getByRole('button', { name: 'Remove track Synth' })).toBeFocused();
});
