import { expect, test, type Page } from '@playwright/test';
import { openMenu } from './topbar';
import { startApp } from './startApp';

// File ▸ New from template ▸ (plan 27 Task 2; state/templates.ts,
// docs/architecture/projects.md "Templates"), driven through the menu. The
// project is read from window.__daw; the sound from the engine's telemetry
// output peaks (project.spec.ts).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const daw = <T>(page: Page, fn: (d: Any, arg?: Any) => T, arg?: unknown) =>
  page.evaluate(`(${fn.toString()})(window.__daw, ${JSON.stringify(arg)})`) as Promise<T>;

const BAR = 3840;

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  // The starter kit lands first (the session a template replaces).
  await expect.poll(() => daw(page, (d) => d.project.tracks[0]?.rows?.every((r: Any) => r.sampleId !== null) ?? false)).toBe(true);
}

/** File ▸ New from template ▸ `id` (the submenu opens on a click). */
async function pickTemplate(page: Page, id: string) {
  await openMenu(page, 'File');
  await page.getByTestId('project-new-template').click();
  await page.getByTestId(`menu-template-${id}`).click();
}

/** The template's kit has landed on every drum row. */
const kitLanded = (page: Page) =>
  expect.poll(() => daw(page, (d) => d.project.tracks.filter((t: Any) => t.kind === 'drum').every((t: Any) => t.rows.every((r: Any) => r.sampleId !== null)))).toBe(true);

test('Deep House 122: tempo, four tracks with clips across 32 bars; clean, no undo; it plays', async ({ page }) => {
  await start(page);
  await pickTemplate(page, 'deep-house-122');
  await expect(page.getByTestId('project-name')).toHaveText('Deep House 122');
  await expect.poll(() => daw(page, (d) => d.project.tempo)).toBe(122);
  await kitLanded(page);
  type Shape = { name: string; kind: string; clips: number; end: number; start: number };
  const shape = await daw<Shape[]>(page, (d) => d.project.tracks.map((t: Any) => ({
    name: t.name, kind: t.kind, clips: t.clips.length,
    end: Math.max(...t.clips.map((c: Any) => c.start + c.len)), start: Math.min(...t.clips.map((c: Any) => c.start)),
  })));
  expect(shape.map((t) => [t.name, t.kind])).toEqual([['Drums', 'drum'], ['Bass', 'synth'], ['Keys', 'synth'], ['Pad', 'synth']]);
  expect(shape.every((t) => t.clips > 0)).toBe(true);
  expect(Math.max(...shape.map((t) => t.end))).toBe(32 * BAR);
  expect(Math.min(...shape.map((t) => t.start))).toBe(0);
  await expect(page.getByTestId('project-name')).not.toContainText('unsaved');
  // Still clean once the dirty check has run after the samples landed; nothing to undo.
  await page.waitForTimeout(800);
  expect(await daw(page, (d) => [d.project.dirty, d.history.canUndo, d.history.canRedo])).toEqual([false, false, false]);
  await expect(page.getByTestId('project-name')).not.toContainText('unsaved');
  await openMenu(page, 'Edit');
  await expect(page.getByTestId('menu-undo')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  // Play from bar 1 (the intro: drums) and the output peaks.
  await page.getByTestId('play').click();
  const peak = await daw<Promise<number>>(page, (d) => new Promise((resolve) => {
    let max = 0;
    const t0 = performance.now();
    const id = setInterval(() => {
      const t = d.engine.telemetry();
      max = Math.max(max, t[5], t[6]);
      if (performance.now() - t0 > 2500) {
        clearInterval(id);
        resolve(max);
      }
    }, 20);
  }));
  await page.getByTestId('play').click(); // stop
  expect(peak).toBeGreaterThan(0.05);
});

test('Garage 130 is in F minor: the key button says so, and its bass is the factory line a major third down', async ({ page }) => {
  await start(page);
  await pickTemplate(page, 'garage-130');
  await expect.poll(() => daw(page, (d) => ({ ...d.project.key }))).toEqual({ root: 5, scale: 'minor' });
  await expect.poll(() => daw(page, (d) => d.project.tempo)).toBe(130);
  await page.getByTestId('track-1').click(); // the Bass (slot 1)
  await expect(page.getByRole('button', { name: 'Piano roll' })).toHaveClass(/active/);
  await expect(page.getByTestId('pr-key')).toContainText('F min');
  // Garage sub starts on A1 (33) in the factory: F1 (29) here.
  const first = await daw(page, (d) => {
    const t = d.project.tracks[1];
    return [...t.patterns[0].notes].sort((a: Any, b: Any) => a.start - b.start)[0].pitch;
  });
  expect(first).toBe(29);
  await kitLanded(page);
  expect(await daw(page, (d) => d.project.dirty)).toBe(false);
});

test('a template over unsaved changes asks first, the same way New does', async ({ page }) => {
  await start(page);
  await daw(page, (d) => d.actions.addSynthTrack('Lead'));
  await expect(page.getByTestId('project-name')).toContainText('● unsaved');
  await pickTemplate(page, 'acid-126');
  await expect(page.getByTestId('project-discard-warning')).toHaveText('Unsaved changes in "Untitled" will be lost.');
  await expect(page.getByTestId('project-discard')).toHaveText(/Discard and start new/);
  await expect(page.getByTestId('project-discard-cancel')).toBeFocused();
  await page.getByTestId('project-discard-cancel').click();
  // Nothing was replaced.
  expect(await daw(page, (d) => d.project.tracks.map((t: Any) => t.kind))).toEqual(['drum', 'synth']);
  await expect(page.getByTestId('project-name')).toContainText('● unsaved');

  await page.keyboard.press('Escape');
  await pickTemplate(page, 'acid-126');
  await page.getByTestId('project-discard').click();
  await expect(page.getByTestId('project-name')).toHaveText('Acid 126');
  await expect.poll(() => daw(page, (d) => [d.project.tempo, d.project.tracks.map((t: Any) => t.name)])).toEqual([126, ['Drums', 'Acid', 'Stab']]);
  await kitLanded(page);
  expect(await daw(page, (d) => [d.project.dirty, d.history.canUndo])).toEqual([false, false]);

  // Empty is plain New: the default kit's drum track.
  await pickTemplate(page, 'empty');
  await expect(page.getByTestId('project-name')).toHaveText('Untitled');
  await expect.poll(() => daw(page, (d) => d.project.tracks.map((t: Any) => t.kind))).toEqual(['drum']);
});

test('every other template plays too: a couple of bars of its groove each, peak > 0.05', async ({ page }) => {
  await start(page);
  for (const id of ['garage-130', 'acid-126', 'tech-house-125']) {
    await daw(page, (d, a) => d.newFromTemplate(a), id);
    await kitLanded(page);
    await daw(page, (d) => d.actions.seek(8 * 3840)); // bar 9: the groove (drums, bass, chords)
    await page.getByTestId('play').click();
    await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'true');
    const peak = await daw<Promise<number>>(page, (d) => new Promise((resolve) => {
      let max = 0;
      const t0 = performance.now();
      const iv = setInterval(() => {
        const t = d.engine.telemetry();
        max = Math.max(max, t[5], t[6]);
        if (performance.now() - t0 > 2000) {
          clearInterval(iv);
          resolve(max);
        }
      }, 20);
    }));
    await page.getByTestId('play').click(); // stop
    await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'false');
    expect(peak, id).toBeGreaterThan(0.05);
  }
});

// ?template=<id> on the page URL (state/templates.ts templateFromUrl, App.svelte
// onstarted): that template replaces the default drum track at start-up.
test('?template=garage-130 opens Garage 130 at start-up, clean, its kit landed', async ({ page }) => {
  await page.goto('/?template=garage-130');
  await startApp(page);
  await expect(page.getByTestId('project-name')).toHaveText('Garage 130');
  await expect.poll(() => daw(page, (d) => d.project.tempo)).toBe(130);
  await kitLanded(page);
  expect(await daw(page, (d) => d.project.tracks[0].name)).toBe('Drums');
  await page.waitForTimeout(800);
  expect(await daw(page, (d) => [d.project.dirty, d.history.canUndo])).toEqual([false, false]);
  await expect(page.getByTestId('banner')).toBeHidden();
});

test('an unknown ?template= starts the default session with a banner naming the templates', async ({ page }) => {
  await page.goto('/?template=polka-90');
  await startApp(page);
  await expect(page.getByTestId('banner')).toContainText('No template "polka-90"');
  await expect(page.getByTestId('banner')).toContainText('deep-house-122');
  expect(await daw(page, (d) => d.project.tracks.map((t: Any) => t.name))).toEqual(['Drums']);
  await expect(page.getByTestId('project-name')).toContainText('Untitled');
});

test('?template= still offers an unrestored autosave, after the template loads', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await daw(page, (d) => { d.project.name = 'Night Drive'; d.actions.setMix('master', 'fader', -3); });
  await expect.poll(() => daw(page, (d) => d.autosave.lastSaved), { timeout: 15_000 }).not.toBeNull();

  await page.goto('/?template=acid-126');
  await startApp(page);
  await expect(page.getByTestId('project-name')).toHaveText('Acid 126');
  const offer = page.getByTestId('restore');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('Night Drive');
  await offer.getByRole('button', { name: 'Restore last session' }).click();
  await expect(page.getByTestId('project-name')).toContainText('Night Drive');

  // Leave no autosave state behind.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const n of ['autosave', 'autosave.tmp']) await root.removeEntry(n, { recursive: true }).catch(() => {});
    localStorage.removeItem('daw.lastExplicitSave');
  });
});
