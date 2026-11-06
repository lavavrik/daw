<script lang="ts">
  // One keyboard-accessible button per track. Selection is shown by a colour
  // bar + lighter background + a "▶" marker (not colour alone), and the kind
  // label says what each track is. The × only appears on hover/focus.
  import type { AudioEngine } from '../audio/engine';
  import type { Project } from '../state/project.svelte';
  import { addDrumTrack, removeTrack, selectTrack } from '../state/actions';
  import { addSynthTrack } from '../state/rack-actions';
  import { STARTER_PATCHES } from '../state/patches';

  let { p, engine }: { p: Project; engine: AudioEngine } = $props();
  const deepBass = STARTER_PATCHES.find((x) => x.name === 'Deep Bass') ?? STARTER_PATCHES[0];

  function remove(id: string, name: string) {
    if (confirm(`Remove track "${name}"?`)) removeTrack(p, engine, id);
  }
</script>

<div class="list">
  {#each p.tracks as t (t.id)}
    {@const sel = t.id === p.selectedTrackId}
    <div class="row" class:sel style:--c={t.color}>
      <button
        class="main"
        data-testid={`track-${t.slot}`}
        aria-pressed={sel}
        onclick={() => selectTrack(p, engine, t.id)}
      >
        <span class="mark">{sel ? '▶' : ''}</span>
        <span class="sw" style:background={t.color}></span>
        <b class="name">{t.name}</b>
        <span class="kind">{t.kind === 'drum' ? 'Drums' : `Synth · ${t.patchName}`}</span>
      </button>
      <button class="x" aria-label={`Remove track ${t.name}`} title="Remove track" onclick={() => remove(t.id, t.name)}>×</button>
    </div>
  {/each}
  {#if p.tracks.length === 0}<p class="empty">No tracks yet</p>{/if}
</div>
<div class="add">
  <button data-testid="add-drum-track" onclick={() => addDrumTrack(p, engine)}>+ Drum track</button>
  <button data-testid="add-synth-track" onclick={() => addSynthTrack(p, engine, undefined, deepBass)}>+ Synth track</button>
</div>

<style>
  .list { display: flex; flex-direction: column; gap: 2px; }
  .row { display: flex; align-items: stretch; border-left: 4px solid var(--c); background: #20222a; border-radius: 0 3px 3px 0; }
  .row:hover, .row:focus-within { background: #272a33; }
  .row.sel { background: #343846; box-shadow: inset 0 0 0 1px #4a4f63; }
  .main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 4px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .main:focus-visible, .x:focus-visible, .add button:focus-visible { outline: 2px solid #f0a23a; outline-offset: -2px; }
  .mark { width: 10px; color: #f0a23a; font-size: 9px; }
  .sw { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .name { color: #e6e7ec; white-space: nowrap; }
  .row:not(.sel) .name { font-weight: 500; color: #c9cbd3; }
  .kind { margin-left: auto; color: #8d90a0; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .x { width: 24px; border: 0; background: transparent; color: #9a9dab; font-size: 15px; cursor: pointer; opacity: 0; }
  .row:hover .x, .row:focus-within .x, .x:focus-visible { opacity: 1; }
  .x:hover { color: #ff8a92; }
  .add { display: flex; gap: 6px; margin-top: 8px; }
  .add button { font: inherit; padding: 4px 10px; border: 1px solid #3a3d48; border-radius: 3px; background: #24262c; color: #c9cbd3; cursor: pointer; }
  .add button:hover { background: #2e313a; }
  .empty { color: #7d808c; margin: 0; }
</style>
