<script lang="ts">
  // The Mixer tab: the whole mixer, whatever track is selected. A horizontal
  // scroll of strips — one per track in track order (same order and colours
  // as the track headers), then the returns (p.mixer.returns, in creation
  // order; plan 29), the dashed "+ Return" ghost strip (AddReturn; gone at
  // MAX_RETURNS) and the Master. Returns and the Master are styled neutrally
  // so they never pass for tracks (a return wears its colour only on its dot
  // and its knobs). Clicking a
  // track strip's name selects that track (the tab stays on the mixer).
  //
  // Meters: the app's one frame loop (ui/vis/frameLoop.ts) ticks the
  // MeterBus, which reads engine.meters() and fans it out to every strip. A
  // consumer with want 0 (the meters have their own SAB), watching the mixer
  // element: it stops while the mixer is off screen or the tab is hidden, and
  // is removed when the view is destroyed (switching tabs). It is an idle
  // driver too: stopped with every meter at rest, it leaves the loop after
  // 0.5 s and the next Play / note / edit brings it back.
  //
  // The analyser (AnalyserPanel, right of the Master; plan 12 Task 3) shows
  // the Master or the strip whose ∿ toggle is on: the analyser bus
  // (ui/vis/analyserBus.ts) owns that choice and the strip tap (OP_VIS_TAP);
  // the effect below tells it which strips exist, so a removed track's
  // selection falls back to the Master.
  import { onMount } from 'svelte';
  import type { AudioEngine } from '../../audio/engine';
  import { MIX_MASTER } from '../../audio/protocol';
  import { MAX_RETURNS, returnChannel } from '../../state/returns';
  import { selectTrack } from '../../state/actions';
  import type { Project } from '../../state/project.svelte';
  import { createMeterBus } from './meterBus';
  import { frameLoop } from '../vis/frameLoop';
  import { createIdleDriver } from '../vis/idleDriver';
  import Strip from './Strip.svelte';
  import AnalyserPanel from './AnalyserPanel.svelte';
  import AddReturn from './AddReturn.svelte';
  import { returnSummary } from './returnSummary';
  import { analyserBus } from '../vis/analyserBus';

  let { p, engine }: { p: Project; engine: AudioEngine } = $props();

  const bus = createMeterBus();
  let mixerEl: HTMLDivElement;
  // An idle driver: out of the loop once stopped with every meter at rest.
  onMount(() => {
    const d = createIdleDriver({ loop: frameLoop(), want: 0, el: mixerEl, frame: (now) => bus.tick(engine.meters(), now) });
    d.kick();
    return () => d.stop();
  });
  $effect(() => analyserBus().sync([
    ...p.tracks.map((t) => ({ ch: t.slot, key: t.id })),
    ...p.mixer.returns.map((r) => ({ ch: returnChannel(r), key: r.id })),
  ]));
</script>

<div class="mixer" data-testid="mixer" bind:this={mixerEl}>
  {#each p.tracks as t (t.id)}
    <Strip
      {p} {engine} {bus}
      target={t.id}
      kind="track"
      channel={t.slot}
      name={t.name}
      color={t.color}
      subtitle={t.kind === 'drum' ? 'Drums' : t.kind === 'audio' ? 'Audio' : `Synth · ${t.patchName}`}
      selected={t.id === p.selectedTrackId}
      onselect={() => selectTrack(p, engine, t.id)}
    />
  {/each}
  {#if p.tracks.length === 0}<p class="empty">No tracks yet — add one in the track list.</p>{/if}
  <div class="gap" aria-hidden="true"></div>
  {#each p.mixer.returns as r (r.id)}
    <Strip {p} {engine} {bus} target={r.id} kind="return" channel={returnChannel(r)} name={r.name} subtitle={returnSummary(r)} />
  {/each}
  {#if p.mixer.returns.length < MAX_RETURNS}<AddReturn {p} {engine} />{/if}
  <Strip {p} {engine} {bus} target="master" kind="master" channel={MIX_MASTER} name="Master" subtitle="Limiter → output" />
  <AnalyserPanel {p} />
</div>

<style>
  /* The --work canvas the strip cards sit on. */
  .mixer { display: flex; align-items: flex-start; gap: 8px; overflow-x: auto; overflow-y: visible; padding: 8px 8px 12px; background: var(--work); min-width: 0; }
  .gap { width: 8px; flex: none; align-self: stretch; border-left: 1px dashed var(--line); margin-left: 4px; }
  .empty { color: var(--text-2); margin: 8px; flex: none; }
</style>
