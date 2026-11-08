import { expect, test, type Page } from '@playwright/test';

// The look check (plan 20 Task 11; spec §5). Captures the four main views at
// 1440×900 into test-results/look-*.png for a human to compare with the
// design canvas, and asserts the layout invariants the redesign promises —
// not pixels:
//   - no horizontal page scroll at 1280×800, in every view;
//   - the top bar is one row at 1280 px.
// Playwright empties test-results/ at the start of each run, so the
// screenshots are always this run's.

type Daw = {
  __daw: {
    project: { tracks: { id: string; rows?: { id: string }[] }[] };
    actions: {
      setStep: (trackId: string, rowId: string, step: number, vel: number) => void;
      addSynthTrack: (patch: string) => { id: string } | null;
      addNote: (trackId: string, o: { pitch: number; start: number; len: number; vel: number }) => unknown;
      addClip: (trackId: string, o: { start: number }) => unknown;
    };
  };
};

const BAR = 3840; // ticks (960 PPQ, 4/4)
const BEAT = 960;

/** Start audio and build a small song: a drum beat, a bass line, both placed on the playlist. */
async function setup(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Click to start audio' }).click();
  await expect(page.getByTestId('step-0-0')).toBeVisible();
  await page.evaluate(
    ({ BAR, BEAT }) => {
      const { project, actions: a } = (window as unknown as Daw).__daw;
      const d = project.tracks[0];
      const rows = d.rows!;
      for (const s of [0, 4, 8, 12]) a.setStep(d.id, rows[0].id, s, s === 0 ? 120 : 100);
      for (const s of [4, 12]) a.setStep(d.id, rows[1].id, s, 100);
      for (let s = 2; s < 16; s += 4) a.setStep(d.id, rows[2].id, s, 80);
      for (const s of [3, 7, 11, 15]) a.setStep(d.id, rows[3].id, s, 60);
      const bass = a.addSynthTrack('Deep Bass')!;
      const line = [36, 36, 48, 36, 39, 36, 43, 41];
      line.forEach((pitch, i) => a.addNote(bass.id, { pitch, start: (i * BEAT) / 2, len: BEAT / 2 - 60, vel: i % 4 === 0 ? 120 : 90 }));
      for (let bar = 0; bar < 4; bar++) {
        a.addClip(d.id, { start: bar * BAR });
        a.addClip(bass.id, { start: bar * BAR });
      }
    },
    { BAR, BEAT },
  );
  await expect(page.getByTestId('track-1')).toBeVisible();
}

/** The views: what to click to get there, and what must then be on screen. */
const VIEWS: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: 'song',
    open: async (page) => {
      await page.getByTestId('track-0').click();
      await page.getByRole('button', { name: 'Step grid', exact: true }).click();
      await expect(page.getByTestId('step-0-0')).toBeVisible();
    },
  },
  {
    name: 'rack',
    open: async (page) => {
      await page.getByTestId('track-1').click();
      await page.getByRole('button', { name: 'Instrument', exact: true }).click();
      await expect(page.getByTestId('rack')).toBeVisible();
    },
  },
  {
    name: 'mixer',
    open: async (page) => {
      await page.getByTestId('mixer-tab').click();
      await expect(page.getByTestId('mixer')).toBeVisible();
      // Open the Delay return's section: its 12-way division is a skinned select.
      await page.getByTestId('strip-delay').getByTestId('fx-expand').click();
      await expect(page.getByTestId('strip-delay').getByTestId('knob-delay_time')).toBeVisible();
    },
  },
  {
    name: 'pianoroll',
    open: async (page) => {
      await page.getByTestId('track-1').click();
      await page.getByRole('button', { name: 'Piano roll', exact: true }).click();
      await expect(page.getByTestId('pianoroll')).toBeVisible();
    },
  },
];

/** Page-level horizontal overflow, and the top bar's rows (see layout.spec.ts). */
function layout(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('header')!;
    const kids = [...bar.children].filter((el) => getComputedStyle(el).display !== 'none');
    const rs = kids.map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
    const minBottom = Math.min(...rs.map((r) => r.bottom));
    return {
      docWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      // One row: no part of the bar starts below the bottom of the shortest one,
      // and the bar is one 64 px row tall (two rows would be ~100 px).
      rows: rs.some((r) => r.top >= minBottom) ? 2 : 1,
      barHeight: bar.getBoundingClientRect().height,
    };
  });
}

test('look: the four views at 1440×900 (screenshots in test-results/look-*.png)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  for (const v of VIEWS) {
    await v.open(page);
    await page.mouse.move(0, 0); // no hover state in the picture
    await page.screenshot({ path: `test-results/look-${v.name}.png` });
    const out = await layout(page);
    expect(out.docWidth, `${v.name}: no horizontal scroll at 1440`).toBeLessThanOrEqual(1440);
  }
});

test('layout at 1280×800: no horizontal scroll in any view; the top bar is one row', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await setup(page);
  for (const v of VIEWS) {
    await v.open(page);
    const out = await layout(page);
    expect(out.docWidth, `${v.name}: page width`).toBeLessThanOrEqual(1280);
    expect(out.bodyWidth, `${v.name}: body width`).toBeLessThanOrEqual(1280);
    expect(out.rows, `${v.name}: top bar rows`).toBe(1);
    expect(out.barHeight, `${v.name}: top bar height`).toBeLessThan(80);
  }
});
