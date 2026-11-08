<script lang="ts">
  // One param control: a knob (dial) or a slider for continuous/integer
  // params. The label and the value readout are always shown (anti-goal:
  // never guess what a control is or what it is set to).
  // A choice param (wave, filter mode...) is not drawn here: Knob hands it to
  // ChoiceParam.svelte (a ChoiceSeg row, or a <select> past 6 choices), as the
  // rack's ModulePanel does directly, so a caller that passes any param def
  // (the mixer's delay time) still gets the right control.
  //
  // The dial's size is the CSS custom property --dial (default 30 px), set by
  // the caller on an ancestor: the rack's hero dials are bigger (ModulePanel).
  //
  // Slider variant (`variant="slider"`, plan 20 Task 3; spec §3): the same
  // control drawn as a label and a mono value readout on one row, and below
  // them a horizontal --well track with the fill (in `color`, with the gloss)
  // and the white handle. Everything below (typed entry, double-click reset,
  // keys, automation, menu, MIDI learn, one undo entry per drag, cancel) is
  // shared, and the root keeps the same role/name/value/testid, so tests and
  // screen readers see the same slider. Only the pointer differs, and only
  // on the track (its hit area is padded taller than the 6 px groove):
  // - a press does NOT move the value; moving CLICK_SLOP_PX (3) or more
  //   sideways makes it a relative horizontal drag, the track's width = the
  //   full range (Shift 10x finer; knobMath sliderDrag). Vertical travel never
  //   counts (knobMath isClickTravel), so a wobbly click is still a click;
  // - a press ON THE HANDLE is a drag from the first pixel and never a click:
  //   letting go of the handle without moving it changes nothing;
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
  import ChoiceParam from './ChoiceParam.svelte';
  import { dragPos, fillSpan, formatValue, fromPos, isClickTravel, keyStep, parseValue, sliderDrag, sliderPosFromX, toPos } from './knobMath';
  import type { KnobDef } from './knobMath';

  let { def, value, onchange, moduleName = '', color = 'var(--accent)', testid, note = '', auto = null, variant = 'knob' }: {
    /** A rack ParamDef or a mixer MixParamDef. */
    def: KnobDef;
    value: number;
    onchange: (v: number) => void;
    /** For the accessible name: "<module name> <label>". */
    moduleName?: string;
    /** Value-arc / fill colour (the module's category colour; any CSS colour, var() included). */
    color?: string;
    testid?: string;
    /** Extra line under the label, e.g. the mixer delay's "(max 2 s)"; "" = none. */
    note?: string;
    /** What an automation lane on this knob targets (null: not automatable here). */
    auto?: { owner: MixChannelTarget; target: AutoTarget } | null;
    /** A dial, or a horizontal slider (header comment). Choice params ignore it (ChoiceParam). */
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
  // of horizontal travel, not on the handle), and the track's width at the
  // press (the drag's full range).
  let downX = 0;
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
    // On the handle it is a drag from the start: no jump on release.
    clicking = slider && !handleEl?.contains(e.target as Node);
    trackW = railEl?.getBoundingClientRect().width ?? 0;
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    if (slider) {
      // Relative from the press: the travel accumulates from the start, but
      // nothing moves until the pointer has left the click slop.
      pos = sliderDrag(pos, e.clientX - lastX, trackW, e.shiftKey);
      lastX = e.clientX;
      if (clicking && isClickTravel(downX, e.clientX)) return;
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
</script>

{#if def.choices.length}
  <ChoiceParam {def} {value} {onchange} {moduleName} {color} {testid} {note} />
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
  /* Tokens only (spec §2–§3). The dial is --dial wide (30 px unless the caller sets it). */
  .knob { position: relative; display: flex; flex-direction: column; align-items: center; gap: 2px; width: max(56px, calc(var(--dial, 30px) + 8px)); padding: 2px 0; border-radius: var(--r-sm); cursor: ns-resize; touch-action: none; user-select: none; outline: none; }
  .knob:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
  .knob:hover .readout, .knob.dragging .readout, .knob:focus-visible .readout { color: var(--accent); }
  .dial { width: var(--dial, 30px); height: var(--dial, 30px); }
  .track, .val { fill: none; stroke-width: 3; stroke-linecap: round; }
  .track { stroke: var(--well); }
  .val { stroke: var(--c); }
  .cap { fill: var(--raised); stroke: color-mix(in srgb, var(--text) 25%, var(--raised)); stroke-width: 1; }
  .ptr { stroke: var(--text); stroke-width: 2; stroke-linecap: round; }
  /* Automated: the base (own value) tick, the A badge; grey while the lane is idle / suspended. */
  .base { stroke: var(--text); stroke-width: 1.5; stroke-linecap: round; opacity: 0.8; }
  .badge { position: absolute; top: 1px; right: 4px; width: 10px; font: 700 8px/10px var(--font-ui); text-align: center; border-radius: 3px; background: var(--c); color: var(--on-color); pointer-events: none; }
  .knob.auto-off .badge, .slider.auto-off .badge { background: var(--text-dim); }
  /* MIDI: the CC tag (top left, opposite the A badge) and the learn target's pulsing outline (cv blue: a controller). */
  .cc { position: absolute; top: 1px; left: 3px; padding: 0 2px; font: 700 7px/10px var(--font-ui); border-radius: 3px; background: var(--sig-cv); color: var(--on-color); pointer-events: none; }
  .knob.learning, .slider.learning { outline: 2px solid var(--sig-cv); outline-offset: 1px; animation: learn-pulse 0.9s ease-in-out infinite; }
  @keyframes learn-pulse { 50% { outline-color: color-mix(in srgb, var(--sig-cv) 15%, transparent); } }
  @media (prefers-reduced-motion: reduce) { .knob.learning, .slider.learning { animation: none; } }
  .knob.auto-susp .val { stroke: var(--text-dim); }
  .label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 var(--fs-lbl)/14px var(--font-ui); color: var(--text-2); }
  .note { font-size: var(--fs-lbl); color: var(--accent); white-space: nowrap; }
  .readout { min-width: 40px; padding: 0 4px; border-radius: 4px; background: var(--well); box-shadow: var(--well-shadow); font: 500 var(--fs-lbl)/14px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text); text-align: center; white-space: nowrap; }
  .readout.typeable { cursor: text; }
  /* The heard (automated) value: italic in the knob's colour. */
  .readout.auto { font-style: italic; color: var(--c); }
  .readout.entry { width: 56px; min-width: 0; box-sizing: border-box; border: 0; padding: 0 3px; box-shadow: var(--well-shadow), 0 0 0 1px var(--accent); outline: none; }
  .readout.entry.bad { background: color-mix(in srgb, var(--rec) 25%, var(--well)); box-shadow: var(--well-shadow), 0 0 0 1px var(--rec); }
  /* ---- slider variant ----
     Label (left) and mono value (right) on one row; below, the hit area
     (5 px padding around the 6 px --well groove: 16 px to aim at) with the
     fill in --c plus the gloss, and the handle recipe. 32 px in all. The
     horizontal padding keeps the handle inside the control at both ends. */
  /* grid-column: a full row of the module's param grid (no effect outside a grid). */
  .slider { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 112px; min-height: 28px; padding-top: 2px; border-radius: var(--r-sm); user-select: none; outline: none; grid-column: 1 / -1; }
  .slider .row { display: flex; align-items: baseline; gap: 4px; padding: 0 2px; }
  .slider .label { flex: 0 1 auto; max-width: none; }
  .slider .readout { margin-left: auto; min-width: 0; padding: 0; background: none; box-shadow: none; border-radius: 0; text-align: right; font-size: var(--fs-ctl); }
  .slider .readout.typeable:hover { color: var(--accent); }
  .slider .readout.entry { width: 64px; padding: 0 4px; border-radius: var(--r-sm); background: var(--well); box-shadow: var(--well-shadow), 0 0 0 1px var(--accent); }
  .slider .readout.entry.bad { background: color-mix(in srgb, var(--rec) 25%, var(--well)); box-shadow: var(--well-shadow), 0 0 0 1px var(--rec); }
  .slider .badge, .slider .cc { position: static; align-self: center; }
  .slider .note { padding: 0 2px; }
  .hit { padding: 5px 7px; cursor: ew-resize; touch-action: none; }
  .rail { position: relative; height: 6px; border-radius: 3px; background: var(--well); box-shadow: var(--well-shadow); }
  .fill { position: absolute; top: 0; bottom: 0; border-radius: 3px; background: var(--c) var(--gloss); }
  .slider.auto-susp .fill { background-color: var(--text-dim); }
  .handle { position: absolute; top: 50%; width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px; border-radius: 50%; background: var(--handle); box-shadow: var(--handle-shadow); cursor: grab; }
  .slider.dragging .handle { cursor: grabbing; }
  .slider:focus-visible .handle { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 45%, transparent), var(--handle-shadow); }
  /* Automated: the base (own value) tick across the groove. */
  .slider .base { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--text); opacity: 0.8; }
</style>
