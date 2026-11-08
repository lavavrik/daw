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
// Undo/redo mid-drag (plan 16 Task 5): a drag widget (Knob, Fader, the
// automation lane, the clip tab's handles, the sample markers, the piano
// roll, the timeline, the rack's cables) registers its Escape-cancel with
// registerDragCancel. Cmd/Ctrl+Z or redo while a pointer is down asks them
// (cancelDrag): a widget that was dragging puts its pre-drag value back
// through the same edit path as Escape, inside the still-open gesture, so
// the gesture ends where it began and its commit makes no entry; the key
// does nothing else (no undo of an older entry). The keys stay swallowed
// until the gesture ends (a held Cmd+Z repeats). A press on something that
// is not a cancellable drag (no widget says it was dragging): the old rule,
// the undo commits the gesture and afterApply() re-opens one for the rest
// of the press.

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
  /**
   * Undo/redo pressed: if a pointer is down and a drag widget was dragging,
   * cancel that drag and return true (the caller then does not undo/redo).
   * Stays true until the gesture ends, so a held key never undoes an older entry.
   */
  cancelDrag(): boolean;
}

/** Each drag widget's cancel: true when it was dragging (and now restored the pre-drag value). */
const dragCancels = new Set<() => boolean>();

/**
 * Register a drag widget's cancel (the Escape path: restore the value from
 * before the drag, stop following the pointer; return false when not
 * dragging). Returns the unregister function (idempotent).
 */
export function registerDragCancel(cancel: () => boolean): () => void {
  dragCancels.add(cancel);
  return () => void dragCancels.delete(cancel);
}

/** Ask every registered widget to cancel its drag; true if one was dragging. */
export function cancelDrags(): boolean {
  let any = false;
  for (const cancel of [...dragCancels]) if (cancel()) any = true;
  return any;
}

export function createGestures(o: {
  history: () => GestureHistory | null;
  /** True while a load replaces the session (no gesture starts). */
  loading: () => boolean;
  /** Run `fn` one task later (default setTimeout 0). */
  later?: (fn: () => void) => void;
  /** The drag widgets' cancels (default: the registerDragCancel registry). */
  cancelDrags?: () => boolean;
}): Gestures {
  const later = o.later ?? ((fn) => void setTimeout(fn, 0));
  const cancel = o.cancelDrags ?? cancelDrags;
  const down = new Set<number>();
  /** This gesture's drag was cancelled by an undo/redo key: those keys do nothing until it ends. */
  let cancelled = false;
  const end = () => {
    down.clear();
    cancelled = false;
    o.history()?.commit();
  };
  return {
    press(e) {
      if (e.isPrimary) down.clear();
      else down.delete(e.pointerId);
      if (down.size === 0) {
        cancelled = false;
        if (!o.loading()) o.history()?.begin();
      }
      down.add(e.pointerId);
    },
    release(e) {
      down.delete(e.pointerId);
      if (down.size === 0) cancelled = false;
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
    cancelDrag() {
      if (down.size === 0) return false;
      if (cancel()) cancelled = true;
      return cancelled;
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
