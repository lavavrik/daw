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
  /* The work surface, near-opaque, with the prompt as a primary (accent) pill. */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    border: 0;
    background: color-mix(in srgb, var(--work) 94%, transparent);
    color: var(--text);
    font: var(--fs-body) var(--font-ui);
    cursor: pointer;
  }
  .label {
    padding: 12px 24px;
    border-radius: var(--r-lg);
    background: var(--accent) var(--gloss);
    box-shadow: var(--raised-shadow), 0 0 10px color-mix(in srgb, var(--accent) 40%, transparent);
    color: var(--on-color);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 0.01em;
  }
  .overlay:focus-visible { outline: none; }
  .overlay:focus-visible .label { outline: 2px solid var(--text); outline-offset: 3px; }
  .hint,
  .note {
    color: var(--text-2);
  }
  .error {
    color: var(--rec);
    max-width: 40rem;
  }
</style>
