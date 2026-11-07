<script lang="ts">
  // The left Browser pane: the sample + patch library (spec §4 "Library
  // browser"; state in library/library.svelte.ts) and the built-in starter
  // kit (library/starter.ts; plan 8 Task 4).
  //
  //   header   library folder name, ↻ rescan
  //   preview  what is playing, with ■ Stop (one preview at a time)
  //   body     the folder:
  //              none:  Choose library folder…
  //              lost:  why, and "Reconnect folder" (permission needs a click)
  //              ready: folders (listed one level at a time when expanded,
  //                     "N more not shown" past the per-folder cap) and
  //                     samples; Patches (patches/*.json)
  //            Starter kit (always, read-only, foldable): the bundled CC0
  //            samples the default drum track is made of
  //   footer   change folder
  //
  // Samples (folder and kit alike): click previews (library/preview.ts:
  // straight to the speakers, never through the engine; big files stream
  // instead of decoding); drag onto a step-grid row, "+ Add row" or a
  // Sample Player copies the file into the project (library/drag.ts).
  // Problems with one file show in this pane's own inline banner; an
  // unreachable folder is the `lost` state, never a stream of errors.
  import { onMount } from 'svelte';
  import type { AudioEngine } from '../audio/engine';
  import { STARTER_SAMPLE_MIME, startLibraryDrag } from '../library/drag';
  import { LibraryLostError, library } from '../library/library.svelte';
  import { bindPreview, clearPreviewCache, previewState, stopPreview, togglePreview } from '../library/sharedPreview.svelte';
  import { listingFromPaths } from '../library/scan';
  import type { LibSample } from '../library/scan';
  import { STARTER_KIT, starterSample } from '../library/starter';

  let { engine }: { engine: AudioEngine } = $props();

  const lib = library.state;
  let error = $state<string | null>(null);
  // The app-wide preview player (library/sharedPreview: the step grid's rows
  // play through it too). An audio restart (Settings ▸ Apply) closes the
  // context it plays on: rebinding drops the old player.
  $effect(() => bindPreview(engine));
  const previewing = $derived(previewState.key);

  /** Kit previews are keyed "kit:<file>", apart from any library path. */
  const KIT = 'kit:';
  const kitSamples = listingFromPaths(STARTER_KIT.files.map((f) => f.path)).samples;
  let kitOpen = $state(true);

  async function toggle(s: LibSample, kit = false) {
    const k = kit ? KIT + s.path : s.path;
    if (previewing === k) return stopPreview();
    error = null;
    try {
      await togglePreview(k, s.name, () => (kit ? starterSample(s.path) : library.sampleBlob(s.path)));
    } catch (e) {
      if (e instanceof LibraryLostError) return; // the pane shows "Reconnect folder"
      error = e instanceof Error && e.message.includes(s.name) ? e.message : `Couldn't preview "${s.name}" — not a readable audio file`;
    }
  }
  function key(e: KeyboardEvent, s: LibSample, kit = false) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void toggle(s, kit);
  }

  // A new listing (refresh, another library) may hold other bytes at the same paths.
  $effect(() => {
    void lib.stamp;
    clearPreviewCache();
  });
  // Switching library stops the preview (folders start collapsed: the library forgets them).
  let shown = '';
  $effect(() => {
    const id = `${lib.source}:${lib.name}`;
    if (id === shown) return;
    shown = id;
    stopPreview();
    error = null;
  });

  onMount(() => {
    void library.init();
    // Back to the tab: pick up new files (root, open folders and patches/
    // only), and notice a revoked permission or a deleted folder (shown
    // once, as "Reconnect folder").
    const vis = () => {
      if (document.visibilityState === 'visible' && lib.status === 'ready') void library.refresh();
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      stopPreview();
    };
  });

  const isOpen = (path: string) => path in lib.listings;
  /** Expand lists that folder level (library.expand); a folder gone meanwhile says so once. */
  function fold(path: string) {
    if (isOpen(path)) return library.collapse(path);
    library.expand(path).catch((e) => {
      if (!(e instanceof LibraryLostError)) error = e instanceof Error ? e.message : String(e);
    });
  }
  const choose = () => library.choose().catch((e) => (error = `Couldn't open the folder — ${e instanceof Error ? e.message : String(e)}`));
  const nameOf = (key: string) => (key.startsWith(KIT) ? key.slice(KIT.length) : key.slice(key.lastIndexOf('/') + 1));
</script>

{#snippet folder(path: string, depth: number)}
  {@const f = lib.listings[path]}
  {#each f.folders as sub (sub.path)}
    <button
      class="item dir" style:--d={depth} data-testid="lib-folder-{sub.path}" aria-expanded={isOpen(sub.path)}
      title={sub.path} onclick={() => fold(sub.path)}
    ><span class="tw">{isOpen(sub.path) ? '▾' : '▸'}</span><span class="nm">{sub.name}</span></button>
    {#if isOpen(sub.path)}{@render folder(sub.path, depth + 1)}{/if}
  {/each}
  {#each f.samples as s (s.path)}
    <div
      class="item smp" class:on={previewing === s.path} style:--d={depth}
      role="button" tabindex="0" draggable="true" data-testid="lib-sample-{s.path}"
      title="{s.path} — click to preview, drag onto a row or a Sample Player"
      onclick={() => void toggle(s)} onkeydown={(e) => key(e, s)}
      ondragstart={(e) => startLibraryDrag(e, s.path)}
    ><span class="tw">{previewing === s.path ? '■' : '♪'}</span><span class="nm">{s.name}</span></div>
  {/each}
  {#if f.more}
    <p class="dim more" style:--d={depth} data-testid="lib-more-{path}">{f.more} more not shown</p>
  {:else if depth > 0 && !f.folders.length && !f.samples.length}
    <p class="dim more" style:--d={depth}>no audio files</p>
  {/if}
{/snippet}

<aside class="pane" data-testid="browser" aria-label="Library">
  <div class="head">
    <span class="ttl">Library</span>
    {#if lib.source}
      <span class="name" data-testid="library-name" title={lib.name}>{lib.name}</span>
      {#if lib.status === 'ready'}
        <button class="icon" data-testid="library-refresh" title="Rescan the folder" aria-label="Rescan the folder" onclick={() => void library.refresh()}>↻</button>
      {/if}
    {/if}
  </div>

  <!-- Always shown (fixed height), so starting/stopping a preview never
       shifts the tree below it. -->
  <div class="pv" class:idle={!previewing} role="status" data-testid="preview-bar">
    {#if previewing}
      <span title={previewing}>▶ {previewState.label ?? nameOf(previewing)}</span>
    {:else}
      <span>Click a sample (here or a row's name) to preview</span>
    {/if}
    <button data-testid="preview-stop" aria-label="Stop preview" disabled={!previewing} onclick={stopPreview}>■ Stop</button>
  </div>
  {#if error}
    <div class="err" data-testid="library-error" role="alert">
      <span>{error}</span><button aria-label="Dismiss" onclick={() => (error = null)}>×</button>
    </div>
  {/if}

  <div class="body">
    {#if lib.status === 'none'}
      <p>Pick a folder of samples once; it stays your library in every project. Patches you save go to its <code>patches/</code> folder.</p>
      <button class="big" data-testid="library-choose" onclick={choose}>Choose library folder…</button>
    {:else if lib.status === 'loading'}
      <p class="dim" role="status">Scanning…</p>
    {:else if lib.status === 'lost'}
      <p class="lost" data-testid="library-message">{lib.message}</p>
      <button class="big" data-testid="library-reconnect" onclick={() => void library.reconnect()}>Reconnect folder</button>
    {:else if lib.listings['']}
      {@const top = lib.listings['']}
      <div class="sec">Samples</div>
      {#if top.samples.length || top.folders.length}
        <div class="tree">{@render folder('', 0)}</div>
      {:else}
        <p class="dim">No audio files here (wav, aiff, mp3, flac, ogg, m4a).</p>
      {/if}
      <div class="sec">Patches</div>
      {#each lib.patches as pt (pt.path)}
        <div class="item pat" data-testid="lib-patch-{pt.name}" title="Load it from the Patch menu of a synth track's Instrument tab">
          <span class="tw">⎍</span><span class="nm">{pt.name}</span>
        </div>
      {:else}
        <p class="dim">None yet — Save patch in a synth track's Instrument tab.</p>
      {/each}
    {/if}

    <section class="kit" data-testid="starter-kit" aria-label="Starter kit">
      <button class="sec fold" data-testid="starter-kit-toggle" aria-expanded={kitOpen} onclick={() => (kitOpen = !kitOpen)}>
        <span>{kitOpen ? '▾' : '▸'} Starter kit</span>
        <span class="ro" title="Built in (CC0): drag a sound into the project; nothing is saved here">read-only</span>
      </button>
      {#if kitOpen}
        <div class="tree">
          {#each kitSamples as s (s.path)}
            <div
              class="item smp" class:on={previewing === KIT + s.path}
              role="button" tabindex="0" draggable="true" data-testid="kit-sample-{s.path}"
              title="{s.name} — built-in starter kit: click to preview, drag onto a row or a Sample Player"
              onclick={() => void toggle(s, true)} onkeydown={(e) => key(e, s, true)}
              ondragstart={(e) => startLibraryDrag(e, s.path, STARTER_SAMPLE_MIME)}
            ><span class="tw">{previewing === KIT + s.path ? '■' : '♪'}</span><span class="nm">{s.name}</span></div>
          {/each}
        </div>
      {/if}
    </section>
  </div>

  {#if lib.status !== 'none'}
    <div class="foot">
      {#if lib.status === 'lost'}
        <button class="link" data-testid="library-choose" onclick={choose}>Choose another folder…</button>
      {:else}
        <button class="link" data-testid="library-choose" onclick={choose}>Change folder…</button>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .pane { background: #1b1c21; border: 1px solid #2a2c33; padding: 8px 0 6px; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .head { display: flex; align-items: center; gap: 6px; padding: 0 8px 6px; min-width: 0; }
  .ttl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #7d808c; flex: none; }
  .name { color: #e4e5ea; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .ro { flex: none; font-size: 9px; color: #9aa6c4; border: 1px solid #3a3d48; border-radius: 3px; padding: 0 3px; }
  .icon { margin-left: auto; flex: none; font: inherit; border: 0; background: transparent; color: #8d90a0; cursor: pointer; padding: 0 2px; }
  .icon:hover { color: #fff; }
  .pv { display: flex; align-items: center; gap: 6px; margin: 0 8px 6px; padding: 3px 6px; border-radius: 3px; background: #23302a; color: #9fe0b8; }
  .pv span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pv.idle { background: #22242b; color: #7d808c; }
  .pv button:disabled { opacity: 0.4; cursor: default; }
  .pv button { font: inherit; font-size: 11px; border: 1px solid currentColor; border-radius: 3px; background: transparent; color: inherit; cursor: pointer; padding: 0 6px; }
  .err { display: flex; align-items: flex-start; gap: 6px; margin: 0 8px 6px; padding: 4px 6px; border-radius: 3px; background: #3a1d22; color: #ffb3ba; border: 1px solid #6b2a33; }
  .err span { flex: 1; }
  .err button { border: 0; background: transparent; color: inherit; cursor: pointer; }
  .body { flex: 1; min-height: 0; overflow: auto; padding: 0 4px; }
  p { color: #9a9ca8; margin: 4px 4px 8px; }
  .dim { color: #6a6d79; }
  .lost { color: #ffd98a; }
  code { color: #c9cbd3; }
  .big { display: block; width: calc(100% - 8px); margin: 0 4px 6px; font: inherit; padding: 5px 8px; border-radius: 3px; border: 1px solid #f0a23a; background: #f0a23a; color: #111; font-weight: 600; cursor: pointer; text-align: center; }
  .sec { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: #6a6d79; margin: 6px 4px 2px; }
  .kit { margin-top: 8px; border-top: 1px solid #2a2c33; padding-top: 2px; }
  .fold {
    display: flex; align-items: center; gap: 6px; width: calc(100% - 8px); font-family: inherit; text-align: left;
    border: 0; background: transparent; padding: 0; cursor: pointer;
  }
  .fold:hover, .fold:focus-visible { color: #c9cbd3; outline: none; }
  .fold .ro { text-transform: none; letter-spacing: 0; }
  .tree { display: flex; flex-direction: column; }
  .item {
    display: flex; align-items: center; gap: 4px; width: 100%; box-sizing: border-box; font: inherit; text-align: left;
    padding: 1px 4px 1px calc(4px + var(--d, 0) * 12px); border: 0; border-radius: 2px; background: transparent; color: #c9cbd3;
    white-space: nowrap; cursor: pointer;
  }
  .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .item:hover, .item:focus-visible { background: #2a2c33; color: #fff; outline: none; }
  .item.on { background: #23302a; color: #9fe0b8; }
  .smp { cursor: grab; }
  .pat { cursor: default; }
  .tw { flex: none; width: 10px; color: #6a6d79; font-size: 10px; text-align: center; }
  .dir { color: #e4e5ea; }
  .more { margin: 0; padding: 1px 4px 1px calc(18px + var(--d, 0) * 12px); font-size: 11px; }
  .foot { display: flex; gap: 10px; padding: 6px 8px 0; border-top: 1px solid #2a2c33; }
  .link { font: inherit; font-size: 11px; border: 0; background: transparent; color: #8fb8ff; cursor: pointer; padding: 0; }
  .link:hover { text-decoration: underline; }
</style>
