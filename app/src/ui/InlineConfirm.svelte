<script lang="ts">
  // Inline confirmation popover: replaces every native confirm() (the spec
  // says "no modal dialogs"). The host renders it only while a question is
  // open, passing the button that asked (`anchor`) so it sits right under it.
  //
  // Keyboard: focus starts on Cancel (the safe default); Esc cancels; Enter
  // confirms only when Confirm itself is focused (a plain button press), so a
  // stray Enter never destroys work. Focus returns to the anchor afterwards,
  // except to a <select> (the Rack's patch list): there a stray arrow key
  // would change the patch, so the keys go back to the piano instead.
  // Key events inside stop here so the global piano/transport shortcuts
  // never see them -- except undo / redo (⌘Z, ⇧⌘Z, Ctrl+Y): an undo cancels
  // every open confirm first (inlineConfirms.ts: the question was about a
  // state the undo replaces), so those keys go on to the shortcuts. Held
  // piano keys are the HOST's job: call releaseHeldKeys() before opening (a
  // popover doesn't block the thread, but a held note must not keep sounding
  // while the user decides).
  import { onDestroy, onMount } from 'svelte';
  import { registerConfirm } from './inlineConfirms';

  let {
    message,
    anchor,
    confirmLabel = 'Confirm',
    onconfirm,
    oncancel,
  }: {
    message: string;
    anchor: HTMLElement | null;
    confirmLabel?: string;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();

  // Unique per instance: two popovers (or a re-open) never share an id.
  const uid = $props.id();
  const msgId = `${uid}-msg`;
  /** A <select> anchor: pressing it cancels, and focus never returns to it. */
  const isSelect = () => anchor?.tagName === 'SELECT';

  let root: HTMLDivElement;
  let cancelBtn: HTMLButtonElement;
  let top = $state(0);
  let left = $state(0);

  const W = 280; // matches the CSS max-width

  function place() {
    const r = anchor?.getBoundingClientRect();
    if (!r) return;
    top = Math.min(r.bottom + 4, window.innerHeight - 8 - (root?.offsetHeight ?? 0));
    left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8));
  }

  onMount(() => {
    place();
    cancelBtn.focus();
    // An undo/redo cancels this as its Cancel button would (inlineConfirms.ts).
    const unregister = registerConfirm(() => oncancel());
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      // A press on a button anchor is its own click (ignored here). A press on
      // a <select> anchor would open its native list under the popover: cancel.
      if (!root.contains(t) && (!anchor?.contains(t) || isSelect())) oncancel();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', place);
    return () => {
      unregister();
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', place);
    };
  });

  // Back to the button that asked (if it still exists, e.g. not a removed track).
  onDestroy(() => {
    if (anchor?.isConnected && !isSelect()) anchor.focus({ preventScroll: true });
  });

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Tab') {
      // Keep Tab inside the two buttons (DOM order: Confirm, Cancel).
      const ok = root.querySelector<HTMLButtonElement>('.ok')!;
      if (!e.shiftKey && document.activeElement === cancelBtn) (e.preventDefault(), ok.focus());
      else if (e.shiftKey && document.activeElement === ok) (e.preventDefault(), cancelBtn.focus());
      e.stopPropagation();
      return;
    }
    // Undo / redo reach the shortcuts, which cancel this first (above).
    const undoRedo = (e.metaKey || e.ctrlKey) && !e.altKey && (e.code === 'KeyZ' || (e.code === 'KeyY' && e.ctrlKey && !e.metaKey && !e.shiftKey));
    if (undoRedo) return;
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      oncancel();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={root}
  class="ic"
  role="alertdialog"
  aria-labelledby={msgId}
  tabindex="-1"
  data-testid="inline-confirm"
  style:top="{top}px"
  style:left="{left}px"
  {onkeydown}
>
  <p id={msgId}>{message}</p>
  <div class="btns">
    <button class="ok" data-testid="inline-confirm-ok" onclick={onconfirm}>{confirmLabel}</button>
    <button bind:this={cancelBtn} data-testid="inline-confirm-cancel" onclick={oncancel}>Cancel</button>
  </div>
</div>

<style>
  /* A small --panel card with the lift (spec §2 depth recipes), placed next
     to the control that asked; the confirm button is the destructive one, in --rec. */
  .ic {
    position: fixed; z-index: 50; max-width: 280px; box-sizing: border-box; padding: 10px 12px;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: var(--lift);
    color: var(--text); font: var(--fs-ctl) var(--font-ui);
  }
  p { margin: 0 0 10px; line-height: 1.35; }
  .btns { display: flex; gap: 6px; justify-content: flex-end; }
  button {
    font: 500 var(--fs-ctl)/16px var(--font-ui); padding: 4px 12px; border: 0; border-radius: var(--r-sm);
    background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow); color: var(--text); cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  .ok { background-color: var(--rec); color: var(--on-color); font-weight: 700; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
