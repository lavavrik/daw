<script lang="ts">
  // Pattern picker for the selected track (bottom panel header): a dropdown of
  // the track's patterns plus New / Duplicate / Rename / Delete. All edits go
  // through pattern-actions.ts (state + engine). Picking a pattern makes it the
  // track's current one (what Pattern mode loops and the editors show).
  //
  // Rename is an inline text input: Enter commits, Escape cancels, an empty
  // name is rejected (the input stays open). While it has focus the global
  // shortcuts are off (shortcuts.isTyping).
  // Delete is disabled with a tooltip when a clip uses the pattern or when it
  // is the track's last one (deletePattern refuses both anyway).
  //
  // The pattern library (plan 21 Task 4; state/pattern-library.ts): Save
  // (bookmark) turns the picker into a name field like Rename (default
  // "<track> · <pattern>"; Enter saves a copy, Esc or leaving it cancels);
  // Load (books) opens a popover with the library (LibraryList: load,
  // rename, delete) and, below it, the read-only Factory patterns of the
  // track's kind (plan 25 Task 2). Not the project's floppy / folder: those save and open
  // the project file. The popover closes on a load, Esc (focus back on
  // Load), a press outside it, focus leaving it and its Load button (Tab
  // out), or another track / pattern being selected.
  // Keys typed in it stay there (no song start, no notes).
  import { tick } from 'svelte';
  import { releaseSelect, selectKey } from './selectKey';
  import { MAX_PATTERNS } from '../audio/protocol';
  import type { AudioEngine } from '../audio/engine';
  import { currentPattern } from '../state/project.svelte';
  import type { PatternTrack, Project } from '../state/project.svelte';
  import Plus from 'phosphor-svelte/lib/Plus';
  import Copy from 'phosphor-svelte/lib/Copy';
  import PencilSimple from 'phosphor-svelte/lib/PencilSimple';
  import Trash from 'phosphor-svelte/lib/Trash';
  import Icon from './Icon.svelte';
  import BookmarkSimple from 'phosphor-svelte/lib/BookmarkSimple';
  import Books from 'phosphor-svelte/lib/Books';
  import LibraryList from './LibraryList.svelte';
  import { flashHint } from '../state/banners.svelte';
  import { LIBRARY_NAME_MAX, defaultLibraryName, saveBlocked, savePatternToLibrary } from '../state/pattern-library';
  import {
    PATTERNS_FULL_TEXT, deletePattern, duplicatePattern, newPattern, renamePattern, selectPattern,
  } from '../state/pattern-actions';

  let { p, engine, track }: { p: Project; engine: AudioEngine; track: PatternTrack } = $props();

  const cur = $derived(currentPattern(track));
  const used = $derived(track.clips.filter((c) => c.patternId === cur.id).length);
  const full = $derived(track.patterns.length >= MAX_PATTERNS);
  const deleteTip = $derived(
    track.patterns.length <= 1 ? 'A track needs at least one pattern'
    : used > 0 ? `Used by ${used} clip${used === 1 ? '' : 's'}`
    : 'Delete this pattern',
  );

  let renaming = $state(false);
  let draft = $state('');
  let input = $state<HTMLInputElement | null>(null);

  async function startRename() {
    draft = cur.name;
    renaming = true;
    await tick();
    input?.focus();
    input?.select();
  }
  function commit() {
    if (renamePattern(p, engine, track.id, cur.id, draft)) renaming = false;
    else input?.focus(); // empty: rejected, keep editing
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      renaming = false;
    }
  }
  // Leaving the input without Enter cancels (no surprise rename).
  const cancel = () => (renaming = false);

  // ---- the library ----
  let saving = $state(false);
  let saveInput = $state<HTMLInputElement | null>(null);
  async function startSave() {
    draft = defaultLibraryName(track, cur.name);
    saving = true;
    await tick();
    saveInput?.focus();
    saveInput?.select();
  }
  function saveKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const entry = savePatternToLibrary(p, track.id, cur.id, draft);
      if (!entry) return void saveInput?.focus(); // empty: rejected, keep editing
      void endSave();
      flashHint(`Saved “${entry.name}” to the pattern library`);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void endSave();
    }
  }
  let saveBtn = $state<HTMLButtonElement | null>(null);
  const saveWhy = $derived(saveBlocked(p));
  /** Back from the name field to the Save button (Enter or Esc; not a blur, which moved the focus already). */
  async function endSave() {
    saving = false;
    await tick();
    saveBtn?.focus();
  }

  let libOpen = $state(false);
  let loadBtn = $state<HTMLButtonElement | null>(null);
  let pop = $state<HTMLElement | null>(null);
  async function toggleLib() {
    libOpen = !libOpen;
    if (!libOpen) return;
    await tick();
    // The first usable button; an empty (or all-inert) list: the list itself, so Esc still reaches popKey.
    (pop?.querySelector<HTMLElement>('button:not([aria-disabled="true"])') ?? pop?.querySelector<HTMLElement>('[data-testid="pattern-library"]'))?.focus();
  }
  function closeLib(refocus: boolean) {
    libOpen = false;
    if (refocus) loadBtn?.focus();
  }
  function popKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (e.defaultPrevented) return; // the rename field ended its rename
      e.preventDefault();
      closeLib(true);
    }
    // Keys stay in the popover (Space presses a button, letters play nothing); Cmd / Ctrl chords pass.
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  }
  /** Focus left the Load button + popover pair (Tab / Shift+Tab out): close.
   *  A null relatedTarget (a press on nothing focusable, a re-rendered row)
   *  is left to the pointer rule below. */
  function libFocusOut(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (libOpen && to && !(e.currentTarget as HTMLElement).contains(to)) closeLib(false);
  }
  // A press outside the popover (and its Load button) closes it.
  $effect(() => {
    if (!libOpen) return;
    const outside = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!pop?.contains(n) && !loadBtn?.contains(n)) closeLib(false);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  });

  // A different track/pattern selected elsewhere ends an open rename / save / library.
  $effect(() => {
    void track.id;
    void track.currentPatternId;
    renaming = false;
    saving = false;
    libOpen = false;
  });
</script>

<span class="picker">
  {#if saving}
    <input class="name" bind:this={saveInput} bind:value={draft} maxlength={LIBRARY_NAME_MAX} data-testid="pattern-save-input"
      aria-label="Library name for this pattern" title="Enter saves a copy to the pattern library, Esc cancels"
      onkeydown={saveKey} onblur={() => (saving = false)} />
  {:else if renaming}
    <input class="name" bind:this={input} bind:value={draft} maxlength="40" data-testid="pattern-rename-input"
      aria-label="Pattern name" onkeydown={onKey} onblur={cancel} />
  {:else}
    <select data-testid="pattern-picker" aria-label="Pattern" title={cur.name} value={track.currentPatternId} onkeydown={selectKey}
      onchange={(e) => { selectPattern(p, engine, track.id, e.currentTarget.value); releaseSelect(e.currentTarget); }}>
      {#each track.patterns as pat (pat.id)}
        <option value={pat.id}>{pat.name}</option>
      {/each}
    </select>
  {/if}
  <button class="btn" data-testid="pattern-new" disabled={full} title={full ? PATTERNS_FULL_TEXT : 'New empty pattern'}
    onclick={() => newPattern(p, engine, track.id)}><Icon icon={Plus} /> New</button>
  <button class="btn" data-testid="pattern-dup" aria-label="Duplicate" disabled={full} title={full ? PATTERNS_FULL_TEXT : 'Duplicate this pattern'}
    onclick={() => duplicatePattern(p, engine, track.id)}><Icon icon={Copy} /><span class="t"> Duplicate</span></button>
  <button class="btn" data-testid="pattern-rename" title="Rename this pattern" onmousedown={(e) => e.preventDefault()} aria-label="Rename" onclick={startRename}><Icon icon={PencilSimple} /><span class="t"> Rename</span></button>
  <button class="btn" data-testid="pattern-delete" disabled={track.patterns.length <= 1 || used > 0} title={deleteTip}
    aria-label="Delete" onclick={() => deletePattern(p, engine, track.id, cur.id)}><Icon icon={Trash} /><span class="t"> Delete</span></button>
  <button class="btn ic" data-testid="pattern-save" bind:this={saveBtn} aria-label="Save to library" disabled={!!saveWhy}
    title={saveWhy ?? "Save a copy of this pattern to the project's pattern library"}
    onmousedown={(e) => e.preventDefault()} onclick={startSave}><Icon icon={BookmarkSimple} /></button>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span class="lib" onfocusout={libFocusOut}>
    <button class="btn ic" data-testid="pattern-load" bind:this={loadBtn} aria-label="Load from library" aria-expanded={libOpen}
      aria-controls="pattern-library-pop" title="Load a pattern from the project's library or the factory patterns as a new pattern" onclick={toggleLib}><Icon icon={Books} /></button>
    {#if libOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="pop" id="pattern-library-pop" data-testid="pattern-library-pop" bind:this={pop} onkeydown={popKey}>
        <p class="sec">Pattern library</p>
        <LibraryList {p} {engine} {track} testid="pattern-library" onloaded={() => closeLib(true)} />
      </div>
    {/if}
  </span>
</span>

<style>
  /* Tokens only (theme.css): the select and the rename field take the global
     skins; the buttons are compact .btn (raised), 11 px text because the
     bottom panel header is a dense row. Every control here is --ctl-h (24 px)
     tall, the same box as the pattern transport's well and the tab tray
     beside it, so the header row reads as one line of equal pills. */
  .picker { display: inline-flex; align-items: center; gap: 4px; --ctl-h: 24px; }
  .btn, select, .name { box-sizing: border-box; height: var(--ctl-h); }
  .btn { padding: 0 6px; font-size: 11px; }
  /* One fixed width for the picker and the name fields that replace it
     (plan 30): a long pattern name is cut (its tooltip has all of it), and
     the buttons after it never move. */
  select { width: 150px; padding: 0 4px 0 6px; font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
  .name { width: 150px; box-shadow: var(--well-shadow), 0 0 0 2px var(--accent); }
  .ic { display: inline-flex; align-items: center; padding: 0 4px; }
  /* Room for Save / Load in the one-row header at 1280 px (layout.spec.ts):
     Duplicate, Rename and Delete are icon-only below 1600 px (their names
     stay: aria-label, and the tooltip says what each does). */
  @media (max-width: 1599px) { .t { display: none; } }
  /* The library popover: a --panel card with the lift (as the menus), under its button. */
  .lib { position: relative; display: inline-flex; }
  .pop {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 20; width: max-content; min-width: 240px; max-width: 320px;
    max-height: min(360px, 50vh); overflow-y: auto; padding: 6px;
    background: var(--panel); border-radius: var(--r-md); box-shadow: var(--lift); color: var(--text);
  }
  .sec {
    margin: 2px 8px 4px; font: 600 var(--fs-lbl) var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2);
  }
</style>
