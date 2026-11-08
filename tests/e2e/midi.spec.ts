import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';

// MIDI learn (plan 14 Task 3; docs/architecture/midi.md "UI"): right-click a
// knob or fader ▸ "MIDI learn", the next CC binds to it, later CCs move it
// (one undo entry per sweep), "Forget MIDI (CC n)" unbinds. Web MIDI cannot
// be driven by Playwright, so CCs go through window.__daw.midi.inject (the
// same handler as a real input).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// The filter's params in engine/catalog.json: mode, cutoff, reso, cv_amt, drive.
const CUTOFF = 1;
// mixMath FADER_LAW (dB, position); app code cannot be imported here (catalog.json import attribute).
const LAW = [[-60, 0], [-40, 0.14], [-30, 0.25], [-20, 0.38], [-10, 0.55], [0, 0.75], [6, 1]];
function faderPos(db: number) {
  for (let i = 1; i < LAW.length; i++) {
    if (db <= LAW[i][0]) return LAW[i - 1][1] + ((db - LAW[i - 1][0]) / (LAW[i][0] - LAW[i - 1][0])) * (LAW[i][1] - LAW[i - 1][1]);
  }
  return 1;
}
const LEARN_HINT = 'Move a knob on your MIDI controller (Esc cancels)';

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByTestId('timeline')).toBeVisible();
  // The injection hook exists once audio runs.
  await page.waitForFunction(() => !!(window as Any).__daw?.midi);
}

/** Feed raw MIDI bytes, then wait two frames (CC moves are applied once per animation frame). */
async function inject(page: Page, bytes: number[]) {
  await page.evaluate(
    (b) =>
      new Promise<void>((resolve) => {
        (window as Any).__daw.midi.inject(b);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
    bytes,
  );
}

const valueOf = async (page: Page, testid: string) => Number(await page.getByTestId(testid).getAttribute('aria-valuenow'));
const midiMap = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as Any).__daw.project.midiMap)));

test('MIDI learn a rack knob: sweep, undo, forget', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  const t = await page.evaluate(() => {
    const x = (window as Any).__daw.project.tracks.at(-1);
    return { id: x.id as string, slot: x.slot as number };
  });
  await page.getByTestId(`track-${t.slot}`).click();
  await page.getByRole('button', { name: 'Instrument' }).click();
  const knob = page.getByTestId('knob-4-cutoff');
  const min = Number(await knob.getAttribute('aria-valuemin'));
  const max = Number(await knob.getAttribute('aria-valuemax'));
  const before = await valueOf(page, 'knob-4-cutoff');
  /** The cutoff in the model (__daw.project): module 4's param that the knob shows. */
  const modelCutoff = () =>
    page.evaluate(([id, i]) => {
      const tr = (window as Any).__daw.project.tracks.find((x: Any) => x.id === id);
      return tr.modules.find((m: Any) => m.idx === 4).params[i as number] as number;
    }, [t.id, CUTOFF] as [string, number]);

  // Right-click ▸ MIDI learn: the hint, the pulsing ring.
  await knob.click({ button: 'right' });
  await expect(page.getByTestId('auto-ctl-automate')).toHaveText('Automate');
  await expect(page.getByTestId('auto-ctl-midi')).toHaveText('MIDI learn');
  await page.getByTestId('auto-ctl-midi').click();
  await expect(page.getByTestId('flash-hint')).toHaveText(LEARN_HINT);
  await expect(knob).toHaveClass(/learning/);
  // The first CC binds (and only binds: the knob does not move).
  await inject(page, [0xb0, 74, 64]);
  await expect(page.getByTestId('flash-hint')).toHaveText(/MIDI CC 74 → .*Cutoff/);
  await expect(knob).not.toHaveClass(/learning/);
  await expect(page.getByTestId('knob-4-cutoff-cc')).toBeVisible();
  await expect(knob).toHaveAttribute('title', /MIDI CC 74/);
  expect(await midiMap(page)).toEqual([{ cc: 74, owner: t.id, target: { kind: 'rack', module: 4, param: 'cutoff' } }]);
  expect(await valueOf(page, 'knob-4-cutoff')).toBe(before);

  // A sweep: 127 -> the max, 0 -> the min (the model and the knob).
  await inject(page, [0xb0, 74, 127]);
  await expect.poll(() => valueOf(page, 'knob-4-cutoff')).toBe(max);
  expect(await modelCutoff()).toBe(max);
  await inject(page, [0xb0, 74, 0]);
  await expect.poll(() => valueOf(page, 'knob-4-cutoff')).toBe(min);
  expect(await modelCutoff()).toBe(min);

  // One undo: back to the pre-sweep value (the mapping stays).
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => valueOf(page, 'knob-4-cutoff')).toBe(before);
  expect(await midiMap(page)).toHaveLength(1);

  // Right-click ▸ Forget MIDI (CC 74): the tag goes, CC 74 no longer moves it.
  await knob.click({ button: 'right' });
  await expect(page.getByTestId('auto-ctl-midi')).toHaveText('Forget MIDI (CC 74)');
  await page.getByTestId('auto-ctl-midi').click();
  await expect(page.getByTestId('knob-4-cutoff-cc')).toHaveCount(0);
  expect(await midiMap(page)).toEqual([]);
  await inject(page, [0xb0, 74, 127]);
  expect(await valueOf(page, 'knob-4-cutoff')).toBe(before);
});

test('MIDI learn a mixer fader; Esc cancels learning', async ({ page }) => {
  await start(page);
  await page.getByTestId('mixer-tab').click();
  const fader = page.getByTestId('strip-master').getByTestId('fader');
  await fader.click({ button: 'right' });
  await page.getByTestId('auto-ctl-midi').click();
  await expect(page.getByTestId('flash-hint')).toHaveText(LEARN_HINT);
  await expect(fader).toHaveClass(/learning/);
  await inject(page, [0xb0, 7, 0]); // binds
  await expect(page.getByTestId('strip-master').getByTestId('fader-cc')).toBeVisible();
  await inject(page, [0xb0, 7, 127]);
  await expect.poll(async () => Number(await fader.getAttribute('aria-valuenow'))).toBe(6);
  await inject(page, [0xb0, 7, 0]);
  await expect.poll(async () => Number(await fader.getAttribute('aria-valuenow'))).toBe(-60);
  // The fader law, not a linear sweep: CC 64 (half travel) puts the handle at ~0.5 (faderPos).
  await inject(page, [0xb0, 7, 64]);
  await expect
    .poll(async () => faderPos(Number(await fader.getAttribute('aria-valuenow'))))
    .toBeCloseTo(64 / 127, 1);

  // Esc that closes the context menu leaves learn mode on (the menu stops it).
  const ceiling = page.getByTestId('strip-master').getByTestId('knob-limiter_ceiling');
  await ceiling.click({ button: 'right' });
  await page.getByTestId('auto-ctl-midi').click();
  await ceiling.click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('auto-ctl-midi')).toHaveCount(0);
  await expect(page.getByTestId('flash-hint')).toHaveText(LEARN_HINT);
  await expect(ceiling).toHaveClass(/learning/);
  // So does the Esc that closes a menu-bar menu (a document listener that stops it).
  await page.getByTestId('menu-file').click();
  await expect(page.locator('#menu-file-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-file-panel')).toBeHidden();
  await expect(ceiling).toHaveClass(/learning/);
  // Esc during learn: the hint goes, nothing is bound.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('flash-hint')).toHaveCount(0);
  await expect(ceiling).not.toHaveClass(/learning/);
  await inject(page, [0xb0, 20, 64]);
  expect(await midiMap(page)).toHaveLength(1);
});

// The MIDI popover (plan 14 Task 4): devices, last CC, the mapping list.
test('MIDI popover: devices, last CC, mappings, forget (one undo), Esc', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  const slot = await page.evaluate(() => (window as Any).__daw.project.tracks.at(-1).slot as number);
  await page.getByTestId(`track-${slot}`).click();
  await page.getByRole('button', { name: 'Instrument' }).click();

  const pill = page.getByTestId('midi-status');
  const pop = page.getByTestId('midi-popover');
  await expect(pop).toHaveCount(0);
  await pill.click();
  await expect(pop).toBeVisible();
  await expect(pop).toHaveAttribute('role', 'dialog');
  await expect(pop).toHaveAttribute('aria-label', 'MIDI');
  // No real device under Playwright: the status text, the empty states.
  await expect(page.getByTestId('midi-devices')).not.toHaveText('');
  await expect(page.getByTestId('midi-last-cc')).toHaveText('Move a knob on your controller');
  await expect(pop).toContainText('Right-click a knob → MIDI learn');

  // The pill toggles; live last-CC readout.
  await pill.click();
  await expect(pop).toHaveCount(0);
  await pill.click();
  await inject(page, [0xb0, 20, 33]);
  await expect(page.getByTestId('midi-last-cc')).toHaveText('CC 20 = 33');

  // Esc closes (and does not leak to anything else).
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);

  // Learn cutoff on CC 74 (popover closed by the right-click's outside press).
  await page.getByTestId('knob-4-cutoff').click({ button: 'right' });
  await page.getByTestId('auto-ctl-midi').click();
  await inject(page, [0xb0, 74, 64]);
  await pill.click();
  const row = page.getByTestId('midi-map-74');
  await expect(row).toHaveText(/^CC 74 → .* · Filter · Cutoff/);
  await expect(page.getByTestId('midi-last-cc')).toHaveText('CC 74 = 64');

  // An outside press closes it.
  await page.getByTestId('timeline').click({ position: { x: 5, y: 5 } });
  await expect(pop).toHaveCount(0);
  await pill.click();

  // Forget: gone from the list and the model; one undo brings it back.
  await row.getByRole('button', { name: 'Forget CC 74' }).click();
  await expect(row).toHaveCount(0);
  await expect(pop).toContainText('Right-click a knob → MIDI learn');
  expect(await midiMap(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+z');
  await pill.click();
  await expect(page.getByTestId('midi-map-74')).toBeVisible();
  expect((await midiMap(page)).length).toBe(1);
});

// Removing a track drops its mappings (spec §2.3).
test('removing a mapped track drops its mapping', async ({ page }) => {
  await start(page);
  await addTrack(page, 'synth');
  const t = await page.evaluate(() => (window as Any).__daw.project.tracks.at(-1).id as string);
  await page.getByTestId(`track-${await page.evaluate(() => (window as Any).__daw.project.tracks.at(-1).slot)}`).click();
  await page.getByRole('button', { name: 'Instrument' }).click();
  const knob = page.getByTestId('knob-4-cutoff');
  await knob.click({ button: 'right' });
  await page.getByTestId('auto-ctl-midi').click();
  await inject(page, [0xb0, 74, 64]);
  expect(await midiMap(page)).toHaveLength(1);
  await page.evaluate((id) => (window as Any).__daw.actions.removeTrack(id), t);
  expect(await midiMap(page)).toEqual([]);
  const pill = page.getByTestId('midi-status');
  await pill.click();
  await expect(page.getByTestId('midi-popover')).toContainText('Right-click a knob → MIDI learn');
  await expect(page.getByTestId('midi-map-74')).toHaveCount(0);
  // CC 74 now moves nothing (no mapping, no change in the model).
  const ver = () => page.evaluate(() => (window as Any).__daw.project.version as number);
  const v0 = await ver();
  await inject(page, [0xb0, 74, 127]);
  expect(await ver()).toBe(v0);
});
