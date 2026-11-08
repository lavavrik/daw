import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';
import { addTrack } from './addTrack';

// Plan 12 (docs/architecture/visuals.md): the visuals in the running app.
// The Scope module, the mixer analyser (spectrum, strip toggle), the top-bar
// spectrum's pause, the zoomable waveform (Clip tab and drum rows), the
// ADSR/LFO previews and the voice LEDs. Hooks: window.__daw.vis (stats,
// drawn, running, want, scopeHead, analyser.peakHz / tap) and the test ids
// listed in the plan. The main-thread budget is in serial.spec.ts.

type Daw = {
  engine: { dropouts(): number; failure: string | null; telemetry(): Float64Array; sampleRate: number } | null;
  project: { dirty: boolean; mode: string; tracks: { id: string; slot: number; kind: string; name: string }[]; selectedTrackId: string | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, (...args: any[]) => any>;
  vis: {
    stats(): { busyMs: number; wallMs: number; frames: number };
    drawn(): number;
    running(): boolean;
    want(): number;
    scopeHead(track: number, idx: number): number;
    analyser: { peakHz(): number | null; tap(): number };
  };
};

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

/** A new synth track (Deep Bass), selected, on the Instrument tab. Returns its slot. */
async function addSynth(page: Page): Promise<number> {
  await startAudio(page);
  await addTrack(page, 'synth');
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByTestId('rack')).toBeVisible();
  return page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.find((t) => t.id === (window as unknown as { __daw: Daw }).__daw.project.selectedTrackId)!.slot);
}

/** Centre of the element with `testid`, scrolled into view first. */
async function centre(page: Page, testid: string) {
  const el = page.getByTestId(testid);
  await el.scrollIntoViewIfNeeded();
  const b = (await el.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * A cable by keyboard patching (Enter on a jack picks it up, Enter on another
 * drops it): the two jacks can be a rail's width apart.
 */
async function cable(page: Page, from: string, to: string) {
  await page.getByTestId(from).focus();
  await page.keyboard.press('Enter');
  await page.getByTestId(to).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="cables"] path.drag')).toHaveCount(0);
}

async function addModule(page: Page, id: string) {
  await page.getByRole('button', { name: '+ Add module' }).click();
  await page.getByTestId(`add-${id}`).click();
  await expect(page.getByTestId('add-menu')).toBeHidden();
}

const scopeHead = (page: Page, track: number, idx: number) => page.evaluate(({ track, idx }) => (window as unknown as { __daw: Daw }).__daw.vis.scopeHead(track, idx), { track, idx });

// ---- Scope ------------------------------------------------------------------

test('scope shows a triggered saw', async ({ page }) => {
  const slot = await addSynth(page); // Deep Bass: Osc 1 is a saw
  await addModule(page, 'scope');
  const scope = page.getByTestId('scope-8');
  await expect(page.getByTestId('module-8')).toContainText('Scope');
  await cable(page, 'jack-1-out-out', 'jack-8-in-a');
  await expect(page.locator('[data-testid="cables"] path.cable')).toHaveCount(12);
  await scope.scrollIntoViewIfNeeded(); // on screen: the frame loop wants its slot (bit 8)
  await page.keyboard.press('KeyZ'); // octave 3
  await page.keyboard.down('KeyA'); // C3
  try {
    // The head advances (the engine writes, the worklet mirrors, want bit 8).
    await expect.poll(() => scopeHead(page, slot, 8)).toBeGreaterThanOrEqual(0);
    const h0 = await scopeHead(page, slot, 8);
    await expect.poll(() => scopeHead(page, slot, 8)).not.toBe(h0);
    await expect(scope).toHaveAttribute('data-readout', '5 ms/div');
    await expect(scope).toHaveAttribute('data-tag', ''); // triggered: no "no trig", not idle
    // The trace spans many rows: an orange saw, not a flat line.
    const rows = await scope.locator('canvas').evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const hit = new Set<number>();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 180 && d[i + 1] > 100 && d[i + 1] < 200 && d[i + 2] < 110) hit.add(Math.floor(i / 4 / c.width));
      }
      return hit.size;
    });
    expect(rows).toBeGreaterThan(30);
  } finally {
    await page.keyboard.up('KeyA');
  }
});

test('a ninth scope is greyed out', async ({ page }) => {
  await addSynth(page);
  for (let i = 0; i < 8; i++) await addModule(page, 'scope');
  await expect(page.locator('[data-testid^="scope-"]')).toHaveCount(8);
  await page.getByRole('button', { name: '+ Add module' }).click();
  const ninth = page.getByTestId('add-scope');
  await expect(ninth).toHaveAttribute('aria-disabled', 'true');
  await expect(ninth).toContainText('All 8 scopes in use');
  await ninth.click({ force: true }); // aria-disabled: Playwright would wait
  await expect(page.getByTestId('add-menu')).toBeVisible(); // nothing added, the menu says why
  await expect(page.locator('[data-testid^="scope-"]')).toHaveCount(8);
});

// 'scope edits while playing cause no dropouts' is in serial.spec.ts: a
// dropout count only means something with no other worker on the CPU.

// ---- Analyser ---------------------------------------------------------------

test('analyser finds the note', async ({ page }) => {
  await startAudio(page);
  await addTrack(page, 'synth');
  await page.evaluate(() => {
    const id = (window as unknown as { __daw: Daw }).__daw.project.selectedTrackId!;
    (window as unknown as { __daw: Daw }).__daw.actions.loadPatch(id, {
      name: 'Sine',
      modules: [
        { idx: 0, id: 'midi_in', params: { mode: 1 } },
        { idx: 1, id: 'osc', params: { wave: 3 } },
        { idx: 2, id: 'adsr', params: { attack: 0.002, sustain: 1 } },
        { idx: 3, id: 'vca' },
        { idx: 4, id: 'out' },
      ],
      cables: [
        { from: [0, 'pitch'], to: [1, 'pitch'] },
        { from: [0, 'gate'], to: [2, 'gate'] },
        { from: [1, 'out'], to: [3, 'in'] },
        { from: [2, 'env'], to: [3, 'cv'] },
        { from: [3, 'out'], to: [4, 'l'] },
        { from: [3, 'out'], to: [4, 'r'] },
      ],
    });
  });
  await page.getByTestId('mixer-tab').click();
  const panel = page.getByTestId('analyser');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-source', 'master');
  await page.keyboard.press('KeyX'); // octave 5
  await page.keyboard.down('KeyH'); // A5 = 880 Hz
  try {
    // The loudest band's centre is within a band (1/6 octave) of 880 Hz.
    await expect
      .poll(async () => {
        const hz = await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.analyser.peakHz());
        return hz === null ? 99 : Math.abs(Math.log2(hz / 880));
      })
      .toBeLessThan(0.17);
    // Hovering 880 Hz on the log axis (20 Hz..20 kHz over the plot) names A5.
    const spec = page.getByTestId('analyser-spectrum');
    // The wide panel scrolls inside the mixer row: bring the spectrum into view first.
    await spec.scrollIntoViewIfNeeded();
    const b = (await spec.boundingBox())!;
    const x = (Math.log10(880 / 20) / 3) * b.width;
    await page.mouse.move(b.x + x, b.y + b.height / 2);
    await expect(page.getByTestId('analyser-readout')).toBeVisible();
    await expect(page.getByTestId('analyser-readout')).toContainText('A5');
    await expect(page.getByTestId('analyser-readout')).toContainText(/8[78]\d Hz/);
  } finally {
    await page.keyboard.up('KeyH');
  }
});

test('strip toggle retargets the analyser and back', async ({ page }) => {
  await startAudio(page);
  await page.getByTestId('mixer-tab').click();
  const panel = page.getByTestId('analyser');
  await expect(panel).toHaveAttribute('data-source', 'master');
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.analyser.tap())).toBe(-1);
  const drum = await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks[0]);
  const btn = page.getByTestId(`analyser-strip-${drum.slot}`);
  await btn.click();
  await expect(panel).toHaveAttribute('data-source', String(drum.slot));
  await expect(page.getByTestId('analyser-source')).toHaveText(drum.name);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.analyser.tap())).toBe(drum.slot);
  // The tapped channel reaches the engine (the worklet publishes it while the tap is wanted).
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.want() & 2)).toBe(2);
  // Another strip (the Reverb return), then its "Master" button.
  await page.getByTestId('analyser-strip-32').click();
  await expect(panel).toHaveAttribute('data-source', '32');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.analyser.tap())).toBe(32);
  await panel.getByRole('button', { name: 'Master' }).click();
  await expect(panel).toHaveAttribute('data-source', 'master');
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.analyser.tap())).toBe(-1);
  // ∿ twice: there and back.
  await btn.click();
  await btn.click();
  await expect(panel).toHaveAttribute('data-source', 'master');
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.analyser.tap())).toBe(-1);
  // View state: not an edit.
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.dirty)).toBe(false);
  await expect(page.getByTestId('project-name')).not.toContainText('unsaved');
});

test('top bar spectrum stops when the page is hidden', async ({ page }) => {
  await startAudio(page);
  await expect(page.getByTestId('topbar-spectrum')).toBeVisible();
  // Playing keeps the master spectrum busy (it may idle when stopped and silent).
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.running())).toBe(true);
  const d0 = await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.drawn());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.drawn())).toBeGreaterThan(d0 + 5);
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.want() & 1)).toBe(1);
  const setHidden = (hidden: boolean) =>
    page.evaluate((hidden) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await setHidden(true);
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.running())).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.want())).toBe(0);
  const d1 = await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.drawn());
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.drawn())).toBe(d1);
  // Visible again: it resumes.
  await setHidden(false);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.drawn())).toBeGreaterThan(d1 + 5);
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.vis.want() & 1)).toBe(1);
  await page.keyboard.press('Space');
});

// ---- Waveforms --------------------------------------------------------------

/** The new Audio track made by dropping `bytes` (a WAV) below the lanes at tick 0; returns its slot. */
async function dropBelow(page: Page, name: string, bytes: number[]) {
  await expect(page.getByTestId('tl-lane-0')).toBeVisible();
  const v = JSON.parse((await page.getByTestId('timeline').getAttribute('data-view'))!) as { ticksPerPx: number; scrollTick: number };
  const x = (await page.getByTestId('tl-lane-0').boundingBox())!.x - v.scrollTick / v.ticksPerPx;
  const below = (await page.getByTestId('tl-below').boundingBox())!;
  const count = () => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.filter((t) => t.kind === 'audio').length);
  const before = await count();
  await page.evaluate(
    ({ name, bytes, x, y }) => {
      const el = document.querySelector('[data-testid="tl-below"]')!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], `${name}.wav`, { type: 'audio/wav' }));
      for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    },
    { name, bytes, x, y: below.y + Math.min(below.height / 2, 14) },
  );
  await expect.poll(count, { timeout: 30_000 }).toBe(before + 1);
  return page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.tracks.filter((t) => t.kind === 'audio').at(-1)!.slot);
}

/** ⌘-wheel steps over the middle of a waveform view's canvas (negative deltaY zooms in). */
function zoomWheel(page: Page, testid: string, deltaY: number, steps: number) {
  return page.evaluate(
    async ({ testid, deltaY, steps }) => {
      const c = document.querySelector(`[data-testid="${testid}"] canvas`)!;
      const b = c.getBoundingClientRect();
      for (let i = 0; i < steps; i++) {
        c.dispatchEvent(new WheelEvent('wheel', { deltaY, metaKey: true, bubbles: true, cancelable: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 }));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
    },
    { testid, deltaY, steps },
  );
}

const fpp = async (page: Page, testid: string) => Number(await page.getByTestId(testid).locator('canvas').getAttribute('data-fpp'));

test('clip tab waveform zooms to samples', async ({ page }) => {
  await startAudio(page);
  await dropBelow(page, 'tone', [...makeWav(220, 2000)]);
  await expect(page.getByTestId('cliptab-panel')).toBeVisible();
  const wave = page.getByTestId('cliptab-wave');
  const cv = wave.locator('canvas');
  // Fitted: the whole 2 s clip (96 000 frames at 48 kHz) across the view.
  await expect(cv).not.toHaveAttribute('data-draw', 'none');
  await expect.poll(() => fpp(page, 'cliptab-wave')).toBeGreaterThan(0);
  const fit = await fpp(page, 'cliptab-wave');
  const w = (await wave.boundingBox())!.width;
  expect(fit * w).toBeGreaterThan(0.9 * 2 * 44100);
  // ⌘-wheel in (at most 2× per event) down to single samples: dots and a sample count.
  await zoomWheel(page, 'cliptab-wave', -100, 14);
  await expect(cv).toHaveAttribute('data-draw', 'dots');
  expect(await fpp(page, 'cliptab-wave')).toBeLessThanOrEqual(1 / 6);
  await expect(page.getByTestId('wave-zoom-text')).toContainText(/\d+ samples/);
  // Zoom stops at 16 px per sample.
  await zoomWheel(page, 'cliptab-wave', -100, 4);
  expect(await fpp(page, 'cliptab-wave')).toBeCloseTo(1 / 16, 6);
  // Double-click fits again.
  await cv.dblclick();
  await expect.poll(() => fpp(page, 'cliptab-wave')).toBeCloseTo(fit, 6);
  // Keys: + zooms in at the centre, 0 fits.
  await wave.focus();
  await page.keyboard.press('+');
  await expect.poll(() => fpp(page, 'cliptab-wave')).toBeLessThan(fit * 0.9);
  await expect(wave).toHaveAttribute('aria-valuetext', /visible from/);
  await page.keyboard.press('0');
  await expect.poll(() => fpp(page, 'cliptab-wave')).toBeCloseTo(fit, 6);
  // The playhead (a DOM element moved by transform) runs while Song mode plays inside the clip.
  // (The wave has focus, inside the bottom panel, where Space means the pattern transport: song Play is the button.)
  const head = wave.locator('.ph');
  await expect(head).toBeHidden();
  await page.getByTestId('play').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.mode)).toBe('song');
  await expect(head).toBeVisible();
  const t1 = await head.evaluate((el) => (el as HTMLElement).style.transform);
  await expect.poll(() => head.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(t1);
  await page.getByTestId('play').click();
  await expect(head).toBeHidden();
});

test('drum row waveform strip opens and closes', async ({ page }) => {
  await startAudio(page);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('Kick');
  await expect(page.getByTestId('row-wave-0')).toHaveCount(0);
  await page.getByTestId('row-wave-btn-0').click();
  const strip = page.getByTestId('row-wave-0');
  await expect(strip).toBeVisible();
  await expect(strip.locator('canvas')).not.toHaveAttribute('data-draw', 'none');
  await expect(page.getByTestId('row-wave-btn-0')).toHaveClass(/\bon\b/);
  // Zoom to samples on a kit one-shot (keys this time).
  await expect.poll(() => fpp(page, 'row-wave-0')).toBeGreaterThan(0);
  const fit = await fpp(page, 'row-wave-0');
  await strip.focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press('+');
  await expect.poll(() => fpp(page, 'row-wave-0')).toBeLessThan(fit / 8);
  await expect(page.getByTestId('wave-zoom-text')).toContainText(/samples/);
  // Strip only, no markers or playhead (the engine has no row trim and drum voices report no position).
  await expect(strip.locator('.ph')).toBeHidden();
  // One row at a time: another row's ≈ moves the strip.
  await page.getByTestId('row-wave-btn-1').click();
  await expect(page.getByTestId('row-wave-0')).toHaveCount(0);
  await expect(page.getByTestId('row-wave-1')).toBeVisible();
  // Its own ≈ closes it. View state, not an edit.
  await page.getByTestId('row-wave-btn-1').click();
  await expect(page.locator('[data-testid^="row-wave-"]:not([data-testid^="row-wave-btn"])')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __daw: Daw }).__daw.project.dirty)).toBe(false);
});

// ---- Shape previews and voice LEDs --------------------------------------------

test('ADSR preview follows its knobs', async ({ page }) => {
  await addSynth(page); // Deep Bass: ADSR is module 5
  const svg = page.getByTestId('module-5').getByTestId('shape-adsr');
  await expect(svg).toBeVisible();
  const label = page.getByTestId('module-5').getByTestId('shape-label-adsr');
  const rel0 = Number(await svg.getAttribute('data-release'));
  const att0 = Number(await svg.getAttribute('data-attack'));
  const text0 = await label.textContent();
  expect(rel0).toBeGreaterThan(0);
  // Drag the Release slider right: its segment widens (and the others give way), the label follows.
  const k = await centre(page, 'knob-5-release-track');
  await page.mouse.move(k.x, k.y);
  await page.mouse.down();
  await page.mouse.move(k.x + 40, k.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Number(await svg.getAttribute('data-release'))).toBeGreaterThan(rel0 * 1.2);
  expect(await label.textContent()).not.toBe(text0);
  expect(Number(await svg.getAttribute('data-attack'))).toBeLessThanOrEqual(att0); // widths are normalised
});

test('voice LEDs light for a chord', async ({ page }) => {
  await addSynth(page);
  await page.getByTestId('patch-select').selectOption('Pad'); // 8 voices, sustain 0.8
  await expect(page.locator('[data-testid^="voice-led-"]')).toHaveCount(8);
  // The LFO preview is there too.
  await expect(page.getByTestId('shape-lfo')).toBeVisible();
  const lit = () => page.locator('[data-testid^="voice-led-"][data-on="1"]').count();
  const gated = () => page.locator('[data-testid^="voice-led-"][data-gate="1"]').count();
  expect(await lit()).toBe(0);
  for (const k of ['KeyA', 'KeyD', 'KeyG']) await page.keyboard.down(k);
  try {
    await expect.poll(lit).toBe(3);
    await expect.poll(gated).toBe(3);
  } finally {
    for (const k of ['KeyA', 'KeyD', 'KeyG']) await page.keyboard.up(k);
  }
  await expect.poll(gated).toBe(0);
  // Dark after the release (1.5 s, and −48 dB is the LEDs' floor).
  await expect.poll(lit, { timeout: 15_000 }).toBe(0);
});
