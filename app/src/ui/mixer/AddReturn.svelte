<script lang="ts">
  // The "+ Return" ghost strip (plan 29; spec "Adding, renaming, deleting"):
  // a dashed outline the strips' width class, after the last return and
  // before the Master. Its button asks Reverb or Delay in a small floating
  // card (PopButton `float`: the mixer scrolls and clips) and adds one
  // through state/returns.ts addReturn (one undo entry; the lowest free slot,
  // the catalog defaults, the name "Reverb N" / "Delay N"). MixerView hides
  // it at MAX_RETURNS.
  //
  // The button sits in the middle of the outline, so the card opens there
  // (PopButton places it under its trigger); a press anywhere else on the
  // outline presses the button too, so the whole strip is the target.
  import type { AudioEngine } from '../../audio/engine';
  import { KIND_NAME, addReturn, type ReturnKind } from '../../state/returns';
  import type { Project } from '../../state/project.svelte';
  import PopButton from '../PopButton.svelte';
  import Icon from '../Icon.svelte';
  import Plus from 'phosphor-svelte/lib/Plus';

  let { p, engine }: { p: Project; engine: AudioEngine } = $props();

  let btn = $state<HTMLButtonElement | null>(null);
  const KINDS: { kind: ReturnKind; blurb: string }[] = [
    { kind: 'reverb', blurb: 'A Reverb return: room, plate, hall…' },
    { kind: 'delay', blurb: 'A Delay return, synced to the tempo' },
  ];

  /** A press on the outline (not on the button or its card) presses the button. */
  function outline(e: MouseEvent) {
    if (!(e.target as Element).closest('.popbtn')) btn?.click();
  }
</script>

<!-- The outline's click is a mouse convenience: the button inside is the keyboard's way in. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="ghost" onclick={outline}>
  <PopButton id="add-return-pop" label="Add a return" testid="add-return-menu" float>
    {#snippet trigger(a)}
      <button {...a} type="button" class="add" data-testid="add-return" bind:this={btn} title="Add a return: a Reverb or a Delay every track can send to">
        <span class="plus"><Icon icon={Plus} size={20} /></span>
        <span>Return</span>
      </button>
    {/snippet}
    {#snippet children(close)}
      <p class="lbl pop-h">Add a return</p>
      <div class="plist">
        {#each KINDS as k (k.kind)}
          <button type="button" class="it" data-testid={`add-return-${k.kind}`} title={k.blurb} onclick={() => { close(); addReturn(p, engine, k.kind); }}>{KIND_NAME[k.kind]}</button>
        {/each}
      </div>
    {/snippet}
  </PopButton>
</div>

<style>
  /* The outline: as tall as the strips beside it, no faceplate (it is not a strip yet). */
  .ghost {
    flex: none; align-self: stretch; width: 96px; min-height: 250px; box-sizing: border-box;
    display: flex; align-items: center; justify-content: center;
    border: 2px dashed var(--line); border-radius: var(--r-md); cursor: pointer;
  }
  .ghost:hover { border-color: var(--text-2); background: color-mix(in srgb, var(--raised) 25%, transparent); }
  .add {
    display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 8px;
    border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-2);
    font: 700 var(--fs-ctl) var(--font-ui); cursor: pointer;
  }
  .ghost:hover .add { color: var(--text); }
  .add:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .plus { display: inline-flex; }
  /* The card's rows, as the strips' Presets list (MenuBar's item look). */
  .pop-h { margin: 0 8px; }
  .plist { display: flex; flex-direction: column; gap: 1px; min-width: 120px; }
  .it {
    display: flex; align-items: center; width: 100%; box-sizing: border-box; min-height: 26px; padding: 0 8px; border: 0; border-radius: var(--r-sm);
    background: transparent; color: var(--text); font: 500 var(--fs-ctl) var(--font-ui); text-align: left; white-space: nowrap; cursor: pointer;
  }
  .it:hover { background: var(--raised); }
  .it:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
