// Keys and focus for the app's <select>s: every one takes
// `onkeydown={selectKey}` and calls releaseSelect after a pick (rack patch and
// sample pickers, choice params, the mixer's sidechain picker, the pattern
// picker, the step grid's steps, the piano roll's grid / length, the Acid
// tab's length / root / scale, Settings).
//
// A focused <select> type-aheads on printable keys: "a" jumps to the first
// option starting with A. Here letters and digits are the QWERTY piano and
// shortcuts, so a select that still has focus after a pick would change its
// value when the user plays a note. selectKey swallows those keys (not with
// Cmd/Ctrl/Alt, so shortcuts and the browser's own keys keep working);
// arrows, Enter, Space and Escape still drive the select.

/** Printable key without Cmd/Ctrl/Alt: the ones a focused select would type-ahead on. */
export function isTypeAheadKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** `onkeydown={selectKey}` on a <select>: no type-ahead (the piano keys must not change it). */
export function selectKey(e: KeyboardEvent): void {
  if (isTypeAheadKey(e)) e.preventDefault();
}

/** How long after a pick a returning focus is taken away again (the picker's close). */
export const RELEASE_WINDOW_MS = 200;

/**
 * Give the keys back to the piano after a pick: blur the select (or focus
 * `to`, e.g. the piano roll's stage, which takes the keys itself). With
 * `appearance: base-select` (theme.css) the picker hands focus back to its
 * select as it closes, after the change event, so a plain blur() is undone.
 * For RELEASE_WINDOW_MS a focus coming back is blurred again (one-shot
 * listener), and on the next frame the select is checked once more in case
 * focus never left while the picker was open (no focus event to catch).
 */
export function releaseSelect(sel: HTMLSelectElement, to: HTMLElement | null = null): void {
  const away = () => (to ? to.focus({ preventScroll: true }) : sel.blur());
  sel.addEventListener('focus', away);
  setTimeout(() => sel.removeEventListener('focus', away), RELEASE_WINDOW_MS);
  away();
  requestAnimationFrame(() => {
    if (document.activeElement === sel) away();
  });
}
