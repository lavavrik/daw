// App-wide banners shown at the top of the bottom panel: `error` (red,
// role=alert) and `notice` (yellow, e.g. a sample waiting for Stop). Shared
// so that code outside the step grid (e.g. App's window-level drop guard) can
// raise them too. null = hidden.
//
// `hint` is different: a brief one-line message in the bottom panel's header
// status line (fixed height, so it never moves the editor), e.g. "Recording
// works in Pattern mode" when R is pressed in Song mode. Raise it with
// flashHint(); it clears itself.
//
// `load`: what a project load skipped or changed (its own banner, so the
// deferred-sample notice clearing `notice` never hides it).
// `ask`: an inline yes/no question (e.g. "Replace the project in …?") with
// its action; Cancel just clears it. Never confirm().
export interface Ask {
  text: string;
  /** Label of the confirming button. */
  ok: string;
  run: () => Promise<void> | void;
}

export const banners = $state<{
  error: string | null; notice: string | null; hint: string | null; load: string | null; ask: Ask | null;
}>({
  error: null,
  notice: null,
  hint: null,
  load: null,
  ask: null,
});

let hintTimer: ReturnType<typeof setTimeout> | undefined;

/** Show `message` in the header status line for `ms` (a newer one replaces it). */
export function flashHint(message: string, ms = 2500) {
  clearTimeout(hintTimer);
  banners.hint = message;
  hintTimer = setTimeout(() => {
    if (banners.hint === message) banners.hint = null;
  }, ms);
}
