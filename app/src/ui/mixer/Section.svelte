<script lang="ts">
  // A collapsible strip section (EQ, Comp, Reverb/Delay settings). Collapsed
  // by default; the header always shows the title and, for processors with an
  // on/off switch, an "on" toggle that works without expanding. `summary` is
  // a line that stays visible while collapsed (the Comp's "SC: Drums · kick").
  // `aside` is a short text at the header's right end (the Sends' "1 of 3");
  // `open` is bindable, for a summary that opens the section (the Sends' mini
  // bars, plan 29). The open state is view state: per strip, never saved.
  import type { Snippet, Component } from 'svelte';
  import Icon from '../Icon.svelte';

  let { title, icon, on = null, ontoggle, summary, aside = '', children, testid, name, open = $bindable(false) }: {
    title: string;
    /** Phosphor glyph shown before the title (the title text stays), in
     *  place of the ▸ / ▾ triangle; --text (not --text-2) while open. */
    icon?: Component<any>;
    /** On/off state, or null for sections without a switch. */
    on?: boolean | null;
    ontoggle?: () => void;
    summary?: Snippet;
    /** Short text at the header's right end ("1 of 3"); "" = none. */
    aside?: string;
    children: Snippet;
    testid: string;
    /** Strip name, for accessible labels ("Drums EQ"). */
    name: string;
    /** Expanded (collapsed by default). */
    open?: boolean;
  } = $props();
</script>

<section class="sec" class:open data-testid={testid}>
  <div class="head">
    <button
      type="button"
      class="exp"
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} ${name} ${title}`}
      title={`${open ? 'Hide' : 'Show'} ${title} settings`}
      data-testid={`${testid}-expand`}
      onclick={() => (open = !open)}
    ><!-- One leading glyph: the section's icon when it has one (brighter while
         open), else the ▸ / ▾ triangle. Never both (two glyphs read as two
         disclosures); aria-expanded carries the state either way. -->{#if icon}<span class="ico"><Icon {icon} size={12} /></span>{:else}<span class="tri">{open ? '▾' : '▸'}</span>{/if}{title}</button>
    {#if aside}<span class="aside" data-testid={`${testid}-aside`}>{aside}</span>{/if}
    {#if on !== null}
      <button
        type="button"
        class="on"
        class:lit={on}
        aria-pressed={on}
        aria-label={`${name} ${title} on`}
        title={`${title} is ${on ? 'on' : 'off (bypassed)'} — click to turn ${on ? 'off' : 'on'}`}
        data-testid={`${testid}-on`}
        onclick={() => ontoggle?.()}
      >{on ? 'on' : 'off'}</button>
    {/if}
  </div>
  {#if summary}<div class="summary">{@render summary()}</div>{/if}
  {#if open}<div class="body">{@render children()}</div>{/if}
</section>

<style>
  .sec { border-top: 1px solid var(--line); padding: 3px 0; }
  .head { display: flex; align-items: center; gap: 4px; }
  .exp { flex: 1; display: flex; align-items: center; gap: 3px; border: 0; background: transparent; color: var(--text); font: 600 var(--fs-lbl) var(--font-ui); letter-spacing: .06em; text-transform: uppercase; padding: 2px 2px; cursor: pointer; text-align: left; border-radius: var(--r-sm); }
  .exp:hover { background: color-mix(in srgb, var(--raised) 50%, transparent); }
  .aside { flex: none; font: 600 var(--fs-lbl) var(--font-ui); color: var(--text-2); padding-right: 2px; font-variant-numeric: tabular-nums; }
  .tri { width: 9px; color: var(--text-2); font-size: 9px; }
  .ico { display: inline-flex; color: var(--text-2); }
  .open .ico { color: var(--text); } /* not --accent: too faint as an icon on the strip (ui-theme.md) */
  .on { font: 600 var(--fs-lbl) var(--font-ui); border: 0; background: var(--raised); color: var(--text); border-radius: var(--r-sm); padding: 1px 6px; cursor: pointer; min-width: 28px; box-shadow: var(--raised-shadow); }
  .on.lit { background: var(--accent) var(--gloss); color: var(--on-color); box-shadow: var(--raised-shadow), 0 0 10px color-mix(in srgb, var(--accent) 40%, transparent); }
  .exp:focus-visible, .on:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .summary { font-size: var(--fs-lbl); color: var(--text-2); padding: 0 2px 1px 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Dials sit two per row; a slider spans the row (Knob's grid-column), so sliders stack. */
  .body { display: grid; grid-template-columns: 1fr 1fr; justify-items: center; gap: 4px 0; padding: 3px 0; }
</style>
