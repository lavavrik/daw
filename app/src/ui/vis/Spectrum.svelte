<script lang="ts">
  // A spectrum view on the analyser bus (ui/vis/analyserBus.ts; plan 12
  // Task 3). It runs no FFT of its own: it subscribes and draws the bus's
  // arrays straight onto its canvas after each analysis (≤ 30 Hz, never
  // through Svelte state), and only while it is on screen.
  //
  // - `need: 'panel'` (the mixer analyser, 60 bands of the selected source):
  //   a filled line through the band levels, peak-hold dots, gridlines at
  //   30/50/100/200/500/1k/2k/5k/10k/20k Hz and 0/−12/−24/−48/−72 dB (drawn
  //   once on a canvas underneath), and a hover readout "55 Hz · A1 · −8.2
  //   dB" (the hovered band's level; the note helps tune kick and bass).
  // - `need: 'mini'` (the top bar, 20 master bands): bars, no labels.
  //
  // Accessibility: the panel is one role="img" with a label (the canvases
  // are hidden); the mini view is hidden (its button carries the label).
  // The hover readout is pointer-only for now (a keyboard cursor is a
  // follow-up).
  //
  // The canvases are device-pixel sharp. A frame that would draw exactly
  // what is already there (silence) is skipped. data-peak-db exposes the
  // loudest band level to tests.
  import { onMount } from 'svelte';
  import { THEME } from '../theme';
  import { analyserBus } from './analyserBus';
  import type { AnalyserBus } from './analyserBus';
  import { DB_FLOOR, DB_TOP, dbToY, freqToX, hoverReadout, xToFreq } from './spectrum';

  let { need, width, height, color = THEME.textDim }: {
    need: 'panel' | 'mini';
    /** CSS px. */
    width: number;
    height: number;
    /** Line / bar colour (the panel takes the shown strip's). */
    color?: string;
  } = $props();

  const GRID_HZ = [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const GRID_DB = [0, -12, -24, -48, -72];

  let canvas: HTMLCanvasElement;
  let gridCanvas = $state<HTMLCanvasElement | null>(null);
  let readoutEl = $state<HTMLElement | null>(null);
  let dpr = 1;
  /** Hovered x (CSS px), or null. */
  let hoverX: number | null = null;
  /** What was drawn last (levels then peaks), to skip identical frames. */
  let drawn = new Float32Array(0);
  let drawnHover: number | null = null;
  let drawnColor = '';
  let shownPeak = '';

  /** Size the canvas backing store for the device pixel ratio; true if it changed. */
  function fit(c: HTMLCanvasElement): boolean {
    const want = Math.max(1, Math.round(window.devicePixelRatio || 1));
    if (want === dpr && c.width === width * want) return false;
    dpr = want;
    c.width = width * dpr;
    c.height = height * dpr;
    return true;
  }

  const hzLabel = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

  /** `hex` (#rrggbb) at alpha `a`, as an rgba() string (no color-mix in addColorStop). */
  function withAlpha(hex: string, a: number) {
    const n = parseInt(hex.slice(1, 7), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  let gradient: CanvasGradient | null = null;
  let gradientKey = '';
  /** The trace colour with a gloss: bright at the top, fading toward the floor. Cached per colour and height. */
  function barFill(c: CanvasRenderingContext2D) {
    const key = `${color}|${height}`;
    if (gradient && key === gradientKey) return gradient;
    const g = c.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, color);
    g.addColorStop(1, color.startsWith('#') && color.length >= 7 ? withAlpha(color, 0.25) : color);
    gradientKey = key;
    return (gradient = g);
  }

  function drawGrid() {
    const c = gridCanvas?.getContext('2d');
    if (!gridCanvas || !c) return;
    gridCanvas.width = width * dpr;
    gridCanvas.height = height * dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = THEME.lcd;
    c.fillRect(0, 0, width, height);
    c.lineWidth = 1;
    c.font = `9px ${THEME.fontMono}`;
    c.textBaseline = 'top';
    for (const f of GRID_HZ) {
      const x = Math.round(freqToX(f) * width) + 0.5;
      c.strokeStyle = f === 100 || f === 1000 || f === 10000 ? THEME.line : THEME.grid;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, height);
      c.stroke();
      if (f < 20000) {
        c.fillStyle = THEME.textDim;
        c.fillText(hzLabel(f), x + 2, height - 10);
      }
    }
    for (const db of GRID_DB) {
      const y = Math.round(dbToY(db, height)) + 0.5;
      c.strokeStyle = db === 0 ? THEME.line : THEME.grid;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(width, y);
      c.stroke();
      c.fillStyle = THEME.textDim;
      c.fillText(db === 0 ? '0' : `−${-db}`, 2, y + 1);
    }
  }

  function draw(bus: AnalyserBus) {
    const b = need === 'panel' ? bus.panel : bus.mini;
    const bands = need === 'panel' ? bus.panelBands : bus.miniBands;
    const n = bands.count;
    const resized = fit(canvas);
    if (resized && need === 'panel') drawGrid();
    // Skip a frame identical to the last one (e.g. silence).
    if (drawn.length !== 2 * n) drawn = new Float32Array(2 * n).fill(NaN);
    let same = !resized && hoverX === drawnHover && color === drawnColor;
    let loudest = DB_FLOOR;
    for (let i = 0; i < n; i++) {
      if (b.level[i] > loudest) loudest = b.level[i];
      if (drawn[i] !== b.level[i] || drawn[n + i] !== b.peak[i]) {
        same = false;
        drawn[i] = b.level[i];
        drawn[n + i] = b.peak[i];
      }
    }
    if (same) return;
    drawnHover = hoverX;
    drawnColor = color;
    const c = canvas.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, width, height);
    const peakDb = loudest <= DB_FLOOR ? '-inf' : loudest.toFixed(1);
    if (peakDb !== shownPeak) canvas.dataset.peakDb = shownPeak = peakDb;

    if (need === 'mini') {
      c.fillStyle = THEME.lcd;
      c.fillRect(0, 0, width, height);
      // Glossy bars: the colour fading toward the floor, as on the Mixer board.
      c.fillStyle = barFill(c);
      const w = width / n;
      for (let i = 0; i < n; i++) {
        const y = dbToY(b.level[i], height);
        if (y < height) c.fillRect(i * w, y, Math.max(1, w - 0.6), height - y);
      }
      return;
    }

    // The filled line through the band centres.
    c.beginPath();
    c.moveTo(0, height);
    for (let i = 0; i < n; i++) c.lineTo(freqToX(bands.centre[i]) * width, dbToY(b.level[i], height));
    c.lineTo(width, height);
    c.closePath();
    c.globalAlpha = 0.5;
    c.fillStyle = barFill(c);
    c.fill();
    c.globalAlpha = 1;
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const x = freqToX(bands.centre[i]) * width;
      const y = dbToY(b.level[i], height);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.strokeStyle = color;
    c.lineWidth = 1.25;
    c.stroke();
    // Peak-hold dots.
    c.fillStyle = THEME.text;
    for (let i = 0; i < n; i++) {
      if (b.peak[i] <= DB_FLOOR) continue;
      c.fillRect(freqToX(bands.centre[i]) * width - 1, dbToY(b.peak[i], height) - 1, 2, 2);
    }
    // Hover: a cursor line and the readout of the band under it.
    if (hoverX !== null && readoutEl) {
      c.fillStyle = THEME.accent;
      c.fillRect(Math.round(hoverX), 0, 1, height);
      const f = xToFreq(hoverX / width);
      readoutEl.textContent = hoverReadout(f, b.level[bands.bandOf(f)]);
    }
  }

  function move(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    hoverX = Math.min(width - 1, Math.max(0, e.clientX - r.left));
    if (readoutEl) readoutEl.hidden = false;
  }
  function leave() {
    hoverX = null;
    if (readoutEl) readoutEl.hidden = true;
  }

  onMount(() => {
    fit(canvas);
    if (need === 'panel') drawGrid();
    return analyserBus().subscribe({ need, el: canvas, draw });
  });
</script>

<div
  class="spec" class:mini={need === 'mini'} style:width="{width}px" style:height="{height}px"
  role={need === 'panel' ? 'img' : undefined}
  aria-label={need === 'panel' ? `Spectrum, 20 Hz to 20 kHz, ${DB_FLOOR} to +${DB_TOP} dB` : undefined}
  aria-hidden={need === 'mini' ? 'true' : undefined}
>
  {#if need === 'panel'}<canvas class="grid" bind:this={gridCanvas} style:width="{width}px" style:height="{height}px" aria-hidden="true"></canvas>{/if}
  <canvas
    bind:this={canvas}
    style:width="{width}px" style:height="{height}px"
    data-testid={need === 'panel' ? 'analyser-spectrum' : 'mini-spectrum-canvas'}
    data-peak-db="-inf"
    aria-hidden="true"
    onpointermove={need === 'panel' ? move : undefined}
    onpointerleave={need === 'panel' ? leave : undefined}
  ></canvas>
  {#if need === 'panel'}<span class="readout" bind:this={readoutEl} data-testid="analyser-readout" hidden></span>{/if}
</div>

<style>
  .spec { position: relative; flex: none; }
  .spec canvas { position: absolute; inset: 0; display: block; }
  .spec:not(.mini) canvas:not(.grid) { cursor: crosshair; }
  .readout { position: absolute; top: 2px; right: 2px; padding: 0 4px; border-radius: 2px; background: color-mix(in srgb, var(--lcd) 85%, transparent); color: var(--accent); font: 10px/1.4 var(--font-mono); pointer-events: none; white-space: nowrap; }
</style>
