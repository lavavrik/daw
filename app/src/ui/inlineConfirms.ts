// Registry of the open inline confirmations (InlineConfirm.svelte), so an
// undo/redo can close them first (plan 9 Task 1).
//
// Ruling: a confirm asks about the state on screen ("Remove track X?"). An
// undo replaces that state, so the question never stays open over a
// different one: App's undo/redo paths (⌘Z / ⇧⌘Z / Ctrl+Y and ↶ ↷) call
// cancelOpenConfirms() before applying. A cancelled confirm behaves exactly
// like its Cancel button (the host closes it; on destroy focus returns to
// the anchor by the usual rule), then the undo applies.
//
// InlineConfirm registers its `oncancel` on mount and unregisters on destroy.

const open = new Set<() => void>();

/** Register an open confirm's cancel; returns the unregister function (idempotent). */
export function registerConfirm(cancel: () => void): () => void {
  open.add(cancel);
  return () => void open.delete(cancel);
}

/**
 * Cancel every open confirm (each one's Cancel). True if any was open.
 * A cancelled one is forgotten at once, even before its host destroys it.
 */
export function cancelOpenConfirms(): boolean {
  if (open.size === 0) return false;
  const all = [...open];
  open.clear();
  for (const cancel of all) cancel();
  return true;
}
