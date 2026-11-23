<script lang="ts">
  // The `?template=<id>` start card (App.svelte, state/templates.ts
  // templateFromUrl). Opening a template resets the engine, which needs the
  // AudioContext running (project/load.ts), and the browser only starts it
  // after a gesture. So until the first click or key press the app shows this
  // card: the gesture starts audio (App.svelte's capture-phase wake on every
  // pointerdown / keydown), then App opens the template and removes the card.
  // A native modal <dialog>: the first click lands here, never on a control
  // of the empty session underneath. Esc does not close it.
  import { onMount } from 'svelte';

  let { name, blurb, loading }: { name: string; blurb: string; loading: boolean } = $props();
  let dlg: HTMLDialogElement | undefined = $state();
  onMount(() => dlg?.showModal());
</script>

<dialog bind:this={dlg} class="card" data-testid="template-start" aria-labelledby="template-start-name" oncancel={(e) => e.preventDefault()}>
  <p class="lbl">Template</p>
  <h2 id="template-start-name">{name}</h2>
  <p class="dim">{blurb}</p>
  <!-- svelte-ignore a11y_autofocus -->
  <button class="btn primary" data-testid="template-start-go" disabled={loading} autofocus>
    {loading ? 'Opening…' : 'Click to start'}
  </button>
</dialog>

<style>
  /* Tokens only, as ShortcutsSheet's card. */
  .card {
    width: min(360px, calc(100vw - 32px)); padding: 16px 20px 20px; border: 0; text-align: center;
    border-radius: var(--r-lg); background: var(--panel); color: var(--text); box-shadow: var(--lift);
    font: var(--fs-body) var(--font-ui);
  }
  .card::backdrop { background: color-mix(in srgb, var(--lcd) 55%, transparent); }
  .lbl { margin: 0 0 4px; }
  h2 { margin: 0; font: 700 18px var(--font-ui); }
  .dim { margin: 8px 0 16px; color: var(--text-2); }
  .btn { padding: 6px 18px; }
  .btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
</style>
