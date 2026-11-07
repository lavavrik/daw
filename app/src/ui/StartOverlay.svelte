<script lang="ts">
  // Browsers only let audio start from a user gesture, so the app opens behind
  // this full-screen button. It starts the engine and hides once running,
  // with the latency hint last applied in the audio settings (audio/restart.ts).
  import { AudioEngine } from '../audio/engine';
  import { loadLatencyHint } from '../audio/restart';

  // `note`: a standing message for this tab (App: "Autosave is off — …" when
  // another tab owns the autosave), shown before audio starts too.
  let { onstarted, note = null }: { onstarted: (engine: AudioEngine) => void; note?: string | null } = $props();

  let busy = $state(false);
  let started = $state(false);
  let error = $state<string | null>(null);

  async function start() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const engine = await AudioEngine.start({ latencyHint: loadLatencyHint() });
      started = true;
      onstarted(engine);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if !started}
  <button class="overlay" onclick={start} disabled={busy}>
    <span class="label">Click to start audio</span>
    {#if busy}<span class="hint">Starting…</span>{/if}
    {#if error}<span class="error">Could not start audio: {error}</span>{/if}
    {#if note}<span class="note" data-testid="autosave-off">{note}</span>{/if}
  </button>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    border: 0;
    background: rgb(12 12 14 / 0.92);
    color: #eee;
    font: inherit;
    cursor: pointer;
  }
  .label {
    font-size: 1.5rem;
    letter-spacing: 0.02em;
  }
  .hint {
    opacity: 0.6;
  }
  .note {
    opacity: 0.6;
    font-size: 0.9rem;
  }
  .error {
    color: #ff7a7a;
    max-width: 40rem;
  }
</style>
