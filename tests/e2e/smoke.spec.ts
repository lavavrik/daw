import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// Minimal shape of what App.svelte exposes on window for tests.
type DawWindow = {
  __daw?: {
    engine: {
      telemetry(): Float64Array;
      send(op: number, a?: number, b?: number, c?: number, d?: number): boolean;
      loadSample(id: number, channels: Float32Array[]): Promise<number>;
      dropouts(): number;
      failure: string | null;
    } | null;
    Op: Record<string, number>;
    recorder?: { lastTakeIds: string[]; armed: boolean } | null;
    clock?: { heardTicks(): number } | null;
    project: {
      tempo: number; tracks: { patterns: { notes?: { pitch: number; start: number; len: number }[] }[] }[] };
  };
};

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

/** Reads telemetry slot `i` from the live engine (NaN until started). */
function slot(page: Page, i: number) {
  return () =>
    page.evaluate((i) => {
      const daw = (window as unknown as DawWindow).__daw;
      return daw?.engine ? daw.engine.telemetry()[i] : NaN;
    }, i);
}

test('cross-origin isolated', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test('engine renders', async ({ page }) => {
  await startAudio(page);
  await expect.poll(slot(page, 0), { timeout: 5_000 }).toBeGreaterThan(100); // blocks
});

/**
 * The plan-1 test tone is gone: live notes only sound through a synth track
 * that is the input track. Build a minimal patch on `track` with raw engine
 * commands (the UI's default drum track uses slot 0) and make it the input
 * track: MIDI In(0) -> Osc(1) -> VCA(3) <- ADSR(2) -> Out(4).l.
 */
async function buildSynth(page: Page, track = 1) {
  const blocks = await slot(page, 0)();
  const sent = await page.evaluate((slot) => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    const send = (op: number, a = 0, b = 0, c = 0, d = 0) => engine!.send(op, a, b, c, d);
    const port = (m: number, p: number) => m * 16 + p; // packed module/port
    const kinds = { midiIn: 0, osc: 1, adsr: 4, vca: 5, out: 8 }; // catalog wire ids
    return [
      send(Op.ADD_SYNTH_TRACK, slot),
      send(Op.RACK_ADD_MODULE, slot, 0, kinds.midiIn),
      send(Op.RACK_ADD_MODULE, slot, 1, kinds.osc),
      send(Op.RACK_ADD_MODULE, slot, 2, kinds.adsr),
      send(Op.RACK_ADD_MODULE, slot, 3, kinds.vca),
      send(Op.RACK_ADD_MODULE, slot, 4, kinds.out),
      send(Op.RACK_CONNECT, slot, port(0, 0), port(1, 0)), // pitch -> osc pitch
      send(Op.RACK_CONNECT, slot, port(0, 1), port(2, 0)), // gate -> adsr gate
      send(Op.RACK_CONNECT, slot, port(1, 0), port(3, 0)), // osc -> vca in
      send(Op.RACK_CONNECT, slot, port(2, 0), port(3, 1)), // env -> vca cv
      send(Op.RACK_CONNECT, slot, port(3, 0), port(4, 0)), // vca -> out l
      send(Op.SET_INPUT_TRACK, slot),
    ];
  }, track);
  expect(sent.every((ok) => ok)).toBe(true); // all queued to the engine
  // The worklet drains the ring at the start of each block: once a couple of
  // blocks have passed, every command ran and none failed (LAST_ERROR = 0).
  await expect.poll(slot(page, 0)).toBeGreaterThan(blocks + 2);
  expect(await slot(page, 7)()).toBe(0);
}

test('live notes play the input synth track', async ({ page }) => {
  await startAudio(page);
  await buildSynth(page);
  const sent = await page.evaluate(() => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    return engine!.send(Op.NOTE_ON, 69, 127);
  });
  expect(sent).toBe(true);
  await expect.poll(slot(page, 5), { timeout: 5_000 }).toBeGreaterThan(0.05); // peakL
});

test('sample upload round-trips through the worklet', async ({ page }) => {
  await startAudio(page);
  const codes = await page.evaluate(async () => {
    const { engine } = (window as unknown as DawWindow).__daw!;
    const ch = new Float32Array(4800).fill(0.5);
    return [
      await engine!.loadSample(0, [ch, ch]), // stopped: alloc may grow, OK
      await engine!.loadSample(1_000_000, [ch]), // id out of range
      await engine!.loadSample(1, []), // no channels
      engine!.dropouts(),
    ];
  });
  expect(codes.slice(0, 3)).toEqual([0, -2, -3]); // Err.OK, BAD_INDEX, BAD_VALUE
  expect(typeof codes[3]).toBe('number');
});

test('oversized sample defers while playing, loads after stop (memory grows)', async ({ page }) => {
  await startAudio(page);
  await page.evaluate(() => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    engine!.send(Op.PLAY);
  });
  await expect.poll(slot(page, 1)).toBe(1); // playing
  const result = await page.evaluate(async () => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    const e = engine! as typeof engine & { onSampleLoaded?: (id: number) => void };
    const loaded = new Promise<number>((r) => (e.onSampleLoaded = r));
    // Larger than the pre-reserved 32 Mi-float arena: cannot fit while playing.
    const first = await e.loadSample(3, [new Float32Array(33 * 1024 * 1024)]);
    e.send(Op.STOP);
    return { first, loadedId: await loaded };
  });
  expect(result).toEqual({ first: -4, loadedId: 3 }); // Err.DEFERRED, then loaded
  // Audio keeps running after the heap grew (views were rebuilt, no trap).
  const blocks = await slot(page, 0)();
  await expect.poll(slot(page, 0)).toBeGreaterThan(blocks + 10);
});

test('space toggles transport and keyboard plays', async ({ page }) => {
  await startAudio(page);
  await buildSynth(page);
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(1); // playing
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(0);
  await page.keyboard.down('KeyH'); // A4
  await expect.poll(slot(page, 5), { timeout: 5_000 }).toBeGreaterThan(0.05); // peakL
  await page.keyboard.up('KeyH');
});

/** Max peakL seen over `ms` (sampled every 4 ms): a short hit is easy to miss with a single read. */
function maxPeak(page: Page, ms = 2000) {
  return page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        const eng = (window as unknown as DawWindow).__daw!.engine!;
        let max = 0;
        const t0 = performance.now();
        const id = setInterval(() => {
          max = Math.max(max, eng.telemetry()[5]);
          if (performance.now() - t0 > ms) {
            clearInterval(id);
            resolve(max);
          }
        }, 4);
      }),
    ms,
  );
}

/**
 * Dispatch a file drop onto the element with `testid` (bytes passed as a
 * number array). Returns, per event, whether its default action was prevented
 * (for 'drop' the default is navigating to the file).
 */
async function dropFile(page: Page, testid: string, name: string, type: string, bytes: number[]) {
  return page.evaluate(
    ({ testid, name, type, bytes }) => {
      const el = document.querySelector(`[data-testid="${testid}"]`)!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
      const prevented: Record<string, boolean> = {};
      for (const t of ['dragenter', 'dragover', 'drop']) {
        prevented[t] = !el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
      return prevented;
    },
    { testid, name, type, bytes },
  );
}

async function loadKickOnRow0(page: Page) {
  await dropFile(page, 'row-0', 'kick.wav', 'audio/wav', [...makeWav()]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
}

test('drop sample, program steps, hear it', async ({ page }) => {
  await startAudio(page);
  await loadKickOnRow0(page);
  for (const s of [0, 4, 8, 12]) await page.getByTestId(`step-0-${s}`).click();
  await page.keyboard.press('Space');
  expect(await maxPeak(page)).toBeGreaterThan(0.1); // peakL
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        const cls = await page.locator('[data-testid^="step-0-"].playhead').first().getAttribute('data-testid');
        if (cls) seen.add(cls);
        return seen.size;
      },
      { timeout: 4_000 },
    )
    .toBeGreaterThan(1);
  await page.screenshot({ path: test.info().outputPath('step-grid.png') }); // under test-results/
});

test('bad file drop shows error', async ({ page }) => {
  await startAudio(page);
  await loadKickOnRow0(page);
  const rows = page.locator('[data-testid^="row-"][role="group"]');
  const before = await rows.count();
  await dropFile(page, 'row-1', 'notes.txt', 'text/plain', [...Buffer.from('hello')]);
  await expect(page.getByTestId('banner')).toContainText('Couldn\'t load "notes.txt"');
  await expect(page.getByTestId('row-1').getByTestId('row-name')).toHaveText('drop sample');
  // A .wav name with garbage bytes passes the extension check but fails decoding.
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await dropFile(page, 'row-1', 'broken.wav', 'audio/wav', [1, 2, 3, 4, 5, 6, 7, 8]);
  await expect(page.getByTestId('banner')).toContainText('not a readable audio file');
  await expect(page.getByTestId('row-1').getByTestId('row-name')).toHaveText('drop sample');
  // A failed drop on "+ Add row" must not leave an orphan row.
  await dropFile(page, 'add-row', 'notes.txt', 'text/plain', [...Buffer.from('hello')]);
  await expect(rows).toHaveCount(before);
  for (const s of [0, 4, 8, 12]) await page.getByTestId(`step-0-${s}`).click();
  await page.keyboard.press('Space');
  expect(await maxPeak(page)).toBeGreaterThan(0.1);
});

test('drop outside a row is caught: no navigation, hint shown', async ({ page }) => {
  await startAudio(page);
  const url = page.url();
  // The Browser pane invites drops but is not a target; synthetic events can't
  // trigger real navigation, so check the drop's default action was prevented.
  const prevented = await dropFile(page, 'browser', 'kick.wav', 'audio/wav', [...makeWav()]);
  expect(prevented.dragover).toBe(true);
  expect(prevented.drop).toBe(true);
  await expect(page.getByTestId('banner')).toContainText('Drop onto a step-grid row');
  expect(page.url()).toBe(url);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('drop sample');
  // A real row drop is not flagged with the hint.
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await loadKickOnRow0(page);
  await expect(page.getByTestId('banner')).toBeHidden();
});

test('Space and piano keys still work after touching a slider or the BPM field', async ({ page }) => {
  await startAudio(page);
  await buildSynth(page);
  await page.getByTestId('swing').fill('30'); // focuses the range input
  await expect(page.getByTestId('swing')).toBeFocused();
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(1); // playing
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(0);
  await page.keyboard.down('KeyH'); // A4 on the qwerty piano
  await expect.poll(slot(page, 5), { timeout: 5_000 }).toBeGreaterThan(0.05);
  await page.keyboard.up('KeyH');
  // The BPM field is text entry while focused; Enter commits and releases it.
  const bpm = page.getByRole('spinbutton');
  await bpm.fill('130');
  await bpm.press('Enter');
  await expect(bpm).not.toBeFocused();
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(1);
});

test('worklet answers a malformed sample message with BAD_VALUE and its original id', async ({ page }) => {
  await startAudio(page);
  const codes = await page.evaluate(async () => {
    const e = (window as unknown as DawWindow).__daw!.engine! as unknown as {
      node: AudioWorkletNode;
      waiting: Map<unknown, ((code: number) => void)[]>;
      loadSample(id: number, channels: Float32Array[]): Promise<number>;
    };
    // Post straight to the port (bypassing loadSample's validation), and wait
    // on the reply the same way loadSample does.
    const raw = (id: unknown, frames: number, data: Float32Array) =>
      new Promise<number>((resolve) => {
        e.waiting.set(id, [resolve]);
        e.node.port.postMessage({ type: 'sample', id, frames, channels: 1, data });
      });
    return [
      await raw(7, 100, new Float32Array(10)), // data shorter than frames
      await raw('x', 10, new Float32Array(10)), // non-u32 id: echoed as-is
      await e.loadSample(1.5, [new Float32Array(10)]), // rejected before posting
    ];
  });
  expect(codes).toEqual([-3, -3, -2]); // BAD_VALUE, BAD_VALUE, BAD_INDEX
});

test('engine failure is shown prominently and loads settle', async ({ page }) => {
  await startAudio(page);
  await expect(page.getByTestId('engine-error')).toBeHidden();
  const code = await page.evaluate(async () => {
    const e = (window as unknown as DawWindow).__daw!.engine! as unknown as {
      node: AudioWorkletNode;
      loadSample(id: number, channels: Float32Array[]): Promise<number>;
    };
    e.node.port.postMessage({ type: 'test-fail' }); // next process() throws
    await new Promise((r) => setTimeout(r, 200));
    return e.loadSample(0, [new Float32Array(10)]);
  });
  expect(code).toBe(-100); // HostErr.ENGINE_STOPPED, not a hang
  await expect(page.getByTestId('engine-error')).toContainText('Audio engine stopped — reload');
  // Output is silent from then on.
  await page.evaluate(() => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    engine!.send(Op.NOTE_ON, 69, 127);
  });
  expect(await maxPeak(page, 500)).toBe(0);
});

test('a command burst larger than the ring is delivered, in order, nothing dropped', async ({ page }) => {
  await startAudio(page);
  await page.getByTestId('add-synth-track').click(); // live input
  const backlog = await page.evaluate(() => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    // 3001 commands in one task (the ring holds 1023): only the last NOTE_ON
    // leaves a note sounding, so a dropped or reordered tail means silence.
    for (let i = 0; i < 1500; i++) {
      engine!.send(Op.NOTE_ON, 69, 100);
      engine!.send(Op.NOTE_OFF, 69);
    }
    engine!.send(Op.NOTE_ON, 69, 100);
    return (engine as unknown as { commandBacklog: number }).commandBacklog;
  });
  expect(backlog).toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => ((window as unknown as DawWindow).__daw!.engine as unknown as { commandBacklog: number }).commandBacklog))
    .toBe(0);
  await expect.poll(slot(page, 5), { timeout: 1_000 }).toBeGreaterThan(0.05);
  await expect(page.getByRole('alert')).toBeHidden(); // no stall banner
  await page.evaluate(() => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    engine!.send(Op.NOTE_OFF, 69);
  });
});

/** Fill the 32 Mi-float arena (stopped) so any further load needs growth. */
async function fillArena(page: Page, leave: number) {
  const code = await page.evaluate(
    (leave) => (window as unknown as DawWindow).__daw!.engine!.loadSample(200, [new Float32Array(32 * 1024 * 1024 - leave)]),
    leave,
  );
  expect(code).toBe(0);
}

// 'deferred drop while playing' lives in serial.spec.ts (it asserts real-time
// block rates, so it must not share the machine with parallel workers).

test('a deferred load evicted from the retry queue shows an error', async ({ page }) => {
  await startAudio(page);
  await fillArena(page, 0);
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(1);
  await dropFile(page, 'row-0', 'kick.wav', 'audio/wav', [...makeWav()]);
  await expect(page.getByTestId('notice')).toBeVisible();
  // 32 more deferred loads overflow the 32-entry queue, evicting the kick.
  await page.evaluate(async () => {
    const e = (window as unknown as DawWindow).__daw!.engine!;
    for (let id = 201; id < 233; id++) await e.loadSample(id, [new Float32Array(10)]);
  });
  await expect(page.getByTestId('banner')).toContainText('Couldn\'t load "kick"');
  await expect(page.getByTestId('notice')).toBeHidden();
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('drop sample');
});

// ---- Track list (Task 8): driven through the UI, not raw engine commands ----

test('add synth track, it plays from the keyboard', async ({ page }) => {
  await startAudio(page);
  await page.getByTestId('add-synth-track').click();
  const row = page.getByTestId('track-1');
  await expect(row).toContainText('Synth · Deep Bass');
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('keys-target')).toContainText('Keys → Synth');
  // Synth tracks open on the Piano roll (default); the rack is one tab away.
  await expect(page.getByRole('button', { name: 'Piano roll' })).toHaveClass(/active/);
  await expect(page.getByTestId('pianoroll')).toBeVisible();
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByRole('button', { name: 'Instrument' })).toHaveClass(/active/);
  await expect(page.getByTestId('rack')).toBeVisible();
  await page.keyboard.down('KeyA');
  await expect.poll(slot(page, 5), { timeout: 1_000 }).toBeGreaterThan(0.05); // peakL
  await page.keyboard.up('KeyA');
  await expect.poll(slot(page, 5), { timeout: 1_000 }).toBeLessThan(0.001);
});

test('selecting drums keeps keys on the last synth', async ({ page }) => {
  await startAudio(page);
  await page.getByTestId('add-synth-track').click();
  await page.getByTestId('track-0').click();
  await expect(page.getByTestId('track-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Step grid' })).toHaveClass(/active/);
  await expect(page.getByTestId('keys-target')).toContainText('Keys → Synth');
  await page.keyboard.down('KeyA');
  await expect.poll(slot(page, 5), { timeout: 1_000 }).toBeGreaterThan(0.05);
  await page.keyboard.up('KeyA');
});

test('removing the synth track silences it and keys show no synth', async ({ page }) => {
  await startAudio(page);
  await page.getByTestId('add-synth-track').click();
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); void d.accept(); });
  await page.getByTestId('track-1').hover();
  await page.getByRole('button', { name: 'Remove track Synth' }).click();
  await expect(page.getByTestId('track-1')).toHaveCount(0);
  expect(asked).toBe('Remove track "Synth" and its 1 pattern? This cannot be undone.');
  await expect(page.getByTestId('keys-target')).not.toContainText('Synth');
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(300);
  expect(await slot(page, 5)()).toBeLessThan(0.001);
  await page.keyboard.up('KeyA');
});

// ---- Rack UI (Task 9): modules, knobs, jacks, cables -----------------------

/** Centre of the element with `testid`, scrolled into view first. */
async function centre(page: Page, testid: string) {
  const el = page.getByTestId(testid);
  await el.scrollIntoViewIfNeeded();
  const b = (await el.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Real mouse drag (pointer events + capture) from a jack to a point. */
async function dragTo(page: Page, fromTestid: string, to: { x: number; y: number }) {
  const a = await centre(page, fromTestid);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + to.x) / 2, (a.y + to.y) / 2 + 20, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

/** Hold `keys`, return the max peakL seen over `ms`, release. */
async function holdPeak(page: Page, keys: string[], ms = 700) {
  for (const k of keys) await page.keyboard.down(k);
  const peak = await maxPeak(page, ms);
  for (const k of keys) await page.keyboard.up(k);
  return peak;
}

async function addSynth(page: Page) {
  await startAudio(page);
  await page.getByTestId('add-synth-track').click();
  await page.getByRole('button', { name: 'Instrument' }).click(); // default tab is the Piano roll
  await expect(page.getByTestId('rack')).toBeVisible();
}

test('rack shows the patch and knobs show values', async ({ page }) => {
  await addSynth(page);
  const names = ['MIDI In', 'Oscillator', 'Oscillator', 'Mixer', 'Filter', 'ADSR', 'VCA', 'Out'];
  await expect(page.locator('[data-testid^="module-"]')).toHaveCount(names.length);
  for (const [i, n] of names.entries()) await expect(page.getByTestId(`module-${i}`)).toContainText(n);
  await expect(page.getByTestId('knob-4-cutoff')).toContainText('300 Hz');
  await expect(page.getByTestId('knob-4-cutoff')).toContainText('Cutoff');
  await expect(page.getByTestId('patch-select')).toHaveValue('Deep Bass');
  // 11 cables in Deep Bass, all drawn.
  await expect(page.locator('[data-testid="cables"] path.cable')).toHaveCount(11);
  // Every cable's lowest point is inside the rail's scrollable content
  // (reachable by scrolling, not clipped), and jack labels sit above holes.
  const fit = await page.evaluate(() => {
    const rail = document.querySelector('[data-testid="rail"]')!;
    const top = rail.getBoundingClientRect().top - rail.scrollTop;
    const lowest = Math.max(...[...document.querySelectorAll('[data-testid="cables"] path.cable')].map((p) => p.getBoundingClientRect().bottom));
    return { lowest: lowest - top, scrollHeight: rail.scrollHeight };
  });
  expect(fit.lowest).toBeLessThanOrEqual(fit.scrollHeight);
  const jack = page.getByTestId('jack-0-out-gate');
  const nameBox = (await jack.getByText('gate').boundingBox())!;
  const holeBox = (await jack.locator('.hole').boundingBox())!;
  expect(nameBox.y + nameBox.height).toBeLessThanOrEqual(holeBox.y + 1);
  await page.screenshot({ path: 'test-results/rack.png' });
});

test('turning cutoff updates readout and engine accepts it', async ({ page }) => {
  await addSynth(page);
  const knob = page.getByTestId('knob-4-cutoff');
  const before = await knob.getAttribute('aria-valuetext');
  const err = await slot(page, 7)();
  await knob.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowUp');
  await expect(knob).not.toHaveAttribute('aria-valuetext', before!);
  await expect(knob).not.toContainText('300 Hz');
  await expect(page.getByTestId('patch-edited')).toBeVisible();
  const blocks = await slot(page, 0)();
  await expect.poll(slot(page, 0)).toBeGreaterThan(blocks + 2);
  expect(await slot(page, 7)()).toBe(err);
  // With edits, loading a patch asks first: declining keeps everything.
  const after = await knob.getAttribute('aria-valuetext');
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); void d.dismiss(); });
  await page.getByTestId('patch-select').selectOption('Pad');
  await expect.poll(() => asked).toBe('Discard your edits to "Deep Bass"?');
  await expect(page.getByTestId('patch-select')).toHaveValue('Deep Bass');
  await expect(knob).toHaveAttribute('aria-valuetext', after!);
  await expect(page.getByTestId('patch-edited')).toBeVisible();
  // Accepting loads it and clears the marker.
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('patch-select').selectOption('Pad');
  await expect(page.getByTestId('patch-select')).toHaveValue('Pad');
  await expect(page.locator('[data-testid^="module-"]')).toHaveCount(7);
  await expect(page.getByTestId('patch-edited')).toBeHidden();
});

test('Escape cancels a cable drag and a knob drag (nothing changes)', async ({ page }) => {
  await addSynth(page);
  const cables = page.locator('[data-testid="cables"] path.cable');
  const a = await centre(page, 'jack-7-in-l');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x - 60, a.y - 80, { steps: 5 });
  await expect(cables).toHaveCount(10); // carried
  await expect(page.locator('[data-testid="cables"] path.drag')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="cables"] path.drag')).toHaveCount(0);
  await expect(cables).toHaveCount(11); // snapped back
  await page.mouse.up();
  await expect(cables).toHaveCount(11);
  expect(await holdPeak(page, ['KeyA'])).toBeGreaterThan(0.05); // still plugged in the engine

  const k = await centre(page, 'knob-4-cutoff');
  await page.mouse.move(k.x, k.y);
  await page.mouse.down();
  await page.mouse.move(k.x, k.y - 60, { steps: 5 });
  await expect(page.getByTestId('knob-4-cutoff')).not.toContainText('300 Hz');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByTestId('knob-4-cutoff')).toContainText('300 Hz');
  await expect(page.getByTestId('knob-4-cutoff')).toHaveAttribute('aria-valuenow', '300');
});

test('pulling the VCA→Out cable silences, re-plugging restores', async ({ page }) => {
  await addSynth(page);
  const cables = page.locator('[data-testid="cables"] path.cable');
  await expect(cables).toHaveCount(11);
  // Drop the Out `l` cable end on the module's header: not a jack -> disconnect.
  const header = await centre(page, 'module-7');
  const box = (await page.getByTestId('module-7').boundingBox())!;
  await dragTo(page, 'jack-7-in-l', { x: header.x, y: box.y + 8 });
  await expect(cables).toHaveCount(10);
  await page.waitForTimeout(100);
  expect(await holdPeak(page, ['KeyA'])).toBeLessThan(0.001);
  await dragTo(page, 'jack-6-out-out', await centre(page, 'jack-7-in-l'));
  await expect(cables).toHaveCount(11);
  expect(await holdPeak(page, ['KeyA'])).toBeGreaterThan(0.05);
});

test('add module menu adds Noise', async ({ page }) => {
  await addSynth(page);
  await page.getByRole('button', { name: '+ Add module' }).click();
  const menu = page.getByTestId('add-menu');
  await expect(menu).toContainText('Source');
  await menu.getByRole('menuitem', { name: 'Noise' }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('module-8')).toContainText('Noise');
  await expect(page.getByTestId('knob-8-level')).toContainText('100%');
  // Escape closes the menu without adding anything.
  await page.getByRole('button', { name: '+ Add module' }).click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('[data-testid^="module-"]')).toHaveCount(9);
});

test('effect modules: pink Effect group, a Delay in the signal path, pool limit greys the 9th', async ({ page }) => {
  await addSynth(page); // Deep Bass: VCA 6 -> Out 7
  const addBtn = page.getByRole('button', { name: '+ Add module' });
  await addBtn.click();
  const menu = page.getByTestId('add-menu');
  await expect(menu).toContainText('Effect');
  for (const name of ['Delay', 'Reverb', 'Chorus', 'EQ', 'Compressor']) {
    await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await page.getByTestId('add-delay').click();
  const delay = page.getByTestId('module-8');
  await expect(delay).toContainText('Delay');
  // Effect category colour (pink) on the header rule.
  await expect(delay).toHaveCSS('border-top-color', 'rgb(255, 122, 138)');
  await expect(page.getByTestId('knob-8-division')).toContainText('3/16');
  // VCA -> Delay -> Out: the patch still plays through it.
  await dragTo(page, 'jack-6-out-out', await centre(page, 'jack-8-in-l'));
  await dragTo(page, 'jack-8-out-l', await centre(page, 'jack-7-in-l'));
  await dragTo(page, 'jack-8-out-r', await centre(page, 'jack-7-in-r'));
  await page.waitForTimeout(100);
  expect(await holdPeak(page, ['KeyA'])).toBeGreaterThan(0.05);
  // 7 more delays use up the engine's 8 shared slots; the 9th is greyed.
  for (let i = 0; i < 7; i++) {
    await addBtn.click();
    await page.getByTestId('add-delay').click();
  }
  await expect(page.locator('[data-testid^="module-"]')).toHaveCount(16);
  await addBtn.click();
  const ninth = page.getByTestId('add-delay');
  await expect(ninth).toHaveAttribute('aria-disabled', 'true');
  await expect(ninth).toContainText('All 8 delays in use');
  await ninth.click({ force: true }); // aria-disabled: Playwright would wait
  await expect(menu).toBeVisible(); // nothing added, the menu says why
  await expect(page.locator('[data-testid^="module-"]')).toHaveCount(16);
  await expect(page.getByTestId('add-reverb')).not.toHaveAttribute('aria-disabled', 'true');
});

test('loading the Chord Stab patch replaces the rack and plays chords', async ({ page }) => {
  await addSynth(page);
  await page.getByTestId('patch-select').selectOption('Chord Stab');
  await expect(page.locator('[data-testid^="module-"]')).toHaveCount(6);
  await expect(page.getByTestId('module-5')).toContainText('Out');
  await expect(page.getByTestId('track-1')).toContainText('Synth · Chord Stab');
  await expect(page.getByTestId('patch-edited')).toBeHidden();
  expect(await holdPeak(page, ['KeyA', 'KeyD', 'KeyG'])).toBeGreaterThan(0.05);
  // Piano keys must not retarget the patch dropdown (type-ahead).
  await expect(page.getByTestId('patch-select')).toHaveValue('Chord Stab');
});

test('a cable can also be drawn from an empty input to an output; a full rack says so', async ({ page }) => {
  await addSynth(page);
  const cables = page.locator('[data-testid="cables"] path.cable');
  await dragTo(page, 'jack-3-in-in3', await centre(page, 'jack-1-out-out'));
  await expect(cables).toHaveCount(12);
  // Deep Bass has 8 modules; fill the other 24 slots through the menu.
  const addBtn = page.getByRole('button', { name: '+ Add module' });
  for (let i = 0; i < 24; i++) {
    await addBtn.click();
    await page.getByTestId('add-noise').click();
  }
  await expect(page.locator('[data-testid^="module-"]')).toHaveCount(32);
  await addBtn.click();
  await expect(page.getByTestId('add-menu')).toContainText('Rack is full');
  await page.mouse.click(5, 5); // outside click closes it
  await expect(page.getByTestId('add-menu')).toBeHidden();
});

test('dragging a knob coalesces param sends (at most one per frame + final)', async ({ page }) => {
  await addSynth(page);
  await page.evaluate(() => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    const w = window as unknown as { setParams: number[] };
    w.setParams = [];
    const orig = engine!.send.bind(engine);
    engine!.send = (op, a, b, c, d) => {
      if (op === Op.RACK_SET_PARAM) w.setParams.push(d!);
      return orig(op, a, b, c, d);
    };
  });
  const k = await centre(page, 'knob-4-cutoff');
  await page.mouse.move(k.x, k.y);
  await page.mouse.down();
  // 60 moves inside one task (one frame), half the range up in total.
  await page.evaluate(({ x, y }) => {
    const el = document.querySelector('[data-testid="knob-4-cutoff"]')!;
    for (let i = 1; i <= 60; i++) {
      el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: y - (75 * i) / 60, bubbles: true }));
    }
  }, k);
  await page.mouse.up();
  const sent = await page.evaluate(() => (window as unknown as { setParams: number[] }).setParams);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.length).toBeLessThanOrEqual(2); // one frame + the final value on pointerup
  // Half of the log range above 300 Hz: 300·(1000)^0.5 ≈ 9.5 kHz, final value sent last.
  expect(sent[sent.length - 1]).toBeGreaterThan(8000);
  await expect(page.getByTestId('knob-4-cutoff')).toContainText('kHz');
});

/**
 * Perf budget: four synth tracks, each a gate-independent "drone" patch, so
 * every voice channel computes all the time (notes can't be held on four
 * tracks at once; SET_INPUT_TRACK releases the previous track's notes).
 *   MIDI In (8 voices) -> 2x Osc saw (unison 2) -> Mixer -> Filter LP24
 *   (reso 0.5, cv <- LFO, cv_amt 2) -> VCA (cv unconnected = unity) -> Out.
 * Built with raw commands (catalog kind ids, packed module*16+port).
 */
test('four synth tracks stay under budget', async ({ page }) => {
  await startAudio(page);
  const before = await page.evaluate(() => {
    const { engine, Op } = (window as unknown as DawWindow).__daw!;
    const send = (op: number, a = 0, b = 0, c = 0, d = 0) => engine!.send(op, a, b, c, d);
    const port = (m: number, p: number) => m * 16 + p;
    const K = { midiIn: 0, osc: 1, filter: 3, vca: 5, lfo: 6, mixer: 7, out: 8 };
    let ok = true;
    const run = (r: boolean) => void (ok = ok && r);
    for (let slot = 1; slot <= 4; slot++) {
      run(send(Op.ADD_SYNTH_TRACK, slot));
      // module indices: 0 midi, 1 osc, 2 osc, 3 mixer, 4 filter, 5 lfo, 6 vca, 7 out
      [K.midiIn, K.osc, K.osc, K.mixer, K.filter, K.lfo, K.vca, K.out].forEach((k, i) =>
        run(send(Op.RACK_ADD_MODULE, slot, i, k)));
      run(send(Op.RACK_SET_PARAM, slot, 1, 6, 2)); // osc1 unison 2
      run(send(Op.RACK_SET_PARAM, slot, 2, 6, 2)); // osc2 unison 2
      run(send(Op.RACK_SET_PARAM, slot, 4, 2, 0.5)); // filter reso
      run(send(Op.RACK_SET_PARAM, slot, 4, 3, 2)); // filter cv_amt
      run(send(Op.RACK_CONNECT, slot, port(0, 0), port(1, 0))); // pitch -> osc1
      run(send(Op.RACK_CONNECT, slot, port(0, 0), port(2, 0))); // pitch -> osc2
      run(send(Op.RACK_CONNECT, slot, port(1, 0), port(3, 0))); // osc1 -> mixer in1
      run(send(Op.RACK_CONNECT, slot, port(2, 0), port(3, 1))); // osc2 -> mixer in2
      run(send(Op.RACK_CONNECT, slot, port(3, 0), port(4, 0))); // mixer -> filter in
      run(send(Op.RACK_CONNECT, slot, port(5, 0), port(4, 1))); // lfo -> filter cv
      run(send(Op.RACK_CONNECT, slot, port(4, 0), port(6, 0))); // filter -> vca in
      run(send(Op.RACK_CONNECT, slot, port(6, 0), port(7, 0))); // vca -> out l
      run(send(Op.RACK_CONNECT, slot, port(6, 0), port(7, 1))); // vca -> out r
    }
    return { ok, dropouts: engine!.dropouts() };
  });
  expect(before.ok).toBe(true);
  const err0 = await slot(page, 7)();
  // Telemetry CPU is written once per second by the worklet: wait >= 3 s.
  await page.waitForTimeout(3500);
  const cpu = await slot(page, 3)();
  const drop = await page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.dropouts());
  console.log(`PERF four synth tracks: cpu=${(cpu * 100).toFixed(1)}%`);
  expect(await slot(page, 7)()).toBe(err0);
  expect(cpu).toBeGreaterThan(0);
  expect(cpu).toBeLessThan(0.6);
  expect(drop).toBe(before.dropouts);
  // The drones must actually be rendering (a silent graph would be cheap).
  expect(await slot(page, 5)()).toBeGreaterThan(0); // peakL
  expect(await slot(page, 6)()).toBeGreaterThan(0); // peakR
});

// ---- Recording (plan 3, Task 4) ----

/** Ids of the notes the last recording pass added. */
const takeLen = (page: Page) => () =>
  page.evaluate(() => (window as unknown as DawWindow).__daw!.recorder!.lastTakeIds.length);

test('record: R arms, played notes land in the pattern, a note held through Stop is closed, undo removes the take', async ({ page }) => {
  await startAudio(page);
  await page.getByTestId('add-synth-track').click();
  const rec = page.getByTestId('rec-button');
  await expect(rec).toHaveAttribute('data-state', 'off');
  await page.keyboard.press('KeyR'); // stopped: only arms
  await expect(rec).toHaveAttribute('aria-pressed', 'true');
  await expect(rec).toHaveAttribute('data-state', 'armed');
  expect(await slot(page, 1)()).toBe(0); // arming did not start the transport
  await page.keyboard.press('Space');
  await expect(rec).toHaveAttribute('data-state', 'recording');
  await expect(rec).toHaveText('● REC');
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(150);
  await page.keyboard.up('KeyA');
  await page.keyboard.down('KeyD'); // held through Stop
  await page.waitForTimeout(150);
  await page.keyboard.press('Space');
  await expect.poll(takeLen(page)).toBe(2);
  await page.keyboard.up('KeyD');
  await expect(rec).toHaveAttribute('data-state', 'armed');
  const undo = page.getByTestId('undo-take');
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect.poll(takeLen(page)).toBe(0);
  await expect(undo).toBeDisabled();
});

test('count-in: Play while armed counts one bar in, then records; the setting persists', async ({ page }) => {
  await startAudio(page);
  await page.getByTestId('add-synth-track').click();
  const countIn = page.getByTestId('count-in');
  await countIn.click();
  await expect(countIn).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('KeyR');
  await page.keyboard.press('Space');
  const rec = page.getByTestId('rec-button');
  await expect(rec).toHaveText('Count-in…');
  // Engine started at -3840 ticks (the label shows as soon as Play is sent, up
  // to a block before the engine applies PLAY, so poll).
  await expect.poll(slot(page, 2), { timeout: 1_000 }).toBeLessThan(0);
  // One bar at 124 bpm is ~1.9 s.
  await expect(rec).toHaveAttribute('data-state', 'recording', { timeout: 5_000 });
  await page.keyboard.press('Space');
  await page.reload();
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByTestId('count-in')).toHaveAttribute('aria-pressed', 'true');
  // Not armed: Play has no count-in.
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(1);
  expect(await slot(page, 2)()).toBeGreaterThanOrEqual(0);
});

test('record: switching the input track mid-pass ends held notes there and records later notes on the new track', async ({ page }) => {
  await startAudio(page);
  await page.getByTestId('add-synth-track').click(); // slot 1
  await page.getByTestId('add-synth-track').click(); // slot 2, selected: keys -> it
  await page.keyboard.press('KeyR');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('rec-button')).toHaveAttribute('data-state', 'recording');
  await page.keyboard.down('KeyA'); // C, held across the switch
  await page.waitForTimeout(150);
  await page.getByTestId('track-1').click();
  await page.waitForTimeout(100);
  await page.keyboard.up('KeyA');
  await page.keyboard.down('KeyD'); // E, played on track 1
  await page.waitForTimeout(150);
  await page.keyboard.up('KeyD');
  await page.keyboard.press('Space');
  const pitches = (i: number) =>
    page.evaluate((i) => (window as unknown as DawWindow).__daw!.project.tracks[i].patterns[0].notes!.map((n) => n.pitch % 12), i);
  await expect.poll(() => pitches(2)).toEqual([0]);
  await expect.poll(() => pitches(1)).toEqual([4]);
});

// ---- Recording e2e with simulated Bluetooth latency (plan 3, Task 6) ----

test('record from the keyboard, notes land on the heard beat (simulated Bluetooth, 250 ms)', async ({ page }) => {
  // Headless Chromium reports no output latency, so install a getOutputTimestamp
  // that says "what you hear is 250 ms behind currentTime", before the app loads.
  const LATENCY_S = 0.25;
  await page.addInitScript((lat) => {
    AudioContext.prototype.getOutputTimestamp = function (this: AudioContext) {
      (window as unknown as { __ctx?: AudioContext }).__ctx = this;
      return { contextTime: this.currentTime - lat, performanceTime: performance.now() };
    };
  }, LATENCY_S);

  await startAudio(page);
  await page.getByTestId('add-synth-track').click();
  await page.getByRole('button', { name: 'Metronome' }).click();
  await expect(page.getByRole('button', { name: 'Metronome' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.getByTestId('count-in').getAttribute('aria-pressed')).toBe('false');
  await page.keyboard.press('KeyR');
  await expect(page.getByTestId('rec-button')).toHaveAttribute('data-state', 'armed');

  await page.keyboard.press('Space');
  await expect(page.getByTestId('rec-button')).toHaveAttribute('data-state', 'recording');

  // INDEPENDENT reference: the "rendered" tick from raw engine telemetry and
  // ctx.currentTime (never the audioClock, which is what is under test). The
  // mock captures the context on first use; heardTicks() forces that call.
  const tempo = await page.evaluate(() => (window as unknown as DawWindow).__daw!.project.tempo);
  const lateTicks = LATENCY_S * (tempo / 60) * 960; // ~496 at 124 BPM
  const rawTick = () =>
    page.evaluate(() => {
      const w = window as unknown as DawWindow & { __ctx?: AudioContext };
      w.__daw!.clock!.heardTicks();
      const t = w.__daw!.engine!.telemetry(); // [2] ticks at [8] frame
      const ctx = w.__ctx!;
      const fpt = (ctx.sampleRate * 60) / (w.__daw!.project.tempo * 960);
      return t[2] + (ctx.currentTime * ctx.sampleRate - t[8]) / fpt;
    });
  const heardNow = () => page.evaluate(() => (window as unknown as DawWindow).__daw!.clock!.heardTicks());

  // Wait (polling, no fixed sleeps) until the raw tick is one beat + latency, i.e.
  // beat 2 (tick 960) is just being *heard*.
  await expect.poll(rawTick, { intervals: [10] }).toBeGreaterThanOrEqual(960 + lateTicks - 20);
  // Meaningful mock check: the clock reports the heard tick ~latency behind raw.
  const [r0, h0] = [await rawTick(), await heardNow()];
  expect(r0 - h0).toBeGreaterThan(lateTicks - 80);
  expect(r0 - h0).toBeLessThan(lateTicks + 80);

  const rawBefore = await rawTick();
  await page.keyboard.down('KeyA'); // play A (C4)
  const rawAfter = await rawTick();
  await page.waitForTimeout(200); // the held length itself; not a sync point
  await page.keyboard.up('KeyA');
  await page.keyboard.press('Space');

  await expect(page.getByTestId('pr-readout')).toContainText('1 note ');
  const notes = await page.evaluate(() =>
    (window as unknown as DawWindow).__daw!.project.tracks.flatMap((t) => t.patterns[0]?.notes ?? []).map((n) => ({ pitch: n.pitch, start: n.start, len: n.len })),
  );
  expect(notes).toHaveLength(1);
  const n = notes[0];
  expect(n.pitch).toBe(60);
  // Heard time = raw tick minus the latency in ticks (+-60 ticks grace).
  expect(n.start).toBeGreaterThanOrEqual(rawBefore - lateTicks - 60);
  expect(n.start).toBeLessThanOrEqual(rawAfter - lateTicks + 60);
  // And clearly NOT the rendered (~480-500 ticks late) position.
  expect(n.start).toBeLessThan(rawBefore - 300);
  expect(n.len).toBeGreaterThan(200); // ~200 ms ~ 400 ticks

  await page.getByTestId('undo-take').click();
  await expect(page.getByTestId('pr-readout')).toContainText('0 notes');
});
