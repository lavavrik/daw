<script lang="ts">
  // The master's stereo picture on the analyser bus (plan 12 Task 3): a
  // 120 × 120 goniometer and a horizontal correlation bar under it.
  //
  // Goniometer: the newest 2048 frames as dots, mid up and side across
  // (stereo.ts: x = (R − L)/√2, y = (L + R)/√2), at a fixed scale where the
  // circle's radius is full scale (a full-scale mono sine draws a vertical
  // line touching the circle; nothing within ±1 leaves it). Mono is a
  // vertical line, wide material a blob, an inverted side a horizontal line.
  //
  // Correlation: −1 (red, left: out of phase, cancels in mono) … 0 … +1
  // (green, right: mono), smoothed over 300 ms, with the value as text.
  //
  // Drawn straight from the bus after each analysis (≤ 30 Hz, not through
  // Svelte state), only while on screen. data-corr exposes the shown value.
  import { onMount } from 'svelte';
  import { analyserBus } from './analyserBus';
  import type { AnalyserBus } from './analyserBus';

  const S = 120;
  const R = S / 2 - 4;

  let canvas: HTMLCanvasElement;
  let bar = $state<HTMLElement | null>(null);
  let marker = $state<HTMLElement | null>(null);
  let valueEl = $state<HTMLElement | null>(null);
  let dpr = 1;
  let shown = '';
  let wasEmpty = false;

  function frame(c: CanvasRenderingContext2D) {
    c.fillStyle = '#15161a';
    c.fillRect(0, 0, S, S);
    c.strokeStyle = '#2c2e36';
    c.lineWidth = 1;
    c.beginPath();
    c.arc(S / 2, S / 2, R, 0, 2 * Math.PI);
    // The L and R axes (diagonals) and the mid / side cross.
    const d = R * Math.SQRT1_2;
    c.moveTo(S / 2 - d, S / 2 - d);
    c.lineTo(S / 2 + d, S / 2 + d);
    c.moveTo(S / 2 + d, S / 2 - d);
    c.lineTo(S / 2 - d, S / 2 + d);
    c.stroke();
    c.strokeStyle = '#25272e';
    c.beginPath();
    c.moveTo(S / 2 + 0.5, S / 2 - R);
    c.lineTo(S / 2 + 0.5, S / 2 + R);
    c.moveTo(S / 2 - R, S / 2 + 0.5);
    c.lineTo(S / 2 + R, S / 2 + 0.5);
    c.stroke();
    c.fillStyle = '#6b6e7a';
    c.font = '9px ui-sans-serif, system-ui, sans-serif';
    c.textBaseline = 'top';
    c.fillText('L', 4, 4);
    c.fillText('R', S - 9, 4);
    c.fillText('M', S / 2 + 3, 1);
  }

  function draw(bus: AnalyserBus) {
    const n = bus.gonN;
    const v = bus.correlation;
    const c = canvas.getContext('2d');
    if (!c) return;
    const want = Math.max(1, Math.round(window.devicePixelRatio || 1));
    let resized = false;
    if (want !== dpr || canvas.width !== S * want) {
      dpr = want;
      canvas.width = canvas.height = S * dpr;
      resized = true;
    }
    // Silence after silence: nothing to redraw.
    let empty = true;
    for (let i = 0; i < n && empty; i++) if (bus.gonX[i] !== 0 || bus.gonY[i] !== 0) empty = false;
    if (!(empty && wasEmpty && !resized)) {
      wasEmpty = empty;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      frame(c);
      // Full scale (√2 in point units) = the radius.
      const k = R / Math.SQRT2;
      c.fillStyle = '#7fd1ae';
      c.globalAlpha = 0.55;
      for (let i = 0; i < n; i++) {
        const x = S / 2 + bus.gonX[i] * k;
        const y = S / 2 - bus.gonY[i] * k;
        c.fillRect(x - 0.5, y - 0.5, 1, 1);
      }
      c.globalAlpha = 1;
    }
    const text = `${v > 0.005 ? '+' : v < -0.005 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
    if (text !== shown && bar && marker && valueEl) {
      shown = text;
      marker.style.left = `${((v + 1) / 2) * 100}%`;
      valueEl.textContent = text;
      bar.dataset.corr = v.toFixed(2);
    }
  }

  onMount(() => {
    const c = canvas.getContext('2d');
    if (c) {
      canvas.width = canvas.height = S;
      frame(c);
    }
    return analyserBus().subscribe({ need: 'stereo', el: canvas, draw });
  });
</script>

<div class="stereo">
  <canvas
    bind:this={canvas} style:width="{S}px" style:height="{S}px" data-testid="goniometer"
    aria-label="Master goniometer: mid up, side across; a vertical line is mono"
  ></canvas>
  <div class="side">
    <div class="lbl">Correlation <span class="val" bind:this={valueEl}>0.00</span></div>
    <div class="corr" title="Master phase correlation (300 ms): +1 mono, 0 wide, −1 out of phase (cancels in mono)">
      <span class="end">−1</span>
      <div class="track" bind:this={bar} data-testid="correlation" data-corr="0.00">
        <span class="mid"></span>
        <span class="marker" bind:this={marker} style:left="50%"></span>
      </div>
      <span class="end">+1</span>
    </div>
    <p class="hint">+1 mono · 0 wide · −1 out of phase (cancels in mono)</p>
  </div>
</div>

<style>
  .stereo { display: flex; gap: 10px; align-items: flex-start; }
  canvas { display: block; flex: none; }
  .side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; padding-top: 4px; }
  .lbl { display: flex; justify-content: space-between; font-size: 10px; color: #a3a6b3; }
  .val { color: #e6e7ec; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .corr { display: flex; align-items: center; gap: 4px; font: 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #6b6e7a; }
  .track { position: relative; flex: 1; height: 8px; border-radius: 2px; background: linear-gradient(to right, #e03131, #3a3d47 50%, #2f9e44); }
  .mid { position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: #8d90a0; }
  .marker { position: absolute; top: -3px; bottom: -3px; width: 3px; margin-left: -1.5px; border-radius: 1px; background: #f4f5f7; }
  .hint { margin: 0; font-size: 9px; line-height: 1.3; color: #6b6e7a; white-space: normal; }
</style>
