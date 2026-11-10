<script lang="ts">
  // A grab strip that resizes a pane (ui/paneWidths.svelte.ts): vertical
  // (axis 'x', the default) for the library sidebar's right edge (App) and the
  // track header column's right edge (Timeline); horizontal (axis 'y', plan
  // 30) for the song area's bottom edge over the bottom panel (App), where
  // ↑/↓ replace ←/→ and `measure` gives the size the drag starts from (the
  // stored one may be "auto" or clamped by the CSS). A focusable window-splitter (role="separator",
  // aria-orientation="vertical", aria-valuenow = the width), like the lane
  // height strip in TrackHeaders:
  //   - drag: the width follows the pointer live (clamped); saved on release;
  //   - double-click: back to the default width;
  //   - ←/→: 8 px (Shift: 1 px), saved at once;
  //   - Escape, a lost pointer capture, or Cmd/Ctrl+Z mid-drag
  //     (registerDragCancel) put back the width from before the drag;
  //     unmounting mid-drag does too.
  // The parent places it (position: absolute + its own left/top/bottom via
  // `style`, which may also set a width); it is 7 px wide by default and
  // draws a 2 px accent line in its middle on hover / drag / focus. A width is UI state: no undo entry, not dirty.
  import { onDestroy } from 'svelte';
  import { registerDragCancel } from '../history/gestures';
  import { PANES, paneWidths, setPaneWidth, type PaneId } from './paneWidths.svelte';

  let { pane, label, testid, style = '', axis = 'x', measure }: {
    pane: PaneId; label: string; testid: string; style?: string;
    axis?: 'x' | 'y';
    /** The pane's rendered size now (px); default: the stored one. */
    measure?: () => number;
  } = $props();
  const pos = (e: PointerEvent) => (axis === 'x' ? e.clientX : e.clientY);
  const size = () => measure?.() ?? paneWidths[pane];

  const def = $derived(PANES[pane]);
  /** The drag in progress: the press's x and the width before it. */
  let drag = $state<{ x0: number; w0: number } | null>(null);

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection, no native drag
    const el = e.currentTarget as HTMLElement;
    el.focus({ preventScroll: true }); // Escape reaches key()
    drag = { x0: pos(e), w0: size() };
    el.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (drag) setPaneWidth(pane, drag.w0 + pos(e) - drag.x0, false);
  }
  function up() {
    if (!drag) return;
    drag = null; // first: the lostpointercapture that follows must not cancel
    setPaneWidth(pane, paneWidths[pane]); // save where it ended
  }
  /** Abort the drag: the width from before it. False when no drag was on. */
  function cancel(): boolean {
    const d = drag;
    if (!d) return false;
    drag = null;
    setPaneWidth(pane, d.w0, false);
    return true;
  }
  const unregister = registerDragCancel(cancel);
  onDestroy(() => {
    cancel();
    unregister();
  });
  function key(e: KeyboardEvent) {
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape' && drag) {
      take();
      cancel();
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      const [less, more] = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (e.key !== less && e.key !== more) return;
      take();
      const step = e.shiftKey ? 1 : 8;
      setPaneWidth(pane, size() + (e.key === more ? step : -step));
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
<div
  class="split"
  class:y={axis === 'y'}
  class:on={drag !== null}
  role="separator"
  aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
  aria-valuenow={paneWidths[pane] || undefined}
  aria-valuemin={def.min}
  aria-valuemax={def.max}
  aria-label={label}
  tabindex="0"
  data-testid={testid}
  title={axis === 'x'
    ? `Drag to resize · double-click: default width (${def.def} px) · ←/→: 8 px (Shift: 1 px)`
    : 'Drag to resize · double-click: default height · ↑/↓: 8 px (Shift: 1 px)'}
  {style}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={cancel}
  onlostpointercapture={cancel}
  ondblclick={() => setPaneWidth(pane, def.def)}
  onkeydown={key}
></div>

<style>
  /* Tokens only. Over the pane's edge (the parent places it), above the
     sticky ruler / corner, so it can be grabbed along its whole height. */
  .split { position: absolute; width: 7px; z-index: 4; cursor: col-resize; touch-action: none; outline: none; }
  .split::after { content: ''; position: absolute; top: 0; bottom: 0; left: calc(50% - 1px); width: 2px; border-radius: 1px; background: transparent; transition: background 0.1s; }
  .split:hover::after, .split.on::after { background: color-mix(in srgb, var(--accent) 60%, transparent); }
  .split:focus-visible::after { background: var(--accent); }
  .split.y { height: 7px; width: auto; cursor: row-resize; }
  .split.y::after { top: calc(50% - 1px); bottom: auto; left: 0; right: 0; width: auto; height: 2px; }
</style>
