<script lang="ts">
  // A collapsible strip section (EQ, Comp, Reverb/Delay settings). Collapsed
  // by default; the header always shows the title and, for processors with an
  // on/off switch, an "on" toggle that works without expanding. `summary` is
  // a line that stays visible while collapsed (the Comp's "SC: Drums · kick").
  import type { Snippet } from 'svelte';

  let { title, on = null, ontoggle, summary, children, testid, name }: {
    title: string;
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
    ><span class="tri">{open ? '▾' : '▸'}</span>{title}</button>
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
  .sec { border-top: 1px solid #2a2c33; padding: 2px 0; }
  .head { display: flex; align-items: center; gap: 4px; }
  .exp { flex: 1; display: flex; align-items: center; gap: 3px; border: 0; background: transparent; color: #c9cbd3; font: 600 11px ui-sans-serif, system-ui, sans-serif; padding: 2px 2px; cursor: pointer; text-align: left; border-radius: 2px; }
  .exp:hover { background: #262830; }
  .tri { width: 9px; color: #8d90a0; font-size: 9px; }
  .on { font: 10px ui-sans-serif, system-ui, sans-serif; border: 1px solid #3a3d47; background: #1a1b20; color: #8d90a0; border-radius: 3px; padding: 0 5px; cursor: pointer; min-width: 28px; }
  .on.lit { background: #f0a23a; border-color: #f0a23a; color: #111; font-weight: 600; }
  .exp:focus-visible, .on:focus-visible { outline: 1px solid #f0a23a; }
  .summary { font-size: 10px; color: #a3a6b3; padding: 0 2px 1px 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .body { display: grid; grid-template-columns: 1fr 1fr; justify-items: center; gap: 2px 0; padding: 2px 0; }
</style>
