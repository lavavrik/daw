<script lang="ts">
  // One param control: a knob for continuous/integer params, a segmented
  // control for choice params (wave, filter mode...). The label is always
  // under it and the value is always shown as a readout (anti-goal: never
  // guess what a control is or what it is set to).
  // (ChoiceSeg.svelte is the standalone segmented control the redesign moves
  // choice params to; plan 20 Task 3 switched the Filter's mode, Task 9 the rest.)
  //
  // Slider variant (`variant="slider"`, plan 20 Task 3; spec §3): the same
  // control drawn as a label and a mono value readout on one row, and below
  // them a horizontal --well track with the fill (in `color`, with the gloss)
  // and the white handle. Everything below (typed entry, double-click reset,
  // keys, automation, menu, MIDI learn, one undo entry per drag, cancel) is
  // shared, and the root keeps the same role/name/value/testid, so tests and
  // screen readers see the same slider. Only the pointer differs, and only
  // on the track (its hit area is padded taller than the 6 px groove):
  // - a press does NOT move the value; moving CLICK_SLOP_PX (3) or more makes
  //   it a relative horizontal drag, the track's width = the full range
  //   (Shift 10x finer; knobMath sliderDrag);
  // - a release before that is a click: the value jumps to the pointer
  //   (knobMath sliderPosFromX, against the track's live rect taken at the
  //   release, so a scrolled or zoomed container lands under the pointer).
  //   One undo entry, like a drag (history/gestures.ts brackets the press).
  //   A double-click on the track therefore makes two entries (the jump,
  //   then the reset); on the label row it is only the reset.
  // - bipolar params (min < 0 < max) fill from zero (knobMath fillSpan).
  // While automated, the fill and handle show the heard value and a thin
  // tick on the track marks the base, as the knob's ring and base tick do.
  //
  // Knob gestures (maths in knobMath.ts, unit-tested):
  // - vertical drag, 150 px = full range in the param's curve space (the
  //   fader law for fader-taper params like the sends; log for Exp params; Exp params with min 0, like glide, have a 2% "off" zone at
  //   the bottom, then go log from max/1000); Shift = 10x finer;
  // - double-click resets to the default;
  // - typed entry: click the readout (or press Enter on the focused knob),
  //   type a value ("1.2k", "250 ms", "-6", "45%", "L30" — knobMath
  //   parseValue), Enter applies, Esc cancels, clicking away applies;
  //   something that doesn't read as a value turns the field red and stays;
  // - ArrowUp/Right +1% of travel, ArrowDown/Left -1% (integers: 1 unit;
  //   fader-taper params such as the mixer sends: 1 dB, like the fader),
  //   Shift = 0.1% (0.1 dB); Home/End = min/max.
  //
  // Cancel (pointercancel, lost capture without pointerup, Escape mid-drag)
  // puts the pre-drag value back.
  //
  // Click-safety: a drag sends `onchange` at most once per animation frame
  // (the latest value wins) plus the final value on pointerup, so dragging
  // never floods the engine's command ring. The engine smooths the rest.
  //
  // Automation (plan 10 Task 4; `auto` = this knob's lane target): the knob
  // registers with the app's autoBus (ui/autoBus.ts). While its lane applies
  // the ring and pointer show the LANE's value at the heard tick (written
  // straight into the SVG by the bus's callback, no re-render per frame), a
  // small tick marks the knob's own (base) value, and an "A" badge says it
  // is automated (grey while the lane plays nothing: Pattern mode, disabled,
  // no points, or suspended; a suspended knob's ring is grey too).
  // While the lane applies the READOUT shows the heard value too, in italics
  // (written by paint(), not per-frame state), and aria-valuenow /
  // aria-valuetext ("1.2 kHz, automated (base 300 Hz)") follow it at most
  // 4 times a second; the base is in the title. The typed entry edits the
  // base (what is saved).
  // A manual move (drag, keys, typed value, double-click) first calls
  // bus.touch, which in Song mode overrides the lane until its next point
  // (AUTO_OVERRIDE), then the normal onchange: it sets the base and is
  // undoable. A drag and the arrow keys start from what is heard (the ring).
  // Escape mid-drag puts the old base back without a new override (the
  // drag's own overrides still hold until the next point: the engine has no
  // "un-override"). Right-click, the ContextMenu key or Shift+F10 opens the
  // "Automate" / "Show automation" menu (AutoMenu.svelte) on continuous
  // params; integer ones don't register and don't offer *Automate* (they
  // do offer MIDI learn, below).
  //
  // MIDI learn (plan 14 Task 3; ui/midiLearn.svelte.ts): the same menu also
  // offers "MIDI learn" / "Forget MIDI (CC 74)" on continuous AND integer
  // knobs (bus.canLearn), so an integer knob opens it too (learn only).
  // While this knob is the learn target it pulses (class `learning`; a
  // static outline under prefers-reduced-motion). A mapped knob shows a
  // small "CC" tag (`<testid>-cc`) and its title (the accessible description) says
  // "MIDI CC 74". A CC move arrives as an ordinary `value` change (the
  // router calls the same action as onchange, plus bus.touch).
  import { onDestroy, untrack } from 'svelte';
  import { registerDragCancel } from '../../history/gestures';
  import type { MixChannelTarget } from '../../state/mixer-actions';
  import type { AutoTarget } from '../../state/project.svelte';
  import { menuItems, openAutoMenu } from '../AutoMenu.svelte';
  import { isLearning } from '../midiLearn.svelte';
  import { ariaThrottle, useAutoBus } from '../autoBus';
  import type { AutoStatus } from '../autoBus';
  import { CLICK_SLOP_PX, dragPos, fillSpan, formatValue, fromPos, keyStep, parseValue, sliderDrag, sliderPosFromX, toPos } from './knobMath';
  import type { KnobDef } from './knobMath';

  let { def, value, onchange, moduleName = '', color = '#f0a23a', testid, note = '', auto = null, variant = 'knob' }: {
    /** A rack ParamDef or a mixer MixParamDef. */
    def: KnobDef;
    value: number;
    onchange: (v: number) => void;
    /** For the accessible name: "<module name> <label>". */
    moduleName?: string;
    /** Value-arc colour (the module's category colour). */
    color?: string;
    testid?: string;
    /** Extra line under the label, e.g. the mixer delay's "(max 2 s)"; "" = none. */
    note?: string;
    /** What an automation lane on this knob targets (null: not automatable here). */
    auto?: { owner: MixChannelTarget; target: AutoTarget } | null;
    /** A dial, or a horizontal slider (header comment). Choice params ignore it. */
    variant?: 'knob' | 'slider';
  } = $props();
  const slider = $derived(variant === 'slider');

  const name = $derived(`${moduleName} ${def.label}`.trim());

  // ---- automation ----------------------------------------------------------
  const bus = useAutoBus();
  /** The lane's state (changes rarely: reactive); its value changes per frame (not reactive). */
  let autoStatus = $state<AutoStatus | null>(null);
  let autoValue: number | null = null;
  let valEl = $state<SVGCircleElement | null>(null);
  let ptrEl = $state<SVGLineElement | null>(null);
  /** Slider variant: the groove (its live rect is the maths' frame), the fill and the handle. */
  let railEl = $state<HTMLElement | null>(null);
  let fillEl = $state<HTMLElement | null>(null);
  let handleEl = $state<HTMLElement | null>(null);
  /** The heard value's readout (mounted while the lane applies) and the throttled aria value. */
  let autoTextEl = $state<HTMLElement | null>(null);
  let ariaAuto = $state<number | null>(null);
  const aria = ariaThrottle((v) => (ariaAuto = v));
  onDestroy(aria.dispose);
  const autoKey = $derived(auto && !def.choices.length && !def.integer ? JSON.stringify([auto.owner, auto.target]) : null);
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
  /** Ring + pointer (slider: fill + handle) at the lane's value while it applies, else at the knob's own. */
  function paint() {
    const v = autoValue ?? (dragging ? local : value);
    const pos = toPos(def, v);
    const a = -135 + 270 * pos;
    valEl?.setAttribute('stroke-dasharray', `${(a + 135).toFixed(1)} 360`);
    ptrEl?.setAttribute('transform', `rotate(${a.toFixed(1)} 16 16)`);
    if (fillEl && handleEl) {
      const [from, to] = fillSpan(def, v);
      fillEl.style.left = `${(from * 100).toFixed(2)}%`;
      fillEl.style.width = `${((to - from) * 100).toFixed(2)}%`;
      handleEl.style.left = `${(pos * 100).toFixed(2)}%`;
    }
    if (knobEl && autoStatus) {
      knobEl.dataset.autoPos = autoValue === null ? '' : pos.toFixed(4);
      knobEl.dataset.autoValue = autoValue === null ? '' : String(autoValue);
    }
    if (autoTextEl && autoValue !== null) autoTextEl.textContent = formatValue(def, autoValue);
    aria.push(autoValue);
  }
  $effect(() => {
    void shown;
    void valEl;
    void fillEl;
    void handleEl;
    void autoTextEl;
    paint();
  });
  const automated = $derived(autoStatus !== null && autoStatus !== 'none');
  /** A manual move: override the lane first (Song mode), then the normal action. */
  function change(v: number) {
    if (bus && auto) bus.touch(auto.owner, auto.target);
    onchange(v);
  }
  // ---- MIDI learn ------------------------------------------------------------
  const learningMe = $derived(auto ? isLearning(auto.owner, auto.target) : false);
  /** The CC mapped to this knob, or null. */
  const cc = $derived(bus && auto ? bus.midiCc(auto.owner, auto.target) : null);
  const ccNote = $derived(cc !== null ? ` — MIDI CC ${cc}` : '');

  /** The control menu at (x, y), or under the knob (keyboard); false when it would have no item. */
  function menuAt(x: number | null, y: number | null): boolean {
    if (!bus || !auto) return false;
    const items = menuItems(bus, auto.owner, auto.target);
    if (!items.automate && !items.midi) return false;
    const r = knobEl?.getBoundingClientRect();
    openAutoMenu({ x: x ?? r?.left ?? 0, y: y ?? r?.bottom ?? 0, owner: auto.owner, target: auto.target, label: name, from: knobEl });
    return true;
  }
  function context(e: MouseEvent) {
    // A keyboard-made contextmenu event has no pointer position: place it at the knob.
    const kbd = e.clientX === 0 && e.clientY === 0;
    if (menuAt(kbd ? null : e.clientX, kbd ? null : e.clientY)) e.preventDefault();
  }

  // ---- drag state ------------------------------------------------------
  let dragging = $state(false);
  /** Value shown while dragging (the prop lags by up to one frame). */
  let local = $state(0);
  let pos = 0; // unrounded position, so integer params don't stick
  let lastY = 0;
  let lastX = 0;
  let lastSent = NaN;
  let startValue = 0;
  let pending: number | null = null;
  let raf = 0;
  let moved = false;
  // Slider: the press point, whether it is still a click (under CLICK_SLOP_PX
  // of travel), and the track's width at the press (the drag's full range).
  let downX = 0;
  let downY = 0;
  let clicking = false;
  let trackW = 0;

  const shown = $derived(dragging ? local : value);
  const angle = $derived(-135 + 270 * toPos(def, shown));
  const readout = $derived(formatValue(def, shown));

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

  /** Press on the knob, or on the slider's track (its hit area holds the capture). */
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection / native drag (and no default focus: done here)
    knobEl?.focus();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // An automated knob is grabbed where its ring is (the lane's value), not
    // where its base is: the hand takes over from what is heard.
    const from = autoValue ?? value;
    dragging = true;
    moved = false;
    local = from;
    lastSent = value;
    startValue = value;
    pos = toPos(def, from);
    lastY = e.clientY;
    lastX = downX = e.clientX;
    downY = e.clientY;
    clicking = slider;
    trackW = railEl?.getBoundingClientRect().width ?? 0;
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    if (slider) {
      // Relative from the press: the travel accumulates from the start, but
      // nothing moves until the pointer has left the click slop.
      pos = sliderDrag(pos, e.clientX - lastX, trackW, e.shiftKey);
      lastX = e.clientX;
      if (clicking && Math.hypot(e.clientX - downX, e.clientY - downY) < CLICK_SLOP_PX) return;
      clicking = false;
    } else {
      pos = dragPos(pos, e.clientY - lastY, e.shiftKey);
      lastY = e.clientY;
    }
    const v = fromPos(def, pos);
    if (v !== local) {
      local = v;
      moved = true;
      schedule(v);
    }
  }
  function up(e: PointerEvent) {
    if (!dragging) return;
    if (clicking && railEl) {
      // A slider click: jump to the pointer, measured on the track's rect as
      // it is now (a scrolled or zoomed rail included). Nothing was sent yet.
      dragging = false;
      send(fromPos(def, sliderPosFromX(e.clientX, railEl.getBoundingClientRect())));
      return;
    }
    flush();
    if (moved) send(local); // final value, even if a frame was still pending (a click sends nothing)
    dragging = false;
  }
  /** Abort the drag and restore the value it started from. */
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

  // Cmd/Ctrl+Z or redo mid-drag cancels the drag like Escape (history/gestures.ts).
  onDestroy(registerDragCancel(() => {
    if (!dragging) return false;
    cancel();
    return true;
  }));

  // ---- typed entry -------------------------------------------------------
  let editing = $state(false);
  let draft = $state('');
  let bad = $state(false);
  let knobEl = $state<HTMLElement | null>(null);
  function openEntry() {
    if (dragging) return;
    draft = readout;
    bad = false;
    editing = true;
  }
  /** Apply the draft; false (and stay open) when it doesn't parse. */
  function commitEntry(): boolean {
    const v = parseValue(def, draft, readout);
    if (v === null) {
      bad = true;
      return false;
    }
    editing = false;
    if (v !== value) change(v);
    return true;
  }
  function closeEntry() {
    editing = false;
    queueMicrotask(() => knobEl?.focus());
  }
  function entryKey(e: KeyboardEvent) {
    e.stopPropagation(); // letters are text here, not the QWERTY piano
    if (e.key === 'Enter') {
      e.preventDefault();
      if (commitEntry()) closeEntry();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeEntry();
    } else bad = false;
  }
  function entryBlur() {
    if (!editing) return;
    if (!commitEntry()) editing = false; // clicking away from junk: keep the old value
  }
  const selectAll = (el: HTMLInputElement) => { el.focus(); el.select(); };

  function key(e: KeyboardEvent) {
    if (editing) return;
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      if (!dragging && menuAt(null, null)) e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      openEntry();
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
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v = keyStep(def, from, 1, e.shiftKey);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v = keyStep(def, from, -1, e.shiftKey);
    else if (e.key === 'Home') v = def.min;
    else if (e.key === 'End') v = def.max;
    if (v === null) return;
    e.preventDefault(); // don't scroll the panel
    if (v !== value) change(v);
  }

  // ---- choice params -----------------------------------------------------
  // A radiogroup with roving focus: Tab reaches the selected option, arrows
  // move the selection (Space is the global play/stop key, so it is not used
  // to pick; click or Enter works).
  const choiceIdx = $derived(Math.round(value));
  let seg = $state<HTMLElement | null>(null);
  function choiceKey(e: KeyboardEvent) {
    const n = def.choices.length;
    let i: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = (choiceIdx + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = (choiceIdx - 1 + n) % n;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    if (i === null) return;
    e.preventDefault();
    if (i !== choiceIdx) onchange(i);
    queueMicrotask(() => seg?.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus());
  }
</script>

{#if def.choices.length}
  <div class="choice" data-testid={testid}>
    <div
      class="seg"
      role="radiogroup"
      tabindex="-1"
      aria-label={name}
      bind:this={seg}
      onkeydown={choiceKey}
      style:--c={color}
    >
      {#each def.choices as c, i (i)}
        <button
          type="button"
          role="radio"
          aria-checked={i === choiceIdx}
          tabindex={i === choiceIdx ? 0 : -1}
          class:on={i === choiceIdx}
          onclick={() => { if (i !== choiceIdx) onchange(i); }}
        >{c}</button>
      {/each}
    </div>
    <span class="label">{def.label}</span>
    {#if note}<span class="note" data-testid="knob-note">{note}</span>{/if}
  </div>
{:else}
  <!-- The tags, and the readout or the typed-entry field: shared by both variants. -->
  {#snippet tags()}
    {#if automated}<span class="badge" data-testid="auto-badge" aria-hidden="true">A</span>{/if}
    {#if cc !== null}<span class="cc" data-testid={testid ? `${testid}-cc` : 'knob-cc'} aria-hidden="true">CC</span>{/if}
  {/snippet}
  {#snippet readoutField()}
    {#if editing}
      <input
        class="readout entry" class:bad type="text" spellcheck="false" autocomplete="off"
        aria-label={`Type a value for ${name}`} aria-invalid={bad}
        title="Type a value, Enter to apply, Esc to cancel"
        data-testid="knob-entry"
        bind:value={draft}
        use:selectAll
        onpointerdown={(e) => e.stopPropagation()}
        ondblclick={(e) => e.stopPropagation()}
        onkeydown={entryKey}
        onblur={entryBlur}
      />
    {:else}
      <!-- Mouse shortcut only: keyboard users press Enter on the slider itself
           (same entry), so the readout needs no role or key handler. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <span
        class="readout typeable"
        class:auto={autoStatus === 'on'}
        data-testid="knob-readout"
        data-auto={autoStatus === 'on' ? 'on' : undefined}
        onpointerdown={(e) => { if (e.button === 0) { e.stopPropagation(); e.preventDefault(); } }}
        onclick={openEntry}
        ondblclick={(e) => e.stopPropagation()}
      >{#if autoStatus === 'on'}<span bind:this={autoTextEl}></span>{:else}{readout}{/if}</span>
    {/if}
  {/snippet}
  <!-- The root is the same ARIA slider in both variants (role, name, value,
       testid); the knob takes the pointer on the whole control, the slider on its track. -->
  <div
    class={slider ? 'slider' : 'knob'}
    class:dragging
    role="slider"
    tabindex="0"
    aria-label={name}
    aria-valuemin={def.min}
    aria-valuemax={def.max}
    aria-valuenow={ariaAuto ?? shown}
    aria-valuetext={ariaAuto !== null
      ? `${formatValue(def, ariaAuto)}${note ? ` ${note}` : ''}, automated (base ${readout})`
      : note ? `${readout} ${note}` : readout}
    title={(automated
      ? `${name}: base ${readout} — Automated — dragging overrides until the next point (right-click: Show automation)`
      : `${name}: ${readout} — ${slider ? 'drag left/right (Shift = fine), click the track to jump' : 'drag up/down (Shift = fine)'}, double-click = reset, click the value to type one${autoStatus ? ', right-click = Automate' : ''}`) + ccNote}
    data-testid={testid}
    data-auto={autoStatus ?? undefined}
    class:auto-on={autoStatus === 'on'}
    class:auto-off={automated && autoStatus !== 'on'}
    class:auto-susp={autoStatus === 'suspended'}
    class:learning={learningMe}
    data-learning={learningMe ? '' : undefined}
    style:--c={color}
    bind:this={knobEl}
    onpointerdown={slider ? undefined : down}
    onpointermove={slider ? undefined : move}
    onpointerup={slider ? undefined : up}
    onpointercancel={slider ? undefined : cancel}
    onlostpointercapture={slider ? undefined : cancel}
    ondblclick={() => { if (value !== def.default) change(def.default); }}
    onkeydown={key}
    oncontextmenu={context}
  >
    {#if slider}
      <div class="row">
        <span class="label">{def.label}</span>
        {@render tags()}
        {@render readoutField()}
      </div>
      <!-- The hit area: taller than the 6 px groove, which is the maths' frame.
           Pointer only: the root is the ARIA slider and takes the keys. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="hit" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={cancel} onlostpointercapture={cancel}>
        <div class="rail" bind:this={railEl} data-testid={testid ? `${testid}-track` : undefined}>
          <i class="fill" bind:this={fillEl}></i>
          {#if automated}
            <i class="base" data-testid="auto-base" style:left={`${(toPos(def, shown) * 100).toFixed(2)}%`}></i>
          {/if}
          <b class="handle" bind:this={handleEl}></b>
        </div>
      </div>
      {#if note}<span class="note" data-testid="knob-note">{note}</span>{/if}
    {:else}
      <svg class="dial" viewBox="0 0 32 32" aria-hidden="true">
        <!-- track arc (270°) and value arc, then the cap with its pointer. The
             value arc and the pointer are painted by paint() (the lane's value
             while it applies); the base tick shows the knob's own value then. -->
        <circle class="track" cx="16" cy="16" r="13" pathLength="360" stroke-dasharray="270 360" transform="rotate(135 16 16)" />
        <circle class="val" bind:this={valEl} cx="16" cy="16" r="13" pathLength="360" transform="rotate(135 16 16)" />
        {#if automated}
          <line class="base" data-testid="auto-base" x1="16" y1="1.5" x2="16" y2="5" transform={`rotate(${angle.toFixed(1)} 16 16)`} />
        {/if}
        <circle class="cap" cx="16" cy="16" r="9.5" />
        <line class="ptr" bind:this={ptrEl} x1="16" y1="16" x2="16" y2="8" />
      </svg>
      {@render tags()}
      <span class="label">{def.label}</span>
      {@render readoutField()}
      {#if note}<span class="note" data-testid="knob-note">{note}</span>{/if}
    {/if}
  </div>
{/if}

<style>
  .knob { position: relative; display: flex; flex-direction: column; align-items: center; gap: 1px; width: 56px; padding: 2px 0; border-radius: 4px; cursor: ns-resize; touch-action: none; user-select: none; outline: none; }
  .knob:focus-visible { box-shadow: 0 0 0 1px #f0a23a; }
  .knob:hover .readout, .knob.dragging .readout, .knob:focus-visible .readout { color: #fff; background: #000; }
  .dial { width: 30px; height: 30px; }
  .track, .val { fill: none; stroke-width: 2.5; stroke-linecap: round; }
  .track { stroke: #3a3d47; }
  .val { stroke: var(--c); }
  .cap { fill: #34363e; stroke: #50535e; stroke-width: 1; }
  .ptr { stroke: #e8e9ee; stroke-width: 2; stroke-linecap: round; }
  /* Automated: the base (own value) tick, the A badge; grey while the lane is idle / suspended. */
  .base { stroke: #e8e9ee; stroke-width: 1.5; stroke-linecap: round; opacity: 0.8; }
  .badge { position: absolute; top: 1px; right: 4px; font: 700 8px/10px ui-sans-serif, system-ui, sans-serif; width: 10px; text-align: center; border-radius: 2px; background: var(--c); color: #111; pointer-events: none; }
  .knob.auto-off .badge { background: #6b6e7a; }
  /* MIDI: the CC tag (top left, opposite the A badge) and the learn target's pulsing outline. */
  .cc { position: absolute; top: 1px; left: 3px; font: 700 7px/10px ui-sans-serif, system-ui, sans-serif; padding: 0 2px; border-radius: 2px; background: #3d8fd6; color: #fff; pointer-events: none; }
  .knob.learning, .slider.learning { outline: 2px solid #4fb3ff; outline-offset: 1px; animation: learn-pulse 0.9s ease-in-out infinite; }
  @keyframes learn-pulse { 50% { outline-color: rgba(79, 179, 255, 0.15); } }
  @media (prefers-reduced-motion: reduce) { .knob.learning, .slider.learning { animation: none; } }
  .knob.auto-susp .val { stroke: #7d808c; }
  .label { font-size: 10px; color: #a3a6b3; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .note { font-size: 9px; color: #f0a43a; white-space: nowrap; }
  .readout { font: 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color: #d7d9e0; background: #15161a; border-radius: 2px; padding: 0 3px; min-width: 40px; text-align: center; white-space: nowrap; }

  .readout.typeable { cursor: text; }
  /* The heard (automated) value: italic in the knob's colour. */
  .readout.auto { font-style: italic; color: var(--c); }
  .readout.entry { width: 52px; min-width: 0; box-sizing: border-box; border: 1px solid #f0a23a; color: #fff; background: #000; outline: none; padding: 0 2px; }
  .readout.entry.bad { border-color: #ff5c6a; background: #3a1418; }
  .choice { display: flex; flex-direction: column; align-items: center; gap: 2px; grid-column: 1 / -1; }
  .seg { display: flex; flex-wrap: wrap; justify-content: center; gap: 1px; background: #15161a; border-radius: 3px; padding: 1px; outline: none; }
  .seg button { font: 10px/1.2 ui-sans-serif, system-ui, sans-serif; padding: 2px 5px; border: 0; border-radius: 2px; background: transparent; color: #a3a6b3; cursor: pointer; }
  .seg button:hover { color: #fff; }
  .seg button.on { background: var(--c); color: #111; font-weight: 600; }
  .seg button:focus-visible { outline: 1px solid #f0a23a; outline-offset: 0; }
  /* ---- slider variant (spec §2–§3; tokens only) ----
     Label (left) and mono value (right) on one row; below, the hit area
     (5 px padding around the 6 px --well groove: 16 px to aim at) with the
     fill in --c plus the gloss, and the handle recipe. 32 px in all. The
     horizontal padding keeps the handle inside the control at both ends. */
  /* grid-column: a full row of the module's param grid (no effect outside a grid). */
  .slider { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 112px; min-height: 28px; padding-top: 2px; border-radius: var(--r-sm); user-select: none; outline: none; grid-column: 1 / -1; }
  .slider .row { display: flex; align-items: baseline; gap: 4px; padding: 0 2px; }
  .slider .label { flex: 0 1 auto; max-width: none; font: 500 var(--fs-lbl)/14px var(--font-ui); color: var(--text-2); }
  .slider .readout { margin-left: auto; min-width: 0; padding: 0; background: none; border-radius: 0; text-align: right; font: 500 var(--fs-ctl)/14px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text); }
  .slider .readout.typeable:hover { color: var(--accent); }
  .slider .readout.auto { color: var(--c); }
  .slider .readout.entry { width: 64px; padding: 0 4px; border: 0; border-radius: var(--r-sm); background: var(--well); box-shadow: var(--well-shadow), 0 0 0 1px var(--accent); color: var(--text); }
  .slider .readout.entry.bad { box-shadow: var(--well-shadow), 0 0 0 1px var(--rec); }
  .slider .badge, .slider .cc { position: static; align-self: center; color: var(--on-color); }
  .slider .cc { background: var(--sig-cv); }
  .slider.auto-off .badge { background: var(--text-dim); }
  .slider .note { padding: 0 2px; font-size: var(--fs-lbl); color: var(--accent); }
  .hit { padding: 5px 7px; cursor: ew-resize; touch-action: none; }
  .rail { position: relative; height: 6px; border-radius: 3px; background: var(--well); box-shadow: var(--well-shadow); }
  .fill { position: absolute; top: 0; bottom: 0; border-radius: 3px; background: var(--c) var(--gloss); }
  .slider.auto-susp .fill { background-color: var(--text-dim); }
  .handle { position: absolute; top: 50%; width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px; border-radius: 50%; background: var(--handle); box-shadow: var(--handle-shadow); }
  .slider:focus-visible .handle { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 45%, transparent), var(--handle-shadow); }
  /* Automated: the base (own value) tick across the groove. */
  .slider .base { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--text); opacity: 0.8; }
</style>
