import { expect, test, type Page } from '@playwright/test';
import { closeMenu, openMenu } from './topbar';
import { startApp } from './startApp';

// The FL-style top bar (plan 20 Task 5; spec §4 "Top bar"; TopBar.svelte,
// BigTimer.svelte). layout.spec.ts measures it at more widths; this file
// checks its new parts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function start(page: Page, height = 800) {
  await page.setViewportSize({ width: 1280, height });
  await page.goto('/');
  await startApp(page);
  await expect(page.getByTestId('play')).toBeVisible();
}

/** One row (no direct child starts below the shortest one's bottom), and no page scroll sideways. */
function measure(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('header')!;
    const rs = [...bar.children].map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
    const minBottom = Math.min(...rs.map((r) => r.bottom));
    return {
      rows: rs.some((r) => r.top >= minBottom) ? 2 : 1,
      height: bar.getBoundingClientRect().height,
      docWidth: document.documentElement.scrollWidth,
    };
  });
}

/** A fake Web MIDI (connectMidi reads inputs / onstatechange): one input named `name`, or none. Headless Chrome blocks Web MIDI otherwise. */
async function fakeMidi(page: Page, name: string | null) {
  await page.addInitScript((name) => {
    const inputs = new Map(name ? [['fake-1', { id: 'fake-1', name, state: 'connected', onmidimessage: null }]] : []);
    const access = { inputs, onstatechange: null };
    Object.defineProperty(navigator, 'requestMIDIAccess', { value: () => Promise.resolve(access), configurable: true });
  }, name);
}

test('one row at 1280×800 with no horizontal scroll, also with the web fonts blocked', async ({ page }) => {
  // Fonts blocked (Review focus: offline): the stacks fall back to system-ui / ui-monospace.
  await page.route(/\.(woff2?|ttf)(\?.*)?$/, (r) => r.abort());
  await start(page);
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => {
    (window as Any).__daw.engine.dropouts = () => 123; // the widest badge
  });
  await expect(page.getByTestId('topbar-warning')).toHaveText('123 dropouts');
  const out = await measure(page);
  expect(out.rows).toBe(1);
  expect(out.height).toBeLessThanOrEqual(65);
  expect(out.docWidth).toBeLessThanOrEqual(1280);
  for (const id of ['project-menu', 'menu-file', 'menu-help', 'undo', 'redo', 'play', 'song-stop', 'loop-toggle', 'timer', 'master-volume', 'topbar-spectrum', 'topbar-warning']) {
    await expect(page.getByTestId(id)).toBeInViewport();
  }
  // The timer's box already fits bar 999: a 3-digit bar moves nothing.
  const timerW = async () => (await page.getByTestId('timer').boundingBox())!.width;
  const w1 = await timerW();
  await page.getByTestId('song-stop').click();
  await page.evaluate(() => (window as Any).__daw.actions.seek(998 * 3840 + 3 * 960 + 959));
  await expect(page.getByTestId('timer-pos')).toHaveText('999:04:959');
  expect(await timerW()).toBe(w1);
  expect((await measure(page)).rows).toBe(1);
});

// Plan 22 Task 1: Keys, octave, MIDI, CPU and latency moved into the menus;
// the top right is empty until something needs attention.
test('the top right is empty in the normal state; the pills live in the menus', async ({ page }) => {
  const NAME = 'Arturia KeyStep Pro Mk II USB MIDI Interface Port 1';
  await fakeMidi(page, NAME);
  await start(page);
  const slot = page.getByTestId('audio-status');
  await expect(slot).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('topbar-warning')).toHaveCount(0);
  await expect(slot).toBeEmpty();
  expect((await slot.boundingBox())?.width ?? 0).toBe(0);
  // Nothing at the right of the mini spectrum but the spacer and the (empty) slot.
  const right = await page.evaluate(() => {
    const kids = [...document.querySelector('header.bar')!.children] as HTMLElement[];
    const mini = kids.findIndex((k) => k.dataset.testid === 'topbar-spectrum');
    return kids.slice(mini + 1).filter((k) => !k.classList.contains('spacer') && k.getBoundingClientRect().width > 0).map((k) => k.className);
  });
  expect(right).toEqual([]);
  // The moved controls, under their test ids, in the menus.
  await openMenu(page, 'Options');
  await expect(page.getByTestId('keys-target')).toHaveText('Drums');
  await expect(page.getByTestId('octave')).toHaveText(/^Octave \d$/);
  await expect(page.getByTestId('midi-status')).toHaveText(`MIDI: ${NAME}`);
  // A long device name is cut with an ellipsis inside the menu (full name in the tooltip).
  const midiItem = page.getByTestId('menu-midi');
  await expect(midiItem).toHaveAttribute('title', `MIDI: ${NAME}`);
  expect(await page.getByTestId('midi-status').evaluate((l) => l.scrollWidth > l.clientWidth && getComputedStyle(l).textOverflow === 'ellipsis')).toBe(true);
  await openMenu(page, 'View');
  await expect(page.getByTestId('cpu')).toHaveText(/^CPU \d+% · 0 drop$/);
  await expect(page.getByTestId('latency')).toHaveText(/^\d+ ms$/);
});

test('View ▸ Performance: live CPU, dropouts and latency; a click opens Audio settings, Esc gives the focus back to View', async ({ page }) => {
  await start(page);
  await openMenu(page, 'View');
  const item = page.getByTestId('settings-button');
  await expect(item).toBeVisible();
  await expect(item).toContainText('Performance');
  await expect(page.getByTestId('cpu')).toHaveText(/^CPU \d+% · \d+ drop$/);
  // Live while the menu is open (4 Hz from the top bar's telemetry).
  await page.evaluate(() => ((window as Any).__daw.engine.dropouts = () => 7));
  await expect(page.getByTestId('cpu')).toContainText('· 7 drop');
  await expect(page.getByTestId('cpu')).toHaveClass(/\bbad\b/);
  await item.click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings')).toBeHidden();
  await expect(page.getByTestId('menu-view')).toBeFocused();
});

test('the warning badge: dropouts in the last 10 s, MIDI blocked, high latency; a click does the fix', async ({ page }) => {
  await fakeMidi(page, null);
  await start(page);
  const badge = page.getByTestId('topbar-warning');
  await expect(badge).toHaveCount(0);

  // Dropouts: "N dropouts", red; a click opens Audio settings. (The 10 s
  // window itself is unit-tested: topStatus.test.ts.)
  await page.evaluate(() => ((window as Any).__daw.engine.dropouts = () => 2));
  await expect(badge).toHaveText('2 dropouts');
  await expect(badge).toHaveAttribute('data-kind', 'dropouts');
  await badge.click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(badge).toBeFocused(); // the focus back on what opened it
  // A lower total is a new engine (an audio restart): the count starts over.
  await page.evaluate(() => ((window as Any).__daw.engine.dropouts = () => 0));
  await expect(badge).toHaveCount(0);

  // High latency (Bluetooth-size): the orange badge, which opens Audio settings.
  await page.evaluate(() => ((window as Any).__daw.engine.latencyMs = () => 180));
  await expect(badge).toHaveText('180 ms latency');
  await expect(badge).toHaveAttribute('data-kind', 'latency');
  await page.mouse.move(600, 500); // not on the badge: its title is back from the tooltip layer
  await expect(badge).toHaveAttribute('title', /Bluetooth/);
  await badge.click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings')).toBeHidden();
});

test('MIDI blocked shows the badge; it opens the MIDI popover, which says so; a second click closes it', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'requestMIDIAccess', { value: () => Promise.reject(new DOMException('denied', 'SecurityError')), configurable: true });
  });
  await start(page);
  const badge = page.getByTestId('topbar-warning');
  await expect(badge).toHaveText('MIDI blocked');
  await expect(badge).toHaveAttribute('data-kind', 'midi');
  await expect(page.getByTestId('midi-status')).toHaveText('MIDI: blocked'); // Options ▸ MIDI…'s label
  await badge.click();
  const pop = page.getByTestId('midi-popover');
  await expect(pop).toBeVisible();
  await expect(page.getByTestId('midi-devices')).toContainText('denied');
  // It opens under the badge, inside the window.
  const b = (await badge.boundingBox())!;
  const r = (await pop.boundingBox())!;
  expect(r.y).toBeGreaterThan(b.y + b.height);
  expect(r.x + r.width).toBeLessThanOrEqual(1280);
  await badge.click();
  await expect(pop).toHaveCount(0);
});

test('a suspended context shows the paused pill in the badge slot; its click resumes', async ({ page }) => {
  await fakeMidi(page, null);
  await start(page);
  const slot = page.getByTestId('audio-status');
  await page.evaluate(() => (window as Any).__daw.engine.context.suspend());
  await expect(slot).toHaveAttribute('data-state', 'paused');
  await expect(slot).toHaveText('Audio paused — click anywhere to start');
  await slot.getByRole('button').click();
  await expect(slot).toHaveAttribute('data-state', 'running');
  await expect(slot).toBeEmpty();
});

test('short windows (1280×720): the compact 40 px bar, still one row; the short badge keeps a 24 px hit area', async ({ page }) => {
  await start(page, 720);
  await page.getByTestId('play').click();
  const out = await measure(page);
  expect(out.rows).toBe(1);
  expect(out.height).toBeLessThanOrEqual(41);
  expect(out.docWidth).toBeLessThanOrEqual(1280);
  // Headless Chrome blocks Web MIDI: the badge says so. A click 3 px above it still opens the popover.
  const badge = page.getByTestId('topbar-warning');
  await expect(badge).toHaveText('MIDI blocked');
  const b = (await badge.boundingBox())!;
  expect(b.height).toBeLessThan(24);
  await page.mouse.click(b.x + b.width / 2, b.y - 3);
  await expect(page.getByTestId('midi-popover')).toBeVisible();
});

test('names: "Play song" is a toggle, "Stop all" stops either transport', async ({ page }) => {
  await start(page);
  const play = page.getByRole('button', { name: 'Play song' });
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Stop all' }).click();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('pattern-play').click();
  await expect(play).toHaveAttribute('aria-pressed', 'false'); // the pattern runs, not the song
  await page.getByRole('button', { name: 'Stop all' }).click();
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.project.playing)).toBe(false);
});

test('the timer: 1:01:000 stopped at 0, advances while the song plays, the pattern position while the pattern plays', async ({ page }) => {
  await start(page);
  const pos = page.getByTestId('timer-pos');
  await expect(page.getByTestId('timer')).toHaveAttribute('aria-live', 'off');
  await expect(pos).toHaveText('1:01:000');
  await expect(page.getByTestId('timer-seconds')).toHaveText('0:00.00');
  await page.getByTestId('play').click();
  // 124 BPM: one beat is ~0.48 s; beat 2 within a couple of seconds.
  await expect(pos).not.toHaveText('1:01:000');
  await expect(pos).toHaveText(/^1:0[2-4]:\d{3}$|^[2-9]:\d{2}:\d{3}$/, { timeout: 5_000 });
  await expect(page.getByTestId('timer-seconds')).not.toHaveText('0:00.00');
  await page.getByTestId('song-stop').click();
  await expect(pos).toHaveText('1:01:000'); // back at the song position
  await expect(page.getByTestId('timer')).toHaveAttribute('aria-label', 'Song position');
  // The pattern transport: the timer shows the position inside the shown pattern, labelled "Pattern".
  const width = (await page.getByTestId('timer').boundingBox())!.width;
  await page.getByTestId('pattern-play').click();
  await expect(page.getByTestId('timer')).toHaveAttribute('aria-label', 'Pattern position');
  await expect(page.getByTestId('timer-label').getByText('Pattern', { exact: true })).toBeVisible();
  await expect(pos).toHaveText(/^1:0[2-4]:\d{3}$/, { timeout: 5_000 }); // a 1-bar pattern: bar 1, beat 2+
  expect((await page.getByTestId('timer').boundingBox())!.width).toBe(width); // the label switch moves nothing
  await page.getByTestId('song-stop').click(); // Stop stops whichever transport runs
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.project.playing)).toBe(false);
  await expect(pos).toHaveText('1:01:000'); // the song position again
  await expect(page.getByTestId('timer')).toHaveAttribute('aria-label', 'Song position');
  // A parked song position shows too.
  await page.evaluate(() => (window as Any).__daw.actions.seek(3840 * 2 + 960 + 288));
  await expect(pos).toHaveText('3:02:288');
});

test('tempo: a scrub is one undo entry', async ({ page }) => {
  await start(page);
  await expect(page.getByTestId('undo')).toBeDisabled();
  const bpm = page.getByLabel('BPM');
  await expect(bpm).toHaveValue('124');
  const b = (await bpm.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  // Record the SET_TEMPO sends: a scrub is heard live (previews), committed once.
  await page.evaluate(() => {
    const d = (window as Any).__daw;
    const e = d.engine;
    const orig = e.send.bind(e);
    d.tempoSends = [];
    e.send = (op: number, ...a: number[]) => { if (op === d.Op.SET_TEMPO) d.tempoSends.push(a[0]); return orig(op, ...a); };
  });
  const sends = () => page.evaluate(() => (window as Any).__daw.tempoSends as number[]);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x, y - i * 4); // 40 px up: +10
  // Mid-scrub: the engine already plays the live tempo; the project (and the history) not yet.
  await expect.poll(sends).toContain(134);
  expect(await page.evaluate(() => (window as Any).__daw.project.tempo)).toBe(124);
  await expect(page.getByTestId('undo')).toBeDisabled();
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.project.tempo)).toBe(134);
  await expect(bpm).toHaveValue('134');
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Tempo/);
  await page.getByTestId('undo').click();
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.project.tempo)).toBe(124);
  await expect(bpm).toHaveValue('124');
  await expect(page.getByTestId('undo')).toBeDisabled(); // one entry, nothing older
  // Escape mid-scrub drops it: the engine gets the committed tempo back, no entry.
  await page.evaluate(() => ((window as Any).__daw.tempoSends = []));
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x, y - i * 4);
  await expect.poll(sends).toContain(129);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await sends()).at(-1)).toBe(124);
  expect(await page.evaluate(() => (window as Any).__daw.project.tempo)).toBe(124);
  await expect(page.getByTestId('undo')).toBeDisabled();
});

test('master slider: the master fader, on the fader law, one undo entry per drag, follows automation', async ({ page }) => {
  await start(page);
  const vol = page.getByTestId('master-volume');
  await expect(vol).toHaveAttribute('aria-valuenow', '0');
  await expect(vol).toHaveAttribute('data-auto', 'none'); // registered on the auto bus
  // 0 dB sits at 3/4 of the track (the fader law), not at the dB range's 91 %.
  const track = page.getByTestId('master-volume-track');
  const t = (await track.boundingBox())!;
  const handle = (await vol.locator('.handle').boundingBox())!;
  expect((handle.x + handle.width / 2 - t.x) / t.width).toBeCloseTo(0.75, 1);
  // Drag left from a point on the track (not the handle) by a quarter of its width.
  const y = t.y + t.height / 2;
  await page.mouse.move(t.x + t.width * 0.3, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(t.x + t.width * (0.3 - 0.025 * i), y);
  await page.mouse.up();
  const db = Number(await vol.getAttribute('aria-valuenow'));
  expect(db).toBeLessThan(-5);
  // The mixer's master strip shows the same fader value.
  await page.getByTestId('topbar-spectrum').click(); // opens the Mixer tab
  const fader = page.getByTestId('strip-master').getByTestId('fader');
  await expect(fader).toHaveAttribute('aria-valuenow', String(db));
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Set Volume/);
  await page.getByTestId('undo').click();
  await expect(vol).toHaveAttribute('aria-valuenow', '0');
  await expect(fader).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByTestId('undo')).toBeDisabled(); // the whole drag was one entry

  // A master fader lane: the slider shows the lane's value in Song mode.
  await page.evaluate(() => {
    const a = (window as Any).__daw.actions;
    a.drawLane(a.addLane('master', { kind: 'mix', param: 'fader' }), [{ tick: 0, value: -12 }, { tick: 3840, value: -12 }]);
  });
  await page.getByTestId('play').click(); // Song mode …
  await page.getByTestId('song-stop').click(); // … stopped at the start, where the lane applies
  await expect(vol).toHaveAttribute('data-auto', 'on');
  await expect.poll(async () => Number(await vol.getAttribute('aria-valuenow'))).toBeCloseTo(-12, 1);
});

test('master slider: a click on the track jumps there; a press on the handle never jumps', async ({ page }) => {
  await start(page);
  const vol = page.getByTestId('master-volume');
  const track = page.getByTestId('master-volume-track');
  const t = (await track.boundingBox())!;
  const y = t.y + t.height / 2;
  const handleX = async () => {
    const h = (await vol.locator('.handle').boundingBox())!;
    return (h.x + h.width / 2 - t.x) / t.width;
  };
  // A click (press + release, no move) at 30 % of the track: the handle goes there.
  await page.mouse.click(t.x + t.width * 0.3, y);
  await expect.poll(handleX).toBeCloseTo(0.3, 1);
  const jumped = Number(await vol.getAttribute('aria-valuenow'));
  expect(jumped).toBeLessThan(-5);
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Set Volume/);
  // A press-and-release on the handle, a few px off its centre: no change at all.
  const h = (await vol.locator('.handle').boundingBox())!;
  await page.mouse.click(h.x + h.width / 2 + 3, h.y + h.height / 2);
  await page.waitForTimeout(50);
  expect(Number(await vol.getAttribute('aria-valuenow'))).toBe(jumped);
  // A drag from the handle moves by the pointer's travel, not to where it was pressed.
  await page.mouse.move(h.x + h.width / 2 + 3, h.y + h.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(h.x + h.width / 2 + 3 + i * 4, h.y + h.height / 2);
  await page.mouse.up();
  expect(Number(await vol.getAttribute('aria-valuenow'))).toBeGreaterThan(jumped);
});

test('menu bar: the ⋯ controls moved to File / Options with their test ids; Escape and a press outside close it', async ({ page }) => {
  await start(page);
  const FILE = ['project-new', 'project-open', 'project-save', 'project-save-as', 'project-export', 'undo-take'];
  for (const id of [...FILE, 'rec-offset']) await expect(page.getByTestId(id)).toBeHidden();
  await openMenu(page, 'File');
  for (const id of FILE) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId('undo-take')).toBeDisabled(); // no take yet
  // Escape closes it; the focus goes back to File.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('project-new')).toBeHidden();
  await expect(page.getByTestId('menu-file')).toBeFocused();
  // The recording offset is in Options and persists (localStorage), as before.
  await openMenu(page, 'Options');
  await page.getByTestId('rec-offset').fill('25');
  await page.getByTestId('rec-offset').press('Enter');
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.recorder.offsetMs)).toBe(25);
  // Escape inside the offset only reverts the typed text: the menu stays open.
  await page.getByTestId('rec-offset').fill('40');
  await page.getByTestId('rec-offset').press('Escape');
  await expect(page.getByTestId('rec-offset')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.recorder.offsetMs)).toBe(25);
  // Escape again closes it and gives the focus back to Options.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('rec-offset')).toBeHidden();
  await expect(page.getByTestId('menu-options')).toBeFocused();
  // The project name opens File; Escape returns the focus to it.
  await page.getByTestId('project-menu').click();
  await expect(page.getByTestId('project-new')).toBeVisible();
  await expect(page.getByTestId('project-menu')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('project-new')).toBeHidden();
  await expect(page.getByTestId('project-menu')).toBeFocused();
  // A press outside closes it.
  await page.getByTestId('project-menu').click();
  await page.getByTestId('timer').click();
  await expect(page.getByTestId('project-new')).toBeHidden();
  await closeMenu(page, 'File'); // no-op: already closed
  // A command closes it and gives the focus back to the opener (clean project: New runs at once).
  await page.getByTestId('project-menu').click();
  await page.getByTestId('project-new').click();
  await expect(page.getByTestId('project-new')).toBeHidden();
  await expect(page.getByTestId('project-menu')).toBeFocused();
});

test('⌘O on a dirty project opens the menu on the question; Escape closes it', async ({ page }) => {
  await start(page);
  await page.evaluate(() => (window as Any).__daw.actions.addSynthTrack('Lead'));
  await expect(page.getByTestId('project-name')).toContainText('unsaved');
  await page.keyboard.press('ControlOrMeta+O');
  await expect(page.getByTestId('project-discard')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('project-discard')).toBeHidden();
  await expect(page.getByTestId('project-new')).toBeHidden();
  // Cancel on the question goes back to the list, focused on its first item.
  await page.keyboard.press('ControlOrMeta+O');
  await page.getByTestId('project-discard-cancel').click();
  await expect(page.getByTestId('project-new')).toBeFocused();
});

test('hint line: the hovered control, a flashed hint first', async ({ page }) => {
  await start(page);
  const hint = page.getByTestId('hint-line');
  await page.getByRole('button', { name: 'Metronome' }).hover();
  await expect(hint).toHaveText('Metronome');
  await page.getByTestId('loop-toggle').hover();
  await expect(hint).toHaveText('Loop the loop range while playing the song');
  // R with the song transport selected flashes a hint (banners.hint): it wins.
  await page.getByTestId('play').click();
  await page.keyboard.press('KeyR');
  await expect(page.getByTestId('flash-hint')).toBeVisible();
  await expect(hint).toHaveText((await page.getByTestId('flash-hint').textContent())!);
});

// ---- Contrast of warnings and status (final review I3) ----------------------
// WCAG: 4.5:1 for text, 3:1 for icons. --rec / --accent / --play as text or
// an icon on --raised fail (ui-theme.md "Rules of use"), so warnings fill the
// pill (vivid colour, --on-color text) and the pattern transport's status
// uses fills and an LED. Computed colours, base colour only (the gloss only
// lightens the top, which helps dark text).

/** Contrast ratio between two computed CSS colours (rgb()/rgba() or color(srgb …)). */
function contrastOf(page: Page, testid: string) {
  return page.evaluate((testid) => {
    const el = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
    const cs = getComputedStyle(el);
    const parse = (c: string): number[] => {
      const m = c.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/);
      if (m) return [1, 2, 3].map((i) => Number(m[i]));
      const n = c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      return n.map((v) => v / 255);
    };
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const fg = lum(parse(cs.color));
    const bg = lum(parse(cs.backgroundColor));
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  }, testid);
}

test('contrast: warning pills and the pattern transport status meet WCAG (text 4.5:1, icons 3:1)', async ({ page }) => {
  await start(page);
  // The badge: red for dropouts and MIDI blocked, orange for latency; and
  // View ▸ Performance's red dropout readout.
  await page.evaluate(() => ((window as Any).__daw.engine.dropouts = () => 3));
  await expect(page.getByTestId('topbar-warning')).toHaveAttribute('data-kind', 'dropouts');
  expect(await contrastOf(page, 'topbar-warning')).toBeGreaterThanOrEqual(4.5);
  await expect(page.getByTestId('cpu')).toHaveClass(/\bbad\b/);
  expect(await contrastOf(page, 'cpu')).toBeGreaterThanOrEqual(4.5);
  // Latency: forced on (it depends on the machine).
  await page.evaluate(() => document.querySelector('[data-testid="topbar-warning"]')!.classList.add('latency'));
  expect(await contrastOf(page, 'topbar-warning')).toBeGreaterThanOrEqual(4.5);
  await page.evaluate(() => document.querySelector('[data-testid="latency"]')!.classList.add('warn'));
  expect(await contrastOf(page, 'latency')).toBeGreaterThanOrEqual(4.5);
  // The pattern ▶ (icon, stopped and playing).
  expect(await contrastOf(page, 'pattern-play')).toBeGreaterThanOrEqual(3);
  // Rec, unarmed: a --text label (4.07:1 on --raised, the palette's own
  // button text; flagged to the owner) and a red LED; armed: --on-color on --rec.
  expect(await contrastOf(page, 'rec-button')).toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId('rec-button').locator('.led')).toBeVisible();
  await page.keyboard.press('KeyR');
  await expect(page.getByTestId('rec-button')).toHaveAttribute('aria-pressed', 'true');
  expect(await contrastOf(page, 'rec-button')).toBeGreaterThanOrEqual(4.5);
  await page.getByTestId('pattern-play').click();
  await expect(page.getByTestId('pattern-play')).toHaveAttribute('aria-pressed', 'true');
  expect(await contrastOf(page, 'pattern-play')).toBeGreaterThanOrEqual(3);
  await page.getByTestId('pattern-stop').click();
});

test('transports: idle reads as ready (raised, full opacity), playing is filled, disabled is flat and faint', async ({ page }) => {
  await start(page);
  const look = (id: string) => page.getByTestId(id).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { opacity: Number(cs.opacity), shadow: cs.boxShadow !== 'none', bg: cs.backgroundColor, cursor: cs.cursor };
  });
  // Idle (stopped, a drum track selected): both Plays and both Stops are enabled raised buttons.
  for (const id of ['play', 'song-stop', 'pattern-play', 'pattern-stop']) {
    await expect(page.getByTestId(id)).toBeEnabled();
    const l = await look(id);
    expect(l.opacity, id).toBe(1);
    expect(l.shadow, id).toBe(true);
  }
  // Playing: Play is filled (its background is no longer the idle --raised).
  const idleBg = (await look('pattern-play')).bg;
  await page.getByTestId('pattern-play').click();
  await expect(page.getByTestId('pattern-play')).toHaveAttribute('aria-pressed', 'true');
  expect((await look('pattern-play')).bg).not.toBe(idleBg);
  await page.getByTestId('pattern-stop').click();
  // Disabled (no pattern track): flat and faint.
  await page.getByTestId('track-0').hover();
  await page.getByRole('button', { name: 'Remove track Drums' }).click();
  await page.getByTestId('inline-confirm-ok').click();
  await expect(page.getByTestId('pattern-play')).toBeDisabled();
  const d = await look('pattern-play');
  expect(d.opacity).toBeLessThan(1);
  expect(d.shadow).toBe(false);
  expect(d.cursor).toBe('not-allowed');
});
