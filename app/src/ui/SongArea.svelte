<script lang="ts">
  import type { Project } from '../state/project.svelte';
  import type { AudioEngine } from '../audio/engine';
  import TrackList from './TrackList.svelte';

  let { p, engine }: { p: Project; engine: AudioEngine } = $props();
</script>

<section class="pane">
  <div class="ttl">Tracks</div>
  <TrackList {p} {engine} />
  <p class="note">Arrangement timeline arrives in plan 4</p>
</section>

<style>
  .pane { background: #1b1c21; border: 1px solid #2a2c33; padding: 8px; overflow: auto; }
  .ttl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #7d808c; margin-bottom: 8px; }
  .note { color: #7d808c; margin: 10px 0 0; }
</style>
