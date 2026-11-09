import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';
import { addTrack } from './addTrack';
import { startApp } from './startApp';
import { HOUSE_PATCHES } from './builtinPatches';

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
      send(op: number, a?: number, b?: number, c?: number, d?: number): boolean;
      failure: string | null;
      sampleRate: number;
    } | null;
    Op: Record<string, number>;
    project: { arenaFloats: number; mode: string; tracks: { id: string; slot: number; patchName?: string; kind: string; rows?: { id: string }[]; clips?: unknown[] }[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actions: Record<string, (...args: any[]) => any>;
  };
};

async function startAudio(page: Page) {
  await page.goto('/');
  await startApp(page);
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

/**
 * Starts a transport by its button (plan 20): the pattern transport (Play in
 * the bottom panel's header; a drum or synth track must be selected) or the
 * song transport (the top bar's Play). Waits until the engine plays.
 */
async function start(page: Page, mode: 'pattern' | 'song') {
  await page.getByTestId(mode === 'pattern' ? 'pattern-play' : 'play').click();
  await expect.poll(slot(page, 1)).toBe(1);
}

/** Stops whichever transport runs, by its button. */
async function stop(page: Page) {
  const mode = await page.evaluate(() => (window as unknown as { __daw: { project: { mode: string } } }).__daw.project.mode);
  await page.getByTestId(mode === 'song' ? 'play' : 'pattern-stop').click();
  await expect.poll(slot(page, 1)).toBe(0);
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
  await addTrack(page, 'synth');
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
      // From 62, not 60: the first 16th (start 0) must not repeat the chord's
      // top voice (60 + k at 0), which addNote refuses as a duplicate.
      for (let i = 0; i < 16; i++) a.addNote(t.id, { pitch: 62 + ((i * 5 + k) % 24), start: i * 240, len: 120, vel: 100 });
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
async function playAndMeasure(page: Page, label: string, scSlot: number, mode: 'pattern' | 'song', watch: number[] = []) {
  const drop0 = await page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.dropouts());
  const err0 = await slot(page, 7)();
  await start(page, mode);
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

/** Plays 10 s of the spec 6 mix (the song: 16 bars of clips on every track). */
test('spec 6 mix stays under the browser CPU budget', async ({ page }) => {
  test.setTimeout(60_000);
  await startAudio(page);
  const { synths } = await buildSpec6(page);
  // The whole mix at once: the song transport over clips (the pattern
  // transport plays only the shown track since plan 20 task 12).
  const laid = await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as DawWindow).__daw!;
    for (const t of project.tracks) {
      for (let start = 0; start < 16 * 3840; ) {
        const c = a.addClip(t.id, { start });
        if (!c) return false;
        start += c.len;
      }
    }
    return true;
  });
  expect(laid).toBe(true);
  await playAndMeasure(page, 'spec6 browser', synths[0], 'song');
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
  const run = await playAndMeasure(page, 'spec6 + 4 audio tracks browser', synths[0], 'song', audio);
  // Every stem was heard (the strips' meters, after the -6 dB fader).
  for (const p of run.strips) expect(p).toBeGreaterThan(0.05);
  await stop(page);
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
  // Song mode (as the PAT/SONG switch did before plan 20): song Play, then Stop.
  await start(page, 'song');
  await stop(page);

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
  const run = await playAndMeasure(page, 'spec6 + 4 audio tracks + 64 lanes browser', synths[0], 'song', audio);
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
  await stop(page);

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
  await start(page, 'pattern'); // the patterns loop (no clips); the last synth is selected
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

// ---- Plan 12: visuals --------------------------------------------------------

type VisWindow = {
  __daw: {
    engine: { dropouts(): number; failure: string | null; telemetry(): Float64Array; sampleRate: number };
    project: { selectedTrackId: string | null; tracks: { id: string; slot: number; kind: string }[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actions: Record<string, (...args: any[]) => any>;
    vis: {
      stats(): { busyMs: number; wallMs: number; frames: number };
      drawn(): number;
      running(): boolean;
      scopeHead(track: number, idx: number): number;
    };
  };
};

/** Nothing focused: Space is the transport again, not a click on the focused button. */
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

async function addRackModule(page: Page, id: string) {
  await page.getByRole('button', { name: '+ Add module' }).click();
  await page.getByTestId(`add-${id}`).click();
  await expect(page.getByTestId('add-menu')).toBeHidden();
}

/** A cable by keyboard patching (Enter on one jack, Enter on the other). */
async function patch(page: Page, from: string, to: string) {
  await page.getByTestId(from).focus();
  await page.keyboard.press('Enter');
  await page.getByTestId(to).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="cables"] path.drag')).toHaveCount(0);
}

/**
 * Plan 12 (Review Focus 1 and 2 in the browser): a Scope added, cabled to A
 * and B, every param changed (choices included), unplugged and removed while
 * the rack sounds. Scope edits apply at once without a declick and never
 * touch the sound; here: no dropouts, no engine error, and the scope ran.
 * Serial because a dropout count only means something on an idle CPU.
 */
test('scope edits while playing cause no dropouts', async ({ page }) => {
  await startAudio(page);
  await addTrack(page, 'synth');
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByTestId('rack')).toBeVisible();
  const track = await page.evaluate(() => {
    const { project, actions } = (window as unknown as VisWindow).__daw;
    const t = project.tracks.find((x) => x.id === project.selectedTrackId)!;
    for (let i = 0; i < 16; i++) actions.addNote(t.id, { pitch: 36 + (i % 4) * 3, start: i * 240, len: 200, vel: 110 });
    return t.slot;
  });
  const drop0 = await page.evaluate(() => (window as unknown as VisWindow).__daw.engine.dropouts());
  const err0 = await slot(page, 7)();
  await start(page, 'pattern');
  await addRackModule(page, 'scope'); // Deep Bass has 8 modules: the Scope is 8
  await patch(page, 'jack-1-out-out', 'jack-8-in-a');
  await patch(page, 'jack-5-out-env', 'jack-8-in-b');
  await page.getByTestId('scope-8').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate((s) => (window as unknown as VisWindow).__daw.vis.scopeHead(s, 8), track)).toBeGreaterThan(0);
  for (const k of ['time', 'gain_a', 'gain_b']) {
    await page.getByTestId(`knob-8-${k}`).focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
  }
  for (const [k, choice] of [['trig', 'Free'], ['sync', 'Sync'], ['division', '1 bar'], ['mode', 'XY'], ['mode', 'A+B']]) {
    // Division has 8 choices: a select (spec §3); the rest are seg rows.
    if (k === 'division') await page.getByTestId(`knob-8-${k}`).selectOption({ label: choice });
    else await page.getByTestId(`knob-8-${k}`).getByRole('radio', { name: choice, exact: true }).click();
  }
  // The readout is written when the canvas redraws, which it does only on
  // screen: the card is taller than the rail with its sliders, so the last
  // controls scrolled the screen out of view.
  await page.getByTestId('scope-8').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('scope-8')).toHaveAttribute('data-readout', '1 bar · sync');
  // Unplug A (pick it up from the input, drop it with Delete), then remove the module.
  await page.getByTestId('jack-8-in-a').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  await page.getByTestId('module-8').getByRole('button', { name: 'Remove Scope' }).click();
  await expect(page.getByTestId('module-8')).toHaveCount(0);
  await page.waitForTimeout(500);
  await stop(page);
  expect(await page.evaluate(() => (window as unknown as VisWindow).__daw.engine.dropouts())).toBe(drop0);
  expect(await slot(page, 7)()).toBe(err0);
  expect(await page.evaluate(() => (window as unknown as VisWindow).__daw.engine.failure)).toBeNull();
});

/**
 * Plan 12 Review Focus 3: the visuals' main-thread cost, measured by the
 * frame loop itself (window.__daw.vis.stats(): time inside the consumers /
 * the time the loop ran, last 5 s), while the spec-6 mix plus one Audio
 * track plays in Song mode. One 8 s phase per surface, each with the top
 * bar's master spectrum on as always:
 *   top bar     the Step grid (no other visual on screen);
 *   mixer       every strip meter and the analyser on the Master (spectrum,
 *               goniometer, correlation);
 *   instrument  a Chord Stab rack: voice LEDs and the ADSR preview;
 *   scopes      8 scopes on one track, all on screen (a wide window), each
 *               cabled to the oscillator;
 *   clip tab    the waveform at 1000 frames/px with the playhead moving.
 * Each must stay under 5 %, with no new dropouts and the engine inside the
 * spec-6 budget (CPU < 60 %, blocks >= 95 % of real time). Stopped and idle
 * (before anything plays, and after Stop once the master is digital silence
 * again: the returns' tails take ~16 s) the loop pauses: the visuals cost
 * nothing.
 */
test('visuals stay under 5% of the main thread', async ({ page }) => {
  test.setTimeout(300_000);
  await startAudio(page);
  await expect(page.getByTestId('tl-lane-0')).toBeVisible();
  // The app open and idle (nothing played yet): the loop pauses within a second or so.
  await expect.poll(() => page.evaluate(() => (window as unknown as VisWindow).__daw.vis.running()), { timeout: 3000, intervals: [100] }).toBe(false);
  const stem = await dropLongAudio(page, 'stem', 60, 110);
  const { synths, drums } = await buildSpec6(page);
  // 64 bars of clips (well past the phases), then Song mode.
  const laid = await page.evaluate(() => {
    const { actions: a, project } = (window as unknown as DawWindow).__daw!;
    let n = 0;
    for (const t of project.tracks.filter((t) => t.kind !== 'audio')) {
      for (let start = 0; start < 64 * 3840; ) {
        const c = a.addClip(t.id, { start });
        if (!c) return -1;
        start += c.len;
        n++;
      }
    }
    return n;
  });
  expect(laid).toBeGreaterThan(0);
  // 8 scopes on the first synth track, each fed by its oscillator (Chord Stab: Osc 1; Scopes 6..13).
  await page.getByTestId(`track-${synths[0]}`).click();
  await page.keyboard.press('Alt+4');
  await expect(page.getByTestId('rack')).toBeVisible();
  for (let i = 0; i < 8; i++) {
    await addRackModule(page, 'scope');
    await patch(page, 'jack-1-out-out', `jack-${6 + i}-in-a`);
  }
  await expect(page.locator('[data-testid^="scope-"]')).toHaveCount(8);

  /** One phase: `ms` of playing, then the frame loop's share and the engine's budget. */
  const phase = async (label: string, ms = 8000) => {
    const drop0 = await page.evaluate(() => (window as unknown as VisWindow).__daw.engine.dropouts());
    const err0 = await slot(page, 7)();
    const run = await page.evaluate(
      (ms) =>
        new Promise<{ cpu: number[]; share: number }>((resolve) => {
          const eng = (window as unknown as VisWindow).__daw.engine;
          const cpu: number[] = [];
          const b0 = eng.telemetry()[0];
          const t0 = performance.now();
          const id = setInterval(() => {
            cpu.push(eng.telemetry()[3]);
            if (performance.now() - t0 >= ms) {
              clearInterval(id);
              const secs = (performance.now() - t0) / 1000;
              resolve({ cpu, share: ((eng.telemetry()[0] - b0) * 128) / eng.sampleRate / secs });
            }
          }, 250);
        }),
      ms,
    );
    const s = await page.evaluate(() => (window as unknown as VisWindow).__daw.vis.stats());
    const share = s.busyMs / s.wallMs;
    const cpuMax = Math.max(...run.cpu);
    console.log(
      `VIS ${label}: main thread ${(share * 100).toFixed(2)}% (${s.busyMs.toFixed(1)} ms in ${s.frames} frames over ${(s.wallMs / 1000).toFixed(1)} s, ` +
        `${(s.busyMs / Math.max(1, s.frames)).toFixed(3)} ms/frame); engine cpu max ${(cpuMax * 100).toFixed(1)}%, blocks ${(run.share * 100).toFixed(1)}%`,
    );
    expect(s.frames).toBeGreaterThan(100); // the loop really ran (~300 frames in 5 s)
    expect(share).toBeLessThan(0.05);
    expect(cpuMax).toBeLessThan(0.6);
    expect(run.share).toBeGreaterThanOrEqual(0.95);
    expect(await page.evaluate(() => (window as unknown as VisWindow).__daw.engine.dropouts())).toBe(drop0);
    expect(await slot(page, 7)()).toBe(err0);
  };
  const seek0 = () => page.evaluate(() => (window as unknown as VisWindow).__daw.actions.seek(0));

  await blur(page); // Space on a focused jack would pick it up
  await start(page, 'song'); // (the rack was used last: Space would start the pattern transport)
  expect(await page.evaluate(() => (window as unknown as DawWindow).__daw!.project.mode)).toBe('song');
  await page.waitForTimeout(2000); // warm-up

  // Top bar only.
  await page.getByTestId(`track-${drums[0]}`).click();
  await page.keyboard.press('Alt+1');
  await expect(page.getByTestId('row-0')).toBeVisible();
  await expect(page.getByTestId('topbar-spectrum')).toBeVisible();
  await phase('top bar');

  // The mixer: every meter, the analyser on the Master.
  await page.getByTestId('mixer-tab').click();
  await expect(page.getByTestId('analyser')).toHaveAttribute('data-source', 'master');
  await expect(page.getByTestId('analyser')).toBeVisible();
  await phase('mixer + analyser (Master)');

  // The Instrument tab without scopes: voice LEDs, the ADSR preview.
  await page.getByTestId(`track-${synths[1]}`).click();
  await page.keyboard.press('Alt+4');
  await expect(page.getByTestId('voice-leds')).toBeVisible();
  await expect(page.getByTestId('shape-adsr')).toBeVisible();
  await phase('instrument: voice LEDs + ADSR preview');

  // 8 scopes, all on screen.
  await page.setViewportSize({ width: 3400, height: 900 });
  await page.getByTestId(`track-${synths[0]}`).click();
  await page.keyboard.press('Alt+4');
  await page.getByTestId('scope-6').scrollIntoViewIfNeeded();
  const onScreen = await page.evaluate(() => {
    const rail = document.querySelector('[data-testid="rail"]')!.getBoundingClientRect();
    return [...document.querySelectorAll('[data-testid^="scope-"]')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.right > rail.left && r.left < rail.right && r.bottom > 0 && r.top < innerHeight;
    }).length;
  });
  console.log(`VIS scopes on screen: ${onScreen} of 8`);
  expect(onScreen).toBe(8);
  await expect.poll(() => page.evaluate((s) => (window as unknown as VisWindow).__daw.vis.scopeHead(s, 13), synths[0])).toBeGreaterThan(0);
  await phase('instrument: 8 scopes + LEDs + ADSR preview');
  await page.setViewportSize({ width: 1280, height: 720 });

  // The Clip tab: the stem's waveform at 1000 frames/px from its start, the playhead running through it.
  await page.getByTestId(`track-${stem}`).click();
  await page.keyboard.press('Alt+6');
  const wave = page.getByTestId('cliptab-wave');
  await expect(wave).toBeVisible();
  const fpp = async () => Number(await wave.locator('canvas').getAttribute('data-fpp'));
  await expect.poll(fpp).toBeGreaterThan(1000);
  for (let i = 0; i < 12 && Math.abs((await fpp()) - 1000) > 0.5; i++) {
    const f = await fpp();
    const d = Math.max(-69, Math.min(69, Math.log(1000 / f) / 0.01));
    // ⌘-wheel at the left edge: the view keeps starting at the clip's start.
    await wave.locator('canvas').evaluate((c, d) => {
      const b = c.getBoundingClientRect();
      c.dispatchEvent(new WheelEvent('wheel', { deltaY: d, metaKey: true, bubbles: true, cancelable: true, clientX: b.left, clientY: b.top + 10 }));
    }, d);
    await page.waitForTimeout(50);
  }
  expect(Math.abs((await fpp()) - 1000)).toBeLessThan(1);
  await seek0();
  const head = wave.locator('.ph');
  await expect(head).toBeVisible();
  const x0 = await head.evaluate((el) => (el as HTMLElement).style.transform);
  await expect.poll(() => head.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(x0);
  await phase('clip tab at 1000 frames/px, playhead moving');

  // Stopped and idle (top bar only): nothing moves, so the loop pauses.
  await page.getByTestId(`track-${drums[0]}`).click();
  await page.keyboard.press('Alt+1');
  await blur(page);
  await page.keyboard.press('Space');
  await expect.poll(slot(page, 1)).toBe(0);
  const tStop = Date.now();
  await expect.poll(() => page.evaluate(() => (window as unknown as VisWindow).__daw.vis.running()), { timeout: 12_000, intervals: [100] }).toBe(false);
  console.log(`VIS paused ${((Date.now() - tStop) / 1000).toFixed(1)} s after Stop`);
  const d0 = await page.evaluate(() => (window as unknown as VisWindow).__daw.vis.drawn());
  await page.waitForTimeout(2000);
  const d1 = await page.evaluate(() => (window as unknown as VisWindow).__daw.vis.drawn());
  console.log(`VIS idle (stopped, top bar): ${d1 - d0} frames drawn in 2 s`);
  expect(d1).toBe(d0);
});

// ---- moved from smoke.spec.ts / house.spec.ts (plan 16 Task 6): real-time
// assertions that flake when parallel workers compete for the CPU ----

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

async function addSynth(page: Page) {
  await addTrack(page, 'synth');
  await page.getByRole('button', { name: 'Instrument' }).click();
  await expect(page.getByTestId('patch-select')).toBeVisible();
}


/** Max peak (L, R) seen over `ms`, sampled every 4 ms. */
function peaks(page: Page, ms: number) {
  return page.evaluate(
    (ms) =>
      new Promise<[number, number]>((resolve) => {
        const eng = (window as unknown as DawWindow).__daw!.engine!;
        let l = 0;
        let r = 0;
        const t0 = performance.now();
        const id = setInterval(() => {
          const t = eng.telemetry();
          l = Math.max(l, t[5]);
          r = Math.max(r, t[6]);
          if (performance.now() - t0 > ms) {
            clearInterval(id);
            resolve([l, r]);
          }
        }, 4);
      }),
    ms,
  );
}

const status = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as DawWindow).__daw!.engine!;
    return { drop: e.dropouts(), err: e.telemetry()[7] };
  });

test('every house patch loads and sounds', async ({ page }) => {
  test.setTimeout(150_000);
  await startAudio(page);
  await addSynth(page);
  // Spelled out in builtinPatches.ts (app code is not importable here).
  const house = HOUSE_PATCHES;
  const before = await status(page);
  for (const p of house) {
    await page.getByTestId('patch-select').selectOption(p);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as DawWindow).__daw!.project.tracks[1].patchName))
      .toBe(p);
    // A chord (A, D, G = C4, E4, G4) works for mono patches too: last note wins.
    for (const k of ['KeyA', 'KeyD', 'KeyG']) await page.keyboard.down(k);
    const [l, r] = await peaks(page, 700);
    for (const k of ['KeyA', 'KeyD', 'KeyG']) await page.keyboard.up(k);
    expect(l, `${p} peak L`).toBeGreaterThan(0);
    expect(r, `${p} peak R`).toBeGreaterThan(0);
    // Let the release die out (the longest, Impact's, is 1.5 s) before
    // loading the next patch, so the load is not an edit while sounding and
    // the dropout check below does not measure queued-edit bursts.
    await expect
      .poll(async () => Math.max(...(await peaks(page, 100))), { timeout: 5_000, intervals: [50] })
      .toBeLessThan(1e-4);
  }
  const after = await status(page);
  expect(after.err).toBe(before.err);
  expect(after.drop).toBe(before.drop);
});
