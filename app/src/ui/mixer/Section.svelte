<script lang="ts">
  // A collapsible strip section (EQ, Comp, Reverb/Delay settings). Collapsed
  // by default; the header always shows the title and, for processors with an
  // on/off switch, an "on" toggle that works without expanding. `summary` is
  // a line that stays visible while collapsed (the Comp's "SC: Drums · kick").
  import type { Snippet, Component } from 'svelte';
  import Icon from '../Icon.svelte';

  let { title, icon, on = null, ontoggle, summary, children, testid, name }: {
    title: string;
    /** Phosphor glyph shown before the title (the title text stays). */
    icon?: Component<any>;
    /** On/off state, or null for sections without a switch. */
    on?: boolean | null;
    ontoggle?: () => void;
    summary?: Snippet;
    children: Snippet;
    testid: string;
    /** Strip name, for accessible labels ("Drums EQ"). */
    name: string;
  } = $props();

  let open = $state(false);
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
    ><span class="tri">{open ? '▾' : '▸'}</span>{#if icon}<Icon {icon} size={12} />{/if}{title}</button>
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
  .tri { width: 9px; color: var(--text-2); font-size: 9px; }
  .on { font: 600 var(--fs-lbl) var(--font-ui); border: 0; background: var(--raised); color: var(--text); border-radius: var(--r-sm); padding: 1px 6px; cursor: pointer; min-width: 28px; box-shadow: var(--raised-shadow); }
  .on.lit { background: var(--accent) var(--gloss); color: var(--on-color); box-shadow: var(--raised-shadow), 0 0 10px color-mix(in srgb, var(--accent) 40%, transparent); }
  .exp:focus-visible, .on:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .summary { font-size: var(--fs-lbl); color: var(--text-2); padding: 0 2px 1px 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Dials sit two per row; a slider spans the row (Knob's grid-column), so sliders stack. */
  .body { display: grid; grid-template-columns: 1fr 1fr; justify-items: center; gap: 4px 0; padding: 3px 0; }
</style>
