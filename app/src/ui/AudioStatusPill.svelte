<script lang="ts">
  // The audio pill while audio is not running (audio/audioStatus.ts): it sits
  // in the ⚙ latency pill's slot (TopBar), or alone in App's bare bar when
  // the engine could not be built. Paused: --accent, "Audio paused — click
  // anywhere to start" after a SpeakerSlash icon. Failed: --rec, "Audio
  // failed — retry", the error in the tooltip. A click resumes (paused) or
  // retries (failed); any other click on the page resumes too (App's
  // capture-phase listener). Starting (App's bare bar, while the engine is
  // built): a quiet "Starting audio…" line, not a button.
  // Height: --pill-h (TopBar's small row: 22 px, 17 px in short windows).
  import type { AudioStatus } from '../audio/audioStatus';
  import { FAILED_LABEL, PAUSED_LABEL, STARTING_LABEL, audioStatusTitle } from '../audio/audioStatus';
  import Icon from './Icon.svelte';
  import SpeakerSlash from 'phosphor-svelte/lib/SpeakerSlash';

  let { status, onresume }: { status: AudioStatus; onresume: () => void } = $props();
</script>

{#if status.kind === 'paused'}
  <button class="pill" title={audioStatusTitle(status)} onclick={onresume}><Icon icon={SpeakerSlash} size={12} weight="bold" />{PAUSED_LABEL}</button>
{:else if status.kind === 'failed'}
  <button class="pill failed" title={audioStatusTitle(status)} onclick={onresume}>{FAILED_LABEL}</button>
{:else if status.kind === 'starting'}
  <span class="quiet" role="status">{STARTING_LABEL}</span>
{/if}

<style>
  /* A filled pill (vivid colour, --on-color text), like TopBar's warning
     pills. Tight (600 weight, 6 px sides): at 1280 px the bar has ~240 px
     for it (MIDI and CPU step aside), audiostart.spec.ts checks one row. */
  .pill {
    position: relative; display: inline-flex; align-items: center; gap: 3px; height: var(--pill-h, 22px); box-sizing: border-box; padding: 0 6px;
    border: 0; border-radius: var(--r-md); background: var(--accent) var(--gloss); box-shadow: var(--raised-shadow);
    color: var(--on-color); font: 600 11px var(--font-ui); white-space: nowrap; cursor: pointer;
  }
  .pill.failed { background-color: var(--rec); }
  /* Below 1400 px a half pixel smaller: ~10 px of slack at 1280 px (web fonts blocked too). */
  @media (max-width: 1399px) { .pill { font-size: 10.5px; } }
  .quiet { color: var(--text-2); font: 500 11px var(--font-ui); white-space: nowrap; }
  .pill:hover { filter: brightness(1.08); }
  .pill:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  /* A 24 px hit area around a short pill. */
  .pill::after { content: ''; position: absolute; inset: -4px -2px; }
</style>
