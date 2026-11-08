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
  // `title` back, so code and tests reading `title` keep working.
  import { onMount } from 'svelte';
  import { createTipTiming, placeTip } from './tooltip';

  let el: HTMLDivElement;
  const ID = 'tooltip-layer';
  const SEL = '[title],[data-tip]';

  onMount(() => {
    const timing = createTipTiming();
    let target: HTMLElement | null = null;
    let movedTitle = false; // we took `title` off the target
    let prevDescribed: string | null = null;
    let showing = false;
    let timer = 0;
    let raf = 0;
    // Element whose tip the user dismissed (click, Esc, scroll): no re-show until the pointer leaves it.
    let dismissed: HTMLElement | null = null;
    let watch: MutationObserver | null = null;

    const tipOf = (n: EventTarget | null): HTMLElement | null =>
      n instanceof Element && !el.contains(n) ? n.closest<HTMLElement>(SEL) : null;
    const textOf = (t: HTMLElement) => (t.getAttribute('title') || t.getAttribute('data-tip') || '').trim();

    /** Move a (possibly changed) `title` into `data-tip`. Idempotent. */
    function absorb(t: HTMLElement) {
      const title = t.getAttribute('title');
      if (title === null) return;
      t.setAttribute('data-tip', title);
      t.removeAttribute('title');
      movedTitle = true;
    }

    function paint() {
      if (!target) return;
      const text = textOf(target);
      if (!text) { release(); return; }
      if (el.textContent !== text) el.textContent = text;
      el.hidden = false;
      const r = target.getBoundingClientRect();
      const p = placeTip(r, { width: el.offsetWidth, height: el.offsetHeight }, { width: innerWidth, height: innerHeight });
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    }

    /** While shown: the target going away or hidden (a menu closing, a cell
     *  re-rendered) hides the tip. One cheap check per frame. */
    function guard() {
      if (!showing || !target) return;
      if (!target.isConnected || target.getClientRects().length === 0) { release(); return; }
      paint();
      raf = requestAnimationFrame(guard);
    }

    function release() {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      watch?.disconnect();
      watch = null;
      if (showing) timing.hidden(performance.now());
      showing = false;
      el.hidden = true;
      if (target) {
        if (movedTitle) {
          const tip = target.getAttribute('data-tip');
          if (tip !== null && target.getAttribute('title') === null) target.setAttribute('title', tip);
          target.removeAttribute('data-tip');
        }
        if (prevDescribed === null) target.removeAttribute('aria-describedby');
        else target.setAttribute('aria-describedby', prevDescribed);
      }
      target = null;
      movedTitle = false;
      prevDescribed = null;
    }

    function claim(t: HTMLElement) {
      if (t === target || t === dismissed) return;
      release();
      if (!textOf(t)) return;
      target = t;
      absorb(t);
      prevDescribed = t.getAttribute('aria-describedby');
      t.setAttribute('aria-describedby', ID);
      // Live changes to the text (title re-set by the framework, or data-tip).
      watch = new MutationObserver(() => { if (target) { absorb(target); if (showing) paint(); } });
      watch.observe(t, { attributes: true, attributeFilter: ['title', 'data-tip'] });
      const reveal = () => {
        if (!target) return;
        showing = true;
        timing.shown();
        paint();
        raf = requestAnimationFrame(guard);
      };
      const delay = timing.delayFor(performance.now());
      if (delay === 0) reveal();
      else timer = window.setTimeout(reveal, delay);
    }

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const t = tipOf(e.target);
      if (t) claim(t);
    };
    const onOut = (e: PointerEvent) => {
      if (dismissed && tipOf(e.relatedTarget) !== dismissed) dismissed = null;
      if (!target) return;
      const to = tipOf(e.relatedTarget);
      if (to !== target) release();
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = tipOf(e.target);
      // Keyboard focus only: a click-focus would show the tip under the cursor.
      if (t && t === e.target && t.matches(':focus-visible')) claim(t);
    };
    const onFocusOut = (e: FocusEvent) => { if (target && tipOf(e.target) === target) release(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); }; // never swallowed
    const hide = () => { dismissed = target; release(); };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
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
    };
  });
</script>

<div bind:this={el} id={ID} class="tooltip" role="tooltip" hidden></div>

<style>
  /* Above everything, including menus and the loading veil (z 50). It never
     takes the pointer, so it cannot cause pointerout flicker. */
  .tooltip {
    position: fixed; left: 0; top: 0; z-index: 1000; pointer-events: none;
    max-width: 320px; padding: 5px 8px; box-sizing: border-box;
    background: var(--lcd); color: var(--text); border: 1px solid var(--line);
    border-radius: var(--r-sm); box-shadow: var(--lift);
    font: var(--fs-body)/1.35 var(--font-ui); overflow-wrap: anywhere;
  }
  .tooltip[hidden] { display: none; }
</style>
