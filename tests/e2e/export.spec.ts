import { expect, test, type Page } from '@playwright/test';
import { makeNoiseWav, makeWav } from './wav';
import { openMenu, openAudioSettings } from './topbar';
import { addTrack } from './addTrack';
import { pickAutomation } from './automate';
import { startApp } from './startApp';

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
  await startApp(page);
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
  await openMenu(page, 'File');
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
  await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'false');
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
  expect(saved.version).toBe(6);
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
  await openAudioSettings(page);
  const settings = page.getByTestId('settings');
  await settings.getByTestId('latency-hint').selectOption('playback');
  await settings.getByTestId('settings-apply').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Win).__daw.engine !== (window as unknown as { __oldEngine: unknown }).__oldEngine && !document.querySelector('[data-testid="loading"]')), { timeout: 10_000 })
    .toBe(true);
  expect(await only()).toEqual(want);
  await page.keyboard.press('Escape'); // close the settings dialog
  await page.keyboard.press('Space'); // focus is in the top bar: the song transport
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__daw.project.mode)).toBe('song');
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

// Plan 10 Task 5: automation lanes through every pipeline that replays the
// project (save, undo, the audio restart, open, export), in one session.
// Tempo 240 (one bar = 1 s). A synth holds a low note for two bars; its
// filter cutoff is swept up over bar 1 with a Cmd/Ctrl-drag stroke, and its
// fader holds 0 dB until 1.5 bars, then drops to −∞ (a hold point).

/** The lanes as saved: per track (by slot), points sorted by tick. */
type SavedLane = { target: unknown; enabled: boolean; points: [number, number, 0 | 1][] };
const DROP = BAR + BAR / 2;
const LANE_PAD = 6;
const LANE_H = 48;

test('automation round-trips through save, undo, restart and export', async ({ page }) => {
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

  await addTrack(page, 'synth');
  const synth = await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as Win).__daw;
    const t = project.tracks.at(-1)!;
    a.addNote(t.id, { pitch: 36, start: 0, len: 2 * 3840, vel: 110 });
    a.addClip(t.id, { start: 0, len: 2 * 3840 });
    return { id: t.id, slot: t.slot, kind: t.kind };
  });
  expect(synth.kind).toBe('synth');
  const slot = synth.slot;

  const lanes = async (): Promise<SavedLane[]> => {
    const ls: SavedLane[] = await page.evaluate(
      (slot) => ((window as unknown as Win).__daw as unknown as { snapshot(): { tracks: { slot: number; automation: SavedLane[] }[] } }).snapshot().tracks.find((t) => t.slot === slot)!.automation,
      slot,
    );
    return ls.map((l) => ({ ...l, points: [...l.points].sort((a, b) => a[0] - b[0]) }));
  };
  /** Page point of song tick `tick` at knob position `pos` (0 bottom .. 1 top) in lane `testid`. */
  const lanePt = async (testid: string, tick: number, pos: number) => {
    const v = JSON.parse((await page.getByTestId('timeline').getAttribute('data-view'))!) as { ticksPerPx: number; scrollTick: number };
    await page.getByTestId(testid).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const b = (await page.getByTestId(testid).boundingBox())!;
    return { x: b.x + (tick - v.scrollTick) / v.ticksPerPx, y: b.y + LANE_PAD + (1 - pos) * (LANE_H - 2 * LANE_PAD) };
  };
  const addLane = async (group: string, param: string, k: number) => {
    const toggle = page.getByTestId(`track-auto-${slot}`);
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    await pickAutomation(page, slot, group, param);
    await expect(page.getByTestId(`auto-lane-${slot}-${k}`)).toBeVisible();
    return `auto-lane-${slot}-${k}`;
  };

  // 1. The cutoff sweep: one Cmd/Ctrl-drag stroke from low at 0 to high at bar 1.
  const cutoff = await addLane('Filter', 'Cutoff', 0);
  const a = await lanePt(cutoff, 0, 0.15);
  const b = await lanePt(cutoff, BAR, 0.95);
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 24 });
  await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');
  // The fader drop: 0 dB (hold) at 0, −∞ at 1.5 bars.
  const fader = await addLane('Volume', 'Volume', 1);
  const p0 = await lanePt(fader, 0, 0.75); // 0 dB on the fader taper (plan 19)
  await page.mouse.click(p0.x, p0.y);
  const p1 = await lanePt(fader, DROP, 0);
  await page.mouse.click(p1.x, p1.y);
  await page.mouse.click(p0.x, p0.y, { button: 'right' });
  await page.getByTestId('auto-menu-hold').click();
  await expect(page.getByTestId('auto-menu')).toBeHidden();

  const want = await lanes();
  expect(want.map((l) => l.target)).toEqual([{ rack: [4, 'cutoff'] }, { mix: 'fader' }]);
  expect(want.every((l) => l.enabled)).toBe(true);
  expect(want[0].points.length).toBeGreaterThanOrEqual(2);
  expect(want[0].points[0][1]).toBeLessThan(want[0].points.at(-1)![1]); // a sweep up
  expect(want[1].points.map(([t, , h]) => [t, h])).toEqual([[0, 1], [DROP, 0]]);
  expect(want[1].points[0][1]).toBeCloseTo(0, 1); // 0 dB (a click: within a pixel)
  expect(want[1].points[1][1]).toBe(-60); // −∞

  const dirName = `e2e-auto-roundtrip-${test.info().workerIndex}`;
  const saved = await page.evaluate(
    async ({ n, slot }) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(n, { recursive: true }).catch(() => {});
      const dir = await root.getDirectoryHandle(n, { create: true });
      await (window as unknown as Win).__daw.saveTo(dir);
      const json = JSON.parse(await (await (await dir.getFileHandle('project.json')).getFile()).text());
      return { version: json.schemaVersion, lanes: json.tracks.find((t: { slot: number }) => t.slot === slot).automation };
    },
    { n: dirName, slot },
  );
  expect(saved.version).toBe(6);
  expect(saved.lanes.map((l: SavedLane) => ({ ...l, points: [...l.points].sort((x, y) => x[0] - y[0]) }))).toEqual(want);

  // 2. Remove each lane with its header's ×, then undo: both come back as they were.
  await page.getByTestId(`auto-remove-${slot}-0`).click();
  await expect.poll(async () => (await lanes()).map((l) => l.target)).toEqual([{ mix: 'fader' }]);
  await page.getByTestId(`auto-remove-${slot}-0`).click();
  await expect.poll(lanes).toEqual([]);
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(lanes).toEqual(want);

  /** Song Play from 0: the master peak (telemetry) by song tick over `ms`. */
  const playSong = async (ms: number) => {
    await page.evaluate(() => (window as unknown as Win).__daw.actions.seek(0));
    await page.getByTestId('play').click();
    const rec = await page.evaluate(
      (ms) =>
        new Promise<{ t: number; peak: number }[]>((resolve) => {
          const eng = (window as unknown as { __daw: { engine: { telemetry(): Float64Array } } }).__daw.engine;
          const out: { t: number; peak: number }[] = [];
          const t0 = performance.now();
          const id = setInterval(() => {
            const tele = eng.telemetry();
            out.push({ t: tele[2], peak: Math.max(tele[5], tele[6]) });
            if (performance.now() - t0 > ms) (clearInterval(id), resolve(out));
          }, 4);
        }),
      ms,
    );
    await page.getByTestId('play').click();
    return rec;
  };
  const peakIn = (rec: { t: number; peak: number }[], from: number, to: number) => Math.max(0, ...rec.filter((r) => r.t >= from && r.t < to).map((r) => r.peak));

  // 3. Another latency hint: an audio restart. The lanes are unchanged and drive the new engine: the drop is heard.
  await page.evaluate(() => ((window as unknown as { __oldEngine: unknown }).__oldEngine = (window as unknown as Win).__daw.engine));
  await openAudioSettings(page);
  const settings = page.getByTestId('settings');
  await settings.getByTestId('latency-hint').selectOption('playback');
  await settings.getByTestId('settings-apply').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Win).__daw.engine !== (window as unknown as { __oldEngine: unknown }).__oldEngine && !document.querySelector('[data-testid="loading"]')), { timeout: 10_000 })
    .toBe(true);
  await page.keyboard.press('Escape'); // close the settings dialog
  expect(await lanes()).toEqual(want);
  const rec = await playSong(2000);
  const ms10 = BAR / 100; // ticks in 10 ms (1 bar = 1 s)
  const before = peakIn(rec, BAR, DROP - ms10);
  const after = rec.filter((r) => r.t >= DROP + ms10 && r.t < 2 * BAR);
  console.log(`after restart: ${before.toFixed(3)} before the drop, ${Math.max(...after.map((r) => r.peak)).toExponential(1)} after (${after.length} frames)`);
  expect(before).toBeGreaterThan(0.05);
  expect(after.length).toBeGreaterThan(3);
  expect(Math.max(...after.map((r) => r.peak))).toBeLessThan(0.001);

  // 4. Open the saved folder (a fresh replay into the restarted engine).
  const warnings = await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    return (window as unknown as Win).__daw.openFrom(dir);
  }, dirName);
  expect(warnings).toEqual([]);
  expect(await lanes()).toEqual(want);

  // 5. Export: the sweep brightens bar 1; the file is silent (−60 dBFS) from 10 ms after the drop to its end.
  await exportFromMenu(page);
  await expect(page.getByTestId('notice')).toContainText('Exported', { timeout: 20_000 });
  expect(await lanes()).toEqual(want);
  const r = await page.evaluate(async (dropSecs) => {
    const w = window as unknown as Win;
    const sr = w.__daw.engine!.sampleRate;
    const buf = await new OfflineAudioContext(2, 1, sr).decodeAudioData(await w.__exported!.arrayBuffer());
    const chans = [buf.getChannelData(0), buf.getChannelData(1)];
    const peak = (from: number, to: number) => {
      let m = 0;
      for (const c of chans) for (let i = Math.round(from * sr); i < Math.min(c.length, Math.round(to * sr)); i++) m = Math.max(m, Math.abs(c[i]));
      return m;
    };
    /** Brightness: RMS of the first difference over the RMS (rises with the cutoff). */
    const bright = (from: number, to: number) => {
      const c = chans[0];
      let d = 0;
      let e = 0;
      for (let i = Math.round(from * sr) + 1; i < Math.round(to * sr); i++) (d += (c[i] - c[i - 1]) ** 2), (e += c[i] ** 2);
      return Math.sqrt(d / e);
    };
    return {
      secs: buf.length / sr,
      heard: peak(0.2, dropSecs - 0.01),
      after: peak(dropSecs + 0.01, buf.length / sr),
      early: bright(0.1, 0.3),
      late: bright(0.8, 1.0),
    };
  }, DROP / BAR);
  console.log(`export: ${r.secs.toFixed(2)} s, ${r.heard.toFixed(3)} before the drop, ${r.after.toExponential(1)} after; brightness ${r.early.toFixed(4)} -> ${r.late.toFixed(4)}`);
  expect(r.secs).toBeCloseTo(2 + 2, 1); // two bars + the 2 s tail
  expect(r.heard).toBeGreaterThan(0.05);
  expect(r.after).toBeLessThan(0.001); // −60 dBFS
  expect(r.late).toBeGreaterThan(r.early * 1.5); // the cutoff sweep is in the file

  await page.evaluate(async (n) => {
    await (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {});
    localStorage.removeItem('daw.latencyHint');
  }, dirName);
});
