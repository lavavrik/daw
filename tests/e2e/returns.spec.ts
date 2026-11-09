import { expect, test, type Page } from '@playwright/test';
import mixerCatalog from '../../engine/mixer_catalog.json' with { type: 'json' };
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// Several mixer returns (plan 29 Task 7; docs/architecture/mixer.md "Strip
// look"), driven through the mixer: the dashed "+ Return" strip, renaming a
// return by double-clicking its name, deleting it from its Presets card, and
// the track strips' folding Sends section (one mini bar and one knob per
// return, in the return's colour).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const daw = <T>(page: Page, fn: (d: Any, arg?: Any) => T, arg?: unknown) =>
  page.evaluate(`(${fn.toString()})(window.__daw, ${JSON.stringify(arg)})`) as Promise<T>;

const KIT = ['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc'];
const pid = (name: string) => mixerCatalog.params.find((x) => x.name === name)!.id;

async function start(page: Page) {
  await page.goto('/');
  await startApp(page);
}

const strip = (page: Page, id: string | number) => page.getByTestId(`strip-${id}`);

async function openMixer(page: Page) {
  await page.getByTestId('mixer-tab').click();
  await expect(page.getByTestId('mixer')).toBeVisible();
}

/** The data-testids of the mixer's strips, left to right. */
const stripIds = (page: Page) =>
  page.locator('[data-testid="mixer"] > [data-testid^="strip-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));

/** The returns as the project holds them. */
const returns = (page: Page) =>
  daw<{ id: string; name: string; slot: number; kind: string }[]>(page, (d) =>
    d.project.mixer.returns.map((r: Any) => ({ id: r.id, name: r.name, slot: r.slot, kind: r.kind })));

/** "+ Return" → Reverb / Delay; returns the new return's id. */
async function addReturnUi(page: Page, kind: 'reverb' | 'delay'): Promise<string> {
  const before = (await returns(page)).length;
  await page.getByTestId('add-return').click();
  await page.getByTestId(`add-return-${kind}`).click();
  await expect.poll(async () => (await returns(page)).length).toBe(before + 1);
  return (await returns(page)).at(-1)!.id;
}

test('add a reverb return: a new strip before the master, and a third send bar on every track', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  await openMixer(page);
  const id = await addReturnUi(page, 'reverb');
  expect(await stripIds(page)).toEqual(['strip-0', 'strip-1', 'strip-reverb', 'strip-delay', `strip-${id}`, 'strip-master']);
  await expect(strip(page, id).getByTestId('strip-name')).toContainText('Reverb 2');
  await expect(strip(page, id).getByTestId('strip-name')).toContainText('Reverb · ');
  await expect(strip(page, id).getByTestId('return-dot')).toBeVisible();
  // The ghost strip sits between the last return and the master.
  const x = async (testid: string) => (await page.getByTestId(testid).boundingBox())!.x;
  expect(await x('add-return')).toBeGreaterThan(await x(`strip-${id}`));
  expect(await x('add-return')).toBeLessThan(await x('strip-master'));
  for (const t of [0, 1]) {
    const sends = strip(page, t).getByTestId('sends');
    await expect(sends.locator('[data-testid^="send-bar-"]')).toHaveCount(3);
    await expect(sends.getByTestId('send-bar-2')).toBeVisible();
    await expect(sends).toContainText('0 of 3');
  }
});

test('rename by double-click: Enter saves (strip and send knob), Esc keeps the old name', async ({ page }) => {
  await start(page);
  await openMixer(page);
  const name = strip(page, 'reverb').getByTestId('strip-name');
  await name.dblclick();
  const input = strip(page, 'reverb').getByTestId('return-name-input');
  await expect(input).toBeFocused();
  await input.fill('Hall');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(name).toContainText('Hall');
  await strip(page, 0).getByTestId('sends-expand').click();
  await expect(strip(page, 0).getByTestId('knob-send_a')).toContainText('Hall');
  expect((await returns(page))[0].name).toBe('Hall');

  await name.dblclick();
  await strip(page, 'reverb').getByTestId('return-name-input').fill('Nope');
  await strip(page, 'reverb').getByTestId('return-name-input').press('Escape');
  await expect(strip(page, 'reverb').getByTestId('return-name-input')).toHaveCount(0);
  await expect(name).toContainText('Hall');
  expect((await returns(page))[0].name).toBe('Hall');

  // An empty name is refused: the old one stays.
  await name.dblclick();
  await strip(page, 'reverb').getByTestId('return-name-input').fill('   ');
  await strip(page, 'reverb').getByTestId('return-name-input').press('Enter');
  await expect(name).toContainText('Hall');
});

test('delete from the presets card: the strip and its bars go; Cmd+Z brings both back', async ({ page }) => {
  await start(page);
  await openMixer(page);
  await strip(page, 'delay').getByTestId('strip-presets').click();
  const card = page.getByTestId('strip-presets-pop');
  await expect(card.getByTestId('preset-delete-return')).toBeVisible();
  // It sits at the bottom of the card.
  const last = await card.locator('button').evaluateAll((els) => els.at(-1)?.getAttribute('data-testid'));
  expect(last).toBe('preset-delete-return');
  await card.getByTestId('preset-delete-return').click();
  await expect(strip(page, 'delay')).toHaveCount(0);
  const sends = strip(page, 0).getByTestId('sends');
  await expect(sends.locator('[data-testid^="send-bar-"]')).toHaveCount(1);
  await expect(sends.getByTestId('send-bar-1')).toHaveCount(0);

  await page.getByTestId('mixer').click({ position: { x: 2, y: 2 } }); // the focus off the (gone) card
  await page.keyboard.press('ControlOrMeta+z');
  await expect(strip(page, 'delay')).toBeVisible();
  await expect(sends.locator('[data-testid^="send-bar-"]')).toHaveCount(2);
  await expect(sends.getByTestId('send-bar-1')).toBeVisible();
});

test('sends section folds: closed by default, a mini bar opens it, knobs wear the return names', async ({ page }) => {
  await start(page);
  await openMixer(page);
  const s = strip(page, 0);
  await expect(s.getByTestId('sends-expand')).toHaveAttribute('aria-expanded', 'false');
  await expect(s.getByTestId('knob-send_a')).toHaveCount(0);
  await expect(s.getByTestId('send-bar-0')).toBeVisible();
  await s.getByTestId('send-bar-0').click();
  await expect(s.getByTestId('sends-expand')).toHaveAttribute('aria-expanded', 'true');
  // Open = the knob grid only: the mini bars are the closed state.
  await expect(s.locator('[data-testid^="send-bar-"]')).toHaveCount(0);
  await expect(s.getByTestId('knob-send_a')).toBeVisible();
  await expect(s.getByTestId('knob-send_a')).toContainText('Reverb');
  await expect(s.getByTestId('knob-send_b')).toContainText('Delay');
  await expect(s.getByTestId('send_a-pre')).toBeVisible();
  // A send above −∞ counts and fills its bar.
  await expect(s.getByTestId('sends')).toContainText('0 of 2');
  await daw(page, (d) => d.actions.setMix(d.project.tracks[0].id, 'send_b', -12));
  await expect(s.getByTestId('sends')).toContainText('1 of 2');
  // The section closes again from its header.
  await s.getByTestId('sends-expand').click();
  await expect(s.getByTestId('knob-send_a')).toHaveCount(0);
  await expect(s.getByTestId('send-bar-0')).toBeVisible();
});

test('with no returns the Sends section is not rendered', async ({ page }) => {
  await start(page);
  await openMixer(page);
  await daw(page, (d) => { d.actions.deleteReturn('reverb'); d.actions.deleteReturn('delay'); });
  await expect(strip(page, 'reverb')).toHaveCount(0);
  await expect(strip(page, 0).getByTestId('sends')).toHaveCount(0);
  await expect(page.getByTestId('add-return')).toBeVisible();
});

test('add-return hides at 8 returns', async ({ page }) => {
  await start(page);
  await openMixer(page);
  for (let i = 0; i < 5; i++) await addReturnUi(page, i % 2 ? 'delay' : 'reverb');
  await expect(page.getByTestId('add-return')).toBeVisible();
  await addReturnUi(page, 'delay');
  expect((await returns(page)).length).toBe(8);
  await expect(page.getByTestId('add-return')).toHaveCount(0);
  await expect(strip(page, 0).getByTestId('sends').locator('[data-testid^="send-bar-"]')).toHaveCount(8);
  await page.screenshot({ path: 'test-results/returns-8.png' });
});

test('two reverbs sound different: Drums on Room (slot 0), Strings on Hall (slot 2)', async ({ page }) => {
  test.setTimeout(40_000);
  await start(page);
  for (const [i, n] of KIT.entries()) await expect(page.getByTestId(`row-${i}`).getByTestId('row-name')).toHaveText(n);
  for (const st of [0, 4, 8, 12]) await page.getByTestId(`step-0-${st}`).click();
  await openMixer(page);
  const hall = await addReturnUi(page, 'reverb');
  expect((await returns(page)).find((r) => r.id === hall)!.slot).toBe(2);

  await strip(page, 'reverb').getByTestId('strip-presets').click();
  await page.getByTestId('strip-presets-pop').getByTestId('preset-room').click();
  await strip(page, hall).getByTestId('strip-presets').click();
  await page.getByTestId('strip-presets-pop').getByTestId('preset-hall').click();

  await daw(page, (d) => {
    const a = d.actions;
    const drums = d.project.tracks[0];
    const s = a.addSynthTrack('Strings');
    for (const pitch of [48, 55, 60]) a.addNote(s.id, { pitch, start: 0, len: 15360, vel: 100 });
    a.addClip(drums.id, { start: 0, len: 64 * 3840 });
    a.addClip(s.id, { start: 0, len: 64 * 3840 });
    a.setMix(drums.id, 'send_a', -6);
    a.setMix(s.id, 'send_c', -6);
  });
  await page.getByTestId('play').click();
  const peak = async (id: string) => {
    const v = await strip(page, id).getByTestId('meter').getAttribute('data-peak-db');
    return v === null || v === '-inf' ? -Infinity : Number(v);
  };
  await expect.poll(() => peak('reverb'), { timeout: 5_000 }).toBeGreaterThan(-60);
  await expect.poll(() => peak(hall), { timeout: 5_000 }).toBeGreaterThan(-60);
  const decay = (id: string) => daw<number>(page, (d, a) => d.project.mixer.returns.find((r: Any) => r.id === a.id).params[a.p], { id, p: pid('rev_decay') });
  const [room, big] = [await decay('reverb'), await decay(hall)];
  expect(room).not.toBe(big);
  expect(big).toBeGreaterThan(room);
  // The strips say so in their subtitles.
  await expect(strip(page, 'reverb').getByTestId('strip-name')).toContainText(`Reverb · ${room.toFixed(1)} s`);
  await expect(strip(page, hall).getByTestId('strip-name')).toContainText(`Reverb · ${big.toFixed(1)} s`);
  await page.getByTestId('play').click();
});
