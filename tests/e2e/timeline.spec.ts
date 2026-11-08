import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// Song timeline (plan 4, Task 5): placing / editing clips through the UI,
// loop range and seek on the ruler, and what the engine plays in Song mode.
// Tempo 240 throughout: one bar = 1 s.

const BAR = 3840;
const BEAT = 960;

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('tl-lane-0')).toBeVisible();
}

async function setTempo(page: Page, bpm: number) {
  const input = page.getByLabel('BPM');
  await input.fill(String(bpm));
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__daw.project.tempo)).toBe(bpm);
}

async function dropSample(page: Page, row: number, name: string, freq: number) {
  await page.evaluate(({ bytes, row, name }) => {
    const el = document.querySelector(`[data-testid="row-${row}"]`)!;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], `${name}.wav`, { type: 'audio/wav' }));
    for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { bytes: [...makeWav(freq)], row, name });
  await expect(page.getByTestId(`row-${row}`).getByTestId('row-name')).toHaveText(name);
}

async function steps(page: Page, row: number, list: number[]) {
  for (const s of list) {
    await page.getByTestId(`step-${row}-${s}`).click();
    await expect(page.getByTestId(`step-${row}-${s}`)).toHaveAttribute('aria-pressed', 'true');
  }
}

type View = { ticksPerPx: number; scrollTick: number; laneH: number };
async function view(page: Page): Promise<View> {
  return JSON.parse((await page.getByTestId('timeline').getAttribute('data-view'))!);
}

/** Page coordinates of song tick `tick` on lane `slot` (vertical middle of the lane). */
async function at(page: Page, slot: number, tick: number) {
  const v = await view(page);
  const b = (await page.getByTestId(`tl-lane-${slot}`).boundingBox())!;
  return { x: b.x + (tick - v.scrollTick) / v.ticksPerPx, y: b.y + b.height / 2 };
}

async function clickLane(page: Page, slot: number, tick: number) {
  const p = await at(page, slot, tick);
  await page.mouse.click(p.x, p.y);
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { alt?: boolean; shift?: boolean; up?: boolean } = {}) {
  if (opts.alt) await page.keyboard.down('Alt');
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  if (opts.up !== false) await page.mouse.up();
  if (opts.shift) await page.keyboard.up('Shift');
  if (opts.alt) await page.keyboard.up('Alt');
}

/** Drag a clip's right edge (2 px inside) to song tick `toTick`. */
async function resizeRight(page: Page, slot: number, idx: number, toTick: number) {
  const b = (await page.getByTestId(`clip-${slot}-${idx}`).boundingBox())!;
  const to = await at(page, slot, toTick);
  await drag(page, { x: b.x + b.width - 2, y: b.y + b.height / 2 }, { x: to.x, y: b.y + b.height / 2 });
}

const clip = (page: Page, slot: number, idx: number) => page.getByTestId(`clip-${slot}-${idx}`);
const pos = async (page: Page, slot: number, idx: number) => {
  const c = clip(page, slot, idx);
  return { start: Number(await c.getAttribute('data-start')), len: Number(await c.getAttribute('data-len')) };
};

/** Samples telemetry {ticks, peakL} and the timeline's playhead every 4 ms for `ms`. */
function record(page: Page, ms: number) {
  return page.evaluate(
    (ms) =>
      new Promise<{ t: number; peak: number; head: string }[]>((resolve) => {
        const eng = (window as any).__daw.engine;
        const tl = document.querySelector('[data-testid="timeline"]') as HTMLElement;
        const out: { t: number; peak: number; head: string }[] = [];
        const t0 = performance.now();
        const id = setInterval(() => {
          const tele = eng.telemetry();
          out.push({ t: tele[2], peak: tele[5], head: tl.dataset.playhead ?? '' });
          if (performance.now() - t0 > ms) {
            clearInterval(id);
            resolve(out);
          }
        }, 4);
      }),
    ms,
  );
}
const peakIn = (rec: { t: number; peak: number }[], from: number, to: number) =>
  Math.max(0, ...rec.filter((r) => r.t >= from && r.t < to).map((r) => r.peak));

/** Song Play (the top bar): Song mode, playing. */
async function play(page: Page) {
  await page.getByTestId('play').click();
  await expect.poll(() => page.evaluate(() => (window as any).__daw.engine.telemetry()[1])).toBe(1);
}

test('arrange a song', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await setTempo(page, 240);
  await dropSample(page, 0, 'kick', 100);
  await dropSample(page, 1, 'hat', 2000);
  await steps(page, 0, [0, 4, 8, 12]); // Pattern 1: four on the floor
  await page.getByTestId('pattern-new').click();
  await expect(page.getByTestId('panel-title')).toContainText('· Pattern 2');
  await steps(page, 1, [2, 6, 10, 14]); // Pattern 2: off-beat hats (kick row empty)

  // Pattern 1 at bars 1-4: click places one bar (its length), the right edge repeats it.
  await page.getByTestId('pattern-picker').selectOption({ label: 'Pattern 1' });
  await clickLane(page, 0, 100);
  await expect(clip(page, 0, 0)).toHaveAttribute('data-pattern', 'Pattern 1');
  expect(await pos(page, 0, 0)).toEqual({ start: 0, len: BAR });
  await resizeRight(page, 0, 0, 4 * BAR);
  expect(await pos(page, 0, 0)).toEqual({ start: 0, len: 4 * BAR });
  await expect(clip(page, 0, 0)).toHaveAttribute('aria-label', 'Drums · Pattern 1 · bars 1–4');

  // Pattern 2 at bars 5-8 (the click lands mid-bar: snapped to the bar).
  await page.getByTestId('pattern-picker').selectOption({ label: 'Pattern 2' });
  await clickLane(page, 0, 4 * BAR + 1500);
  await expect(clip(page, 0, 1)).toHaveAttribute('data-pattern', 'Pattern 2');
  await resizeRight(page, 0, 1, 8 * BAR);
  expect(await pos(page, 0, 1)).toEqual({ start: 4 * BAR, len: 4 * BAR });

  // The song, from the start (ruler click at bar 1): song Play.
  const r = (await page.getByTestId('tl-ruler').boundingBox())!;
  await page.mouse.click(r.x + 2, r.y + r.height / 2);
  expect(await page.evaluate(() => (window as any).__daw.project.songPosition)).toBe(0);
  await play(page);
  const rec = await record(page, 9500);

  const ticks = rec.map((x) => x.t);
  expect(Math.max(...ticks)).toBeGreaterThan(8.5 * BAR); // ticks advance through the song
  const heads = rec.map((x) => Number(x.head)).filter((h) => h > 0);
  expect(heads.length).toBeGreaterThan(100);
  expect(heads[heads.length - 1]).toBeGreaterThan(heads[0] + 6 * BAR); // the playhead moves
  expect(peakIn(rec, 0, 4 * BAR)).toBeGreaterThan(0.1); // bars 1-4: kicks
  expect(peakIn(rec, 4 * BAR, 8 * BAR)).toBeGreaterThan(0.1); // bars 5-8: hats
  // Distinguish the patterns by WHERE in the beat they sound (samples are
  // 50 ms = 192 ticks): Pattern 1 hits on the beat (ticks 0, 960, ...), Pattern 2
  // on the off-beat (480, 1440, ...). Probe the slot each pattern leaves empty.
  const probe = (bars: [number, number], from: number, to: number) => {
    let max = 0;
    for (let bar = bars[0]; bar < bars[1]; bar++)
      for (let beat = 0; beat < 4; beat++) max = Math.max(max, peakIn(rec, bar * BAR + beat * BEAT + from, bar * BAR + beat * BEAT + to));
    return max;
  };
  expect(probe([0, 4], 300, 470)).toBeLessThan(0.02); // bars 1-4: nothing on the off-beat
  expect(probe([4, 8], 480, 600)).toBeGreaterThan(0.1); // bars 5-8: the off-beat hat
  expect(probe([4, 8], 40, 150)).toBeLessThan(0.02); // bars 5-8: nothing on the beat itself
  expect(peakIn(rec, 8 * BAR + BEAT, 8.6 * BAR)).toBeLessThan(0.001); // past the last clip: silence
  expect(await page.evaluate(() => (window as any).__daw.engine.failure)).toBeNull();
});

test('loop range wraps', async ({ page }) => {
  test.setTimeout(40_000);
  await start(page);
  await setTempo(page, 240);
  // Drag on the ruler from inside bar 2 to inside bar 3: loop bars 2-3, loop on.
  const a = await at(page, 0, BAR + 500);
  const b = await at(page, 0, 2 * BAR + 2000);
  const r = (await page.getByTestId('tl-ruler').boundingBox())!;
  await drag(page, { x: a.x, y: r.y + 10 }, { x: b.x, y: r.y + 10 });
  await expect(page.getByTestId('tl-ruler')).toHaveAttribute('data-loop', `${BAR},${3 * BAR},1`);
  await expect(page.getByTestId('tl-ruler')).toHaveAttribute('aria-label', /bars 2–3, loop on/);

  await expect(page.getByTestId('loop-toggle')).toHaveAttribute('aria-pressed', 'true');
  await play(page);
  const rec = await record(page, 4500); // 0 -> bar 3 end (3 s), then wraps to bar 2
  const ticks = rec.map((x) => x.t);
  expect(Math.max(...ticks)).toBeLessThanOrEqual(3 * BAR); // never past the loop end
  const wrap = ticks.findIndex((t, i) => i > 0 && t < ticks[i - 1]);
  expect(wrap).toBeGreaterThan(0); // wrapped back
  expect(Math.min(...ticks.slice(wrap))).toBeGreaterThanOrEqual(BAR); // ...to the loop start
  await page.getByTestId('play').click(); // ■ Stop (transport)
  expect(await page.evaluate(() => (window as any).__daw.project.songPosition)).toBe(BAR); // Stop: loop start
});

test('make unique detaches edits', async ({ page }) => {
  test.setTimeout(40_000);
  await start(page);
  await setTempo(page, 240);
  await dropSample(page, 0, 'kick', 100);
  await clickLane(page, 0, 100); // bar 1: Pattern 1 (empty)
  await clickLane(page, 0, BAR + 100); // bar 2: Pattern 1 again
  await expect(clip(page, 0, 1)).toHaveAttribute('data-pattern', 'Pattern 1');

  // The menu: Make unique on the second clip.
  await clip(page, 0, 1).click({ button: 'right' });
  await expect(page.getByTestId('tl-menu')).toBeVisible();
  await page.getByTestId('tl-menu-unique').click();
  await expect(page.getByTestId('tl-menu')).toBeHidden();
  await expect(clip(page, 0, 1)).toHaveAttribute('data-pattern', 'Pattern 1 copy');
  await expect(clip(page, 0, 0)).toHaveAttribute('data-pattern', 'Pattern 1');
  // Now the only user of its pattern: nothing to detach.
  await clip(page, 0, 1).click({ button: 'right' });
  await expect(page.getByTestId('tl-menu-unique')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tl-menu')).toBeHidden();

  // Double-click opens the clip's pattern; an edit there leaves Pattern 1 alone.
  await clip(page, 0, 1).dblclick();
  await expect(page.getByTestId('panel-title')).toHaveText('Drums · Pattern 1 copy');
  await steps(page, 0, [0]);
  await clip(page, 0, 0).dblclick();
  await expect(page.getByTestId('panel-title')).toHaveText('Drums · Pattern 1');
  await expect(page.getByTestId('step-0-0')).toHaveAttribute('aria-pressed', 'false');

  // Engine side: bar 1 (Pattern 1) silent, bar 2 (the copy) kicks.
  await play(page);
  const rec = await record(page, 2300);
  expect(peakIn(rec, 0, BAR)).toBeLessThan(0.001);
  expect(peakIn(rec, BAR, 2 * BAR)).toBeGreaterThan(0.1);
});

test('delete clip stops its sound', async ({ page }) => {
  test.setTimeout(40_000);
  await start(page);
  await setTempo(page, 240);
  await dropSample(page, 0, 'kick', 100);
  await steps(page, 0, [0, 4, 8, 12]);
  await clickLane(page, 0, 100);
  await resizeRight(page, 0, 0, 8 * BAR);
  expect(await pos(page, 0, 0)).toEqual({ start: 0, len: 8 * BAR });
  await play(page);
  const before = await record(page, 700);
  expect(Math.max(...before.map((x) => x.peak))).toBeGreaterThan(0.1);

  await clip(page, 0, 0).click(); // select (and focus the lanes)
  await expect(clip(page, 0, 0)).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Delete');
  await expect(clip(page, 0, 0)).toHaveCount(0);
  await page.waitForTimeout(200);
  const after = await record(page, 900);
  expect(Math.max(...after.map((x) => x.peak))).toBeLessThan(0.001);
  expect(await page.evaluate(() => (window as any).__daw.project.playing)).toBe(true); // still playing
});

test('clip edits: move, lane lock, edges, Escape revert, duplicate, nudge, box select', async ({ page }) => {
  await start(page);
  await page.getByTestId('add-synth-track').click(); // slot 1, 4-bar pattern
  await clickLane(page, 0, 100);
  await clickLane(page, 1, 100);
  expect(await pos(page, 1, 0)).toEqual({ start: 0, len: 4 * BAR }); // the synth pattern's length
  await expect(clip(page, 1, 0)).toHaveAttribute('aria-label', 'Synth · Pattern 1 · bars 1–4');

  // Move by two bars; a vertical component is ignored (R4: clips stay on their lane).
  const c0 = (await clip(page, 0, 0).boundingBox())!;
  const pxBar = BAR / (await view(page)).ticksPerPx;
  const lane1y = (await at(page, 1, 0)).y;
  await drag(page, { x: c0.x + c0.width / 2, y: c0.y + 5 }, { x: c0.x + c0.width / 2 + 2 * pxBar, y: lane1y });
  expect(await pos(page, 0, 0)).toEqual({ start: 2 * BAR, len: BAR });
  await expect(page.getByTestId('tl-readout')).toContainText('Clips stay on their own track');
  await expect(clip(page, 0, 0)).toBeVisible(); // still in lane 0

  // Escape mid-drag puts it back.
  const c1 = (await clip(page, 0, 0).boundingBox())!;
  const far = await at(page, 0, 6 * BAR);
  await drag(page, { x: c1.x + c1.width / 2, y: c1.y + 5 }, { x: far.x, y: c1.y + 5 }, { up: false });
  await expect(clip(page, 0, 0)).not.toHaveAttribute('data-start', String(2 * BAR));
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await pos(page, 0, 0)).toEqual({ start: 2 * BAR, len: BAR });

  // Left edge: start moves one beat later, the end stays, the offset follows.
  const c2 = (await clip(page, 0, 0).boundingBox())!;
  const beat = await at(page, 0, 2 * BAR + BEAT);
  await drag(page, { x: c2.x + 2, y: c2.y + 5 }, { x: beat.x, y: c2.y + 5 });
  expect(await pos(page, 0, 0)).toEqual({ start: 2 * BAR + BEAT, len: BAR - BEAT });
  await expect(clip(page, 0, 0)).toHaveAttribute('data-offset', String(BEAT));

  // Cmd/Ctrl+D duplicates right after; arrows nudge by a beat.
  await clip(page, 0, 0).click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect(clip(page, 0, 1)).toHaveAttribute('data-start', String(3 * BAR));
  await expect(clip(page, 0, 1)).toHaveAttribute('data-selected', 'true');
  await expect(clip(page, 0, 0)).toHaveAttribute('data-selected', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(clip(page, 0, 1)).toHaveAttribute('data-start', String(3 * BAR + BEAT));
  await page.keyboard.press('ArrowLeft');
  await expect(clip(page, 0, 1)).toHaveAttribute('data-start', String(3 * BAR));
  await page.keyboard.press('Shift+ArrowRight'); // a bar
  await expect(clip(page, 0, 1)).toHaveAttribute('data-start', String(4 * BAR));

  // Cmd/Ctrl+A selects all; Escape clears; Shift-drag box-selects across lanes.
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.getByTestId('tl-readout')).toHaveText('3 clips selected');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tl-readout')).not.toContainText('selected');
  const lane1 = (await page.getByTestId('tl-lane-1').boundingBox())!;
  const bx0 = await at(page, 0, 5 * BAR);
  const bx1 = await at(page, 1, 2.5 * BAR);
  await drag(page, { x: bx0.x, y: bx0.y - 10 }, { x: bx1.x, y: lane1.y + 20 }, { shift: true });
  await expect(clip(page, 1, 0)).toHaveAttribute('data-selected', 'true'); // synth 0..4 bars
  await expect(clip(page, 0, 0)).toHaveAttribute('data-selected', 'true'); // drums 2.25..3 bars
  await expect(clip(page, 0, 1)).toHaveAttribute('data-selected', 'true'); // drums 4..4.75 bars
  await expect(page.getByTestId('tl-readout')).toHaveText('3 clips selected');

  // Context-menu Delete removes the selection.
  await clip(page, 1, 0).click({ button: 'right' });
  await expect(page.getByTestId('tl-menu-delete')).toHaveText('Delete 3 clips');
  await page.getByTestId('tl-menu-delete').click();
  await expect(page.locator('[data-testid^="clip-"]')).toHaveCount(0);
});

test('ruler click seeks (beat snap, Alt = free); keys bubble from the timeline', async ({ page }) => {
  await start(page);
  const songPos = () => page.evaluate(() => (window as any).__daw.project.songPosition);
  const r = (await page.getByTestId('tl-ruler').boundingBox())!;
  const p = await at(page, 0, 2 * BAR + 400);
  await page.mouse.click(p.x, r.y + 10);
  expect(await songPos()).toBe(2 * BAR); // +400 ticks -> nearest beat (bar 3)
  await page.keyboard.down('Alt');
  await page.mouse.click(p.x, r.y + 10);
  await page.keyboard.up('Alt');
  expect(Math.abs((await songPos()) - (2 * BAR + 400))).toBeLessThan(80); // free (within a pixel)

  // The lanes have focus (outside the bottom panel): Space toggles the song transport.
  await clickLane(page, 0, 100);
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__daw.project.playing)).toBe(true);
  expect(await page.evaluate(() => (window as any).__daw.project.mode)).toBe('song');
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__daw.project.playing)).toBe(false);
});

test('stopped after the pattern transport, the playlist is the song: loop live, parked marker, next song Play starts there', async ({ page }) => {
  await start(page);
  const ruler = page.getByTestId('tl-ruler');
  const d = () => page.evaluate(() => {
    const p = (window as any).__daw.project;
    return { mode: p.mode, playing: p.playing, pos: p.songPosition };
  });
  await page.getByTestId('loop-toggle').click(); // loop on (bars 1-4)
  await expect(ruler).toHaveAttribute('data-loop-live', '1');
  // The pattern transport plays: the song's loop and marker step back.
  await page.getByTestId('pattern-play').click();
  await expect(ruler).toHaveAttribute('data-loop-live', '0');
  await expect(ruler).toHaveAttribute('data-marker', 'none');
  await page.getByTestId('pattern-stop').click();
  // Stopped (Pattern ran last): drawn as the song again.
  expect(await d()).toMatchObject({ mode: 'pattern', playing: false });
  await expect(ruler).toHaveAttribute('data-loop-live', '1');
  await expect(ruler).toHaveAttribute('data-marker', 'parked');
  await expect(page.getByTestId('tl-readout')).not.toContainText('pattern transport');
  // A ruler click parks the song position, without the "play the song" hint.
  const r = (await ruler.boundingBox())!;
  const p = await at(page, 0, 2 * BAR + 100);
  await page.mouse.click(p.x, r.y + 10);
  expect((await d()).pos).toBe(2 * BAR);
  await expect(page.getByTestId('tl-readout')).not.toContainText('Song position set');
  // The next song Play starts from the parked marker.
  await page.getByTestId('play').click();
  await expect.poll(async () => (await d()).mode).toBe('song');
  await expect.poll(() => page.evaluate(() => (window as any).__daw.clock.heardTicks()), { timeout: 3000 }).toBeGreaterThan(2 * BAR);
  expect(await page.evaluate(() => (window as any).__daw.clock.heardTicks())).toBeLessThan(4 * BAR);
  await expect(ruler).toHaveAttribute('data-marker', 'live');
  await page.getByTestId('song-stop').click();
});

test('timeline screenshot', async ({ page }) => {
  test.setTimeout(40_000);
  await start(page);
  await dropSample(page, 0, 'kick', 100);
  await steps(page, 0, [0, 4, 8, 12]);
  await page.getByTestId('pattern-new').click();
  await steps(page, 0, [0, 6, 10]);
  await page.getByTestId('pattern-picker').selectOption({ label: 'Pattern 1' });
  await clickLane(page, 0, 100);
  await resizeRight(page, 0, 0, 4 * BAR);
  await page.getByTestId('pattern-picker').selectOption({ label: 'Pattern 2' });
  await clickLane(page, 0, 4 * BAR + 100);
  await resizeRight(page, 0, 1, 6 * BAR);
  await page.getByTestId('add-synth-track').click();
  await clickLane(page, 1, 2 * BAR + 100);
  await clickLane(page, 1, 8 * BAR + 100);
  await page.getByTestId('add-drum-track').click();
  await clickLane(page, 2, 4 * BAR + 100);
  await clickLane(page, 2, 5 * BAR + 100);
  const a = await at(page, 0, 100);
  const b = await at(page, 0, 7 * BAR + 100);
  const r = (await page.getByTestId('tl-ruler').boundingBox())!;
  await drag(page, { x: a.x, y: r.y + 10 }, { x: b.x, y: r.y + 10 }); // loop bars 1-8
  await clip(page, 0, 1).click();
  await play(page);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: 'test-results/timeline.png' });
});

test('placing: Escape removes the just-placed clip; a tail click places after the clip', async ({ page }) => {
  await start(page);
  // Escape mid place-and-drag: the clip never existed.
  const p0 = await at(page, 0, 100);
  await drag(page, p0, { x: p0.x + 80, y: p0.y }, { up: false });
  await expect(clip(page, 0, 0)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('[data-testid^="clip-"]')).toHaveCount(0);

  // A clip cut to 1.5 bars; a click in bar 2's empty second half places the
  // next clip at the clip's end (bar 2 + 0.5 bar), not overlapping it.
  await clickLane(page, 0, 100);
  await resizeRight(page, 0, 0, BAR + BAR / 2);
  expect(await pos(page, 0, 0)).toEqual({ start: 0, len: BAR + BAR / 2 });
  await clickLane(page, 0, BAR + BAR / 2 + 200);
  expect((await pos(page, 0, 1)).start).toBe(BAR + BAR / 2);
});

test('the add-track buttons are disabled at 32 tracks and come back when one is removed', async ({ page }) => {
  await start(page);
  // The default drum track + 31 more = MAX_TRACKS (32).
  await page.evaluate(() => { for (let i = 0; i < 31; i++) (window as any).__daw.actions.addDrumTrack(); });
  await expect.poll(() => page.evaluate(() => (window as any).__daw.project.tracks.length)).toBe(32);
  for (const id of ['add-drum-track', 'add-synth-track']) {
    await expect(page.getByTestId(id)).toBeDisabled();
    await expect(page.getByTestId(id)).toHaveAttribute('title', /32 tracks/);
  }
  await page.evaluate(() => {
    const d = (window as any).__daw;
    d.actions.removeTrack(d.project.tracks[5].id);
  });
  await expect(page.getByTestId('add-synth-track')).toBeEnabled();
  await page.getByTestId('add-synth-track').click();
  await expect(page.getByTestId('add-drum-track')).toBeDisabled();
});

test('loop drag while playing sends the loop once, on release; Escape sends nothing', async ({ page }) => {
  await start(page);
  await play(page);
  await page.evaluate(() => {
    const d = (window as any).__daw;
    const e = d.engine;
    const orig = e.send.bind(e);
    d.loopSends = [];
    e.send = (op: number, ...a: number[]) => { if (op === d.Op.SET_LOOP) d.loopSends.push(a.slice(0, 2)); return orig(op, ...a); };
  });
  const sends = () => page.evaluate(() => (window as any).__daw.loopSends);
  const a = await at(page, 0, 2 * BAR + 500);
  const b = await at(page, 0, 4 * BAR + 500);
  const r = (await page.getByTestId('tl-ruler').boundingBox())!;
  await drag(page, { x: a.x, y: r.y + 10 }, { x: b.x, y: r.y + 10 }, { up: false });
  // The loop previews on the ruler but nothing reaches the engine mid-drag.
  await expect(page.getByTestId('tl-ruler')).toHaveAttribute('data-loop', `${2 * BAR},${5 * BAR},1`);
  await page.waitForTimeout(100);
  expect(await sends()).toEqual([]);
  await page.mouse.up();
  await expect.poll(sends).toEqual([[2 * BAR, 5 * BAR]]);
  // Escape mid-drag: the old loop is back, and the engine never heard of the new one.
  const c = await at(page, 0, 6 * BAR + 500);
  await drag(page, { x: b.x, y: r.y + 10 }, { x: c.x, y: r.y + 10 }, { up: false });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByTestId('tl-ruler')).toHaveAttribute('data-loop', `${2 * BAR},${5 * BAR},1`);
  await page.waitForTimeout(100);
  expect(await sends()).toEqual([[2 * BAR, 5 * BAR]]);
});

test('clicking a note clip selects its track (as an audio clip does)', async ({ page }) => {
  await start(page);
  await page.getByTestId('add-synth-track').click(); // slot 1
  await clickLane(page, 0, 100);
  await clickLane(page, 1, 100);
  const sel = () => page.evaluate(() => (window as any).__daw.project.selectedTrackId as string);
  const ids = await page.evaluate(() => (window as any).__daw.project.tracks.map((t: { id: string }) => t.id) as string[]);
  const a = (await clip(page, 0, 0).boundingBox())!;
  await page.mouse.click(a.x + a.width / 2, a.y + a.height / 2);
  await expect.poll(sel).toBe(ids[0]);
  const b = (await clip(page, 1, 0).boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect.poll(sel).toBe(ids[1]);
  await expect(clip(page, 1, 0)).toHaveAttribute('data-selected', 'true');
});
