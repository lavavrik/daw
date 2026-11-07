import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// Audio clips on the timeline (plan 9 Task 5): drops from Finder, the
// library and the starter kit onto audio lanes, waveform overviews, clip
// editing, and what the engine plays. Tempo 240 throughout: one bar = 1 s,
// one beat = 0.25 s, so a 2 s file is two bars long.

const BAR = 3840;
const BEAT = 960;

type AClip = { id: string; idx: number; sampleId: number | null; start: number; len: number; offset: number; loop: boolean; gain: number; fadeIn: number; fadeOut: number };
type Daw = {
  engine: { meters(): Float32Array; telemetry(): Float64Array } | null;
  project: {
    playing: boolean;
    mode: string;
    tempo: number;
    selectedTrackId: string | null;
    tracks: { id: string; slot: number; kind: string; name: string; clips: AClip[] }[];
    sampleMeta: Map<number, { seconds: number; peaks: unknown }>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, (...args: any[]) => any>;
  library: { attach(dir: FileSystemDirectoryHandle): Promise<void> };
};

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

type View = { ticksPerPx: number; scrollTick: number; laneH: number };
async function view(page: Page): Promise<View> {
  return JSON.parse((await page.getByTestId('timeline').getAttribute('data-view'))!);
}

/** Client x of song tick `tick` (lanes area). */
async function xOf(page: Page, tick: number) {
  const v = await view(page);
  const b = (await page.getByTestId('tl-lane-0').boundingBox())!;
  return b.x + (tick - v.scrollTick) / v.ticksPerPx;
}

/**
 * Drop Finder files (WAVs) on the element `testid` at song tick `tick`
 * (vertically: the element's middle).
 */
async function dropFiles(page: Page, testid: string, tick: number, files: { name: string; bytes: number[] }[]) {
  const x = await xOf(page, tick);
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

/** A Browser drag (library or kit sample `from`) dropped on `to` at song tick `tick`. */
async function dragSample(page: Page, from: string, to: string, tick: number) {
  const x = await xOf(page, tick);
  const b = (await page.getByTestId(to).boundingBox())!;
  await page.evaluate(
    ({ from, to, x, y }) => {
      const src = document.querySelector(`[data-testid="${from}"]`)!;
      const dst = document.querySelector(`[data-testid="${to}"]`)!;
      const dt = new DataTransfer();
      const ev = (el: Element, t: string) => el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
      ev(src, 'dragstart');
      for (const t of ['dragenter', 'dragover', 'drop']) ev(dst, t);
      ev(src, 'dragend');
    },
    { from, to, x, y: b.y + b.height / 2 },
  );
}

const audioTracks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.filter((t) => t.kind === 'audio').map((t) => ({ slot: t.slot, name: t.name, clips: t.clips.map((c) => ({ ...c })) })));

/** Max meter peak of strip `slot` over `ms`. */
function stripPeak(page: Page, slot: number, ms: number) {
  return page.evaluate(
    ({ slot, ms }) =>
      new Promise<number>((resolve) => {
        const eng = (window as unknown as { __daw: Daw }).__daw.engine!;
        let peak = 0;
        const id = setInterval(() => {
          const m = eng.meters();
          peak = Math.max(peak, m[slot * 3], m[slot * 3 + 1]);
        }, 10);
        setTimeout(() => (clearInterval(id), resolve(peak)), ms);
      }),
    { slot, ms },
  );
}

/** Drop a `secs` long sine below the lanes at tick 0: a new audio track; returns its slot. */
async function dropBelow(page: Page, name: string, secs: number, freq = 220) {
  const before = (await audioTracks(page)).length;
  await dropFiles(page, 'tl-below', 0, [{ name: `${name}.wav`, bytes: [...makeWav(freq, secs * 1000)] }]);
  await expect.poll(async () => (await audioTracks(page)).length).toBe(before + 1);
  const t = (await audioTracks(page)).at(-1)!;
  await expect(page.getByTestId(`clip-${t.slot}-0`)).toHaveAttribute('data-pattern', name);
  return t.slot;
}

const undoKey = 'ControlOrMeta+z';

test('drop a WAV below the lanes makes an audio track', async ({ page }) => {
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 2);
  const [t] = await audioTracks(page);
  expect(t.clips).toHaveLength(1);
  expect(t.clips[0]).toMatchObject({ start: 0, len: 2 * BAR, offset: 0, loop: false, gain: 0, fadeIn: 0, fadeOut: 0 });
  // The new track is selected and the Clip tab shows it.
  await expect(page.getByTestId('panel-title')).toHaveText(`${t.name} · tone`);
  await expect(page.getByTestId('cliptab-panel')).toBeVisible();
  await expect(page.getByTestId('track-' + slot)).toContainText('Audio');
  // Peaks computed: the clip says so, and the waveform canvas draws it.
  const clip = page.getByTestId(`clip-${slot}-0`);
  await expect(clip).toHaveAttribute('data-peaks', '1');
  const box = (await clip.boundingBox())!;
  const cv = (await page.getByTestId('tl-canvas').boundingBox())!;
  const color = await page.evaluate((slot) => (window as any).__daw.project.tracks.find((t: { slot: number }) => t.slot === slot).color as string, slot);
  /** Fraction of the pixels on the clip's middle row (its middle third: no name, no edges) drawn in the track colour. */
  const lit = () => page.evaluate(
    ({ x0, x1, y0, y1, color }) => {
      const c = document.querySelector('[data-testid="tl-canvas"]') as HTMLCanvasElement;
      const k = c.width / c.getBoundingClientRect().width;
      const d = c.getContext('2d')!.getImageData(Math.round((x0 + (x1 - x0) / 3) * k), Math.round(((y0 + y1) / 2) * k), Math.round(((x1 - x0) / 3) * k), 1).data;
      const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - rgb[0]) + Math.abs(d[i + 1] - rgb[1]) + Math.abs(d[i + 2] - rgb[2]) < 80) n++;
      return n / (d.length / 4);
    },
    { x0: box.x - cv.x, x1: box.x - cv.x + box.width, y0: box.y - cv.y, y1: box.y - cv.y + box.height, color },
  );
  // The sine fills the middle of the clip in the track colour; the body around it is a dim tint.
  expect(await lit()).toBeGreaterThan(0.9);
  await expect(page.getByTestId('banner')).toBeHidden();
  // The Browser footer counts the sample memory.
  await expect(page.getByTestId('sample-budget')).toHaveText(/^Samples \d+ MB \/ 1 GB$/);
  await page.screenshot({ path: 'test-results/audioclips-drop.png' });

  // Two files at once on that lane: placed one after another.
  await dropFiles(page, `tl-lane-${slot}`, 2 * BAR, [
    { name: 'a.wav', bytes: [...makeWav(300, 500)] },
    { name: 'b.wav', bytes: [...makeWav(400, 250)] },
  ]);
  await expect.poll(async () => (await audioTracks(page))[0].clips.length).toBe(3);
  const clips = (await audioTracks(page))[0].clips.sort((a, b) => a.start - b.start);
  expect(clips.map((c) => [c.start, c.len])).toEqual([[0, 2 * BAR], [2 * BAR, 2 * BEAT], [2 * BAR + 2 * BEAT, BEAT]]);
  // One undo takes the whole drop back.
  await page.getByTestId(`tl-lane-${slot}`).click({ position: { x: 5, y: 5 }, modifiers: ['Shift'] }); // focus, no edit
  await page.keyboard.press(undoKey);
  await expect.poll(async () => (await audioTracks(page))[0].clips.length).toBe(1);
  // + Audio track in the footer.
  await page.getByTestId('add-audio-track').click();
  await expect.poll(async () => (await audioTracks(page)).length).toBe(2);
  const slot2 = (await audioTracks(page))[1].slot;

  // An audio clip drags onto another audio lane (and back on Escape) ...
  const from = (await page.getByTestId(`clip-${slot}-0`).boundingBox())!;
  const lane2 = (await page.getByTestId(`tl-lane-${slot2}`).boundingBox())!;
  const lane0 = (await page.getByTestId('tl-lane-0').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, lane2.y + 14, { steps: 6 });
  await expect.poll(async () => (await audioTracks(page)).map((t) => t.clips.length)).toEqual([0, 1]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(async () => (await audioTracks(page)).map((t) => t.clips.length)).toEqual([1, 0]);
  // ... and over a drum lane it stays on its own lane.
  await page.mouse.move(from.x + from.width / 2, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, lane0.y + 14, { steps: 6 });
  await page.mouse.move(from.x + from.width / 2, lane2.y + 14, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await audioTracks(page)).map((t) => t.clips.length)).toEqual([0, 1]);
  expect((await audioTracks(page))[1].clips[0].start).toBe(0);
  await page.screenshot({ path: 'test-results/audioclips-lanes.png' });
});

test('audio clip is heard in song mode and after a mid-clip seek', async ({ page }) => {
  test.setTimeout(30_000);
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 4);
  // Pattern mode: audio tracks are silent.
  await page.keyboard.press('Space');
  expect(await stripPeak(page, slot, 400)).toBeLessThan(0.001);
  await page.keyboard.press('Space');
  // Song mode from the start: heard.
  await page.keyboard.press('Shift+L');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.mode)).toBe('song');
  await page.keyboard.press('Space');
  expect(await stripPeak(page, slot, 500)).toBeGreaterThan(0.3);
  // Past the clip: silent.
  await page.evaluate((t) => (window as unknown as { __daw: Daw }).__daw.actions.seek(t), 6 * BAR);
  await expect.poll(() => stripPeak(page, slot, 100), { timeout: 3_000 }).toBeLessThan(0.001);
  // Seek into the middle of the clip: the clip chases in at once.
  const ms = await page.evaluate(
    ({ slot, t }) =>
      new Promise<number>((resolve) => {
        const eng = (window as unknown as { __daw: Daw }).__daw.engine!;
        const t0 = performance.now();
        (window as unknown as { __daw: Daw }).__daw.actions.seek(t);
        const id = setInterval(() => {
          const m = eng.meters();
          if (Math.max(m[slot * 3], m[slot * 3 + 1]) > 0.1) {
            clearInterval(id);
            resolve(performance.now() - t0);
          } else if (performance.now() - t0 > 1000) {
            clearInterval(id);
            resolve(Infinity);
          }
        }, 2);
      }),
    { slot, t: 2 * BAR },
  );
  console.log(`audio clip heard ${ms.toFixed(1)} ms after a mid-clip seek`);
  expect(ms).toBeLessThan(100);
  await page.keyboard.press('Space');
});

test('trim, split, duplicate and undo each', async ({ page }) => {
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 2);
  const clip = page.getByTestId(`clip-${slot}-0`);
  const first = async () => (await audioTracks(page))[0].clips.sort((a, b) => a.start - b.start);

  // Trim the left edge one beat in: start and offset move together.
  const b = (await clip.boundingBox())!;
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(await xOf(page, BEAT), y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await first())[0]).toMatchObject({ start: BEAT, len: 2 * BAR - BEAT, offset: 0.25 });
  await page.keyboard.press(undoKey);
  await expect.poll(async () => (await first())[0]).toMatchObject({ start: 0, len: 2 * BAR, offset: 0 });

  // A right edge cannot pass the end of a one-shot file.
  const r = (await clip.boundingBox())!;
  await page.mouse.move(r.x + r.width - 2, y);
  await page.mouse.down();
  await page.mouse.move(await xOf(page, 3 * BAR), y, { steps: 6 });
  await page.mouse.up();
  expect((await first())[0].len).toBe(2 * BAR);

  // Split at the parked song position (Cmd/Ctrl+E with the lanes focused).
  await page.evaluate((t) => (window as unknown as { __daw: Daw }).__daw.actions.seek(t), BAR);
  await clip.click({ position: { x: 20, y: 8 } });
  await page.keyboard.press('ControlOrMeta+e');
  await expect.poll(async () => (await first()).map((c) => [c.start, c.len, c.offset])).toEqual([[0, BAR, 0], [BAR, BAR, 1]]);
  await page.keyboard.press(undoKey);
  await expect.poll(async () => (await first()).length).toBe(1);

  // Split here (the clip menu), at the beat under the pointer.
  await clip.click({ button: 'right', position: { x: (await xOf(page, BAR + 2 * BEAT)) - b.x, y: 8 } });
  await page.getByTestId('tl-menu-split').click();
  await expect.poll(async () => (await first()).map((c) => c.start)).toEqual([0, BAR + 2 * BEAT]);
  await page.keyboard.press(undoKey);
  await expect.poll(async () => (await first()).length).toBe(1);

  // Duplicate: the copy goes right after.
  await clip.click({ position: { x: 20, y: 8 } });
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(async () => (await first()).map((c) => c.start)).toEqual([0, 2 * BAR]);
  await page.keyboard.press(undoKey);
  await expect.poll(async () => (await first()).length).toBe(1);

  // Loop to fill: then the right edge can grow past the file.
  await clip.click({ button: 'right', position: { x: 20, y: 8 } });
  await expect(page.getByTestId('tl-menu-loop')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('tl-menu-loop').click();
  await expect.poll(async () => (await first())[0].loop).toBe(true);
  const r2 = (await clip.boundingBox())!;
  await page.mouse.move(r2.x + r2.width - 2, y);
  await page.mouse.down();
  await page.mouse.move(await xOf(page, 3 * BAR), y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await first())[0].len).toBe(3 * BAR);
  await page.keyboard.press(undoKey);
  await expect.poll(async () => (await first())[0].len).toBe(2 * BAR);
  await page.keyboard.press(undoKey);
  await expect.poll(async () => (await first())[0].loop).toBe(false);
});

test('library and kit samples drop onto an audio lane', async ({ page }) => {
  test.setTimeout(30_000);
  await start(page);
  await setTempo(page, 240);
  const name = `e2e-audioclips-${test.info().workerIndex}`;
  await page.evaluate(
    async ({ name, bytes }) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(name, { recursive: true }).catch(() => {});
      const lib = await root.getDirectoryHandle(name, { create: true });
      const w = await (await lib.getFileHandle('loop.wav', { create: true })).createWritable();
      await w.write(new Uint8Array(bytes));
      await w.close();
      await (window as unknown as { __daw: Daw }).__daw.library.attach(lib);
    },
    { name, bytes: [...makeWav(110, 1000)] },
  );
  try {
    await expect(page.getByTestId('lib-sample-loop.wav')).toBeVisible();
    await page.getByTestId('add-audio-track').click();
    const slot = (await audioTracks(page))[0].slot;
    await expect(page.getByTestId(`tl-lane-${slot}`)).toBeVisible();
    // Library sample at bar 2 (snapped to the beat).
    await dragSample(page, 'lib-sample-loop.wav', `tl-lane-${slot}`, BAR + 100);
    await expect.poll(async () => (await audioTracks(page))[0].clips.map((c) => [c.start, c.len])).toEqual([[BAR, BAR]]);
    await expect(page.getByTestId(`clip-${slot}-0`)).toHaveAttribute('data-pattern', 'loop');
    // Kit sample at bar 4.
    await dragSample(page, 'kit-sample-kick-deep.wav', `tl-lane-${slot}`, 3 * BAR);
    await expect.poll(async () => (await audioTracks(page))[0].clips.length).toBe(2);
    await expect(page.getByTestId(`clip-${slot}-1`)).toHaveAttribute('data-pattern', 'kick-deep');
    expect((await audioTracks(page))[0].clips[1].start).toBe(3 * BAR);
    await expect(page.getByTestId('banner')).toBeHidden();
  } finally {
    await page.evaluate(async (name) => {
      await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }).catch(() => {});
      await new Promise((r) => {
        const req = indexedDB.deleteDatabase('daw-library');
        req.onsuccess = req.onerror = req.onblocked = r;
      });
    }, name);
  }
});

test('Clip tab edits gain and fades', async ({ page }) => {
  test.setTimeout(30_000);
  await start(page);
  await setTempo(page, 240);
  const slot = await dropBelow(page, 'tone', 2);
  // Alt+5 on a drum track only says why; on the audio track it opens the tab.
  await page.getByTestId('track-0').click();
  await page.keyboard.press('Alt+5');
  await expect(page.getByTestId('flash-hint')).toHaveText('Select an audio track');
  await expect(page.getByTestId('cliptab-panel')).toBeHidden();
  await page.getByTestId(`clip-${slot}-0`).click({ position: { x: 20, y: 8 } });
  await page.getByTestId('mixer-tab').click();
  await page.keyboard.press('Alt+5');
  await expect(page.getByTestId('cliptab-panel')).toBeVisible();
  await expect(page.getByTestId('cliptab-info')).toContainText('tone');
  await expect(page.getByTestId('cliptab-info')).toContainText('mono');
  // Step grid / Piano roll / Instrument are disabled for an audio track.
  await expect(page.getByRole('button', { name: 'Step grid' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Piano roll' })).toBeDisabled();

  const c0 = async () => (await audioTracks(page))[0].clips[0];
  // Gain fader in dB.
  await page.getByTestId('cliptab-gain').evaluate((el: HTMLInputElement) => {
    el.value = '-6';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(async () => (await c0()).gain).toBe(-6);
  await expect(page.getByTestId('cliptab-gain-text')).toHaveText('−6.0 dB');
  // Fades in beats, exact entry.
  await page.getByTestId('cliptab-fade-in').fill('0.5');
  await page.getByTestId('cliptab-fade-in').press('Enter');
  await expect.poll(async () => (await c0()).fadeIn).toBe(BEAT / 2);
  await page.getByTestId('cliptab-fade-out').fill('4');
  await page.getByTestId('cliptab-fade-out').press('Enter');
  await expect.poll(async () => (await c0()).fadeOut).toBe(4 * BEAT);
  // Too long: shortened to fit the clip (8 beats with the 0.5 beat fade-in).
  await page.getByTestId('cliptab-fade-out').fill('20');
  await page.getByTestId('cliptab-fade-out').press('Enter');
  await expect.poll(async () => (await c0()).fadeOut).toBe(8 * BEAT);
  await expect(page.getByTestId('cliptab-fade-in')).toHaveValue('0');
  await page.getByTestId('cliptab-fade-out').blur(); // in the field, Cmd/Ctrl+Z undoes its text
  await page.keyboard.press(undoKey);
  await expect.poll(async () => [(await c0()).fadeIn, (await c0()).fadeOut]).toEqual([BEAT / 2, 4 * BEAT]);

  // The fade-out lowers the last beat's peak (per-beat meter peaks over one pass).
  await page.keyboard.press('Shift+L');
  const perBeat = await page.evaluate(
    ({ slot, beat }) =>
      new Promise<number[]>((resolve) => {
        const eng = (window as unknown as { __daw: Daw }).__daw.engine!;
        const peaks = new Array(8).fill(0);
        (window as unknown as { __daw: Daw }).__daw.actions.seek(0);
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
        const id = setInterval(() => {
          const t = eng.telemetry()[2];
          const b = Math.floor(t / beat);
          const m = eng.meters();
          if (b >= 0 && b < 8) peaks[b] = Math.max(peaks[b], m[slot * 3], m[slot * 3 + 1]);
          if (t > 8.5 * beat) {
            clearInterval(id);
            resolve(peaks);
          }
        }, 5);
      }),
    { slot, beat: BEAT },
  );
  console.log(`per-beat peaks ${perBeat.map((x) => x.toFixed(3)).join(' ')}`);
  expect(perBeat[2]).toBeGreaterThan(0.3); // −6 dB of a 0.9 sine
  expect(perBeat[7]).toBeLessThan(perBeat[2] * 0.5);
  await page.keyboard.press('Space');
});

test('drop on a drum lane shows the hint', async ({ page }) => {
  await start(page);
  const before = await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.length);
  await dropFiles(page, 'tl-lane-0', 0, [{ name: 'x.wav', bytes: [...makeWav(200, 100)] }]);
  await expect(page.getByTestId('tl-readout')).toHaveText('Drop audio on an audio track or below the tracks');
  await expect(page.getByTestId('banner')).toBeHidden(); // not the window's "drop onto a row" error
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.length)).toBe(before);
});

test('a long stereo file gets its peaks from the Worker', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  // 60 s of stereo: over 2^22 floats at any context rate, so audio/peaks.ts
  // analyses it in its Worker (the buffers go there and back). Built in the page.
  const b = (await page.getByTestId('tl-below').boundingBox())!;
  const lane = (await page.getByTestId('tl-lane-0').boundingBox())!;
  await page.evaluate(({ x, y }) => {
    const sr = 48000;
    const n = sr * 60;
    const buf = new ArrayBuffer(44 + n * 4);
    const v = new DataView(buf);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true);
    v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) {
      const s = Math.round(Math.sin((2 * Math.PI * 110 * i) / sr) * (i / n) * 30000);
      v.setInt16(44 + i * 4, s, true);
      v.setInt16(46 + i * 4, s, true);
    }
    const el = document.querySelector('[data-testid="tl-below"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File([buf], 'stem.wav', { type: 'audio/wav' }));
    for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }, { x: lane.x + 2, y: b.y + 10 });
  await expect.poll(async () => (await audioTracks(page)).length, { timeout: 30_000 }).toBe(1);
  const slot = (await audioTracks(page))[0].slot;
  await expect(page.getByTestId(`clip-${slot}-0`)).toHaveAttribute('data-pattern', 'stem');
  await expect(page.getByTestId(`clip-${slot}-0`)).toHaveAttribute('data-peaks', '1');
  await expect(page.getByTestId('banner')).toBeHidden();
  // The whole file reached the engine (the channels came back from the Worker).
  const seconds = await page.evaluate(() => [...(window as any).__daw.project.sampleMeta.values()].at(-1).seconds);
  expect(seconds).toBeCloseTo(60, 1);
});
