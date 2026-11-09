<script lang="ts">
  // The one global tooltip layer (round-2 spec §3, docs/architecture/ui-theme.md
  // "Tooltips"). Mounted once in App.svelte; it listens on `document` and
  // serves every element with a `title` or `data-tip`, so components need no
  // changes.
  //
  // Life of a tip: an element is *claimed* when the pointer enters it (or it
  // gets keyboard focus): its `title` moves to `data-tip`, which stops the
  // native tooltip, and `aria-describedby` points at this layer. After the
  // delay (tooltip.ts) the tip shows. *Release* undoes the claim and puts the
  // `title` back, so code and tests reading `title` keep working. An authored
  // `data-tip` is never overwritten or removed (it wins over `title`).
  //
  // The layer's text is written at claim time (while it is still hidden), so
  // `aria-describedby` never points at the previous tip's words during the
  // delay. The layer is a `popover="manual"`: shown with showPopover(), it
  // sits in the top layer, above modal <dialog>s (Settings, the shortcuts
  // sheet), which no z-index can beat.
  //
  // While shown, a timer (GUARD_MS, not every frame: getBoundingClientRect
  // forces layout) checks that the target is still there and re-places the
  // tip; a resize or an attribute change re-places it at once.
  //
  // Known limits: (1) a reactive `title` that becomes absent mid-hover gives
  // no attribute mutation (removing an absent attribute is not observable),
  // so release would put the old title back until the next render. Components
  // whose title comes and goes while hovered use '' instead of undefined
  // (MenuBar's undo / redo and View items): '' is a real mutation, the tip
  // hides, and release restores an empty title (no native tooltip). (2) Any
  // scroll event, including programmatic ones (playhead follow), hides the tip.
  //
  // A tip that only repeats the element's visible text (a menu item titled
  // with its own label; tooltip.ts tipRepeatsText) is MUTED (plan 22): the
  // element is still claimed, so its `title` is out of the way and the native
  // tip never fires, but the layer stays hidden and no aria-describedby is
  // added (the accessible name already says it). Checked at claim time and on
  // every repaint, so a title that changes to something longer shows.
  import { onMount } from 'svelte';
  import { createTipTiming, placeTip, tipRepeatsText } from './tooltip';

  let el: HTMLDivElement;
  const ID = 'tooltip-layer';
  const SEL = '[title],[data-tip]';
  /** How often a shown tip re-checks its target (ms). */
  const GUARD_MS = 120;

  onMount(() => {
    const timing = createTipTiming();
    let target: HTMLElement | null = null;
    let movedTitle = false; // we took `title` off the target
    let authoredTip = false; // the target had its own `data-tip` before the claim
    let viaFocus = false;
    let lastKey = '';
    let prevDescribed: string | null = null;
    let showing = false;
    let timer = 0;
    let guardTimer = 0;
    // Element whose tip the user dismissed (click, Esc, scroll): no re-show until the pointer leaves it.
    let dismissed: HTMLElement | null = null;
    let watch: MutationObserver | null = null;

    const tipOf = (n: EventTarget | null): HTMLElement | null =>
      n instanceof Element && !el.contains(n) ? n.closest<HTMLElement>(SEL) : null;
    const textOf = (t: HTMLElement) => ((authoredTip ? t.getAttribute('data-tip') : null) || t.getAttribute('title') || t.getAttribute('data-tip') || '').trim();

    /** Move a (possibly changed) `title` into `data-tip`. Idempotent. */
    function absorb(t: HTMLElement) {
      const title = t.getAttribute('title');
      if (title === null || authoredTip) return;
      t.setAttribute('data-tip', title);
      t.removeAttribute('title');
      movedTitle = true;
    }

    const isOpen = () => el.matches(':popover-open');
    function open() { if (!isOpen()) el.showPopover(); }
    function close() { if (isOpen()) el.hidePopover(); }

    /** The tip only repeats the target's own visible text (shown: nothing). */
    const repeats = (t: HTMLElement, text: string) => tipRepeatsText(text, t.innerText ?? '');
    /** Point aria-describedby at the layer only while it has something to add. */
    function describe(t: HTMLElement, on: boolean) {
      if (on) t.setAttribute('aria-describedby', ID);
      else if (t.getAttribute('aria-describedby') === ID) {
        if (prevDescribed === null) t.removeAttribute('aria-describedby');
        else t.setAttribute('aria-describedby', prevDescribed);
      }
    }

    function paint() {
      if (!target) return;
      const text = textOf(target);
      if (!text) { release(); return; }
      // Muted: keep the claim (no native tip), show nothing.
      if (repeats(target, text)) { close(); lastKey = ''; describe(target, false); return; }
      describe(target, true);
      const r = target.getBoundingClientRect();
      const key = `${text}|${r.left}|${r.top}|${r.width}|${r.height}|${innerWidth}|${innerHeight}`;
      if (key === lastKey && isOpen()) return;
      lastKey = key;
      if (el.textContent !== text) el.textContent = text;
      open();
      const p = placeTip(r, { width: el.offsetWidth, height: el.offsetHeight }, { width: innerWidth, height: innerHeight });
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    }

    /** While shown: the target going away or hidden (a menu closing, a cell
     *  re-rendered) hides the tip; a moved target moves it. Every GUARD_MS. */
    function guard() {
      if (!showing || !target) return;
      if (!target.isConnected || target.getClientRects().length === 0) { release(); return; }
      paint();
    }

    function release() {
      clearTimeout(timer);
      clearInterval(guardTimer);
      watch?.disconnect();
      watch = null;
      if (showing) timing.hidden(performance.now());
      showing = false;
      close();
      el.textContent = '';
      lastKey = '';
      if (target) {
        if (!authoredTip) {
          const tip = target.getAttribute('data-tip');
          if (movedTitle && tip !== null && target.getAttribute('title') === null) target.setAttribute('title', tip);
          target.removeAttribute('data-tip');
        }
        // Only undo our own aria-describedby.
        if (target.getAttribute('aria-describedby') === ID) {
          if (prevDescribed === null) target.removeAttribute('aria-describedby');
          else target.setAttribute('aria-describedby', prevDescribed);
        }
      }
      target = null;
      movedTitle = false;
      authoredTip = false;
      viaFocus = false;
      prevDescribed = null;
    }

    function claim(t: HTMLElement, byFocus: boolean) {
      if (t === target || t === dismissed) return;
      release();
      authoredTip = t.hasAttribute('data-tip');
      if (!textOf(t)) { authoredTip = false; return; }
      target = t;
      viaFocus = byFocus;
      absorb(t);
      // The text first (the layer still hidden), then the reference to it
      // (none for a muted tip: see the header).
      el.textContent = textOf(t);
      prevDescribed = t.getAttribute('aria-describedby');
      describe(t, !repeats(t, textOf(t)));
      // Live changes to the text (title re-set by the framework, or data-tip).
      watch = new MutationObserver(() => {
        if (!target) return;
        absorb(target);
        if (showing) paint();
        else {
          el.textContent = textOf(target);
          describe(target, !repeats(target, textOf(target)));
        }
      });
      watch.observe(t, { attributes: true, attributeFilter: ['title', 'data-tip'] });
      const reveal = () => {
        if (!target || !target.isConnected) { release(); return; }
        showing = true;
        if (!repeats(target, textOf(target))) timing.shown(); // a muted tip opens no quick-switch window
        paint();
        guardTimer = window.setInterval(guard, GUARD_MS);
      };
      const delay = timing.delayFor(performance.now());
      if (delay === 0) reveal();
      else timer = window.setTimeout(reveal, delay);
    }

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const t = tipOf(e.target);
      if (t) claim(t, false);
    };
    const onOut = (e: PointerEvent) => {
      if (dismissed && tipOf(e.relatedTarget) !== dismissed) dismissed = null;
      if (!target || viaFocus) return; // a keyboard-focus tip stays until focus leaves
      const to = tipOf(e.relatedTarget);
      if (to !== target) release();
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = tipOf(e.target);
      // Keyboard focus only: a click-focus would show the tip under the cursor.
      if (t && t === e.target && t.matches(':focus-visible')) claim(t, true);
    };
    const onFocusOut = (e: FocusEvent) => {
      dismissed = null;
      if (target && tipOf(e.target) === target) release();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); }; // never swallowed
    const hide = () => { dismissed = target; release(); };
    const onResize = () => { if (showing) guard(); };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', onResize);
    return () => {
      release();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', onResize);
    };
  });
</script>

<div bind:this={el} id={ID} class="tooltip" role="tooltip" popover="manual"></div>

<style>
  /* In the top layer while shown (popover), so above everything, modal
     dialogs included. It never takes the pointer, so it cannot cause
     pointerout flicker. The UA popover style centres it (inset 0, margin
     auto): pinned to the top-left here, placed by transform. */
  .tooltip {
    position: fixed; inset: 0 auto auto 0; margin: 0; z-index: 1000; pointer-events: none;
    width: max-content; height: auto; overflow: visible;
    max-width: 320px; padding: 5px 8px; box-sizing: border-box;
    background: var(--lcd); color: var(--text); border: 1px solid var(--line);
    border-radius: var(--r-sm); box-shadow: var(--lift);
    font: var(--fs-body)/1.35 var(--font-ui); overflow-wrap: anywhere;
  }
</style>
