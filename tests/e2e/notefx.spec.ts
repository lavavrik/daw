import { expect, test, type Page } from '@playwright/test';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// The note modules Chord and Arp (plan 26 Task 3; docs/architecture/modular.md
// "Note modules"). Their timing, voicings and export parity are tested in Rust
// (engine/src/rack/modules/{arp,chord}.rs, synth.rs, tests/export_render.rs);
// here the real app: adding them from the menu, hearing them through the
// voice LEDs (one LED per MIDI In voice, data-gate = that voice's gate), and
// keeping them across a reload.

type Daw = {
  project: { tracks: { kind: string; modules?: { idx: number; kind: number; params: number[] }[] }[] };
  autosave: { lastSaved: number | null; flush(): Promise<void> };
};
type W = { __daw: Daw };

const KIND = { chord: 20, arp: 21 };

async function synthWith(page: Page, patch: string) {
  await page.goto('/');
  await startApp(page);
  await addTrack(page, 'synth');
  await page.getByRole('button', { name: 'Instrument' }).click();
  await page.getByTestId('patch-select').selectOption(patch);
  await expect(page.locator('[data-testid^="module-"].mech-panel').first()).toBeVisible();
}

/** Add module `name` from the "+ Add module" menu; returns its idx. */
async function addModule(page: Page, name: string): Promise<number> {
  const before = await page.locator('.mech-panel[data-testid^="module-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  await page.getByRole('button', { name: '+ Add module' }).click();
  await page.getByTestId('add-menu').getByRole('menuitem', { name }).click();
  await expect(page.getByTestId('add-menu')).toHaveCount(0);
  await expect.poll(() => page.locator('.mech-panel[data-testid^="module-"]').count()).toBe(before.length + 1);
  const after = await page.locator('.mech-panel[data-testid^="module-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  const added = after.find((id) => !before.includes(id))!;
  return Number(added.replace('module-', ''));
}

/** Give the keys to the QWERTY piano (nothing focused). */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const gated = (page: Page) => page.locator('[data-testid^="voice-led-"][data-gate="1"]').count();

/** Rising edges of voice LED 0's gate over `ms`, watched with a MutationObserver. */
function gateEdges(page: Page, ms: number) {
  return page.evaluate((ms) => new Promise<number>((resolve) => {
    const led = document.querySelector('[data-testid="voice-led-0"]')!;
    let was = led.getAttribute('data-gate');
    let edges = 0;
    const obs = new MutationObserver(() => {
      const g = led.getAttribute('data-gate');
      if (g === '1' && was !== '1') edges++;
      was = g;
    });
    obs.observe(led, { attributes: true, attributeFilter: ['data-gate'] });
    setTimeout(() => { obs.disconnect(); resolve(edges); }, ms);
  }), ms);
}

test('Arp on the Acid Line: a held note plays repeated notes; one Arp per rack; "→ MIDI In"', async ({ page }) => {
  await synthWith(page, 'Acid Line');
  // Baseline: a held note without the Arp is one gate, held.
  await blur(page);
  await page.keyboard.down('KeyA');
  await expect.poll(() => gated(page)).toBe(1);
  const plain = await gateEdges(page, 1000);
  await page.keyboard.up('KeyA');
  expect(plain).toBe(0);
  await expect.poll(() => gated(page)).toBe(0);

  const idx = await addModule(page, 'Arp');
  await expect(page.getByTestId(`module-route-${idx}`)).toHaveText('→ MIDI In');
  // No jacks on a note module.
  await expect(page.getByTestId(`module-${idx}`).locator('[data-jack]')).toHaveCount(0);
  // Its controls: rate/mode/latch LED buttons, octaves and gate knobs.
  for (const p of ['rate', 'mode', 'octaves', 'gate', 'latch']) await expect(page.getByTestId(`knob-${idx}-${p}`)).toBeVisible();
  // At most one per rack: the menu greys a second Arp and says why.
  await page.getByRole('button', { name: '+ Add module' }).click();
  const again = page.getByTestId('add-arp');
  await expect(again).toHaveAttribute('aria-disabled', 'true');
  await expect(again).toContainText('one per rack');
  await again.click({ force: true });
  await expect(page.getByTestId('add-menu')).toBeVisible(); // refused: stays open
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('add-menu')).toHaveCount(0);

  // Stopped, the Arp runs on its own clock (124 BPM, 1/16: ~8 steps a second,
  // gate 50 %): the held key retriggers the voice again and again.
  await blur(page);
  await page.keyboard.down('KeyA');
  let edges = 0;
  try {
    edges = await gateEdges(page, 2000);
  } finally {
    await page.keyboard.up('KeyA');
  }
  expect(edges, 'the gate opens on every step').toBeGreaterThanOrEqual(6);
  await expect.poll(() => gated(page)).toBe(0); // released: it stops
});

test('Chord set to In key turns one note into four sounding voices', async ({ page }) => {
  await synthWith(page, 'Pad'); // 8 voices
  await expect(page.locator('[data-testid^="voice-led-"]')).toHaveCount(8);
  const idx = await addModule(page, 'Chord');
  await expect(page.getByTestId(`module-route-${idx}`)).toHaveText('→ MIDI In');
  // Type defaults to In key (the key's own seventh: A minor here).
  await expect(page.getByTestId(`knob-${idx}-type`)).toHaveValue('9');
  await blur(page);
  await page.keyboard.down('KeyA');
  try {
    await expect.poll(() => gated(page)).toBe(4);
  } finally {
    await page.keyboard.up('KeyA');
  }
  await expect.poll(() => gated(page)).toBe(0); // the one key-up releases all four
  // A fixed type: maj is three voices. (The param travels as a command, the
  // key as a live note on its own path: re-press until the engine has both.)
  await page.getByTestId(`knob-${idx}-type`).selectOption('0');
  await blur(page);
  await expect(async () => {
    await page.keyboard.down('KeyA');
    try {
      await expect.poll(() => gated(page), { timeout: 1000 }).toBe(3);
    } finally {
      await page.keyboard.up('KeyA');
      await expect.poll(() => gated(page)).toBe(0);
    }
  }).toPass({ timeout: 10_000 });
});

test('Chord and Arp survive a reload (autosave restore)', async ({ page }) => {
  test.setTimeout(60_000);
  await synthWith(page, 'Pad');
  const chord = await addModule(page, 'Chord');
  const arp = await addModule(page, 'Arp');
  await page.getByTestId(`knob-${chord}-type`).selectOption('4'); // m7
  const modules = () => page.evaluate(() => {
    const t = (window as unknown as W).__daw.project.tracks.find((x) => x.kind === 'synth');
    return (t?.modules ?? []).map((m) => ({ idx: m.idx, kind: m.kind, params: [...m.params] }));
  });
  const want = (await modules()).filter((m) => m.kind === KIND.chord || m.kind === KIND.arp);
  expect(want.map((m) => [m.idx, m.kind])).toEqual([[chord, KIND.chord], [arp, KIND.arp]]);
  expect(want[0].params[0]).toBe(4);
  await expect
    .poll(() => page.evaluate(async () => {
      await (window as unknown as W).__daw.autosave.flush();
      return (window as unknown as W).__daw.autosave.lastSaved;
    }), { timeout: 15_000 })
    .not.toBeNull();
  await page.reload();
  await startApp(page);
  const offer = page.getByTestId('restore');
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: 'Restore last session' }).click();
  await expect.poll(async () => (await modules()).filter((m) => m.kind === KIND.chord || m.kind === KIND.arp)).toEqual(want);
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByTestId(`module-route-${chord}`)).toBeVisible();
  await expect(page.getByTestId(`module-route-${arp}`)).toBeVisible();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const n of ['autosave', 'autosave.tmp']) await root.removeEntry(n, { recursive: true }).catch(() => {});
    localStorage.removeItem('daw.lastExplicitSave');
  });
});
