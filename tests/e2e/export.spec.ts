import { expect, test, type Page } from '@playwright/test';
import { makeNoiseWav, makeWav } from './wav';

// Project ▸ Export WAV… end to end: the real render Worker running
// engine.wasm. showSaveFilePicker is replaced (before the app loads) by a
// fake whose writable behaves like Chromium's: the streamed parts go to a
// "swap file" and close commits them to window.__exported (a Blob), so the
// test can decode it in the page with decodeAudioData. __writes counts the
// write calls (the export streams ~1 s parts, not one Blob).

type AClip = { id: string; idx: number; sampleId: number | null; start: number; len: number; offset: number; loop: boolean; gain: number; fadeIn: number; fadeOut: number };
type Daw = {
  engine: { sampleRate: number; meters(): Float32Array } | null;
  project: { tempo: number; mode: string; playing: boolean; tracks: { id: string; slot: number; kind: string; rows?: { id: string }[]; clips: AClip[] }[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, (...args: any[]) => any>;
  saveTo(dir: FileSystemDirectoryHandle): Promise<void>;
  openFrom(dir: FileSystemDirectoryHandle): Promise<string[]>;
};
type Win = { __daw: Daw; __exported: Blob | null; __picks: string[]; __writes: number };

const EMPTY = 'Nothing to export — the song has no clips. Add clips to the timeline in Song mode first.';

async function fakeSavePicker(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Win & { showSaveFilePicker: unknown };
    w.__exported = null;
    w.__picks = [];
    w.__writes = 0;
    w.showSaveFilePicker = async (o: { suggestedName: string }) => {
      w.__picks.push(o.suggestedName);
      return {
        name: o.suggestedName,
        createWritable: async () => {
          const swap: BlobPart[] = [];
          return {
            write: async (part: ArrayBuffer) => {
              w.__writes++;
              swap.push(part);
            },
            close: async () => void (w.__exported = new Blob(swap)),
            abort: async () => void (swap.length = 0),
          };
        },
        getFile: async () => ({ size: w.__exported?.size ?? 0 }),
      };
    };
  });
}

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

/** Kick on row 0 (four on the floor) and one 1-bar clip of it at 0; the metronome on (the export ignores it). */
async function oneBarSong(page: Page) {
  await page.evaluate((bytes) => {
    const el = document.querySelector('[data-testid="row-0"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'kick.wav', { type: 'audio/wav' }));
    for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [...makeWav(80, 120)]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as Win).__daw;
    const d = project.tracks[0];
    for (const s of [0, 4, 8, 12]) a.setStep(d.id, d.rows![0].id, s, 120);
    a.addClip(d.id, { start: 0 }); // the pattern's length: 1 bar
  });
  await page.getByRole('button', { name: 'Metronome' }).click();
}

async function exportFromMenu(page: Page) {
  await page.getByTestId('project-menu').click();
  await page.getByTestId('project-export').click();
}

const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

test('export produces a non-silent WAV of the right length', async ({ page }) => {
  await fakeSavePicker(page);
  await startAudio(page);
  await oneBarSong(page);
  await exportFromMenu(page);
  await expect(page.getByTestId('notice')).toContainText(`Exported "Untitled ${today()}.wav"`, { timeout: 20_000 });
  await expect(page.getByTestId('export-progress')).toBeHidden();

  const r = await page.evaluate(async () => {
    const w = window as unknown as Win;
    const sr = w.__daw.engine!.sampleRate;
    const bytes = await w.__exported!.arrayBuffer();
    const buf = await new OfflineAudioContext(2, 1, sr).decodeAudioData(bytes.slice(0));
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) for (const x of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
    const bits = new DataView(bytes).getUint16(34, true);
    // 1 bar = 4 beats at the project tempo, plus the 2 s tail.
    const want = Math.round(4 * (60 / w.__daw.project.tempo) * sr) + 2 * sr;
    return { length: buf.length, want, channels: buf.numberOfChannels, peak, bits, picks: w.__picks, writes: w.__writes };
  });
  expect(r.picks).toEqual([`Untitled ${today()}.wav`]);
  expect(r.writes).toBeGreaterThan(2); // streamed: the header, then ~1 s parts
  expect(r.bits).toBe(24);
  expect(r.channels).toBe(2);
  expect(r.length).toBe(r.want);
  expect(r.peak).toBeGreaterThan(0.05);
  // The live engine was never touched: the transport is still stopped and alive.
  await expect(page.getByTestId('play')).toHaveText('▶ Play');
  await expect(page.getByTestId('engine-error')).toHaveCount(0);
});

test('empty song shows message', async ({ page }) => {
  await fakeSavePicker(page);
  await startAudio(page);
  await exportFromMenu(page); // a drum track, but no clips
  await expect(page.getByTestId('banner')).toContainText(EMPTY);
  expect(await page.evaluate(() => (window as unknown as Win).__picks)).toEqual([]); // no file created
});

test('without a save picker the export is a download link', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await startAudio(page);
  await oneBarSong(page);
  await exportFromMenu(page);
  const link = page.getByTestId('export-download-link');
  await expect(link).toBeVisible({ timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe(`Untitled ${today()}.wav`);
});

// Plan 9 Task 6: one session through every pipeline that replays the project
// (save, undo, the audio restart, open, export). Tempo 240: one bar = 1 s,
// one beat = 0.25 s. The file is white noise, so the export can be
// cross-correlated against it: one sharp peak where its audio landed.
const BAR = 3840;
const BEAT = 960;

test('audio clips round-trip through save, undo, restart and export', async ({ page }) => {
  test.setTimeout(90_000);
  await fakeSavePicker(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('daw.latencyHint'));
  await startAudio(page);
  await expect(page.getByTestId('tl-lane-0')).toBeVisible();
  const bpm = page.getByLabel('BPM');
  await bpm.fill('240');
  await bpm.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__daw.project.tempo)).toBe(240);

  /** Client x of song tick `tick` on the lanes. */
  const xOf = async (tick: number) => {
    const v = JSON.parse((await page.getByTestId('timeline').getAttribute('data-view'))!) as { ticksPerPx: number; scrollTick: number };
    return (await page.getByTestId('tl-lane-0').boundingBox())!.x + (tick - v.scrollTick) / v.ticksPerPx;
  };
  const audioClips = () =>
    page.evaluate(() => (window as unknown as Win).__daw.project.tracks.filter((t) => t.kind === 'audio').map((t) => t.clips.map((c) => ({ ...c }))));
  /** What must survive every stage: the clip's place in the song and in its file, and its fades. */
  const shape = (c: AClip) => ({ start: c.start, len: c.len, offset: c.offset, loop: c.loop, gain: c.gain, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
  const only = async () => {
    const tracks = await audioClips();
    expect(tracks.map((t) => t.length)).toEqual([1]);
    return shape(tracks[0][0]);
  };

  // 1. Drop a 2 s WAV below the lanes (a new Audio track), trim its left edge
  //    one beat in, give it fades; Save to an OPFS folder.
  const noise = [...makeNoiseWav(2000)];
  const below = (await page.getByTestId('tl-below').boundingBox())!;
  const x0 = await xOf(0);
  await page.evaluate(
    ({ bytes, x, y }) => {
      const el = document.querySelector('[data-testid="tl-below"]')!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'noise.wav', { type: 'audio/wav' }));
      for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    },
    { bytes: noise, x: x0, y: below.y + Math.min(below.height / 2, 14) },
  );
  await expect.poll(async () => (await audioClips()).length).toBe(1);
  const slot = await page.evaluate(() => (window as unknown as Win).__daw.project.tracks.find((t) => t.kind === 'audio')!.slot);
  const clip = page.getByTestId(`clip-${slot}-0`);
  await expect(clip).toHaveAttribute('data-peaks', '1');
  expect(await only()).toMatchObject({ start: 0, len: 2 * BAR, offset: 0 });
  const b = (await clip.boundingBox())!;
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(await xOf(BEAT), y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(only).toMatchObject({ start: BEAT, len: 2 * BAR - BEAT, offset: 0.25 });
  await expect(page.getByTestId('cliptab-panel')).toBeVisible(); // the dropped track's Clip tab
  await page.getByTestId('cliptab-fade-in').fill('0.5');
  await page.getByTestId('cliptab-fade-in').press('Enter');
  await page.getByTestId('cliptab-fade-out').fill('1');
  await page.getByTestId('cliptab-fade-out').press('Enter');
  await expect.poll(only).toMatchObject({ fadeIn: BEAT / 2, fadeOut: BEAT });
  const want = await only();
  expect(want).toEqual({ start: BEAT, len: 2 * BAR - BEAT, offset: 0.25, loop: false, gain: 0, fadeIn: BEAT / 2, fadeOut: BEAT });

  const dirName = `e2e-audio-roundtrip-${test.info().workerIndex}`;
  const saved = await page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(n, { recursive: true }).catch(() => {});
    const dir = await root.getDirectoryHandle(n, { create: true });
    await (window as unknown as Win).__daw.saveTo(dir);
    const json = JSON.parse(await (await (await dir.getFileHandle('project.json')).getFile()).text());
    return { version: json.schemaVersion, clips: json.tracks.filter((t: { kind: string }) => t.kind === 'audio').map((t: { clips: unknown[] }) => t.clips) };
  }, dirName);
  expect(saved.version).toBe(3);
  expect(saved.clips).toHaveLength(1);
  expect(saved.clips[0]).toHaveLength(1);
  expect(saved.clips[0][0]).toMatchObject(want);
  expect(await only()).toEqual(want);

  // 2. Delete the clip, then undo.
  await clip.click({ position: { x: 20, y: 8 } });
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await audioClips())[0].length).toBe(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await audioClips())[0].length).toBe(1);
  expect(await only()).toEqual(want);

  // 3. Another latency hint: an audio restart. The clip is in the new engine: heard in Song mode.
  await page.evaluate(() => ((window as unknown as { __oldEngine: unknown }).__oldEngine = (window as unknown as Win).__daw.engine));
  await page.getByTestId('settings-button').click();
  const settings = page.getByTestId('settings');
  await settings.getByTestId('latency-hint').selectOption('playback');
  await settings.getByTestId('settings-apply').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Win).__daw.engine !== (window as unknown as { __oldEngine: unknown }).__oldEngine && !document.querySelector('[data-testid="loading"]')), { timeout: 10_000 })
    .toBe(true);
  expect(await only()).toEqual(want);
  await page.keyboard.press('Escape'); // close the settings popover
  await page.keyboard.press('Shift+L');
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__daw.project.mode)).toBe('song');
  await page.keyboard.press('Space');
  const heard = await page.evaluate(
    (slot) =>
      new Promise<number>((resolve) => {
        const eng = (window as unknown as Win).__daw.engine!;
        let peak = 0;
        const id = setInterval(() => {
          const m = eng.meters();
          peak = Math.max(peak, m[slot * 3], m[slot * 3 + 1]);
        }, 10);
        setTimeout(() => (clearInterval(id), resolve(peak)), 1000);
      }),
    slot,
  );
  await page.keyboard.press('Space');
  expect(heard).toBeGreaterThan(0.05);

  // 4. Open the saved folder (a fresh replay into the restarted engine).
  const warnings = await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    return (window as unknown as Win).__daw.openFrom(dir);
  }, dirName);
  expect(warnings).toEqual([]);
  expect(await only()).toEqual(want);

  // 5. Export: the file's audio lands where the clip says.
  await exportFromMenu(page);
  await expect(page.getByTestId('notice')).toContainText('Exported', { timeout: 20_000 });
  expect(await only()).toEqual(want);
  const r = await page.evaluate(
    async ({ bytes, start, offset, fadeIn, tempo }) => {
      const w = window as unknown as Win;
      const sr = w.__daw.engine!.sampleRate;
      const ctx = new OfflineAudioContext(2, 1, sr);
      const out = (await ctx.decodeAudioData(await w.__exported!.arrayBuffer())).getChannelData(0);
      const src = (await ctx.decodeAudioData(new Uint8Array(bytes).buffer)).getChannelData(0); // at the engine's rate, as the app decodes it
      const secs = (ticks: number) => (ticks / 960) * (60 / tempo);
      // Reference: 0.1 s of the file starting 0.1 s after the user fade-in ends.
      const into = secs(fadeIn) + 0.1;
      const ref = src.subarray(Math.round((offset + into) * sr), Math.round((offset + into + 0.1) * sr));
      const expected = Math.round((secs(start) + into) * sr);
      const span = Math.round(0.03 * sr); // search ±30 ms
      let best = -Infinity;
      let lag = 0;
      for (let d = -span; d <= span; d++) {
        let acc = 0;
        const at = expected + d;
        for (let i = 0; i < ref.length; i++) acc += ref[i] * out[at + i];
        if (acc > best) (best = acc), (lag = d);
      }
      let energy = 0;
      for (const x of ref) energy += x * x;
      // Before the clip starts (minus the 2 ms declick margin): silence.
      let pre = 0;
      for (let i = 0; i < Math.round((secs(start) - 0.002) * sr); i++) pre = Math.max(pre, Math.abs(out[i]));
      return { lagMs: (lag / sr) * 1000, ratio: best / energy, pre };
    },
    { bytes: noise, start: want.start, offset: want.offset, fadeIn: want.fadeIn, tempo: 240 },
  );
  console.log(`export cross-correlation: lag ${r.lagMs.toFixed(3)} ms, peak/energy ${r.ratio.toFixed(3)}, pre-clip peak ${r.pre.toExponential(1)}`);
  expect(Math.abs(r.lagMs)).toBeLessThanOrEqual(1);
  expect(r.ratio).toBeGreaterThan(0.5); // the clip's own audio, not a chance match
  expect(r.pre).toBeLessThan(0.001);

  await page.evaluate(async (n) => {
    await (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {});
    localStorage.removeItem('daw.latencyHint');
  }, dirName);
});
