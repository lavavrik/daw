import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';

// Timing-sensitive e2e tests. The "serial" Playwright project runs this file
// alone, after all parallel tests are done (playwright.config.ts), so CPU
// contention from other workers cannot cause audio overruns and the
// real-time assertions below (engine block rate, CPU share, dropouts) mean
// what they say.

type DawWindow = {
  __daw?: {
    engine: {
      telemetry(): Float64Array;
      meters(): Float32Array;
      loadSample(id: number, channels: Float32Array[]): Promise<number>;
      dropouts(): number;
      failure: string | null;
      sampleRate: number;
    } | null;
    Op: Record<string, number>;
    project: { arenaFloats: number; tracks: { id: string; slot: number; kind: string; rows?: { id: string }[] }[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actions: Record<string, (...args: any[]) => any>;
  };
};

async function startAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByRole('button', { name: 'Click to start audio' })).toBeHidden();
}

function slot(page: Page, i: number) {
  return () =>
    page.evaluate((i) => {
      const daw = (window as unknown as DawWindow).__daw;
      return daw?.engine ? daw.engine.telemetry()[i] : NaN;
    }, i);
}

async function dropFile(page: Page, testid: string, name: string, type: string, bytes: number[]) {
  await page.evaluate(
    ({ testid, name, type, bytes }) => {
      const el = document.querySelector(`[data-testid="${testid}"]`)!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
      for (const t of ['dragenter', 'dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    { testid, name, type, bytes },
  );
}

/**
 * Fill the arena's first 32 Mi-float chunk (stopped) up to `leave` floats, so
 * any larger load needs growth. The arena allocates first fit, so the fill
 * goes into that chunk's tail after the default kit's samples, which
 * Project.arenaFloats counts (state/sampleBudget.ts).
 */
async function fillArena(page: Page, leave: number) {
  const code = await page.evaluate((leave) => {
    const daw = (window as unknown as DawWindow).__daw!;
    return daw.engine!.loadSample(200, [new Float32Array(32 * 1024 * 1024 - daw.project.arenaFloats - leave)]);
  }, leave);
  expect(code).toBe(0);
}

/**
 * Engine blocks rendered per real second, as a share of what real time needs
 * (sampleRate / 128 blocks per second). 1.0 = keeping up; below means the
 * audio thread stalled (e.g. blocked on a memory grow) or was starved.
 */
function blockShare(page: Page, ms: number) {
  return page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        const eng = (window as unknown as DawWindow).__daw!.engine!;
        const b0 = eng.telemetry()[0];
        const t0 = performance.now();
        setTimeout(() => {
          const blocks = eng.telemetry()[0] - b0;
          const secs = (performance.now() - t0) / 1000;
          resolve((blocks * 128) / eng.sampleRate / secs);
        }, ms);
      }),
    ms,
  );
}

test('deferred drop while playing: notice, loads on Stop, engine keeps running at real time', async ({ page }) => {
  await startAudio(page);
  // Let the default kit load first: loading after the fill (stopped, so it
  // may grow the arena) it would leave room for the kick.
  await expect(page.getByTestId('row-7').getByTestId('row-name')).toHaveText('Perc');
  // Leave less room than the kick (50 ms = 2205..2400 frames) needs.
  await fillArena(page, 100);
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(1);
  await page.waitForTimeout(500); // settle: the first blocks after Play are not steady state
  const ticks = () => page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.telemetry()[2]);
  const before = await ticks();
  // Stall guard (plan-4 review): parking the deferred load must not cost the
  // audio thread anything. Serial project => no other workers; the engine must
  // render at least 95% of real time while the load is parked.
  const share = blockShare(page, 1500);
  await dropFile(page, 'row-0', 'kick.wav', 'audio/wav', [...makeWav()]);
  await expect(page.getByTestId('notice')).toContainText('"kick" will load when playback stops');
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('Kick'); // the default kit's, until Stop
  const s = await share;
  console.log(`SERIAL deferred drop: engine blocks at ${(s * 100).toFixed(1)}% of real time`);
  expect(s).toBeGreaterThanOrEqual(0.95);
  await expect.poll(ticks).not.toBe(before); // still playing with the load parked
  expect(await page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.failure)).toBeNull();
  // Select a synth track first: the step grid unmounts, but the pending load
  // is session state (state/sampleLoads.ts) and must still land on Stop.
  await page.getByTestId('add-synth-track').click();
  await expect(page.getByTestId('pianoroll')).toBeVisible();
  await expect(page.getByTestId('row-0')).toHaveCount(0);
  await page.keyboard.press('Space'); // Stop -> retry (grows memory)
  await expect(page.getByTestId('notice')).toBeHidden();
  await page.getByTestId('track-0').click(); // back to the drums
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  await expect(page.getByTestId('notice')).toBeHidden();
  await expect(page.getByTestId('banner')).toBeHidden();
});

/**
 * Spec §6 in the browser: 4 drum tracks x 8 rows with patterns, 4 Chord Stab
 * synth tracks (8 voices, 13-module-class patch, a held 8-note chord plus a
 * 16-note arpeggio in the pattern), EQ and both sends on every strip, two
 * sidechained compressors (synth 1 keyed by drum track 1's kick row, synth 2
 * by the whole of drum track 2), both returns and the master limiter. Built
 * through the same actions the UI uses (window.__daw.actions). Plays 10 s.
 * Budget: audio-thread CPU share < 0.6 and no new dropouts.
 */
test('spec 6 mix stays under the browser CPU budget', async ({ page }) => {
  test.setTimeout(60_000);
  await startAudio(page);
  const setup = await page.evaluate(async () => {
    const { engine, actions: a, project } = (window as unknown as DawWindow).__daw!;
    // Drum sample: 0.1 s of a decaying sine (id 0, shared by every row).
    const n = Math.round(engine!.sampleRate * 0.1);
    const ch = new Float32Array(n).map((_, i) => Math.sin(i * 0.05) * (1 - i / n));
    if ((await engine!.loadSample(0, [ch])) !== 0) return { ok: false, why: 'sample' };
    // Drum tracks: the default one is slot 0; add three more, 8 rows each.
    for (let i = 0; i < 3; i++) a.addDrumTrack();
    const drums = project.tracks.filter((t) => t.kind === 'drum');
    for (const t of drums) {
      while (t.rows!.length < 8) a.addRow(t.id);
      t.rows!.forEach((r, row) => {
        a.setRowSample(t.id, r.id, 0, 'sine');
        for (let step = row % 2; step < 16; step += 2 + (row % 3)) a.setStep(t.id, r.id, step, 100);
      });
    }
    for (let i = 0; i < 4; i++) a.addSynthTrack('Chord Stab');
    const synths = project.tracks.filter((t) => t.kind === 'synth');
    synths.forEach((t, k) => {
      // Held chord (a full 4-bar pattern, all 8 voices busy) + one bar of 16ths.
      [36, 40, 43, 47, 50, 53, 57, 60].forEach((p) => a.addNote(t.id, { pitch: p + k, start: 0, len: 15360, vel: 90 }));
      for (let i = 0; i < 16; i++) a.addNote(t.id, { pitch: 60 + ((i * 5 + k) % 24), start: i * 240, len: 120, vel: 100 });
    });
    // Mix: EQ, both sends and a lowered fader on every track; returns/master EQ.
    for (const t of project.tracks) {
      a.setMix(t.id, 'eq_on', 1);
      a.setMix(t.id, 'eq_low', 2);
      a.setMix(t.id, 'eq_mid_gain', -3);
      a.setMix(t.id, 'send_a', -12);
      a.setMix(t.id, 'send_b', -18);
      a.setMix(t.id, 'fader', -6);
    }
    for (const r of ['reverb', 'delay', 'master']) {
      a.setMix(r, 'eq_on', 1);
      a.setMix(r, 'eq_mid_gain', 2);
    }
    // Two sidechained compressors.
    const comp = (id: string, key: { trackId: string; row: number | null }) => {
      a.setMix(id, 'comp_on', 1);
      a.setMix(id, 'comp_threshold', -30);
      a.setMix(id, 'comp_ratio', 8);
      return a.setSidechain(id, key);
    };
    const k1 = comp(synths[0].id, { trackId: drums[0].id, row: 0 });
    const k2 = comp(synths[1].id, { trackId: drums[1].id, row: null });
    return { ok: k1 && k2, why: 'keys', synths: synths.map((t) => t.slot), drums: drums.map((t) => t.slot) };
  });
  expect(setup.ok, setup.why).toBe(true);
  expect(await page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.failure)).toBeNull();
  const drop0 = await page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.dropouts());
  const err0 = await slot(page, 7)();

  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(1);
  await page.waitForTimeout(2500); // warm-up (telemetry CPU is written once a second)
  // 10 s: sample the CPU share, the peak and the first comp's gain reduction.
  const run = await page.evaluate(
    (scSlot) =>
      new Promise<{ cpu: number[]; peak: number; gr: number; share: number }>((resolve) => {
        const eng = (window as unknown as DawWindow).__daw!.engine!;
        const cpu: number[] = [];
        let peak = 0;
        let gr = 0;
        const b0 = eng.telemetry()[0];
        const t0 = performance.now();
        const id = setInterval(() => {
          const t = eng.telemetry();
          cpu.push(t[3]);
          peak = Math.max(peak, t[5], t[6]);
          gr = Math.max(gr, eng.meters()[scSlot * 3 + 2]); // the keyed comp's gain reduction
          if (performance.now() - t0 >= 10_000) {
            clearInterval(id);
            const secs = (performance.now() - t0) / 1000;
            resolve({ cpu, peak, gr, share: ((t[0] - b0) * 128) / eng.sampleRate / secs });
          }
        }, 250);
      }),
    setup.synths![0],
  );
  const mean = run.cpu.reduce((x, y) => x + y, 0) / run.cpu.length;
  const max = Math.max(...run.cpu);
  console.log(`PERF spec6 browser: cpu mean=${(mean * 100).toFixed(1)}% max=${(max * 100).toFixed(1)}% blocks=${(run.share * 100).toFixed(1)}% of real time`);
  expect(run.peak).toBeGreaterThan(0.01); // it sounds
  expect(run.gr).toBeGreaterThan(1); // the sidechain ducks
  expect(max).toBeGreaterThan(0);
  expect(max).toBeLessThan(0.6);
  expect(run.share).toBeGreaterThanOrEqual(0.95);
  expect(await page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.dropouts())).toBe(drop0);
  expect(await slot(page, 7)()).toBe(err0);
});
