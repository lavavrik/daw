<script lang="ts">
  // Transport + live engine readouts. Telemetry refreshes at 4 Hz. If the
  // engine dies after start, a red "Audio engine stopped — reload" alert
  // replaces the readouts (AudioEngine.onError / failure).
  import { onMount } from 'svelte';
  import { TELEMETRY } from '../audio/protocol';
  import type { AudioEngine } from '../audio/engine';
  import { setMetronome, setTempo, togglePlay } from '../state/actions';
  import type { Project } from '../state/project.svelte';
  import { liveInputTrack } from '../state/actions';
  import type { MidiStatus } from '../input/midi';

  let {
    p,
    engine,
    octave = 4,
    midi = { state: 'no-devices', devices: [] },
  }: { p: Project; engine: AudioEngine; octave?: number; midi?: MidiStatus } = $props();

  // Reactive: follows track selection (project state is $state).
  const keysTrack = $derived(liveInputTrack(p));
  const midiLabel = $derived(
    midi.state === 'connected'
      ? midi.devices[0] + (midi.devices.length > 1 ? ` +${midi.devices.length - 1}` : '')
      : midi.state === 'denied'
        ? 'blocked'
        : midi.state === 'unsupported'
          ? 'unsupported'
          : 'no device',
  );
  const midiTip = $derived(
    midi.state === 'denied'
      ? 'MIDI access is blocked. Enable it in Chrome site settings (lock icon > Site settings > MIDI devices), then reload.'
      : midi.state === 'unsupported'
        ? 'This browser has no Web MIDI. Use Chrome.'
        : midi.devices.join(', '),
  );
  const BT_TIP = 'High output latency — Bluetooth headphones? Use wired output for playing live.';

  let cpu = $state(0);
  let dropouts = $state(0);
  let latency = $state('');
  let latencyMs = $state(0);
  let engineError = $state<string | null>(null); // set from engine.failure in onMount

  function refresh() {
    cpu = Math.round(engine.telemetry()[TELEMETRY.cpu] * 100);
    dropouts = engine.dropouts();
    latencyMs = engine.latencyMs();
    latency = `${engine.sampleRate / 1000} kHz · ${latencyMs.toFixed(1)} ms`;
  }

  onMount(() => {
    refresh();
    const id = setInterval(refresh, 250);
    engine.onError = (msg) => (engineError = msg);
    engineError = engine.failure; // in case it failed before mount
    return () => {
      clearInterval(id);
      engine.onError = undefined;
    };
  });

  /** Commit on change/Enter, then release focus so Space and the piano work again. */
  function commitTempo(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    setTempo(p, engine, input.valueAsNumber);
    input.value = String(p.tempo); // show the clamped result
    input.blur();
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
  <span class="pill keys" data-testid="keys-target" title="Computer keyboard and MIDI play this track">
    Keys →
    {#if keysTrack}
      <span class="sw" style:background={keysTrack.color}></span>{keysTrack.name}
    {:else}
      (no synth track)
    {/if}
  </span>
  <span class="pill" data-testid="octave" title="QWERTY octave (Z / X)">Oct {octave}</span>
  <span class="pill" data-testid="midi-status" class:bad={midi.state === 'denied'} title={midiTip}>MIDI: {midiLabel}</span>
  <span class="spacer"></span>
  {#if engineError}
    <span class="fatal" role="alert" data-testid="engine-error" title={engineError}>
      Audio engine stopped — <button onclick={() => location.reload()}>reload</button>
    </span>
  {/if}
  <span class="pill">CPU {cpu}%</span>
  <span class="pill" class:bad={dropouts > 0}>Dropouts {dropouts}</span>
  <span class="pill" data-testid="latency" title={latencyMs > 40 ? BT_TIP : 'Output latency'}>
    Latency {latency}{#if latencyMs > 40}<span class="bt">{" "}BT?</span>{/if}
  </span>
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
  .sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin: 0 5px 0 3px; vertical-align: -1px; }
  .pill.keys { color: #c9cbd3; }
  .bt { color: #f0a23a; font-size: 10px; font-weight: 600; }
  .fatal { background: #c92a2a; color: #fff; font-weight: 700; padding: 4px 10px; border-radius: 4px; }
  .fatal button { background: #fff; color: #c92a2a; border-color: #fff; font-weight: 700; padding: 1px 8px; }
</style>
