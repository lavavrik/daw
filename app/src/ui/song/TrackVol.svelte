<script lang="ts">
  // A track header's thin volume slider (`track-vol-<slot>`; plan 20, spec
  // §4 Playlist; TrackHeaders.svelte places one per track row, none on the
  // Master row). A skinned <input type="range"> bound to the track's mixer
  // fader: the same value and the same action as the strip's Fader (setMix
  // 'fader'), so the two always agree. Its 0..1 travel is the fader law
  // (mixMath faderPos / faderDb: 0 dB at 3/4, snapped to 0.1 dB), not
  // linear dB. --c (the track colour, inherited from the row) fills it.
  //
  // Automation (as Fader.svelte, ui/autoBus.ts): while the fader's lane
  // applies (Song mode, `data-auto="on"`) the thumb and fill ride at the
  // heard lane value, painted from the bus callback (no re-render per frame);
  // `data-auto` mirrors the status ('none' | 'on' | 'idle' | 'suspended'),
  // aria-valuetext says "…, automated (base …)" (at most 4 times a second),
  // the title names the base. A press shows what the hand sets, not the lane.
  //
  // Edits (as the Fader): a drag is one undo entry (the window's gesture
  // bracket, history/gestures.ts, spans the native press .. release); each
  // edit first overrides the lane (autoBus.touch). Escape or Cmd/Ctrl+Z
  // mid-drag (registerDragCancel) puts back the value from before the press
  // and ignores the rest of that press. The press ends on the window's
  // pointerup / pointercancel / blur or the next pointerdown anywhere, so a
  // lost release can never leave a stale press for a later Cmd+Z to
  // "restore". Arrows ±1 dB from the heard value (Shift 0.1 dB), Home −∞,
  // End +6 dB; double-click 0 dB. Chrome aligns pointer moves to frames, so
  // a drag sends at most one value per frame without the Fader's own
  // coalescing.
  //
  // Right-click, the ContextMenu key or Shift+F10 (as the Fader): the control
  // menu, "Automate" / "Show automation" and "MIDI learn" / "Forget MIDI"
  // (AutoMenu.svelte). The learn target pulses (`data-learning`), as the
  // Fader; both are the same target (the track's fader), so learning or
  // mapping one shows on the other.
  import { onDestroy, untrack } from 'svelte';
  import { registerDragCancel } from '../../history/gestures';
  import type { CommandSink } from '../../state/actions';
  import type { Project, Track } from '../../state/project.svelte';
  import { setMix } from '../../state/mixer-actions';
  import { mixParam } from '../../audio/mixerCatalog';
  import { ariaThrottle, useAutoBus } from '../autoBus';
  import { menuItems, openAutoMenu } from '../AutoMenu.svelte';
  import { isLearning } from '../midiLearn.svelte';
  import type { AutoStatus } from '../autoBus';
  import { FADER_MAX_DB, FADER_MIN_DB, faderDb, faderKeyStep, faderPos, formatDb } from '../mixer/mixMath';
  import { rangeFill } from '../rangeFill';

  let { p, engine, track }: { p: Project; engine: CommandSink; track: Track } = $props();

  const FADER = { kind: 'mix', param: 'fader' } as const;
  const bus = useAutoBus();
  /** The fader's own (base) value, dB, as the strip shows it. */
  const db = $derived(p.mixer.channels[track.id]?.params[mixParam('fader').id] ?? mixParam('fader').default);

  let el = $state<HTMLInputElement | null>(null);

  // ---- automation (as Fader.svelte) ----------------------------------------------
  let autoStatus = $state<AutoStatus | null>(null);
  /** The lane's value while it applies, else null (not reactive: paint() shows it). */
  let autoValue: number | null = null;
  let ariaAuto = $state<number | null>(null);
  const aria = ariaThrottle((v) => (ariaAuto = v));
  onDestroy(aria.dispose);
  $effect(() => {
    if (!bus) return;
    const id = track.id;
    // Untracked: the callback (it runs at once) reads and writes state this effect must not depend on.
    const off = untrack(() => bus.register(id, FADER, (v) => {
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
  const automated = $derived(autoStatus !== null && autoStatus !== 'none');

  /** The fill up to the thumb's centre (the thumb is restyled to THUMB_PX below). */
  const THUMB_PX = 10;
  const fill = (pos: number) => rangeFill(pos, THUMB_PX).fill;
  /** The thumb and fill: at the lane's value while it applies, else at the base; left alone during a press. */
  function paint() {
    const e = el;
    if (!e || press) return;
    const pos = faderPos(autoValue ?? db);
    e.value = String(pos);
    e.style.setProperty('--fill', fill(pos));
    e.dataset.autoValue = autoValue === null ? '' : String(autoValue);
    aria.push(autoValue);
  }
  $effect(() => {
    void db;
    void el;
    paint();
  });

  // ---- control menu: Automate / MIDI learn (as Fader.svelte) --------------------
  const learningMe = $derived(isLearning(track.id, FADER));
  /** The control menu at (x, y), or under the slider (keyboard); false when it would have no item. */
  function menuAt(x: number | null, y: number | null): boolean {
    if (!bus) return false;
    const items = menuItems(bus, track.id, FADER);
    if (!items.automate && !items.midi) return false;
    const r = el?.getBoundingClientRect();
    openAutoMenu({ x: x ?? r?.left ?? 0, y: y ?? r?.bottom ?? 0, owner: track.id, target: FADER, label: `${track.name} volume`, from: el });
    return true;
  }
  function context(e: MouseEvent) {
    // A keyboard-made contextmenu event has no pointer position: place it at the slider.
    const kbd = e.clientX === 0 && e.clientY === 0;
    if (menuAt(kbd ? null : e.clientX, kbd ? null : e.clientY)) e.preventDefault();
  }

  // ---- edits ---------------------------------------------------------------------
  function setVol(v: number) {
    if (v === db) return;
    bus?.touch(track.id, FADER);
    setMix(p, engine, track.id, 'fader', v);
  }
  /** The press in progress: the value before it, and whether Escape / Cmd+Z cancelled it. */
  let press: { db0: number; cancelled: boolean; end: () => void } | null = null;
  function down(e: PointerEvent) {
    press?.end(); // a press whose release was lost
    if (e.button !== 0) return;
    const end = () => {
      if (press !== p0) return;
      press = null;
      for (const t of ['pointerup', 'pointercancel', 'pointerdown']) window.removeEventListener(t, end, true);
      window.removeEventListener('blur', end);
      paint(); // the lane's value again, if it applies
    };
    const p0 = { db0: db, cancelled: false, end };
    press = p0;
    // The native slider keeps the pointer: its release can land anywhere. A
    // window capture listener added now does not see this pointerdown (it is
    // past the window), only the next one.
    for (const t of ['pointerup', 'pointercancel', 'pointerdown']) window.addEventListener(t, end, true);
    window.addEventListener('blur', end);
  }
  function input(e: Event & { currentTarget: HTMLInputElement }) {
    if (press?.cancelled) {
      e.currentTarget.value = String(faderPos(db)); // the thumb stays at the restored value
      return;
    }
    const pos = e.currentTarget.valueAsNumber;
    e.currentTarget.style.setProperty('--fill', fill(pos));
    setVol(faderDb(pos));
  }
  /** Abort the press: the value from before it; the rest of the press is ignored. False when none is on. */
  function cancel(): boolean {
    const v = press;
    if (!v || v.cancelled) return false;
    v.cancelled = true;
    // The old base back without a new override (as the Fader's Escape).
    if (db !== v.db0) setMix(p, engine, track.id, 'fader', v.db0);
    if (el) {
      el.value = String(faderPos(v.db0));
      el.style.setProperty('--fill', fill(faderPos(v.db0)));
    }
    return true;
  }
  onDestroy(registerDragCancel(cancel));
  onDestroy(() => press?.end());
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape' && press && !press.cancelled) {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    const from = autoValue ?? db; // step from what is heard
    let v: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v = faderKeyStep(from, 1, e.shiftKey);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v = faderKeyStep(from, -1, e.shiftKey);
    else if (e.key === 'Home') v = FADER_MIN_DB;
    else if (e.key === 'End') v = FADER_MAX_DB;
    if (v === null) return;
    e.preventDefault(); // not the native 0.001 step
    setVol(v);
  }
</script>

<!-- value and --fill are painted by paint() (the lane's value while it applies). -->
<input
  bind:this={el}
  type="range"
  class="vol"
  class:auto-susp={autoStatus === 'suspended'}
  class:learning={learningMe}
  data-learning={learningMe ? '' : undefined}
  min="0"
  max="1"
  step="0.001"
  data-testid={`track-vol-${track.slot}`}
  data-auto={autoStatus ?? undefined}
  aria-label={`${track.name} volume`}
  aria-valuetext={ariaAuto !== null ? `${formatDb(ariaAuto)}, automated (base ${formatDb(db)})` : formatDb(db)}
  title={automated
    ? `${track.name} volume: base ${formatDb(db)} — Automated — dragging overrides until the next point`
    : `${track.name} volume: ${formatDb(db)} (the mixer fader) — double-click: 0 dB, arrows: ±1 dB (Shift: 0.1 dB)`}
  onpointerdown={down}
  oninput={input}
  onkeydown={key}
  ondblclick={() => setVol(0)}
  oncontextmenu={context}
/>

<style>
  /* theme.css's range skin, scaled down (4 px groove, 10 px handle); the width leaves the 10 px indent. */
  .vol { display: block; box-sizing: border-box; width: calc(100% - 10px); height: 10px; margin: 0 0 0 10px; }
  .vol::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; }
  .vol::-webkit-slider-thumb { width: 10px; height: 10px; margin-top: -3px; }
  /* A suspended lane (a manual move overrides it until its next point): a grey fill, as the Fader's grey cap. */
  .vol.auto-susp { --c: var(--text-dim); }
  /* The MIDI learn target: the Fader's pulsing outline. */
  .vol.learning { outline: 2px solid var(--sig-cv); outline-offset: 2px; animation: learn-pulse 0.9s ease-in-out infinite; }
  @keyframes learn-pulse { 50% { outline-color: color-mix(in srgb, var(--sig-cv) 15%, transparent); } }
  @media (prefers-reduced-motion: reduce) { .vol.learning { animation: none; } }
</style>
