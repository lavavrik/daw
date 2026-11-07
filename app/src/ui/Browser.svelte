<script lang="ts">
  // The left Browser pane: the sample + patch library (spec §4 "Library
  // browser"; state in library/library.svelte.ts).
  //
  //   header   library name (folder, or "Starter kit · read-only"), ↻ rescan
  //   preview  what is playing, with ■ Stop (one preview at a time)
  //   body     none:  Choose library folder… / Use starter kit
  //            lost:  why, and "Reconnect folder" (permission needs a click)
  //            ready: folders (listed one level at a time when expanded,
  //                   "N more not shown" past the per-folder cap) and
  //                   samples; Patches (patches/*.json)
  //   footer   switch library (folder / starter kit)
  //
  // Samples: click previews (library/preview.ts: straight to the speakers,
  // never through the engine; big files stream instead of decoding); drag onto a step-grid row, "+ Add row" or a
  // Sample Player copies the file into the project (library/drag.ts).
  // Problems with one file show in this pane's own inline banner; an
  // unreachable folder is the `lost` state, never a stream of errors.
  import { onMount } from 'svelte';
  import type { AudioEngine } from '../audio/engine';
  import { startLibraryDrag } from '../library/drag';
  import { LibraryLostError, library } from '../library/library.svelte';
  import { createPreview } from '../library/preview';
  import type { Preview } from '../library/preview';
  import type { LibSample } from '../library/scan';

  let { engine }: { engine: AudioEngine } = $props();

  const lib = library.state;
  let previewing = $state<string | null>(null);
  let error = $state<string | null>(null);
  let preview: Preview | null = null;

  const pv = () => (preview ??= createPreview(engine.context, (k) => (previewing = k)));

  async function toggle(s: LibSample) {
    if (previewing === s.path) return pv().stop();
    error = null;
    try {
      await pv().play(s.path, () => library.sampleBlob(s.path));
    } catch (e) {
      if (e instanceof LibraryLostError) return; // the pane shows "Reconnect folder"
      error = e instanceof Error && e.message.includes(s.name) ? e.message : `Couldn't preview "${s.name}" — not a readable audio file`;
    }
  }
  function key(e: KeyboardEvent, s: LibSample) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void toggle(s);
  }

  // A new listing (refresh, another library) may hold other bytes at the same paths.
  $effect(() => {
    void lib.stamp;
    preview?.clearCache();
  });
  // Switching library stops the preview (folders start collapsed: the library forgets them).
  let shown = '';
  $effect(() => {
    const id = `${lib.source}:${lib.name}`;
    if (id === shown) return;
    shown = id;
    preview?.stop();
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
      preview?.stop();
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
  const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
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
      {#if lib.source === 'starter'}<span class="ro" title="The bundled kit: samples only, nothing is saved here">read-only</span>{/if}
      {#if lib.source === 'folder' && lib.status === 'ready'}
        <button class="icon" data-testid="library-refresh" title="Rescan the folder" aria-label="Rescan the folder" onclick={() => void library.refresh()}>↻</button>
      {/if}
    {/if}
  </div>

  {#if previewing}
    <div class="pv" role="status">
      <span title={previewing}>▶ {nameOf(previewing)}</span>
      <button data-testid="preview-stop" onclick={() => preview?.stop()}>■ Stop</button>
    </div>
  {/if}
  {#if error}
    <div class="err" data-testid="library-error" role="alert">
      <span>{error}</span><button aria-label="Dismiss" onclick={() => (error = null)}>×</button>
    </div>
  {/if}

  <div class="body">
    {#if lib.status === 'none'}
      <p>Pick a folder of samples once; it stays your library in every project. Patches you save go to its <code>patches/</code> folder.</p>
      <button class="big" data-testid="library-choose" onclick={choose}>Choose library folder…</button>
      <button class="big alt" data-testid="library-starter" onclick={() => void library.useStarter()}>Use starter kit</button>
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
      {#if lib.source === 'folder'}
        <div class="sec">Patches</div>
        {#each lib.patches as pt (pt.path)}
          <div class="item pat" data-testid="lib-patch-{pt.name}" title="Load it from the Patch menu of a synth track's Instrument tab">
            <span class="tw">⎍</span><span class="nm">{pt.name}</span>
          </div>
        {:else}
          <p class="dim">None yet — Save patch in a synth track's Instrument tab.</p>
        {/each}
      {/if}
    {/if}
  </div>

  {#if lib.status !== 'none'}
    <div class="foot">
      {#if lib.status === 'lost'}
        <button class="link" data-testid="library-choose" onclick={choose}>Choose another folder…</button>
      {:else}
        <button class="link" data-testid="library-choose" onclick={choose}>{lib.source === 'folder' ? 'Change folder…' : 'Choose library folder…'}</button>
      {/if}
      {#if lib.source !== 'starter'}
        <button class="link" data-testid="library-starter" onclick={() => void library.useStarter()}>Starter kit</button>
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
  .big.alt { background: transparent; color: #c9cbd3; border-color: #3a3d48; font-weight: 400; }
  .sec { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: #6a6d79; margin: 6px 4px 2px; }
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
