<script lang="ts">
  // A button that opens a small popover card under it (plan 25: the step
  // grid's swing presets and Humanize…, the piano roll's Humanize…). The
  // same behaviour as the pattern picker's Load popover:
  //   - the trigger toggles it; opening focuses the card's first control;
  //   - Esc closes it and puts the focus back on the trigger;
  //   - a press outside (trigger and card excluded), or the focus leaving
  //     the pair (Tab out), closes it;
  //   - keys typed in it stay in it (Space presses a button, letters never
  //     play the QWERTY piano, arrows move a slider, not the roll's notes);
  //     Cmd / Ctrl chords still reach the app (Cmd+Z).
  //
  // The parent renders the trigger itself (`trigger` snippet, spreading the
  // attrs it is given onto its button), so the button keeps the parent's
  // scoped look (the piano roll's dense toolbar buttons, the step grid's
  // .btn). `children` gets `close` for actions that end the popover.
  //
  // `float` (plan 27: the mixer strip's Presets): the card is fixed to the
  // window instead of absolutely placed under the trigger, for a trigger
  // inside a box that clips (the strip's overflow: hidden). It opens under
  // the trigger's left edge, flipped above it or shifted left when it would
  // leave the window. Since it no longer follows the trigger, a wheel outside
  // it (the mixer scrolls under it) or a resize closes it too.
  import { tick, type Snippet } from 'svelte';

  interface TriggerAttrs {
    'aria-haspopup': 'dialog';
    'aria-expanded': boolean;
    'aria-controls': string;
    onclick: () => void;
  }

  let { id, label, testid, place = 'below', float = false, trigger, children }: {
    /** The card's DOM id (aria-controls). */
    id: string;
    /** The card's accessible name. */
    label: string;
    testid: string;
    /** Where the card opens: under the trigger (a toolbar), or over it (a footer at a panel's bottom). */
    place?: 'below' | 'above';
    /** Fixed to the window (header: a trigger inside a clipping box); `place` is then ignored. */
    float?: boolean;
    trigger: Snippet<[TriggerAttrs]>;
    children: Snippet<[() => void]>;
  } = $props();

  let open = $state(false);
  let wrap = $state<HTMLElement | null>(null);
  let card = $state<HTMLElement | null>(null);
  const triggerBtn = () => wrap?.querySelector<HTMLElement>(':scope > button');

  /** The floating card's window position (float only). */
  let left = $state(0);
  let top = $state(0);
  /** Margin kept from the window's edges, and the gap to the trigger (px). */
  const EDGE = 8;
  const GAP = 6;

  async function toggle() {
    open = !open;
    if (!open) return;
    const r = float ? triggerBtn()?.getBoundingClientRect() : undefined;
    if (r) [left, top] = [r.left, r.bottom + GAP];
    await tick();
    if (r && card) {
      const [w, h] = [card.offsetWidth, card.offsetHeight];
      left = Math.max(EDGE, Math.min(r.left, innerWidth - EDGE - w));
      top = r.bottom + GAP + h > innerHeight - EDGE ? Math.max(EDGE, r.top - GAP - h) : r.bottom + GAP;
    }
    (card?.querySelector<HTMLElement>('button:not(:disabled), input') ?? card)?.focus();
  }
  function close(refocus = true) {
    open = false;
    if (refocus) triggerBtn()?.focus();
  }
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  }
  /** Tab / Shift+Tab out of the trigger + card pair closes it (a null target is left to the press rule). */
  function focusOut(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (open && to && !wrap?.contains(to)) close(false);
  }
  $effect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!wrap?.contains(e.target as Node)) close(false);
    };
    window.addEventListener('pointerdown', outside, true);
    if (!float) return () => window.removeEventListener('pointerdown', outside, true);
    const wheel = (e: WheelEvent) => {
      if (!card?.contains(e.target as Node)) close(false);
    };
    const resize = () => close(false);
    window.addEventListener('wheel', wheel, { capture: true, passive: true });
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('wheel', wheel, { capture: true });
      window.removeEventListener('resize', resize);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="popbtn" bind:this={wrap} onfocusout={focusOut}>
  {@render trigger({ 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': id, onclick: toggle })}
  {#if open}
    <div class="card" class:above={!float && place === 'above'} class:float style:left={float ? `${left}px` : undefined} style:top={float ? `${top}px` : undefined} {id} role="dialog" aria-label={label} tabindex="-1" data-testid={testid} bind:this={card} onkeydown={key}>
      {@render children(() => close())}
    </div>
  {/if}
</span>

<style>
  /* Tokens only: a --panel card with the lift, under (or over) its button, as the Load popover. */
  .popbtn { position: relative; display: inline-flex; }
  .card {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 20; width: max-content;
    display: flex; flex-direction: column; gap: 8px; padding: 10px;
    background: var(--panel); border-radius: var(--r-md); box-shadow: var(--lift); color: var(--text);
    outline: none;
  }
  .card.above { top: auto; bottom: calc(100% + 6px); }
  /* Floating: fixed to the window, on the app's menus' layer (ValuePopover's z-index). */
  .card.float { position: fixed; z-index: 60; }
</style>
