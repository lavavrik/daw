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

/** Mixer param `name` of channel `ch` (a track index, or 'reverb' / 'delay' / 'master'). */
const param = (page: Page, ch: number | string, name: string) =>
  daw<number>(page, (d, a) => {
    const c = typeof a.ch === 'number' ? d.project.mixer.channels[d.project.tracks[a.ch].id] : d.project.mixer[a.ch];
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
  await expect.poll(() => param(page, 1, 'eq_hp')).toBe(35);
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
  console.log(`DUCK TO KICK pump: steady ${(steady.max - steady.min).toFixed(1)} dB, ducked ${(pump.max - pump.min).toFixed(1)} dB over ${pump.n} frames`);
  expect(pump.n).toBeGreaterThan(30);
  expect(pump.max - pump.min).toBeGreaterThanOrEqual(6);
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
