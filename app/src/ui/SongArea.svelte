<script lang="ts">
  // Top-centre Song pane (layout B): the song timeline, whose left column is
  // the track list (headers + add buttons).
  import type { Project } from '../state/project.svelte';
  import type { AudioEngine } from '../audio/engine';
  import type { AudioClock } from '../audio/audioClock';
  import Timeline from './song/Timeline.svelte';

  let { p, engine, clock }: { p: Project; engine: AudioEngine; clock: AudioClock | null } = $props();
</script>

<section class="pane">
  <Timeline {p} {engine} {clock} />
</section>

<style>
  .pane { background: var(--work); border: 1px solid var(--line); min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
</style>
