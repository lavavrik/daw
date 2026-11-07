<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import StartOverlay from './ui/StartOverlay.svelte';
  import TopBar from './ui/TopBar.svelte';
  import Browser from './ui/Browser.svelte';
  import SongArea from './ui/SongArea.svelte';
  import BottomPanel from './ui/BottomPanel.svelte';
  import { Op } from './audio/protocol';
  import { createAudioClock } from './audio/audioClock';
  import type { AudioClock } from './audio/audioClock';
  import type { AudioEngine } from './audio/engine';
  import { Project } from './state/project.svelte';
  import { addDrumTrack } from './state/actions';
  import { installShortcuts } from './input/shortcuts';
  import { connectMidi } from './input/midi';
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

  // Exposed unconditionally (personal local app): e2e tests and the console use it.
  window.__daw = { engine: null, Op, clock: null };

  function onstarted(e: AudioEngine) {
    engine = e;
    window.__daw.engine = e;
    clock = createAudioClock(e, () => project.tempo);
    window.__daw.clock = clock;
    // Session-lifetime: deferred sample loads must land even while the step
    // grid is unmounted (a synth track selected).
    uninstallLoads = installSampleLoads(project, e);
    addDrumTrack(project, e); // default track so the UI has something to show
    uninstall = installShortcuts(project, e, (o) => (octave = o));
    // Not awaited: the permission prompt must never block startup/rendering.
    void connectMidi(e, (s) => (midi = s)).then((d) => (uninstallMidi = d));
  }

  onDestroy(() => {
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
    <TopBar p={project} {engine} {octave} {midi} />
    <div class="main">
      <Browser />
      <div class="right">
        <div class="song"><SongArea p={project} {engine} /></div>
        <div class="bottom"><BottomPanel p={project} {engine} {clock} /></div>
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
  .right { display: grid; grid-template-rows: 40fr 60fr; gap: 3px; min-height: 0; min-width: 0; }
  .song, .bottom { display: grid; min-height: 0; min-width: 0; }
</style>
