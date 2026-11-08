import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// The Browser pane's library (plan 6 Task 5). An OPFS folder stands in for
// the user's library folder: __daw.library.attach(handle) runs the same code
// as start-up with a stored handle (permission check, then scan); the
// picker itself cannot be driven headless. Every test removes the OPFS
// folder and the IndexedDB choice it created.

type Daw = {
  engine: { meters(): Float32Array } | null;
  project: {
    playing: boolean;
    sampleFiles: Map<number, { name: string; bytes: ArrayBuffer }>;
    tracks: { id: string; slot: number; kind: string; patchName?: string; modules?: { idx: number; kind: number; params: number[] }[]; rows?: { name: string; sampleId: number | null }[] }[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, (...args: any[]) => any>;
  library: { attach(dir: FileSystemDirectoryHandle): Promise<void>; state: { status: string } };
};

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

type Entry = { path: string; bytes?: number[]; text?: string };

/** A fresh OPFS folder `name` holding `files` (paths with '/' make sub-folders). */
async function makeLibrary(page: Page, name: string, files: Entry[]) {
  await page.evaluate(
    async ({ name, files }) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(name, { recursive: true }).catch(() => {});
      const lib = await root.getDirectoryHandle(name, { create: true });
      for (const f of files) {
        const parts = f.path.split('/');
        let dir = lib;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const w = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
        await w.write(f.text ?? new Uint8Array(f.bytes!));
        await w.close();
      }
    },
    { name, files },
  );
}

/** Use OPFS folder `name` as the library (start-up path). */
async function attach(page: Page, name: string) {
  await page.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    await (window as unknown as { __daw: Daw }).__daw.library.attach(dir);
  }, name);
}

async function cleanup(page: Page, name: string) {
  await page.evaluate(async (name) => {
    await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }).catch(() => {});
    await new Promise((r) => {
      const req = indexedDB.deleteDatabase('daw-library');
      req.onsuccess = req.onerror = req.onblocked = r;
    });
  }, name);
}

/**
 * An HTML5 drag from one element to another, with one DataTransfer shared by
 * every event (what the browser does for a real drag): dragstart lets the
 * source fill it, drop reads it.
 */
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
        }, 20);
        setTimeout(() => (clearInterval(id), resolve(peak)), ms);
      }),
    { slot, ms },
  );
}

const kick = [...makeWav(80, 120)];

test('library sample drag loads into row', async ({ page }) => {
  test.setTimeout(30_000);
  await startAudio(page);
  await expect(page.getByTestId('library-choose')).toBeVisible();
  const name = `e2e-lib-drag-${test.info().workerIndex}`;
  await makeLibrary(page, name, [
    { path: 'drums/kick.wav', bytes: kick },
    { path: 'drums/notes.txt', text: 'not audio' },
    { path: 'bass.wav', bytes: [...makeWav(55, 200)] },
    { path: 'patches/Wobble.json', text: '{"name":"Wobble","modules":[],"cables":[]}' },
  ]);
  await attach(page, name);
  await expect(page.getByTestId('library-name')).toHaveText(name);
  await expect(page.getByTestId('lib-sample-bass.wav')).toBeVisible();
  await expect(page.getByTestId('lib-patch-Wobble')).toBeVisible();
  // Folders start collapsed; non-audio files are not listed.
  await expect(page.getByTestId('lib-sample-drums/kick.wav')).toBeHidden();
  await page.getByTestId('lib-folder-drums').click();
  await expect(page.getByTestId('lib-sample-drums/kick.wav')).toBeVisible();
  await expect(page.getByTestId('browser')).not.toContainText('notes.txt');

  // Click previews (one at a time, with a stop button); it never touches the project.
  await page.getByTestId('lib-sample-bass.wav').click();
  await expect(page.getByTestId('preview-stop')).toBeEnabled();
  await page.getByTestId('preview-stop').click();
  await expect(page.getByTestId('preview-stop')).toBeDisabled();

  await drag(page, 'lib-sample-drums/kick.wav', 'row-0');
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  // The original bytes are kept for Save (same as a Finder drop).
  const kept = await page.evaluate(() => {
    const { project } = (window as unknown as { __daw: Daw }).__daw;
    const id = project.tracks[0].rows![0].sampleId!;
    const f = project.sampleFiles.get(id)!;
    return { name: f.name, bytes: [...new Uint8Array(f.bytes)] };
  });
  expect(kept.name).toBe('kick.wav');
  expect(kept.bytes).toEqual(kick);

  // "+ Add row" accepts a library drag too: a new row with that sample.
  await drag(page, 'lib-sample-bass.wav', 'add-row');
  await expect(page.getByTestId('row-8').getByTestId('row-name')).toHaveText('bass'); // after the default kit's eight
  await expect(page.getByTestId('banner')).toBeHidden();
  await page.getByTestId('lib-sample-drums/kick.wav').click(); // previewing, for the screenshot
  await expect(page.getByTestId('preview-stop')).toBeEnabled();
  await page.screenshot({ path: 'test-results/browser.png' });
  await page.getByTestId('preview-stop').click();

  // The built-in starter kit section, beside the folder: drags the same way (more in kit.spec.ts).
  await expect(page.getByTestId('library-name')).toHaveText(name);
  await expect(page.getByTestId('kit-sample-kick-deep.wav')).toBeVisible();
  await drag(page, 'kit-sample-snare.wav', 'row-1');
  await expect(page.getByTestId('row-1').getByTestId('row-name')).toHaveText('snare');
  await cleanup(page, name);
});

test('save patch then load from library', async ({ page }) => {
  test.setTimeout(30_000);
  await startAudio(page);
  const name = `e2e-lib-patch-${test.info().workerIndex}`;
  await makeLibrary(page, name, [
    {
      path: 'patches/Pad.json',
      text: JSON.stringify({ name: 'Pad', modules: [{ idx: 0, id: 'midi_in' }, { idx: 1, id: 'out' }], cables: [] }),
    },
    {
      path: 'patches/Broken.json',
      text: JSON.stringify({
        name: 'Broken',
        modules: [{ idx: 0, id: 'midi_in' }, { idx: 1, id: 'granular_cloud' }, { idx: 2, id: 'out' }],
        cables: [{ from: [1, 'out'], to: [2, 'l'] }, { from: [0, 'gate'], to: [2, 'nope'] }],
      }),
    },
  ]);
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.addSynthTrack('Lead'));
  await page.getByRole('button', { name: 'Instrument' }).click();

  // No library folder yet: Save patch is disabled and says why.
  await expect(page.getByTestId('patch-save')).toBeDisabled();
  await expect(page.getByTestId('patch-save')).toHaveAttribute('title', 'Choose a library folder to save patches');

  await attach(page, name);
  await expect(page.getByTestId('patch-save')).toBeEnabled();
  const lead = await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks[1].modules!.map((m) => [m.idx, m.kind, ...m.params]));
  await page.getByTestId('patch-save').click();
  await page.getByTestId('patch-save-name').fill('My Lead');
  await page.getByTestId('patch-save-ok').click();
  await expect(page.getByTestId('lib-patch-My Lead')).toBeVisible();
  const onDisk = await page.evaluate(async (name) => {
    const lib = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    const f = await (await (await lib.getDirectoryHandle('patches')).getFileHandle('My Lead.json')).getFile();
    return JSON.parse(await f.text());
  }, name);
  expect(onDisk.modules.map((m: { id: string }) => m.id)).toEqual(['midi_in', 'osc', 'lfo', 'filter', 'adsr', 'vca', 'out']);

  // Saving again under the same name asks inline before replacing (showing the name as it is saved).
  await page.getByTestId('patch-save').click();
  await page.getByTestId('patch-save-name').fill('My/Lead');
  await page.getByTestId('patch-save-ok').click();
  await expect(page.getByTestId('patch-replace')).toBeVisible();
  await expect(page.getByTestId('patch-replace')).toContainText('"My Lead"');
  await page.getByTestId('patch-replace-cancel').click();
  await expect(page.getByTestId('patch-replace')).toBeHidden();

  // Another patch, then the library one: the dropdown lists it after the starters.
  await page.getByTestId('patch-select').selectOption('Pad');
  await expect(page.getByTestId('patch-select')).toHaveValue('Pad');
  await page.getByTestId('patch-select').selectOption('lib:patches/My Lead.json');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks[1].patchName)).toBe('My Lead');
  const back = await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks[1].modules!.map((m) => [m.idx, m.kind, ...m.params]));
  expect(back).toEqual(lead);
  await expect(page.getByTestId('patch-select')).toHaveValue('lib:patches/My Lead.json');
  await expect(page.getByTestId('patch-warnings')).toBeHidden();

  // A library patch named like a starter (a hand-made file): the dropdown keeps showing the library one.
  await page.getByTestId('patch-select').selectOption('lib:patches/Pad.json');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks[1].modules!.length)).toBe(2);
  await expect(page.getByTestId('patch-select')).toHaveValue('lib:patches/Pad.json');

  // A broken library patch: what is valid loads, the rest is listed in a banner.
  await page.getByTestId('patch-select').selectOption('lib:patches/Broken.json');
  await expect(page.getByTestId('patch-warnings')).toBeVisible();
  await expect(page.getByTestId('patch-warnings')).toContainText('granular_cloud');
  await expect(page.getByTestId('patch-warnings')).toContainText('nope');
  const broken = await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks[1].modules!.length);
  expect(broken).toBe(2);
  await cleanup(page, name);
});

test('permission lost shows reconnect', async ({ page }) => {
  await startAudio(page);
  await expect(page.getByTestId('row-7').getByTestId('row-name')).toHaveText('Perc'); // the default kit has loaded
  const name = `e2e-lib-perm-${test.info().workerIndex}`;
  await makeLibrary(page, name, [{ path: 'kick.wav', bytes: kick }]);
  // A stored handle after a browser restart: queryPermission says 'prompt'
  // until the user grants it again (requestPermission, on the click).
  await page.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    const w = window as unknown as { __daw: Daw; __reqs: number };
    w.__reqs = 0;
    const handle = new Proxy(dir, {
      get(t, k) {
        if (k === 'queryPermission') return async () => 'prompt';
        if (k === 'requestPermission') return async () => (w.__reqs++, 'granted');
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    await w.__daw.library.attach(handle);
  }, name);
  await expect(page.getByTestId('library-reconnect')).toBeVisible();
  await expect(page.getByTestId('library-reconnect')).toHaveText('Reconnect folder');
  await expect(page.getByTestId('library-name')).toHaveText(name);
  await expect(page.getByTestId('library-message')).toContainText('Allow access');
  // No error spam: nothing in the app-wide banner, nothing asked before the click.
  await expect(page.getByTestId('banner')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __reqs: number }).__reqs)).toBe(0);
  await page.getByTestId('library-reconnect').click();
  await expect(page.getByTestId('lib-sample-kick.wav')).toBeVisible();
  await expect(page.getByTestId('library-reconnect')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __reqs: number }).__reqs)).toBe(1);

  // The folder deleted while in use: a drag fails quietly into "Reconnect folder".
  await page.evaluate(async (name) => (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }), name);
  await drag(page, 'lib-sample-kick.wav', 'row-0');
  await expect(page.getByTestId('library-reconnect')).toBeVisible();
  await expect(page.getByTestId('library-message')).toContainText('moved or deleted');
  await expect(page.getByTestId('banner')).toBeHidden();
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('Kick'); // unchanged (the default kit's)
  await cleanup(page, name);
});

test('library sample onto a SamplePlayer: picker shows it and a gate plays it', async ({ page }) => {
  test.setTimeout(30_000);
  await startAudio(page);
  const name = `e2e-lib-sp-${test.info().workerIndex}`;
  await makeLibrary(page, name, [{ path: 'kick.wav', bytes: kick }]);
  await attach(page, name);
  const slot = await page.evaluate(() => {
    const a = (window as unknown as { __daw: Daw }).__daw.actions;
    const t = a.addSynthTrack('Lead');
    a.loadPatch(t.id, {
      name: 'Sampler',
      modules: [{ idx: 0, id: 'midi_in' }, { idx: 1, id: 'sample_player' }, { idx: 2, id: 'out' }],
      cables: [
        { from: [0, 'pitch'], to: [1, 'pitch'] },
        { from: [0, 'gate'], to: [1, 'gate'] },
        { from: [1, 'out'], to: [2, 'l'] },
        { from: [1, 'out'], to: [2, 'r'] },
      ],
    });
    a.addNote(t.id, { pitch: 60, start: 0, len: 480, vel: 120 });
    return t.slot as number;
  });
  await page.getByRole('button', { name: 'Instrument' }).click();
  const picker = page.getByTestId('sample-1');
  await expect(picker.locator('option:checked')).toHaveText('— none —');
  await drag(page, 'lib-sample-kick.wav', 'module-1');
  await expect(picker.locator('option:checked')).toHaveText('kick');
  await page.keyboard.press('Space');
  const peak = await stripPeak(page, slot, 1500);
  await page.keyboard.press('Space');
  expect(peak).toBeGreaterThan(0.05);
  // The picker can clear it again (and lists the project's samples).
  await picker.selectOption({ label: '— none —' });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks[1].modules![1].params[0])).toBe(-1);
  await cleanup(page, name);
});

test('browser tabs and search filter the library', async ({ page }) => {
  test.setTimeout(30_000);
  await startAudio(page);
  const name = `e2e-lib-tabs-${test.info().workerIndex}`;
  await makeLibrary(page, name, [
    { path: 'drums/kick.wav', bytes: kick },
    { path: 'pads/warm.wav', bytes: kick },
    { path: 'bass.wav', bytes: [...makeWav(55, 200)] },
    { path: 'patches/Wobble.json', text: '{"name":"Wobble","modules":[],"cables":[]}' },
  ]);
  await attach(page, name);
  await expect(page.getByTestId('lib-patch-Wobble')).toBeVisible();
  await page.getByTestId('lib-folder-drums').click();
  await expect(page.getByTestId('lib-sample-drums/kick.wav')).toBeVisible();

  // Patches tab: only patches.
  await page.getByTestId('lib-tab-patches').click();
  await expect(page.getByTestId('lib-patch-Wobble')).toBeVisible();
  await expect(page.getByTestId('lib-sample-bass.wav')).toBeHidden();
  await expect(page.getByTestId('starter-kit')).toBeHidden();

  // Kits tab: only the starter kit.
  await page.getByTestId('lib-tab-kits').click();
  await expect(page.getByTestId('starter-kit')).toBeVisible();
  await expect(page.getByTestId('lib-patch-Wobble')).toBeHidden();

  // Samples tab + search: "kick" keeps the folder holding it, hides the rest.
  await page.getByTestId('lib-tab-samples').click();
  await expect(page.getByTestId('lib-sample-bass.wav')).toBeVisible();
  await page.getByTestId('lib-search').fill('KICK');
  await expect(page.getByTestId('lib-sample-drums/kick.wav')).toBeVisible();
  await expect(page.getByTestId('lib-sample-bass.wav')).toBeHidden();

  // Hint about unopened folders; folding a folder under a query keeps it listed.
  await expect(page.getByTestId('lib-search-hint')).toBeVisible();
  await page.getByTestId('lib-folder-drums').click();
  await expect(page.getByTestId('lib-folder-drums')).toBeVisible();
  await expect(page.getByTestId('lib-sample-drums/kick.wav')).toBeHidden();
  await page.getByTestId('lib-folder-drums').click();
  await expect(page.getByTestId('lib-sample-drums/kick.wav')).toBeVisible();

  // Previewing still works from a filtered list.
  await page.getByTestId('lib-sample-drums/kick.wav').click();
  await expect(page.getByTestId('preview-stop')).toBeEnabled();
  await page.getByTestId('preview-stop').click();

  // Clearing restores everything; an empty category says so.
  await page.getByTestId('lib-search').fill('');
  await expect(page.getByTestId('lib-sample-bass.wav')).toBeVisible();
  await page.getByTestId('lib-tab-patches').click();
  await page.getByTestId('lib-search').fill('zzz');
  await expect(page.getByTestId('browser')).toContainText('No patches match');
  await cleanup(page, name);
});
