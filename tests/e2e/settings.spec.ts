import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';
import { startApp } from './startApp';

// Audio settings (plan 7 Task 3): Apply re-creates the AudioContext and the
// engine and replays the project held in memory onto it -- no reload, no
// disk reads. The project folder and the library folder are OPFS handles
// here (the pickers cannot be driven headless); both must keep working
// after the restart.

type Daw = {
  engine: { meters(): Float32Array; telemetry(): Float64Array; latencyHint: unknown; context: BaseAudioContext } | null;
  project: {
    name: string;
    dirty: boolean;
    version: number;
    playing: boolean;
    tracks: { id: string; slot: number; kind: string; rows?: { id: string; name: string; sampleId: number | null }[] }[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, (...args: any[]) => any>;
  saveTo(dir: FileSystemDirectoryHandle): Promise<void>;
  library: { attach(dir: FileSystemDirectoryHandle): Promise<void> };
  snapshot(): unknown;
};
type W = Window & { __daw: Daw; __oldEngine?: Daw['engine'] };

async function startAudio(page: Page) {
  await startApp(page);
}

async function dropFile(page: Page, testid: string, name: string, bytes: number[]) {
  await page.evaluate(
    ({ testid, name, bytes }) => {
      const el = document.querySelector(`[data-testid="${testid}"]`)!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'audio/wav' }));
      for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { testid, name, bytes },
  );
}

/** An HTML5 drag with one shared DataTransfer (library sample -> drop target). */
async function drag(page: Page, from: string, to: string) {
  await page.evaluate(
    ({ from, to }) => {
      const src = document.querySelector(`[data-testid="${from}"]`)!;
      const dst = document.querySelector(`[data-testid="${to}"]`)!;
      const dt = new DataTransfer();
      const ev = (el: Element, t: string) => el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      ev(src, 'dragstart');
      for (const t of ['dragenter', 'dragover', 'drop']) ev(dst, t);
      ev(src, 'dragend');
    },
    { from, to },
  );
}

/** Max meter peak per strip (track slots) over `ms`. */
function stripPeaks(page: Page, slots: number[], ms: number) {
  return page.evaluate(
    ({ slots, ms }) =>
      new Promise<number[]>((resolve) => {
        const eng = (window as unknown as W).__daw.engine!;
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

const snapshot = (page: Page) => page.evaluate(() => JSON.stringify((window as unknown as W).__daw.snapshot()));

/** project.json as written to OPFS folder `name`. */
const savedJson = (page: Page, name: string) =>
  page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    return JSON.stringify(JSON.parse(await (await (await dir.getFileHandle('project.json')).getFile()).text()));
  }, name);

test('restart keeps project and handles', async ({ page }) => {
  test.setTimeout(90_000);
  const w = test.info().workerIndex;
  const projDir = `e2e-restart-proj-${w}`;
  const libDir = `e2e-restart-lib-${w}`;
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('daw.latencyHint'));
  await startAudio(page);
  expect(await page.evaluate(() => (window as unknown as W).__daw.engine!.latencyHint)).toBe('interactive');

  // The library folder (an OPFS stand-in for the picked folder).
  await page.evaluate(async ({ libDir, bass }) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(libDir, { recursive: true }).catch(() => {});
    const lib = await root.getDirectoryHandle(libDir, { create: true });
    const wr = await (await lib.getFileHandle('bass.wav', { create: true })).createWritable();
    await wr.write(new Uint8Array(bass));
    await wr.close();
    await (window as unknown as W).__daw.library.attach(lib);
  }, { libDir, bass: [...makeWav(55, 200)] });
  await expect(page.getByTestId('lib-sample-bass.wav')).toBeVisible();

  // A beat: kick on the drums, a held chord on a synth, mixer settings, a sidechain key.
  await dropFile(page, 'row-0', 'kick.wav', [...makeWav(80, 120)]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as W).__daw;
    const d = project.tracks[0];
    for (const s of [0, 4, 8, 12]) a.setStep(d.id, d.rows![0].id, s, 120);
    a.setMix(d.id, 'fader', -3);
    const synth = a.addSynthTrack('Chord Stab');
    for (const pitch of [48, 52, 55]) a.addNote(synth.id, { pitch, start: 0, len: 15360, vel: 100 });
    a.setSidechain(synth.id, { trackId: d.id, row: 0 });
    // Automation (plan 10): a cutoff sweep on the synth, a pan ride on the drums and a Master row lane.
    const sweep = a.addLane(synth.id, { kind: 'rack', module: 2, param: 'cutoff' }) // Chord Stab's Filter;
    a.drawLane(sweep, [{ tick: 0, value: 200 }, { tick: 3840, value: 4000 }, { tick: 7680, value: 300 }]);
    a.drawLane(a.addLane(d.id, { kind: 'mix', param: 'pan' }), [{ tick: 0, value: -0.5 }, { tick: 1920, value: 0.5 }]);
    const ceiling = a.addLane('master', { kind: 'mix', param: 'limiter_ceiling' });
    a.drawLane(ceiling, [{ tick: 0, value: -3 }, { tick: 3840, value: 0 }]);
    a.setLaneEnabled(ceiling, false);
  });
  const laneCount = (j: string) => {
    const x = JSON.parse(j) as { tracks: { automation: { points: unknown[] }[] }[]; mixer: { automation: { enabled: boolean }[] } };
    return [x.tracks.map((t) => t.automation.map((l) => l.points.length)), x.mixer.automation.map((l) => l.enabled)];
  };
  expect(laneCount(await snapshot(page))).toEqual([[[2], [3]], [false]]);
  // Saved to a project folder, then edited again: a folder handle and the "unsaved" mark.
  await page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(n, { recursive: true }).catch(() => {});
    await (window as unknown as W).__daw.saveTo(await root.getDirectoryHandle(n, { create: true }));
  }, projDir);
  await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as W).__daw;
    a.setMix(project.tracks[1].id, 'pan', 0.4);
  });
  await expect(page.getByTestId('project-name')).toContainText('unsaved');
  const before = await snapshot(page);
  const version = await page.evaluate(() => (window as unknown as W).__daw.project.version);
  const undoTitle = await page.getByTestId('undo').getAttribute('title');
  expect(undoTitle).toMatch(/^Undo /);

  // Playing when Apply is pressed: the restart stops the transport. (The
  // pattern transport plays only the selected track, the synth: plan 20 task 12.)
  await page.getByTestId('pattern-play').click();
  await expect.poll(async () => (await stripPeaks(page, [1], 600))[0], { timeout: 5_000 }).toBeGreaterThan(0.01);
  await page.evaluate(() => ((window as unknown as W).__oldEngine = (window as unknown as W).__daw.engine));

  await page.getByTestId('settings-button').click();
  const panel = page.getByTestId('settings');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('settings-rate')).toHaveText(/\d+(\.\d+)? kHz/);
  await expect(panel.getByTestId('settings-total')).toHaveText(/\d+(\.\d) ms/);
  await expect(panel.getByTestId('settings-bt')).toContainText('Bluetooth');
  await page.screenshot({ path: 'test-results/settings.png' });
  await panel.getByTestId('latency-hint').selectOption('playback');
  await panel.getByTestId('settings-apply').click();

  // A new engine on a new context; the old context is closed.
  await expect.poll(() => page.evaluate(() => {
    const x = window as unknown as W;
    return x.__daw.engine !== x.__oldEngine && !x.__daw.project.playing && !document.querySelector('[data-testid="loading"]');
  }), { timeout: 10_000 }).toBe(true);
  expect(await page.evaluate(() => (window as unknown as W).__oldEngine!.context.state)).toBe('closed');
  expect(await page.evaluate(() => (window as unknown as W).__daw.engine!.latencyHint)).toBe('playback');
  expect(await page.evaluate(() => localStorage.getItem('daw.latencyHint'))).toBe('playback');
  await expect(page.getByTestId('play')).toHaveText(/Play/);
  await expect(page.getByTestId('banner')).toBeHidden();

  // The project is exactly what it was: serialize equality, same edit count,
  // still unsaved, and the undo history survived.
  expect(await snapshot(page)).toBe(before); // the lanes included
  expect(laneCount(before)).toEqual([[[2], [3]], [false]]);
  expect(await page.evaluate(() => (window as unknown as W).__daw.project.version)).toBe(version);
  await expect(page.getByTestId('project-name')).toContainText('unsaved');
  await expect(page.getByTestId('undo')).toHaveAttribute('title', undoTitle!);

  // Audio plays after the restart: the synth, then the kick (sample
  // re-uploaded from memory) once its track is selected (the pattern focus
  // follows the selection); then the synth is selected again for the keys.
  await page.getByTestId('pattern-play').click();
  await expect.poll(async () => (await stripPeaks(page, [1], 600))[0], { timeout: 5_000 }).toBeGreaterThan(0.01);
  await page.getByTestId('track-0').click();
  await expect.poll(async () => (await stripPeaks(page, [0], 600))[0], { timeout: 5_000 }).toBeGreaterThan(0.01);
  await page.getByTestId('pattern-stop').click();
  await page.getByTestId('track-1').click();
  // The computer keyboard (bound once per session, through App's forwarding
  // view) plays the synth on the new engine.
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__daw.project.playing)).toBe(false);
  await expect.poll(async () => (await stripPeaks(page, [1], 200))[0], { timeout: 5_000 }).toBeLessThan(0.001); // the chord's tail
  await page.keyboard.down('KeyA');
  await expect.poll(async () => (await stripPeaks(page, [1], 300))[0], { timeout: 5_000 }).toBeGreaterThan(0.01);
  await page.keyboard.up('KeyA');

  // The library handle still works: preview (on the new context) and a drag into a new row.
  await page.getByTestId('lib-sample-bass.wav').click();
  await expect(page.getByTestId('preview-stop')).toBeEnabled();
  await page.getByTestId('preview-stop').click();
  await page.getByTestId('track-0').click(); // the drums' step grid
  const preBass = await snapshot(page); // (the selection moved: part of the snapshot)
  await drag(page, 'lib-sample-bass.wav', 'add-row');
  await expect(page.getByTestId('row-8').getByTestId('row-name')).toHaveText('bass'); // after the default kit's eight
  const withBass = await snapshot(page);

  // Undo / redo across the restart, through the new engine.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => snapshot(page)).toBe(preBass);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => snapshot(page)).toBe(withBass);

  // The project folder handle still works: Save writes to it without a picker.
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByTestId('project-name')).not.toContainText('unsaved');
  expect(await savedJson(page, projDir)).toBe(withBass);
  await expect(page.getByTestId('banner')).toBeHidden();

  // The hint persists: the next start uses it.
  await page.reload();
  await startAudio(page);
  expect(await page.evaluate(() => (window as unknown as W).__daw.engine!.latencyHint)).toBe('playback');

  await page.evaluate(async (dirs) => {
    localStorage.removeItem('daw.latencyHint');
    const root = await navigator.storage.getDirectory();
    for (const d of dirs) await root.removeEntry(d, { recursive: true }).catch(() => {});
    await new Promise((r) => {
      const req = indexedDB.deleteDatabase('daw-library');
      req.onsuccess = req.onerror = req.onblocked = r;
    });
  }, [projDir, libDir]);
});

test('a refused restart keeps the running audio; an empty custom buffer cannot be applied', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('daw.latencyHint'));
  await startAudio(page);
  await dropFile(page, 'row-0', 'kick.wav', [...makeWav(80, 120)]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as W).__daw;
    const d = project.tracks[0];
    for (const s of [0, 4, 8, 12]) a.setStep(d.id, d.rows![0].id, s, 120);
  });
  const before = await snapshot(page);
  await page.getByTestId('settings-button').click();
  const panel = page.getByTestId('settings');

  // Custom with the field emptied: nothing would apply, so Apply is off and says why.
  await panel.getByTestId('latency-hint').selectOption('custom');
  await expect(panel.getByTestId('latency-applies')).toHaveText('Applies Custom 20 ms');
  await panel.getByTestId('latency-custom').fill('');
  await expect(panel.getByTestId('latency-applies')).toHaveText('Enter 1–1000 ms');
  await expect(panel.getByTestId('settings-apply')).toBeDisabled();
  await panel.getByTestId('latency-custom').fill('0');
  await expect(panel.getByTestId('settings-apply')).toBeDisabled();

  // The device refuses a new context: the running engine is kept, untouched.
  await panel.getByTestId('latency-hint').selectOption('playback');
  await page.evaluate(() => {
    const x = window as unknown as W & { __RealAC?: typeof AudioContext };
    x.__oldEngine = x.__daw.engine;
    x.__RealAC = window.AudioContext;
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      throw new Error('device gone');
    };
  });
  await panel.getByTestId('settings-apply').click();
  await expect(page.getByTestId('banner')).toContainText("Couldn't apply Playback: device gone; kept previous settings");
  await expect(panel.getByTestId('settings-status')).toContainText('kept previous settings');
  await expect(page.getByTestId('loading')).toBeHidden();
  const kept = await page.evaluate(() => {
    const x = window as unknown as W & { __RealAC?: typeof AudioContext };
    window.AudioContext = x.__RealAC!;
    return { same: x.__daw.engine === x.__oldEngine, state: x.__daw.engine!.context.state, hint: localStorage.getItem('daw.latencyHint') };
  });
  expect(kept).toEqual({ same: true, state: 'running', hint: null });
  expect(await snapshot(page)).toBe(before);
  await page.getByTestId('pattern-play').click();
  await expect.poll(async () => (await stripPeaks(page, [0], 600))[0], { timeout: 5_000 }).toBeGreaterThan(0.01);
  await page.getByTestId('pattern-stop').click();
});

/** Max master peak (telemetry peakL / peakR) over `ms`. */
function masterPeak(page: Page, ms: number) {
  return page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        const eng = (window as unknown as W).__daw.engine!;
        let peak = 0;
        const id = setInterval(() => {
          const t = eng.telemetry();
          peak = Math.max(peak, t[5], t[6]); // TELEMETRY.peakL, peakR
        }, 20);
        setTimeout(() => (clearInterval(id), resolve(peak)), ms);
      }),
    ms,
  );
}

// Plan 9 Task 1: an undo applied through the new engine after an audio
// restart is heard (the restored row gain reaches the new engine).
test('undo audible after restart', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('daw.latencyHint'));
  await startAudio(page);
  // The default kit: its Kick row (row 0) gets its sample asynchronously.
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__daw.project.tracks[0]?.rows?.[0]?.sampleId ?? null), { timeout: 10_000 }).not.toBeNull();
  await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as W).__daw;
    const d = project.tracks[0];
    for (const s of [0, 4, 8, 12]) a.setStep(d.id, d.rows![0].id, s, 120);
  });
  await page.getByTestId('pattern-play').click();
  await expect.poll(() => masterPeak(page, 300), { timeout: 5_000 }).toBeGreaterThan(0.05);

  // The Kick row's gain to 0 (its own undo step), then Stop.
  await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as W).__daw;
    const d = project.tracks[0];
    a.setRowGain(d.id, d.rows![0].id, 0);
  });
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Row gain/);
  await page.getByTestId('pattern-stop').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__daw.project.playing)).toBe(false);

  // Another latency hint: an audio restart.
  await page.evaluate(() => ((window as unknown as W).__oldEngine = (window as unknown as W).__daw.engine));
  await page.getByTestId('settings-button').click();
  const panel = page.getByTestId('settings');
  await panel.getByTestId('latency-hint').selectOption('playback');
  await panel.getByTestId('settings-apply').click();
  await expect.poll(() => page.evaluate(() => {
    const x = window as unknown as W;
    return x.__daw.engine !== x.__oldEngine && !document.querySelector('[data-testid="loading"]');
  }), { timeout: 10_000 }).toBe(true);

  // ⌘Z (the row gain comes back) and Play: heard within a second.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('redo')).toHaveAttribute('title', /^Redo Row gain/);
  await page.getByTestId('pattern-play').click();
  await expect.poll(() => masterPeak(page, 100), { timeout: 1_000, intervals: [0] }).toBeGreaterThan(0.05);
  await page.getByTestId('pattern-stop').click();
  await page.evaluate(() => localStorage.removeItem('daw.latencyHint'));
});
