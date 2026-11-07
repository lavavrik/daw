<script lang="ts">
  // Vertical channel fader in dB (catalog param "fader": −60 = −∞ .. +6).
  // The travel follows the fader law in mixMath.ts (0 dB at 3/4 height,
  // perceptual spacing), shared with the meter and scale beside it.
  //
  // Gestures (maths in mixMath.ts, unit-tested):
  // - drag the fader (anywhere on it) vertically: its height = full travel;
  //   Shift = 10x finer;
  // - double-click: 0 dB;
  // - ArrowUp/Right +1 dB, ArrowDown/Left −1 dB, Shift = 0.1 dB;
  //   Home = −∞, End = +6 dB.
  // Escape mid-drag, pointercancel or lost capture restore the pre-drag value.
  //
  // Click-safety (same as Knob.svelte): a drag sends `onchange` at most once
  // per animation frame (latest value wins) plus the final value on release.
  import { onDestroy } from 'svelte';
  import { FADER_MAX_DB, FADER_MIN_DB, faderDb, faderDrag, faderKeyStep, faderPos, formatDb } from './mixMath';

  let { value, onchange, name, height = 132, testid = 'fader' }: {
    /** dB (catalog range). */
    value: number;
    onchange: (db: number) => void;
    /** Accessible name, e.g. "Drums volume". */
    name: string;
    /** Track height in px (the drag distance for the full travel, minus the cap). */
    height?: number;
    testid?: string;
  } = $props();

  const CAP_H = 18;
  let dragging = $state(false);
  let local = $state(0);
  let pos = 0;
  let lastY = 0;
  let lastSent = NaN;
  let startValue = 0;
  let pending: number | null = null;
  let raf = 0;

  const shown = $derived(dragging ? local : value);
  const readout = $derived(formatDb(shown));
  const capBottom = $derived(faderPos(shown) * (height - CAP_H));

  function send(v: number) {
    if (v === lastSent) return;
    lastSent = v;
    onchange(v);
  }
  function flush() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (pending !== null) send(pending);
    pending = null;
  }
  function schedule(v: number) {
    pending = v;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; flush(); });
  }
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).focus();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = true;
    local = value;
    lastSent = value;
    startValue = value;
    pos = faderPos(value);
    lastY = e.clientY;
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    pos = faderDrag(pos, e.clientY - lastY, height - CAP_H, e.shiftKey);
    lastY = e.clientY;
    const v = faderDb(pos);
    if (v !== local) {
      local = v;
      schedule(v);
    }
  }
  function up() {
    if (!dragging) return;
    flush();
    send(local);
    dragging = false;
  }
  function cancel() {
    if (!dragging) return;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    pending = null;
    dragging = false;
    send(startValue);
  }
  onDestroy(flush);

  function key(e: KeyboardEvent) {
    if (dragging) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
      return;
    }
    let v: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v = faderKeyStep(value, 1, e.shiftKey);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v = faderKeyStep(value, -1, e.shiftKey);
    else if (e.key === 'Home') v = FADER_MIN_DB;
    else if (e.key === 'End') v = FADER_MAX_DB;
    if (v === null) return;
    e.preventDefault();
    if (v !== value) onchange(v);
  }
</script>

<div class="wrap">
  <div
    class="fader"
    class:dragging
    role="slider"
    tabindex="0"
    aria-label={name}
    aria-orientation="vertical"
    aria-valuemin={FADER_MIN_DB}
    aria-valuemax={FADER_MAX_DB}
    aria-valuenow={shown}
    aria-valuetext={readout}
    title={`${name}: ${readout} — drag up/down (Shift = fine), double-click = 0 dB, arrows = ±1 dB`}
    data-testid={testid}
    style:height="{height}px"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={cancel}
    onlostpointercapture={cancel}
    ondblclick={() => { if (value !== 0) onchange(0); }}
    onkeydown={key}
  >
    <div class="slot"></div>
    <div class="cap" style:bottom="{capBottom}px" style:height="{CAP_H}px"></div>
  </div>
</div>

<style>
  .wrap { display: flex; flex-direction: column; align-items: center; }
  .fader { position: relative; width: 26px; cursor: ns-resize; touch-action: none; user-select: none; outline: none; border-radius: 3px; }
  .fader:focus-visible { box-shadow: 0 0 0 1px #f0a23a; }
  .slot { position: absolute; left: 50%; top: 9px; bottom: 9px; width: 4px; margin-left: -2px; background: #0e0f12; border-radius: 2px; box-shadow: inset 0 0 0 1px #2a2c33; }
  .cap {
    position: absolute; left: 1px; right: 1px; border-radius: 3px;
    background: linear-gradient(#5b5f6c, #3b3e48 45%, #e8e9ee 48%, #e8e9ee 52%, #3b3e48 55%, #2f3139);
    box-shadow: 0 1px 2px #000a;
  }
  .fader:hover .cap, .fader.dragging .cap { filter: brightness(1.2); }
</style>
