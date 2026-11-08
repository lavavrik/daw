<script lang="ts">
  // The audio pill while audio is not running (audio/audioStatus.ts): it sits
  // in the ⚙ latency pill's slot (TopBar), or alone in App's bare bar when
  // the engine could not be built. Paused: --accent, "Audio paused — click
  // anywhere to start". Failed: --rec, "Audio failed — retry", the error in
  // the tooltip. A click resumes (paused) or retries (failed); any other
  // click on the page resumes too (App's capture-phase listener).
  // Height: --pill-h (TopBar's small row: 22 px, 17 px in short windows).
  import type { AudioStatus } from '../audio/audioStatus';
  import { FAILED_LABEL, PAUSED_LABEL, audioStatusTitle } from '../audio/audioStatus';

  let { status, onresume }: { status: AudioStatus; onresume: () => void } = $props();
</script>

{#if status.kind === 'paused' || status.kind === 'failed'}
  <button
    class="pill" class:failed={status.kind === 'failed'} title={audioStatusTitle(status)} onclick={onresume}
  >{status.kind === 'failed' ? FAILED_LABEL : PAUSED_LABEL}</button>
{/if}

<style>
  /* A filled pill (vivid colour, --on-color text), like TopBar's warning pills. */
  .pill {
    position: relative; display: inline-flex; align-items: center; height: var(--pill-h, 22px); box-sizing: border-box; padding: 0 8px;
    border: 0; border-radius: var(--r-md); background: var(--accent) var(--gloss); box-shadow: var(--raised-shadow);
    color: var(--on-color); font: 700 11px var(--font-ui); white-space: nowrap; cursor: pointer;
  }
  .pill.failed { background-color: var(--rec); }
  .pill:hover { filter: brightness(1.08); }
  .pill:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  /* A 24 px hit area around a short pill. */
  .pill::after { content: ''; position: absolute; inset: -4px -2px; }
</style>
