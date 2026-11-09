import { expect, test, type Page } from '@playwright/test';
import mixerCatalog from '../../engine/mixer_catalog.json' with { type: 'json' };
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// Mixer strip presets and Duck to kick (plan 27 Task 1;
// docs/architecture/mixer.md "Strip presets"), driven through each strip's
// Presets menu. Values are read from the project (window.__daw) and the
// strip's own controls; the pump from the strip meter's data-peak-db, as
// mixer.spec.ts's sidechain test does.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const daw = <T>(page: Page, fn: (d: Any, arg?: Any) => T, arg?: unknown) =>
  page.evaluate(`(${fn.toString()})(window.__daw, ${JSON.stringify(arg)})`) as Promise<T>;

const KIT = ['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc'];

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
  // The starter kit lands asynchronously: wait for its rows (Duck to kick finds the Kick by its row name).
  for (const [i, name] of KIT.entries()) await expect(page.getByTestId(`row-${i}`).getByTestId('row-name')).toHaveText(name);
}

const strip = (page: Page, id: string | number) => page.getByTestId(`strip-${id}`);

async function openMixer(page: Page) {
  await page.getByTestId('mixer-tab').click();
  await expect(page.getByTestId('mixer')).toBeVisible();
}

/** Open strip `id`'s Presets menu; returns the card. */
async function openPresets(page: Page, id: string | number) {
  await strip(page, id).getByTestId('strip-presets').click();
  const card = page.getByTestId('strip-presets-pop');
  await expect(card).toBeVisible();
  return card;
}

/** Mixer param `name` of channel `ch` (a track index, a return id such as 'reverb' / 'delay', or 'master'). */
const param = (page: Page, ch: number | string, name: string) =>
  daw<number>(page, (d, a) => {
    const m = d.project.mixer;
    const c = typeof a.ch === 'number' ? m.channels[d.project.tracks[a.ch].id] : a.ch === 'master' ? m.master : m.returns.find((r: { id: string }) => r.id === a.ch)!;
    return c.params[a.id];
  }, { ch, id: mixerCatalog.params.find((x) => x.name === name)!.id });

/** Sample a strip meter's shown peak at every animation frame for `ms`; min/max in dB (mixer.spec.ts). */
function meterRange(page: Page, testid: string, ms: number) {
  return page.evaluate(
    ({ testid, ms }) =>
      new Promise<{ min: number; max: number; n: number }>((resolve) => {
        const el = document.querySelector(`[data-testid="${testid}"] [data-testid="meter"]`) as HTMLElement;
        let [min, max, n] = [Infinity, -Infinity, 0];
        const t0 = performance.now();
        const step = () => {
          const s = el.dataset.peakDb ?? '-inf';
          const db = s === '-inf' ? -200 : Number(s);
          min = Math.min(min, db);
          max = Math.max(max, db);
          n++;
          if (performance.now() - t0 < ms) requestAnimationFrame(step);
          else resolve({ min, max, n });
        };
        requestAnimationFrame(step);
      }),
    { testid, ms },
  );
}

test('Bass tidy changes the low cut and the comp; one Cmd+Z restores them', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  await openMixer(page);
  const s = strip(page, 1);
  const [hp0, comp0] = [await param(page, 1, 'eq_hp'), await param(page, 1, 'comp_on')];
  expect([hp0, comp0]).toEqual([20, 0]);

  const card = await openPresets(page, 1);
  await expect(card.getByTestId('preset-bass-tidy')).toBeVisible();
  await expect(card.getByTestId('preset-duck')).toBeVisible();
  await card.getByTestId('preset-bass-tidy').click();
  await expect(card).toBeHidden();
  await expect.poll(() => param(page, 1, 'eq_hp')).toBe(30);
  expect(await param(page, 1, 'comp_on')).toBe(1);
  await expect(s.getByTestId('comp-on')).toHaveAttribute('aria-pressed', 'true');
  await expect(s.getByTestId('eq-on')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => daw(page, (d) => d.history?.labels.undo ?? null)).toBe('Preset: Bass tidy');

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => param(page, 1, 'eq_hp')).toBe(hp0);
  expect(await param(page, 1, 'comp_on')).toBe(comp0);
  expect(await param(page, 1, 'eq_on')).toBe(0);
  await expect(s.getByTestId('comp-on')).toHaveAttribute('aria-pressed', 'false');
});

test('Duck to kick on a synth track keys its comp from "Drums · Kick"; the drum strip does not offer it', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  await openMixer(page);
  const s = strip(page, 1);
  await (await openPresets(page, 1)).getByTestId('preset-duck').click();
  await expect(s.getByTestId('sc-label')).toHaveText('SC: Drums · Kick');
  await expect(s.getByTestId('comp-on')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => daw(page, (d) => d.history?.labels.undo ?? null)).toBe('Duck to kick');
  await page.screenshot({ path: 'test-results/mixpresets-duck.png' });

  // The drum track plays the Kick: its menu has its presets but no Duck to kick.
  const card = await openPresets(page, 0);
  await expect(card.getByTestId('preset-kick-punch')).toBeVisible();
  await expect(card.getByTestId('preset-duck')).toHaveCount(0);
  // Arrow keys, Home and End move between the items.
  await expect(card.getByTestId('preset-kick-punch')).toBeFocused();
  await page.keyboard.press('End');
  await expect(card.getByTestId('preset-flat')).toBeFocused();
  await page.keyboard.press('ArrowDown'); // wraps
  await expect(card.getByTestId('preset-kick-punch')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(card.getByTestId('preset-flat')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(card.getByTestId('preset-kick-punch')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(strip(page, 0).getByTestId('strip-presets')).toBeFocused();
});

test('kick plus a held bass: with Duck to kick the bass level dips on every kick', async ({ page }) => {
  test.setTimeout(40_000);
  await start(page);
  // Four on the floor on the starter kit's Kick row.
  for (const st of [0, 4, 8, 12]) await page.getByTestId(`step-0-${st}`).click();
  // A synth (Deep Bass) holding a note from the computer keyboard.
  await addTrack(page, 'synth');
  await expect(page.getByTestId('track-1')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down('KeyA');
  // The drums loop under the song transport, together with the live note (mixer.spec.ts drumsLoopInSong).
  await daw(page, (d) => d.actions.addClip(d.project.tracks[0].id, { start: 0, len: 64 * 3840 }));
  await page.getByTestId('play').click();
  await openMixer(page);
  await expect.poll(async () => (await meterRange(page, 'strip-1', 300)).max, { timeout: 3_000 }).toBeGreaterThan(-40);

  // No duck: the held note reads steady once its envelope has settled.
  await page.waitForTimeout(1_000);
  const steady = await meterRange(page, 'strip-1', 1_000);
  expect(steady.max - steady.min).toBeLessThan(3);

  await (await openPresets(page, 1)).getByTestId('preset-duck').click();
  await expect(strip(page, 1).getByTestId('sc-label')).toHaveText('SC: Drums · Kick');
  await page.waitForTimeout(300);
  const pump = await meterRange(page, 'strip-1', 2_000);
  expect(pump.n).toBeGreaterThan(30);
  // Duck to kick dips about 6.6 dB on the starter kick at vel 100 (mixer.md); the meter ballistics shave some off.
  expect(pump.max - pump.min).toBeGreaterThanOrEqual(4);
  await page.keyboard.up('KeyA');
});

test('the Hall preset on the Reverb return sets a decay over 3 s; the returns and master list their own presets', async ({ page }) => {
  await start(page);
  await openMixer(page);
  let card = await openPresets(page, 'reverb');
  for (const id of ['room', 'plate', 'hall', 'dark']) await expect(card.getByTestId(`preset-${id}`)).toBeVisible();
  await expect(card.getByTestId('preset-duck')).toHaveCount(0);
  await expect(card.getByTestId('preset-bass-tidy')).toHaveCount(0);
  await card.getByTestId('preset-hall').click();
  await expect.poll(() => param(page, 'reverb', 'rev_decay')).toBeGreaterThan(3);
  await expect.poll(() => daw(page, (d) => d.history?.labels.undo ?? null)).toBe('Preset: Hall');

  card = await openPresets(page, 'delay');
  for (const id of ['delay-pingpong', 'delay-dub', 'delay-slap']) await expect(card.getByTestId(`preset-${id}`)).toBeVisible();
  await page.keyboard.press('Escape');
  card = await openPresets(page, 'master');
  for (const id of ['master-clean', 'master-warm']) await expect(card.getByTestId(`preset-${id}`)).toBeVisible();
  // The card floats over the page, inside the window (the strip clips its own content).
  const box = (await card.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.x + box.width).toBeLessThanOrEqual(vw);
  await page.screenshot({ path: 'test-results/mixpresets-menu.png' });
});

test('a track preset on a ducked strip keeps the duck; Flat removes it', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  await openMixer(page);
  const s = strip(page, 1);
  await (await openPresets(page, 1)).getByTestId('preset-duck').click();
  await expect(s.getByTestId('sc-label')).toHaveText('SC: Drums · Kick');

  // Bass tidy: its EQ lands, the duck's key and comp stay.
  await (await openPresets(page, 1)).getByTestId('preset-bass-tidy').click();
  await expect.poll(() => param(page, 1, 'eq_hp')).toBe(30);
  await expect(s.getByTestId('sc-label')).toHaveText('SC: Drums · Kick');
  expect(await param(page, 1, 'comp_threshold')).toBe(-14);
  expect(await param(page, 1, 'comp_ratio')).toBe(8);
  await expect(s.getByTestId('comp-on')).toHaveAttribute('aria-pressed', 'true');

  // Flat: a clean strip, key cleared and comp off, in one undo entry.
  await (await openPresets(page, 1)).getByTestId('preset-flat').click();
  await expect(s.getByTestId('sc-label')).toHaveText('SC: none');
  await expect(s.getByTestId('comp-on')).toHaveAttribute('aria-pressed', 'false');
  expect(await param(page, 1, 'eq_hp')).toBe(20);
  await expect.poll(() => daw(page, (d) => d.history?.labels.undo ?? null)).toBe('Preset: Flat');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(s.getByTestId('sc-label')).toHaveText('SC: Drums · Kick');
  await expect(s.getByTestId('comp-on')).toHaveAttribute('aria-pressed', 'true');
});

test('Duck to kick with no drum track says why in the status line and changes nothing', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  await daw(page, (d) => d.actions.removeTrack(d.project.tracks.find((t: Any) => t.kind === 'drum').id));
  await openMixer(page);
  await expect(strip(page, 0)).toHaveCount(0);
  const s = strip(page, 1);
  const undo = await daw(page, (d) => d.history?.labels.undo ?? null);
  await (await openPresets(page, 1)).getByTestId('preset-duck').click();
  await expect(page.getByTestId('hint-line')).toHaveText('Duck to kick: no Kick row in any drum track');
  await expect(s.getByTestId('sc-label')).toHaveText('SC: none');
  await expect(s.getByTestId('comp-on')).toHaveAttribute('aria-pressed', 'false');
  expect(await daw(page, (d) => d.history?.labels.undo ?? null)).toBe(undo);
});

test('deleting the Kick row takes Duck to kick off the strip and says so', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  await openMixer(page);
  const s = strip(page, 1);
  await (await openPresets(page, 1)).getByTestId('preset-duck').click();
  await expect(s.getByTestId('comp-on')).toHaveAttribute('aria-pressed', 'true');
  // The drums' step grid (a track header click shows its editor), then the Kick row's delete button.
  await page.getByTestId('track-0').click();
  await page.getByTestId('row-0').hover();
  await page.getByTestId('row-delete-0').click();
  await expect(page.getByTestId('hint-line')).toHaveText('Duck to kick removed from Synth (kick deleted)');
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('Clap');
  await openMixer(page);
  await expect(s.getByTestId('sc-label')).toHaveText('SC: none');
  await expect(s.getByTestId('comp-on')).toHaveAttribute('aria-pressed', 'false');
});
