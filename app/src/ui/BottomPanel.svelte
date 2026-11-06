<script lang="ts">
  import type { Project } from '../state/project.svelte';

  let { p }: { p: Project } = $props();
  const track = $derived(p.tracks.find((t) => t.id === p.selectedTrackId) ?? null);
  const later = 'Coming in a later milestone';
</script>

<section class="pane">
  <div class="head">
    {#if track}
      <span class="swatch" style:background={track.color}></span>
      <b>{track.name}</b>
    {:else}
      <span class="none">No track selected</span>
    {/if}
    <span class="tabs">
      <button class="tab active">Step grid</button>
      <button class="tab" disabled title={later}>Piano roll</button>
      <button class="tab" disabled title={later}>Instrument</button>
      <button class="tab" disabled title={later}>Mixer</button>
    </span>
  </div>
  <div class="body">Step grid arrives in the next task</div>
</section>

<style>
  .pane { background: #1b1c21; border: 1px solid #2a2c33; display: flex; flex-direction: column; min-height: 0; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #2a2c33; }
  .swatch { width: 12px; height: 12px; border-radius: 3px; }
  .none { color: #7d808c; }
  .tabs { margin-left: auto; display: flex; gap: 2px; }
  .tab { font: inherit; font-size: 11px; padding: 3px 10px; border: 0; border-radius: 3px 3px 0 0; background: #24262c; color: #c9cbd3; }
  .tab.active { background: #f0a23a; color: #111; }
  .tab:disabled { opacity: 0.45; cursor: not-allowed; }
  .body { padding: 12px; color: #7d808c; overflow: auto; flex: 1; }
</style>
