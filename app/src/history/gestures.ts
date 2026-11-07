// Pointer gestures -> undo entries (docs/architecture/history.md).
//
// Every gesture (first press .. last release) is bracketed with
// history.begin() / commit(), so a knob, fader, note, clip or step-paint
// drag is one entry. The commit waits one task after the release so the
// editors' own pointerup handlers (final drag value) and the click that
// follows land inside the gesture.
//
// A pointerup can get lost: a native <select> popup or a context menu
// swallows it. A stale pointer id must never keep the gesture open, or the
// next unrelated edits would fuse into it. So:
//   - a primary press forgets every held id (a new primary pointer means the
//     old one is up), and begin() closes a gesture still open;
//   - a <select> change and a contextmenu end the gesture at once (capture
//     phase: before the page's own handler edits, which is then its own
//     entry). A text field's change is NOT one: it fires when a press
//     elsewhere blurs it, in the middle of that press's gesture;
//   - window blur ends it.
// Undo/redo mid-drag (Cmd+Z while the mouse is down) commits the gesture;
// afterApply() re-opens one for the rest of the drag.

export interface GestureHistory {
  begin(): void;
  commit(): void;
}

export interface Gestures {
  press(e: { pointerId: number; isPrimary: boolean }): void;
  release(e: { pointerId: number }): void;
  /** Capture-phase `change` anywhere. */
  change(target: EventTarget | null): void;
  contextMenu(): void;
  blur(): void;
  /** After an undo/redo: a pointer still down starts a new gesture. */
  afterApply(): void;
}

export function createGestures(o: {
  history: () => GestureHistory | null;
  /** True while a load replaces the session (no gesture starts). */
  loading: () => boolean;
  /** Run `fn` one task later (default setTimeout 0). */
  later?: (fn: () => void) => void;
}): Gestures {
  const later = o.later ?? ((fn) => void setTimeout(fn, 0));
  const down = new Set<number>();
  const end = () => {
    down.clear();
    o.history()?.commit();
  };
  return {
    press(e) {
      if (e.isPrimary) down.clear();
      else down.delete(e.pointerId);
      if (down.size === 0 && !o.loading()) o.history()?.begin();
      down.add(e.pointerId);
    },
    release(e) {
      down.delete(e.pointerId);
      later(() => {
        if (down.size === 0) o.history()?.commit();
      });
    },
    change(target) {
      if ((target as { tagName?: string } | null)?.tagName === 'SELECT') end();
    },
    contextMenu: end,
    blur: end,
    afterApply() {
      if (down.size > 0 && !o.loading()) o.history()?.begin();
    },
  };
}

/** Wire `g` to the window; returns the uninstall function. */
export function installGestures(g: Gestures): () => void {
  const change = (e: Event) => g.change(e.target);
  const listeners: [string, EventListener, boolean][] = [
    ['pointerdown', g.press as unknown as EventListener, true],
    ['pointerup', g.release as unknown as EventListener, true],
    ['pointercancel', g.release as unknown as EventListener, true],
    ['change', change, true],
    ['contextmenu', g.contextMenu, true],
    ['blur', g.blur, false],
  ];
  for (const [t, fn, capture] of listeners) window.addEventListener(t, fn, capture);
  return () => {
    for (const [t, fn, capture] of listeners) window.removeEventListener(t, fn, capture);
  };
}
