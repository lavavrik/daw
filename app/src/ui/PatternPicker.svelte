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
  import { tick } from 'svelte';
  import { MAX_PATTERNS } from '../audio/protocol';
  import type { AudioEngine } from '../audio/engine';
  import { currentPattern } from '../state/project.svelte';
  import type { Project, Track } from '../state/project.svelte';
  import {
    deletePattern, duplicatePattern, newPattern, renamePattern, selectPattern,
  } from '../state/pattern-actions';

  let { p, engine, track }: { p: Project; engine: AudioEngine; track: Track } = $props();

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

  // A different track/pattern selected elsewhere ends an open rename.
  $effect(() => {
    void track.id;
    void track.currentPatternId;
    renaming = false;
  });
</script>

<span class="picker">
  {#if renaming}
    <input class="name" bind:this={input} bind:value={draft} maxlength="40" data-testid="pattern-rename-input"
      aria-label="Pattern name" onkeydown={onKey} onblur={cancel} />
  {:else}
    <select data-testid="pattern-picker" aria-label="Pattern" value={track.currentPatternId}
      onchange={(e) => { selectPattern(p, engine, track.id, e.currentTarget.value); e.currentTarget.blur(); }}>
      {#each track.patterns as pat (pat.id)}
        <option value={pat.id}>{pat.name}</option>
      {/each}
    </select>
  {/if}
  <button data-testid="pattern-new" disabled={full} title={full ? `At most ${MAX_PATTERNS} patterns per track` : 'New empty pattern'}
    onclick={() => newPattern(p, engine, track.id)}>+ New</button>
  <button data-testid="pattern-dup" disabled={full} title={full ? `At most ${MAX_PATTERNS} patterns per track` : 'Duplicate this pattern'}
    onclick={() => duplicatePattern(p, engine, track.id)}>Duplicate</button>
  <button data-testid="pattern-rename" title="Rename this pattern" onmousedown={(e) => e.preventDefault()} onclick={startRename}>Rename</button>
  <button data-testid="pattern-delete" disabled={track.patterns.length <= 1 || used > 0} title={deleteTip}
    onclick={() => deletePattern(p, engine, track.id, cur.id)}>Delete</button>
</span>

<style>
  .picker { display: inline-flex; align-items: center; gap: 4px; }
  select, .name, button { font: inherit; font-size: 11px; color: #c9cbd3; background: #2a2c33; border: 1px solid #34363e; border-radius: 3px; padding: 2px 6px; }
  .name { width: 130px; border-color: #f0a23a; }
  button { cursor: pointer; }
  button:hover:not(:disabled) { background: #33353e; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
