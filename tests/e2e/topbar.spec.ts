import { expect, test, type Page } from '@playwright/test';
import { closeMore, openMore } from './topbar';

// The FL-style top bar (plan 20 Task 5; spec §4 "Top bar"; TopBar.svelte,
// BigTimer.svelte). layout.spec.ts measures it at more widths; this file
// checks its new parts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function start(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
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

test('one row at 1280×800 with no horizontal scroll, also with the web fonts blocked', async ({ page }) => {
  // Fonts blocked (Review focus: offline): the stacks fall back to system-ui / ui-monospace.
  await page.route(/\.(woff2?|ttf)(\?.*)?$/, (r) => r.abort());
  await start(page);
  await page.getByTestId('play').click();
  await expect(page.getByTestId('play')).toHaveText('Stop');
  await page.evaluate(() => {
    (window as Any).__daw.engine.dropouts = () => 123; // the widest CPU pill
  });
  await expect(page.getByTestId('cpu')).toContainText('123');
  const out = await measure(page);
  expect(out.rows).toBe(1);
  expect(out.height).toBeLessThanOrEqual(65);
  expect(out.docWidth).toBeLessThanOrEqual(1280);
  for (const id of ['project-menu', 'topbar-more', 'undo', 'play', 'song-stop', 'loop-toggle', 'timer', 'master-volume', 'topbar-spectrum', 'keys-target', 'cpu', 'settings-button']) {
    await expect(page.getByTestId(id)).toBeInViewport();
  }
});

test('the timer: 1:01:000 stopped at 0, advances while the song plays, the song position while the pattern plays', async ({ page }) => {
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
  // The pattern transport: the timer keeps showing the song position.
  await page.getByTestId('pattern-play').click();
  await page.waitForTimeout(700);
  await expect(pos).toHaveText('1:01:000');
  await page.getByTestId('song-stop').click(); // Stop stops whichever transport runs
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.project.playing)).toBe(false);
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
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x, y - i * 4); // 40 px up: +10
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.project.tempo)).toBe(134);
  await expect(bpm).toHaveValue('134');
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /^Undo Tempo/);
  await page.getByTestId('undo').click();
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.project.tempo)).toBe(124);
  await expect(bpm).toHaveValue('124');
  await expect(page.getByTestId('undo')).toBeDisabled(); // one entry, nothing older
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

test('⋯ menu: the moved controls keep their test ids; Escape and a press outside close it', async ({ page }) => {
  await start(page);
  for (const id of ['project-new', 'project-open', 'project-save', 'project-save-as', 'project-export', 'undo-take', 'rec-offset']) {
    await expect(page.getByTestId(id)).toBeHidden();
  }
  await openMore(page);
  for (const id of ['project-new', 'project-open', 'project-save', 'project-save-as', 'project-export', 'undo-take', 'rec-offset']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.getByTestId('undo-take')).toBeDisabled(); // no take yet
  // The recording offset persists (localStorage), as before.
  await page.getByTestId('rec-offset').fill('25');
  await page.getByTestId('rec-offset').press('Enter');
  await expect.poll(() => page.evaluate(() => (window as Any).__daw.recorder.offsetMs)).toBe(25);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('project-new')).toBeHidden();
  // The project name opens the same menu; a press outside closes it.
  await page.getByTestId('project-menu').click();
  await expect(page.getByTestId('project-new')).toBeVisible();
  await page.getByTestId('timer').click();
  await expect(page.getByTestId('project-new')).toBeHidden();
  await closeMore(page); // no-op: already closed
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
