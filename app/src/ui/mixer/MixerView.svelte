<script lang="ts">
  // The Mixer tab: the whole mixer, whatever track is selected. A horizontal
  // scroll of strips — one per track in track order (same order and colours
  // as the track headers), then the Reverb and Delay returns and the Master,
  // which are styled neutrally so they never pass for tracks. Clicking a
  // track strip's name selects that track (the tab stays on the mixer).
  //
  // Meters: the app's one frame loop (ui/vis/frameLoop.ts) ticks the
  // MeterBus, which reads engine.meters() and fans it out to every strip. A
  // consumer with want 0 (the meters have their own SAB), watching the mixer
  // element: it stops while the mixer is off screen or the tab is hidden, and
  // is removed when the view is destroyed (switching tabs).
  import { onMount } from 'svelte';
  import type { AudioEngine } from '../../audio/engine';
  import { MIX_DELAY, MIX_MASTER, MIX_REVERB } from '../../audio/protocol';
  import { selectTrack } from '../../state/actions';
  import type { Project } from '../../state/project.svelte';
  import { createMeterBus } from './meterBus';
  import { frameLoop } from '../vis/frameLoop';
  import Strip from './Strip.svelte';

  let { p, engine }: { p: Project; engine: AudioEngine } = $props();

  const bus = createMeterBus();
  let mixerEl: HTMLDivElement;
  onMount(() => frameLoop().add({ want: 0, el: mixerEl, frame: (now) => bus.tick(engine.meters(), now) }));
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
  <Strip {p} {engine} {bus} target="reverb" kind="return" channel={MIX_REVERB} name="Reverb" subtitle="Return (send A)" />
  <Strip {p} {engine} {bus} target="delay" kind="return" channel={MIX_DELAY} name="Delay" subtitle="Return (send B)" />
  <Strip {p} {engine} {bus} target="master" kind="master" channel={MIX_MASTER} name="Master" subtitle="Limiter → output" />
</div>

<style>
  .mixer { display: flex; align-items: flex-start; gap: 4px; overflow-x: auto; overflow-y: visible; padding-bottom: 4px; min-width: 0; }
  .gap { width: 8px; flex: none; align-self: stretch; border-left: 1px dashed #3a3d47; margin-left: 4px; }
  .empty { color: #7d808c; margin: 8px; flex: none; }
</style>
