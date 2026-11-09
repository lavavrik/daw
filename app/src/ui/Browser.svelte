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
  //            Kits (always, read-only, foldable; state/kits.ts KITS, plan 25):
  //            the Starter kit (the bundled CC0 samples the default drum
  //            track is made of, open by default) and the generated kits
  //            (Drum Machine, Deep, Garage, Dusty; closed by default). Each
  //            kit's "Load" (also its header's context menu) loads it onto
  //            the selected drum track by role (state/kit-actions.ts
  //            loadKitOntoTrack: one undo entry, steps kept)
  //   tabs     All / Samples / Patches / Kits pick which sections show; the
  //            search box filters them by name (library/browserFilter.ts).
  //            Both are UI state only. While searching, folding a folder only
  //            hides its children (`searchFolded`; the listing stays, so the
  //            folder doesn't vanish); clearing the search drops that.
  //   footer   "Samples 412 MB / 1 GB" (the engine's sample memory in use,
  //            removed samples included until the project is reopened;
  //            state/sampleBudget.ts), change folder
  //
  // Samples (folder and kits alike): click previews (library/preview.ts:
  // straight to the speakers, never through the engine; big files stream
  // instead of decoding); drag onto a step-grid row, "+ Add row", a
  // Sample Player or the timeline (an audio lane, or below the lanes for a
  // new audio track) copies the file into the project (library/drag.ts).
  // Problems with one file show in this pane's own inline banner; an
  // unreachable folder is the `lost` state, never a stream of errors.
  import { onMount } from 'svelte';
  import type { AudioEngine } from '../audio/engine';
  import type { Project } from '../state/project.svelte';
  import { budgetText } from '../state/sampleBudget';
  import { KIT_SAMPLE_MIME, STARTER_SAMPLE_MIME, startLibraryDrag } from '../library/drag';
  import { LibraryLostError, library } from '../library/library.svelte';
  import { bindPreview, clearPreviewCache, previewState, stopPreview, togglePreview } from '../library/sharedPreview.svelte';
  import { listingFromPaths } from '../library/scan';
  import { BROWSER_TABS, folderVisible, hasUnscannedFolder, isFolderOpen, nameMatches, tabSections, type BrowserTab } from '../library/browserFilter';
  import type { LibSample } from '../library/scan';
  import { STARTER_KIT, starterSample } from '../library/starter';
  import { kitSample } from '../library/kitFiles';
  import { KITS, STARTER_KIT_ID } from '../state/kits';
  import type { Kit, KitSound } from '../state/kits';
  import { loadKitOntoTrack } from '../state/kit-actions';
  import DownloadSimple from 'phosphor-svelte/lib/DownloadSimple';
  import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
  import Stop from 'phosphor-svelte/lib/Stop';
  import X from 'phosphor-svelte/lib/X';
  import FolderOpen from 'phosphor-svelte/lib/FolderOpen';
  import Folder from 'phosphor-svelte/lib/Folder';
  import FileAudio from 'phosphor-svelte/lib/FileAudio';
  import Faders from 'phosphor-svelte/lib/Faders';
  import Play from 'phosphor-svelte/lib/Play';
  import ListBullets from 'phosphor-svelte/lib/ListBullets';
  import Waveform from 'phosphor-svelte/lib/Waveform';
  import SquaresFour from 'phosphor-svelte/lib/SquaresFour';
  import Icon from './Icon.svelte';
  /** Tab glyphs (the label stays beside them). */
  const TAB_ICON = { all: ListBullets, samples: Waveform, patches: Faders, kits: SquaresFour } as const;

  let { engine, p }: { engine: AudioEngine; p: Project } = $props();

  const lib = library.state;
  let tab = $state<BrowserTab>('all');
  let query = $state('');
  const q = $derived(query.trim());
  const sections = $derived(tabSections(tab));
  let searchFolded = $state(new Set<string>());
  $effect(() => { if (!q) searchFolded = new Set(); });
  let error = $state<string | null>(null);
  // The app-wide preview player (library/sharedPreview: the step grid's rows
  // play through it too). An audio restart (Settings ▸ Apply) closes the
  // context it plays on: rebinding drops the old player.
  $effect(() => bindPreview(engine));
  const previewing = $derived(previewState.key);

  /** Kit previews are keyed "kit:<file>" (starter) or "kit:<kit id>/<file>", apart from any library path. */
  const KIT = 'kit:';
  const kitSamples = listingFromPaths(STARTER_KIT.files.map((f) => f.path)).samples;
  let kitOpen = $state(true);
  /** The generated kits shown open (they start closed: five open kits would bury the folder). */
  let kitsOpen = $state(new Set<string>());
  const isKitOpen = (k: Kit) => (k.id === STARTER_KIT_ID ? kitOpen : kitsOpen.has(k.id));
  function foldKit(k: Kit) {
    if (k.id === STARTER_KIT_ID) return void (kitOpen = !kitOpen);
    const n = new Set(kitsOpen);
    if (!n.delete(k.id)) n.add(k.id);
    kitsOpen = n;
  }

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
  /** A generated kit's sound: preview it (the bar says "<kit> <role>"). */
  const soundKey = (k: Kit, s: KitSound) => `${KIT}${k.id}/${s.file}`;
  async function toggleSound(k: Kit, s: KitSound) {
    const id = soundKey(k, s);
    if (previewing === id) return stopPreview();
    error = null;
    try {
      await togglePreview(id, `${k.name} ${s.role}`, () => kitSample(k.id, s.file));
    } catch (e) {
      error = e instanceof Error && e.message.includes(s.file) ? e.message : `Couldn't preview the ${k.name} ${s.role}`;
    }
  }

  // ---- "Load onto track" (state/kit-actions.ts) -------------------------------
  /** The selected track, when it is a drum track (the one a kit loads onto). */
  const target = $derived.by(() => {
    const t = p.tracks.find((x) => x.id === p.selectedTrackId);
    return t?.kind === 'drum' ? t : null;
  });
  /**
   * The kit loading now (its button says so; one load at a time). The load
   * always settles (a replaced session or a dropped load ends it:
   * kit-actions.ts), so this never sticks.
   */
  let loadingKit = $state<string | null>(null);
  const loadTitle = (k: Kit) =>
    target
      ? `Load ${k.name} onto "${target.name}": each row named Kick, Clap… gets this kit's sound, missing roles get new rows; steps are kept`
      : 'Select a drum track to load a kit onto';
  async function loadKit(k: Kit) {
    const t = target;
    if (!t || loadingKit) return;
    loadingKit = k.id;
    try {
      await loadKitOntoTrack(p, engine, t.id, k.id);
    } finally {
      loadingKit = null;
    }
  }
  // A kit header's context menu: "Load onto <track>". It takes the focus (its
  // item, or the menu itself when the item is disabled: no drum track), so
  // Escape always closes it; Escape and a pick give the focus back to the
  // kit's header (its fold button). A press outside just closes it.
  let kitMenu = $state<{ x: number; y: number; kit: Kit; from: HTMLElement | null } | null>(null);
  let kitMenuEl = $state<HTMLDivElement | null>(null);
  function openKitMenu(e: MouseEvent, k: Kit) {
    e.preventDefault();
    const head = e.currentTarget as HTMLElement;
    const r = head.getBoundingClientRect();
    // A keyboard-made contextmenu event has no pointer position: open it under the header.
    const kbd = e.clientX === 0 && e.clientY === 0;
    kitMenu = { x: kbd ? r.left : e.clientX, y: kbd ? r.bottom : e.clientY, kit: k, from: head.querySelector<HTMLElement>('.fold') };
  }
  function closeKitMenu(refocus = true) {
    const from = kitMenu?.from;
    kitMenu = null;
    if (refocus) from?.focus({ preventScroll: true });
  }
  $effect(() => {
    if (!kitMenu || !kitMenuEl) return;
    const me = kitMenuEl;
    (me.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? me).focus();
    const outside = (e: PointerEvent) => {
      if (!me.contains(e.target as Node)) closeKitMenu(false);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  });
  function kitMenuKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // only this layer closes
    closeKitMenu();
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
  const shownOpen = (path: string) => isFolderOpen(lib.listings, searchFolded, path, q);
  /** `all`: an ancestor's name matched, so its contents show unfiltered. */
  const visibleFolders = (path: string, all: boolean) => lib.listings[path].folders.filter((f) => all || !q || folderVisible(lib.listings, f.path, f.name, q));
  const visibleSamples = (path: string, all: boolean) => lib.listings[path].samples.filter((s) => all || nameMatches(s.name, q));
  const visibleKit = $derived(kitSamples.filter((s) => nameMatches(s.name, q)));
  /** A generated kit's sounds under the search: all of them when the kit's name matches. */
  const visibleSounds = (k: Kit) => (nameMatches(k.name, q) ? k.rows : k.rows.filter((s) => nameMatches(`${s.role} ${s.name}`, q)));
  const visiblePatches = $derived(lib.patches.filter((pt) => nameMatches(pt.name, q)));
  const rootShown = $derived(lib.listings[''] ? visibleFolders('', false).length + visibleSamples('', false).length : 0);
  /** Expand lists that folder level (library.expand); a folder gone meanwhile says so once. */
  function fold(path: string) {
    if (q && isOpen(path)) {
      const n = new Set(searchFolded);
      if (!n.delete(path)) n.add(path);
      searchFolded = n;
      return;
    }
    if (isOpen(path)) return library.collapse(path);
    library.expand(path).catch((e) => {
      if (!(e instanceof LibraryLostError)) error = e instanceof Error ? e.message : String(e);
    });
  }
  const choose = () => library.choose().catch((e) => (error = `Couldn't open the folder — ${e instanceof Error ? e.message : String(e)}`));
  const nameOf = (key: string) => (key.startsWith(KIT) ? key.slice(KIT.length) : key.slice(key.lastIndexOf('/') + 1));
  const plural = (n: number) => `${n} match${n === 1 ? '' : 'es'}`;
</script>

{#snippet folder(path: string, depth: number, all: boolean)}
  {@const f = lib.listings[path]}
  {#each visibleFolders(path, all) as sub (sub.path)}
    <button
      class="item dir" style:--d={depth} data-testid="lib-folder-{sub.path}" aria-expanded={shownOpen(sub.path)}
      title={sub.path} onclick={() => fold(sub.path)}
    ><span class="tw"><Icon icon={shownOpen(sub.path) ? FolderOpen : Folder} size={14} /></span><span class="nm">{sub.name}</span></button>
    {#if shownOpen(sub.path) && lib.listings[sub.path]}{@render folder(sub.path, depth + 1, all || nameMatches(sub.name, q))}{/if}
  {/each}
  {#each visibleSamples(path, all) as s (s.path)}
    <div
      class="item smp" class:on={previewing === s.path} style:--d={depth}
      role="button" tabindex="0" draggable="true" data-testid="lib-sample-{s.path}"
      title="{s.path} — click to preview, drag onto a row or a Sample Player"
      onclick={() => void toggle(s)} onkeydown={(e) => key(e, s)}
      ondragstart={(e) => startLibraryDrag(e, s.path)}
    ><span class="tw dot smp-dot"><Icon icon={previewing === s.path ? Stop : FileAudio} size={14} /></span><span class="nm">{s.name}</span></div>
  {/each}
  {#if f.more && !q}
    <p class="dim more" style:--d={depth} data-testid="lib-more-{path}">{f.more} more not shown</p>
  {:else if depth > 0 && !q && !f.folders.length && !f.samples.length}
    <p class="dim more" style:--d={depth}>no audio files</p>
  {/if}
{/snippet}

<aside class="pane" data-testid="browser" aria-label="Library">
  <div class="head">
    <span class="ttl">Library</span>
    {#if lib.source}
      <span class="name" data-testid="library-name" title={lib.name}>{lib.name}</span>
      {#if lib.status === 'ready'}
        <button class="icon" data-testid="library-refresh" title="Rescan the folder" aria-label="Rescan the folder" onclick={() => void library.refresh()}><Icon icon={ArrowClockwise} size={14} /></button>
      {/if}
    {/if}
  </div>

  <div class="tabs" role="group" aria-label="Library category">
    {#each BROWSER_TABS as t (t.id)}
      <button aria-pressed={tab === t.id} data-testid="lib-tab-{t.id}" title={t.label} onclick={() => (tab = t.id)}><Icon icon={TAB_ICON[t.id]} />{t.label}</button>
    {/each}
  </div>
  <input
    class="search" type="search" data-testid="lib-search" placeholder="Search" aria-label="Search the library"
    bind:value={query} onkeydown={(e) => { if (e.key === 'Escape') query = ''; }}
  />

  <!-- Always shown (fixed height), so starting/stopping a preview never
       shifts the tree below it. -->
  <div class="pv" class:idle={!previewing} role="status" data-testid="preview-bar">
    {#if previewing}
      <span title={previewing}><Icon icon={Play} size={12} weight="fill" /> {previewState.label ?? nameOf(previewing)}</span>
    {:else}
      <span>Click a sample (here or a row's name) to preview</span>
    {/if}
    <button data-testid="preview-stop" title="Stop the preview" disabled={!previewing} onclick={stopPreview}><Icon icon={Stop} size={12} weight="fill" /> Stop</button>
  </div>
  {#if error}
    <div class="err" data-testid="library-error" role="alert">
      <span>{error}</span><button aria-label="Dismiss" onclick={() => (error = null)}><Icon icon={X} size={12} /></button>
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
      {#if sections.samples}
        <div class="sec">Samples</div>
        {#if rootShown}
          <div class="tree">{@render folder('', 0, false)}</div>
        {:else if q}
          <p class="dim">No samples match "{q}".</p>
        {:else}
          <p class="dim">No audio files here (wav, aiff, mp3, flac, ogg, m4a).</p>
        {/if}
        {#if q && hasUnscannedFolder(lib.listings)}
          <p class="dim hint" data-testid="lib-search-hint">Only opened folders are searched</p>
        {/if}
      {/if}
      {#if sections.patches}
        <div class="sec">Patches</div>
        {#each visiblePatches as pt (pt.path)}
          <div class="item pat" data-testid="lib-patch-{pt.name}" title="Load it from the Patch menu of a synth track's Instrument tab">
            <span class="tw dot pat-dot"><Icon icon={Faders} size={14} /></span><span class="nm">{pt.name}</span>
          </div>
        {:else}
          <p class="dim">{q ? `No patches match "${q}".` : 'No patches yet — save one from the Instrument tab.'}</p>
        {/each}
      {/if}
    {/if}

    {#if sections.kit}
    <div class="kits">
      <div class="sec kits-ttl"><span>Kits</span><span class="ro" title="Built in (CC0): drag a sound into the project or load a kit onto a drum track; nothing is saved here">read-only</span></div>
      {#each KITS as k (k.id)}
        {@const starter = k.id === STARTER_KIT_ID}
        {@const open = isKitOpen(k)}
        {@const sounds = starter ? [] : visibleSounds(k)}
        {@const matches = starter ? visibleKit.length : sounds.length}
        {#if starter || !q || sounds.length}
        <section class="kit" data-kit={k.id} data-testid={starter ? 'starter-kit' : `kit-${k.id}`} aria-label={k.name}>
          <div class="khead" role="group" aria-label="{k.name} kit" oncontextmenu={(e) => openKitMenu(e, k)}>
            <button class="sec fold" data-testid={starter ? 'starter-kit-toggle' : `kit-${k.id}-toggle`} aria-expanded={open} title={k.blurb} onclick={() => foldKit(k)}>
              <span><Icon icon={open ? FolderOpen : Folder} size={14} /> {k.name}{#if q && !open && matches} — {plural(matches)}{/if}</span>
            </button>
            <button class="load" data-testid="kit-load-{k.id}" disabled={!target || loadingKit !== null} title={loadTitle(k)} onclick={() => void loadKit(k)}>
              <Icon icon={DownloadSimple} size={12} />{loadingKit === k.id ? 'Loading…' : 'Load'}
            </button>
          </div>
          {#if open}
            <div class="tree">
              {#if starter}
                {#each visibleKit as s (s.path)}
                  <div
                    class="item smp" class:on={previewing === KIT + s.path}
                    role="button" tabindex="0" draggable="true" data-testid="kit-sample-{s.path}"
                    title="{s.name} — built-in starter kit: click to preview, drag onto a row or a Sample Player"
                    onclick={() => void toggle(s, true)} onkeydown={(e) => key(e, s, true)}
                    ondragstart={(e) => startLibraryDrag(e, s.path, STARTER_SAMPLE_MIME)}
                  ><span class="tw dot kit-dot"><Icon icon={previewing === KIT + s.path ? Stop : FileAudio} size={14} /></span><span class="nm">{s.name}</span></div>
                {:else}
                  <p class="dim">{q ? `No kit sounds match "${q}".` : 'No kit sounds.'}</p>
                {/each}
              {:else}
                {#each sounds as s (s.file)}
                  {@const id = soundKey(k, s)}
                  <div
                    class="item smp" class:on={previewing === id}
                    role="button" tabindex="0" draggable="true" data-testid="kit-sample-{k.id}/{s.file}"
                    title="{k.name} {s.role}: {s.name} — click to preview, drag onto a row or a Sample Player"
                    onclick={() => void toggleSound(k, s)}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void toggleSound(k, s); } }}
                    ondragstart={(e) => startLibraryDrag(e, `${k.id}/${s.file}`, KIT_SAMPLE_MIME)}
                  ><span class="tw dot kit-dot"><Icon icon={previewing === id ? Stop : FileAudio} size={14} /></span><span class="nm">{s.role}</span><span class="snd">{s.name}</span></div>
                {/each}
              {/if}
            </div>
          {/if}
        </section>
        {/if}
      {/each}
    </div>
    {/if}
  </div>

  {#if kitMenu}
    {@const k = kitMenu.kit}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="menu" bind:this={kitMenuEl} tabindex="-1" data-testid="kit-menu" style:left="{kitMenu.x}px" style:top="{kitMenu.y}px" onkeydown={kitMenuKey}>
      <div class="menu-ttl">{k.name}</div>
      <button data-testid="kit-menu-load" disabled={!target || loadingKit !== null} title={loadTitle(k)} onclick={() => { const kit = k; closeKitMenu(); void loadKit(kit); }}>
        {target ? `Load onto "${target.name}"` : 'Load onto track (select a drum track)'}
      </button>
    </div>
  {/if}

  <div class="foot">
    <span class="budget" data-testid="sample-budget" title="Sample memory in the audio engine: removed samples are freed when the project is reopened">Samples {budgetText(p)}</span>
    {#if lib.status === 'lost'}
      <button class="link" data-testid="library-choose" onclick={choose}>Choose another folder…</button>
    {:else if lib.status !== 'none'}
      <button class="link" data-testid="library-choose" onclick={choose}>Change folder…</button>
    {/if}
  </div>
</aside>

<style>
  /* Colours, radii and fonts come from theme.css tokens. Dots: samples
     --accent, kits --rec, patches --text-2 (no per-patch category yet). */
  .pane { background: var(--panel); border-right: 1px solid var(--line); padding: 8px 0 6px; display: flex; flex-direction: column; min-height: 0; min-width: 0; font-family: var(--font-ui); font-size: var(--fs-body); color: var(--text-2); }
  .head { display: flex; align-items: center; gap: 6px; padding: 0 8px 6px; min-width: 0; }
  .ttl { font: 600 var(--fs-lbl) var(--font-ui); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-2); flex: none; }
  .name { color: var(--text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .ro { flex: none; font-size: 9px; color: var(--text-dim); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0 3px; }
  .icon { margin-left: auto; display: inline-flex; flex: none; font: inherit; border: 0; background: transparent; color: var(--text-dim); cursor: pointer; padding: 0 2px; }
  .icon:hover { color: var(--text); }
  .tabs { display: flex; margin: 0 8px 6px; }
  .tabs > button { flex: 1; display: inline-flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 2px; font-size: var(--fs-lbl); }
  .search { margin: 0 8px 6px; width: calc(100% - 16px); box-sizing: border-box; font: var(--fs-ctl) var(--font-ui); }
  .pv { display: flex; align-items: center; gap: 6px; margin: 0 8px 6px; padding: 3px 6px; border-radius: var(--r-sm); background: var(--well); box-shadow: var(--well-shadow); color: var(--play); }
  .pv span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pv.idle { color: var(--text-dim); }
  .pv button:disabled { opacity: 0.4; cursor: default; }
  .pv button { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: var(--fs-ctl); border: 1px solid currentColor; border-radius: var(--r-sm); background: transparent; color: inherit; cursor: pointer; padding: 0 6px; }
  .err { display: flex; align-items: flex-start; gap: 6px; margin: 0 8px 6px; padding: 4px 6px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--rec) 18%, var(--well)); color: var(--rec); border: 1px solid var(--rec); }
  .err span { flex: 1; }
  .err button { display: inline-flex; border: 0; background: transparent; color: inherit; cursor: pointer; }
  .body { flex: 1; min-height: 0; overflow: auto; padding: 0 4px; }
  p { color: var(--text-2); margin: 4px 4px 8px; }
  .dim { color: var(--text-dim); }
  .lost { color: var(--accent); }
  code { color: var(--text); font-family: var(--font-mono); }
  .big { display: block; width: calc(100% - 8px); margin: 0 4px 6px; font: inherit; padding: 5px 8px; border-radius: var(--r-md); border: 0; background: var(--accent); color: var(--on-color); font-weight: 700; cursor: pointer; text-align: center; }
  .sec { font: 600 var(--fs-lbl) var(--font-ui); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); margin: 8px 4px 2px; }
  .kits { margin-top: 8px; border-top: 1px solid var(--line); padding-top: 2px; }
  .kits-ttl { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .kits-ttl .ro { text-transform: none; letter-spacing: 0; }
  .khead { display: flex; align-items: center; gap: 4px; margin-right: 4px; }
  .khead .fold { flex: 1; min-width: 0; width: auto; }
  .khead .fold > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .load {
    flex: none; display: inline-flex; align-items: center; gap: 3px; font: var(--fs-lbl) var(--font-ui); padding: 1px 6px;
    border: 1px solid var(--line); border-radius: var(--r-sm); background: transparent; color: var(--text-2); cursor: pointer;
  }
  .load:hover:not(:disabled), .load:focus-visible { color: var(--text); border-color: var(--accent); outline: none; }
  .load:disabled { opacity: 0.45; cursor: default; }
  .snd { margin-left: auto; padding-left: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-dim); font-size: var(--fs-ctl); }
  .menu { position: fixed; z-index: 50; min-width: 150px; outline: none; padding: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: var(--lift); display: flex; flex-direction: column; }
  .menu-ttl { font-size: var(--fs-lbl); color: var(--text-2); padding: 2px 6px 4px; }
  .menu button { font: var(--fs-ctl) var(--font-ui); text-align: left; padding: 4px 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); cursor: pointer; }
  .menu button:hover:not(:disabled), .menu button:focus-visible { background: var(--raised); outline: none; }
  .menu button:disabled { color: var(--text-2); opacity: 0.5; cursor: not-allowed; }
  .fold {
    display: flex; align-items: center; gap: 6px; width: calc(100% - 8px); font-family: inherit; text-align: left;
    border: 0; background: transparent; padding: 0; cursor: pointer;
  }
  .fold:hover, .fold:focus-visible { color: var(--text); outline: none; }
  .tree { display: flex; flex-direction: column; }
  .item {
    display: flex; align-items: center; gap: 4px; width: 100%; box-sizing: border-box; font: inherit; text-align: left;
    padding: 1px 4px 1px calc(4px + var(--d, 0) * 12px); border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-2);
    white-space: nowrap; cursor: pointer;
  }
  .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .item:hover, .item:focus-visible { background: var(--raised); color: var(--text); outline: none; }
  .item.on { background: var(--well); color: var(--play); }
  .smp { cursor: grab; }
  .pat { cursor: default; }
  .tw { flex: none; width: 16px; display: inline-flex; justify-content: center; color: var(--text-dim); }
  .dot { font-size: 8px; }
  .smp-dot { color: var(--accent); }
  .kit-dot { color: var(--rec); }
  .pat-dot { color: var(--text-2); }
  .on .dot { color: var(--play); }
  .dir { color: var(--text); }
  .more { margin: 0; padding: 1px 4px 1px calc(18px + var(--d, 0) * 12px); font-size: var(--fs-ctl); }
  .foot { display: flex; gap: 10px; padding: 6px 8px 0; border-top: 1px solid var(--line); }
  .budget { flex: 1; min-width: 0; font: var(--fs-ctl) var(--font-mono); color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .link { font: inherit; font-size: var(--fs-ctl); border: 0; background: transparent; color: var(--accent); cursor: pointer; padding: 0; }
  .link:hover { text-decoration: underline; }
</style>
