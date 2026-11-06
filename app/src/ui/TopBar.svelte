<script lang="ts">
  // Transport + live engine readouts. Telemetry refreshes at 4 Hz.
  import { onMount } from 'svelte';
  import { TELEMETRY } from '../audio/protocol';
  import type { AudioEngine } from '../audio/engine';
  import { setMetronome, setTempo, togglePlay } from '../state/actions';
  import type { Project } from '../state/project.svelte';

  let { p, engine }: { p: Project; engine: AudioEngine } = $props();

  let cpu = $state(0);
  let dropouts = $state(0);
  let latency = $state('');

  function refresh() {
    cpu = Math.round(engine.telemetry()[TELEMETRY.cpu] * 100);
    dropouts = engine.dropouts();
    latency = `${engine.sampleRate / 1000} kHz · ${engine.latencyMs().toFixed(1)} ms`;
  }

  onMount(() => {
    refresh();
    const id = setInterval(refresh, 250);
    return () => clearInterval(id);
  });

  function commitTempo(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    setTempo(p, engine, input.valueAsNumber);
    input.value = String(p.tempo); // show the clamped result
  }
</script>

<header class="bar">
  <button class="play" class:on={p.playing} onclick={() => togglePlay(p, engine)} title="Play / Stop (Space)">
    {p.playing ? '■ Stop' : '▶ Play'}
  </button>
  <label class="bpm">
    <span class="lbl">BPM</span>
    <input
      type="number"
      min="20"
      max="300"
      step="1"
      value={p.tempo}
      onchange={commitTempo}
      onkeydown={(e) => e.key === 'Enter' && commitTempo(e)}
    />
  </label>
  <button class="metro" class:on={p.metronome} aria-pressed={p.metronome} onclick={() => setMetronome(p, engine, !p.metronome)} title="Metronome">
    Metronome
  </button>
  <span class="spacer"></span>
  <span class="pill">CPU {cpu}%</span>
  <span class="pill" class:bad={dropouts > 0}>Dropouts {dropouts}</span>
  <span class="pill">{latency}</span>
</header>

<style>
  .bar { display: flex; gap: 10px; align-items: center; padding: 6px 10px; background: #1f2026; border-bottom: 1px solid #2a2c33; }
  .spacer { flex: 1; }
  button, .pill, input { font: inherit; color: #c9cbd3; background: #2a2c33; border: 1px solid #34363e; border-radius: 4px; padding: 4px 10px; }
  button { cursor: pointer; }
  button:hover { background: #33353e; }
  button.on { background: #f0a23a; color: #111; border-color: #f0a23a; }
  .bpm { display: flex; align-items: center; gap: 6px; }
  .lbl { font-size: 10px; letter-spacing: 0.06em; color: #7d808c; }
  input { width: 64px; }
  .pill { background: transparent; border-color: transparent; color: #9a9da8; font-variant-numeric: tabular-nums; }
  .pill.bad { color: #ff6b6b; font-weight: 600; }
</style>
