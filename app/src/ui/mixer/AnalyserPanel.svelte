<script lang="ts">
  // The mixer's analyser (plan 12 Task 3; docs/architecture/visuals.md
  // *Analyser*): right of the Master strip, 340 px wide, scrolling with the
  // strips. It shows the Master, or the one strip whose "∿" toggle is on
  // (ui/vis/analyserBus.ts owns that choice: view state, not saved, not an
  // edit; a removed track falls back to the Master).
  //
  //   header   "Analyser · Master" / "Analyser · <strip name>" (strip colour)
  //   spectrum 320 × 140, 60 bands, peak-hold dots, grid, hover readout
  //   stereo   120 × 120 goniometer + correlation bar: the Master only
  //
  // Everything per frame is drawn by the views straight from the bus.
  import { MIX_DELAY, MIX_REVERB } from '../../audio/protocol';
  import type { Project } from '../../state/project.svelte';
  import { analyserBus, type AnalyserSource } from '../vis/analyserBus';
  import Goniometer from '../vis/Goniometer.svelte';
  import Spectrum from '../vis/Spectrum.svelte';

  let { p }: { p: Project } = $props();

  const NEUTRAL = '#9aa6c4';
  let shown = $state<AnalyserSource>('master');
  $effect(() => analyserBus().onSelect((s) => (shown = s)));

  const source = $derived.by(() => {
    if (shown === 'master') return { name: 'Master', color: null };
    if (shown === MIX_REVERB) return { name: 'Reverb', color: null };
    if (shown === MIX_DELAY) return { name: 'Delay', color: null };
    const t = p.tracks.find((tr) => tr.slot === shown);
    return { name: t?.name ?? `Channel ${shown}`, color: t?.color ?? null };
  });
</script>

<section class="analyser" data-testid="analyser" data-source={shown} aria-label="Analyser">
  <header>
    <b>Analyser</b> · <span class="src" style:color={source.color ?? '#e6e7ec'} data-testid="analyser-source">{source.name}</span>
    {#if shown !== 'master'}
      <button type="button" class="back" onclick={() => analyserBus().select('master')} title="Show the Master again (or press the strip's ∿ again)">Master</button>
    {/if}
  </header>
  <Spectrum need="panel" width={320} height={140} color={source.color ?? NEUTRAL} />
  {#if shown === 'master'}
    <Goniometer />
  {:else}
    <p class="note">Goniometer and correlation: Master only.</p>
  {/if}
</section>

<style>
  .analyser { width: 340px; flex: none; box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 4px 10px 8px; background: #1c1d22; border: 1px solid #2a2c33; border-top: 3px solid #6b7080; border-radius: 3px; }
  header { display: flex; align-items: baseline; gap: 4px; font-size: 12px; color: #a3a6b3; white-space: nowrap; min-width: 0; }
  header b { color: #e6e7ec; }
  .src { font-weight: 600; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .back { margin-left: auto; font: 10px ui-sans-serif, system-ui, sans-serif; border: 1px solid #3a3d47; border-radius: 3px; background: #2a2c33; color: #c9cbd3; padding: 0 6px; cursor: pointer; }
  .back:hover { background: #33353e; }
  .note { margin: 0; font-size: 10px; color: #6b6e7a; }
</style>
