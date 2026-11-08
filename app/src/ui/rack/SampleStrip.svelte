<script lang="ts">
  // The Sample Player's sample (plan 15 Task 5; maths in sampleStrip.ts):
  // the whole file as a 220×48 waveform, under the panel's sample dropdown,
  // with the region the voice plays:
  //   Start (green)       where a note starts;
  //   End (red)           where it stops (loop off) / the loop's end;
  //   Loop start (yellow) where the sustain loop jumps back to; only while
  //                       Loop is On.
  // Outside [Start, End) is dimmed; the loop region is tinted while Loop is On.
  //
  // The waveform is the peaks pyramid (waveMath.columns over waveBase, the
  // same helpers the Clip tab's WaveformView uses), whole file, no zoom; it
  // is redrawn when the sample's SampleMeta (a new object per load) or the
  // pixel ratio changes, never per frame. No sample (or one the session
  // doesn't know): "Drop a sample here" (the panel is the drop target).
  //
  // Handles: a small flag per marker (Start and End at the top, Start's
  // pointing right and End's left; Loop start at the bottom), so markers at
  // the same x stay grabbable. Each flag is a slider (aria-label "Start",
  // "End", "Loop start"; value = the param, 0..1). Drag: the value moves by
  // dx / 220 from where it was grabbed, clamped (sampleStrip.clampMarker:
  // End never left of Start + 1 px ...); every move goes through `onchange`
  // = ModulePanel's `onparam`, the knobs' path. The press..release is one
  // undo entry (history/gestures.ts brackets every pointer gesture).
  // Escape, pointercancel or a lost capture mid-drag puts the grabbed value
  // back. Keys on a focused flag: ←/↓ −0.01, →/↑ +0.01, Shift a tenth
  // (each press its own undo entry, like a knob's).
  import type { SampleMeta } from '../../state/project.svelte';
  import { columns, fileMap, waveBase } from '../vis/waveMath';
  import { dragMarker, markerXs, stepMarker, STRIP_H, STRIP_W } from './sampleStrip';
  import type { Marker, Region } from './sampleStrip';

  let { idx, meta, sampleRate, region, loop, color, onchange }: {
    /** The module's idx (test id `sample-strip-<idx>`). */
    idx: number;
    /** The assigned sample's meta (peaks), or null: nothing assigned / unknown. */
    meta: SampleMeta | null;
    /** The engine's rate (waveBase's axis before peaks exist). */
    sampleRate: number;
    region: Region;
    loop: boolean;
    /** The waveform colour (the module's category colour). */
    color: string;
    onchange: (m: Marker, v: number) => void;
  } = $props();

  const W = STRIP_W;
  const H = STRIP_H;
  const FLAG_W = 9;
  const FLAG_H = 12;
  const COLORS: Record<Marker, string> = { start: '#4cd07d', end: '#ff5c6a', loopStart: '#f5d142' };
  const LABELS: Record<Marker, string> = { start: 'Start', end: 'End', loopStart: 'Loop start' };

  const xs = $derived(markerXs(region, W));
  const markers = $derived<Marker[]>(loop ? ['start', 'end', 'loopStart'] : ['start', 'end']);
  const seconds = $derived(meta?.seconds ?? 0);

  // ---- waveform ------------------------------------------------------------
  let canvas: HTMLCanvasElement;
  let dpr = $state(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  $effect(() => {
    // A zoom / another screen changes the ratio: redraw sharp.
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const on = () => (dpr = window.devicePixelRatio || 1);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
  $effect(() => draw(meta, dpr, color));

  function draw(m: SampleMeta | null, ratio: number, col: string) {
    const cw = Math.round(W * ratio);
    const ch = Math.round(H * ratio);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    const base = m ? waveBase(m, sampleRate) : null;
    if (!base || !base.peaks || base.frames <= 0) {
      canvas.dataset.draw = 'none';
      return;
    }
    const cols = columns(base, { frame0: 0, framesPerPx: base.frames / cw }, cw, fileMap(base.frames));
    canvas.dataset.draw = cols.kind;
    const lanes = base.channels >= 2 ? 2 : 1;
    const laneH = ch / lanes;
    const amp = laneH / 2 - Math.max(1, Math.round(ratio));
    ctx.fillStyle = '#ffffff14';
    for (let l = 0; l < lanes; l++) ctx.fillRect(0, Math.round(l * laneH + laneH / 2), cw, 1);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.8; // the markers stay the brightest thing on the strip
    for (let l = 0; l < lanes; l++) {
      const mid = l * laneH + laneH / 2;
      const lo = cols.lo[l];
      const hi = cols.hi[l];
      for (let x = 0; x < cw; x++) {
        if (!cols.has[x]) continue;
        const y0 = Math.floor(mid - Math.min(1, hi[x]) * amp);
        const y1 = Math.ceil(mid - Math.max(-1, lo[x]) * amp);
        ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- handles ---------------------------------------------------------------
  let drag: { m: Marker; from: number; x0: number; last: number; id: number } | null = null;

  function down(e: PointerEvent, m: Marker) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection / native drag
    const el = e.currentTarget as HTMLElement;
    el.focus();
    el.setPointerCapture(e.pointerId);
    drag = { m, from: region[m], x0: e.clientX, last: region[m], id: e.pointerId };
  }
  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const v = dragMarker(drag.m, drag.from, e.clientX - drag.x0, region, W);
    if (v !== drag.last) {
      drag.last = v;
      onchange(drag.m, v);
    }
  }
  function up(e: PointerEvent) {
    if (drag && e.pointerId === drag.id) drag = null;
  }
  /** Abort the drag: the grabbed value back (nothing if nothing moved). */
  function cancel() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.last !== d.from) onchange(d.m, d.from);
  }
  function key(e: KeyboardEvent, m: Marker) {
    if (drag) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // App's Esc handlers must not also fire
        cancel();
      }
      return;
    }
    let dir: 1 | -1 | 0 = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') dir = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') dir = -1;
    if (!dir) return;
    e.preventDefault(); // don't scroll the rail
    const v = stepMarker(m, region, dir, e.shiftKey, W);
    if (v !== region[m]) onchange(m, v);
  }

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const valueText = (v: number) => (seconds > 0 ? `${pct(v)} (${(v * seconds).toFixed(3)} s)` : pct(v));
  /** The flag's left edge: Start / Loop start to the right of their line, End to the left. */
  const flagLeft = (m: Marker, x: number) => (m === 'end' ? Math.max(0, x - FLAG_W) : Math.min(W - FLAG_W, x));
  /** The 1 px line: End's on its last played pixel (the region is [start, end)). */
  const lineLeft = (m: Marker, x: number) => Math.min(W - 1, Math.max(0, m === 'end' ? x - 1 : x));
</script>

<div class="strip" data-testid={`sample-strip-${idx}`} style:width={`${W}px`} style:height={`${H}px`} style:--c={color}>
  <canvas bind:this={canvas} style:width={`${W}px`} style:height={`${H}px`} aria-hidden="true"></canvas>
  <!-- outside the played region: dimmed; the loop: tinted -->
  <div class="dim" style:left="0" style:width={`${xs.start}px`}></div>
  <div class="dim" style:left={`${xs.end}px`} style:width={`${W - xs.end}px`}></div>
  {#if loop}
    <div class="loop" style:left={`${xs.loopStart}px`} style:width={`${Math.max(0, xs.end - xs.loopStart)}px`}></div>
  {/if}
  {#if !meta}
    <span class="empty">Drop a sample here</span>
  {/if}
  {#each markers as m (m)}
    <div class="line" style:left={`${lineLeft(m, xs[m])}px`} style:background={COLORS[m]}></div>
    <div
      class="flag" class:bottom={m === 'loopStart'} class:end={m === 'end'}
      role="slider" tabindex="0"
      aria-label={LABELS[m]}
      aria-valuemin={0} aria-valuemax={1}
      aria-valuenow={Number(region[m].toFixed(4))}
      aria-valuetext={valueText(region[m])}
      title={`${LABELS[m]}: ${valueText(region[m])} — drag, or ←/→ (Shift = fine)`}
      data-testid={`sample-strip-${idx}-${m}`}
      style:left={`${flagLeft(m, xs[m])}px`}
      style:width={`${FLAG_W}px`} style:height={`${FLAG_H}px`}
      style:background={COLORS[m]}
      onpointerdown={(e) => down(e, m)}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={cancel}
      onlostpointercapture={cancel}
      onkeydown={(e) => key(e, m)}
    ></div>
  {/each}
</div>

<style>
  .strip { position: relative; flex: none; align-self: center; background: #15161a; border-radius: 2px; overflow: hidden; }
  canvas { position: absolute; inset: 0; display: block; }
  .dim { position: absolute; top: 0; bottom: 0; background: #000a; pointer-events: none; }
  .loop { position: absolute; top: 0; bottom: 0; background: #f5d1421c; pointer-events: none; }
  .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #6f7280; pointer-events: none; }
  .line { position: absolute; top: 0; bottom: 0; width: 1px; pointer-events: none; }
  .flag { position: absolute; top: 0; box-sizing: border-box; cursor: ew-resize; touch-action: none; clip-path: polygon(0 0, 100% 0, 100% 60%, 0 100%); }
  .flag.end { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 60%); }
  .flag.bottom { top: auto; bottom: 0; clip-path: polygon(0 0, 100% 40%, 100% 100%, 0 100%); }
  .flag:focus-visible { outline: 1px solid #fff; outline-offset: 0; clip-path: none; }
</style>
