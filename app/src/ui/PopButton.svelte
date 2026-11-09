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
  import { tick, type Snippet } from 'svelte';

  interface TriggerAttrs {
    'aria-haspopup': 'dialog';
    'aria-expanded': boolean;
    'aria-controls': string;
    onclick: () => void;
  }

  let { id, label, testid, place = 'below', trigger, children }: {
    /** The card's DOM id (aria-controls). */
    id: string;
    /** The card's accessible name. */
    label: string;
    testid: string;
    /** Where the card opens: under the trigger (a toolbar), or over it (a footer at a panel's bottom). */
    place?: 'below' | 'above';
    trigger: Snippet<[TriggerAttrs]>;
    children: Snippet<[() => void]>;
  } = $props();

  let open = $state(false);
  let wrap = $state<HTMLElement | null>(null);
  let card = $state<HTMLElement | null>(null);
  const triggerBtn = () => wrap?.querySelector<HTMLElement>(':scope > button');

  async function toggle() {
    open = !open;
    if (!open) return;
    await tick();
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
    return () => window.removeEventListener('pointerdown', outside, true);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="popbtn" bind:this={wrap} onfocusout={focusOut}>
  {@render trigger({ 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': id, onclick: toggle })}
  {#if open}
    <div class="card" class:above={place === 'above'} {id} role="dialog" aria-label={label} tabindex="-1" data-testid={testid} bind:this={card} onkeydown={key}>
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
</style>
