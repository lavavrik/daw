import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { withAppendedParams } from '../../app/src/project/testdata/appendedParams';
import { makeWav } from './wav';
import { closeMore, openMore } from './topbar';

// Project save/load through OPFS (an origin-private folder: no picker). The
// app's debug hooks __daw.saveTo(handle) / __daw.openFrom(handle) run the
// same code as Project ▸ Save / Open with a FileSystemDirectoryHandle.

type Daw = {
  engine: { telemetry(): Float64Array; meters(): Float32Array } | null;
  project: {
    name: string;
    dirty: boolean;
    playing: boolean;
    tracks: { id: string; slot: number; kind: string; name: string; rows?: { id: string; name: string; sampleId: number | null }[]; patterns: { notes?: unknown[] }[] }[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, (...args: any[]) => any>;
  saveTo(dir: FileSystemDirectoryHandle): Promise<void>;
  openFrom(dir: FileSystemDirectoryHandle): Promise<string[]>;
  autosave: { lastSaved: number | null; flush(): Promise<void> };
  newProject(): Promise<void>;
};
const daw = () => (window as unknown as { __daw: Daw }).__daw;

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

async function dropFiles(page: Page, testid: string, files: { name: string; bytes: number[] }[]) {
  await page.evaluate(
    ({ testid, files }) => {
      const el = document.querySelector(`[data-testid="${testid}"]`)!;
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'audio/wav' }));
      for (const t of ['dragenter', 'dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    { testid, files },
  );
}

/** Kick sample on row 0 (four on the floor) + a Chord Stab track with a held chord. */
async function makeBeat(page: Page) {
  await dropFiles(page, 'row-0', [{ name: 'kick.wav', bytes: [...makeWav(80, 120)] }]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as { __daw: Daw }).__daw;
    const d = project.tracks[0];
    for (const s of [0, 4, 8, 12]) a.setStep(d.id, d.rows![0].id, s, 120);
    const synth = a.addSynthTrack('Chord Stab');
    for (const pitch of [48, 52, 55]) a.addNote(synth.id, { pitch, start: 0, len: 15360, vel: 100 });
    a.addNote(synth.id, { pitch: 60, start: 1920, len: 480, vel: 100 });
  });
}

/** Max meter peak per strip (track slots) over `ms` of playback. */
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
 * Max meter peak of each track's pattern over `ms` (indexed by slot), track by
 * track in `order`: the pattern transport plays only the selected track (plan
 * 20 task 12), so each track header is clicked in turn while it plays (the
 * focus follows). The synth goes first: a note sounds only from its start (a
 * track focused mid-note waits for the next one), and the chord starts at
 * tick 0 of a 4-bar pattern; the drums hit on every beat.
 */
async function patternPeaks(page: Page, order: number[], ms: number) {
  const out: number[] = [];
  await page.getByTestId(`track-${order[0]}`).click();
  await page.getByTestId('pattern-play').click();
  for (const s of order) {
    await page.getByTestId(`track-${s}`).click();
    out[s] = (await stripPeaks(page, [s], ms))[0];
  }
  await page.getByTestId('pattern-stop').click();
  return out;
}

/** A fresh OPFS folder for this test. */
async function opfsDir(page: Page, name: string) {
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name, { recursive: true }).catch(() => {});
    await root.getDirectoryHandle(name, { create: true });
  }, name);
}

const summary = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __daw: Daw }).__daw.project.tracks.map((t) => ({
      kind: t.kind,
      name: t.name,
      rows: t.rows?.map((r) => r.name),
      notes: t.patterns.map((p) => p.notes?.length ?? 0),
    })),
  );

test('save then load reproduces the beat', async ({ page }) => {
  test.setTimeout(60_000);
  await startAudio(page);
  await makeBeat(page);
  await expect(page.getByTestId('project-name')).toContainText('unsaved');
  const before = await patternPeaks(page, [1, 0], 2000); // the beat is patterns: Pattern mode
  expect(before[0]).toBeGreaterThan(0.01);
  expect(before[1]).toBeGreaterThan(0.01);
  const want = await summary(page);

  const dirName = `e2e-save-${test.info().workerIndex}`;
  await opfsDir(page, dirName);
  await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    await (window as unknown as { __daw: Daw }).__daw.saveTo(dir);
  }, dirName);
  await expect(page.getByTestId('project-name')).not.toContainText('unsaved');
  const listing = await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    const s = await dir.getDirectoryHandle('samples');
    const names: string[] = [];
    for await (const [k] of s.entries()) names.push(k);
    const json = JSON.parse(await (await (await dir.getFileHandle('project.json')).getFile()).text());
    return { names, version: json.schemaVersion, tmp: await dir.getFileHandle('project.json.tmp').then(() => true, () => false) };
  }, dirName);
  expect(listing).toMatchObject({ version: 4, tmp: false }); // plan 14: schema v4
  // The kick plus the default kit's other seven rows (plan 8 Task 4: the kit is in the project).
  expect(listing.names).toHaveLength(8);
  expect(listing.names).toContainEqual(expect.stringMatching(/^\d+-[0-9a-f]{8}-kick\.wav$/)); // <id>-<content hash>-<name>
  expect(listing.names).toContainEqual(expect.stringMatching(/^\d+-[0-9a-f]{8}-clap\.wav$/));

  // A new session: reload, start audio, open the folder.
  await startAudio(page);
  const warnings = await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    return (window as unknown as { __daw: Daw }).__daw.openFrom(dir);
  }, dirName);
  expect(warnings).toEqual([]);
  expect(await summary(page)).toEqual(want);
  await expect(page.getByTestId('project-name')).not.toContainText('unsaved');
  const after = await patternPeaks(page, [1, 0], 2000);
  expect(after[0]).toBeGreaterThan(0.01);
  expect(after[1]).toBeGreaterThan(0.01);
  await expect(page.getByTestId('banner')).toBeHidden();
});

test('load while playing stops cleanly (no stuck notes)', async ({ page }) => {
  test.setTimeout(60_000);
  await startAudio(page);
  await makeBeat(page);
  const dirName = `e2e-playing-${test.info().workerIndex}`;
  await opfsDir(page, dirName);
  await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    await (window as unknown as { __daw: Daw }).__daw.saveTo(dir);
  }, dirName);
  await page.getByTestId('pattern-play').click();
  expect((await stripPeaks(page, [1], 1000))[0]).toBeGreaterThan(0.01); // the chord is sounding
  const result = await page.evaluate(async (n) => {
    const d = (window as unknown as { __daw: Daw }).__daw;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    const warnings = await d.openFrom(dir);
    // From the end of the load: the output must fall below 0.001 within 1 s.
    const t0 = performance.now();
    return new Promise<{ warnings: string[]; ms: number; playing: boolean; engPlaying: number }>((resolve) => {
      const id = setInterval(() => {
        const t = d.engine!.telemetry();
        const ms = performance.now() - t0;
        if ((t[5] < 0.001 && t[6] < 0.001) || ms > 1000) {
          clearInterval(id);
          resolve({ warnings, ms, playing: d.project.playing, engPlaying: t[1] });
        }
      }, 10);
    });
  }, dirName);
  expect(result.warnings).toEqual([]);
  expect(result.ms).toBeLessThan(1000);
  expect(result.playing).toBe(false);
  expect(result.engPlaying).toBe(0);
  // Still silent a moment later (nothing restarted, no hanging voice).
  await page.waitForTimeout(500);
  const peak = await page.evaluate(() => {
    const t = (window as unknown as { __daw: Daw }).__daw.engine!.telemetry();
    return Math.max(t[5], t[6]);
  });
  expect(peak).toBeLessThan(0.001);
  await expect(page.getByTestId('play')).toHaveText(/Play/);
});

test('dropping several files on "+ Add row" adds one row per file', async ({ page }) => {
  await startAudio(page);
  await dropFiles(page, 'add-row', [
    { name: 'a.wav', bytes: [...makeWav(100)] },
    { name: 'b.wav', bytes: [...makeWav(200)] },
    { name: 'c.wav', bytes: [...makeWav(300)] },
  ]);
  // After the default kit's eight rows (plan 8 Task 4).
  await expect(page.getByTestId('row-10').getByTestId('row-name')).toHaveText('c');
  await expect(page.getByTestId('row-8').getByTestId('row-name')).toHaveText('a');
  await expect(page.getByTestId('row-9').getByTestId('row-name')).toHaveText('b');
});

test('Project menu: New asks inline before discarding unsaved changes', async ({ page }) => {
  await startAudio(page);
  await expect(page.getByTestId('project-name')).toHaveText('Untitled');
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.addSynthTrack('Lead'));
  await expect(page.getByTestId('project-name')).toContainText('● unsaved');
  await openMore(page);
  await page.getByTestId('project-new').click();
  await expect(page.getByTestId('project-discard')).toBeVisible();
  await page.getByTestId('project-discard').click();
  await expect(page.getByTestId('project-name')).toHaveText('Untitled');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.map((t) => t.kind))).toEqual(['drum']);
});

test('⌘O / Ctrl+O on a dirty project asks the same "Discard and open…" question (I1)', async ({ page }) => {
  await startAudio(page);
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.addSynthTrack('Lead'));
  await expect(page.getByTestId('project-name')).toContainText('● unsaved');
  await page.keyboard.press('ControlOrMeta+O');
  await expect(page.getByTestId('project-discard')).toBeVisible();
  await expect(page.getByTestId('project-discard')).toHaveText(/Discard and open/);
  await expect(page.getByTestId('project-discard-warning')).toHaveText('Unsaved changes in "Untitled" will be lost.');
  await page.getByTestId('project-discard-cancel').click();
  await expect(page.getByTestId('project-discard')).toBeHidden();
  // Nothing was replaced.
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.map((t) => t.kind))).toEqual(['drum', 'synth']);
  await expect(page.getByTestId('project-name')).toContainText('● unsaved');
});

test('closing the tab with unsaved edits to a saved project asks first (P9)', async ({ page }) => {
  await startAudio(page);
  const dirName = `e2e-unload-${test.info().workerIndex}`;
  await opfsDir(page, dirName);
  await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    await (window as unknown as { __daw: Daw }).__daw.saveTo(dir);
  }, dirName);
  await page.getByTestId('pattern-play').click(); // a real gesture (the prompt needs one) …
  await page.getByTestId('pattern-stop').click(); // … that leaves the transport stopped
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.addSynthTrack('Lead'));
  await expect(page.getByTestId('project-name')).toContainText('● unsaved');
  const dialog = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const d = await dialog;
  expect(d.type()).toBe('beforeunload');
  await d.accept();
});

test('restore banner appears and restores', async ({ page }) => {
  test.setTimeout(60_000);
  await startAudio(page);
  await expect(page.getByTestId('restore')).toBeHidden(); // a fresh browser profile: nothing to restore
  await makeBeat(page);
  await page.evaluate(() => ((window as unknown as { __daw: Daw }).__daw.project.name = 'Night Drive'));
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.setMix('master', 'fader', -3)); // one more edit after the rename
  const want = await summary(page);
  // The debounced autosave (5 s after the last edit) lands in OPFS.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.autosave.lastSaved), { timeout: 15_000 })
    .not.toBeNull();
  const written = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('autosave');
    const marker = JSON.parse(await (await (await dir.getFileHandle('autosave.json')).getFile()).text());
    return { name: marker.project.name, samples: marker.project.samples.length };
  });
  expect(written).toEqual({ name: 'Night Drive', samples: 8 }); // the kick + the default kit's other seven

  // Reload (a crash or a closed tab): the next start offers the session back.
  await startAudio(page);
  const offer = page.getByTestId('restore');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('Night Drive');
  expect(await summary(page)).not.toEqual(want); // a fresh session until Restore
  // The fresh session is not dirty, but Open / New would discard the offer: they ask first (I1).
  await page.keyboard.press('ControlOrMeta+O');
  await expect(page.getByTestId('project-discard-warning')).toContainText('Discard the unrestored session "Night Drive"?');
  await page.getByTestId('project-discard-cancel').click();
  await closeMore(page);
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: 'Restore last session' }).click();
  await expect(offer).toBeHidden();
  await expect.poll(() => summary(page)).toEqual(want);
  await expect(page.getByTestId('project-name')).toContainText('Night Drive');
  await expect(page.getByTestId('project-name')).toContainText('unsaved');
  const peaks = await patternPeaks(page, [1, 0], 2000);
  expect(peaks[0]).toBeGreaterThan(0.01); // the kick (its sample came back from OPFS)
  expect(peaks[1]).toBeGreaterThan(0.01);

  // "Start fresh" removes it: the next start offers nothing.
  await startAudio(page);
  await page.getByTestId('restore').getByRole('button', { name: 'Start fresh' }).click();
  await expect(page.getByTestId('restore')).toBeHidden();
  await expect
    .poll(() => page.evaluate(async () => (await navigator.storage.getDirectory()).getDirectoryHandle('autosave').then(() => true, () => false)))
    .toBe(false);
  await startAudio(page);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('restore')).toBeHidden();

  // Leave no autosave state behind.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const n of ['autosave', 'autosave.tmp']) await root.removeEntry(n, { recursive: true }).catch(() => {});
    localStorage.removeItem('daw.lastExplicitSave');
  });
});

test('an explicit save makes the older autosave stale (no offer)', async ({ page }) => {
  test.setTimeout(30_000);
  await startAudio(page);
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.addSynthTrack('Lead'));
  // An autosave really exists before the save (the start-up hold may have deferred a flush).
  await expect
    .poll(() => page.evaluate(async () => {
      const a = (window as unknown as { __daw: Daw }).__daw.autosave;
      await a.flush();
      return a.lastSaved;
    }), { timeout: 15_000 })
    .not.toBeNull();
  const dirName = `e2e-stale-${test.info().workerIndex}`;
  await opfsDir(page, dirName);
  await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(n);
    await (window as unknown as { __daw: Daw }).__daw.saveTo(dir);
  }, dirName);
  await startAudio(page);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('restore')).toBeHidden();
  await page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    for (const x of ['autosave', 'autosave.tmp', n]) await root.removeEntry(x, { recursive: true }).catch(() => {});
    localStorage.removeItem('daw.lastExplicitSave');
  }, dirName);
});

test('New right after start deletes the autosave', async ({ page }) => {
  test.setTimeout(30_000);
  await startAudio(page);
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.addSynthTrack('Lead'));
  await expect
    .poll(() => page.evaluate(async () => {
      const a = (window as unknown as { __daw: Daw }).__daw.autosave;
      await a.flush();
      return a.lastSaved;
    }), { timeout: 15_000 })
    .not.toBeNull();
  // Reload; click start and New at once: New runs in the very task that
  // wired the engine (before any start-up check after audio could finish).
  await page.goto('/');
  await page.evaluate(() => {
    const w = window as unknown as { __daw: Daw & { engine: unknown } };
    const d = w.__daw;
    let e: unknown = null;
    Object.defineProperty(d, 'engine', {
      configurable: true,
      get: () => e,
      set: (v) => {
        e = v;
        if (v) queueMicrotask(() => void d.newProject());
      },
    });
    document.querySelector<HTMLButtonElement>('button.overlay')!.click();
  });
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.length)).toBe(1);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('restore')).toBeHidden(); // no offer of the session New discarded
  // After another reload no restore offer shows: the autosave is gone.
  await startAudio(page);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('restore')).toBeHidden();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const x of ['autosave', 'autosave.tmp']) await root.removeEntry(x, { recursive: true }).catch(() => {});
    localStorage.removeItem('daw.lastExplicitSave');
  });
});

test('a second tab neither autosaves nor offers the first tab\'s session', async ({ page, context }) => {
  test.setTimeout(30_000);
  await startAudio(page);
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.addSynthTrack('Lead'));
  await expect
    .poll(() => page.evaluate(async () => {
      const a = (window as unknown as { __daw: Daw }).__daw.autosave;
      await a.flush();
      return a.lastSaved;
    }), { timeout: 15_000 })
    .not.toBeNull();
  const second = await context.newPage();
  // Said at mount, before audio starts, and kept while this tab is not the owner.
  await second.goto('/');
  await expect(second.getByTestId('autosave-off')).toContainText('Autosave is off — this project is open in another tab');
  await second.waitForTimeout(300);
  await second.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(second.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
  await expect(second.getByTestId('autosave-off')).toContainText('Autosave is off — this project is open in another tab');
  await second.waitForTimeout(300);
  await expect(second.getByTestId('restore')).toBeHidden();
  await second.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.addSynthTrack('Pad'));
  await second.evaluate(() => (window as unknown as { __daw: Daw }).__daw.autosave.flush());
  expect(await second.evaluate(() => (window as unknown as { __daw: Daw }).__daw.autosave.lastSaved)).toBeNull();
  await second.close();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const x of ['autosave', 'autosave.tmp']) await root.removeEntry(x, { recursive: true }).catch(() => {});
    localStorage.removeItem('daw.lastExplicitSave');
  });
});


// Plan 9: schema v2; plan 10: v3; plan 14: v4. The frozen genuine v1 save
// (app/src/project/testdata, also pinned by migrate.test.ts) opens with no
// warnings, and saving it writes a v4 project.json that carries every v1
// field over unchanged (plus the empty automation lanes v3 adds and the
// empty MIDI mapping list v4 adds).
test('v1 project opens in v4', async ({ page }) => {
  test.setTimeout(30_000);
  const v1 = JSON.parse(readFileSync(new URL('../../app/src/project/testdata/v1-fixture.json', import.meta.url), 'utf8'));
  expect(v1.schemaVersion).toBe(1);
  await startAudio(page);
  const w = test.info().workerIndex;
  const src = `e2e-v1-${w}`;
  const dst = `e2e-v1-saved-${w}`;
  const files = (v1.samples as { file: string }[]).map((s, i) => ({ file: s.file.split('/')[1], bytes: [...makeWav(100 + 50 * i, 80)] }));
  const warnings = await page.evaluate(
    async ({ src, dst, json, files }) => {
      const root = await navigator.storage.getDirectory();
      for (const n of [src, dst]) await root.removeEntry(n, { recursive: true }).catch(() => {});
      const dir = await root.getDirectoryHandle(src, { create: true });
      const put = async (d: FileSystemDirectoryHandle, name: string, data: FileSystemWriteChunkType) => {
        const wr = await (await d.getFileHandle(name, { create: true })).createWritable();
        await wr.write(data);
        await wr.close();
      };
      await put(dir, 'project.json', json);
      const samples = await dir.getDirectoryHandle('samples', { create: true });
      for (const f of files) await put(samples, f.file, new Uint8Array(f.bytes));
      return (window as unknown as { __daw: Daw }).__daw.openFrom(dir);
    },
    { src, dst, json: JSON.stringify(v1), files },
  );
  expect(warnings).toEqual([]);
  await expect(page.getByTestId('banner')).toBeHidden();
  await expect(page.getByTestId('project-name')).toContainText('Fixture');
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.map((t) => [t.kind, t.name]))).toEqual(
    (v1.tracks as { kind: string; name: string }[]).map((t) => [t.kind, t.name]),
  );

  const out = await page.evaluate(async (dst) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(dst, { create: true });
    await (window as unknown as { __daw: Daw }).__daw.saveTo(dir);
    return JSON.parse(await (await (await dir.getFileHandle('project.json')).getFile()).text());
  }, dst);
  expect(out.schemaVersion).toBe(4);
  // Everything but the version, the sample file names (they carry the content
  // hash), the empty lanes (v2 -> v3) and mappings (v3 -> v4) is as saved in v1.
  const strip = (j: { schemaVersion: number; samples: { file: string }[] }) => ({ ...j, schemaVersion: 0, samples: j.samples.map((s) => ({ ...s, file: s.file.replace(/-[0-9a-f]{8}-/, '-#-') })) });
  // Params appended to the catalog since (appendedParams.ts) are written with their defaults.
  const v4 = { ...v1, tracks: v1.tracks.map((t: object) => ({ ...withAppendedParams(t), automation: [] })), mixer: { ...v1.mixer, automation: [] }, midiMap: [] };
  expect(strip(out)).toEqual(strip(v4));

  await page.evaluate(async (names) => {
    const root = await navigator.storage.getDirectory();
    for (const n of names) await root.removeEntry(n, { recursive: true }).catch(() => {});
  }, [src, dst]);
});

// Plan 10 Task 5: the checked-in plan-9 save (schema 2, with Audio tracks)
// opens with no warnings, plays its Audio tracks, and saves as v4 (plan 14)
// with every v2 field unchanged: the only additions are the empty lanes and
// the empty MIDI mapping list.
test('v2 project opens in v4', async ({ page }) => {
  test.setTimeout(30_000);
  const v2 = JSON.parse(readFileSync(new URL('../../app/src/project/testdata/v2-fixture.json', import.meta.url), 'utf8'));
  expect(v2.schemaVersion).toBe(2);
  const audioIds = new Set(
    (v2.tracks as { kind: string; clips: { sample: number | null }[] }[]).filter((t) => t.kind === 'audio').flatMap((t) => t.clips.map((c) => c.sample)).filter((x) => x !== null),
  );
  expect(audioIds.size).toBe(2); // and one clip without a sample
  await startAudio(page);
  const w = test.info().workerIndex;
  const src = `e2e-v2-${w}`;
  const dst = `e2e-v2-saved-${w}`;
  // The audio clips' files are long enough for their offsets and lengths (2 s); the drum rows' are short.
  const files = (v2.samples as { id: number; file: string }[]).map((s, i) => ({
    file: s.file.split('/')[1],
    bytes: [...makeWav(100 + 50 * i, audioIds.has(s.id) ? 2000 : 80)],
  }));
  const warnings = await page.evaluate(
    async ({ src, dst, json, files }) => {
      const root = await navigator.storage.getDirectory();
      for (const n of [src, dst]) await root.removeEntry(n, { recursive: true }).catch(() => {});
      const dir = await root.getDirectoryHandle(src, { create: true });
      const put = async (d: FileSystemDirectoryHandle, name: string, data: FileSystemWriteChunkType) => {
        const wr = await (await d.getFileHandle(name, { create: true })).createWritable();
        await wr.write(data);
        await wr.close();
      };
      await put(dir, 'project.json', json);
      const samples = await dir.getDirectoryHandle('samples', { create: true });
      for (const f of files) await put(samples, f.file, new Uint8Array(f.bytes));
      return (window as unknown as { __daw: Daw }).__daw.openFrom(dir);
    },
    { src, dst, json: JSON.stringify(v2), files },
  );
  expect(warnings).toEqual([]);
  await expect(page.getByTestId('banner')).toBeHidden();
  await expect(page.getByTestId('project-name')).toContainText('Fixture');
  const tracks = await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.map((t) => ({ kind: t.kind, name: t.name, slot: t.slot })));
  expect(tracks.map((t) => [t.kind, t.name])).toEqual((v2.tracks as { kind: string; name: string }[]).map((t) => [t.kind, t.name]));
  // The opened project has no lanes, and its Audio tracks are heard in Song mode.
  await expect(page.locator('[data-testid^="auto-lane-"]')).toHaveCount(0);
  const audioSlots = tracks.filter((t) => t.kind === 'audio').map((t) => t.slot);
  await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.actions.seek(0));
  await page.getByTestId('play').click(); // song Play
  await expect.poll(async () => Math.min(...(await stripPeaks(page, audioSlots, 600))), { timeout: 5_000 }).toBeGreaterThan(0.01);
  await page.getByTestId('play').click();

  const out = await page.evaluate(async (dst) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(dst, { create: true });
    await (window as unknown as { __daw: Daw }).__daw.saveTo(dir);
    return JSON.parse(await (await (await dir.getFileHandle('project.json')).getFile()).text());
  }, dst);
  expect(out.schemaVersion).toBe(4);
  // Everything but the version, the sample file names (they carry the content
  // hash), the mode (Song, switched above to listen), the empty lanes and mappings is as saved in v2.
  const strip = (j: { schemaVersion: number; mode: string; samples: { file: string }[] }) => ({
    ...j,
    schemaVersion: 0,
    mode: '',
    samples: j.samples.map((s) => ({ ...s, file: s.file.replace(/-[0-9a-f]{8}-/, '-#-') })),
  });
  // Params appended to the catalog since (appendedParams.ts) are written with their defaults.
  const v4 = { ...v2, tracks: v2.tracks.map((t: object) => ({ ...withAppendedParams(t), automation: [] })), mixer: { ...v2.mixer, automation: [] }, midiMap: [] };
  expect(out.tracks.filter((t: { kind: string }) => t.kind === 'audio').map((t: { clips: unknown[] }) => t.clips)).toEqual(
    v2.tracks.filter((t: { kind: string }) => t.kind === 'audio').map((t: { clips: unknown[] }) => t.clips),
  );
  expect(strip(out)).toEqual(strip(v4));

  await page.evaluate(async (names) => {
    const root = await navigator.storage.getDirectory();
    for (const n of names) await root.removeEntry(n, { recursive: true }).catch(() => {});
  }, [src, dst]);
});
