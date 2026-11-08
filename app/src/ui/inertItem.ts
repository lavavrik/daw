// Focusable-but-inert menu items (plan 21 Task 3 review). A natively
// `disabled` button drops out of the tab order and the arrow-key list, so a
// keyboard or screen-reader user never learns WHY it is off (the reason only
// lived in its hover tooltip). Instead a menu item that can't run gets
//
//   use:inertItem={reason}   reason !== null -> aria-disabled="true", and
//                            aria-describedby a hidden sibling holding the
//                            reason (read out on focus);
//
// and the menu's popover blocks its activation with `blockInert` (a capture
// click listener: pointer, Enter and Space all arrive as a click). The
// tooltip layer (ui/Tooltip.svelte) borrows aria-describedby while it shows
// and puts this one back after.

let next = 0;

export function inertItem(node: HTMLElement, reason: string | null) {
  const why = document.createElement('span');
  why.id = `inert-why-${++next}`;
  why.hidden = true;
  node.after(why);
  const set = (r: string | null) => {
    if (r) {
      why.textContent = r;
      node.setAttribute('aria-disabled', 'true');
      node.setAttribute('aria-describedby', why.id);
    } else {
      node.removeAttribute('aria-disabled');
      if (node.getAttribute('aria-describedby') === why.id) node.removeAttribute('aria-describedby');
    }
  };
  set(reason);
  return { update: set, destroy: () => why.remove() };
}

/** onclickcapture on a menu popover: an aria-disabled item does nothing. */
export function blockInert(e: MouseEvent) {
  const el = (e.target as Element | null)?.closest?.('[aria-disabled="true"]');
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
}
