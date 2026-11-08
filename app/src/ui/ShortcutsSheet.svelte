<script lang="ts">
  // Help ▸ Keyboard shortcuts (plan 21 Task 3): a modal sheet listing the
  // shortcuts from input/shortcutList.ts (kept in sync with shortcuts.ts by
  // shortcutList.test.ts). Also Help ▸ About: the same dialog frame with the
  // app name and version (`kind`).
  //
  // A native <dialog> opened with showModal(): the browser traps the focus
  // and the page behind is inert. Esc, the × button or a press on the
  // backdrop close it (`onclose`), and the focus goes back to `returnFocus`
  // (the Help menu button). Every keydown inside stops here: the global
  // shortcuts (Space, the piano keys) and the App's Esc-ends-MIDI-learn must
  // not act behind a modal. Esc is prevented too, so the dialog's own
  // `cancel` never fires and the close always goes through `onclose`.
  // ⌘S / ⌘O (Ctrl on Windows / Linux) are prevented as well: the stopped
  // key never reaches the app's Save / Open, so the browser would open its
  // own "Save page" / "Open file" dialog behind the modal instead.
  // A press closes it only OUTSIDE the dialog's box (on the backdrop): a
  // click on the padding or between paragraphs also targets the <dialog>
  // element itself, so the target alone can't tell the two apart.
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import X from 'phosphor-svelte/lib/X';
  import { IS_MAC, SHORTCUTS, formatKeys } from '../input/shortcutList';
  import { version } from '../../../package.json';

  let { kind, returnFocus = null, onclose }: {
    kind: 'shortcuts' | 'about';
    /** Where the focus goes when it closes. */
    returnFocus?: HTMLElement | null;
    onclose: () => void;
  } = $props();

  let dlg = $state<HTMLDialogElement | null>(null);

  function close() {
    dlg?.close(); // first: nothing outside an open modal can take the focus
    returnFocus?.focus();
    onclose();
  }
  function key(e: KeyboardEvent) {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'o')) e.preventDefault();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
  function backdropPress(e: MouseEvent) {
    if (!dlg || e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close();
  }
  onMount(() => {
    dlg?.showModal();
    return () => dlg?.close();
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
<dialog
  bind:this={dlg} class="sheet" class:about={kind === 'about'}
  aria-labelledby="sheet-title" data-testid={kind === 'shortcuts' ? 'shortcuts-sheet' : 'about-dialog'}
  onkeydown={key} onclick={backdropPress}
>
  <header>
    <h2 id="sheet-title">{kind === 'shortcuts' ? 'Keyboard shortcuts' : 'About'}</h2>
    <button class="x" aria-label="Close" title="Close (Esc)" onclick={close}><Icon icon={X} /></button>
  </header>
  {#if kind === 'shortcuts'}
    <div class="groups">
      {#each SHORTCUTS as g (g.title)}
        <section>
          <h3>{g.title}</h3>
          <dl>
            {#each g.entries as e (e.what)}
              <dt>{#each e.keys as k, i (k)}{#if i}<span class="or"> / </span>{/if}<kbd>{formatKeys(k, IS_MAC)}</kbd>{/each}</dt>
              <dd>{e.what}</dd>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
  {:else}
    <p class="app">House DAW</p>
    <p>Version <span data-testid="about-version">{version}</span></p>
    <p class="dim">A personal browser DAW for making house music.</p>
  {/if}
</dialog>

<style>
  /* Tokens only: a --panel card with the lift, like the menus. */
  .sheet {
    width: min(720px, calc(100vw - 32px)); max-height: min(80vh, 720px); padding: 0; border: 0; overflow: auto;
    border-radius: var(--r-lg); background: var(--panel); color: var(--text); box-shadow: var(--lift);
    font: var(--fs-body) var(--font-ui);
  }
  .sheet.about { width: min(360px, calc(100vw - 32px)); }
  .sheet::backdrop { background: color-mix(in srgb, var(--lcd) 55%, transparent); }
  header {
    position: sticky; top: 0; display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px 8px 16px; background: var(--panel); border-bottom: 1px solid var(--line);
  }
  h2 { margin: 0; font: 700 14px var(--font-ui); }
  .x {
    display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0;
    border-radius: var(--r-sm); background: transparent; color: var(--text); cursor: pointer;
  }
  .x:hover { background: var(--raised); }
  .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 4px 24px; padding: 8px 16px 16px; }
  h3 {
    margin: 10px 0 4px; padding-bottom: 2px; border-bottom: 1px solid var(--line);
    font: 600 var(--fs-lbl) var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2);
  }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
  dt { white-space: nowrap; }
  dd { margin: 0; color: var(--text-2); }
  kbd {
    display: inline-block; min-width: 14px; padding: 1px 5px; border-radius: var(--r-xs); text-align: center;
    background: var(--well); box-shadow: var(--well-shadow); font: 500 var(--fs-ctl) var(--font-mono); color: var(--text);
  }
  .or { color: var(--text-2); }
  p { margin: 8px 16px; }
  .app { margin-top: 14px; font: 700 16px var(--font-ui); }
  .dim { color: var(--text-2); margin-bottom: 16px; }
</style>
