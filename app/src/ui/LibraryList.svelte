<script lang="ts">
  // The project's pattern library as a list (plan 21 Task 4): Patterns ▸
  // Load from library ▸ (MenuBar.svelte) and the pattern header's Load
  // popover (PatternPicker.svelte) both show this.
  //
  // Every entry is listed. One of the selected track's kind loads with a
  // click (state/pattern-library.ts loadPatternFromLibrary: a NEW pattern,
  // selected; drum rows that found no place are flashed as "N rows not in
  // this kit"); one of the other kind is greyed with "drum pattern" /
  // "synth pattern" and inert (ui/inertItem.ts: focusable, the reason as its
  // description). Each row has Rename (an inline field: Enter renames, Esc
  // or leaving it cancels) and Delete icon buttons; each edit is one undo
  // entry, so Delete asks nothing.
  //
  // Esc inside the rename field is prevented (it only ends the rename): the
  // menu's / popover's own Esc handling skips a prevented one.
  import { tick } from 'svelte';
  import type { AudioEngine } from '../audio/engine';
  import type { LibraryPattern, PatternTrack, Project } from '../state/project.svelte';
  import { flashHint } from '../state/banners.svelte';
  import {
    LIBRARY_NAME_MAX, deleteLibraryPattern, droppedRowsText, kindText, loadBlocked, loadPatternFromLibrary, renameLibraryPattern,
  } from '../state/pattern-library';
  import Icon from './Icon.svelte';
  import { blockInert, inertItem } from './inertItem';
  import GridFour from 'phosphor-svelte/lib/GridFour';
  import PianoKeys from 'phosphor-svelte/lib/PianoKeys';
  import PencilSimple from 'phosphor-svelte/lib/PencilSimple';
  import Trash from 'phosphor-svelte/lib/Trash';

  let { p, engine, track, onloaded = () => {}, testid }: {
    p: Project;
    engine: AudioEngine;
    /** The selected pattern track (null: none; nothing loads). */
    track: PatternTrack | null;
    /** After a load (the menu / popover closes). */
    onloaded?: () => void;
    testid: string;
  } = $props();

  let root = $state<HTMLElement | null>(null);
  let renaming = $state<string | null>(null);
  let draft = $state('');
  let input = $state<HTMLInputElement | null>(null);

  function load(e: LibraryPattern) {
    if (!track) return;
    const r = loadPatternFromLibrary(p, engine, track.id, e.id);
    if (!r) return;
    if (r.dropped > 0) flashHint(droppedRowsText(r.dropped));
    onloaded();
  }

  async function startRename(e: LibraryPattern) {
    draft = e.name;
    renaming = e.id;
    await tick();
    input?.focus();
    input?.select();
  }
  /** Back from the field to the entry's Rename button. */
  async function endRename(id: string) {
    renaming = null;
    await tick();
    root?.querySelector<HTMLElement>(`[data-entry="${id}"] [data-testid="library-rename"]`)?.focus();
  }
  function renameKey(ev: KeyboardEvent, id: string) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (renameLibraryPattern(p, id, draft)) void endRename(id); // empty: rejected, keep editing
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      void endRename(id);
    }
  }

  async function remove(e: LibraryPattern) {
    const i = p.patternLibrary.findIndex((x) => x.id === e.id);
    if (!deleteLibraryPattern(p, e.id)) return;
    // The focus moves to the entry that took its place (or the one above), never to <body>.
    await tick();
    const loads = root?.querySelectorAll<HTMLElement>('[data-testid="library-load"]') ?? [];
    (loads[Math.min(i, loads.length - 1)] ?? root)?.focus();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="lib" role="group" aria-label="Pattern library" data-testid={testid} bind:this={root} tabindex="-1" onclickcapture={blockInert}>
  {#each p.patternLibrary as e (e.id)}
    {@const why = loadBlocked(track, e)}
    {@const other = !track || track.kind !== e.kind}
    <div class="row" class:other data-entry={e.id} data-testid="library-entry">
      {#if renaming === e.id}
        <input
          class="name" bind:this={input} bind:value={draft} maxlength={LIBRARY_NAME_MAX} data-testid="library-rename-input"
          aria-label={`New name for ${e.name}`} onkeydown={(ev) => renameKey(ev, e.id)} onblur={() => (renaming = null)}
        />
      {:else}
        <button
          class="load" data-testid="library-load" use:inertItem={why}
          title={why ?? `Load “${e.name}” as a new pattern of ${track?.name ?? 'the track'}`} onclick={() => load(e)}
        >
          <Icon icon={e.kind === 'drum' ? GridFour : PianoKeys} />
          <span class="l">{e.name}</span>
          {#if other}<span class="kind">{kindText(e.kind)}</span>{/if}
        </button>
        <button class="ic" data-testid="library-rename" aria-label={`Rename ${e.name}`} title="Rename" onclick={() => void startRename(e)}>
          <Icon icon={PencilSimple} />
        </button>
        <button class="ic" data-testid="library-delete" aria-label={`Delete ${e.name}`} title="Delete from the library" onclick={() => void remove(e)}>
          <Icon icon={Trash} />
        </button>
      {/if}
    </div>
  {:else}
    <p class="empty" data-testid="library-empty">No saved patterns yet: Save to library stores the current one.</p>
  {/each}
</div>

<style>
  /* Tokens only; the rows look like the menu items (MenuBar .it). */
  .lib { display: flex; flex-direction: column; gap: 1px; outline: none; }
  .row { display: flex; align-items: center; gap: 2px; }
  .load {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 26px; padding: 0 8px; border: 0;
    border-radius: var(--r-sm); background: transparent; color: var(--text); font: 500 var(--fs-ctl) var(--font-ui);
    text-align: left; cursor: pointer;
  }
  .load :global(svg) { flex: none; color: var(--text-2); }
  .l { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kind { flex: none; font: 500 var(--fs-lbl) var(--font-ui); color: var(--text-2); }
  .load:hover:not([aria-disabled='true']), .ic:hover { background: var(--raised); }
  /* aria-disabled comes from use:inertItem (unseen by the compiler: :global). */
  .lib :global(.load[aria-disabled='true']) { opacity: 0.45; cursor: default; }
  .ic {
    flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0;
    border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-2); cursor: pointer;
  }
  .load:focus-visible, .ic:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .name {
    flex: 1; min-width: 0; margin: 0 2px; padding: 4px 8px; border: 0; border-radius: var(--r-sm); background: var(--well);
    box-shadow: var(--well-shadow), 0 0 0 2px var(--accent); color: var(--text); font: 500 var(--fs-ctl) var(--font-ui);
  }
  .empty { margin: 4px 8px; max-width: 240px; font-size: 11px; color: var(--text-2); }
</style>
