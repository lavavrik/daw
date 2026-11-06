<script lang="ts">
  import type { Project } from '../state/project.svelte';
  import type { AudioEngine } from '../audio/engine';
  import StepGrid from './StepGrid.svelte';
  import { banners } from '../state/banners.svelte';

  let { p, engine }: { p: Project; engine: AudioEngine } = $props();
  const track = $derived(p.tracks.find((t) => t.id === p.selectedTrackId) ?? null);
  const later = 'Coming in a later milestone';
  // Which tab is shown follows the selected track's kind: drum -> Step grid,
  // synth -> Instrument (the only tab each kind has so far).
  const active = $derived(track?.kind === 'synth' ? 'instrument' : track?.kind === 'drum' ? 'step' : null);

  // Banners show here (top of the body); any code can raise them via `banners`.
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
      <button class="tab" class:active={active === 'step'} disabled={track?.kind !== 'drum'} title={track?.kind === 'drum' ? '' : 'Select a drum track'}>Step grid</button>
      <button class="tab" disabled title={later}>Piano roll</button>
      <button class="tab" class:active={active === 'instrument'} disabled={track?.kind !== 'synth'} title={track?.kind === 'synth' ? '' : 'Select a synth track'}>Instrument</button>
      <button class="tab" disabled title={later}>Mixer</button>
    </span>
  </div>
  <div class="body">
    {#if banners.error}
      <div class="banner err" data-testid="banner" role="alert">
        <span>{banners.error}</span><button aria-label="Dismiss" onclick={() => (banners.error = null)}>×</button>
      </div>
    {/if}
    {#if banners.notice}
      <div class="banner note" data-testid="notice">
        <span>{banners.notice}</span><button aria-label="Dismiss" onclick={() => (banners.notice = null)}>×</button>
      </div>
    {/if}
    {#if track && track.kind === 'drum'}
      <StepGrid {p} {engine} {track} onerror={(m) => (banners.error = m)} onnotice={(m) => (banners.notice = m)} />
    {:else if track && track.kind === 'synth'}
      <!-- Task 9 replaces this placeholder with <Rack>. -->
      <p class="none" data-testid="instrument-body">Rack arrives in the next task</p>
    {/if}
  </div>
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
  .body { padding: 8px; overflow: auto; flex: 1; }
  .banner { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 5px 8px; margin-bottom: 6px; border-radius: 3px; }
  .banner button { font: inherit; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 14px; }
  .err { background: #4a2024; color: #ffb3b8; border: 1px solid #7a3037; }
  .note { background: #2b2a1c; color: #ffd98a; border: 1px solid #5a512b; }
</style>
