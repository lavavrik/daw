import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './wav';
import { addTrack } from './addTrack';
import { startApp } from './startApp';

// Mixer view (plan 5, Task 4), driven through the UI. Meter values are read
// from the strip meters' data-peak-db (what the user sees, updated by the
// mixer's rAF loop) and, for the plumbing check, from engine.meters().

type DawWindow = {
  __daw?: {
    engine: { telemetry(): Float64Array; meters(): Float32Array } | null;
  };
};

async function startAudio(page: Page) {
  await page.goto('/');
  await startApp(page);
}

/** Dispatch a file drop onto the element with `testid` (see smoke.spec.ts). */
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

/** Kick sample on row 0 of the default drum track, four on the floor. */
async function fourOnTheFloor(page: Page) {
  await dropFile(page, 'row-0', 'kick.wav', 'audio/wav', [...makeWav(60, 120)]);
  await expect(page.getByTestId('row-0').getByTestId('row-name')).toHaveText('kick');
  for (const s of [0, 4, 8, 12]) await page.getByTestId(`step-0-${s}`).click();
}

const strip = (page: Page, id: string | number) => page.getByTestId(`strip-${id}`);

/** The strip meter's shown peak, dBFS (−Infinity when silent). */
async function meterDb(page: Page, id: string | number): Promise<number> {
  const v = await strip(page, id).getByTestId('meter').getAttribute('data-peak-db');
  return v === null || v === '-inf' ? -Infinity : Number(v);
}

/** Sample a strip meter's shown peak at every animation frame for `ms`; min/max in dB. */
function meterRange(page: Page, testid: string, ms: number) {
  return page.evaluate(
    ({ testid, ms }) =>
      new Promise<{ min: number; max: number; n: number }>((resolve) => {
        const el = document.querySelector(`[data-testid="${testid}"] [data-testid="meter"]`) as HTMLElement;
        let min = Infinity;
        let max = -Infinity;
        let n = 0;
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

async function openMixer(page: Page) {
  await page.getByTestId('mixer-tab').click();
  await expect(page.getByTestId('mixer')).toBeVisible();
}

/** Add a synth track (slot 1) and hold a note on it from the computer keyboard. */
async function synthHoldingNote(page: Page) {
  await addTrack(page, 'synth');
  await expect(page.getByTestId('track-1')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down('KeyA');
}

/**
 * The drums loop under the song transport (one long clip of their pattern),
 * so they play together with the synth's live note. The pattern transport
 * would play only the selected track, the synth (plan 20 task 12).
 */
async function drumsLoopInSong(page: Page) {
  await page.evaluate(() => {
    const d = (window as unknown as { __daw: { project: { tracks: { id: string }[] }; actions: { addClip(id: string, o: object): unknown } } }).__daw;
    d.actions.addClip(d.project.tracks[0].id, { start: 0, len: 64 * 3840 });
  });
  await page.getByTestId('play').click();
}

test('mixer shows strips for tracks + returns + master', async ({ page }) => {
  await startAudio(page);
  await addTrack(page, 'synth');
  await openMixer(page);
  const ids = await page.locator('[data-testid="mixer"] > [data-testid^="strip-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid')),
  );
  expect(ids).toEqual(['strip-0', 'strip-1', 'strip-reverb', 'strip-delay', 'strip-master']);
  await expect(strip(page, 0).getByTestId('strip-name')).toContainText('Drums');
  await expect(strip(page, 1).getByTestId('strip-name')).toContainText('Synth');
  await expect(strip(page, 'reverb').getByTestId('strip-name')).toContainText('Reverb');
  await expect(strip(page, 'delay').getByTestId('strip-name')).toContainText('Delay');
  await expect(strip(page, 'master').getByTestId('strip-name')).toContainText('Master');
  // Values are visible: fader readouts, sends labelled by return, SC source, limiter.
  await expect(strip(page, 0).getByTestId('fader-readout')).toHaveText('0.0 dB');
  // The Sends section folds (plan 29): closed it shows "0 of 2"; open, a knob per return named after it.
  await expect(strip(page, 1).getByTestId('sends-aside')).toHaveText('0 of 2');
  await expect(strip(page, 1).getByTestId('knob-send_a')).toHaveCount(0);
  await strip(page, 1).getByTestId('sends-expand').click();
  await expect(strip(page, 1).getByTestId('knob-send_a')).toContainText('Reverb');
  await expect(strip(page, 1).getByTestId('knob-send_a')).toContainText('Off');
  await expect(strip(page, 1).getByTestId('knob-send_b')).toContainText('Delay');
  await expect(strip(page, 1).getByTestId('knob-pan')).toContainText('C');
  await expect(strip(page, 1).getByTestId('sc-label')).toHaveText('SC: none');
  await expect(strip(page, 'master').getByTestId('knob-limiter_ceiling')).toContainText('−0.3 dB');
  await expect(strip(page, 'master').getByTestId('gr')).toHaveText('0.0 dB');
  // Returns have no solo; the master has neither mute nor solo.
  await expect(strip(page, 'reverb').getByTestId('solo')).toHaveCount(0);
  await expect(strip(page, 'master').getByTestId('mute')).toHaveCount(0);
  // EQ and Comp are collapsed, their on/off switch visible in the header.
  await expect(strip(page, 1).getByTestId('knob-eq_low')).toHaveCount(0);
  await expect(strip(page, 1).getByTestId('eq-on')).toHaveText('off');
  await strip(page, 1).getByTestId('eq-on').click();
  await expect(strip(page, 1).getByTestId('eq-on')).toHaveText('on');
  await strip(page, 1).getByTestId('eq-expand').click();
  await expect(strip(page, 1).getByTestId('knob-eq_low')).toContainText('0.0 dB');
  // Clicking a strip's name selects that track; the tab stays on the mixer.
  await strip(page, 0).getByTestId('strip-name').click();
  await expect(page.getByTestId('track-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mixer')).toBeVisible();
  await page.getByRole('button', { name: 'Step grid' }).click();
  await expect(page.getByTestId('mixer')).toBeHidden();
});

test('fader down lowers the track meter (meters plumbing end to end)', async ({ page }) => {
  await startAudio(page);
  await synthHoldingNote(page);
  await openMixer(page);
  // Plumbing: engine -> worklet -> shared meters -> engine.meters() -> strip meter.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as DawWindow).__daw!.engine!.meters()[1 * 3]), { timeout: 3_000 })
    .toBeGreaterThan(0.01); // > −40 dBFS
  await expect.poll(() => meterDb(page, 1), { timeout: 3_000 }).toBeGreaterThan(-40);
  await page.waitForTimeout(1_000); // the note's envelope settles to its sustain level
  const before = await meterRange(page, 'strip-1', 500);

  // Drag the fader down with the mouse.
  const fader = strip(page, 1).getByTestId('fader');
  const b = (await fader.boundingBox())!;
  const capY = b.y + b.height * 0.25; // 0 dB sits at 3/4 of the travel
  await page.mouse.move(b.x + b.width / 2, capY);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, capY + 30, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, capY + 45, { steps: 5 });
  await page.mouse.up();
  const readout = (await strip(page, 1).getByTestId('fader-readout').textContent())!;
  const db = Number(readout.replace('−', '-').replace(' dB', ''));
  expect(db).toBeLessThan(-12);
  await page.waitForTimeout(400); // 60 dB/s meter fall
  const after = await meterRange(page, 'strip-1', 500);
  expect(after.max).toBeLessThan(before.max - 10);
  // ...by about the fader move.
  expect(after.max).toBeGreaterThan(before.max + db - 3);
  expect(after.max).toBeLessThan(before.max + db + 3);

  // Double-click: back to 0 dB. Home: −∞ (the meter goes silent).
  await fader.dblclick();
  await expect(strip(page, 1).getByTestId('fader-readout')).toHaveText('0.0 dB');
  await fader.focus();
  await page.keyboard.press('Home');
  await expect(strip(page, 1).getByTestId('fader-readout')).toHaveText('−∞');
  await expect.poll(() => meterDb(page, 1), { timeout: 3_000 }).toBeLessThan(-90);
  await page.keyboard.press('ArrowUp');
  await expect(strip(page, 1).getByTestId('fader-readout')).toHaveText('−59.0 dB');
  await page.keyboard.up('KeyA');
});

test('solo isolates', async ({ page }) => {
  await startAudio(page);
  await fourOnTheFloor(page);
  await synthHoldingNote(page);
  await drumsLoopInSong(page);
  await openMixer(page);
  await expect.poll(async () => (await meterRange(page, 'strip-0', 600)).max, { timeout: 4_000 }).toBeGreaterThan(-30);
  await expect.poll(() => meterDb(page, 1), { timeout: 3_000 }).toBeGreaterThan(-40);

  await strip(page, 1).getByTestId('solo').click();
  await expect(strip(page, 1).getByTestId('solo')).toHaveAttribute('aria-pressed', 'true');
  // The drums go silent; the soloed synth and the master keep playing.
  // (The meter falls at 60 dB/s, so give it 1.7 s to drop past −90 dBFS.)
  await page.waitForTimeout(1_700);
  expect((await meterRange(page, 'strip-0', 1_000)).max).toBeLessThan(-90);
  expect(await meterDb(page, 1)).toBeGreaterThan(-40);
  expect(await meterDb(page, 'master')).toBeGreaterThan(-40);

  // Unsolo: the drums come back.
  await strip(page, 1).getByTestId('solo').click();
  await expect.poll(async () => (await meterRange(page, 'strip-0', 600)).max, { timeout: 4_000 }).toBeGreaterThan(-30);
  await page.keyboard.up('KeyA');
});

test('track header M and S mute / solo the track, in sync with the mixer strip', async ({ page }) => {
  await startAudio(page);
  await fourOnTheFloor(page);
  await synthHoldingNote(page);
  await drumsLoopInSong(page);
  await openMixer(page);
  await expect.poll(async () => (await meterRange(page, 'strip-0', 600)).max, { timeout: 4_000 }).toBeGreaterThan(-30);

  // M on the drum track's header: its strip shows muted and goes silent.
  await page.getByTestId('track-mute-0').click();
  await expect(page.getByTestId('track-mute-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(strip(page, 0).getByTestId('mute')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(1_700);
  expect((await meterRange(page, 'strip-0', 1_000)).max).toBeLessThan(-90);
  expect(await meterDb(page, 1)).toBeGreaterThan(-40);
  // The strip's M unmutes it, and the header follows.
  await strip(page, 0).getByTestId('mute').click();
  await expect(page.getByTestId('track-mute-0')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await meterRange(page, 'strip-0', 600)).max, { timeout: 4_000 }).toBeGreaterThan(-30);

  // S on the synth's header: only the synth plays.
  await page.getByTestId('track-solo-1').click();
  await expect(strip(page, 1).getByTestId('solo')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(1_700);
  expect((await meterRange(page, 'strip-0', 1_000)).max).toBeLessThan(-90);
  expect(await meterDb(page, 1)).toBeGreaterThan(-40);
  // Undo brings the drums back (one entry per click).
  await page.keyboard.press('Meta+z');
  await expect(page.getByTestId('track-solo-1')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await meterRange(page, 'strip-0', 600)).max, { timeout: 4_000 }).toBeGreaterThan(-30);
  await page.keyboard.up('KeyA');
});

test('track header S is exclusive: it unsolos the others; Shift-click adds to the solo', async ({ page }) => {
  // Owner's note (plan 20 task 12). Three tracks: drums (0), synth (1), synth (2).
  await startAudio(page);
  await addTrack(page, 'synth');
  await addTrack(page, 'synth');
  const solo = (slot: number) => page.getByTestId(`track-solo-${slot}`);
  const pressed = async () => Promise.all([0, 1, 2].map(async (s) => (await solo(s).getAttribute('aria-pressed')) === 'true'));
  await expect(solo(0)).toHaveAttribute('title', /Shift-click: add it to the soloed ones/);
  await solo(0).click();
  await solo(1).click({ modifiers: ['Shift'] }); // additive
  expect(await pressed()).toEqual([true, true, false]);
  // A plain click on an unsoloed track: only it stays soloed (the mixer strips follow).
  await solo(2).click();
  await expect(solo(2)).toHaveAttribute('aria-pressed', 'true');
  expect(await pressed()).toEqual([false, false, true]);
  await openMixer(page);
  await expect(strip(page, 0).getByTestId('solo')).toHaveAttribute('aria-pressed', 'false');
  await expect(strip(page, 2).getByTestId('solo')).toHaveAttribute('aria-pressed', 'true');
  // One undo entry brings both back.
  await page.keyboard.press('Meta+z');
  await expect(solo(0)).toHaveAttribute('aria-pressed', 'true');
  expect(await pressed()).toEqual([true, true, false]);
  // A plain click on a soloed track unsolos just that one.
  await solo(1).click();
  await expect(solo(1)).toHaveAttribute('aria-pressed', 'false');
  expect(await pressed()).toEqual([true, false, false]);
  // The mixer strip's S is exclusive too.
  await strip(page, 1).getByTestId('solo').click();
  await expect(solo(1)).toHaveAttribute('aria-pressed', 'true');
  expect(await pressed()).toEqual([false, true, false]);
});

test('sidechain from kick ducks the synth', async ({ page }) => {
  await startAudio(page);
  await fourOnTheFloor(page);
  await synthHoldingNote(page);
  await drumsLoopInSong(page);
  await openMixer(page);
  const synth = strip(page, 1);
  await expect.poll(() => meterDb(page, 1), { timeout: 3_000 }).toBeGreaterThan(-40);

  // Baseline: the held note alone reads steady (no pumping without a key),
  // once its envelope has settled (Deep Bass: decay 0.25 s to sustain).
  await page.waitForTimeout(1_000);
  const steady = await meterRange(page, 'strip-1', 1_000);
  expect(steady.max - steady.min).toBeLessThan(3);

  // Comp on, keyed from the kick row.
  await synth.getByTestId('comp-on').click();
  await expect(synth.getByTestId('comp-on')).toHaveAttribute('aria-pressed', 'true');
  await synth.getByTestId('comp-expand').click();
  await synth.getByTestId('sc-select').selectOption({ label: 'Drums · kick' });
  await expect(synth.getByTestId('sc-label')).toHaveText('SC: Drums · kick');
  await synth.getByTestId('sc-select').blur();

  // The synth meter pumps with the kick: >= 6 dB between ducked and released.
  await page.waitForTimeout(300);
  const pump = await meterRange(page, 'strip-1', 2_000);
  console.log(`MIXER sidechain pump: steady ${(steady.max - steady.min).toFixed(1)} dB, keyed ${(pump.max - pump.min).toFixed(1)} dB over ${pump.n} frames`);
  expect(pump.n).toBeGreaterThan(30);
  expect(pump.max - pump.min).toBeGreaterThanOrEqual(6);
  // The comp's GR readout shows the ducking too.
  await expect.poll(async () => Number(await synth.getByTestId('gr').getAttribute('data-gr-db')), { timeout: 3_000 }).toBeGreaterThan(3);

  // Collapsed, the Comp header still names the key and shows the ducking.
  await synth.getByTestId('comp-expand').click();
  await expect(synth.getByTestId('sc-label')).toHaveText('SC: Drums · kick');
  await expect(synth.getByTestId('knob-comp_threshold')).toHaveCount(0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/mixer.png' });
  await page.keyboard.up('KeyA');
});

test('timeline track headers switch the bottom panel from the mixer to that track\'s editor', async ({ page }) => {
  await startAudio(page);
  await addTrack(page, 'synth'); // slot 1, Piano roll
  await openMixer(page);
  // Inside the mixer, a strip name selects the track but keeps the mixer open.
  await strip(page, 1).getByTestId('strip-name').click();
  await expect(page.getByTestId('track-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mixer')).toBeVisible();
  // The timeline's track header leaves the mixer for that track's editor.
  await page.getByTestId('track-0').click();
  await expect(page.getByTestId('mixer')).toBeHidden();
  await expect(page.getByTestId('row-0')).toBeVisible(); // the drum track's Step grid
  // Same for a synth track: back to the remembered Piano roll tab.
  await openMixer(page);
  await page.getByTestId('track-1').click();
  await expect(page.getByTestId('mixer')).toBeHidden();
  await expect(page.getByTestId('pianoroll')).toBeVisible();
});

// The Delay return's division is a choice with 12 options, so a skinned
// <select> (ChoiceParam, plan 20 Task 9): a pick sends MIX_SET to the engine
// and is one undo entry; the select fits inside the strip.
test('delay division select: a pick reaches the engine, one undo entry, fits the strip', async ({ page }) => {
  type D = { __daw: { engine: { send: (...a: number[]) => boolean }; Op: Record<string, number>; history: { labels: { undo: string | null } } | null; project: { mixer: { delay: { params: number[] } } } }; __sent?: number[][] };
  await startAudio(page);
  await openMixer(page);
  const delay = strip(page, 'delay');
  await delay.getByTestId('fx-expand').click(); // the Delay section starts collapsed
  const sel = delay.getByTestId('knob-delay_time');
  await expect(sel).toBeVisible();
  expect(await sel.evaluate((e) => e.tagName)).toBe('SELECT');
  // Laid out inside the strip card, with room for its options' text.
  const sb = (await delay.boundingBox())!;
  const b = (await sel.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(sb.x - 0.5);
  expect(b.x + b.width).toBeLessThanOrEqual(sb.x + sb.width + 0.5);
  expect(await sel.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);

  // Record what reaches the engine.
  await page.evaluate(() => {
    const w = window as unknown as D;
    const e = w.__daw.engine;
    const send = e.send.bind(e);
    w.__sent = [];
    e.send = (...a: number[]) => (w.__sent!.push(a), send(...a));
  });
  const value = await sel.inputValue();
  const before = await page.evaluate(() => (window as unknown as D).__daw.history?.labels.undo ?? null);
  const pick = value === '3' ? '5' : '3';
  await sel.selectOption(pick);
  await expect
    .poll(() => page.evaluate((v) => {
      const w = window as unknown as D;
      return w.__sent!.some((a) => a[0] === w.__daw.Op.MIX_SET && a[3] === v);
    }, Number(pick)))
    .toBe(true);
  await expect(sel).toHaveValue(pick);
  await expect.poll(() => page.evaluate(() => (window as unknown as D).__daw.history?.labels.undo ?? null)).toMatch(/^Set /);

  // One undo entry: one Cmd/Ctrl+Z puts the old division back (and tells the engine).
  await sel.evaluate((e) => (e as HTMLElement).blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect(sel).toHaveValue(value);
  await expect
    .poll(() => page.evaluate((v) => {
      const w = window as unknown as D;
      const last = w.__sent!.filter((a) => a[0] === w.__daw.Op.MIX_SET).at(-1);
      return last?.[3];
    }, Number(value)))
    .toBe(Number(value));
  expect(await page.evaluate(() => (window as unknown as D).__daw.history?.labels.undo ?? null)).toBe(before);
});

// ChoiceParam's select (plan 20 Task 11): a pick with the pointer gives the
// keys back to the piano (blur, also after base-select's picker hands focus
// back on close); a pick from the keyboard keeps focus, so a keyboard user
// can go on through the options.
test('a choice select keeps focus after a keyboard pick, releases it after a pointer pick', async ({ page }) => {
  await startAudio(page);
  await openMixer(page);
  const delay = strip(page, 'delay');
  await delay.getByTestId('fx-expand').click();
  const sel = delay.getByTestId('knob-delay_time');
  await sel.focus();
  const v0 = Number(await sel.inputValue());
  await page.keyboard.press('ArrowDown'); // opens the picker
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(sel).toHaveValue(String(v0 + 1));
  await expect(sel).toBeFocused();

  await sel.click(); // open with the pointer
  await sel.locator('option').nth(2).click();
  await expect(sel).toHaveValue('2');
  await expect(sel).not.toBeFocused();
});

test('strip knobs fit their 56 px cells; a strip whose upper controls scroll shows a fade cue', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await startAudio(page);
  await addTrack(page, 'synth');
  await openMixer(page);
  const s = strip(page, 1);
  await s.getByTestId('eq-expand').click();
  await s.getByTestId('comp-expand').click();
  // The send knobs too, one wearing a long (24-character) return name as its label.
  await page.evaluate(() => (window as unknown as { __daw: { actions: { renameReturn(id: string, n: string): boolean } } }).__daw.actions.renameReturn('reverb', 'Long Cathedral Hall Room'));
  await s.getByTestId('sends-expand').click();
  await expect(s.getByTestId('knob-send_a')).toContainText('Long Cathedral');
  // Every compact dial fits inside the strip's 112 px content box, two per row.
  const fit = await s.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const left = r.left + parseFloat(cs.paddingLeft);
    const right = r.right - parseFloat(cs.paddingRight);
    return [...el.querySelectorAll<HTMLElement>('.knob.mech')].map((k) => {
      const b = k.getBoundingClientRect();
      return { w: Math.round(b.width), inside: b.left >= left - 0.5 && b.right <= right + 0.5 };
    });
  });
  expect(fit.length).toBeGreaterThan(4);
  for (const k of fit) {
    expect(k.w).toBeLessThanOrEqual(56);
    expect(k.inside).toBe(true);
  }
  // At 720 the expanded EQ + Comp do not fit above the fader: the upper part scrolls, cued by a fade.
  const upper = s.getByTestId('strip-upper');
  const overflow = await upper.evaluate((u) => u.scrollHeight > u.clientHeight);
  expect(overflow).toBe(true);
  // Expanding (focus on a header) may have scrolled it already: start from the top.
  await upper.evaluate((u) => { u.scrollTop = 0; });
  await expect(upper).toHaveClass(/fade-bot/);
  await expect(upper).not.toHaveClass(/fade-top/);
  await upper.evaluate((u) => { u.scrollTop = u.scrollHeight; });
  await expect(upper).toHaveClass(/fade-top/);
  await expect(upper).not.toHaveClass(/fade-bot/);
  expect(await upper.evaluate((u) => getComputedStyle(u).maskImage)).toContain('linear-gradient');
});

test('a GR readout changing value keeps its size, so nothing beside it moves (fixed-width chip)', async ({ page }) => {
  await startAudio(page);
  await openMixer(page);
  const master = page.getByTestId('strip-master');
  const gr = master.getByTestId('gr');
  await expect(gr).toBeVisible();
  const seen: { chip: number; knob: number }[] = [];
  // The engine writes this text every frame; force the narrowest and widest forms.
  for (const text of ['0.0 dB', '−0.1 dB', '−12.4 dB', '−99.9 dB', '0.0 dB']) {
    seen.push(await gr.evaluate((el, t) => {
      el.textContent = t;
      const strip = el.closest('[data-testid="strip-master"]')!;
      const knob = strip.querySelector('[data-testid="knob-limiter_ceiling"]')!;
      return { chip: el.getBoundingClientRect().width, knob: knob.getBoundingClientRect().left };
    }, text));
  }
  for (const s of seen) {
    expect(Math.abs(s.chip - seen[0].chip)).toBeLessThan(0.5);
    expect(Math.abs(s.knob - seen[0].knob)).toBeLessThan(0.5);
  }
});
