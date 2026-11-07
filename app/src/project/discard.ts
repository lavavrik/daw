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
//     and deletes that autosave (App beforeLoad; New also drops the autosave
//     of the session it replaces, App onFresh).

/** The warning line for New / Open, or null when nothing is lost (go ahead at once). */
export function discardWarning(p: { dirty: boolean; name: string }, restoreOffer: { name: string } | null): string | null {
  const edits = `Unsaved changes in "${p.name}" will be lost`;
  if (restoreOffer) {
    const offer = `Discard the unrestored session "${restoreOffer.name}"? Its autosave will be deleted.`;
    return p.dirty ? `${offer} ${edits} too.` : offer;
  }
  return p.dirty ? `${edits}.` : null;
}

/**
 * Closing / reloading the tab: the browser's own "Leave site?" prompt (the
 * one native dialog allowed: nothing else can stop an unload) while a
 * project that lives in a folder has unsaved changes. The autosave's last
 * flush on visibilitychange is async and may not finish, and the folder
 * would not have those edits anyway. A project without a folder is left to
 * the autosave (a restored session stays "unsaved" until saved, so it would
 * prompt on every close).
 */
export function warnOnUnload(p: { dirty: boolean; folder: unknown }): boolean {
  return p.dirty && p.folder !== null;
}
