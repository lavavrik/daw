<script lang="ts">
  // The Sample Player's sample (plan 15 Task 5; maths in sampleStrip.ts):
  // the whole file as a 220×48 waveform, under the panel's sample dropdown,
  // with the region the voice plays:
  //   Start (green)       where a note starts;
  //   End (red)           where it stops (loop off) / the loop's end;
  //   Loop start (yellow) where the sustain loop jumps back to; only while
  //                       Loop is On.
  // Outside [Start, End) is dimmed; the loop region is tinted while Loop is On,
  // hatched when it is shorter than the engine loops (< 20 ms: the region
  // then plays once; sampleStrip.loopTooShort), with that as its title.
  //
  // The waveform is the peaks pyramid (waveMath.columns over waveBase, the
  // same helpers the Clip tab's WaveformView uses), whole file, no zoom; it
  // is redrawn when the sample's SampleMeta (a new object per load) or the
  // pixel ratio changes, never per frame. No sample: "Drop a sample here"
  // (the panel is the drop target); an assigned id the session does not
  // know: "Sample not loaded" (sampleStrip.stripEmptyText).
  //
  // Handles: a small flag per marker (Start and End at the top, Start's
  // pointing right and End's left; Loop start at the bottom), so markers at
  // the same x stay grabbable. Each flag is a slider (aria-label "Start",
  // "End", "Loop start"; value = the param, 0..1). Drag: the value moves by
  // dx / 220 from where the marker is drawn when grabbed (drawnValue: no
  // jump on a degenerate region), clamped (sampleStrip.clampMarker: End
  // never left of Start + 1 px, Loop start at least 20 ms before End ...);
  // End dragged left past Loop start + 20 ms (Loop On) pushes Loop start
  // back with it (sampleStrip.markerChanges). Every change goes through
  // `onchange` = ModulePanel's markerChange -> `onparam` (or `onparams` for
  // End + Loop start), the knobs' path. The press..release is one undo
  // entry (history/gestures.ts brackets every pointer gesture). Escape,
  // pointercancel or a lost capture mid-drag puts the grabbed values back.
  // Keys on a focused flag (sampleStrip.keyMarker): ←/↓ −0.01, →/↑ +0.01,
  // Shift a tenth, PageDown/PageUp ∓0.1, Home/End the lowest/highest value
  // (each press its own undo entry, like a knob's).
  import { onDestroy } from 'svelte';
  import { registerDragCancel } from '../../history/gestures';
  import type { SampleMeta } from '../../state/project.svelte';
  import { THEME } from '../theme';
  import { columns, fileMap, waveBase } from '../vis/waveMath';
  import {
    drawnValue, keyMarker, loopMin, loopTooShort, markerChanges, markerXs, stripEmptyText, STRIP_H, STRIP_W,
  } from './sampleStrip';
  import type { Marker, Region } from './sampleStrip';

  let { idx, sampleId, meta, sampleRate, region, loop, color, onchange }: {
    /** The module's idx (test id `sample-strip-<idx>`). */
    idx: number;
    /** The `sample` param (-1 = none): with no meta, which empty text to show. */
    sampleId: number;
    /** The assigned sample's meta (peaks), or null: nothing assigned / unknown. */
    meta: SampleMeta | null;
    /** The engine's rate (waveBase's axis before peaks exist). */
    sampleRate: number;
    region: Region;
    loop: boolean;
    /** The waveform colour (the module's category colour). */
    color: string;
    /** Marker params that change (End may push Loop start along: both at once). */
    onchange: (changes: Partial<Region>) => void;
  } = $props();

  const W = STRIP_W;
  const H = STRIP_H;
  const FLAG_W = 9;
  const FLAG_H = 12;
  /** Marker colours (CSS: they go into style:background): start green, end red, loop start the accent. */
  const COLORS: Record<Marker, string> = { start: 'var(--play)', end: 'var(--rec)', loopStart: 'var(--accent)' };
  const LABELS: Record<Marker, string> = { start: 'Start', end: 'End', loopStart: 'Loop start' };

  const xs = $derived(markerXs(region, W));
  const markers = $derived<Marker[]>(loop ? ['start', 'end', 'loopStart'] : ['start', 'end']);
  const seconds = $derived(meta?.seconds ?? 0);
  /** The shortest loop the engine loops (20 ms + a frame), as a fraction of the file; 0 = unknown. */
  const minLoop = $derived.by(() => {
    if (!meta) return 0;
    const base = waveBase(meta, sampleRate);
    return loopMin(base.frames, sampleRate);
  });
  const tooShort = $derived(loop && loopTooShort(region, minLoop));
  const emptyText = $derived(stripEmptyText(sampleId, meta));

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
    ctx.fillStyle = THEME.text; // the centre line, faint
    ctx.globalAlpha = 0.08;
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
  /** `from`: the drawn value at the grab; `orig`: the params then (restored by a cancel); `moved`: params changed. */
  let drag: { m: Marker; from: number; x0: number; orig: Region; moved: Set<Marker>; id: number } | null = null;

  function down(e: PointerEvent, m: Marker) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection / native drag
    const el = e.currentTarget as HTMLElement;
    el.focus();
    el.setPointerCapture(e.pointerId);
    drag = { m, from: drawnValue(m, region, W), x0: e.clientX, orig: { ...region }, moved: new Set(), id: e.pointerId };
  }
  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    // No movement yet: nothing (the drawn value may differ from the param).
    if (dx === 0 && drag.moved.size === 0) return;
    const ch = markerChanges(drag.m, drag.from + dx / W, region, W, minLoop, loop);
    const keys = Object.keys(ch) as Marker[];
    if (!keys.length) return;
    for (const k of keys) drag.moved.add(k);
    onchange(ch);
  }
  function up(e: PointerEvent) {
    if (drag && e.pointerId === drag.id) drag = null;
  }
  /** Abort the drag: the grabbed values back (nothing if nothing moved). */
  function cancel() {
    if (!drag) return;
    const d = drag;
    drag = null;
    const back: Partial<Region> = {};
    for (const k of d.moved) if (region[k] !== d.orig[k]) back[k] = d.orig[k];
    if (Object.keys(back).length) onchange(back);
  }
  // Cmd/Ctrl+Z or redo mid-drag cancels the drag like Escape (history/gestures.ts).
  onDestroy(registerDragCancel(() => {
    if (!drag) return false;
    cancel();
    return true;
  }));
  function key(e: KeyboardEvent, m: Marker) {
    if (drag) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // App's Esc handlers must not also fire
        cancel();
      }
      return;
    }
    const v = keyMarker(m, region, e.key, e.shiftKey, W, minLoop);
    if (v === null) return;
    e.preventDefault(); // don't scroll the rail / page
    const ch = markerChanges(m, v, region, W, minLoop, loop);
    if (Object.keys(ch).length) onchange(ch);
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
    <div
      class="loop" class:short={tooShort} data-testid={`sample-strip-${idx}-loop`} data-short={tooShort ? '1' : null}
      title={tooShort ? 'Loop too short (< 20 ms): plays once' : null}
      style:left={`${xs.loopStart}px`} style:width={`${Math.max(0, xs.end - xs.loopStart)}px`}
    ></div>
  {/if}
  {#if emptyText}
    <span class="empty">{emptyText}</span>
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
      title={`${LABELS[m]}: ${valueText(region[m])} — drag, or ←/→ (Shift = fine), PgUp/PgDn, Home/End`}
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
  /* Tokens only: an --lcd screen in a well; the played region bright, the rest veiled. */
  .strip { position: relative; flex: none; align-self: center; border-radius: var(--r-sm); background: var(--lcd); box-shadow: var(--well-shadow); overflow: hidden; }
  canvas { position: absolute; inset: 0; display: block; }
  .dim { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--lcd) 65%, transparent); pointer-events: none; }
  .loop { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--accent) 11%, transparent); pointer-events: none; }
  /* Too short to loop: hatched, and hoverable for its title (the flags sit above it). */
  .loop.short { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 25%, transparent) 0 2px, transparent 2px 5px); pointer-events: auto; }
  .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font: var(--fs-lbl) var(--font-ui); color: var(--text-dim); pointer-events: none; }
  .line { position: absolute; top: 0; bottom: 0; width: 1px; pointer-events: none; }
  .flag { position: absolute; top: 0; box-sizing: border-box; cursor: ew-resize; touch-action: none; clip-path: polygon(0 0, 100% 0, 100% 60%, 0 100%); }
  .flag.end { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 60%); }
  .flag.bottom { top: auto; bottom: 0; clip-path: polygon(0 0, 100% 40%, 100% 100%, 0 100%); }
  .flag:focus-visible { outline: 1px solid var(--text); outline-offset: 0; clip-path: none; }
</style>
