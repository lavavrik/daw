<script lang="ts">
  // One param control: a knob for continuous/integer params, a segmented
  // control for choice params (wave, filter mode...). The label is always
  // under it and the value is always shown as a readout (anti-goal: never
  // guess what a control is or what it is set to).
  //
  // Knob gestures (maths in knobMath.ts, unit-tested):
  // - vertical drag, 150 px = full range in the param's curve space (log for
  //   Exp params; Exp params with min 0, like glide, have a 2% "off" zone at
  //   the bottom, then go log from max/1000); Shift = 10x finer;
  // - double-click resets to the default;
  // - typed entry: click the readout (or press Enter on the focused knob),
  //   type a value ("1.2k", "250 ms", "-6", "45%", "L30" — knobMath
  //   parseValue), Enter applies, Esc cancels, clicking away applies;
  //   something that doesn't read as a value turns the field red and stays;
  // - ArrowUp/Right +1% of travel, ArrowDown/Left -1% (integers: 1 unit),
  //   Shift = 0.1%; Home/End = min/max.
  //
  // Cancel (pointercancel, lost capture without pointerup, Escape mid-drag)
  // puts the pre-drag value back.
  //
  // Click-safety: a drag sends `onchange` at most once per animation frame
  // (the latest value wins) plus the final value on pointerup, so dragging
  // never floods the engine's command ring. The engine smooths the rest.
  import { onDestroy } from 'svelte';
  import { dragPos, formatValue, fromPos, keyStep, parseValue, toPos } from './knobMath';
  import type { KnobDef } from './knobMath';

  let { def, value, onchange, moduleName = '', color = '#f0a23a', testid, note = '' }: {
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
  } = $props();

  const name = $derived(`${moduleName} ${def.label}`.trim());

  // ---- drag state ------------------------------------------------------
  let dragging = $state(false);
  /** Value shown while dragging (the prop lags by up to one frame). */
  let local = $state(0);
  let pos = 0; // unrounded position, so integer params don't stick
  let lastY = 0;
  let lastSent = NaN;
  let startValue = 0;
  let pending: number | null = null;
  let raf = 0;

  const shown = $derived(dragging ? local : value);
  const angle = $derived(-135 + 270 * toPos(def, shown));
  const readout = $derived(formatValue(def, shown));

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
    e.preventDefault(); // no text selection / native drag
    (e.currentTarget as HTMLElement).focus();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = true;
    local = value;
    lastSent = value;
    startValue = value;
    pos = toPos(def, value);
    lastY = e.clientY;
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    pos = dragPos(pos, e.clientY - lastY, e.shiftKey);
    lastY = e.clientY;
    const v = fromPos(def, pos);
    if (v !== local) {
      local = v;
      schedule(v);
    }
  }
  function up() {
    if (!dragging) return;
    flush();
    send(local); // final value, even if a frame was still pending
    dragging = false;
  }
  /** Abort the drag and restore the value it started from. */
  function cancel() {
    if (!dragging) return;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    pending = null;
    dragging = false;
    send(startValue); // no-op if nothing was sent yet
  }
  onDestroy(flush);

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
    if (v !== value) onchange(v);
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
    if (e.key === 'Enter') {
      e.preventDefault();
      openEntry();
      return;
    }
    if (dragging) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
      return;
    }
    let v: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v = keyStep(def, value, 1, e.shiftKey);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v = keyStep(def, value, -1, e.shiftKey);
    else if (e.key === 'Home') v = def.min;
    else if (e.key === 'End') v = def.max;
    if (v === null) return;
    e.preventDefault(); // don't scroll the panel
    if (v !== value) onchange(v);
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
  <div
    class="knob"
    class:dragging
    role="slider"
    tabindex="0"
    aria-label={name}
    aria-valuemin={def.min}
    aria-valuemax={def.max}
    aria-valuenow={shown}
    aria-valuetext={note ? `${readout} ${note}` : readout}
    title={`${name}: ${readout} — drag up/down (Shift = fine), double-click = reset, click the value to type one`}
    data-testid={testid}
    style:--c={color}
    bind:this={knobEl}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={cancel}
    onlostpointercapture={cancel}
    ondblclick={() => { if (value !== def.default) onchange(def.default); }}
    onkeydown={key}
  >
    <svg class="dial" viewBox="0 0 32 32" aria-hidden="true">
      <!-- track arc (270°) and value arc, then the cap with its pointer -->
      <circle class="track" cx="16" cy="16" r="13" pathLength="360" stroke-dasharray="270 360" transform="rotate(135 16 16)" />
      <circle class="val" cx="16" cy="16" r="13" pathLength="360" stroke-dasharray={`${(angle + 135).toFixed(1)} 360`} transform="rotate(135 16 16)" />
      <circle class="cap" cx="16" cy="16" r="9.5" />
      <line class="ptr" x1="16" y1="16" x2="16" y2="8" transform={`rotate(${angle.toFixed(1)} 16 16)`} />
    </svg>
    <span class="label">{def.label}</span>
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
        data-testid="knob-readout"
        onpointerdown={(e) => { if (e.button === 0) { e.stopPropagation(); e.preventDefault(); } }}
        onclick={openEntry}
        ondblclick={(e) => e.stopPropagation()}
      >{readout}</span>
    {/if}
    {#if note}<span class="note" data-testid="knob-note">{note}</span>{/if}
  </div>
{/if}

<style>
  .knob { display: flex; flex-direction: column; align-items: center; gap: 1px; width: 56px; padding: 2px 0; border-radius: 4px; cursor: ns-resize; touch-action: none; user-select: none; outline: none; }
  .knob:focus-visible { box-shadow: 0 0 0 1px #f0a23a; }
  .knob:hover .readout, .knob.dragging .readout, .knob:focus-visible .readout { color: #fff; background: #000; }
  .dial { width: 30px; height: 30px; }
  .track, .val { fill: none; stroke-width: 2.5; stroke-linecap: round; }
  .track { stroke: #3a3d47; }
  .val { stroke: var(--c); }
  .cap { fill: #34363e; stroke: #50535e; stroke-width: 1; }
  .ptr { stroke: #e8e9ee; stroke-width: 2; stroke-linecap: round; }
  .label { font-size: 10px; color: #a3a6b3; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .note { font-size: 9px; color: #f0a43a; white-space: nowrap; }
  .readout { font: 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color: #d7d9e0; background: #15161a; border-radius: 2px; padding: 0 3px; min-width: 40px; text-align: center; white-space: nowrap; }

  .readout.typeable { cursor: text; }
  .readout.entry { width: 52px; min-width: 0; box-sizing: border-box; border: 1px solid #f0a23a; color: #fff; background: #000; outline: none; padding: 0 2px; }
  .readout.entry.bad { border-color: #ff5c6a; background: #3a1418; }
  .choice { display: flex; flex-direction: column; align-items: center; gap: 2px; grid-column: 1 / -1; }
  .seg { display: flex; flex-wrap: wrap; justify-content: center; gap: 1px; background: #15161a; border-radius: 3px; padding: 1px; outline: none; }
  .seg button { font: 10px/1.2 ui-sans-serif, system-ui, sans-serif; padding: 2px 5px; border: 0; border-radius: 2px; background: transparent; color: #a3a6b3; cursor: pointer; }
  .seg button:hover { color: #fff; }
  .seg button.on { background: var(--c); color: #111; font-weight: 600; }
  .seg button:focus-visible { outline: 1px solid #f0a23a; outline-offset: 0; }
</style>
