<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import StartOverlay from './ui/StartOverlay.svelte';
  import TopBar from './ui/TopBar.svelte';
  import Browser from './ui/Browser.svelte';
  import SongArea from './ui/SongArea.svelte';
  import BottomPanel from './ui/BottomPanel.svelte';
  import { Op, TELEMETRY } from './audio/protocol';
  import { createAudioClock } from './audio/audioClock';
  import type { AudioClock } from './audio/audioClock';
  import type { AudioEngine } from './audio/engine';
  import { Project } from './state/project.svelte';
  import { addDrumTrack, play, stop } from './state/actions';
  import { installShortcuts } from './input/shortcuts';
  import { connectMidi } from './input/midi';
  import { createNoteInput } from './input/noteInput';
  import type { NoteInput } from './input/noteInput';
  import { loadRecSettings, recorderFor, sameStatus } from './state/recorder';
  import type { Recorder, RecStatus } from './state/recorder';
  import type { MidiStatus } from './input/midi';
  import { banners } from './state/banners.svelte';
  import { installSampleLoads } from './state/sampleLoads';

  const project = new Project();
  let engine = $state.raw<AudioEngine | null>(null);
  let clock = $state.raw<AudioClock | null>(null);
  let uninstall: (() => void) | null = null;
  let uninstallMidi: (() => void) | null = null;
  let uninstallLoads: (() => void) | null = null;
  let octave = $state(4);
  let midi = $state<MidiStatus>({ state: 'no-devices', devices: [] });
  let recorder = $state.raw<Recorder | null>(null);
  /** The one note bus: QWERTY, MIDI (and later the piano roll) all play through it. */
  let noteInput = $state.raw<NoteInput | null>(null);
  let rec = $state<RecStatus>({ armed: false, state: 'off', takeNotes: 0 });
  let stopWatch: (() => void) | null = null;

  // Exposed unconditionally (personal local app): e2e tests and the console use it.
  window.__daw = { engine: null, Op, clock: null, recorder: null };

  /**
   * Play / Stop for the button and Space. Play while armed with Count-in on
   * sends PLAY 3840. Stop first closes held recorded notes at the heard tick
   * *now*: once STOP lands the engine resets its playhead to 0, so the clock
   * can no longer tell where the user stopped.
   */
  function transportToggle() {
    if (!engine || !recorder || !clock) return;
    if (project.playing) {
      recorder.onTransport(false, clock.heardTicks());
      stop(project, engine);
    } else {
      play(project, engine, recorder.countInTicks());
    }
    refreshRec();
  }

  function toggleArm() {
    recorder?.toggleArm();
    refreshRec();
  }

  function refreshRec() {
    const s = recorder?.status();
    if (s && !sameStatus(s, rec)) rec = s;
  }

  /**
   * 60 Hz: keeps the recorder's transport state in step with the engine
   * (telemetry `playing`; 4 Hz would close notes up to 250 ms late) and the
   * Rec button's status fresh (count-in -> recording). Start is taken when
   * the engine confirms it; a stop the UI did not issue (console, engine
   * failure) closes held notes at the last heard tick seen while playing.
   */
  function watchTransport(e: AudioEngine, c: AudioClock, r: Recorder) {
    let raf = 0;
    let lastHeard = 0;
    const loop = () => {
      const playing = e.telemetry()[TELEMETRY.playing] === 1;
      if (playing) lastHeard = c.heardTicks();
      // project.playing guards the frame between a UI Stop and the engine applying it.
      if (playing && project.playing && !r.playing) r.onTransport(true, lastHeard);
      else if (!playing && r.playing) r.onTransport(false, lastHeard);
      refreshRec();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }

  function onstarted(e: AudioEngine) {
    engine = e;
    window.__daw.engine = e;
    clock = createAudioClock(e, () => project.tempo);
    window.__daw.clock = clock;
    const r = recorderFor(project, e, clock, () => {
      banners.error = 'Pattern is full (1024 notes): some recorded notes were dropped';
    });
    const saved = loadRecSettings();
    r.countIn = saved.countIn;
    r.offsetMs = saved.offsetMs;
    recorder = r;
    window.__daw.recorder = r;
    const input = createNoteInput(e, r);
    noteInput = input;
    stopWatch = watchTransport(e, clock, r);
    // Session-lifetime: deferred sample loads must land even while the step
    // grid is unmounted (a synth track selected).
    uninstallLoads = installSampleLoads(project, e);
    addDrumTrack(project, e); // default track so the UI has something to show
    uninstall = installShortcuts(project, e, input, {
      onOctave: (o) => (octave = o),
      onTogglePlay: transportToggle,
      onToggleArm: toggleArm,
    });
    // Not awaited: the permission prompt must never block startup/rendering.
    void connectMidi(e, input, (s) => (midi = s)).then((d) => (uninstallMidi = d));
  }

  onDestroy(() => {
    stopWatch?.();
    uninstall?.();
    uninstallMidi?.();
    uninstallLoads?.();
  });

  // Window-level drop guard. A file dropped where no row handles it (Browser
  // pane, gaps, headers, a disabled button, the start overlay) would make the
  // browser navigate to the file and lose the session. Rows/"+ Add row" call
  // preventDefault themselves; anything still un-prevented when the event
  // bubbles here is a miss: cancel it and say where to drop instead.
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
  onMount(() => {
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (!e.defaultPrevented) banners.error = 'Drop onto a step-grid row to load a sample';
      e.preventDefault();
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  });
</script>

<div class="app">
  {#if engine}
    {#if recorder}
      <TopBar p={project} {engine} {octave} {midi} {recorder} {rec} onTogglePlay={transportToggle} onToggleArm={toggleArm} />
    {/if}
    <div class="main">
      <Browser />
      <div class="right">
        <div class="song"><SongArea p={project} {engine} /></div>
        <div class="bottom"><BottomPanel p={project} {engine} {clock} {noteInput} /></div>
      </div>
    </div>
  {/if}
</div>
{#if !engine}
  <StartOverlay {onstarted} />
{/if}

<style>
  :global(html, body) { margin: 0; height: 100%; background: #16171b; color: #c9cbd3; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; }
  .app { height: 100vh; display: flex; flex-direction: column; background: #16171b; }
  .main { flex: 1; min-height: 0; display: grid; grid-template-columns: 220px 1fr; gap: 3px; padding: 3px; }
  /* The editor (piano roll / step grid / rack) gets the larger share: the roll
     needs C2..C5 at >= 9 px rows to show note names (anti-goal: what's where). */
  .right { display: grid; grid-template-rows: minmax(140px, 0.5fr) minmax(380px, 1.5fr); gap: 3px; min-height: 0; min-width: 0; }
  .song, .bottom { display: grid; min-height: 0; min-width: 0; }
</style>
