import { expect, test, type Page } from '@playwright/test';

// MIDI learn (plan 14 Task 3; docs/architecture/midi.md "UI"): right-click a
// knob or fader ▸ "MIDI learn", the next CC binds to it, later CCs move it
// (one undo entry per sweep), "Forget MIDI (CC n)" unbinds. Web MIDI cannot
// be driven by Playwright, so CCs go through window.__daw.midi.inject (the
// same handler as a real input).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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
  await page.getByTestId('add-synth-track').click();
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
    page.evaluate((id) => {
      const tr = (window as Any).__daw.project.tracks.find((x: Any) => x.id === id);
      return [...tr.modules.find((m: Any) => m.idx === 4).params] as number[];
    }, t.id);

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
  expect(await modelCutoff()).toContain(max);
  await inject(page, [0xb0, 74, 0]);
  await expect.poll(() => valueOf(page, 'knob-4-cutoff')).toBe(min);
  expect(await modelCutoff()).toContain(min);

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

  // Esc during learn: the hint goes, nothing is bound.
  const ceiling = page.getByTestId('strip-master').getByTestId('knob-limiter_ceiling');
  await ceiling.click({ button: 'right' });
  await page.getByTestId('auto-ctl-midi').click();
  await expect(page.getByTestId('flash-hint')).toHaveText(LEARN_HINT);
  await expect(ceiling).toHaveClass(/learning/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('flash-hint')).toHaveCount(0);
  await expect(ceiling).not.toHaveClass(/learning/);
  await inject(page, [0xb0, 20, 64]);
  expect(await midiMap(page)).toHaveLength(1);
});
