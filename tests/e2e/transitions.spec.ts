import { expect, test, type Page } from '@playwright/test';
import mixerCatalog from '../../engine/mixer_catalog.json' with { type: 'json' };
import { openAddTrack } from './addTrack';
import { startApp } from './startApp';

// Add track ▸ Transition ▸ Riser / Downlifter / Impact (plan 28 Task 3;
// app/src/state/transitions.ts). Each adds a synth track with its clip at the
// song playhead's bar, in one undo entry; the sweeps also get a cutoff and a
// volume lane. The level checks read the engine's per-block master peak
// (telemetry slot 5) with the song position of the same block (slot 2).

const BAR = 3840;
/** The Reverb send's mixer param id, by name (never a hard-coded number). */
const SEND_A = mixerCatalog.params.find((x) => x.name === 'send_a')!.id;
const T = { ticks: 2, peakL: 5 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  await expect(page.getByTestId('timeline')).toBeVisible();
}

/** The project as saved (its tracks, by slot). */
const snapshot = (page: Page) => page.evaluate(() => (window as Any).__daw.snapshot());
const trackCount = (page: Page) => page.evaluate(() => (window as Any).__daw.project.tracks.length as number);

/** Remove every track, so only what a test adds is heard. */
async function emptySong(page: Page) {
  await page.evaluate(() => {
    const d = (window as Any).__daw;
    for (const t of [...d.project.tracks]) d.actions.removeTrack(t.id);
  });
  await expect.poll(() => trackCount(page)).toBe(0);
}

async function setTempo(page: Page, bpm: number) {
  const input = page.getByLabel('BPM');
  await input.fill(String(bpm));
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.project.tempo)).toBe(bpm);
}

/** [song tick, master peak] per sample, every 4 ms for `ms`. */
function sampleLevel(page: Page, ms: number): Promise<[number, number][]> {
  return page.evaluate(
    ({ ms, T }) =>
      new Promise<[number, number][]>((resolve) => {
        const eng = (window as Any).__daw.engine;
        const out: [number, number][] = [];
        const t0 = performance.now();
        const id = setInterval(() => {
          const tel = eng.telemetry();
          out.push([tel[T.ticks], tel[T.peakL]]);
          if (performance.now() - t0 > ms) {
            clearInterval(id);
            resolve(out);
          }
        }, 4);
      }),
    { ms, T },
  );
}

/** RMS of the sampled peaks whose song tick is in [from, to). */
function rmsIn(s: [number, number][], from: number, to: number) {
  const v = s.filter(([t]) => t >= from && t < to).map(([, x]) => x);
  expect(v.length, `samples in ${from}..${to}`).toBeGreaterThan(20);
  return Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length);
}

test('Add ▸ Transition ▸ Riser with the playhead in bar 17: a track, a clip over bars 9–16 (ending at the drop), two lanes; one undo removes it all', async ({ page }) => {
  await start(page);
  await page.evaluate((t) => (window as Any).__daw.actions.seek(t), 16 * BAR + 500); // inside bar 17
  const before = await snapshot(page);

  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('menu-add-transition').click();
  await expect(page.locator('#menu-add-transitions')).toBeVisible();
  await page.screenshot({ path: 'test-results/transitions-menu.png' });
  await page.getByTestId('menu-add-transition-riser').click();

  const after = await snapshot(page);
  expect(after.tracks).toHaveLength(before.tracks.length + 1);
  const t = after.tracks.at(-1);
  expect(t.name).toBe('Riser');
  expect(t.patch.name).toBe('Noise Sweep');
  expect(t.clips.map((c: Any) => [c.start, c.len])).toEqual([[8 * BAR, 8 * BAR]]);
  expect(t.automation).toHaveLength(2);
  // The cutoff opens 200 Hz → 12 kHz and the amp level rises −24 → 0 dB over the clip (its last point one
  // tick before the clip's end: it moves with the clip). The fader has no lane: it stays the user's.
  const lanes = t.automation.map((l: Any) => [...l.points].sort((a: number[], b: number[]) => a[0] - b[0]).map((x: number[]) => [x[0], x[1]]));
  expect(lanes).toHaveLength(2);
  expect(lanes[0]).toEqual([[8 * BAR, 200], [16 * BAR - 1, 12000]]);
  expect(lanes[1].map((x: number[]) => x[0])).toEqual([8 * BAR, 16 * BAR - 1]);
  expect(lanes[1][0][1]).toBeCloseTo(10 ** (-24 / 20), 4);
  expect(lanes[1][1][1]).toBe(1);
  // The lanes are open under the new row.
  await expect(page.getByTestId(`auto-lane-${t.slot}-0`)).toBeVisible();
  await expect(page.getByTestId(`auto-lane-${t.slot}-1`)).toBeVisible();
  await page.screenshot({ path: 'test-results/transitions-riser.png' });

  // One undo takes the track, its clip and its lanes.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => trackCount(page)).toBe(before.tracks.length);
  const undone = await snapshot(page);
  expect(undone.tracks.map((x: Any) => x.name)).toEqual(before.tracks.map((x: Any) => x.name));
  expect(undone.tracks.flatMap((x: Any) => x.automation)).toEqual(before.tracks.flatMap((x: Any) => x.automation));
  await expect(page.getByTestId(`auto-lane-${t.slot}-0`)).toHaveCount(0);
});

test('a Riser played in Song mode gets louder over its clip', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await emptySong(page);
  await setTempo(page, 300); // 8 bars in 6.4 s
  await page.evaluate((t) => (window as Any).__daw.actions.seek(t), 10 * BAR); // bar 11: the Riser ends here
  // The playlist footer's Add track ▸ Transition ▸ Riser.
  await openAddTrack(page);
  await expect(page.getByTestId('add-transitions')).toBeVisible();
  await page.screenshot({ path: 'test-results/transitions-footer.png' });
  await page.getByTestId('add-transition-riser').click();
  await expect.poll(async () => (await snapshot(page)).tracks[0]?.clips?.[0]?.start).toBe(2 * BAR); // bars 3–10
  await page.evaluate((t) => (window as Any).__daw.actions.seek(t), 2 * BAR); // play it from its start

  await page.getByTestId('play').click();
  const s = await sampleLevel(page, 7000);
  await page.getByTestId('play').click();
  const early = rmsIn(s, 2 * BAR, 4 * BAR); // the clip's first 2 bars
  const late = rmsIn(s, 8 * BAR, 10 * BAR); // its last 2
  expect(late, `late ${late} vs early ${early}`).toBeGreaterThan(early * 3);
  expect(late).toBeGreaterThan(0.05);
});

test('an Impact plays one hit, with a reverb send', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await emptySong(page);
  await setTempo(page, 300);
  await page.evaluate((t) => (window as Any).__daw.actions.seek(t), BAR + 900); // inside bar 2
  // The menu bar's submenu from the keyboard: → opens it on Riser, ↓ ↓ to Impact, Enter.
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('menu-add-transition').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('menu-add-transition-riser')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('menu-add-transition-impact')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => trackCount(page)).toBe(1);
  const t = (await snapshot(page)).tracks[0];
  expect(t.name).toBe('Impact');
  expect(t.clips.map((c: Any) => [c.start, c.len])).toEqual([[BAR, BAR]]);
  expect(t.automation).toEqual([]);
  const send = await page.evaluate((id) => {
    const p = (window as Any).__daw.project;
    return p.mixer.channels[p.tracks[0].id].params[id];
  }, SEND_A);
  expect(send).toBe(-6);

  await page.evaluate((t) => (window as Any).__daw.actions.seek(t), BAR);
  await page.getByTestId('play').click();
  const s = await sampleLevel(page, 4000); // 5 bars at 300 BPM: the hit, its tail, silence
  await page.getByTestId('play').click();
  // A block's peak of the 65 Hz sub swings with where the block falls in its cycle (a block is 2.7 ms,
  // the cycle 15 ms), so the envelope is the max over the last 80 ms of samples.
  const env = s.map(([t], i) => [t, Math.max(...s.slice(Math.max(0, i - 20), i + 1).map(([, x]) => x))] as const);
  const max = Math.max(...env.map(([, x]) => x));
  expect(max).toBeGreaterThan(0.02);
  // The hit: the first sample past half the max, on beat 1 of bar 2.
  const first = env.findIndex(([, x]) => x > max / 2);
  const firstAt = env[first][0];
  // One hit: from there the level only decays. The RMS of the raw peaks over each ~100 ms (25 samples)
  // never climbs more than 30 % over the window before it (a second hit, even inside the first's tail,
  // jumps by several times), until the tail is down at the floor.
  const win: number[] = [];
  for (let i = first; i + 25 <= s.length; i += 25) win.push(Math.sqrt(s.slice(i, i + 25).reduce((a, [, x]) => a + x * x, 0) / 25));
  for (let k = 1; k < win.length; k++) {
    if (win[k - 1] > max / 50) expect(win[k], `window ${k}: ${win.map((w) => w.toFixed(3)).join(' ')}`).toBeLessThan(win[k - 1] * 1.3);
  }
  expect(firstAt).toBeGreaterThanOrEqual(BAR);
  expect(firstAt).toBeLessThan(BAR + BAR / 4); // on beat 1 of bar 2
});

test('dragging a Riser clip takes its sweep along (on release); one undo puts both back', async ({ page }) => {
  await start(page);
  await emptySong(page);
  await page.evaluate((t) => (window as Any).__daw.actions.seek(t), 8 * BAR); // bar 9: the Riser is bars 1–8
  await openAddTrack(page);
  await page.getByTestId('add-transition-riser').click();
  await expect.poll(async () => (await snapshot(page)).tracks[0]?.clips?.[0]?.start).toBe(0);
  const t = (await snapshot(page)).tracks[0];
  const ticks = async () => (await snapshot(page)).tracks[0].automation.map((l: Any) => l.points.map((x: number[]) => x[0]).sort((a: number, b: number) => a - b));
  expect(await ticks()).toEqual([[0, 8 * BAR - 1], [0, 8 * BAR - 1]]);

  // Drag the clip 4 bars right by its body (the timeline's own view: ticks per px, scroll).
  const v = JSON.parse((await page.getByTestId('timeline').getAttribute('data-view'))!);
  const b = (await page.getByTestId(`clip-${t.slot}-0`).boundingBox())!;
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + 20, y);
  await page.mouse.down();
  await page.mouse.move(b.x + 20 + (4 * BAR) / v.ticksPerPx, y, { steps: 8 });
  // Mid-drag the clip moves, the points wait for the release.
  await expect.poll(async () => (await snapshot(page)).tracks[0].clips[0].start).toBe(4 * BAR);
  expect(await ticks()).toEqual([[0, 8 * BAR - 1], [0, 8 * BAR - 1]]);
  await page.mouse.up();
  await expect.poll(ticks).toEqual([[4 * BAR, 12 * BAR - 1], [4 * BAR, 12 * BAR - 1]]);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await snapshot(page)).tracks[0].clips[0].start).toBe(0);
  expect(await ticks()).toEqual([[0, 8 * BAR - 1], [0, 8 * BAR - 1]]);
});
