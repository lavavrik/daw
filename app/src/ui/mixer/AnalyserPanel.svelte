<script lang="ts">
  // The mixer's analyser (plan 12 Task 3; docs/architecture/visuals.md
  // *Analyser*): right of the Master strip, 340 px wide, scrolling with the
  // strips. It shows the Master, or the one strip whose "∿" toggle is on
  // (ui/vis/analyserBus.ts owns that choice: view state, not saved, not an
  // edit; a removed track falls back to the Master).
  //
  //   header   "Analyser · Master" / "Analyser · <strip name>" (strip colour:
  //            a track's, or a return's `--return-<slot>` by name, plan 29)
  //   spectrum 320 × 140, 60 bands, peak-hold dots, grid, hover readout
  //   stereo   120 × 120 goniometer + correlation bar: the Master only
  //
  // Everything per frame is drawn by the views straight from the bus.
  import { returnChannel } from '../../state/returns';
  import type { Project } from '../../state/project.svelte';
  import { analyserBus, type AnalyserSource } from '../vis/analyserBus';
  import Goniometer from '../vis/Goniometer.svelte';
  import Spectrum from '../vis/Spectrum.svelte';
  import { RETURN_COLORS, THEME } from '../theme';

  let { p }: { p: Project } = $props();

  let shown = $state<AnalyserSource>('master');
  $effect(() => analyserBus().onSelect((s) => (shown = s)));

  const source = $derived.by(() => {
    if (shown === 'master') return { name: 'Master', color: null };
    const r = p.mixer.returns.find((x) => returnChannel(x) === shown);
    if (r) return { name: r.name, color: RETURN_COLORS[r.slot] ?? null }; // a value: the spectrum draws on a canvas
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
  <Spectrum need="panel" width={320} height={140} color={source.color ?? THEME.textDim} />
  {#if shown === 'master'}
    <Goniometer />
  {:else}
    <p class="note">Goniometer and correlation: Master only.</p>
  {/if}
</section>

<style>
  .analyser { width: 340px; flex: none; box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 0 10px 10px; background: var(--panel); border-radius: var(--r-lg); box-shadow: var(--lift); overflow: hidden; }
  header { display: flex; align-items: baseline; gap: 4px; margin: 0 -10px; padding: 6px 10px; background: var(--raised) var(--gloss); font-size: var(--fs-ctl); color: var(--text-2); white-space: nowrap; min-width: 0; }
  header b { color: var(--text); }
  .src { font-weight: 600; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .back { margin-left: auto; font: 600 var(--fs-lbl) var(--font-ui); border: 0; border-radius: var(--r-sm); background: var(--raised); box-shadow: var(--raised-shadow); color: var(--text); padding: 1px 8px; cursor: pointer; }
  .back:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .note { margin: 0; font-size: var(--fs-lbl); color: var(--text-2); }
</style>
