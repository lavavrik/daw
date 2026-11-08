import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// Automation lanes on the timeline (plan 10 Task 3): the A toggle opens a
// track's lanes under its clip row, "+ Lane" picks a target, clicks add
// points, Cmd/Ctrl-drag draws, right-click a point for Linear / Hold, the
// Master row for the master and the returns, and what the engine plays.
// Tempo 240 throughout: one bar = 1 s.

const BAR = 3840;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.project.tempo)).toBe(bpm);
}

type View = { ticksPerPx: number; scrollTick: number };
async function view(page: Page): Promise<View> {
  return JSON.parse((await page.getByTestId('timeline').getAttribute('data-view'))!);
}

/** Drop Finder WAVs on element `testid` (its middle, near the top) at song tick `tick`. */
async function dropFiles(page: Page, testid: string, tick: number, files: { name: string; bytes: number[] }[]) {
  const v = await view(page);
  const lane0 = (await page.getByTestId('tl-lane-0').boundingBox())!;
  const x = lane0.x + (tick - v.scrollTick) / v.ticksPerPx;
  const b = (await page.getByTestId(testid).boundingBox())!;
  await page.evaluate(
    ({ testid, files, x, y }) => {
      const el = document.querySelector(`[data-testid="${testid}"]`)!;
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'audio/wav' }));
      for (const t of ['dragenter', 'dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
      }
    },
    { testid, files, x, y: b.y + Math.min(b.height / 2, 14) },
  );
}

type T = { id: string; slot: number; kind: string; clips: number };
const tracks = (page: Page): Promise<T[]> =>
  page.evaluate(() => (window as Any).__daw.project.tracks.map((t: Any) => ({ id: t.id, slot: t.slot, kind: t.kind, clips: t.clips.length })));

/** Drop a `secs` long sine below the lanes: a new audio track; returns its slot. */
async function dropBelow(page: Page, name: string, secs: number, freq = 220) {
  const before = (await tracks(page)).length;
  await dropFiles(page, 'tl-below', 0, [{ name: `${name}.wav`, bytes: [...makeWav(freq, secs * 1000)] }]);
  await expect.poll(async () => (await tracks(page)).length).toBe(before + 1);
  const t = (await tracks(page)).at(-1)!;
  await expect(page.getByTestId(`clip-${t.slot}-0`)).toHaveAttribute('data-pattern', name);
  return t.slot;
}

/** The saved form of the lanes: a track's (by slot) or the Master row's. Points sorted by tick. */
async function savedLanes(page: Page, slot: number | 'master') {
  const lanes: Any[] = await page.evaluate((slot) => {
    const j = (window as Any).__daw.snapshot();
    if (slot === 'master') return j.mixer.automation;
    return j.tracks.find((x: Any) => x.slot === slot).automation;
  }, slot);
  return lanes.map((l) => ({ ...l, points: [...l.points].sort((a: number[], b: number[]) => a[0] - b[0]) }));
}

const PAD = 6;
const H = 48;
/** Page point of song tick `tick` at knob position `pos` (0 bottom .. 1 top) in automation lane `testid`. */
async function lanePt(page: Page, testid: string, tick: number, pos: number) {
  const v = await view(page);
  // The Song pane is short: rows below scroll (centred: clear of the sticky footer).
  await page.getByTestId(testid).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const b = (await page.getByTestId(testid).boundingBox())!;
  return { x: b.x + (tick - v.scrollTick) / v.ticksPerPx, y: b.y + PAD + (1 - pos) * (H - 2 * PAD) };
}
/** Knob position of a fader value (dB): the fader is linear, -60..+6. */
const faderPos = (db: number) => (db + 60) / 66;

async function clickLane(page: Page, testid: string, tick: number, pos: number, opts: { button?: 'right' } = {}) {
  const p = await lanePt(page, testid, tick, pos);
  await page.mouse.click(p.x, p.y, opts);
}

/** Open slot's lanes (A) and add a lane on the target labelled `label`; returns the new lane's testid. */
async function addLane(page: Page, slot: number | 'master', label: string) {
  const owner = slot === 'master' ? 'm' : String(slot);
  const toggle = page.getByTestId(slot === 'master' ? 'master-auto' : `track-auto-${slot}`);
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const before = await page.locator(`[data-testid^="auto-lane-${owner}-"]`).count();
  await page.getByTestId(`auto-add-${owner}`).last().selectOption({ label });
  const id = `auto-lane-${owner}-${before}`;
  await expect(page.getByTestId(id)).toBeVisible();
  return id;
}

/** Samples telemetry {ticks, peakL} every 4 ms for `ms`. */
function record(page: Page, ms: number) {
  return page.evaluate(
    (ms) =>
      new Promise<{ t: number; peak: number }[]>((resolve) => {
        const eng = (window as Any).__daw.engine;
        const out: { t: number; peak: number }[] = [];
        const t0 = performance.now();
        const id = setInterval(() => {
          const tele = eng.telemetry();
          out.push({ t: tele[2], peak: tele[5] });
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

/** Song mode, from tick 0: play and record `ms`, then stop. */
async function playSong(page: Page, ms: number) {
  await page.getByTestId('mode-song').click();
  await page.evaluate(() => (window as Any).__daw.actions.seek(0));
  await page.getByTestId('play').click();
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.engine.telemetry()[1])).toBe(1);
  const rec = await record(page, ms);
  await page.getByTestId('play').click();
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.engine.telemetry()[1])).toBe(0);
  return rec;
}

const undoKey = 'ControlOrMeta+z';

test('add a fader lane and draw a ride', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 4);
  const lane = await addLane(page, slot, 'Fader');
  await expect(page.getByTestId(`auto-head-${slot}-0`)).toContainText('Fader');
  // Two clicks: −24 dB at bar 1, 0 dB at bar 2 (snapped to the 1/16 grid).
  await clickLane(page, lane, 50, faderPos(-24));
  await clickLane(page, lane, BAR + 30, faderPos(0));
  const [l] = await savedLanes(page, slot);
  expect(l.target).toEqual({ mix: 'fader' });
  expect(l.enabled).toBe(true);
  expect(l.points.map((x: number[]) => x[0])).toEqual([0, BAR]);
  expect(l.points[0][1]).toBeGreaterThan(-27);
  expect(l.points[0][1]).toBeLessThan(-21);
  expect(l.points[1][1]).toBeGreaterThan(-3);
  expect(l.points[1][1]).toBeLessThan(3);
  expect(l.points.map((x: number[]) => x[2])).toEqual([0, 0]);
  await page.screenshot({ path: 'test-results/automation-ride.png' });

  // Song mode: the master peak rises across the bar, quarter by quarter.
  const rec = await playSong(page, 1400);
  const q = [0, 1, 2, 3].map((k) => peakIn(rec, (k * BAR) / 4 + 100, ((k + 1) * BAR) / 4));
  console.log('ride quarters', q.map((x) => x.toFixed(3)).join(' '));
  for (let k = 1; k < 4; k++) expect(q[k]).toBeGreaterThan(q[k - 1] * 1.3);
  expect(q[3]).toBeGreaterThan(q[0] * 4);
});

test('hold point makes a drop', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 4);
  const lane = await addLane(page, slot, 'Fader');
  await clickLane(page, lane, 0, faderPos(0));
  await clickLane(page, lane, BAR, 0); // −∞
  // Right-click the first point: Hold (the level stays until the next point, then drops).
  await clickLane(page, lane, 0, faderPos(0), { button: 'right' });
  await page.getByTestId('auto-menu-hold').click();
  await expect(page.getByTestId('auto-menu')).toBeHidden();
  const [l] = await savedLanes(page, slot);
  expect(l.points.map((x: number[]) => [x[0], x[2]])).toEqual([[0, 1], [BAR, 0]]);
  expect(l.points[1][1]).toBe(-60);

  const rec = await playSong(page, 1500);
  const ms10 = (10 / 1000) * (BAR / 1); // ticks in 10 ms (1 bar = 1 s)
  expect(peakIn(rec, BAR - 1500, BAR)).toBeGreaterThan(0.3); // full level up to the point
  const after = rec.filter((r) => r.t >= BAR + ms10 && r.t < BAR + 1800);
  expect(after.length).toBeGreaterThan(3);
  expect(Math.max(...after.map((r) => r.peak))).toBeLessThan(0.01); // silent within 10 ms of it
});

test('freehand draw is thinned', async ({ page }) => {
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 2);
  const lane = await addLane(page, slot, 'Fader');
  // A straight Cmd/Ctrl stroke from the bottom left to the top right: 36 px up over 144 px.
  const a = await lanePt(page, lane, 0, 0);
  const b = { x: a.x + 144, y: a.y - 36 };
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 36 });
  await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');
  const [l] = await savedLanes(page, slot);
  console.log(`straight stroke -> ${l.points.length} points`);
  expect(l.points.length).toBeGreaterThanOrEqual(2);
  expect(l.points.length).toBeLessThanOrEqual(20);
  expect(l.points[0][1]).toBe(-60);
  expect(l.points.at(-1)[1]).toBeCloseTo(6, 0);
});

test('undo removes a drawn gesture in one step', async ({ page }) => {
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 2);
  const lane = await addLane(page, slot, 'Fader');
  await clickLane(page, lane, 0, 0.2);
  await clickLane(page, lane, 2 * BAR, 0.8);
  const before = await savedLanes(page, slot);
  expect(before[0].points).toHaveLength(2);
  // A wavy stroke over the middle: many points, one gesture.
  const a = await lanePt(page, lane, BAR / 2, 0.1);
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let k = 1; k <= 30; k++) await page.mouse.move(a.x + k * 3, a.y - 30 * Math.abs(Math.sin(k / 3)));
  await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');
  const drawn = await savedLanes(page, slot);
  expect(drawn[0].points.length).toBeGreaterThan(5);
  // One undo takes the whole stroke back; redo brings it again.
  await page.keyboard.press(undoKey);
  await expect.poll(() => savedLanes(page, slot)).toEqual(before);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => savedLanes(page, slot)).toEqual(drawn);
});

// Plan 16 Task 5: Cmd/Ctrl+Z during a point drag cancels the drag: the point
// goes back, no entry is made and no older entry is undone.
test('undo during a point drag cancels the drag', async ({ page }) => {
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 2);
  const lane = await addLane(page, slot, 'Fader');
  await clickLane(page, lane, BAR, 0.5);
  const before = await savedLanes(page, slot);
  expect(before[0].points).toHaveLength(1);
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Add automation point/); // the click's gesture closed
  const undoTitle = await page.getByTestId('undo').getAttribute('title');
  const a = await lanePt(page, lane, BAR, 0.5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 15, { steps: 6 });
  await expect.poll(async () => (await savedLanes(page, slot))[0].points).not.toEqual(before[0].points);
  await page.keyboard.press(undoKey);
  await expect.poll(() => savedLanes(page, slot)).toEqual(before);
  await page.mouse.move(a.x + 80, a.y + 20, { steps: 4 }); // the cancelled drag moves nothing
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(await savedLanes(page, slot)).toEqual(before); // the point (the newest entry) is still there
  await expect(page.getByTestId('undo')).toHaveAttribute('title', undoTitle!);
  // Released: Cmd+Z is the normal undo again (takes the point away).
  await page.keyboard.press(undoKey);
  await expect.poll(async () => (await savedLanes(page, slot))[0]?.points ?? []).toHaveLength(0);
});

test('master row lane on the limiter ceiling', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await setTempo(page, 240);
  await dropBelow(page, 'tone', 4);
  await expect(page.getByTestId('tl-master-row')).toHaveCount(0);
  await page.getByTestId('tl-master-toggle').click();
  await expect(page.getByTestId('tl-master-row')).toBeVisible();
  const lane = await addLane(page, 'master', 'Master · Ceiling');
  await expect(page.getByTestId('auto-head-m-0')).toContainText('Master · Ceiling');
  // −6 dB held through bar 1, then 0 dB.
  await clickLane(page, lane, 0, 0);
  await clickLane(page, lane, BAR, 1);
  await clickLane(page, lane, 0, 0, { button: 'right' });
  await page.getByTestId('auto-menu-hold').click();
  const [l] = await savedLanes(page, 'master');
  expect(l).toMatchObject({ channel: 'master', target: { mix: 'limiter_ceiling' }, enabled: true });
  expect(l.points).toEqual([[0, -6, 1], [BAR, 0, 0]]);
  // The Master row stays while it has a lane: no toggle to hide it.
  await expect(page.getByTestId('tl-master-toggle')).toHaveCount(0);

  const rec = await playSong(page, 2200);
  const held = peakIn(rec, 600, BAR);
  const open = peakIn(rec, BAR + 600, 2 * BAR);
  console.log(`ceiling lane: bar 1 ${held.toFixed(3)}, bar 2 ${open.toFixed(3)}`);
  expect(held).toBeLessThan(0.52); // −6 dB
  expect(open).toBeGreaterThan(held + 0.1);
});

test('removing a module removes its lane, undo restores it', async ({ page }) => {
  await start(page);
  await page.getByTestId('add-synth-track').click();
  const t = (await tracks(page)).at(-1)!;
  expect(t.kind).toBe('synth');
  const lane = await addLane(page, t.slot, 'Filter · Cutoff');
  await clickLane(page, lane, 0, 0.3);
  await clickLane(page, lane, BAR, 0.9);
  const before = await savedLanes(page, t.slot);
  expect(before).toHaveLength(1);
  expect(before[0].target).toEqual({ rack: [4, 'cutoff'] });
  // The rack's × on the Filter.
  await page.getByTestId(`track-${t.slot}`).click();
  await page.getByRole('button', { name: 'Instrument' }).click();
  await page.getByRole('button', { name: 'Remove Filter' }).click();
  await expect(page.getByTestId(lane)).toHaveCount(0);
  expect(await savedLanes(page, t.slot)).toEqual([]);
  await page.getByTestId('tl-lane-0').click({ position: { x: 5, y: 5 }, modifiers: ['Shift'] }); // focus, no edit
  await page.keyboard.press(undoKey);
  await expect(page.getByTestId(lane)).toBeVisible();
  await expect.poll(() => savedLanes(page, t.slot)).toEqual(before);
});

test('audio drop and cross-lane move with an open automation row above the target', async ({ page }) => {
  await start(page);
  await setTempo(page, 240);
  const a = await dropBelow(page, 'one', 1);
  const b = await dropBelow(page, 'two', 1, 330);
  // a's lanes open between the two audio tracks: a 48 px row above b.
  await addLane(page, a, 'Fader');
  await addLane(page, a, 'Pan');
  const la = (await page.getByTestId(`tl-lane-${a}`).boundingBox())!;
  const lb = (await page.getByTestId(`tl-lane-${b}`).boundingBox())!;
  expect(lb.y - la.y).toBe(28 + 2 * 48);
  // A drop on b's row lands on b ...
  await dropFiles(page, `tl-lane-${b}`, 2 * BAR, [{ name: 'three.wav', bytes: [...makeWav(440, 500)] }]);
  await expect.poll(async () => (await tracks(page)).filter((x) => x.kind === 'audio').map((x) => x.clips)).toEqual([1, 2]);
  // ... a drop on a's automation lane is refused with the hint.
  await dropFiles(page, 'auto-lane-' + a + '-0', 3 * BAR, [{ name: 'four.wav', bytes: [...makeWav(440, 500)] }]);
  await expect(page.getByTestId('tl-readout')).toContainText('Drop audio on an audio track');
  expect((await tracks(page)).filter((x) => x.kind === 'audio').map((x) => x.clips)).toEqual([1, 2]);
  // A clip dragged from a down over the automation rows onto b moves to b.
  const from = (await page.getByTestId(`clip-${a}-0`).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, la.y + 28 + 30, { steps: 4 }); // over a lane row: stays on a
  await expect.poll(async () => (await tracks(page)).filter((x) => x.kind === 'audio').map((x) => x.clips)).toEqual([1, 2]);
  await page.mouse.move(from.x + from.width / 2, lb.y + 14, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await tracks(page)).filter((x) => x.kind === 'audio').map((x) => x.clips)).toEqual([0, 3]);
});

test('lane keys: select all, nudge, delete; enable and remove from the header', async ({ page }) => {
  await start(page);
  const t = (await tracks(page))[0];
  const lane = await addLane(page, t.slot, 'Fader');
  await clickLane(page, lane, BAR, 0.5);
  await clickLane(page, lane, 2 * BAR, 0.5);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ArrowRight'); // 1/16
  await page.keyboard.press('Shift+ArrowLeft'); // a beat
  expect((await savedLanes(page, t.slot))[0].points.map((x: number[]) => x[0])).toEqual([BAR - 720, 2 * BAR - 720]);
  // Other keys bubble: Space still starts the transport.
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.project.playing)).toBe(true);
  await page.keyboard.press('Space');
  await page.keyboard.press('Delete');
  expect((await savedLanes(page, t.slot))[0].points).toEqual([]);
  // The header's enable toggle and ×.
  await page.getByTestId(`auto-enable-${t.slot}-0`).click();
  expect((await savedLanes(page, t.slot))[0].enabled).toBe(false);
  await page.getByTestId(`auto-remove-${t.slot}-0`).click();
  expect(await savedLanes(page, t.slot)).toEqual([]);
});

test('the play-follow page flip waits for a lane gesture to end', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 2);
  const lane = await addLane(page, slot, 'Fader');
  // Zoom in to about two bars (two seconds), so the playhead runs off the right edge soon.
  const box = (await page.getByTestId(lane).boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.wheel(0, -1000);
  await page.keyboard.up('ControlOrMeta');
  await expect.poll(async () => (await view(page)).ticksPerPx).toBeLessThan(20);
  await page.getByTestId('tl-hscroll').fill('0'); // back to the song start
  const v0 = await view(page);
  expect(v0.scrollTick).toBe(0);
  const visibleTicks = box.width * v0.ticksPerPx;
  await page.getByTestId('mode-song').click();
  await page.evaluate(() => (window as Any).__daw.actions.seek(0));
  await page.getByTestId('play').click();
  // A freehand stroke held while the playhead passes the right edge.
  const a = await lanePt(page, lane, Math.round(visibleTicks * 0.1), 0.2);
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let k = 1; k <= 30; k++) {
    await page.mouse.move(a.x + k * 4, a.y - (k % 2 ? 10 : 0));
    await page.waitForTimeout(100);
  }
  await expect.poll(() => page.evaluate(() => Number((document.querySelector('[data-testid="timeline"]') as HTMLElement).dataset.playhead))).toBeGreaterThan(visibleTicks);
  expect((await view(page)).scrollTick).toBe(0); // no page flip mid-gesture
  await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');
  // The stroke's points are where it was drawn, in the first page ...
  const [l] = await savedLanes(page, slot);
  expect(l.points.length).toBeGreaterThan(2);
  for (const pt of l.points) expect(pt[0]).toBeLessThan(visibleTicks);
  // ... and once the gesture ends the view follows the playhead again.
  await expect.poll(async () => (await view(page)).scrollTick).toBeGreaterThan(0);
  await page.getByTestId('play').click();
});

test('a loaded Master row stays when its last lane goes; the 64-lane cap is shown', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await page.getByTestId('tl-master-toggle').click();
  await addLane(page, 'master', 'Master · Ceiling');
  const name = `e2e-auto-master-${test.info().workerIndex}`;
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name, { recursive: true }).catch(() => {});
    const dir = await root.getDirectoryHandle(name, { create: true });
    await (window as Any).__daw.saveTo(dir);
  }, name);
  // A new session opens it: the row is there because of its lane ...
  await start(page);
  await page.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    await (window as Any).__daw.openFrom(dir);
  }, name);
  await expect(page.getByTestId('tl-master-row')).toBeVisible();
  await page.getByTestId('master-auto').click(); // its lanes: open the row
  await expect(page.getByTestId('auto-lane-m-0')).toBeVisible();
  // ... and removing that lane keeps it (its × hides it).
  await page.getByTestId('auto-remove-m-0').click();
  await expect(page.getByTestId('tl-master-row')).toBeVisible();
  await expect(page.getByTestId('auto-head-m-new')).toBeVisible();

  // 64 lanes: "+ Lane" is disabled and says why.
  const t = (await tracks(page))[0];
  await addLane(page, t.slot, 'Fader');
  await expect(page.getByTestId('auto-full')).toHaveCount(0);
  await page.evaluate(() => {
    const d = (window as Any).__daw;
    const ids: string[] = [];
    for (let i = 0; i < 31; i++) ids.push(d.actions.addDrumTrack().id);
    return ids;
  });
  for (const x of (await tracks(page)).slice(1, 32)) {
    await page.getByTestId(`track-auto-${x.slot}`).click();
    await page.getByTestId(`auto-add-${x.slot}`).selectOption({ label: 'Fader' });
    await page.getByTestId(`auto-add-${x.slot}`).selectOption({ label: 'Pan' });
  }
  await page.getByTestId(`auto-add-${t.slot}`).selectOption({ label: 'Pan' });
  await expect(page.getByTestId(`auto-add-${t.slot}`)).toBeDisabled();
  await expect(page.getByTestId('auto-full').first()).toHaveText('64 max');
});

// ---- Task 4: knobs and faders follow automation; manual override; "Automate" ----

test('knob ring follows a cutoff lane while playing', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await setTempo(page, 240);
  await page.getByTestId('add-synth-track').click();
  const t = (await tracks(page)).at(-1)!;
  const lane = await addLane(page, t.slot, 'Filter · Cutoff');
  await clickLane(page, lane, 0, 0.1);
  await clickLane(page, lane, BAR, 0.9);
  await page.getByTestId(`track-${t.slot}`).click();
  await page.getByRole('button', { name: 'Instrument' }).click();
  const knob = page.getByTestId('knob-4-cutoff');
  // Pattern mode: the lane plays nothing, the knob shows its own value; the A badge says it has a lane.
  await expect(knob).toHaveAttribute('data-auto', 'idle');
  await expect(knob.getByTestId('auto-badge')).toBeVisible();
  await expect(knob).toHaveAttribute('title', /Automated — dragging overrides until the next point/);
  // Song mode, stopped at 0: the ring is at the first point.
  await page.getByTestId('mode-song').click();
  await page.evaluate(() => (window as Any).__daw.actions.seek(0));
  await expect(knob).toHaveAttribute('data-auto', 'on');
  await page.getByTestId('module-4').screenshot({ path: 'test-results/automation-knob.png' });
  const pos0 = Number(await knob.getAttribute('data-auto-pos'));
  expect(pos0).toBeGreaterThan(0.05);
  expect(pos0).toBeLessThan(0.15);
  // Play: the ring follows the line at the heard tick.
  await page.getByTestId('play').click();
  const samples: { t: number; pos: number }[] = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const out: { t: number; pos: number }[] = [];
        const el = document.querySelector('[data-testid="knob-4-cutoff"]')!;
        const t0 = performance.now();
        const step = () => {
          out.push({ t: (window as Any).__daw.clock.heardTicks(), pos: Number(el.getAttribute('data-auto-pos')) });
          if (performance.now() - t0 < 1400) requestAnimationFrame(step);
          else resolve(out);
        };
        requestAnimationFrame(step);
      }),
  );
  await page.getByTestId('play').click();
  const pos1 = samples.at(-1)!.pos; // after the last point: its value
  expect(pos1).toBeGreaterThan(0.85);
  expect(pos1).toBeLessThan(0.95);
  const mid = samples.filter((s) => s.t > 200 && s.t < BAR - 200);
  expect(mid.length).toBeGreaterThan(20);
  let worst = 0;
  for (const s of mid) worst = Math.max(worst, Math.abs(s.pos - (pos0 + ((pos1 - pos0) * s.t) / BAR)));
  console.log(`cutoff ring: ${mid.length} frames, worst ${worst.toFixed(4)} off the line`);
  expect(worst).toBeLessThan(0.03); // within a frame (16 ms = 1.6 % of the bar) of the heard tick
});

test('manual move overrides until the next breakpoint', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 4);
  const lane = await addLane(page, slot, 'Fader');
  // A quiet ride: −40 dB, −36 dB at bar 2, −40 dB at bar 3.
  await clickLane(page, lane, 0, faderPos(-40));
  await clickLane(page, lane, BAR, faderPos(-36));
  await clickLane(page, lane, 2 * BAR, faderPos(-40));
  await page.getByTestId('mixer-tab').click();
  const strip = page.getByTestId(`strip-${slot}`);
  const fader = strip.getByTestId('fader');
  await expect(fader).toHaveAttribute('data-auto', 'idle');
  await page.getByTestId('mode-song').click();
  await page.evaluate(() => (window as Any).__daw.actions.seek(0));
  await expect(fader).toHaveAttribute('data-auto', 'on');
  await page.getByTestId('play').click();
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.engine.telemetry()[1])).toBe(1);
  const rec = record(page, 2400);
  await page.waitForTimeout(350);
  // Mid-ride: drag the fader up (from where the lane has it) to +6 dB.
  const b = (await fader.boundingBox())!;
  const tDown: number = await page.evaluate(() => (window as Any).__daw.engine.telemetry()[2]);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 12);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y - 200, { steps: 4 });
  await page.mouse.up();
  const tUp: number = await page.evaluate(() => (window as Any).__daw.engine.telemetry()[2]);
  expect(tUp).toBeLessThan(BAR - 1000);
  await expect(fader).toHaveAttribute('data-auto', 'suspended');
  await expect(strip.getByTestId('fader-readout')).toHaveText('+6.0 dB'); // the base changed
  await strip.screenshot({ path: 'test-results/automation-fader-suspended.png' });
  // The lane takes over again at its next point (bar 2).
  await expect(fader).toHaveAttribute('data-auto', 'on', { timeout: 3000 });
  const r = await rec;
  await page.getByTestId('play').click();
  const before = peakIn(r, 300, tDown);
  const held = peakIn(r, tUp + 200, BAR - 40);
  const after = peakIn(r, BAR + 100, 2 * BAR - 100);
  console.log(`override: before ${before.toFixed(4)}, held ${held.toFixed(3)}, after the point ${after.toFixed(4)}`);
  expect(before).toBeLessThan(0.03); // the lane's −40 dB
  expect(held).toBeGreaterThan(0.3); // the hand's +6 dB, heard at once
  expect(after).toBeLessThan(0.03); // back on the lane (−36 dB) from the point
  // The move was an edit (the base): one undo puts the old base back. The lane is unchanged.
  await page.keyboard.press(undoKey);
  // (Stopped at 0 in Song mode the lane applies: the readout shows its value, the base is in the title.)
  await expect(fader).toHaveAttribute('title', /base 0\.0 dB/);
  expect((await savedLanes(page, slot))[0].points).toHaveLength(3);
});

test('Automate on a fader opens its lane', async ({ page }) => {
  await start(page);
  const t = (await tracks(page))[0];
  await page.getByTestId('mixer-tab').click();
  await expect(page.getByTestId('tl-master-row')).toHaveCount(0);
  // The master fader: right-click -> Automate. The Master row opens with the new lane, in view.
  await page.getByTestId('strip-master').getByTestId('fader').click({ button: 'right' });
  const menu = page.getByTestId('auto-ctl-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('auto-ctl-automate')).toHaveText('Automate');
  await page.getByTestId('auto-ctl-automate').click();
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('tl-master-row')).toBeVisible();
  await expect(page.getByTestId('auto-lane-m-0')).toBeInViewport();
  const [m] = await savedLanes(page, 'master');
  expect(m).toMatchObject({ channel: 'master', target: { mix: 'fader' }, enabled: true, points: [] });
  // Again: "Show automation", no second lane.
  await page.getByTestId('strip-master').getByTestId('fader').click({ button: 'right' });
  await expect(page.getByTestId('auto-ctl-automate')).toHaveText('Show automation');
  await page.getByTestId('auto-ctl-automate').click();
  expect(await savedLanes(page, 'master')).toHaveLength(1);
  // A track's pan knob: the track's lanes open with it. Escape closes the menu without acting.
  const pan = page.getByTestId(`strip-${t.slot}`).getByTestId('knob-pan');
  await pan.click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(await savedLanes(page, t.slot)).toEqual([]);
  await pan.click({ button: 'right' });
  await page.getByTestId('auto-ctl-automate').click();
  await expect(page.getByTestId(`track-auto-${t.slot}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId(`auto-lane-${t.slot}-0`)).toBeInViewport();
  expect((await savedLanes(page, t.slot)).map((l) => l.target)).toEqual([{ mix: 'pan' }]);
  await expect(pan).toHaveAttribute('data-auto', 'idle');
});

test('automated readouts and arrow keys follow the heard value', async ({ page }) => {
  await start(page);
  const t = (await tracks(page))[0];
  const fl = await addLane(page, t.slot, 'Fader');
  await clickLane(page, fl, 0, faderPos(-40));
  await clickLane(page, fl, BAR, faderPos(-20));
  await page.mouse.move(0, 0); // no hover tip (its testid shares the lanes' prefix)
  const pl = await addLane(page, t.slot, 'Pan');
  await clickLane(page, pl, 0, 0.1);
  await clickLane(page, pl, BAR, 0.3);
  await page.getByTestId('mixer-tab').click();
  const strip = page.getByTestId(`strip-${t.slot}`);
  const fader = strip.getByTestId('fader');
  const readout = strip.getByTestId('fader-readout');
  const db = (s: string | null) => Number(s!.replace('−', '-').replace(' dB', ''));
  await expect(readout).toHaveText('0.0 dB'); // Pattern mode: the base
  await page.getByTestId('mode-song').click();
  await page.evaluate((tick) => (window as Any).__daw.actions.seek(tick), BAR / 2);
  await expect(fader).toHaveAttribute('data-auto', 'on');
  const v = Number(await fader.getAttribute('data-auto-value'));
  expect(v).toBeGreaterThan(-32);
  expect(v).toBeLessThan(-28);
  // The readout, aria and value show what is heard, marked as automated; the base is in the title.
  await expect(readout).toHaveAttribute('data-auto', 'on');
  expect(db(await readout.textContent())).toBeCloseTo(v, 1);
  await expect(fader).toHaveAttribute('aria-valuetext', /, automated \(base 0\.0 dB\)$/);
  // (aria follows at most 4 times a second: poll)
  await expect.poll(async () => Number(await fader.getAttribute('aria-valuenow'))).toBeCloseTo(v, 1);
  await expect(fader).toHaveAttribute('title', /base 0\.0 dB — Automated — dragging overrides until the next point/);
  // ArrowUp steps from the heard value (+1 dB), not from the base: it overrides, and the readout shows the new base.
  await fader.focus();
  await page.keyboard.press('ArrowUp');
  await expect(fader).toHaveAttribute('data-auto', 'suspended');
  await expect(readout).not.toHaveAttribute('data-auto', 'on');
  expect(db(await readout.textContent())).toBeCloseTo(Math.round((v + 1) * 10) / 10, 1);

  // A knob the same way (pan: 1 % of the travel per arrow).
  const pan = strip.getByTestId('knob-pan');
  await expect(pan).toHaveAttribute('data-auto', 'on');
  const pv = Number(await pan.getAttribute('data-auto-value'));
  await expect(pan.getByTestId('knob-readout')).toHaveAttribute('data-auto', 'on');
  await expect(pan).toHaveAttribute('aria-valuetext', /, automated \(base C\)$/);
  await expect.poll(async () => Number(await pan.getAttribute('aria-valuenow'))).toBeCloseTo(pv, 3);
  const span = Number(await pan.getAttribute('aria-valuemax')) - Number(await pan.getAttribute('aria-valuemin'));
  await pan.focus();
  await page.keyboard.press('ArrowUp');
  await expect(pan).toHaveAttribute('data-auto', 'suspended');
  await expect.poll(async () => Number(await pan.getAttribute('aria-valuenow'))).toBeCloseTo(pv + span / 100, 2);
});

test('Automate menu from the keyboard; the 64-lane cap', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  await page.getByTestId('mixer-tab').click();
  const menu = page.getByTestId('auto-ctl-menu');
  const mf = page.getByTestId('strip-master').getByTestId('fader');
  // Shift+F10 on the focused fader opens the menu with its item focused; Escape gives focus back.
  await mf.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('auto-ctl-automate')).toBeFocused();
  const box = (await menu.boundingBox())!;
  const fb = (await mf.boundingBox())!;
  expect(Math.abs(box.x - fb.x)).toBeLessThan(40); // placed at the control, not at the window's corner
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(mf).toBeFocused();
  // 64 lanes: 32 tracks with a Fader and a Pan lane each.
  await page.evaluate(() => {
    const d = (window as Any).__daw;
    for (let i = 0; i < 31; i++) d.actions.addDrumTrack();
  });
  for (const x of await tracks(page)) {
    await page.getByTestId(`track-auto-${x.slot}`).click();
    await page.getByTestId(`auto-add-${x.slot}`).last().selectOption({ label: 'Fader' });
    await page.getByTestId(`auto-add-${x.slot}`).last().selectOption({ label: 'Pan' });
  }
  await expect(page.locator('[data-testid^="auto-lane-"][data-lane]')).toHaveCount(64);
  // The ContextMenu key, Enter on "Automate": refused with the reason, nothing added.
  await mf.focus();
  await page.keyboard.press('ContextMenu');
  await expect(page.getByTestId('auto-ctl-automate')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('flash-hint')).toContainText('at most 64');
  expect(await savedLanes(page, 'master')).toEqual([]);
});

test('Alt-drag bends a segment: saved, heard, one undo step (plan 16)', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 4);
  const lane = await addLane(page, slot, 'Fader');
  // A ride from −60 dB to 0 dB over a bar, then flat.
  await clickLane(page, lane, 0, 0);
  await clickLane(page, lane, BAR, faderPos(0));
  const straight = await savedLanes(page, slot);
  expect(straight[0].points.map((x: number[]) => [x[0], Math.round(x[1]) || 0, x[2], x.length])).toEqual([[0, -60, 0, 3], [BAR, 0, 0, 3]]);
  // Alt-drag the middle of the line 30 px up: the first point's curve, 100 px = the full -1..1, so +0.6 (fast, then slow).
  const a = await lanePt(page, lane, BAR / 2, faderPos(0) / 2);
  await page.keyboard.down('Alt');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y - 30, { steps: 10 });
  await expect(page.getByTestId(`${lane}-tip`)).toContainText('Curve +0.6');
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const bent = await savedLanes(page, slot);
  expect(bent[0].points).toHaveLength(2);
  expect(bent[0].points[0].slice(0, 3)).toEqual([0, -60, 0]);
  expect(bent[0].points[0][3]).toBeCloseTo(0.6, 2);
  expect(bent[0].points[1]).toEqual(straight[0].points[1]);
  await page.screenshot({ path: 'test-results/automation-curve.png' });

  // One undo takes the bend back (the points stay); redo brings it again.
  // (Before playing: the switch to Song mode is an undo entry of its own.)
  await page.keyboard.press(undoKey);
  await expect.poll(() => savedLanes(page, slot)).toEqual(straight);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => savedLanes(page, slot)).toEqual(bent);

  // Heard: a quarter of the way the bent ride is at f(0.25) = 0.25^(2^-1.8) ≈ 0.67 of
  // the travel (≈ −20 dB) where the straight one was at −45 dB.
  const rec = await playSong(page, 1200);
  const q0 = peakIn(rec, 100, BAR / 4);
  const q3 = peakIn(rec, (3 * BAR) / 4, BAR);
  console.log('curved ride first/last quarter', q0.toFixed(4), q3.toFixed(4));
  expect(q0).toBeGreaterThan(0.05 * q3);
});

test('Alt-click on a line adds a free point; it bends nothing (plan 16, Ruling P)', async ({ page }) => {
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 2);
  const lane = await addLane(page, slot, 'Fader');
  await clickLane(page, lane, 0, 0.2);
  await clickLane(page, lane, BAR, 0.8);
  // On the straight line, off the 1/16 grid (240 ticks), with a 1 px jitter: still a click.
  const tick = BAR / 2 + 100;
  const at = await lanePt(page, lane, tick, 0.2 + (0.6 * tick) / BAR);
  await page.keyboard.down('Alt');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y + 1);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const [l] = await savedLanes(page, slot);
  expect(l.points).toHaveLength(3);
  for (const pt of l.points) expect(pt).toHaveLength(3); // no curve anywhere
  const { ticksPerPx } = await view(page);
  expect(Math.abs(l.points[1][0] - tick)).toBeLessThanOrEqual(ticksPerPx);
  expect(l.points[1][0] % 240).not.toBe(0);
  await expect(page.getByTestId(lane)).toHaveAttribute('data-selected', '1');
  // One undo entry: the point goes again.
  await page.keyboard.press(undoKey);
  await expect.poll(async () => (await savedLanes(page, slot))[0].points.length).toBe(2);
});
