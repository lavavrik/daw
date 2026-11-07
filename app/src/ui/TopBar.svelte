<script lang="ts">
  // Transport + record controls + live engine readouts. Telemetry refreshes
  // at 4 Hz. If the engine dies after start, a red "Audio engine stopped —
  // reload" alert replaces the readouts (AudioEngine.onError / failure).
  //
  // Record: "● Rec" arms (R key); it is red while armed, reads "Count-in…"
  // during the count-in and "● REC" (pulsing) while notes are being recorded.
  // Play/Stop and arm go through the App (onTogglePlay / onToggleArm) so the
  // count-in and the recorder's stop tick are handled in one place. Count-in
  // and Rec offset persist in localStorage (state/recorder.ts).
  //
  // Layout: one row that never wraps at 1280 px. Every control is nowrap;
  // readouts are compact (latency "29 ms", CPU + dropouts in one pill) with
  // the full text in their tooltips.
  import { onMount, untrack } from 'svelte';
  import { TELEMETRY } from '../audio/protocol';
  import type { AudioEngine } from '../audio/engine';
  import { liveInputTrack, setMetronome, setTempo } from '../state/actions';
  import type { Project } from '../state/project.svelte';
  import type { MidiStatus } from '../input/midi';
  import { REC_OFFSET_MAX, REC_OFFSET_MIN, saveRecSettings } from '../state/recorder';
  import type { Recorder, RecStatus } from '../state/recorder';

  let {
    p,
    engine,
    octave = 4,
    midi = { state: 'no-devices', devices: [] },
    recorder,
    rec,
    onTogglePlay,
    onToggleArm,
  }: {
    p: Project;
    engine: AudioEngine;
    octave?: number;
    midi?: MidiStatus;
    recorder: Recorder;
    /** Recorder status, refreshed every frame by the App. */
    rec: RecStatus;
    onTogglePlay: () => void;
    onToggleArm: () => void;
  } = $props();

  // Mirrors of the recorder's persisted settings (the Recorder is not reactive).
  // Seeded once on purpose: the recorder is created once per session and these
  // toggles are its only writers, so untrack() states "initial value only"
  // (and silences state_referenced_locally).
  let countIn = $state(untrack(() => recorder.countIn));
  let offsetMs = $state(untrack(() => recorder.offsetMs));
  const recLabel = $derived(rec.state === 'count-in' ? 'Count-in…' : rec.state === 'recording' ? '● REC' : '● Rec');

  function persist() {
    saveRecSettings({ countIn: recorder.countIn, offsetMs: recorder.offsetMs });
  }
  function toggleCountIn() {
    recorder.countIn = countIn = !countIn;
    persist();
  }
  /** Commit on change/Enter (clamped), then release focus so Space / R / the piano work again. */
  function commitOffset(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    recorder.offsetMs = input.valueAsNumber;
    offsetMs = recorder.offsetMs;
    input.value = String(offsetMs);
    persist();
    input.blur();
  }

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
    latency = `Output latency ${latencyMs.toFixed(1)} ms at ${engine.sampleRate / 1000} kHz`;
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
  <button class="play" class:on={p.playing} onclick={onTogglePlay} title="Play / Stop (Space)">
    {p.playing ? '■ Stop' : '▶ Play'}
  </button>
  <button
    class="rec"
    class:armed={rec.armed}
    class:live={rec.state === 'recording'}
    aria-pressed={rec.armed}
    data-testid="rec-button"
    data-state={rec.state}
    onclick={onToggleArm}
    title="Record arm (R). Records into the Keys → track while playing."
  >{recLabel}</button>
  <button
    class="small"
    class:on={countIn}
    aria-pressed={countIn}
    data-testid="count-in"
    onclick={toggleCountIn}
    title="One bar of metronome before recording starts (when armed)"
  >Count-in</button>
  <details class="pop">
    <summary title="Recording timing offset">Offset {offsetMs} ms</summary>
    <div class="panel">
      <label>
        <span class="lbl">REC OFFSET</span>
        <input
          type="number"
          min={REC_OFFSET_MIN}
          max={REC_OFFSET_MAX}
          step="1"
          value={offsetMs}
          data-testid="rec-offset"
          onchange={commitOffset}
          onkeydown={(e) => e.key === 'Enter' && commitOffset(e)}
        /> ms
      </label>
      <p>Recorded notes are placed where you heard the beat. If they still land late, raise this (positive = earlier). −200…200.</p>
    </div>
  </details>
  <button
    class="small"
    disabled={rec.takeNotes === 0}
    data-testid="undo-take"
    onclick={() => recorder.undoLastTake()}
    title="Remove the notes the last recording pass added"
  >Undo take</button>
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
  <span class="pill" class:bad={dropouts > 0} data-testid="cpu" title="Audio thread CPU load · {dropouts} dropouts (missed audio blocks) this session">
    CPU {cpu}% · {dropouts} drop
  </span>
  <span class="pill" data-testid="latency" title={latencyMs > 40 ? `${latency}. ${BT_TIP}` : latency}>
    {Math.round(latencyMs)} ms{#if latencyMs > 40}<span class="bt">{" "}BT?</span>{/if}
  </span>
</header>

<style>
  .bar { display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: #1f2026; border-bottom: 1px solid #2a2c33; white-space: nowrap; overflow: hidden; }
  .spacer { flex: 1; }
  button, .pill, input, summary { white-space: nowrap; flex: none; }
  button, .pill, input { font: inherit; color: #c9cbd3; background: #2a2c33; border: 1px solid #34363e; border-radius: 4px; padding: 4px 10px; }
  button { cursor: pointer; }
  button:hover { background: #33353e; }
  button.on { background: #f0a23a; color: #111; border-color: #f0a23a; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .small { font-size: 11px; padding: 4px 8px; }
  .rec { min-width: 84px; color: #e06666; }
  .rec.armed { background: #c92a2a; border-color: #c92a2a; color: #fff; font-weight: 700; }
  .rec.live { animation: rec-pulse 1s ease-in-out infinite; }
  @keyframes rec-pulse { 50% { background: #8a1c1c; border-color: #8a1c1c; } }
  .pop { position: relative; }
  .pop summary { list-style: none; cursor: pointer; font-size: 11px; color: #9a9da8; padding: 4px 6px; border-radius: 4px; }
  .pop summary::-webkit-details-marker { display: none; }
  .pop summary:hover { background: #2a2c33; }
  .pop .panel { position: absolute; top: calc(100% + 4px); left: 0; z-index: 10; width: 240px; padding: 8px 10px; background: #24262c; border: 1px solid #34363e; border-radius: 4px; box-shadow: 0 4px 14px #0008; }
  .pop .panel label { display: flex; align-items: center; gap: 6px; }
  .pop .panel p { margin: 6px 0 0; font-size: 11px; color: #9a9da8; }
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
