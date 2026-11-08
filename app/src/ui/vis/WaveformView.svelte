<script lang="ts">
  // A zoomable waveform, from the whole file down to single samples (plan 12
  // Task 4; docs/architecture/visuals.md *Waveforms*). Used by the Clip tab
  // (clip time, with an overlay for the beat grid, the envelope and the loop
  // seams) and by the drum-row strip under the step grid (file time).
  //
  // Data: `base` (the peaks pyramid, waveMath.waveBase) and, below 256
  // frames per device pixel, the sample's floats from audio/fineSamples
  // (decoded on demand from `fine`; one sample cached, ≤ 256 MiB). While
  // they decode, level 0 is drawn stretched; a file too big for them stops
  // the zoom at 256 frames per pixel with a note; a failed decode keeps the
  // peaks.
  //
  // Drawing (all inside the shared frame loop, never through Svelte state).
  // The view is in the loop only while it has work (waveDriver.ts): a
  // change kicks it in, and it leaves once nothing is dirty and `live`
  // (playback) is off, so a stopped, idle waveform costs no frames.
  //   - the waveform is rendered into an offscreen buffer only when the
  //     zoom, the scroll, the data or the size changes;
  //   - the visible canvas is that buffer plus the caller's `overlay`,
  //     recomposited when `overlayKey` changes (no waveform recompute);
  //   - the playhead is a 1 px element moved with a CSS transform by the
  //     frame-loop consumer, so playback never redraws a canvas.
  //   Stereo is two lanes. Below 1 frame per device pixel a line runs through
  //   the samples, with dots from 6 px per sample; a sample at |x| >= 1 is
  //   marked red at its lane's edges (columns: only when drawn from floats,
  //   the peaks clamp at full scale).
  //
  // Controls: ⌘/Ctrl-wheel or a trackpad pinch (Chrome/Firefox send a
  // ctrl-wheel; Safari's gesture events are handled too) zooms at the
  // pointer; the wheel or Shift-wheel scrolls (while the whole file is shown
  // a vertical wheel passes to the panel, a horizontal swipe is swallowed so
  // it never navigates back); a double-click fits. Focused (Tab): + / -
  // zoom at the centre, ← / → scroll (Shift: a page), 0 fits
  // (waveMath.keyView). It is a slider for assistive tech: aria-valuenow is
  // the scroll position (%), aria-valuetext the visible span and where it
  // starts. The readout shows the span ("1.25 s", "2.6 ms · 125 samples").
  //
  // The decoded floats are held (fineSamples.retain) while mounted with the
  // same sample; the last view to let go releases them.
  //
  // Test hooks: the canvas's data-draw ('none' | 'peaks' | 'floats' |
  // 'line' | 'dots') and data-fpp (frames per CSS px); the readout is
  // `wave-zoom-text`.
  import { onMount } from 'svelte';
  import { THEME } from '../theme';
  import type { Snippet } from 'svelte';
  import { fineSamples } from '../../audio/fineSamples';
  import type { FineRequest } from '../../audio/fineSamples';
  import { frameLoop } from './frameLoop';
  import { createWaveDriver } from './waveDriver';
  import type { WaveDriver } from './waveDriver';
  import {
    FINE_FPP, MIN_FPP, clampView, columns, fitView, keyView, sampleAt, scrollBy, spanText, zoomAt,
  } from './waveMath';
  import type { FrameMap, Limits, View, WaveOverlay, WaveSource } from './waveMath';

  let {
    base, map, fine, height, color, testid, label,
    overlay = null, overlayKey = '', playhead = null, live = false, onview = null, children,
  }: {
    /** The sample's axis and peaks (waveMath.waveBase), or null: nothing to draw. */
    base: WaveSource | null;
    /** View frames -> file frames (fileMap, clipMap). */
    map: FrameMap;
    /** How to get the floats (`key` names the sample at the decode rate), or null. */
    fine: (FineRequest & { key: string }) | null;
    height: number;
    color: string;
    testid: string;
    label: string;
    overlay?: ((ctx: CanvasRenderingContext2D, o: WaveOverlay) => void) | null;
    /** Changes when what `overlay` draws changes. */
    overlayKey?: string;
    /** The playhead's view frame now, or null (hidden); polled every frame. */
    playhead?: (() => number | null) | null;
    /** Playback is running: stay in the frame loop to move the playhead. */
    live?: boolean;
    /** Told the view (and the CSS width) whenever it changes, for DOM handles drawn over the canvas. */
    onview?: ((v: View, width: number) => void) | null;
    /** DOM laid over the canvas (the Clip tab's handles). */
    children?: Snippet;
  } = $props();

  let wrap: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let headEl: HTMLDivElement;
  let readoutEl: HTMLSpanElement;
  let noteEl: HTMLSpanElement;
  const buf = typeof document !== 'undefined' ? document.createElement('canvas') : null;

  let cssW = 0;
  let dpr = 1;
  let view: View = { frame0: 0, framesPerPx: 1 };
  /** Showing everything: a length change refits instead of clamping. */
  let fitted = true;
  let dirtyWave = true;
  let dirtyComp = true;
  let shownHead = NaN;
  let driver: WaveDriver | null = null;
  /** The waveform must be rebuilt / only the overlay recomposited; both join the frame loop. */
  const markWave = () => {
    dirtyWave = true;
    driver?.kick();
  };
  const markComp = () => {
    dirtyComp = true;
    driver?.kick();
  };

  const fs = fineSamples();
  const status = () => (fine ? fs.status(fine.key) : 'none');
  /** No floats can come: zoom stops at FINE_FPP per device pixel. */
  const blocked = () => !fine || !fs.fits(fine.floats) || status() === 'too-big' || status() === 'failed';
  const tooBig = () => !!fine && (!fs.fits(fine.floats) || status() === 'too-big');
  const limits = (): Limits => ({ frames: map.end, width: Math.max(1, cssW), minFpp: blocked() ? FINE_FPP * dpr : MIN_FPP });

  function setView(v: View) {
    const lim = limits();
    view = clampView(v, lim);
    fitted = view.framesPerPx >= fitView(lim.frames, lim.width, lim.minFpp).framesPerPx - 1e-9 && view.frame0 === 0;
    markWave();
  }

  // Any input change redraws (the frame loop picks it up).
  $effect(() => {
    void base; void map; void fine?.key; void height; void color;
    markWave();
  });
  $effect(() => {
    void overlayKey; void overlay;
    markComp();
  });
  $effect(() => {
    if (live) driver?.kick();
  });
  // Hold this sample's floats while shown; the last view to let go frees them.
  // Depends on the key only: a peaksVersion bump makes a new `fine` object
  // with the same key and must not release and re-decode.
  const fineKey = $derived(fine?.key ?? null);
  $effect(() => {
    if (fineKey) return fs.retain(fineKey);
  });

  function size(c: HTMLCanvasElement, w: number, h: number) {
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
  }

  function render() {
    dirtyWave = false;
    dirtyComp = true;
    if (!buf || cssW <= 0) return;
    const lim = limits();
    view = fitted ? fitView(lim.frames, lim.width, lim.minFpp) : clampView(view, lim);
    onview?.(view, cssW);
    const W = Math.round(cssW * dpr);
    const H = Math.round(height * dpr);
    size(buf, W, H);
    size(canvas, W, H);
    const ctx = buf.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const span = base ? spanText(cssW * view.framesPerPx, base.rate) : '';
    readoutEl.textContent = span;
    const room = map.end - cssW * view.framesPerPx;
    wrap.setAttribute('aria-valuenow', String(room > 0 ? Math.round((view.frame0 / room) * 100) : 0));
    wrap.setAttribute('aria-valuetext', base ? `${span} visible from ${(view.frame0 / base.rate).toFixed(3)} s` : 'no audio');
    noteEl.hidden = !(tooBig() && view.framesPerPx <= FINE_FPP * dpr * 1.0001);
    canvas.dataset.fpp = String(view.framesPerPx);
    if (!base) {
      canvas.dataset.draw = 'none';
      return;
    }
    const dv: View = { frame0: view.frame0, framesPerPx: view.framesPerPx / dpr };
    // Floats wanted and none yet: start the decode (the subscription redraws).
    if (fine && dv.framesPerPx < FINE_FPP && !blocked() && status() === 'none') void fs.load(fine.key, fine);
    const src: WaveSource = { ...base, floats: fine ? fs.channels(fine.key) : null };
    const lanes = base.channels >= 2 ? 2 : 1;
    const laneH = H / lanes;
    const pad = Math.max(1, Math.round(dpr));
    const amp = laneH / 2 - pad;
    const mark = Math.max(2, Math.round(2 * dpr));
    // Centre lines and the lane divider: --line, faded.
    ctx.fillStyle = THEME.line;
    ctx.globalAlpha = 0.6;
    for (let l = 0; l < lanes; l++) ctx.fillRect(0, Math.round(l * laneH + laneH / 2), W, 1);
    if (lanes === 2) {
      ctx.fillRect(0, Math.round(laneH), W, 1);
    }
    ctx.globalAlpha = 1;

    if (src.floats && dv.framesPerPx < 1) {
      // A line through the samples (dots from 6 CSS px per sample).
      const dots = view.framesPerPx <= 1 / 6;
      canvas.dataset.draw = dots ? 'dots' : 'line';
      const f0 = Math.max(0, Math.floor(dv.frame0));
      const f1 = Math.min(Math.ceil(map.end), Math.ceil(dv.frame0 + W * dv.framesPerPx) + 1);
      const tmp = [0, 0, 0, 0];
      const r = 1.75 * dpr;
      for (let l = 0; l < lanes; l++) {
        const mid = l * laneH + laneH / 2;
        const top = l * laneH;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, dpr);
        ctx.beginPath();
        let pen = false;
        for (let f = f0; f < f1; f++) {
          const v = sampleAt(src, map, f, l, tmp);
          if (v === null) {
            pen = false;
            continue;
          }
          const x = (f - dv.frame0) / dv.framesPerPx;
          const y = mid - Math.max(-1, Math.min(1, v)) * amp;
          if (pen) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          pen = true;
        }
        ctx.stroke();
        for (let f = f0; f < f1; f++) {
          const v = sampleAt(src, map, f, l, tmp);
          if (v === null) continue;
          const x = (f - dv.frame0) / dv.framesPerPx;
          if (dots) {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, mid - Math.max(-1, Math.min(1, v)) * amp, r, 0, Math.PI * 2);
            ctx.fill();
          }
          if (v >= 1 || v <= -1) {
            ctx.fillStyle = THEME.rec;
            ctx.fillRect(Math.round(x - mark / 2), top, mark, mark);
            ctx.fillRect(Math.round(x - mark / 2), top + laneH - mark, mark, mark);
          }
        }
      }
      return;
    }

    const cols = columns(src, dv, W, map);
    canvas.dataset.draw = cols.kind;
    for (let l = 0; l < lanes; l++) {
      const mid = l * laneH + laneH / 2;
      const top = l * laneH;
      ctx.fillStyle = color;
      const lo = cols.lo[l];
      const hi = cols.hi[l];
      for (let x = 0; x < W; x++) {
        if (!cols.has[x]) continue;
        const y0 = Math.floor(mid - Math.min(1, hi[x]) * amp);
        const y1 = Math.ceil(mid - Math.max(-1, lo[x]) * amp);
        ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
      ctx.fillStyle = THEME.rec;
      for (let x = 0; x < W; x++) {
        if (!cols.over[x]) continue;
        ctx.fillRect(x, top, 1, mark);
        ctx.fillRect(x, top + laneH - mark, 1, mark);
      }
    }
  }

  function composite() {
    dirtyComp = false;
    if (!buf || cssW <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(buf, 0, 0);
    if (overlay && base) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const v = view;
      overlay(ctx, {
        view: v, width: cssW, height, lanes: base.channels >= 2 ? 2 : 1,
        x: (f) => (f - v.frame0) / v.framesPerPx,
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    shownHead = NaN; // the view may have moved
  }

  /** The frame-loop consumer: redraw what is dirty, then move the playhead. */
  function tick() {
    if (dirtyWave) render();
    if (dirtyComp) composite();
    const f = playhead?.() ?? null;
    const x = f === null ? NaN : (f - view.frame0) / view.framesPerPx;
    const on = x >= 0 && x <= cssW;
    const px = on ? Math.round(x * dpr) / dpr : NaN;
    if (px !== shownHead && !(Number.isNaN(px) && Number.isNaN(shownHead))) {
      shownHead = px;
      headEl.style.display = on ? '' : 'none';
      if (on) headEl.style.transform = `translateX(${px}px)`;
    }
  }

  function wheel(e: WheelEvent) {
    if (!base) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? cssW : 1;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const lim = limits();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      // Pinch deltas are small, wheel notches ~100: e^(0.01·d), at most 2× per event.
      const factor = Math.min(2, Math.max(0.5, Math.exp(e.deltaY * unit * 0.01)));
      setView(zoomAt(view, px, factor, lim));
      return;
    }
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    // Fitted: a vertical wheel scrolls the panel; a horizontal swipe is
    // swallowed (it would navigate back).
    if (fitted && !horizontal) return;
    e.preventDefault();
    setView(scrollBy(view, (horizontal ? e.deltaX : e.deltaY) * unit, lim));
  }

  // Safari's trackpad pinch (GestureEvent: scale since gesturestart).
  type Gesture = Event & { scale: number; clientX?: number };
  let pinch: { view: View; px: number } | null = null;
  function gestureStart(e: Event) {
    e.preventDefault();
    const g = e as Gesture;
    const rect = canvas.getBoundingClientRect();
    pinch = { view, px: g.clientX !== undefined ? g.clientX - rect.left : cssW / 2 };
  }
  function gestureChange(e: Event) {
    e.preventDefault();
    const g = e as Gesture;
    if (pinch && base && g.scale > 0) setView(zoomAt(pinch.view, pinch.px, 1 / g.scale, limits()));
  }
  const gestureEnd = () => (pinch = null);

  function key(e: KeyboardEvent) {
    if (!base || e.metaKey || e.ctrlKey || e.altKey) return;
    const v = keyView(view, e.key, e.shiftKey, limits());
    if (!v) return;
    e.preventDefault();
    if (e.key === '0') fit();
    else setView(v);
  }

  function fit() {
    fitted = true;
    markWave();
  }

  /** Device pixel ratio, re-read when it changes (a window moved to another display, browser zoom). */
  function watchDpr(): () => void {
    let mq: MediaQueryList | null = null;
    const on = () => {
      mq?.removeEventListener('change', on);
      const d = Math.max(1, Math.round(window.devicePixelRatio || 1));
      if (d !== dpr) {
        dpr = d;
        markWave();
      }
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', on);
    };
    on();
    return () => mq?.removeEventListener('change', on);
  }

  onMount(() => {
    const d = createWaveDriver({
      loop: frameLoop(), el: wrap, frame: tick,
      idle: () => !dirtyWave && !dirtyComp && !live,
    });
    driver = d;
    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      if (w !== cssW) {
        cssW = w;
        markWave();
      }
    });
    ro.observe(wrap);
    cssW = wrap.clientWidth;
    const offDpr = watchDpr();
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('gesturestart', gestureStart);
    canvas.addEventListener('gesturechange', gestureChange);
    canvas.addEventListener('gestureend', gestureEnd);
    const offFine = fs.subscribe(markWave);
    d.kick();
    return () => {
      d.stop();
      driver = null;
      ro.disconnect();
      offDpr();
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('gesturestart', gestureStart);
      canvas.removeEventListener('gesturechange', gestureChange);
      canvas.removeEventListener('gestureend', gestureEnd);
      offFine();
    };
  });
</script>

<div
  class="wv" bind:this={wrap} data-testid={testid} style:height="{height}px"
  role="slider" tabindex="0" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}
  title="⌘/Ctrl-wheel or pinch: zoom · wheel: scroll · double-click: fit · keys: + − ← → 0"
  onkeydown={key}
>
  <canvas bind:this={canvas} style:height="{height}px" aria-hidden="true" ondblclick={fit}></canvas>
  <div class="ph" bind:this={headEl} style="display: none" aria-hidden="true"></div>
  <span class="readout" data-testid="wave-zoom-text" bind:this={readoutEl}></span>
  <span class="note" bind:this={noteEl} hidden>Sample-level zoom: files up to 256 MB</span>
  {@render children?.()}
</div>

<style>
  .wv { position: relative; width: 100%; overflow: hidden; background: var(--lcd); border-radius: var(--r-sm); box-shadow: var(--well-shadow); box-sizing: border-box; }
  .wv:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  canvas { display: block; width: 100%; }
  .ph { position: absolute; top: 0; left: 0; width: 1px; height: 100%; background: var(--text); pointer-events: none; will-change: transform; }
  .readout, .note {
    position: absolute; top: 2px; padding: 0 4px; border-radius: 2px; background: color-mix(in srgb, var(--lcd) 85%, transparent);
    font: 10px/1.4 var(--font-mono); pointer-events: none; white-space: nowrap;
  }
  .readout { right: 2px; color: var(--text-2); }
  .note { left: 2px; color: var(--accent); }
  .note[hidden] { display: none; }
</style>
