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
  // "A" badge says it is automated. aria-valuenow / -valuetext follow the
  // heard value at most 4 times a second ("−12.3 dB, automated (base 0.0
  // dB)"), the title names the base; the readout under the strip is
  // Strip.svelte's (it follows the lane the same way). A drag / key /
  // double-click first overrides the lane (Song mode) until its next point,
  // then sets the base (one undo entry); a drag and the arrows start from
  // the heard value. Escape mid-drag restores the base without a new
  // override. Right-click, the ContextMenu key or Shift+F10: "Automate" /
  // "Show automation", then "MIDI learn" / "Forget MIDI (CC 7)" (plan 14,
  // as Knob.svelte: the learn target pulses, a mapped fader shows a "CC"
  // tag `<testid>-cc` and its title (the accessible description) says "MIDI CC 7").
  import { onDestroy, untrack } from 'svelte';
  import type { MixChannelTarget } from '../../state/mixer-actions';
  import type { AutoTarget } from '../../state/project.svelte';
  import { menuItems, openAutoMenu } from '../AutoMenu.svelte';
  import { isLearning } from '../midiLearn.svelte';
  import { ariaThrottle, useAutoBus } from '../autoBus';
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
  let ariaAuto = $state<number | null>(null);
  const aria = ariaThrottle((v) => (ariaAuto = v));
  onDestroy(aria.dispose);
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
    aria.push(autoValue);
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
  // ---- MIDI learn ------------------------------------------------------------
  const learningMe = $derived(auto ? isLearning(auto.owner, auto.target) : false);
  /** The CC mapped to this fader, or null. */
  const cc = $derived(bus && auto ? bus.midiCc(auto.owner, auto.target) : null);
  const ccNote = $derived(cc !== null ? ` — MIDI CC ${cc}` : '');

  /** The control menu at (x, y), or beside the fader (keyboard); false when it would have no item. */
  function menuAt(x: number | null, y: number | null): boolean {
    if (!bus || !auto) return false;
    const items = menuItems(bus, auto.owner, auto.target);
    if (!items.automate && !items.midi) return false;
    const r = el?.getBoundingClientRect();
    openAutoMenu({ x: x ?? r?.left ?? 0, y: y ?? r?.bottom ?? 0, owner: auto.owner, target: auto.target, label: name, from: el });
    return true;
  }
  function context(e: MouseEvent) {
    // A keyboard-made contextmenu event has no pointer position: place it at the fader.
    const kbd = e.clientX === 0 && e.clientY === 0;
    if (menuAt(kbd ? null : e.clientX, kbd ? null : e.clientY)) e.preventDefault();
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
    // The old base back, without a new override (no-op if nothing was sent yet).
    if (startValue !== lastSent) {
      lastSent = startValue;
      onchange(startValue);
    }
  }
  onDestroy(flush);

  function key(e: KeyboardEvent) {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      if (!dragging && menuAt(null, null)) e.preventDefault();
      return;
    }
    if (dragging) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // App's Esc-cancels-learn must not also fire
        cancel();
      }
      return;
    }
    let v: number | null = null;
    const from = autoValue ?? value; // step from what is heard
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v = faderKeyStep(from, 1, e.shiftKey);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v = faderKeyStep(from, -1, e.shiftKey);
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
    aria-valuenow={ariaAuto ?? shown}
    aria-valuetext={ariaAuto !== null ? `${formatDb(ariaAuto)}, automated (base ${readout})` : readout}
    title={(automated
      ? `${name}: base ${readout} — Automated — dragging overrides until the next point (right-click: Show automation)`
      : `${name}: ${readout} — drag up/down (Shift = fine), double-click = 0 dB, arrows = ±1 dB${autoStatus ? ', right-click = Automate' : ''}`) + ccNote}
    data-testid={testid}
    data-auto={autoStatus ?? undefined}
    class:auto-off={automated && autoStatus !== 'on'}
    class:auto-susp={autoStatus === 'suspended'}
    class:learning={learningMe}
    data-learning={learningMe ? '' : undefined}
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
    {#if cc !== null}<span class="cc" data-testid={`${testid}-cc`} aria-hidden="true">CC</span>{/if}
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
  /* MIDI: the CC tag (top left, opposite the A badge) and the learn target's pulsing outline. */
  .cc { position: absolute; top: -2px; left: -5px; z-index: 1; font: 700 7px/10px ui-sans-serif, system-ui, sans-serif; padding: 0 2px; border-radius: 2px; background: #3d8fd6; color: #fff; pointer-events: none; }
  .fader.learning { outline: 2px solid #4fb3ff; outline-offset: 2px; animation: learn-pulse 0.9s ease-in-out infinite; }
  @keyframes learn-pulse { 50% { outline-color: rgba(79, 179, 255, 0.15); } }
  @media (prefers-reduced-motion: reduce) { .fader.learning { animation: none; } }
  .fader.auto-susp .cap { filter: grayscale(1) brightness(0.8); }
</style>
