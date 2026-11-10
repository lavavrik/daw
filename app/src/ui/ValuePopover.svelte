<script module lang="ts">
  // Precise value entry (plan 24; docs/architecture/ui-theme.md "Precise
  // entry"): right-click a slider-like control (or press the ContextMenu key
  // or Shift+F10 on it) and this small card opens at the pointer with
  //   - the control's name (uppercase, 10 px);
  //   - a text field with the value in display units, the unit as a suffix
  //     ("-6.0" dB, "220" ms, "C4" for a note param; knobMath entryParts),
  //     the Set button (Enter does the same) and a quiet Reset (to the default);
  //   - the range hint "min … max";
  //   - then, when the control has any, its menu items (AutoMenu.svelte's
  //     list: Automate / Show automation, MIDI learn / Forget MIDI).
  //
  // API (for any control, not only Knob):
  //
  //   openValuePopover({ x, y, label, def, value, apply, from, auto, format })
  //     x, y    where to open (the pointer; for the keyboard, a corner of the
  //             control). The card is kept inside the window.
  //     label   the control's name: the title and the field's accessible name.
  //     def     a KnobDef (rack ParamDef, mixer MixParamDef, or one built
  //             for the control: label, min, max, default, integer, unit,
  //             curve 'lin', choices [], and `name` / `minLabel` where the
  //             readout needs them). knobMath formatValue / parseValue /
  //             entryParts do all the text: what the field shows, what it
  //             accepts ("1.2k", "-6 dB", "C3", "50%", "L25", "-inf"), the
  //             range hint. The parsed value is clamped to [min, max] and an
  //             integer def rounds.
  //     value   a getter for the current value (the control's own,
  //             un-automated base): `value: () => value`. A function, not a
  //             number, so the type itself asks for a live read: while the
  //             card is open and nothing is typed yet, the field follows the
  //             control (an undo, a MIDI CC, a lane), and Set / Reset compare
  //             against the value of the moment, not the one it opened on.
  //     apply   called at most once, with the new value, when it differs from
  //             the live `value`: Set / Enter with a new value, or Reset off
  //             the default. The caller's normal edit path (Knob: bus.touch, then
  //             onchange), so it is one undo entry labelled like the
  //             control's other edits. Not called on Esc, an outside press,
  //             a scroll, an unchanged field or invalid text.
  //     from    the control: focus goes back to it on Set, Reset, Esc, a
  //             wheel and Tab out (not on an outside press: the press's own
  //             focus wins).
  //     auto    optional { owner, target }: the lower half lists that
  //             target's AutoMenu items (menuItems decides which; none, none
  //             shown). Omit it (or null) for a control with no menu.
  //     format  optional (v) => text: the field's text and the range hint
  //             when the control's own readout differs from knobMath's
  //             (the step grid's pan reads "L 25", formatValue "L25"). The
  //             whole text, no suffix; parseValue (def) must read it back.
  //
  //   closeValuePopover(from?)  closes it (only when it belongs to `from`,
  //             if given: a control that unmounts calls this).
  //
  //   For a native control (a range input: StepGrid's, ClipPanel's):
  //   popoverHandlers(() => req) gives { oncontextmenu, onkeydown } to spread
  //   on it (the right-click at the pointer; ContextMenu / Shift+F10 under
  //   the control; other keys pass), with `req` the request minus x, y and
  //   from; `use:popoverOwner` closes a card the node opened when it unmounts.
  //
  // One popover for the whole app (App.svelte renders it once): opening
  // another replaces it, so only one is ever open.
  //
  // Behaviour: the field opens focused with its text selected. Text that
  // doesn't parse outlines the field in --rec, shows "Not a value" and keeps
  // the card open; every invalid Enter announces it again (the alert is
  // re-mounted), and the field's description names the error and the range.
  // A field left as it shows changes nothing (the text is rounded: parsing it
  // back would move the value a hair and make an undo entry for no edit;
  // Knob's typed entry does the same). Esc, a press outside, a wheel outside
  // (the page scrolls under it) or a resize closes it with no change. Not
  // every `scroll` event: the timeline's playhead follow scrolls by itself
  // while playing. Tab past the last button, or Shift+Tab out of the field,
  // closes it too and puts the focus back on the control (the card sits at
  // the end of the DOM: the browser's next stop would be anywhere).
  // The card re-places itself whenever its size changes (the error line), so
  // it never sticks out of the window. Right-click in the field is the
  // browser's own menu (paste); elsewhere on the card, nothing.
  // Keys typed in it stay in it (MenuBar's keepKey): Space presses the
  // focused button and never starts the song, letters never play the
  // QWERTY piano; Esc is its own (App's Esc-ends-MIDI-learn never sees it);
  // Cmd / Ctrl chords still reach the app (Cmd+S), and in the field the
  // shortcuts already leave Cmd+Z to the text (input/shortcuts.ts isTyping).
  // A wheel on the card stops there too.
  //
  // Layering: fixed, z-index 60 (the app's menus' layer). Not in the top layer: the
  // global tooltip (Tooltip.svelte) is, so the tips of Set, Reset and the
  // items show above the card. A press (the right-click) or focus moving
  // into the card releases the control's own tip, so it never covers the field.
  import type { MixChannelTarget } from '../state/mixer-actions';
  import type { AutoTarget } from '../state/project.svelte';
  import type { KnobDef } from './rack/knobMath';

  export interface ValuePopoverReq {
    x: number;
    y: number;
    label: string;
    def: KnobDef;
    /** The live value (header): read again whenever it matters. */
    value: () => number;
    apply: (v: number) => void;
    from: HTMLElement | null;
    auto?: { owner: MixChannelTarget; target: AutoTarget } | null;
    /** The control's own readout text, when it differs from formatValue (header). */
    format?: (v: number) => string;
  }

  // Raw: the request is the caller's own objects (a catalog def, its auto
  // target, its apply), never copied into a deep $state proxy.
  let active = $state.raw<ValuePopoverReq | null>(null);

  export function openValuePopover(req: ValuePopoverReq) {
    active = req;
  }
  export function closeValuePopover(from?: HTMLElement | null) {
    if (active && (from === undefined || active.from === from)) active = null;
  }

  /** A request for a native control: no position, no `from` (the event's control gives both). */
  export type NativeReq = Omit<ValuePopoverReq, 'x' | 'y' | 'from'>;
  /**
   * The handlers that open the card from a native control (header): its
   * contextmenu event (at the pointer; a keyboard-made one, at 0,0, under the
   * control) and its ContextMenu / Shift+F10 key (under the control). `make`
   * runs per opening, so the request reads the control's current state.
   */
  export function popoverHandlers(make: () => NativeReq) {
    const open = (e: MouseEvent | KeyboardEvent) => {
      const kbd = e instanceof KeyboardEvent;
      if (kbd && e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      e.preventDefault(); // no native menu (nor, after the key, a contextmenu event)
      const el = e.currentTarget as HTMLElement;
      const r = el.getBoundingClientRect();
      const at = kbd || (e.clientX === 0 && e.clientY === 0) ? null : e;
      openValuePopover({ ...make(), x: at?.clientX ?? r.left, y: at?.clientY ?? r.bottom, from: el });
    };
    return { oncontextmenu: open, onkeydown: open };
  }
  /** Svelte action: a card opened from this node closes when it unmounts (its apply would edit what is gone). */
  export function popoverOwner(node: HTMLElement) {
    return { destroy: () => closeValuePopover(node) };
  }
</script>

<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { CommandSink } from '../state/actions';
  import type { Project } from '../state/project.svelte';
  import AutoMenu, { menuItems } from './AutoMenu.svelte';
  import type { AutoBus } from './autoBus';
  import { entryParts, formatValue, parseValue } from './rack/knobMath';

  // The menu items' context (AutoMenu's list needs the project, the engine and the bus).
  let { p, engine, bus }: { p: Project; engine: CommandSink; bus: AutoBus } = $props();

  let el = $state<HTMLDivElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  const req = $derived(active);
  /** The value's readout as the field shows it (parseValue's `shown`: a bare number is in its unit). */
  let readout = '';
  /** The field's text as the value gives it: unchanged text changes nothing. */
  let opened = '';
  let draft = $state('');
  let unit = $state('');
  let bad = $state(false);
  /** Each invalid Enter: re-mounts the alert so it is announced again. */
  let badN = $state(0);
  /** The user typed in the field: it stops following the value. */
  let typed = false;
  /** The control's value, read live (the caller's getter). */
  const live = $derived(req ? req.value() : 0);
  /** Placed after measuring (header: kept inside the window). */
  let left = $state(0);
  let top = $state(0);
  const hasItems = $derived.by(() => {
    if (!req?.auto) return false;
    const m = menuItems(bus, req.auto.owner, req.auto.target);
    return m.automate || m.midi;
  });
  /** The control's readout of `v`: its own format, else knobMath's. */
  const fmt = (r: ValuePopoverReq, v: number) => (r.format ? r.format(v) : formatValue(r.def, v));
  const range = $derived(req ? `${fmt(req, req.def.min)} … ${fmt(req, req.def.max)}` : '');

  /** Margin kept from the window's edges (px). */
  const EDGE = 8;

  /** The field's text, suffix and readout from value `v`. */
  function show(r: ValuePopoverReq, v: number) {
    readout = fmt(r, v);
    ({ text: opened, unit } = r.format ? { text: readout, unit: '' } : entryParts(r.def, v));
    draft = opened;
  }

  // A new request (another control, or the same one again): fresh text, then
  // measure and place, then focus the field with its text selected.
  $effect(() => {
    const r = req;
    if (!r) return;
    untrack(() => {
      typed = false;
      show(r, r.value());
      bad = false;
      left = r.x;
      top = r.y;
    });
    void tick().then(() => {
      if (active !== r || !el) return;
      place();
      input?.focus();
      input?.select();
    });
  });

  // The value moved under an untouched field (an undo, a MIDI CC, a lane):
  // the field follows it, still all selected if it was.
  $effect(() => {
    const v = live;
    untrack(() => {
      const r = req;
      if (!r || typed || fmt(r, v) === readout) return;
      const all = !!input && document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length;
      show(r, v);
      if (all) void tick().then(() => input?.select());
    });
  });

  /**
   * Beside the pointer; flipped to its other side when it would cross the
   * window's right or bottom edge, and never past the top-left either. Again
   * whenever the card's size changes (the error line appears).
   */
  function place() {
    const r = active;
    if (!r || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = r.x + w > innerWidth - EDGE ? r.x - w : r.x;
    let y = r.y + h > innerHeight - EDGE ? r.y - h : r.y;
    x = Math.max(EDGE, Math.min(x, innerWidth - EDGE - w));
    y = Math.max(EDGE, Math.min(y, innerHeight - EDGE - h));
    left = x;
    top = y;
  }
  $effect(() => {
    const node = el;
    if (!node) return;
    const ro = new ResizeObserver(() => place());
    ro.observe(node);
    return () => ro.disconnect();
  });

  function close(refocus: boolean) {
    const from = active?.from ?? null;
    active = null;
    if (refocus) queueMicrotask(() => from?.focus());
  }

  function set() {
    const r = active;
    if (!r) return;
    if (draft.trim() === opened.trim()) {
      close(true);
      return;
    }
    const v = parseValue(r.def, draft, readout);
    if (v === null) {
      bad = true;
      badN++;
      input?.focus();
      return;
    }
    if (v !== r.value()) r.apply(v); // the live value
    close(true);
  }

  function reset() {
    const r = active;
    if (!r) return;
    if (r.def.default !== r.value()) r.apply(r.def.default);
    close(true);
  }

  // While open: a press, a wheel outside or a resize closes it.
  $effect(() => {
    if (!req) return;
    const outside = (e: Event) => !el?.contains(e.target as Node);
    const press = (e: PointerEvent) => { if (outside(e)) close(false); };
    const wheel = (e: WheelEvent) => { if (outside(e)) close(true); };
    const resize = () => close(true);
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('wheel', wheel, { capture: true, passive: true });
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('wheel', wheel, { capture: true });
      window.removeEventListener('resize', resize);
    };
  });

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // only this layer: not also "end MIDI learn"
      close(true);
      return;
    }
    // Tab past the last stop, or Shift+Tab before the first: out of the
    // card, back to the control (header).
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey && el) {
      const stops = [...el.querySelectorAll<HTMLElement>('input, button, [tabindex]')].filter((x) => x.tabIndex >= 0 && !(x as HTMLButtonElement).disabled);
      const at = document.activeElement;
      if (stops.length && at === (e.shiftKey ? stops[0] : stops[stops.length - 1])) {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
    }
    // MenuBar's keepKey: the global shortcuts (window listeners) never see
    // the keys typed here; Cmd / Ctrl chords still do.
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  }

  function fieldKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      set();
    } else if (e.key !== 'Escape') bad = false;
  }

  /** Focus left the card (Tab out of it): close, no change. Null = a click on nothing focusable (the press handler decides). */
  function focusOut(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (to && !el?.contains(to)) close(false);
  }
</script>

{#if req}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="pop"
    bind:this={el}
    role="dialog"
    aria-label={`Set ${req.label}`}
    tabindex="-1"
    data-testid="value-popover"
    data-overlay
    style:left="{left}px"
    style:top="{top}px"
    onkeydown={key}
    onfocusout={focusOut}
    onwheel={(e) => e.stopPropagation()}
    oncontextmenu={(e) => { if (e.target !== input) e.preventDefault(); }}
  >
    <div class="lbl ttl">{req.label}</div>
    <div class="row">
      <span class="field">
        <input
          bind:this={input}
          bind:value={draft}
          class="mono"
          class:bad
          type="text"
          spellcheck="false"
          autocomplete="off"
          aria-label={`Value of ${req.label}`}
          aria-invalid={bad}
          aria-describedby={bad ? 'value-popover-err value-popover-range' : 'value-popover-range'}
          data-testid="value-input"
          onkeydown={fieldKey}
          oninput={() => (typed = true)}
        />
        {#if unit}<span class="unit mono" aria-hidden="true">{unit}</span>{/if}
      </span>
      <button class="btn primary" data-testid="value-set" onclick={set}>Set</button>
      <button class="btn quiet" data-testid="value-reset" title={`Back to the default, ${fmt(req, req.def.default)}`} onclick={reset}>Reset</button>
    </div>
    {#if bad}
      {#key badN}
        <div class="err" id="value-popover-err" role="alert" data-testid="value-error">Not a value</div>
      {/key}
    {/if}
    <div class="range mono" id="value-popover-range">{range}</div>
    {#if req.auto && hasItems}
      <div class="items">
        <AutoMenu {p} {engine} {bus} control={{ owner: req.auto.owner, target: req.auto.target, label: req.label }} onclose={() => close(true)} />
      </div>
    {/if}
  </div>
{/if}

<style>
  /* A --panel card with the lift (ui-theme.md: popovers with their own controls), radius 12, 12 px in. */
  .pop {
    position: fixed; z-index: 60; display: flex; flex-direction: column; gap: 8px;
    width: max-content; min-width: 200px; padding: 12px; box-sizing: border-box;
    background: var(--panel); color: var(--text); border-radius: var(--r-lg); box-shadow: var(--lift);
    font: var(--fs-ctl) var(--font-ui); outline: none;
  }
  .ttl { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row { display: flex; align-items: center; gap: 6px; }
  /* The unit sits inside the field's right end, as a suffix. */
  .field { position: relative; display: inline-flex; align-items: center; }
  input { width: 96px; box-sizing: border-box; padding: 7px 8px; font-size: var(--fs-ctl); line-height: 16px; }
  .field:has(.unit) input { padding-right: 36px; }
  .unit { position: absolute; right: 8px; color: var(--text-2); font-size: var(--fs-lbl); pointer-events: none; }
  input.bad, input.bad:focus-visible { box-shadow: inset 0 0 0 2px var(--rec), var(--well-shadow); }
  .err { color: var(--rec); font: 500 var(--fs-lbl) var(--font-ui); }
  .range { color: var(--text-dim); font-size: var(--fs-lbl); }
  .items { margin: 0 -4px -4px; padding-top: 4px; border-top: 1px solid var(--line); }
</style>
