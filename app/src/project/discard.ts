// The one "unsaved changes" guard for everything that replaces the session:
// Project ▸ New, Project ▸ Open… and ⌘O / Ctrl+O all go through the Project
// menu's inline "Discard and …" prompt (ui/TopBar.svelte `request`), which
// asks whenever this returns a warning. (⌘N / Ctrl+N is the browser's own
// "new window" and cannot be taken over, so New has no shortcut.)
//
// Two things can be lost:
//   - unsaved edits (Project.dirty);
//   - the previous session, while the "Restore last session" offer is still
//     open: the fresh session is not dirty, but New / Open answers the offer
//     and the next edit autosaves over the session that was never restored.

/** The warning line for New / Open, or null when nothing is lost (go ahead at once). */
export function discardWarning(p: { dirty: boolean; name: string }, restoreOffer: { name: string } | null): string | null {
  const edits = `Unsaved changes in "${p.name}" will be lost`;
  if (restoreOffer) {
    const offer = `Discard the unrestored session "${restoreOffer.name}"? Its autosave will be overwritten.`;
    return p.dirty ? `${offer} ${edits} too.` : offer;
  }
  return p.dirty ? `${edits}.` : null;
}
