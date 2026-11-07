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
    project: { arenaFloats: number; mode: string; tracks: { id: string; slot: number; kind: string; rows?: { id: string }[]; clips?: unknown[] }[] };
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
 * through the same actions the UI uses (window.__daw.actions). The mix
 * settings go on every track there is, so Audio tracks added before get them
 * too.
 */
async function buildSpec6(page: Page) {
  const setup = await page.evaluate(async () => {
    const { engine, actions: a, project } = (window as unknown as DawWindow).__daw!;
    // Drum sample: 0.1 s of a decaying sine (id 0, shared by every row).
    const n = Math.round(engine!.sampleRate * 0.1);
    const ch = new Float32Array(n).map((_, i) => Math.sin(i * 0.05) * (1 - i / n));
    if ((await engine!.loadSample(0, [ch])) !== 0) return { ok: false, why: 'sample' };
    // Drum tracks: the default one is the first; add three more, 8 rows each.
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
  return { synths: setup.synths!, drums: setup.drums! };
}

/**
 * Plays (from the stopped transport) for a 2.5 s warm-up, then 10 s while
 * sampling the audio-thread CPU share, the master peak, the keyed comp's gain
 * reduction (strip `scSlot`) and the meter peaks of the `watch` strips.
 * Budget: CPU share < 0.6, blocks >= 95% of real time, no new dropouts or
 * engine errors.
 */
async function playAndMeasure(page: Page, label: string, scSlot: number, watch: number[] = []) {
  const drop0 = await page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.dropouts());
  const err0 = await slot(page, 7)();
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(1);
  await page.waitForTimeout(2500); // warm-up (telemetry CPU is written once a second)
  // 10 s: sample the CPU share, the peak and the first comp's gain reduction.
  const run = await page.evaluate(
    ({ scSlot, watch }) =>
      new Promise<{ cpu: number[]; peak: number; gr: number; share: number; strips: number[] }>((resolve) => {
        const eng = (window as unknown as DawWindow).__daw!.engine!;
        const cpu: number[] = [];
        const strips = watch.map(() => 0);
        let peak = 0;
        let gr = 0;
        const b0 = eng.telemetry()[0];
        const t0 = performance.now();
        const id = setInterval(() => {
          const t = eng.telemetry();
          const m = eng.meters();
          cpu.push(t[3]);
          peak = Math.max(peak, t[5], t[6]);
          gr = Math.max(gr, m[scSlot * 3 + 2]); // the keyed comp's gain reduction
          watch.forEach((s, i) => (strips[i] = Math.max(strips[i], m[s * 3], m[s * 3 + 1])));
          if (performance.now() - t0 >= 10_000) {
            clearInterval(id);
            const secs = (performance.now() - t0) / 1000;
            resolve({ cpu, peak, gr, share: ((t[0] - b0) * 128) / eng.sampleRate / secs, strips });
          }
        }, 250);
      }),
    { scSlot, watch },
  );
  const mean = run.cpu.reduce((x, y) => x + y, 0) / run.cpu.length;
  const max = Math.max(...run.cpu);
  console.log(`PERF ${label}: cpu mean=${(mean * 100).toFixed(1)}% max=${(max * 100).toFixed(1)}% blocks=${(run.share * 100).toFixed(1)}% of real time`);
  expect(run.peak).toBeGreaterThan(0.01); // it sounds
  expect(run.gr).toBeGreaterThan(1); // the sidechain ducks
  expect(max).toBeGreaterThan(0);
  expect(max).toBeLessThan(0.6);
  expect(run.share).toBeGreaterThanOrEqual(0.95);
  expect(await page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.dropouts())).toBe(drop0);
  expect(await slot(page, 7)()).toBe(err0);
  return run;
}

/** Plays 10 s of the spec 6 mix (Pattern mode). */
test('spec 6 mix stays under the browser CPU budget', async ({ page }) => {
  test.setTimeout(60_000);
  await startAudio(page);
  const { synths } = await buildSpec6(page);
  await playAndMeasure(page, 'spec6 browser', synths[0]);
});

/**
 * Drop a `secs` long stereo WAV (two sines, built in the page: no 20 MB
 * argument from Node) below the lanes at tick 0, as from Finder: a new Audio
 * track with one clip the file's length. Returns the track's slot.
 */
async function dropLongAudio(page: Page, name: string, secs: number, freq: number) {
  const v = JSON.parse((await page.getByTestId('timeline').getAttribute('data-view'))!) as { ticksPerPx: number; scrollTick: number };
  const x = (await page.getByTestId('tl-lane-0').boundingBox())!.x - v.scrollTick / v.ticksPerPx;
  const below = (await page.getByTestId('tl-below').boundingBox())!;
  const count = () => page.evaluate(() => (window as unknown as DawWindow).__daw!.project.tracks.filter((t) => t.kind === 'audio').length);
  const before = await count();
  await page.evaluate(
    ({ name, secs, freq, x, y }) => {
      const sr = 48000;
      const n = sr * secs;
      const buf = new ArrayBuffer(44 + n * 4);
      const v = new DataView(buf);
      const str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
      str(0, 'RIFF');
      v.setUint32(4, 36 + n * 4, true);
      str(8, 'WAVEfmt ');
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); // PCM
      v.setUint16(22, 2, true); // stereo
      v.setUint32(24, sr, true);
      v.setUint32(28, sr * 4, true);
      v.setUint16(32, 4, true);
      v.setUint16(34, 16, true);
      str(36, 'data');
      v.setUint32(40, n * 4, true);
      const pcm = new Int16Array(buf, 44);
      for (let i = 0; i < n; i++) {
        pcm[2 * i] = Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 0.5 * 32767);
        pcm[2 * i + 1] = Math.round(Math.sin((2 * Math.PI * freq * 1.5 * i) / sr) * 0.5 * 32767);
      }
      const el = document.querySelector('[data-testid="tl-below"]')!;
      const dt = new DataTransfer();
      dt.items.add(new File([buf], `${name}.wav`, { type: 'audio/wav' }));
      for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    },
    { name, secs, freq, x, y: below.y + Math.min(below.height / 2, 14) },
  );
  await expect.poll(count, { timeout: 20_000 }).toBe(before + 1);
  const t = await page.evaluate(() => {
    const a = (window as unknown as DawWindow).__daw!.project.tracks.filter((t) => t.kind === 'audio').at(-1)!;
    return { slot: a.slot, clips: a.clips!.length };
  });
  expect(t.clips).toBe(1);
  return t.slot;
}

/**
 * Spec §6 plus 4 stereo Audio tracks, each one 2-minute clip from tick 0
 * (addendum §4: the serial perf scenario gains Audio tracks with long clips),
 * in Song mode: the drum and synth patterns are laid out as clips over 16
 * bars so everything plays at once. Same budget as spec 6.
 */
test('spec 6 mix plus 4 audio tracks with long clips stays under the browser CPU budget', async ({ page }) => {
  test.setTimeout(120_000);
  await startAudio(page);
  await expect(page.getByTestId('tl-lane-0')).toBeVisible();
  // The Audio tracks first, while the lanes still fit (tl-below in view).
  const audio: number[] = [];
  for (const [i, f] of [110, 165, 220, 330].entries()) audio.push(await dropLongAudio(page, `stem-${i}`, 120, f));
  const mb = await page.evaluate(() => ((window as unknown as DawWindow).__daw!.project.arenaFloats * 4) / 2 ** 20);
  console.log(`PERF audio stems: ${mb.toFixed(0)} MB of sample memory`);
  expect(mb).toBeGreaterThan(4 * 2 * 120 * 44100 * 4 / 2 ** 20 - 1); // 4 stereo 2-minute files, at least at 44.1 kHz
  await expect(page.getByTestId('banner')).toBeHidden();

  const { synths } = await buildSpec6(page);
  const laid = await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as DawWindow).__daw!;
    let n = 0;
    for (const t of project.tracks.filter((t) => t.kind !== 'audio')) {
      for (let start = 0; start < 16 * 3840; ) {
        const c = a.addClip(t.id, { start });
        if (!c) return -1;
        start += c.len;
        n++;
      }
    }
    return n;
  });
  expect(laid).toBeGreaterThan(0);
  await page.keyboard.press('Shift+L');
  await expect.poll(() => page.evaluate(() => (window as unknown as DawWindow).__daw!.project.mode)).toBe('song');
  const run = await playAndMeasure(page, 'spec6 + 4 audio tracks browser', synths[0], audio);
  // Every stem was heard (the strips' meters, after the -6 dB fader).
  for (const p of run.strips) expect(p).toBeGreaterThan(0.05);
  await page.keyboard.press('Space');
});

/**
 * Spec §6 plus the 4 Audio tracks plus 64 automation lanes (plan 10 Task 5;
 * the native perf test's mix): 32 apply (a fader ride on every track, pan on
 * the synths, and four rack params on each synth, zig-zagging every 1/16 over
 * 16 bars: 257 points each) and 32 are disabled (both sends on every track,
 * the EQ mid gain on the drums and synths). Song mode, same engine budget.
 *
 * The UI is measured too, with every track's lanes open in the timeline
 * (most of the 64 lane canvases are scrolled out of view) and the mixer open
 * (its faders and knobs follow their lanes, ui/autoBus.ts): the frame
 * intervals while playing, and what a timeline scroll costs (every lane
 * canvas redraws on a view change).
 */
test('spec 6 mix plus audio tracks and 64 automation lanes stays under the browser CPU budget', async ({ page }) => {
  test.setTimeout(180_000);
  await startAudio(page);
  await expect(page.getByTestId('tl-lane-0')).toBeVisible();
  const audio: number[] = [];
  for (const [i, f] of [110, 165, 220, 330].entries()) audio.push(await dropLongAudio(page, `stem-${i}`, 120, f));
  const { synths } = await buildSpec6(page);
  const built = await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as DawWindow).__daw!;
    let clips = 0;
    for (const t of project.tracks.filter((t) => t.kind !== 'audio')) {
      for (let start = 0; start < 16 * 3840; ) {
        const c = a.addClip(t.id, { start });
        if (!c) return { error: 'clip' };
        start += c.len;
        clips++;
      }
    }
    /** A zig-zag between lo and hi, a corner every 1/16 over 16 bars (257 points, none thinned away). */
    const zig = (lo: number, hi: number) => Array.from({ length: 257 }, (_, i) => ({ tick: i * 240, value: i % 2 ? hi : lo }));
    const lane = (owner: string, target: object, lo: number, hi: number, on: boolean) => {
      const id = a.addLane(owner, target);
      if (!id || !a.drawLane(id, zig(lo, hi))) return false;
      return on || a.setLaneEnabled(id, false);
    };
    const mix = (param: string) => ({ kind: 'mix', param });
    const rack = (module: number, param: string) => ({ kind: 'rack', module, param });
    let applying = 0;
    let disabled = 0;
    for (const t of project.tracks) {
      if (!lane(t.id, mix('fader'), -9, -3, true)) return { error: `fader ${t.kind}` };
      applying++;
      for (const s of ['send_a', 'send_b']) {
        if (!lane(t.id, mix(s), -24, -12, false)) return { error: `${s} ${t.kind}` };
        disabled++;
      }
      if (t.kind !== 'audio') {
        if (!lane(t.id, mix('eq_mid_gain'), -6, 0, false)) return { error: 'eq' };
        disabled++;
      }
      if (t.kind === 'synth') {
        if (!lane(t.id, mix('pan'), -0.5, 0.5, true)) return { error: 'pan' };
        // Chord Stab: Filter (2) cutoff and reso, ADSR (3) decay, Out (5) level.
        for (const [m, p, lo, hi] of [[2, 'cutoff', 300, 3000], [2, 'reso', 0.1, 0.5], [3, 'decay', 0.1, 0.3], [5, 'level', 0.3, 0.4]] as const) {
          if (!lane(t.id, rack(m, p), lo, hi, true)) return { error: `${p}` };
        }
        applying += 5;
      }
    }
    return { clips, applying, disabled };
  });
  expect(built).toEqual({ clips: expect.any(Number), applying: 32, disabled: 32 });
  expect(await page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.failure)).toBeNull();
  await page.keyboard.press('Shift+L');
  await expect.poll(() => page.evaluate(() => (window as unknown as DawWindow).__daw!.project.mode)).toBe('song');

  /** What a timeline scroll costs: 20 wheel steps, each until the next frame has run (ms per step). */
  const scrollCost = async (label: string) => {
    const r = await page.evaluate(async () => {
      const el = document.querySelector('[data-testid="tl-canvas"]')!;
      const b = el.getBoundingClientRect();
      const t: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        el.dispatchEvent(new WheelEvent('wheel', { deltaX: i % 2 ? -40 : 40, bubbles: true, cancelable: true, clientX: b.x + 100, clientY: b.y + 10 }));
        await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
        t.push(performance.now() - t0);
      }
      t.sort((a, b) => a - b);
      return { p50: t[10], max: t[19] };
    });
    console.log(`PERF timeline scroll, ${label}: p50 ${r.p50.toFixed(1)} ms, max ${r.max.toFixed(1)} ms per step`);
    return r;
  };
  await page.getByTestId('mixer-tab').click();
  const closed = await scrollCost('lanes closed');

  // Every track's lanes open (A), and the mixer.
  for (const t of await page.evaluate(() => (window as unknown as DawWindow).__daw!.project.tracks.map((t) => t.slot))) {
    await page.getByTestId(`track-auto-${t}`).click();
  }
  await expect(page.locator('[data-testid^="auto-lane-"]')).toHaveCount(64);
  await expect(page.locator('[data-auto="on"]').first()).toBeVisible();
  const canvases = await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="timeline"] .scroll')!.getBoundingClientRect();
    const cvs = [...document.querySelectorAll('[data-testid^="auto-lane-"] canvas')] as HTMLCanvasElement[];
    const shown = cvs.filter((c) => {
      const r = c.getBoundingClientRect();
      return r.bottom > scroll.top && r.top < scroll.bottom;
    }).length;
    return { n: cvs.length, shown, mpx: cvs.reduce((s, c) => s + c.width * c.height, 0) / 1e6 };
  });
  console.log(`PERF lane canvases: ${canvases.n} (${canvases.shown} in view), ${canvases.mpx.toFixed(1)} Mpx backing`);
  // Only the lanes in (or near) view draw and keep a canvas backing store (AutoLane: data-shown).
  const drawn = await page.locator('[data-testid^="auto-lane-"][data-shown="1"]').count();
  expect(drawn).toBeGreaterThanOrEqual(canvases.shown);
  expect(drawn).toBeLessThanOrEqual(canvases.shown + 12); // + the margin rows above and below
  const open = await scrollCost('64 lanes open');
  expect(open.p50).toBeLessThan(closed.p50 + 25); // a scroll stays about a frame

  // The UI's frames while the engine is measured: rAF intervals and long tasks.
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __long: number[]; __stop: boolean };
    w.__frames = [];
    w.__long = [];
    w.__stop = false;
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ type: 'longtask' });
    let last = performance.now();
    const step = (now: number) => {
      w.__frames.push(now - last);
      last = now;
      if (!w.__stop) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const run = await playAndMeasure(page, 'spec6 + 4 audio tracks + 64 lanes browser', synths[0], audio);
  for (const p of run.strips) expect(p).toBeGreaterThan(0.05);
  const ui = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __long: number[]; __stop: boolean };
    w.__stop = true;
    const f = w.__frames.slice(5).sort((a, b) => a - b);
    const q = (x: number) => f[Math.min(f.length - 1, Math.floor(x * f.length))];
    return { n: f.length, p50: q(0.5), p95: q(0.95), max: f[f.length - 1], slow: f.filter((x) => x > 50).length, long: w.__long.length, longMax: Math.max(0, ...w.__long) };
  });
  console.log(`PERF UI while playing: ${ui.n} frames, p50 ${ui.p50.toFixed(1)} ms, p95 ${ui.p95.toFixed(1)} ms, max ${ui.max.toFixed(1)} ms, ${ui.slow} over 50 ms; ${ui.long} long tasks (max ${ui.longMax.toFixed(0)} ms)`);
  await scrollCost('64 lanes open, playing');
  await page.keyboard.press('Space');

  // A lane that was out of view while the view moved draws at the new view once scrolled in.
  const last = page.locator('[data-testid^="auto-lane-"]').last();
  await expect(last).toHaveAttribute('data-shown', '0');
  await last.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(last).toHaveAttribute('data-shown', '1');
  const ink = await last.evaluate((el) => {
    // The lane's curve at the left edge of the view: some opaque pixels in the leftmost 4 columns.
    const c = el.querySelector('canvas')!;
    const d = c.getContext('2d')!.getImageData(0, 0, 4, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return { n, w: c.width };
  });
  expect(ink.w).toBeGreaterThan(0);
  expect(ink.n).toBeGreaterThan(0);
});

/**
 * Plan 11: four house tracks (Strings, Piano Stab, Reese Bass, Sax), each
 * playing a one-bar 16-note pattern with the transport running. Strings and
 * Piano Stab are poly (overlapping notes and release tails); Reese and Sax
 * are mono. Same budget as the other perf cases: CPU share < 0.6, audible,
 * no new dropouts or engine errors.
 */
test('four house tracks stay under budget', async ({ page }) => {
  await startAudio(page);
  const ok = await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as DawWindow).__daw!;
    ['Strings', 'Piano Stab', 'Reese Bass', 'Sax'].forEach((n) => a.addSynthTrack(n));
    const synths = project.tracks.filter((t) => t.kind === 'synth');
    synths.forEach((t, k) => {
      const base = [60, 48, 36, 67][k];
      for (let i = 0; i < 16; i++) {
        const pitch = base + [0, 3, 7, 10][(i + k) % 4] + (i % 8 === 7 ? 2 : 0);
        a.addNote(t.id, { pitch, start: i * 240, len: [960, 180, 200, 220][k], vel: 100 });
      }
    });
    return synths.length === 4;
  });
  expect(ok).toBe(true);
  const drop0 = await page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.dropouts());
  const err0 = await slot(page, 7)();
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(1);
  await page.waitForTimeout(2500); // warm-up (telemetry CPU is written once a second)
  const run = await page.evaluate(
    () =>
      new Promise<{ cpu: number[]; peak: number }>((resolve) => {
        const eng = (window as unknown as DawWindow).__daw!.engine!;
        const cpu: number[] = [];
        let peak = 0;
        const t0 = performance.now();
        const id = setInterval(() => {
          const t = eng.telemetry();
          cpu.push(t[3]);
          peak = Math.max(peak, t[5], t[6]);
          if (performance.now() - t0 > 6000) {
            clearInterval(id);
            resolve({ cpu, peak });
          }
        }, 100);
      }),
  );
  const cpuMax = Math.max(...run.cpu);
  const cpuMean = run.cpu.reduce((a, b) => a + b, 0) / run.cpu.length;
  console.log(`PERF four house tracks: cpu mean=${(cpuMean * 100).toFixed(1)}% max=${(cpuMax * 100).toFixed(1)}% peak=${run.peak.toFixed(2)}`);
  expect(cpuMax).toBeGreaterThan(0);
  expect(cpuMax).toBeLessThan(0.6);
  expect(run.peak).toBeGreaterThan(0.01); // audible
  expect(await slot(page, 7)()).toBe(err0);
  expect(await page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.dropouts())).toBe(drop0);
});
