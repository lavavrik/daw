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
  //
  // Automation (plan 10 Task 4, same rules as Knob.svelte; `auto` = the
  // channel's fader target): while its lane applies the cap rides at the
  // lane's value (painted by the autoBus callback, no re-render per frame), a
  // small notch beside the slot marks the fader's own (base) value, and an
  // "A" badge says it is automated. A drag / key / double-click first
  // overrides the lane (Song mode) until its next point, then sets the base
  // (one undo entry); a drag grabs the cap where it is. Right-click:
  // "Automate" / "Show automation".
  import { onDestroy, untrack } from 'svelte';
  import type { MixChannelTarget } from '../../state/mixer-actions';
  import type { AutoTarget } from '../../state/project.svelte';
  import { openAutoMenu } from '../AutoMenu.svelte';
  import { useAutoBus } from '../autoBus';
  import type { AutoStatus } from '../autoBus';
  import { FADER_MAX_DB, FADER_MIN_DB, faderDb, faderDrag, faderKeyStep, faderPos, formatDb } from './mixMath';

  let { value, onchange, name, height = 132, testid = 'fader', auto = null }: {
    /** dB (catalog range). */
    value: number;
    onchange: (db: number) => void;
    /** Accessible name, e.g. "Drums volume". */
    name: string;
    /** Track height in px (the drag distance for the full travel, minus the cap). */
    height?: number;
    testid?: string;
    /** What an automation lane on this fader targets (null: none). */
    auto?: { owner: MixChannelTarget; target: AutoTarget } | null;
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
  let moved = false;
  let el = $state<HTMLElement | null>(null);
  let capEl = $state<HTMLElement | null>(null);

  const shown = $derived(dragging ? local : value);
  const readout = $derived(formatDb(shown));
  /** The base value's notch (shown while automated). */
  const baseBottom = $derived(faderPos(shown) * (height - CAP_H) + CAP_H / 2);

  // ---- automation ----------------------------------------------------------
  const bus = useAutoBus();
  let autoStatus = $state<AutoStatus | null>(null);
  let autoValue: number | null = null;
  const autoKey = $derived(auto ? JSON.stringify([auto.owner, auto.target]) : null);
  $effect(() => {
    if (!bus || !autoKey) return;
    const [owner, target] = JSON.parse(autoKey) as [MixChannelTarget, AutoTarget];
    // Untracked: the callback (it runs at once) reads and writes state this effect must not depend on.
    const off = untrack(() => bus.register(owner, target, (v) => {
      if (v.status !== autoStatus) autoStatus = v.status;
      autoValue = v.value;
      paint();
    }));
    return () => {
      off();
      autoValue = null;
      untrack(() => (autoStatus = null));
    };
  });
  /** The cap at the lane's value while it applies, else at the fader's own. */
  function paint() {
    const v = autoValue ?? (dragging ? local : value);
    const pos = faderPos(v);
    if (capEl) capEl.style.bottom = `${pos * (height - CAP_H)}px`;
    if (el && autoStatus) {
      el.dataset.autoPos = autoValue === null ? '' : pos.toFixed(4);
      el.dataset.autoValue = autoValue === null ? '' : String(autoValue);
    }
  }
  $effect(() => {
    void shown;
    void height;
    void capEl;
    paint();
  });
  const automated = $derived(autoStatus !== null && autoStatus !== 'none');
  function change(v: number) {
    if (bus && auto) bus.touch(auto.owner, auto.target);
    onchange(v);
  }
  function context(e: MouseEvent) {
    if (!bus || !auto || !bus.canAutomate(auto.owner, auto.target)) return;
    e.preventDefault();
    openAutoMenu({ x: e.clientX, y: e.clientY, owner: auto.owner, target: auto.target, label: name, from: el });
  }

  function send(v: number) {
    if (v === lastSent) return;
    lastSent = v;
    change(v);
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
    const from = autoValue ?? value; // grabbed where the cap is
    dragging = true;
    moved = false;
    local = from;
    lastSent = value;
    startValue = value;
    pos = faderPos(from);
    lastY = e.clientY;
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    pos = faderDrag(pos, e.clientY - lastY, height - CAP_H, e.shiftKey);
    lastY = e.clientY;
    const v = faderDb(pos);
    if (v !== local) {
      local = v;
      moved = true;
      schedule(v);
    }
  }
  function up() {
    if (!dragging) return;
    flush();
    if (moved) send(local); // a click sends nothing
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
    if (v !== value) change(v);
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
    title={automated
      ? `${name}: ${readout} — Automated — dragging overrides until the next point (right-click: Show automation)`
      : `${name}: ${readout} — drag up/down (Shift = fine), double-click = 0 dB, arrows = ±1 dB${autoStatus ? ', right-click = Automate' : ''}`}
    data-testid={testid}
    data-auto={autoStatus ?? undefined}
    class:auto-off={automated && autoStatus !== 'on'}
    class:auto-susp={autoStatus === 'suspended'}
    bind:this={el}
    style:height="{height}px"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={cancel}
    onlostpointercapture={cancel}
    ondblclick={() => { if (value !== 0) change(0); }}
    onkeydown={key}
    oncontextmenu={context}
  >
    <div class="slot"></div>
    {#if automated}
      <div class="base" data-testid="auto-base" style:bottom="{baseBottom}px"></div>
      <span class="badge" data-testid="auto-badge" aria-hidden="true">A</span>
    {/if}
    <!-- Positioned by paint(): the lane's value while it applies. -->
    <div class="cap" bind:this={capEl} style:height="{CAP_H}px"></div>
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
  /* Automated: the base notch left of the slot, the A badge (grey while the lane plays nothing), a grey cap while suspended. */
  .base { position: absolute; left: 3px; width: 6px; height: 2px; margin-bottom: -1px; background: #e8e9ee; border-radius: 1px; opacity: 0.85; }
  .badge { position: absolute; top: -2px; right: -4px; z-index: 1; font: 700 8px/10px ui-sans-serif, system-ui, sans-serif; width: 10px; text-align: center; border-radius: 2px; background: #f0a23a; color: #111; pointer-events: none; }
  .fader.auto-off .badge { background: #6b6e7a; }
  .fader.auto-susp .cap { filter: grayscale(1) brightness(0.8); }
</style>
