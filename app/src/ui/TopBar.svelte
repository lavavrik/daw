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
  // Undo / redo (↶ ↷): the history's newest entries, named in the tooltips
  // ("Undo Move notes"); ⌘Z / ⇧⌘Z (Ctrl+Y) do the same (input/shortcuts.ts).
  //
  // Project menu (left): the project name with a "● unsaved" mark, and New,
  // Open…, Save (⌘S), Save As… (⇧⌘S). New / Open — from the menu or ⌘O,
  // which opens the menu through `request` — ask inline in the menu (no
  // confirm()) when something would be lost: unsaved changes, or an open
  // "Restore last session" offer (project/discard.ts). Results and errors are
  // banners (project/session.ts). Export WAV… (export/exportFlow.ts) opens
  // the save dialog inside the click, then renders in a Worker; its progress
  // and Cancel are a banner in the bottom panel.
  //
  // Audio settings: the latency readout at the right end is the ⚙ button
  // ("⚙ 29 ms"); it opens the Settings panel (ui/Settings.svelte: latency
  // hint, sample rate / base / output / total latency, the Bluetooth hint,
  // Apply = engine restart via App). The "BT?" badge that used to follow the
  // readout moved into the panel (that freed the room for the ⚙); the
  // readout itself turns orange above 40 ms instead.
  //
  // Layout: one row that never wraps at 1280 px (tight since the Project menu:
  // 4 px gaps, "Metro", narrow BPM field, compact ↶ ↷ and "↶ Take"). Every control is nowrap;
  // readouts are compact (latency "29 ms", CPU + dropouts in one pill) with
  // the full text in their tooltips.
  import { onMount, untrack } from 'svelte';
  import { TELEMETRY } from '../audio/protocol';
  import type { AudioEngine } from '../audio/engine';
  import { BT_LATENCY_MS } from '../audio/restart';
  import type { LatencyHint } from '../audio/restart';
  import Settings from './Settings.svelte';
  import { setLoop, setMode } from '../state/song-actions';
  import { liveInputTrack, setMetronome, setTempo } from '../state/actions';
  import type { Project } from '../state/project.svelte';
  import type { MidiStatus } from '../input/midi';
  import { DEFAULT_OCTAVE } from '../input/qwertyPiano';
  import { REC_OFFSET_MAX, REC_OFFSET_MIN, saveRecSettings } from '../state/recorder';
  import type { Recorder, RecStatus } from '../state/recorder';
  import type { ProjectSession } from '../project/session';
  import { discardWarning } from '../project/discard';
  import { runExport } from '../export/exportFlow';
  import { banners } from '../state/banners.svelte';

  let {
    p,
    engine,
    octave = DEFAULT_OCTAVE,
    midi = { state: 'no-devices', devices: [] },
    recorder,
    rec,
    onTogglePlay,
    onToggleArm,
    session,
    restoreOffer = null,
    undoLabels = { undo: null, redo: null },
    onUndo,
    onRedo,
    latencyHint = 'interactive',
    restarting = false,
    onApplyAudio = async () => null,
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
    session: ProjectSession;
    /** The "Restore last session" offer, while it is open (New / Open would discard it). */
    restoreOffer?: { name: string } | null;
    /** What ↶ / ↷ would undo / redo (history labels; null: nothing). */
    undoLabels?: { undo: string | null; redo: string | null };
    onUndo: () => void;
    onRedo: () => void;
    /** The running engine's latency hint (Settings). */
    latencyHint?: LatencyHint;
    /** An audio restart is running. */
    restarting?: boolean;
    /** Settings ▸ Apply: restart audio with this hint (App); resolves with why it did not run, or null. */
    onApplyAudio?: (hint: LatencyHint) => Promise<string | null>;
  } = $props();

  /** The Settings panel mounts while open (its readout polls only then). */
  let settingsOpen = $state(false);

  // ---- Project menu --------------------------------------------------------
  let menu = $state<HTMLDetailsElement | null>(null);
  /** New/Open waiting for "Discard and …" (only asked when something would be lost). */
  let confirming = $state<'new' | 'open' | null>(null);
  const warning = $derived(discardWarning(p, restoreOffer));
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = isMac ? '⌘' : 'Ctrl+';
  function closeMenu() {
    confirming = null;
    if (menu) menu.open = false;
  }
  function run(cmd: 'new' | 'open' | 'save' | 'saveAs' | 'export') {
    if ((cmd === 'new' || cmd === 'open') && discardWarning(p, restoreOffer) !== null && confirming !== cmd) {
      confirming = cmd;
      return;
    }
    closeMenu();
    if (cmd === 'new') void session.newProject();
    else if (cmd === 'open') void session.open();
    else if (cmd === 'save') void session.save();
    else if (cmd === 'export') void runExport(p, engine.context);
    else void session.saveAs();
  }

  /**
   * ⌘O / Ctrl+O (App's shortcut): the same as the menu item, so it asks the
   * same question — the menu opens on the "Discard and open…" prompt when
   * something would be lost, else the folder picker opens at once (still
   * inside the key press, as the picker needs a user gesture).
   */
  export function request(cmd: 'new' | 'open') {
    if (discardWarning(p, restoreOffer) !== null && menu) menu.open = true;
    run(cmd);
  }

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
  let engineError = $state<string | null>(null); // set from engine.failure (effect below)

  function refresh() {
    cpu = Math.round(engine.telemetry()[TELEMETRY.cpu] * 100);
    dropouts = engine.dropouts();
    latencyMs = engine.latencyMs();
    latency = `Output latency ${latencyMs.toFixed(1)} ms at ${engine.sampleRate / 1000} kHz`;
  }

  onMount(() => {
    refresh();
    const id = setInterval(refresh, 250); // reads the `engine` prop: follows a restart
    return () => clearInterval(id);
  });
  // Per engine: an audio restart hands over a new one (the old one closes
  // without firing onError).
  $effect(() => {
    const e = engine;
    e.onError = (msg) => (engineError = msg);
    engineError = e.failure; // in case it failed before mount
    return () => {
      e.onError = undefined;
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
  <details class="pop proj" bind:this={menu} ontoggle={() => !menu?.open && (confirming = null)}>
    <summary data-testid="project-menu" title="Project: New, Open, Save">
      <span data-testid="project-name"><span class="pname">{p.name}</span>{#if p.dirty}<span class="unsaved" title="Unsaved changes">● unsaved</span>{/if}</span>
    </summary>
    <div class="panel menu" role="menu">
      {#if confirming}
        <p class="warn" data-testid="project-discard-warning">{warning}</p>
        <div class="row">
          <button class="danger" data-testid="project-discard" onclick={() => run(confirming!)}>
            Discard and {confirming === 'new' ? 'start new' : 'open…'}
          </button>
          <button data-testid="project-discard-cancel" onclick={() => (confirming = null)}>Cancel</button>
        </div>
      {:else}
        <button role="menuitem" data-testid="project-new" onclick={() => run('new')}>New</button>
        <button role="menuitem" data-testid="project-open" onclick={() => run('open')}>Open… <kbd>{mod}O</kbd></button>
        <button role="menuitem" data-testid="project-save" onclick={() => run('save')}>Save <kbd>{mod}S</kbd></button>
        <button role="menuitem" data-testid="project-save-as" onclick={() => run('saveAs')}>Save As… <kbd>⇧{mod}S</kbd></button>
        <button
          role="menuitem" data-testid="project-export" disabled={banners.exporting !== null || p.loading}
          title="Render the song (Song mode, from the start to the last clip + 2 s, metronome off) to a 24-bit WAV"
          onclick={() => run('export')}
        >Export WAV…</button>
      {/if}
    </div>
  </details>
  <span class="seg hist" role="group" aria-label="Undo and redo">
    <button
      data-testid="undo" aria-label="Undo" disabled={!undoLabels.undo || p.loading} onclick={onUndo}
      title={undoLabels.undo ? `Undo ${undoLabels.undo} (${mod}Z)` : 'Nothing to undo'}
    >↶</button>
    <button
      data-testid="redo" aria-label="Redo" disabled={!undoLabels.redo || p.loading} onclick={onRedo}
      title={undoLabels.redo ? `Redo ${undoLabels.redo} (⇧${mod}Z)` : 'Nothing to redo'}
    >↷</button>
  </span>
  <button class="play" class:on={p.playing} onclick={onTogglePlay} title="Play / Stop (Space)" data-testid="play">
    {p.playing ? '■ Stop' : '▶ Play'}
  </button>
  <span class="seg" role="group" aria-label="Playback mode" data-testid="mode-toggle" data-mode={p.mode} title="Pattern or Song playback (Shift+L)">
    <button class:on={p.mode === 'pattern'} aria-pressed={p.mode === 'pattern'} data-testid="mode-pat" onclick={() => setMode(p, engine, 'pattern')}>PAT</button>
    <button class:on={p.mode === 'song'} aria-pressed={p.mode === 'song'} data-testid="mode-song" onclick={() => setMode(p, engine, 'song')}>SONG</button>
  </span>
  <button
    class="small"
    class:on={p.loop.on && p.mode === 'song'}
    aria-pressed={p.loop.on && p.mode === 'song'}
    data-testid="loop-toggle"
    disabled={p.mode !== 'song'}
    onclick={() => setLoop(p, engine, { on: !p.loop.on })}
    title={p.mode === 'song' ? 'Loop the loop range while playing the song' : 'Loop range applies to Song mode'}
  >Loop</button>
  <button
    class="rec"
    class:armed={rec.armed}
    class:live={rec.state === 'recording'}
    aria-pressed={rec.armed}
    data-testid="rec-button"
    data-state={rec.state}
    onclick={onToggleArm}
    disabled={p.mode === 'song' && !rec.armed}
    title={p.mode === 'song'
      ? 'Recording works in Pattern mode (Shift+L)'
      : 'Record arm (R). Records into the Keys → track\'s current pattern while playing.'}
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
    disabled={!rec.canUndoTake}
    data-testid="undo-take"
    onclick={() => recorder.undoLastTake()}
    aria-label="Undo take"
    title="Undo take: undo the last recording pass (the newest undo step)"
  >↶ Take</button>
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
  <button class="metro" class:on={p.metronome} aria-pressed={p.metronome} onclick={() => setMetronome(p, engine, !p.metronome)} title="Metronome" aria-label="Metronome">
    Metro
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
  <details class="pop settings" ontoggle={(e) => (settingsOpen = (e.currentTarget as HTMLDetailsElement).open)}>
    <summary
      data-testid="settings-button" aria-label="Audio settings" class:bad={latencyMs > BT_LATENCY_MS}
      title="{latencyMs > BT_LATENCY_MS ? `${latency}. ${BT_TIP}` : latency}. Click for audio settings."
    >⚙ <span data-testid="latency">{Math.round(latencyMs)} ms</span></summary>
    <div class="panel">
      {#if settingsOpen}
        <Settings
          {engine} hint={latencyHint} busy={restarting || p.loading}
          blocked={banners.exporting ? 'Wait for the export to finish' : null}
          onApply={onApplyAudio}
        />
      {/if}
    </div>
  </details>
</header>

<style>
  /* overflow-x: clip (not hidden): clips a too-wide row without becoming a
     scroll container, so the popovers (Project menu, Offset) can drop below. */
  .bar { display: flex; gap: 4px; align-items: center; padding: 6px 10px; background: #1f2026; border-bottom: 1px solid #2a2c33; white-space: nowrap; overflow-x: clip; position: relative; z-index: 5; }
  .spacer { flex: 1; }
  button, .pill, input, summary { white-space: nowrap; flex: none; }
  button, .pill, input { font: inherit; color: #c9cbd3; background: #2a2c33; border: 1px solid #34363e; border-radius: 4px; padding: 4px 10px; }
  button { cursor: pointer; }
  button:hover { background: #33353e; }
  button.on { background: #f0a23a; color: #111; border-color: #f0a23a; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .seg { display: inline-flex; flex: none; }
  .seg button { border-radius: 0; font-size: 11px; padding: 4px 8px; }
  .seg button:first-child { border-radius: 4px 0 0 4px; }
  .seg button:last-child { border-radius: 0 4px 4px 0; }
  .small { font-size: 11px; padding: 4px 8px; }
  .hist button { padding: 4px 5px; }
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
  .proj summary { color: #e4e5ea; font-size: 12px; font-weight: 600; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  .proj .unsaved { color: #f0a23a; font-weight: 400; font-size: 11px; margin-left: 6px; }
  .proj .menu { width: 230px; display: flex; flex-direction: column; gap: 2px; padding: 6px; }
  .proj .menu > button { display: flex; justify-content: space-between; text-align: left; background: transparent; border-color: transparent; }
  .proj .menu > button:hover { background: #33353e; }
  .proj .menu > button:disabled { background: transparent; }
  .proj kbd { font: inherit; font-size: 10px; color: #7d808c; }
  .proj .warn { margin: 2px 2px 6px; color: #f0a23a; white-space: normal; }
  .proj .row { display: flex; gap: 6px; }
  .proj .danger { background: #c92a2a; border-color: #c92a2a; color: #fff; }
  .bpm { display: flex; align-items: center; gap: 6px; }
  .lbl { font-size: 10px; letter-spacing: 0.06em; color: #7d808c; }
  input { width: 48px; }
  .pill { padding: 4px 6px; background: transparent; border-color: transparent; color: #9a9da8; font-variant-numeric: tabular-nums; }
  .pill.bad { color: #ff6b6b; font-weight: 600; }
  .sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin: 0 5px 0 3px; vertical-align: -1px; }
  .pill.keys { color: #c9cbd3; }
  .settings summary { color: #9a9da8; font-size: 12px; font-variant-numeric: tabular-nums; }
  .settings summary.bad { color: #f0a23a; }
  /* At the right edge: the panel opens leftwards. */
  .settings .panel { left: auto; right: 0; width: 270px; }
  .fatal { background: #c92a2a; color: #fff; font-weight: 700; padding: 4px 10px; border-radius: 4px; }
  .fatal button { background: #fff; color: #c92a2a; border-color: #fff; font-weight: 700; padding: 1px 8px; }
</style>
