<script lang="ts">
  import StartOverlay from './ui/StartOverlay.svelte';
  import { Op } from './audio/protocol';
  import type { AudioEngine } from './audio/engine';

  let engine = $state.raw<AudioEngine | null>(null);

  // Exposed unconditionally (personal local app): e2e tests and the console use it.
  window.__daw = { engine: null, Op };

  function onstarted(e: AudioEngine) {
    engine = e;
    window.__daw.engine = e;
  }
</script>

<h1>House DAW</h1>
{#if !engine}
  <StartOverlay {onstarted} />
{/if}
