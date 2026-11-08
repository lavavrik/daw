<script lang="ts">
  // The mixer's analyser (plan 12 Task 3; docs/architecture/visuals.md
  // *Analyser*): right of the Master strip, at least 1260 px wide (flex 3: the
  // spectrum is ≥ 3× the old 320 px), scrolling with the strips. It shows the Master, or the one strip whose "∿" toggle is on
  // (ui/vis/analyserBus.ts owns that choice: view state, not saved, not an
  // edit; a removed track falls back to the Master).
  //
  //   header   "Analyser · Master" / "Analyser · <strip name>" (strip colour)
  //   spectrum fills the panel (≥ 960 × 140, re-measured on resize), 60 bands, peak-hold dots, grid, hover readout
  //   stereo   120 × 120 goniometer + correlation bar, beside the spectrum: the Master only
  //
  // Everything per frame is drawn by the views straight from the bus.
  import { MIX_DELAY, MIX_REVERB } from '../../audio/protocol';
  import type { Project } from '../../state/project.svelte';
  import { analyserBus, type AnalyserSource } from '../vis/analyserBus';
  import Goniometer from '../vis/Goniometer.svelte';
  import Spectrum from '../vis/Spectrum.svelte';
  import { THEME } from '../theme';

  let { p }: { p: Project } = $props();

  /** The spectrum column's measured width (CSS px); Spectrum re-fits its canvas to it. */
  let specW = $state(960);
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
    <b>Analyser</b> · <span class="src" style:color={source.color ?? 'var(--text)'} data-testid="analyser-source">{source.name}</span>
    {#if shown !== 'master'}
      <button type="button" class="back" onclick={() => analyserBus().select('master')} title="Show the Master again (or press the strip's ∿ again)">Master</button>
    {/if}
  </header>
  <div class="body">
    <div class="specCol" bind:clientWidth={specW}>
      <Spectrum need="panel" width={Math.max(320, Math.floor(specW))} height={140} color={source.color ?? THEME.textDim} />
    </div>
    <div class="stereoCol">
      {#if shown === 'master'}
        <Goniometer />
      {:else}
        <p class="note">Goniometer and correlation: Master only.</p>
      {/if}
    </div>
  </div>
</section>

<style>
  .analyser { flex: 3 0 1260px; min-width: 1260px; box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 0 10px 10px; background: var(--panel); border-radius: var(--r-lg); box-shadow: var(--lift); overflow: hidden; }
  header { display: flex; align-items: baseline; gap: 4px; margin: 0 -10px; padding: 6px 10px; background: var(--raised) var(--gloss); font-size: var(--fs-ctl); color: var(--text-2); white-space: nowrap; min-width: 0; }
  header b { color: var(--text); }
  .src { font-weight: 600; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .back { margin-left: auto; font: 600 var(--fs-lbl) var(--font-ui); border: 0; border-radius: var(--r-sm); background: var(--raised); box-shadow: var(--raised-shadow); color: var(--text); padding: 1px 8px; cursor: pointer; }
  .back:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .body { display: flex; gap: 12px; align-items: flex-start; }
  .specCol { flex: 1 1 0; min-width: 0; }
  .stereoCol { flex: none; width: 260px; }
  .note { margin: 0; font-size: var(--fs-lbl); color: var(--text-2); }
</style>
