<script lang="ts">
  // A number field with steppers and a vertical scrub (spec §3, ui-theme.md).
  //
  // The core is a real <input type="number"> carrying the `id` and `testid`,
  // so tests that `fill` it keep working. Its native spinners are hidden; the
  // buttons around it replace them.
  //   - variant "plain": a --well field with − and + either side.
  //   - variant "lcd":   a --lcd readout with a small uppercase label above the
  //                      number and stacked ▲▼ buttons on the right (the tempo).
  //
  // How a value changes (onchange = "a committed value", once each):
  //   - typing: Enter or blur commits (clamped, rounded to `decimals`); Esc
  //     reverts the text. `oninput` (optional) reports the raw text as it is
  //     typed (null when empty or unreadable) for panels that validate live.
  //   - ArrowUp/Down, the ▲▼/−/+ buttons: one step, Shift = step / 10 (at
  //     least the smallest unit kept: 1 on an integer field). The
  //     wheel steps too, but only while the field is focused, so scrolling a
  //     panel over a field never edits it by accident.
  //   - scrub: press the value and drag vertically. The press only becomes a
  //     scrub after 3 px of travel (a plain click still focuses the input for
  //     typing); in a field that already has focus, after 6 px, and a press
  //     that goes sideways first is a text selection and never scrubs
  //     (numberField.ts pressIntent). Then 1 step per 4 px, Shift = step /
  //     10. While scrubbing only the display moves; onchange fires ONCE, on
  //     release, so the whole scrub is one undo entry (history/gestures.ts
  //     brackets every pointer press anyway). Esc, or Cmd/Ctrl+Z mid-scrub (registerDragCancel),
  //     drops the scrub: the value never changed, so there is nothing to undo.
  //   - double-click selects the text.
  import { onDestroy, tick } from 'svelte';
  import { registerDragCancel } from '../history/gestures';
  import { clampValue, decimalsOf, formatValue, pressIntent, scrubValue, stepValue } from './numberField';

  let {
    value,
    min,
    max,
    step = 1,
    decimals,
    unit = '',
    label = '',
    ariaLabel = '',
    variant = 'plain',
    testid,
    id,
    title,
    disabled = false,
    onchange,
    oninput,
  }: {
    /** The committed value (null: show an empty field). */
    value: number | null;
    min?: number;
    max?: number;
    step?: number;
    /** Max decimals shown and kept (default: what `step` needs). */
    decimals?: number;
    /** Text after the number ("ms", "beats"). */
    unit?: string;
    /** Visible label (lcd) and the base of the buttons' aria-labels. */
    label?: string;
    /** The input's accessible name when it differs from `label` (default: label). */
    ariaLabel?: string;
    variant?: 'plain' | 'lcd';
    testid?: string;
    id?: string;
    title?: string;
    disabled?: boolean;
    onchange: (v: number) => void;
    oninput?: (v: number | null) => void;
  } = $props();

  const dec = $derived(decimals ?? decimalsOf(step));
  const bounds = $derived({ min, max, decimals: dec });
  const fmt = (v: number | null) => (v === null || !Number.isFinite(v) ? '' : formatValue(v, dec));

  let inputEl = $state<HTMLInputElement | null>(null);
  /** The text being typed (null: show the value, or the scrub's live value). */
  let draft = $state<string | null>(null);
  /** The scrub's live value while scrubbing. */
  let live = $state<number | null>(null);
  const shown = $derived(draft ?? fmt(live ?? value));
  const base = $derived(value ?? min ?? 0);

  /** Put the DOM text back to the committed value (Svelte skips a write when its own expression did not change). */
  async function resync() {
    await tick();
    if (inputEl && draft === null) inputEl.value = fmt(live ?? value);
  }

  function commitValue(v: number) {
    draft = null;
    if (v !== value) onchange(v);
    void resync();
  }
  function commitDraft() {
    if (draft === null) return;
    const n = draft.trim() === '' ? NaN : Number(draft);
    if (Number.isFinite(n)) commitValue(clampValue(n, bounds));
    else {
      draft = null;
      void resync();
    }
  }
  /** What a step starts from: a readable typed draft, else the value. */
  function current(): number {
    const n = draft !== null && draft.trim() !== '' ? Number(draft) : NaN;
    return Number.isFinite(n) ? n : base;
  }
  function bump(dir: 1 | -1, fine: boolean) {
    if (disabled) return;
    commitValue(stepValue(current(), dir, step, fine, bounds));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      draft = null;
      void resync();
      inputEl?.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      bump(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
    }
  }
  function onInput(e: Event & { currentTarget: HTMLInputElement }) {
    draft = e.currentTarget.value;
    const n = draft.trim() === '' ? NaN : Number(draft);
    oninput?.(Number.isFinite(n) ? n : null);
  }

  // Wheel steps while focused. Needs preventDefault, which Svelte's passive
  // onwheel would refuse, so it is attached by hand.
  $effect(() => {
    const el = inputEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (disabled || document.activeElement !== el || e.deltaY === 0) return;
      e.preventDefault();
      bump(e.deltaY < 0 ? 1 : -1, e.shiftKey);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // ---- scrub ---------------------------------------------------------------
  let areaEl = $state<HTMLElement | null>(null);
  /** A press on the value that has not travelled far enough yet, or is scrubbing. */
  let press: { pointerId: number; x: number; y: number; v0: number; fine: boolean; scrubbing: boolean; wasFocused: boolean } | null = null;
  let scrubbing = $state(false);

  function onDown(e: PointerEvent) {
    if (disabled || !e.isPrimary || e.button !== 0) return;
    press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, v0: current(), fine: e.shiftKey, scrubbing: false, wasFocused: document.activeElement === inputEl };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onPressKey, true);
    window.addEventListener('selectstart', onSelectStart);
  }
  function onMove(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointerId) return;
    if (!press.scrubbing) {
      const intent = pressIntent(e.clientX - press.x, e.clientY - press.y, press.wasFocused);
      if (intent === 'select') {
        endPress(); // the native text selection carries on
        return;
      }
      if (intent === 'wait') return;
      press.scrubbing = true;
      scrubbing = true;
      draft = null;
      // A scrub is not typing: drop the caret/selection the press just made.
      if (!press.wasFocused) inputEl?.blur();
      getSelection()?.removeAllRanges();
      try { areaEl?.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    }
    const fine = e.shiftKey;
    if (fine !== press.fine) {
      // Shift pressed or released mid-scrub: continue from here at the new rate, no jump.
      press.v0 = live ?? press.v0;
      press.y = e.clientY;
      press.fine = fine;
    }
    live = scrubValue(press.v0, e.clientY - press.y, step, fine, bounds);
  }
  function onUp(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointerId) return;
    const p = press;
    const v = live;
    endPress();
    if (p.scrubbing && v !== null && e.type === 'pointerup') commitValue(v);
    else void resync();
  }
  function endPress() {
    press = null;
    scrubbing = false;
    live = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onPressKey, true);
    window.removeEventListener('selectstart', onSelectStart);
  }
  /** Drop the scrub and keep the old value. True when there was a scrub to drop. */
  function cancelScrub(): boolean {
    if (!press?.scrubbing) return false;
    endPress();
    void resync();
    return true;
  }
  function onPressKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && cancelScrub()) {
      e.stopPropagation();
      e.preventDefault();
    }
  }
  function onSelectStart(e: Event) {
    if (press?.scrubbing) e.preventDefault();
  }
  // Cmd/Ctrl+Z or redo mid-drag cancels the scrub like Escape (history/gestures.ts).
  onDestroy(registerDragCancel(cancelScrub));
  onDestroy(endPress);

  const name = $derived(ariaLabel || label);
</script>

<div class="nf {variant}" class:scrubbing class:disabled>
  {#if variant === 'plain'}
    <button type="button" class="step" tabindex="-1" {disabled} data-testid={testid ? `${testid}-down` : undefined}
      aria-label={`Decrease ${label || name}`} onclick={(e) => bump(-1, e.shiftKey)}>−</button>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="area" bind:this={areaEl} onpointerdown={onDown}>
    {#if variant === 'lcd' && label}<span class="lbl">{label}</span>{/if}
    <input
      bind:this={inputEl} type="number" {id} data-testid={testid} aria-label={name || undefined} {title} {disabled}
      {min} {max} {step} value={shown}
      oninput={onInput} onblur={commitDraft} onkeydown={onKey} ondblclick={(e) => e.currentTarget.select()}
    />
    {#if unit}<span class="unit">{unit}</span>{/if}
  </div>
  {#if variant === 'plain'}
    <button type="button" class="step" tabindex="-1" {disabled} data-testid={testid ? `${testid}-up` : undefined}
      aria-label={`Increase ${label || name}`} onclick={(e) => bump(1, e.shiftKey)}>+</button>
  {:else}
    <div class="stack">
      <button type="button" class="arrow" tabindex="-1" {disabled} data-testid={testid ? `${testid}-up` : undefined}
        aria-label={`Increase ${label || name}`} onclick={(e) => bump(1, e.shiftKey)}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 6.5 5 3.5l3 3" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>
      </button>
      <button type="button" class="arrow" tabindex="-1" {disabled} data-testid={testid ? `${testid}-down` : undefined}
        aria-label={`Decrease ${label || name}`} onclick={(e) => bump(-1, e.shiftKey)}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5l3-3" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>
      </button>
    </div>
  {/if}
</div>

<style>
  .nf { display: inline-flex; align-items: stretch; overflow: hidden; vertical-align: middle; }
  .nf.disabled { opacity: 0.5; }
  .area { display: flex; position: relative; min-width: 0; touch-action: none; cursor: ns-resize; }
  .nf.scrubbing, .nf.scrubbing * { user-select: none; }
  input {
    box-sizing: border-box; width: 100%; min-width: 0; margin: 0; border: 0; border-radius: 0;
    background: transparent; box-shadow: none; color: var(--text); text-align: center;
    appearance: textfield; -moz-appearance: textfield;
  }
  input::-webkit-inner-spin-button, input::-webkit-outer-spin-button { appearance: none; margin: 0; }
  input:focus { cursor: text; }
  input:focus-visible { outline: none; }
  .nf:has(input:focus-visible) { box-shadow: var(--well-shadow), 0 0 0 2px var(--accent); }

  /* plain: a --well field, − and + either side */
  .plain { background: var(--well); box-shadow: var(--well-shadow); border-radius: var(--r-md); }
  .plain input { width: 56px; padding: 4px 2px; font: 500 var(--fs-ctl) var(--font-mono); }
  .plain .unit { align-self: center; padding-right: 6px; color: var(--text-dim); font-size: var(--fs-lbl); }
  .step {
    width: 24px; border: 0; padding: 0; background: transparent; color: var(--text);
    font: 500 15px var(--font-ui); cursor: pointer;
  }
  .step:hover:not(:disabled), .arrow:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 10%, transparent); }
  .step:disabled, .arrow:disabled { cursor: default; }

  /* lcd: label above a big mono number, stacked arrows on the right */
  .lcd { background: var(--lcd); box-shadow: var(--well-shadow); border-radius: var(--r-md); height: 44px; }
  .lcd .area { flex-direction: column; justify-content: center; padding: 0 6px 0 12px; }
  .lcd .lbl {
    position: absolute; top: 4px; left: 12px; pointer-events: none;
    color: var(--text-dim); font: 600 9px var(--font-ui); letter-spacing: 0.08em; text-transform: uppercase;
  }
  .lcd input { width: 78px; padding: 12px 0 0; text-align: left; font: 700 18px var(--font-mono); color: var(--text); }
  .lcd .unit { position: absolute; right: 8px; bottom: 6px; color: var(--text-dim); font: 500 var(--fs-lbl) var(--font-mono); pointer-events: none; }
  .stack { display: flex; flex-direction: column; border-left: 1px solid var(--work); }
  .arrow { flex: 1; width: 22px; border: 0; padding: 0; background: transparent; color: var(--text-2); cursor: pointer; }
  .arrow + .arrow { border-top: 1px solid var(--work); }
</style>
